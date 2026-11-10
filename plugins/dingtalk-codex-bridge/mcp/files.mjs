import { realpath, stat, lstat, readFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BridgeError } from "./cli.mjs";

export function createFiles(env = process.env) {
  const root = path.resolve(env.DINGTALK_BRIDGE_FILES_DIR || path.join(os.homedir(), "Downloads"));
  async function resolve(value, { output = false, directory = false } = {}) {
    if (typeof value !== "string" || !value || /[\x00\r\n]/u.test(value)) throw new BridgeError("INVALID_ARGUMENT", "Expected a local file path.");
    try {
      const realRoot = await realpath(root), requested = path.resolve(realRoot, value);
      const resolved = output ? path.join(await realpath(path.dirname(requested)), path.basename(requested)) : await realpath(requested);
      const relative = path.relative(realRoot, resolved);
      if ((!relative && !directory) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new BridgeError("FILE_OUTSIDE_ALLOWED_DIRECTORY", "File is outside Downloads or DINGTALK_BRIDGE_FILES_DIR.");
      if (output) {
        try { await lstat(resolved); throw new BridgeError("LOCAL_FILE_EXISTS", "Output already exists; choose a new filename."); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      } else {
        const info = await stat(resolved);
        if (directory ? !info.isDirectory() : (!info.isFile() || info.size > 20 * 1024 * 1024)) throw new BridgeError("LOCAL_FILE_INVALID", "Input must be a directory or a regular file up to 20 MB, as requested by this parameter.");
      }
      return resolved;
    } catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError("LOCAL_FILE_UNAVAILABLE", "Local file or directory is missing/inaccessible."); }
  }
  async function workingDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return realpath(root);
  }
  async function checkTree(directory) {
    let entries = 0, bytes = 0;
    async function visit(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        if (++entries > 1000 || entry.isSymbolicLink()) throw new BridgeError("LOCAL_DIRECTORY_INVALID", "Directory inputs cannot contain symlinks or more than 1000 entries.");
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) { bytes += (await stat(child)).size; if (bytes > 20 * 1024 * 1024) throw new BridgeError("LOCAL_DIRECTORY_INVALID", "Directory input exceeds 20 MB."); }
        else throw new BridgeError("LOCAL_DIRECTORY_INVALID", "Directory inputs must contain only regular files and directories.");
      }
    }
    await visit(directory);
  }
  return { root, resolve, workingDirectory, checkTree, read: async value => readFile(await resolve(value), "utf8") };
}
