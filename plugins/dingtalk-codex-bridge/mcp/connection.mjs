import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { BridgeError, parseCliResult } from "./cli.mjs";
import { installCli } from "../scripts/setup.mjs";

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const sessionId = { type: "string", description: "The session_id returned by connect_dingtalk; scoped to this MCP process." };
const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const writeHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const CONNECTION_TOOL_DEFINITIONS = [
  { name: "connect_dingtalk", title: "Connect DingTalk", description: "First-use setup in this chat: install the pinned official CLI if missing, reuse an existing readable login, or keep an official device authorization running and open its verified page locally. The user must personally approve in DingTalk. No terminal commands, localhost callback, token export or credential reset. Repeat calls reuse a pending session. Intended for a local desktop with Node.js available.", inputSchema: object({ reauthorize: { type: "boolean", default: false, description: "Only true when the user explicitly requests a fresh authorization. Never use for an ordinary permission error." }, reopen_browser: { type: "boolean", default: false, description: "Reopen the current pending official authorization page when the user says it did not open." } }), annotations: writeHints },
  { name: "get_dingtalk_connection", title: "Check DingTalk connection progress", description: "Check an existing first-use session without restarting authorization or refreshing the browser. Poll every 2–5 seconds while pending; use the returned profile once ready, then perform the requested bounded business read. Login metadata is not proof of resource permission.", inputSchema: object({ session_id: sessionId }), annotations: readHints },
  { name: "cancel_dingtalk_connection", title: "Stop pending DingTalk authorization", description: "Stop only this MCP process's exact pending login child. Does not log out, revoke, reset or delete any existing credentials. A completed authorization is preserved.", inputSchema: object({ session_id: sessionId }, ["session_id"]), annotations: writeHints },
];

const active = phase => ["starting", "awaiting_authorization", "verifying", "cancelling"].includes(phase);
const invalid = message => { throw new BridgeError("INVALID_ARGUMENT", message); };
function validateArguments(args, allowed, requireSession = false) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key))) invalid("Unsupported connection arguments.");
  for (const key of ["reauthorize", "reopen_browser"]) if (args[key] !== undefined && typeof args[key] !== "boolean") invalid(`${key} must be boolean.`);
  if ((requireSession || args.session_id !== undefined) && (typeof args.session_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(args.session_id))) invalid("Use the session_id returned by connect_dingtalk.");
}
function identity(value) {
  if (value?.success !== true || value.token_valid !== true) return null;
  if (typeof value.corp_id !== "string" || typeof value.user_id !== "string") return null;
  const profile = `${value.corp_id}:${value.user_id}`;
  return /^[A-Za-z0-9_-]{1,256}:[A-Za-z0-9_-]{1,256}$/u.test(profile) ? profile : null;
}
function verificationUrl(value, code) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "login.dingtalk.com" || (url.port && url.port !== "443") || url.username || url.password || url.hash || url.pathname !== "/oauth2/device/verify.htm" || url.searchParams.getAll("user_code").length !== 1 || url.searchParams.get("user_code") !== code) return null;
    // Preserve native caller/security context for the browser, but never expose
    // this URL, device codes, raw stdout or stderr to the model or a log file.
    if ([...url.searchParams.keys()].some(key => !["user_code", "caller", "callerUmt"].includes(key))) return null;
    return url.href;
  } catch { return null; }
}

export function openOfficialBrowser(url, { env = process.env, platform = process.platform, spawnProcess = spawn, timeoutMs = 5000 } = {}) {
  const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32.exe" : "xdg-open";
  const argv = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise(resolve => {
    let child, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    // Some desktop launchers remain attached to the actual browser. A timeout
    // must never terminate that browser or close the user's authorization page.
    const timer = setTimeout(() => { child?.unref?.(); finish(false); }, timeoutMs);
    timer.unref?.();
    try {
      child = spawnProcess(command, argv, { env, shell: false, windowsHide: true, stdio: "ignore" });
      child.once("error", () => finish(false));
      child.once("exit", code => finish(code === 0));
    } catch { finish(false); }
  });
}

