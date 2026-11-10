import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection, openOfficialBrowser } from "../mcp/connection.mjs";
import { BridgeError } from "../mcp/cli.mjs";
import { McpClient } from "../scripts/mcp-client.mjs";

const profile = "dingFixture:fixtureUser";
const pendingPrompt = "  授权码: TEST-1234\n  授权码将在 600 秒后过期。\n  授权链接（已填入授权码）：\nhttps://login.dingtalk.com/oauth2/device/verify.htm?caller=fixture&callerUmt=synthetic-runtime-context&user_code=TEST-1234\n";
const tick = () => new Promise(resolve => setImmediate(resolve));
class LoginProcess extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null; this.signalCode = null; this.signals = []; }
  kill(signal) { this.signals.push(signal); this.signalCode = signal; queueMicrotask(() => { this.emit("exit", null, signal); this.emit("close", null, signal); }); return true; }
  finish(payload, code = 0) { this.stdout.write(JSON.stringify(payload)); this.exitCode = code; this.emit("exit", code, null); this.emit("close", code, null); }
}
function fixture(options = {}) {
  const calls = [], browsers = [], children = [];
  const state = { ready: false, installed: true, installs: 0, snapshots: [] };
  const runner = { runtime: async () => { if (!state.installed) throw new BridgeError("CLI_MISSING", "missing"); return { executable: "/fixture/dws", version: "1.0.67" }; } };
  const connection = createConnection({
    runner,
    readStatus: async selected => { state.snapshots.push(selected); return { profile: state.ready ? profile : null, auth: { authenticated: state.ready } }; },
    install: async () => { state.installs++; state.installed = true; },
    spawnProcess: (executable, argv, config) => {
      calls.push({ executable, argv, config }); const child = new LoginProcess(); children.push(child);
      queueMicrotask(() => child.stderr.write(pendingPrompt)); return child;
    },
    openBrowser: async url => { browsers.push(url); return true; },
    startupWaitMs: 5,
    ...options,
  });
  return { connection, calls, browsers, children, state };
}

test("first use installs only the pinned dependency once and keeps one pending official device login", async () => {
  const f = fixture(); f.state.installed = false;
  try {
    const [a, b] = await Promise.all([f.connection.call("connect_dingtalk"), f.connection.call("connect_dingtalk")]);
    assert.equal(a.session_id, b.session_id); assert.equal(f.state.installs, 1); assert.equal(f.children.length, 1);
    assert.deepEqual(f.calls[0].argv, ["auth", "login", "--device", "--no-browser", "--format=json"]);
    assert.equal(f.calls[0].config.shell, false);
    assert.equal(f.calls[0].config.env.DWS_LANG, "zh");
    await tick(); assert.equal(f.browsers.length, 1); assert.ok(f.browsers[0].includes("callerUmt="));
    const status = await f.connection.call("get_dingtalk_connection", { session_id: a.session_id });
    assert.equal(status.status, "awaiting_authorization"); assert.equal(f.children[0].exitCode, null);
    assert.ok(!JSON.stringify([a, b, status]).includes("TEST-1234"));
    assert.ok(!JSON.stringify([a, b, status]).includes("synthetic-runtime-context"));
    assert.ok(!JSON.stringify([a, b, status]).includes("verify.htm"));
  } finally { f.connection.close(); await tick(); }
});

test("an existing readable login is reused without installation, browser launch or reauthorization", async () => {
  const f = fixture(); f.state.ready = true;
  try {
    const result = await f.connection.call("connect_dingtalk");
    assert.equal(result.status, "ready"); assert.equal(result.profile, profile); assert.equal(result.reused_existing_login, true);
    assert.equal(result.live_access_verified, false); assert.equal(f.state.installs, 0); assert.equal(f.calls.length, 0); assert.equal(f.browsers.length, 0);
  } finally { f.connection.close(); }
});

test("explicit connection initializes an inconclusive first-use store with official status, while progress stays readonly", async () => {
  let normalizations = 0;
  const f = fixture({ readStatus: async () => ({ auth: { authenticated: false, reason: "local_state_requires_repair" } }), prepareStatus: async () => { normalizations++; return { auth: { authenticated: false } }; } });
  try {
    const first = await f.connection.call("get_dingtalk_connection"); assert.equal(first.status, "needs_setup"); assert.equal(normalizations, 0);
    const pending = await f.connection.call("connect_dingtalk"); assert.equal(pending.status, "awaiting_authorization"); assert.equal(normalizations, 1);
    await f.connection.call("get_dingtalk_connection", { session_id: pending.session_id }); assert.equal(normalizations, 1); assert.equal(f.calls.length, 1);
  } finally { f.connection.close(); }
});

