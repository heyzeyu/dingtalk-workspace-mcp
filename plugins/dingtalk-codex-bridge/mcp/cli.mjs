import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DWS_VERSION = "1.0.67";
export const CLI_TIMEOUT_MS = 40_000;
export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function cacheRoot(env = process.env) {
  return env.DINGTALK_BRIDGE_CACHE_DIR || path.join(os.homedir(), ".local", "share", "dingtalk-codex-bridge");
}
export function managedCliPath(env = process.env) {
  return path.join(cacheRoot(env), "dws", DWS_VERSION, `${process.platform}-${process.arch}`, process.platform === "win32" ? "dws.exe" : "dws");
}

export async function resolveCli(env = process.env) {
  if (env.DWS_CLI_PATH) {
    if (!path.isAbsolute(env.DWS_CLI_PATH) || /[\x00-\x1f\x7f]/u.test(env.DWS_CLI_PATH)) {
      throw new BridgeError("CLI_PATH_INVALID", "DWS_CLI_PATH must be an absolute executable path, not a command string.");
    }
    return env.DWS_CLI_PATH;
  }
  const managed = managedCliPath(env);
  try { await access(managed, process.platform === "win32" ? constants.F_OK : constants.X_OK); return managed; }
  catch { /* Fall back to an existing installation; its version is checked below. */ }
  return "dws";
}

// Never send arbitrary CLI diagnostics (which may include login URLs or secrets) to MCP.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      /^(?:access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|device[_-]?code|authorization|cookie|set-cookie|password|secret|private[_-]?key|api[_-]?key|token|webhook[_-]?token)$/i.test(k)
        ? "[REDACTED]" : redact(v)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\bBearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(/https:\/\/[^\s"'<>]*[?&](?:signature|x-oss-signature|x-amz-signature|auth_key|ossaccesskeyid)=[^\s"'<>]*/giu, "[TEMPORARY_DOWNLOAD_URL_REDACTED]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|device[_-]?code)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/giu, "$1[REDACTED]");
}

export function execCli(executable, argv, { env = process.env, timeout = CLI_TIMEOUT_MS, cwd, input, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BridgeError("CLI_CANCELLED", "The local command was cancelled."));
    const child = execFile(executable, argv, { env, cwd, signal, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (error?.name === "AbortError") return reject(new BridgeError("CLI_CANCELLED", "The local command was cancelled."));
      if (error?.code === "ENOENT") return reject(new BridgeError("CLI_MISSING", "Official DWS CLI is missing. In the plugin call connect_dingtalk for guided installation and authorization. Terminal fallback: node scripts/setup.mjs install-cli"));
      if (["EACCES", "EPERM"].includes(error?.code)) return reject(new BridgeError("CLI_EXECUTION_DENIED", "The operating system denied execution. Check executable permissions and macOS Privacy & Security for the verified official binary."));
      if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new BridgeError("OUTPUT_LIMIT", "DWS output exceeded the buffer limit. Read a smaller range."));
      if (error?.killed || error?.code === "ETIMEDOUT") return reject(new BridgeError("CLI_TIMEOUT", "DWS timed out. The result is unknown; retry only a bounded read."));
      if (error?.signal) return reject(new BridgeError("CLI_PROCESS_INTERRUPTED", "The native process was interrupted. Check login status before retrying authorization; audit submitted writes before any retry."));
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin?.on("error", error => { if (error.code !== "EPIPE") reject(new BridgeError("STDIN_FAILED", "Could not provide explicit stdin content.")); });
    child.stdin?.end(input ?? "");
  });
}

function failureIn(value) {
  if (!value || typeof value !== "object") return null;
  const meaningful = candidate => {
    if (candidate === null || candidate === undefined || candidate === false || candidate === "" || candidate === 0) return false;
    if (typeof candidate === "object") return Object.values(candidate).some(meaningful);
    return true;
  };
  if (meaningful(value.error) || value.success === false || value.ok === false || value.isError === true) return meaningful(value.error) ? value.error : value;
  for (const key of ["result", "data"]) {
    const child = failureIn(value[key]);
    if (child) return child;
  }
  return null;
}

