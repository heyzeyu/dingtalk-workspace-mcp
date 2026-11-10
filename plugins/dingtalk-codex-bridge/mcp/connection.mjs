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
    function launch(executable) {
      if (settled) return;
      try {
        child = spawnProcess(executable, argv, { env, shell: false, windowsHide: true, stdio: "ignore" });
        child.once("error", error => { if (error.code === "ENOENT" && platform === "darwin" && executable === "open") launch("/usr/bin/open"); else finish(false); });
        child.once("exit", code => finish(code === 0));
      } catch (error) { if (error.code === "ENOENT" && platform === "darwin" && executable === "open") launch("/usr/bin/open"); else finish(false); }
    }
    launch(command);
  });
}

// Device login mixes human progress on stderr with one final error object.
// This framing is specific to login: business JSON parsing remains strict.
function loginResult(code, stdout, stderr) {
  try { return parseCliResult({ code, stdout, stderr }); }
  catch (error) {
    if (code === 0 || error.code !== "CLI_RESPONSE_INVALID") throw error;
    const plain = stripVTControlCharacters(stderr).trim();
    const start = plain.startsWith("{") ? 0 : plain.lastIndexOf("\n{") + 1;
    if (!start && !plain.startsWith("{")) throw error;
    let value;
    try { value = JSON.parse(plain.slice(start)); } catch { throw error; }
    if (!value || Array.isArray(value) || !(value.error || value.success === false || value.ok === false)) throw error;
    return parseCliResult({ code, stdout: JSON.stringify(value) });
  }
}
function safeLoginError(error, signal) {
  const text = String(error.details?.message || "");
  const code = /CLI 数据访问权限|组织.*(?:CLI|渠道)|企业安全认证|channel.*(?:allow|auth)|CLI.*访问个人数据/iu.test(text) ? "AUTH_ORGANIZATION_DENIED"
    : /keychain|钥匙串|DEK|decrypt|cipher|本地登录态无法安全更新|保存 token 失败/iu.test(text) ? "AUTH_STORE_UNAVAILABLE"
    : /network|timeout|timed out|网络|发送请求失败|connection refused|dial tcp/iu.test(text) ? "AUTH_NETWORK_FAILED"
    : /授权码已过期|expired_token|access_denied|authorization_declined/iu.test(text) ? "AUTH_EXPIRED_OR_DENIED"
    : error.code || "AUTH_FAILED";
  return { code, ...(signal ? { interrupted: true } : {}) };
}

