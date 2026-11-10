import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { startServer } from "../mcp/server.mjs";
import { BridgeError } from "../mcp/cli.mjs";
import { installCli } from "../scripts/setup.mjs";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function harness(bridge) {
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  let buffer = "";
  output.on("data", bytes => { buffer += bytes; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) messages.push(JSON.parse(line)); });
  const reader = startServer({ input, output, bridge });
  return { send: request => input.write(typeof request === "string" ? request + "\n" : JSON.stringify(request) + "\n"), messages, close: () => { reader.close(); input.end(); output.end(); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("MCP handshake, tool discovery, tool results and notifications use valid JSON-RPC", async () => {
  const h = harness({ call: async () => ({ sample: true }) });
  try {
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_dingtalk_sheet_csv", arguments: {} } });
    await tick();
    assert.equal(h.messages.length, 3);
    assert.equal(h.messages[0].result.protocolVersion, "2025-06-18");
    assert.equal(h.messages[1].result.tools.length, 17);
    for (const tool of h.messages[1].result.tools) assert.equal(tool.annotations.readOnlyHint, !["write_dingtalk_sheet_operation", "write_dingtalk_command", "call_dingtalk_openapi", "listen_dingtalk_events", "invoke_dingtalk_published_mcp"].includes(tool.name));
    assert.deepEqual(h.messages[2].result.structuredContent, { sample: true });
  } finally { h.close(); }
});

test("invalid JSON and unknown methods do not crash server or leak internal errors", async () => {
  const h = harness({ call: async () => { throw new Error("private secret"); } });
  try {
    h.send("{");
    h.send({ jsonrpc: "2.0", id: 1, method: "unknown" });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read" } });
    h.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    await tick();
    assert.ok(h.messages.some(r => r.error?.code === -32700));
    assert.ok(h.messages.some(r => r.error?.code === -32601));
    assert.ok(!JSON.stringify(h.messages).includes("private secret"));
    assert.deepEqual(h.messages.find(r => r.id === 3).result, {});
  } finally { h.close(); }
});

test("tool failures carry explicit isError with a stable actionable code", async () => {
  const h = harness({ call: async () => { throw new BridgeError("DWS_REQUEST_FAILED", "Denied", { reason: "NO_PERMISSION" }); } });
  try {
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } });
    await tick();
    assert.equal(h.messages[0].result.isError, true);
    const data = JSON.parse(h.messages[0].result.content[0].text);
    assert.equal(data.error.details.reason, "NO_PERMISSION");
  } finally { h.close(); }
});

test("concurrent reads are bounded without silently dropping requests", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ call: async () => { await pending; return {}; } });
  try {
    for (let id = 1; id <= 5; id++) h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "read" } });
    await tick();
    assert.equal(h.messages.length, 1);
    assert.equal(JSON.parse(h.messages[0].result.content[0].text).error.code, "BUSY");
    release(); await tick();
    assert.equal(h.messages.length, 5);
  } finally { release(); h.close(); }
});

test("installer rejects corrupt or substituted archives before installation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dingtalk-install-test-"));
  try {
    const archive = path.join(dir, "tampered.tar.gz"), cache = path.join(dir, "cache");
    await writeFile(archive, "This is not an official archive");
    await assert.rejects(installCli({ archive, env: { ...process.env, DINGTALK_BRIDGE_CACHE_DIR: cache } }), { code: "CHECKSUM_MISMATCH" });
    assert.deepEqual(await readdir(dir), ["tampered.tar.gz"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("oversize write receipts preserve recovery and prohibit repeating the mutation", async () => {
  const h = harness({ call: async () => ({ operation: "create", mutation: { submitted: true }, result: { nodeId: "createdNode", text: "x".repeat(200001) } }) });
  try {
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_dingtalk_sheet_operation" } });
    await tick();
    const result = JSON.parse(h.messages[0].result.content[0].text);
    assert.equal(result.error.code, "MUTATION_OUTCOME_UNKNOWN");
    assert.ok(result.error.details.recovery.some(item => item.value === "createdNode"));
  } finally { h.close(); }
});