export function recoveryFacts(value, location = "", depth = 0, result = []) {
  if (depth > 6 || !value || typeof value !== "object" || result.length >= 30) return result;
  for (const [key, child] of Object.entries(value)) {
    const at = location ? `${location}.${key}` : key;
    if (/^(?:nodeId|sheetId|taskId|jobId|baseId|tableId|recordId|node_id|sheet_id|task_id|job_id|base_id|table_id|record_id|stage|phase|outcome|submissionStatus|submitted|writeSubmitted)$/u.test(key) && ["string", "number", "boolean"].includes(typeof child)) result.push({ path: at, value: child });
    else if (!["cells", "values", "headers", "body"].includes(key)) recoveryFacts(child, at, depth + 1, result);
  }
  return result;
}

export function parseCliResult({ code, stdout, stderr = "", allowPrimitive = false, allowText = false }) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch {
    // DWS prints structured CLI errors on stderr. Only parse it on a failing exit;
    // never return unstructured diagnostics or treat success chatter as data.
    if (code !== 0) {
      // The macOS runtime can emit Objective-C loader warnings before DWS's
      // structured error. Strip only that known preamble, never arbitrary logs.
      const errorJson = stderr.replace(/^(?:(?:objc\[\d+\]:[^\r\n]*|[ \t]*)\r?\n)+/u, "");
      try { parsed = JSON.parse(errorJson); }
      catch { throw new BridgeError("CLI_RESPONSE_INVALID", "DWS did not return valid JSON. Check authentication or read a smaller range."); }
    } else if (allowText && stdout.trim()) {
      const lines = stdout.trim().split(/\r?\n/u);
      try { return { output_kind: "ndjson", records: lines.map(line => redact(JSON.parse(line))), stdout_complete: true }; }
      catch { return { output_kind: "text", text: redact(stdout), completeness: "not_inferred_from_text" }; }
    } else throw new BridgeError("CLI_RESPONSE_INVALID", "DWS did not return valid JSON. Check authentication or read a smaller range.");
  }
  if (allowPrimitive && parsed !== null && typeof parsed !== "object" && code === 0) {
    if (parsed === false && allowPrimitive !== "read") throw new BridgeError("DWS_REQUEST_FAILED", "DWS returned a negative result; read back the target before retrying.");
    return { success: true, result: redact(parsed), verification: "read_back_required" };
  }
  if (parsed === null || typeof parsed !== "object") throw new BridgeError("CLI_RESPONSE_INVALID", "DWS returned an unexpected JSON value.");
  const failure = failureIn(parsed);
  if (code !== 0 || failure) {
    const candidate = failure && typeof failure === "object" ? failure : typeof failure === "string" ? { message: failure } : {};
    // Small, redacted structured facts only. Do not return stdout/stderr or request headers.
    const facts = Object.fromEntries(["code", "category", "type", "subtype", "reason", "message", "hint", "requestId", "traceId", "server_error_code", "upstream_code"].filter(k => candidate[k] !== undefined).map(k => [k, candidate[k]]));
    facts.exit_code = code;
    const recovery = recoveryFacts(parsed);
    if (recovery.length) facts.recovery = recovery;
    throw new BridgeError("DWS_REQUEST_FAILED", "DWS rejected the request. Check the returned reason, organization and document permissions.", redact(facts));
  }
  return parsed;
}

export function createRunner({ env = process.env, execute = execCli } = {}) {
  env = { ...env, DWS_NO_UPDATE_CHECK: "1" };
  let ready;
  async function runtime() {
    if (!ready) ready = (async () => {
      const executable = await resolveCli(env);
      const result = await execute(executable, ["--version"], { env, timeout: 15_000 });
      const match = result.stdout.match(/\bdws version v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/u);
      if (result.code !== 0 || match?.[1] !== DWS_VERSION) throw new BridgeError("CLI_VERSION_MISMATCH", `This bridge requires official dws ${DWS_VERSION}. Run: node scripts/setup.mjs install-cli`);
      return { executable, version: match[1] };
    })().catch(error => { ready = undefined; throw error; });
    return ready;
  }
  async function run(argv, options = {}) {
    const { executable } = await runtime();
    return parseCliResult({ ...await execute(executable, argv, { env, timeout: options.timeout, cwd: options.cwd, input: options.input }), allowPrimitive: options.allowPrimitive ?? false, allowText: options.allowText ?? false });
  }
  return { run, runtime };
}
