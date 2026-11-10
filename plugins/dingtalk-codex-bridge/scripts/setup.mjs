#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { copyFile, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BridgeError, DWS_VERSION, execCli, managedCliPath, createRunner, redact } from "../mcp/cli.mjs";

export const ARTIFACTS = {
  "darwin-arm64": ["dws-darwin-arm64.tar.gz", "ffbb8962de879a5693ea380654813f45f9252f39d5527a24e135567aa2c36dea"],
  "darwin-x64": ["dws-darwin-amd64.tar.gz", "1021d30296534c380bd27967b1641d5a5e42573e263c56d8a984dd13eb9991c2"],
  "linux-arm64": ["dws-linux-arm64.tar.gz", "1170453962f1bd049f27097385cab8b68dbf25cd69f45eb020e5d3bca0cad605"],
  "linux-x64": ["dws-linux-amd64.tar.gz", "25959351407e51d4aba7638790ff1cd04fdd7eaa56b313a26b689c03628e0ee2"],
  "win32-arm64": ["dws-windows-arm64.zip", "349cec555a59dff53ceb142ccf2f9e29727bf879ceb045fb9f51962226b5dcb2"],
  "win32-x64": ["dws-windows-amd64.zip", "3cb839866497405581c8ba5ef069e635495e9ee8afa8ff736c11f66db726184e"]
};
const digest = data => createHash("sha256").update(data).digest("hex");
export async function installCli({ archive, env = process.env, signal, execute = execCli } = {}) {
  const checkCancelled = () => { if (signal?.aborted) throw new BridgeError("CLI_CANCELLED", "CLI installation was cancelled."); };
  async function tool(command, argv, timeout) {
    checkCancelled();
    try { return await execute(command, argv, { env, timeout, signal }); }
    catch (error) {
      if (error.code !== "CLI_MISSING") throw error;
      // GUI applications can inherit a minimal PATH. Use only the macOS system
      // utility as a fallback, never a shell or a separately downloaded helper.
      if (process.platform === "darwin" && ["curl", "tar"].includes(command)) {
        checkCancelled();
        try { return await execute(`/usr/bin/${command}`, argv, { env, timeout, signal }); }
        catch (fallback) { if (fallback.code !== "CLI_MISSING") throw fallback; }
      }
      throw new BridgeError("SETUP_TOOL_MISSING", `The installer requires the system utility ${command}. Restore its PATH or use the verified offline archive installer.`);
    }
  }
  checkCancelled();
  const platform = `${process.platform}-${process.arch}`;
  const artifact = ARTIFACTS[platform];
  if (!artifact) throw new BridgeError("PLATFORM_UNSUPPORTED", `No pinned DWS release for ${platform}.`);
  const [file, sha256] = artifact;
  const url = `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${DWS_VERSION}/${file}`;
  const temp = await mkdtemp(path.join(os.tmpdir(), "dingtalk-cli-"));
  try {
    const input = archive ? path.resolve(archive) : path.join(temp, file);
    if (!archive) {
      const dl = await tool(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--max-time", "120", "--output", input, url], 125000);
      if (dl.code !== 0) throw new BridgeError("DOWNLOAD_FAILED", "Could not download the official DWS archive. Check network/proxy settings and retry install-cli.");
    }
    checkCancelled();
    const bytes = await readFile(input);
    if (bytes.length > 100 * 1024 * 1024 || digest(bytes) !== sha256) throw new BridgeError("CHECKSUM_MISMATCH", "DWS archive SHA-256 does not match the pinned official release. Nothing was installed.");
    const extracted = path.join(temp, "extracted");
    await mkdir(extracted);
    const result = await tool("tar", ["-xf", input, "-C", extracted], 30000);
    if (result.code !== 0) throw new BridgeError("EXTRACTION_FAILED", "Archive extraction failed. This installer requires curl and tar.");
    const filename = process.platform === "win32" ? "dws.exe" : "dws";
    const binary = path.join(extracted, filename);
    await chmod(binary, 0o755);
    checkCancelled();
    const check = await execute(binary, ["--version"], { env: { ...env, DWS_NO_UPDATE_CHECK: "1" }, timeout: 15000, signal });
    if (check.code !== 0 || !check.stdout.includes(`dws version v${DWS_VERSION} `)) throw new BridgeError("CLI_VERSION_MISMATCH", "Downloaded executable did not report the expected version.");
    checkCancelled();
    const target = managedCliPath(env);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const pending = `${target}.${randomUUID()}.pending`;
    try { await copyFile(binary, pending); await chmod(pending, 0o755); await rename(pending, target); }
    finally { await rm(pending, { force: true }); }
    for (const name of ["LICENSE", "NOTICE"]) await copyFile(path.join(extracted, name), path.join(path.dirname(target), name));
    await writeFile(path.join(path.dirname(target), "install.json"), JSON.stringify({ version: DWS_VERSION, platform, archive: file, url, sha256, binarySha256: digest(await readFile(target)) }, null, 2) + "\n", { mode: 0o600 });
    return { installed: true, version: DWS_VERSION, executable: target, sha256_verified: true };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "install-cli") {
    if (args.length && !(args.length === 2 && args[0] === "--archive")) throw new Error("Usage: setup.mjs install-cli [--archive /path/to/official-archive]");
    console.log(JSON.stringify(await installCli({ archive: args[1] }), null, 2));
    return;
  }
  if (command === "status") {
    if (args.length) throw new Error("Usage: setup.mjs status");
    const runner = createRunner();
    const runtime = await runner.runtime();
    const result = await runner.run(["auth", "status", "--readonly", "--format", "json"]);
    console.log(JSON.stringify({ cli_version: runtime.version, local_snapshot: true, live_access_verified: false, result: redact(result) }, null, 2));
    return;
  }
  if (command === "login") {
    if (args.length && !(args.length === 1 && ["--device", "--browser"].includes(args[0]))) throw new Error("Usage: setup.mjs login [--device|--browser]");
    // Authentication is an explicit setup action, outside the read-only MCP surface.
    // DWS owns the OAuth flow, Keychain, polling and refresh. Never implement a second token store.
    const { executable } = await createRunner().runtime();
    const child = spawn(executable, ["auth", "login", ...(args[0] === "--browser" ? [] : ["--device"])], { stdio: "inherit", shell: false });
    child.on("error", () => { console.error("Unable to start DWS login."); process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code ?? 1; });
    return;
  }
  console.log("Usage: node scripts/setup.mjs install-cli [--archive PATH] | status | login [--device|--browser]");
  if (command) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ error: error.code || "SETUP_FAILED", message: error instanceof BridgeError ? error.message : "Setup failed; check arguments and filesystem permissions." })); process.exitCode = 1; });
