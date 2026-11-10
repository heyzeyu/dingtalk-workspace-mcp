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
    client = new McpClient(); assert.equal((await client.initialize()).serverInfo.version, "0.4.0");
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