test("a native success requires matching readonly identity confirmation and never returns token fields", async () => {
  const f = fixture();
  try {
    const pending = await f.connection.call("connect_dingtalk"); f.state.ready = true;
    f.children[0].finish({ success: true, token_valid: true, corp_id: "dingFixture", user_id: "fixtureUser", access_token: "synthetic-secret-value", refresh_token: "synthetic-refresh-value" });
    await tick();
    const result = await f.connection.call("get_dingtalk_connection", { session_id: pending.session_id });
    assert.equal(result.status, "ready"); assert.equal(result.profile, profile);
    assert.equal(f.state.snapshots.at(-1), profile);
    assert.ok(!JSON.stringify(result).includes("synthetic"));
  } finally { f.connection.close(); }
});

test("a fresh authorization cannot be marked ready from an unrelated pre-existing profile", async () => {
  const f = fixture(); f.state.ready = true;
  try {
    const started = await f.connection.call("connect_dingtalk", { reauthorize: true });
    f.children[0].finish({ success: true, token_valid: true, corp_id: "dingDifferent", user_id: "anotherUser" });
    await tick();
    const result = await f.connection.call("get_dingtalk_connection", { session_id: started.session_id });
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "AUTH_NOT_CONFIRMED");
    assert.equal(f.state.snapshots.at(-1), "dingDifferent:anotherUser");
    assert.equal(f.calls.length, 1);
  } finally { f.connection.close(); }
});

test("unreadable credential stores and explicit CLI overrides are preserved without reset or install", async () => {
  for (const reason of ["dek_missing", "keychain_unavailable", "ciphertext_key_mismatch"]) {
    const f = fixture({ readStatus: async () => ({ auth: { authenticated: false, reason } }) });
    try { await assert.rejects(f.connection.call("connect_dingtalk"), { code: "AUTH_STATE_UNAVAILABLE" }); assert.equal(f.calls.length, 0); assert.equal(f.state.installs, 0); }
    finally { f.connection.close(); }
  }
  const f = fixture({ env: { DWS_CLI_PATH: "/user/chosen/dws" }, runner: { runtime: async () => { throw new BridgeError("CLI_VERSION_MISMATCH", "wrong version"); } } });
  try { await assert.rejects(f.connection.call("connect_dingtalk"), { code: "CLI_VERSION_MISMATCH" }); assert.equal(f.state.installs, 0); }
  finally { f.connection.close(); }
});

test("readonly progress does not install or start login and invalid inputs never reach native execution", async () => {
  const f = fixture({ readStatus: async () => { throw new BridgeError("CLI_MISSING", "missing"); } });
  try {
    const result = await f.connection.call("get_dingtalk_connection"); assert.equal(result.status, "needs_setup");
    for (const args of [{ reauthorize: "true" }, { command: "arbitrary" }, { token: "synthetic" }]) await assert.rejects(f.connection.call("connect_dingtalk", args), { code: "INVALID_ARGUMENT" });
    await assert.rejects(f.connection.call("cancel_dingtalk_connection", {}), { code: "INVALID_ARGUMENT" });
    await assert.rejects(f.connection.call("get_dingtalk_connection", { session_id: "00000000-0000-0000-0000-000000000000" }), { code: "AUTH_SESSION_UNKNOWN" });
    assert.equal(f.state.installs, 0); assert.equal(f.calls.length, 0);
  } finally { f.connection.close(); }
});

test("only the verified official URL with the current user-code binding can open a browser", async () => {
  for (const url of [
    "https://login.dingtalk.com.evil.invalid/oauth2/device/verify.htm?user_code=TEST-1234",
    "http://127.0.0.1/callback?user_code=TEST-1234",
    "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=OTHER-123",
    "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-1234&user_code=OTHER-123",
    "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-1234&access_token=synthetic-secret-value",
  ]) {
    const f = fixture({ spawnProcess: () => { const child = new LoginProcess(); queueMicrotask(() => child.stderr.write(`授权码: TEST-1234\n授权链接（已填入授权码）：\n${url}\n`)); return child; } });
    try { const first = await f.connection.call("connect_dingtalk"); await tick(); const result = await f.connection.call("get_dingtalk_connection", { session_id: first.session_id }); assert.equal(result.status, "failed"); assert.equal(result.error.code, "AUTH_URL_REJECTED"); assert.equal(f.browsers.length, 0); }
    finally { f.connection.close(); }
  }
});