export function createConnection({ runner, readStatus, prepareStatus = readStatus, env = process.env, install = installCli, spawnProcess = spawn, openBrowser = url => openOfficialBrowser(url, { env }), timeoutMs = 660000, handshakeTimeoutMs = 90000, readyStatusTtlMs = 5000, startupWaitMs = 1000, now = Date.now } = {}) {
  let current = null, starting = null, setupController = null, closed = false;
  const outputLimit = 65536;
  function view(session) {
    const result = { status: session.phase, session_id: session.id, local_snapshot: true, live_access_verified: false };
    if (session.phase === "ready") return { ...result, profile: session.profile, reused_existing_login: session.reused === true, checked_at: new Date(session.checkedAt).toISOString(), next_action: "Continue the user's requested business operation with this explicit profile; verify actual resource access." };
    if (active(session.phase)) return { ...result, poll_after_seconds: 3, browser_launch_requested: !!session.browserRequested, browser_launch_accepted: !!session.browserAccepted, ...(session.expiresAt ? { expires_at: new Date(session.expiresAt).toISOString() } : {}), message: session.phase === "verifying" ? "正在确认并保存官方登录结果。此时停止等待不会撤销授权；请保持 Codex 打开，等待保存完成。" : session.phase === "starting" ? "正在与钉钉建立设备授权连接，尚未取得授权页。" : session.browserFailed ? "未能打开本机浏览器。确认浏览器可用后，调用 connect_dingtalk(reopen_browser=true)。SSH/无桌面环境请在终端使用官方设备授权流程。" : "请在本机打开的钉钉官方授权页扫码、选择组织并确认。无需返回 127.0.0.1；插件会持续等待结果。", next_action: "Call get_dingtalk_connection with this session_id; do not start another login or resend any business write." };
    if (["needs_setup", "needs_attention"].includes(session.phase)) return { ...result, ...(session.error ? { error: session.error } : {}), credentials_revoked: false, next_action: session.phase === "needs_setup" ? "Login is no longer confirmed. Use connect_dingtalk for guided setup." : "Login could not be rechecked. Inspect local status and credential-store access before reauthorization; do not reset credentials." };
    if (session.error?.code === "AUTH_SAVE_OUTCOME_UNKNOWN") return { ...result, error: session.error, credentials_revoked: false, message: "授权保存结果不明，可能已经完成。先检查本机登录状态和同一账号的有界读取，不要直接重试强制授权或清除凭据。", next_action: "Call get_dingtalk_status; verify the intended profile before deciding whether any new authorization is needed." };
    return { ...result, ...(session.error ? { error: session.error } : {}), credentials_revoked: false, message: session.phase === "cancelled" ? "已停止本次登录进程，未退出或撤销已有登录。" : session.phase === "expired" ? "本次授权等待已过期，可重新发起连接。" : "官方授权未能完成。已有凭据未重置；请检查网络、系统钥匙串和组织 CLI 准入。" };
  }
  function clearTimers(session) { clearTimeout(session.timer); clearTimeout(session.killTimer); clearTimeout(session.handshakeTimer); }
  function clearPrivateOutput(session) { session.stdout = ""; session.stderr = ""; session.line = ""; session.userCode = null; session.nativeUrl = null; }
  function complete(session, phase, error) {
    clearTimers(session); session.phase = phase; session.error = error;
    if (phase === "ready") session.checkedAt = now();
    clearPrivateOutput(session); session.promptReady?.();
  }
  function stop(session, phase) {
    if (!active(session.phase) || session.finishing || session.stopAs) return;
    const child = session.child;
    // Exit and close can race with cancellation. Let stdout finish draining and
    // validate the native receipt instead of discarding an already saved login.
    if (child && (child.exitCode !== null || child.signalCode)) return;
    // Once phone approval has reached token exchange, a normal cancellation must
    // not interrupt persistence. A hard deadline is an explicitly unknown result.
    if (session.saveStarted && phase === "cancelled" && !closed) return;
    if (session.saveStarted && (phase === "expired" || closed)) { session.error = { code: "AUTH_SAVE_OUTCOME_UNKNOWN" }; phase = "failed"; }
    session.stopAs = phase; session.phase = "cancelling";
    if (!child) { complete(session, phase, session.error); return; }
    child.kill("SIGTERM");
    session.killTimer = setTimeout(() => { if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); }, 2000);
    session.killTimer.unref?.();
  }
  async function requestBrowser(session) {
    if (closed || !session.nativeUrl || session.phase !== "awaiting_authorization" || session.opening) return;
    const url = session.nativeUrl;
    session.browserRequested = true; session.opening = true;
    try { const accepted = await openBrowser(url); if (session.nativeUrl === url && active(session.phase)) { session.browserAccepted = !!accepted; session.browserFailed = !accepted; } }
    catch { if (session.nativeUrl === url && active(session.phase)) session.browserFailed = true; }
    finally { session.opening = false; if (session.nativeUrl && session.nativeUrl !== url) void requestBrowser(session); }
  }
  function parseLine(session, original) {
    if (!active(session.phase) || session.stopAs || session.finishing) return;
    const line = stripVTControlCharacters(original).trim();
    if (session.nativeUrl && /\bStep 3:\s*使用授权码换取 Access Token/u.test(line)) { session.saveStarted = true; session.phase = "verifying"; return; }
    const code = line.match(/^授权码\s*[:：]\s*([A-Za-z0-9-]{4,32})$/u);
    if (code) { session.userCode = code[1]; session.expectUrl = false; return; }
    const expiry = line.match(/^授权码将在\s*(\d+)\s*秒后过期/u);
    if (expiry) session.expiresAt = Math.min(now() + Math.min(Number(expiry[1]), 660) * 1000, session.startedAt + timeoutMs);
    if (line === "授权链接（已填入授权码）：" || line === "授权链接（已填入授权码）:") { session.expectUrl = true; return; }
    if (!line || !session.expectUrl) return;
    session.expectUrl = false;
    const verified = verificationUrl(line, session.userCode);
    if (!verified) { session.error = { code: "AUTH_URL_REJECTED" }; stop(session, "failed"); return; }
    const changed = session.nativeUrl !== verified;
    session.nativeUrl = verified; session.phase = "awaiting_authorization"; session.saveStarted = false;
    clearTimeout(session.handshakeTimer); session.promptReady?.();
    if (changed) { session.browserAccepted = false; session.browserFailed = false; void requestBrowser(session); }
  }
  async function finish(session, exitCode, signal, final = false) {
    if (session.finishing || !active(session.phase)) return;
    if (session.stopAs) { complete(session, session.stopAs, session.error); return; }
    let payload;
    try { payload = loginResult(exitCode ?? 1, session.stdout, session.stderr); }
    catch (error) {
      if (!final && error.code === "CLI_RESPONSE_INVALID") return; // stdout may still be draining after exit.
      session.finishing = true;
      complete(session, "failed", session.saveStarted && (signal || error.code === "CLI_RESPONSE_INVALID") ? { code: "AUTH_SAVE_OUTCOME_UNKNOWN" } : safeLoginError(error, signal)); return;
    }
    session.finishing = true; session.phase = "verifying"; session.promptReady?.();
    const profile = identity(payload);
    clearPrivateOutput(session);
    if (!profile || exitCode !== 0) { complete(session, "failed", { code: "AUTH_IDENTITY_UNCONFIRMED" }); return; }
    try {
      let status = await readStatus(profile);
      if (!closed && status.auth?.reason === "local_state_requires_repair") status = await prepareStatus(profile);
      if (closed) { complete(session, "failed", { code: "AUTH_SAVE_OUTCOME_UNKNOWN" }); return; }
      if (status.auth?.authenticated !== true || status.profile !== profile) { complete(session, "failed", { code: "AUTH_NOT_CONFIRMED" }); return; }
      session.profile = profile; complete(session, "ready");
    } catch (error) { complete(session, "failed", { code: error.code || "AUTH_NOT_CONFIRMED" }); }
  }
  function checkOpen(signal) {
    if (closed) throw new BridgeError("CONNECTION_CLOSED", "The MCP connection is closed.");
    if (signal?.aborted) throw new BridgeError("CONNECTION_CANCELLED", "Connection setup was cancelled; existing credentials were preserved.");
  }
  async function begin(args, signal) {
    checkOpen(signal);
    if (current && active(current.phase)) { if (args.reopen_browser) await requestBrowser(current); return view(current); }
    if (starting) return starting;
    const controller = new AbortController(); setupController = controller;
    const abort = () => { controller.abort(); if (current && active(current.phase)) stop(current, "cancelled"); };
    signal?.addEventListener("abort", abort, { once: true });
    starting = (async () => {
      let runtime;
      try { runtime = await runner.runtime(); }
      catch (error) {
        checkOpen(controller.signal);
        if (!["CLI_MISSING", "CLI_VERSION_MISMATCH"].includes(error.code) || env.DWS_CLI_PATH) throw error;
        await install({ env, signal: controller.signal });
        checkOpen(controller.signal);
        runtime = await runner.runtime();
      }
      checkOpen(controller.signal);
      let status = await readStatus();
      checkOpen(controller.signal);
      // A brand-new or legacy native store can be intentionally inconclusive
      // in readonly mode. Only explicit setup may run the official status
      // initialization/refresh; progress queries never perform this operation.
      if (status.auth?.reason === "local_state_requires_repair") status = await prepareStatus();
      checkOpen(controller.signal);
      if (status.auth?.authenticated === true && status.profile && !args.reauthorize) {
        current = { id: randomUUID(), phase: "ready", profile: status.profile, reused: true, checkedAt: now() }; return view(current);
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
      session.handshakeTimer = setTimeout(() => { if (session.phase === "starting") { session.error = { code: "AUTH_HANDSHAKE_TIMEOUT" }; stop(session, "failed"); } }, handshakeTimeoutMs); session.handshakeTimer.unref?.();
      let wait;
      await Promise.race([prompt, new Promise(resolve => { wait = setTimeout(resolve, startupWaitMs); })]); clearTimeout(wait);
      checkOpen(controller.signal);
      return view(session);
    })();
    try { return await starting; }
    catch (error) { checkOpen(controller.signal); throw error; }
    finally { signal?.removeEventListener("abort", abort); starting = null; if (setupController === controller) setupController = null; }
  }
  async function refreshReady(session) {
    if (session.phase !== "ready" || now() - session.checkedAt < readyStatusTtlMs) return;
    if (!session.refreshing) session.refreshing = (async () => {
      try {
        const status = await readStatus(session.profile);
        if (status.auth?.authenticated !== true || status.profile !== session.profile) {
          const unknown = typeof status.auth?.authenticated !== "boolean" || /keychain|dek|cipher|decrypt|repair|unreadable|inconclusive/iu.test(status.auth?.reason || "");
          complete(session, unknown ? "needs_attention" : "needs_setup", { code: unknown ? "AUTH_STATE_UNAVAILABLE" : "AUTH_NOT_CONFIRMED" });
        } else session.checkedAt = now();
      } catch (error) { complete(session, "needs_attention", { code: error.code || "AUTH_STATE_UNAVAILABLE" }); }
    })().finally(() => { session.refreshing = null; });
    await session.refreshing;
  }
  async function call(name, args = {}, { signal } = {}) {
    if (!CONNECTION_TOOL_DEFINITIONS.some(tool => tool.name === name)) invalid("Unknown connection tool.");
    if (name === "connect_dingtalk") { validateArguments(args, ["reauthorize", "reopen_browser"]); return begin(args, signal); }
    validateArguments(args, ["session_id"], name === "cancel_dingtalk_connection");
    if (args.session_id && current?.id !== args.session_id) throw new BridgeError("AUTH_SESSION_UNKNOWN", "This login session does not belong to the current MCP process. Check login status before starting another authorization.");
    if (name === "cancel_dingtalk_connection") {
      stop(current, "cancelled");
      return { ...view(current), credentials_revoked: false };
    }
    if (current) { const session = current; await refreshReady(session); return view(session); }
    try {
      const status = await readStatus();
      return { status: status.auth?.authenticated && status.profile ? "ready" : "needs_setup", ...status, next_action: "Use connect_dingtalk for guided setup when authorization is needed." };
    } catch (error) {
      return { status: "needs_setup", reason: error.code || "SETUP_REQUIRED", next_action: "Use connect_dingtalk in this chat to install the official CLI and start desktop authorization." };
    }
  }
  function close() { if (closed) return; closed = true; setupController?.abort(); if (current && active(current.phase)) stop(current, "cancelled"); }
  return { call, close };
}
