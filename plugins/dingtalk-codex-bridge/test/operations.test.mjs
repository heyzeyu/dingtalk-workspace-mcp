import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridge } from "../mcp/bridge.mjs";
import { BridgeError, parseCliResult } from "../mcp/cli.mjs";
import { CATALOG } from "../mcp/operations.mjs";

const common = { url: "https://alidocs.dingtalk.com/i/nodes/testNode", profile: "dingOrg:user1", sheet_id: "testSheet" };
const native = { result: { extension: "axls", nodeId: "testNode" }, success: true };
function fixture(responses = [], env) {
  const calls = [];
  const bridge = createBridge({ runtime: async () => ({ version: "1.0.67" }), run: async argv => { calls.push(argv); const value = responses.shift(); if (value instanceof Error) throw value; if (value === undefined) throw Error("Unexpected command"); return value; } }, { env });
  return { bridge, calls };
}

test("pinned full catalogue has 99 unique sheet-only operations with safety metadata", async () => {
  assert.equal(CATALOG.operations.length, 99);
  assert.equal(new Set(CATALOG.operations.map(x => x.operation)).size, 99);
  for (const operation of CATALOG.operations) {
    assert.match(operation.operation, /^[a-z+][a-z0-9+ -]*$/u);
    assert.ok(["read", "write", "destructive"].includes(operation.effect));
  }
  const { bridge, calls } = fixture();
  const result = await bridge.call("describe_dingtalk_sheet_operation", { operation: "range update" });
  assert.equal(result.url_required, true);
  assert.ok(!("node" in result.parameters));
  assert.equal(calls.length, 0);
});

test("read and write interfaces cannot be interchanged", async () => {
  for (const [tool, operation] of [["read_dingtalk_sheet_operation", "new"], ["write_dingtalk_sheet_operation", "chart list"]]) {
    const { bridge, calls } = fixture();
    await assert.rejects(bridge.call(tool, { ...common, operation, parameters: {} }), { code: "INVALID_ARGUMENT" });
    assert.equal(calls.length, 0);
  }
});

test("ordinary authorized cell writes need no extra confirmation and preserve JSON", async () => {
  const { bridge, calls } = fixture([native, { success: true }]);
  const values = [[{ type: "text", text: "=SUM(B2:C2)" }, { type: "text", text: "text with ' quotes and $(literal)" }]];
  const result = await bridge.call("write_dingtalk_sheet_operation", { ...common, operation: "range update", parameters: { range: "A1:B1", values } });
  const argv = calls[1];
  assert.deepEqual(JSON.parse(argv.find(x => x.startsWith("--values=")).slice(9)), values);
  assert.ok(argv.includes("--node=testNode"));
  assert.ok(argv.includes("--sheet-id=testSheet"));
  assert.equal(result.mutation.verification, "read_back_required");
  assert.ok(!argv.includes("--yes"));
});

test("destructive authorization can be reused and dry-run does not imply execution", async () => {
  const blocked = fixture();
  await assert.rejects(blocked.bridge.call("write_dingtalk_sheet_operation", { ...common, operation: "delete-sheet" }), { code: "CONFIRMATION_REQUIRED" });
  assert.equal(blocked.calls.length, 0);
  for (const flags of [{ confirmed: true }, { dry_run: true }]) {
    const { bridge, calls } = fixture([native, { success: true }]);
    const result = await bridge.call("write_dingtalk_sheet_operation", { ...common, operation: "delete-sheet", ...flags });
    if (flags.dry_run) { assert.equal(calls.length, 0); assert.equal(result.remote_called, false); assert.equal(result.local_preview, true); }
    else { assert.equal(calls.length, 2); assert.equal(calls[1].includes("--yes"), true); }
    assert.equal(result.mutation.submitted, !flags.dry_run);
  }
});

test("dimensions, types and unknown parameters fail before external calls", async () => {
  const cases = [
    { operation: "range update", parameters: { range: "A1:B2", values: [[{ type: "text", text: "x" }]] } },
    { operation: "range update", parameters: { range: "A1", values: [["primitive is not a cell object"]] } },
    { operation: "update", parameters: { hidden: { invalid: true } } },
    { operation: "update", parameters: { name: { invalid: true } } },
    { operation: "update", parameters: { "client-secret": "forbidden" } },
    { operation: "update", parameters: { node: "anotherNode" } },
    { operation: "csv-put", parameters: { csv: "-", "start-cell": "A1" } },
    { operation: "range update", parameters: { range: "Other!A1", values: [[{}]] } }
  ];
  for (const candidate of cases) {
    const { bridge, calls } = fixture();
    await assert.rejects(bridge.call("write_dingtalk_sheet_operation", { ...common, ...candidate }));
    assert.equal(calls.length, 0);
  }
});