test("only the current pending process is stopped; completed credentials are preserved", async () => {
  const f = fixture();
  try {
    const started = await f.connection.call("connect_dingtalk");
    await assert.rejects(f.connection.call("cancel_dingtalk_connection", { session_id: "00000000-0000-0000-0000-000000000000" }), { code: "AUTH_SESSION_UNKNOWN" });
    assert.equal(f.children[0].signals.length, 0);
    await f.connection.call("cancel_dingtalk_connection", { session_id: started.session_id }); await tick();
    assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
    const stopped = await f.connection.call("get_dingtalk_connection", { session_id: started.session_id });
    assert.equal(stopped.status, "cancelled"); assert.equal(stopped.credentials_revoked, false);
    f.state.ready = true;
    const ready = await f.connection.call("connect_dingtalk");
    assert.equal((await f.connection.call("cancel_dingtalk_connection", { session_id: ready.session_id })).status, "ready");
    assert.equal(f.children.length, 1);
  } finally { f.connection.close(); }
});

test("timeouts terminate the owned login and do not retry an authorization", async () => {
  const f = fixture({ timeoutMs: 25 });
  try {
    const started = await f.connection.call("connect_dingtalk");
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = await f.connection.call("get_dingtalk_connection", { session_id: started.session_id });
    assert.equal(result.status, "expired"); assert.equal(f.calls.length, 1); assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  } finally { f.connection.close(); }
});

test("closing during setup prevents a late browser or login from starting", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ readStatus: () => pending });
  const start = f.connection.call("connect_dingtalk");
  await tick(); f.connection.close(); release({ auth: { authenticated: false } });
  await assert.rejects(start, { code: "CONNECTION_CLOSED" });
  assert.equal(f.calls.length, 0); assert.equal(f.browsers.length, 0);
});

test("browser launches use argument arrays with no shell or credential output", async () => {
  for (const [platform, expected] of [["darwin", "open"], ["linux", "xdg-open"], ["win32", "rundll32.exe"]]) {
    const calls = [];
    assert.equal(await openOfficialBrowser("https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-1234", { platform, env: {}, spawnProcess: (executable, argv, config) => { calls.push({ executable, argv, config }); const child = new EventEmitter(); queueMicrotask(() => child.emit("exit", 0)); return child; } }), true);
    assert.equal(calls[0].executable, expected); assert.equal(calls[0].config.shell, false); assert.equal(calls[0].config.stdio, "ignore");
  }
});

test("a slow browser launcher is never killed with the user's browser attached", async () => {
  let kills = 0, detached = 0;
  const task = openOfficialBrowser("https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-1234", { timeoutMs: 5, spawnProcess: () => { const child = new EventEmitter(); child.kill = () => { kills++; }; child.unref = () => { detached++; }; return child; } });
  const [result] = await Promise.all([task, new Promise(resolve => setTimeout(resolve, 10))]);
  assert.equal(result, false); assert.equal(kills, 0); assert.equal(detached, 1);
});

test("a replacement native device code opens the matching new page rather than leaving the expired page", async () => {
  const f = fixture();
  try {
    const session = await f.connection.call("connect_dingtalk"); await tick();
    f.children[0].stderr.write(pendingPrompt.replaceAll("TEST-1234", "NEXT-5678")); await tick();
    assert.equal(f.browsers.length, 2); assert.ok(f.browsers[1].includes("user_code=NEXT-5678"));
    const status = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(status.status, "awaiting_authorization");
    assert.ok(!JSON.stringify(status).includes("NEXT-5678"));
  } finally { f.connection.close(); }
});

test("closing before a repair-required snapshot returns does not initialize credentials afterwards", async () => {
  let release, prepared = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ readStatus: () => wait, prepareStatus: async () => { prepared++; return { auth: { authenticated: false } }; } });
  const request = f.connection.call("connect_dingtalk"); await tick(); f.connection.close();
  release({ auth: { authenticated: false, reason: "local_state_requires_repair" } });
  await assert.rejects(request, { code: "CONNECTION_CLOSED" });
  assert.equal(prepared, 0); assert.equal(f.calls.length, 0);
});