export function createConnection({ runner, readStatus, prepareStatus = readStatus, env = process.env, install = installCli, spawnProcess = spawn, openBrowser = url => openOfficialBrowser(url, { env }), timeoutMs = 660000, startupWaitMs = 1000, now = Date.now } = {}) {
  let current = null, starting = null, closed = false;
  const outputLimit = 65536;
  function view(session) {
    const result = { status: session.phase, session_id: session.id, local_snapshot: true, live_access_verified: false };
    if (session.phase === "ready") return { ...result, profile: session.profile, reused_existing_login: session.reused === true, next_action: "Continue the user's requested business operation with this explicit profile; verify actual resource access." };
    if (active(session.phase)) return { ...result, poll_after_seconds: 3, browser_launch_requested: !!session.browserRequested, browser_launch_accepted: !!session.browserAccepted, ...(session.expiresAt ? { expires_at: new Date(session.expiresAt).toISOString() } : {}), message: session.phase === "verifying" ? "正在确认官方登录结果。" : session.browserFailed ? "未能打开本机浏览器。确认浏览器可用后，调用 connect_dingtalk(reopen_browser=true)。SSH/无桌面环境请在终端使用官方设备授权流程。" : "请在本机打开的钉钉官方授权页扫码、选择组织并确认。无需返回 127.0.0.1；插件会持续等待结果。", next_action: "Call get_dingtalk_connection with this session_id; do not start another login or resend any business write." };
    return { ...result, ...(session.error ? { error: session.error } : {}), credentials_revoked: false, message: session.phase === "cancelled" ? "已停止本次登录进程，未退出或撤销已有登录。" : session.phase === "expired" ? "本次授权等待已过期，可重新发起连接。" : "官方授权未能完成。已有凭据未重置；请检查网络、系统钥匙串和组织 CLI 准入。" };
  }
  function clearTimers(session) { clearTimeout(session.timer); clearTimeout(session.killTimer); }
  function clearPrivateOutput(session) { session.stdout = ""; session.stderr = ""; session.line = ""; session.userCode = null; session.nativeUrl = null; }
  function complete(session, phase, error) {
    clearTimers(session); session.phase = phase; session.error = error; clearPrivateOutput(session); session.promptReady?.();
  }
  function stop(session, phase) {
    if (!active(session.phase) || session.finishing || session.stopAs) return;
    session.stopAs = phase; session.phase = "cancelling";
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode) { complete(session, phase); return; }
    child.kill("SIGTERM");
    session.killTimer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); }, 2000);
    session.killTimer.unref?.();
  }
  async function requestBrowser(session) {
    if (!session.nativeUrl || !active(session.phase) || session.opening) return;
    session.browserRequested = true; session.opening = true;
    try { const accepted = await openBrowser(session.nativeUrl); if (active(session.phase)) { session.browserAccepted = !!accepted; session.browserFailed = !accepted; } }
    catch { if (active(session.phase)) session.browserFailed = true; }
    finally { session.opening = false; }
  }
  function parseLine(session, original) {
    if (!active(session.phase) || session.stopAs || session.finishing) return;
    const line = stripVTControlCharacters(original).trim();
    const code = line.match(/^授权码\s*[:：]\s*([A-Za-z0-9-]{4,32})$/u);
    if (code) { session.userCode = code[1]; session.expectUrl = false; return; }
    const expiry = line.match(/^授权码将在\s*(\d+)\s*秒后过期/u);
    if (expiry) session.expiresAt = now() + Math.min(Number(expiry[1]), 660) * 1000;
    if (line === "授权链接（已填入授权码）：" || line === "授权链接（已填入授权码）:") { session.expectUrl = true; return; }
    if (!line || !session.expectUrl) return;
    session.expectUrl = false;
    const verified = verificationUrl(line, session.userCode);
    if (!verified) { session.error = { code: "AUTH_URL_REJECTED" }; stop(session, "failed"); return; }
    session.nativeUrl = verified; session.phase = "awaiting_authorization"; session.promptReady?.();
    if (!session.browserRequested) void requestBrowser(session);
  }
  async function finish(session, exitCode, signal, final = false) {
    if (session.finishing || !active(session.phase)) return;
    if (session.stopAs) { complete(session, session.stopAs, session.error); return; }
    let payload;
    try { payload = parseCliResult({ code: exitCode ?? 1, stdout: session.stdout, stderr: session.stderr }); }
    catch (error) {
      if (!final && error.code === "CLI_RESPONSE_INVALID") return; // stdout may still be draining after exit.
      session.finishing = true;
      complete(session, "failed", { code: error.code || "AUTH_FAILED", ...(signal ? { interrupted: true } : {}) }); return;
    }
    session.finishing = true; session.phase = "verifying"; session.promptReady?.();
    const profile = identity(payload);
    clearPrivateOutput(session);
    if (!profile || exitCode !== 0) { complete(session, "failed", { code: "AUTH_IDENTITY_UNCONFIRMED" }); return; }
    try {
      const status = await readStatus(profile);
      if (closed) return;
      if (status.auth?.authenticated !== true || status.profile !== profile) { complete(session, "failed", { code: "AUTH_NOT_CONFIRMED" }); return; }
      session.profile = profile; complete(session, "ready");
    } catch (error) { complete(session, "failed", { code: error.code || "AUTH_NOT_CONFIRMED" }); }
  }
  async function begin(args) {
    if (closed) throw new BridgeError("CONNECTION_CLOSED", "The MCP connection is closed.");
    if (current && active(current.phase)) { if (args.reopen_browser) await requestBrowser(current); return view(current); }
    if (starting) return starting;
    starting = (async () => {
      let runtime;
      try { runtime = await runner.runtime(); }
      catch (error) {
        if (!["CLI_MISSING", "CLI_VERSION_MISMATCH"].includes(error.code) || env.DWS_CLI_PATH) throw error;
        await install({ env });
        runtime = await runner.runtime();
      }
      if (closed) throw new BridgeError("CONNECTION_CLOSED", "The MCP connection is closed.");
      let status = await readStatus();
      // A brand-new or legacy native store can be intentionally inconclusive
      // in readonly mode. Only explicit setup may run the official status
      // initialization/refresh; progress queries never perform this operation.
      if (status.auth?.reason === "local_state_requires_repair") status = await prepareStatus();
      if (closed) throw new BridgeError("CONNECTION_CLOSED", "The MCP connection is closed.");
      if (status.auth?.authenticated === true && status.profile && !args.reauthorize) {
        current = { id: randomUUID(), phase: "ready", profile: status.profile, reused: true }; return view(current);
      }
      if (typeof status.auth?.authenticated !== "boolean") throw new BridgeError("AUTH_STATE_UNAVAILABLE", "Could not safely determine local login state. No new login was started; existing credentials were preserved.");
      if (/keychain|dek|cipher|decrypt|repair|unreadable|inconclusive/iu.test(status.auth?.reason || "")) throw new BridgeError("AUTH_STATE_UNAVAILABLE", "The official credential store is unreadable. No reset or replacement login was attempted.");
      const session = { id: randomUUID(), phase: "starting", stdout: "", stderr: "", line: "", startedAt: now(), browserRequested: false };
      current = session;
      let promptReady;
      const prompt = new Promise(resolve => { promptReady = resolve; }); session.promptReady = promptReady;
      try {
        session.child = spawnProcess(runtime.executable, ["auth", "login", "--device", "--no-browser", "--format=json"], { env: { ...env, DWS_LANG: "zh", DWS_NO_UPDATE_CHECK: "1" }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch { complete(session, "failed", { code: "AUTH_START_FAILED" }); return view(session); }
      for (const [stream, key] of [[session.child.stdout, "stdout"], [session.child.stderr, "stderr"]]) {
        stream.setEncoding("utf8");
        stream.on("data", chunk => {
          if (!active(session.phase) || session.stopAs) return;
          if (session[key].length + chunk.length > outputLimit) { session.error = { code: "AUTH_OUTPUT_LIMIT" }; stop(session, "failed"); return; }
          session[key] += chunk;
          if (key === "stderr") {
            session.line += chunk;
            let end;
            while ((end = session.line.indexOf("\n")) >= 0) { const line = session.line.slice(0, end); session.line = session.line.slice(end + 1); parseLine(session, line); }
          }
        });
      }
      session.child.once("error", () => { if (active(session.phase)) complete(session, "failed", { code: "AUTH_START_FAILED" }); });
      session.child.once("exit", (code, signal) => { setImmediate(() => { void finish(session, code, signal); }); });
      session.child.once("close", (code, signal) => { void finish(session, code, signal, true); });
      session.timer = setTimeout(() => stop(session, "expired"), timeoutMs); session.timer.unref?.();
      let wait;
      await Promise.race([prompt, new Promise(resolve => { wait = setTimeout(resolve, startupWaitMs); })]); clearTimeout(wait);
      return view(session);
    })();
    try { return await starting; } finally { starting = null; }
  }
  async function call(name, args = {}) {
    if (!CONNECTION_TOOL_DEFINITIONS.some(tool => tool.name === name)) invalid("Unknown connection tool.");
    if (name === "connect_dingtalk") { validateArguments(args, ["reauthorize", "reopen_browser"]); return begin(args); }
    validateArguments(args, ["session_id"], name === "cancel_dingtalk_connection");
    if (args.session_id && current?.id !== args.session_id) throw new BridgeError("AUTH_SESSION_UNKNOWN", "This login session does not belong to the current MCP process. Check login status before starting another authorization.");
    if (name === "cancel_dingtalk_connection") {
      stop(current, "cancelled");
      return { ...view(current), credentials_revoked: false };
    }
    if (current) return view(current);
    try {
      const status = await readStatus();
      return { status: status.auth?.authenticated && status.profile ? "ready" : "needs_setup", ...status, next_action: "Use connect_dingtalk for guided setup when authorization is needed." };
    } catch (error) {
      return { status: "needs_setup", reason: error.code || "SETUP_REQUIRED", next_action: "Use connect_dingtalk in this chat to install the official CLI and start desktop authorization." };
    }
  }
  function close() { if (closed) return; closed = true; if (current && active(current.phase)) stop(current, "cancelled"); }
  return { call, close };
}
