import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAdapters } from "../mcp/adapters.mjs";
import { createWorkspace } from "../mcp/workspace.mjs";
import { validateId, validateProfile } from "../mcp/bridge.mjs";

function fixture(spawnProcess) {
  const calls = [], runner = { runtime: async () => ({ executable: "/fixture/dws" }), run: async argv => { calls.push(argv); return { success: true }; } };
  const workspace = createWorkspace({ runner, sheetCall: async () => ({}), validateId, validateProfile });
  return { adapters: createAdapters({ runner, workspace, validateProfile, spawnProcess }), calls };
}
test("raw API previews require no credentials or native call and restrict official hosts", async () => {
  const { adapters, calls } = fixture();
  const preview = await adapters.call("call_dingtalk_openapi", { method: "GET", path: "/v1.0/microApp/allApps" });
  assert.equal(preview.remote_called, false); assert.equal(calls.length, 0);
  for (const path of ["https://attacker.invalid/api", "//attacker.invalid/api", "/../api", "/x?access_token=secret"]) await assert.rejects(adapters.call("call_dingtalk_openapi", { method: "GET", path }));
  await assert.rejects(adapters.call("call_dingtalk_openapi", { method: "GET", path: "/x", host: "attacker.invalid" }));
  await assert.rejects(adapters.call("call_dingtalk_openapi", { method: "POST", path: "/x", dry_run: false }), { code: "CONFIRMATION_REQUIRED" });
});
test("event previews are bounded, do not subscribe, and reject bus/file overrides", async () => {
  const { adapters } = fixture(() => { throw Error("No spawn during preview"); });
  const result = await adapters.call("listen_dingtalk_events", { profile: "dingFixture:userFixture", event_keys: ["user_calendar_event_changed"], seconds: 5, max_events: 1, dry_run: true });
  assert.equal(result.remote_called, false); assert.ok(result.plan.includes("--duration=5s"));
  await assert.rejects(adapters.call("listen_dingtalk_events", { profile: "dingFixture:userFixture", event_keys: ["user_calendar_event_changed"], seconds: 0 }));
  await assert.rejects(adapters.call("listen_dingtalk_events", { profile: "dingFixture:userFixture", event_keys: ["user_calendar_event_changed"], parameters: { foreground: true } }));
});
test("event NDJSON is parsed and credentials are redacted without killing a shared bus", async () => {
  const signals = [];
  const { adapters } = fixture(() => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = signal => { signals.push(signal); };
    setImmediate(() => { child.stdout.write('{"event_type":"fixture","data":{"accessToken":"private"}}\n'); child.emit("close", 0); });
    return child;
  });
  const result = await adapters.call("listen_dingtalk_events", { profile: "dingFixture:userFixture", event_keys: ["user_calendar_event_changed"], seconds: 1 });
  assert.equal(result.count, 1); assert.equal(result.events[0].data.accessToken, "[REDACTED]"); assert.equal(result.delivery_verified, true); assert.ok(!signals.includes("SIGKILL"));
});

test("published MCP previews keep native schema gating and block unapproved actual calls", async () => {
  const { adapters, calls } = fixture();
  const args = { profile: "dingFixture:userFixture", mcp_id: "1234", tool: "fixture_query", parameters: { query: "fixture" } };
  const preview = await adapters.call("invoke_dingtalk_published_mcp", args);
  assert.equal(preview.remote_called, false); assert.equal(calls.length, 0);
  await assert.rejects(adapters.call("invoke_dingtalk_published_mcp", { ...args, dry_run: false }), { code: "CONFIRMATION_REQUIRED" });
  await assert.rejects(adapters.call("invoke_dingtalk_published_mcp", { ...args, mcp_id: "https://attacker.invalid" }));
});