test("closing before a missing-runtime check returns does not install afterwards", async () => {
  let release, runs = 0, installs = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ runner: { runtime: async () => { if (++runs === 1) { await wait; throw new BridgeError("CLI_MISSING", "missing"); } return { executable: "/fixture/dws", version: "1.0.67" }; } }, install: async () => { installs++; } });
  const request = f.connection.call("connect_dingtalk"); await tick(); f.connection.close(); release();
  await assert.rejects(request, { code: "CONNECTION_CLOSED" }); assert.equal(installs, 0);
});

test("cancellation arriving after native success preserves the successful receipt and checks the stored identity", async () => {
  const f = fixture();
  try {
    const session = await f.connection.call("connect_dingtalk"); f.state.ready = true;
    const child = f.children[0];
    child.stdout.write(JSON.stringify({ success: true, token_valid: true, corp_id: "dingFixture", user_id: "fixtureUser" }));
    child.exitCode = 0; child.emit("exit", 0, null);
    await f.connection.call("cancel_dingtalk_connection", { session_id: session.session_id });
    child.emit("close", 0, null); await tick();
    const result = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(result.status, "ready"); assert.equal(result.profile, profile); assert.equal(child.signals.length, 0);
  } finally { f.connection.close(); }
});

test("a successful login may finish official profile initialization using only its exact receipt identity", async () => {
  let completed = false, selected;
  const f = fixture({ readStatus: async () => completed ? { auth: { authenticated: false, reason: "local_state_requires_repair" } } : { auth: { authenticated: false } }, prepareStatus: async account => { selected = account; return { auth: { authenticated: true }, profile }; } });
  try {
    const session = await f.connection.call("connect_dingtalk"); completed = true;
    f.children[0].finish({ success: true, token_valid: true, corp_id: "dingFixture", user_id: "fixtureUser" }); await tick();
    const result = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(result.status, "ready"); assert.equal(selected, profile);
  } finally { f.connection.close(); }
});

test("ready progress is rechecked after its short cache expires rather than remaining ready after logout", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, readyStatusTtlMs: 5 }); f.state.ready = true;
  try {
    const session = await f.connection.call("connect_dingtalk"); f.state.ready = false; clock += 10;
    const result = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(result.status, "needs_setup"); assert.equal(f.calls.length, 0); assert.equal(f.state.installs, 0);
  } finally { f.connection.close(); }
});

test("an already-cancelled setup request never starts a login", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  try { await assert.rejects(f.connection.call("connect_dingtalk", {}, { signal: controller.signal }), { code: "CONNECTION_CANCELLED" }); assert.equal(f.calls.length, 0); }
  finally { f.connection.close(); }
});

test("missing authorization prompts time out separately from the user's scan window", async () => {
  const child = new LoginProcess();
  const f = fixture({ handshakeTimeoutMs: 15, timeoutMs: 1000, startupWaitMs: 1, spawnProcess: () => child });
  try {
    const session = await f.connection.call("connect_dingtalk"); await new Promise(resolve => setTimeout(resolve, 40));
    const result = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "AUTH_HANDSHAKE_TIMEOUT"); assert.deepEqual(child.signals, ["SIGTERM"]);
  } finally { f.connection.close(); }
});

test("replacing a page while its previous opener is pending launches the latest page and ignores the stale outcome", async () => {
  let release;
  const pages = [];
  const f = fixture({ openBrowser: url => { pages.push(url); return pages.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true); } });
  try {
    const session = await f.connection.call("connect_dingtalk");
    f.children[0].stderr.write(pendingPrompt.replaceAll("TEST-1234", "NEXT-5678")); await tick();
    release(false); await tick();
    const result = await f.connection.call("get_dingtalk_connection", { session_id: session.session_id });
    assert.equal(pages.length, 2); assert.ok(pages[1].includes("NEXT-5678")); assert.equal(result.browser_launch_accepted, true);
  } finally { release?.(false); f.connection.close(); }
});

test("a failed browser can be explicitly reopened without issuing another device authorization", async () => {
  let launches = 0;
  const f = fixture({ openBrowser: async () => ++launches > 1 });
  try {
    const session = await f.connection.call("connect_dingtalk"); await tick();
    assert.equal((await f.connection.call("get_dingtalk_connection")).browser_launch_accepted, false);
    const retry = await f.connection.call("connect_dingtalk", { reopen_browser: true });
    assert.equal(retry.session_id, session.session_id); assert.equal(retry.browser_launch_accepted, true); assert.equal(f.children.length, 1);
  } finally { f.connection.close(); }
});