test("advanced reads cannot bypass bounded cell-read rules", async () => {
  for (const operation of ["csv-get", "range read", "+read", "table-get", "formula-verify"]) {
    const { bridge, calls } = fixture();
    await assert.rejects(bridge.call("read_dingtalk_sheet_operation", { ...common, operation, parameters: {} }), { code: "INVALID_ARGUMENT" });
    assert.equal(calls.length, 0);
  }
});

test("unknown mutation results explicitly prevent blind replay", async () => {
  const { bridge, calls } = fixture([native, new BridgeError("CLI_TIMEOUT", "timeout")]);
  await assert.rejects(bridge.call("write_dingtalk_sheet_operation", { ...common, operation: "append", parameters: { values: [["one row"]] } }), { code: "MUTATION_OUTCOME_UNKNOWN" });
  assert.equal(calls.filter(args => args[1] === "append").length, 1);
});

test("nested batches cannot switch workbook or invoke another product", async () => {
  for (const entry of [{ toolName: "chat message send", input: {} }, { toolName: "range update", input: { node: "otherWorkbook" } }, { toolName: "range update", input: { values: "@/etc/passwd" } }]) {
    const { bridge, calls } = fixture();
    await assert.rejects(bridge.call("write_dingtalk_sheet_operation", { url: common.url, profile: common.profile, operation: "batch-update", confirmed: true, parameters: { operations: [entry] } }), { code: "INVALID_ARGUMENT" });
    assert.equal(calls.length, 0);
  }
});

test("file operations reject symlink escape, hidden indirection and existing output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dingtalk-files-test-"));
  const root = path.join(dir, "allowed"), outside = path.join(dir, "outside");
  try {
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(outside, "private.json"), "[[{}]]");
    await symlink(outside, path.join(root, "escape"));
    await writeFile(path.join(root, "existing.xlsx"), "existing");
    const env = { DINGTALK_BRIDGE_FILES_DIR: root };
    const { bridge, calls } = fixture([], env);
    await assert.rejects(bridge.call("write_dingtalk_sheet_operation", { ...common, operation: "range update", parameters: { range: "A1", values: "@escape/private.json" } }), { code: "FILE_OUTSIDE_ALLOWED_DIRECTORY" });
    await assert.rejects(bridge.call("read_dingtalk_sheet_operation", { url: common.url, profile: common.profile, operation: "export", parameters: { output: "existing.xlsx" } }), { code: "LOCAL_FILE_EXISTS" });
    assert.equal(calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workbook creation does not require or silently invent an existing resource", async () => {
  const { bridge, calls } = fixture([{ success: true, result: { nodeId: "newWorkbook" } }]);
  const result = await bridge.call("write_dingtalk_sheet_operation", { profile: common.profile, operation: "create", parameters: { name: "New workbook" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].find(x => x.startsWith("--node")), undefined);
  assert.equal(result.mutation.verification, "verify_returned_node_and_content");
});

test("composite failure retains created node and task recovery facts without logging cell values", () => {
  try {
    parseCliResult({ code: 1, stdout: JSON.stringify({ success: false, error: { message: "write failed", details: { nodeId: "createdNode", taskId: "pendingTask", stage: "write", values: [["private content"]] } } }) });
    assert.fail("Expected failure");
  } catch (error) {
    assert.ok(error.details.recovery.some(item => item.value === "createdNode"));
    assert.ok(error.details.recovery.some(item => item.value === "pendingTask"));
    assert.ok(!JSON.stringify(error.details).includes("private content"));
  }
});

test("structured CLI errors on stderr retain actionable facts and recovery context", () => {
  assert.throws(() => parseCliResult({ code: 3, stdout: "", stderr: JSON.stringify({ error: { reason: "missing_scope", message: "Permission needed" } }) }), error => error.code === "DWS_REQUEST_FAILED" && error.details.reason === "missing_scope");
});

test("scalar write receipts still require readback and never turn false into success", () => {
  assert.equal(parseCliResult({ code: 0, stdout: "true", allowPrimitive: true }).verification, "read_back_required");
  assert.throws(() => parseCliResult({ code: 0, stdout: "false", allowPrimitive: true }), { code: "DWS_REQUEST_FAILED" });
  assert.throws(() => parseCliResult({ code: 0, stdout: "true" }), { code: "CLI_RESPONSE_INVALID" });
});