test("a cancelled request aborts dependency setup and cannot proceed to a login afterwards", async () => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = fixture({ install: ({ signal }) => new Promise((resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(new BridgeError("CLI_CANCELLED", "cancelled")), { once: true }); }) });
  f.state.installed = false;
  const controller = new AbortController();
  try {
    const request = f.connection.call("connect_dingtalk", {}, { signal: controller.signal });
    await waiting; controller.abort();
    await assert.rejects(request, { code: "CONNECTION_CANCELLED" }); assert.equal(f.calls.length, 0); assert.equal(f.browsers.length, 0);
  } finally { f.connection.close(); }
});

test("cancelling after phone approval lets the official save finish, without killing or revoking it", async () => {
  const f = fixture();
  try {
    const session = await f.connection.call("connect_dingtalk");
    f.children[0].stderr.write("\n✔ Step 3: 使用授权码换取 Access Token...\n");
    const cancel = await f.connection.call("cancel_dingtalk_connection", { session_id: session.session_id });
    assert.equal(cancel.status, "verifying"); assert.equal(f.children[0].signals.length, 0);
    f.state.ready = true; f.children[0].finish({ success: true, token_valid: true, corp_id: "dingFixture", user_id: "fixtureUser" }); await tick();
    assert.equal((await f.connection.call("get_dingtalk_connection")).status, "ready");
  } finally { f.connection.close(); }
});

test("a deadline or shutdown during credential saving reports an unknown outcome rather than a safe-to-retry expiry", async () => {
  for (const close of [false, true]) {
    const f = fixture({ timeoutMs: 20 });
    try {
      await f.connection.call("connect_dingtalk"); f.children[0].stderr.write("✔ Step 3: 使用授权码换取 Access Token...\n");
      if (close) f.connection.close(); else await new Promise(resolve => setTimeout(resolve, 40));
      await tick();
      const result = await f.connection.call("get_dingtalk_connection");
      assert.equal(result.status, "failed"); assert.equal(result.error.code, "AUTH_SAVE_OUTCOME_UNKNOWN"); assert.equal(f.children[0].signals.length, 1);
    } finally { f.connection.close(); }
  }
});

test("device progress plus a final structured failure produces a safe actionable code without leaking diagnostics", async () => {
  for (const [message, code] of [
    ["device authorization failed: 该组织尚未开启CLI数据访问权限", "AUTH_ORGANIZATION_DENIED"],
    ["device authorization failed: 保存 token 失败 keychain unavailable", "AUTH_STORE_UNAVAILABLE"],
    ["device authorization failed: 发送请求失败 dial tcp", "AUTH_NETWORK_FAILED"],
    ["device authorization failed: expired_token", "AUTH_EXPIRED_OR_DENIED"],
  ]) {
    const f = fixture();
    try {
      await f.connection.call("connect_dingtalk");
      const child = f.children[0]; child.stderr.write(JSON.stringify({ error: { category: "auth", message: message + " private-diagnostic-canary" } })); child.exitCode = 1; child.emit("close", 1, null); await tick();
      const result = await f.connection.call("get_dingtalk_connection");
      assert.equal(result.status, "failed"); assert.equal(result.error.code, code); assert.ok(!JSON.stringify(result).includes("canary"));
    } finally { f.connection.close(); }
  }
});

test("a repaired fresh login still requires the exact receipt identity and cannot start repair after shutdown", async () => {
  for (const close of [false, true]) {
    let release, started = false, prepared = 0;
    const wait = new Promise(resolve => { release = resolve; });
    const f = fixture({ readStatus: async () => started ? wait : { auth: { authenticated: false } }, prepareStatus: async () => { prepared++; return { auth: { authenticated: true }, profile: "dingOther:anotherUser" }; } });
    try {
      await f.connection.call("connect_dingtalk"); started = true;
      f.children[0].finish({ success: true, token_valid: true, corp_id: "dingFixture", user_id: "fixtureUser" });
      if (close) f.connection.close();
      release({ auth: { authenticated: false, reason: "local_state_requires_repair" } }); await tick();
      const result = await f.connection.call("get_dingtalk_connection");
      assert.equal(result.status, "failed"); assert.equal(prepared, close ? 0 : 1);
    } finally { release?.({}); f.connection.close(); }
  }
});

test("macOS falls back to its system opener when GUI PATH omits open", async () => {
  const calls = [];
  const opened = await openOfficialBrowser("https://login.dingtalk.com/oauth2/device/verify.htm?user_code=TEST-1234", { platform: "darwin", spawnProcess: command => {
    calls.push(command); const child = new EventEmitter();
    queueMicrotask(() => command === "open" ? child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })) : child.emit("exit", 0)); return child;
  } });
  assert.equal(opened, true); assert.deepEqual(calls, ["open", "/usr/bin/open"]);
});

test("an interrupted native save without a receipt requires status inspection before another authorization", async () => {
  const f = fixture();
  try {
    await f.connection.call("connect_dingtalk");
    const child = f.children[0]; child.stderr.write("✔ Step 3: 使用授权码换取 Access Token...\n");
    child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); await tick();
    const result = await f.connection.call("get_dingtalk_connection");
    assert.equal(result.error.code, "AUTH_SAVE_OUTCOME_UNKNOWN"); assert.match(result.next_action, /get_dingtalk_status/u); assert.equal(f.calls.length, 1);
  } finally { f.connection.close(); }
});

test("a progress recheck for an explicit session does not return a concurrent new authorization's session", async () => {
  let clock = 1000, release, block = false;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture({ now: () => clock, readyStatusTtlMs: 5, readStatus: selected => selected && block ? wait : Promise.resolve({ auth: { authenticated: true }, profile }) });
  try {
    const ready = await f.connection.call("connect_dingtalk"); clock += 10; block = true;
    const poll = f.connection.call("get_dingtalk_connection", { session_id: ready.session_id }); await tick();
    const fresh = await f.connection.call("connect_dingtalk", { reauthorize: true });
    release({ auth: { authenticated: true }, profile });
    const checked = await poll;
    assert.equal(checked.session_id, ready.session_id); assert.notEqual(checked.session_id, fresh.session_id);
  } finally { release?.({}); f.connection.close(); }
});

for (const completeLogin of [true, false]) test(completeLogin ? "MCP authorization survives the initiating tool return and completes on a later poll" : "closing the MCP session stops the exact pending login child", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dingtalk-connect-e2e-"));
  const keys = ["DWS_CLI_PATH", "DWS_CONFIG_DIR", "PATH"], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let client;
  try {
    const bin = path.join(root, "bin"); await mkdir(bin);
    const opener = path.join(bin, process.platform === "darwin" ? "open" : "xdg-open"); await writeFile(opener, "#!/bin/sh\nexit 0\n"); await chmod(opener, 0o755);
    const fake = path.join(root, "dws");
    await writeFile(fake, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst root=process.env.DWS_CONFIG_DIR;const args=process.argv.slice(2);\nif(args.includes('--version')){console.log('dws version v1.0.67 (fixture)');}\nelse if(args[0]==='auth'&&args[1]==='status'){console.log(JSON.stringify(fs.existsSync(root+'/approved')?{authenticated:true,corp_id:'dingFixture',user_id:'fixtureUser'}:{authenticated:false}));}\nelse if(args[0]==='auth'&&args[1]==='login'){setTimeout(()=>process.exit(2),5000).unref();fs.writeFileSync(root+'/login-pid',String(process.pid));process.stderr.write(${JSON.stringify(pendingPrompt)});const poll=setInterval(()=>{if(fs.existsSync(root+'/approved')){clearInterval(poll);console.log(JSON.stringify({success:true,token_valid:true,corp_id:'dingFixture',user_id:'fixtureUser'}));}},20);}\nelse{process.exit(1);}\n`); await chmod(fake, 0o755);
    process.env.DWS_CLI_PATH = fake; process.env.DWS_CONFIG_DIR = root; process.env.PATH = bin + path.delimiter + previous.PATH;
    client = new McpClient(); assert.equal((await client.initialize()).serverInfo.version, "0.4.1");
    assert.equal((await client.request("tools/list")).tools.length, 20);
    const started = await client.call("connect_dingtalk"); assert.equal(started.status, "awaiting_authorization");
    const pid = Number(await readFile(path.join(root, "login-pid"), "utf8")); process.kill(pid, 0);
    assert.ok(!JSON.stringify(started).includes("TEST-1234"));
    if (!completeLogin) {
      client.close(); client = null;
      let alive = true;
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { alive = false; break; } throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(alive, false); return;
    }
    await writeFile(path.join(root, "approved"), "approved fixture");
    let status;
    for (let i = 0; i < 30; i++) { status = await client.call("get_dingtalk_connection", { session_id: started.session_id }); if (status.status === "ready") break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(status.status, "ready"); assert.equal(status.profile, profile);
  } finally {
    client?.close();
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    await rm(root, { recursive: true, force: true });
  }
});
