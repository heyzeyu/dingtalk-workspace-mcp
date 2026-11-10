import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, completionOf, parseRange, validateUrl } from "../mcp/bridge.mjs";
import { createRunner, parseCliResult, redact } from "../mcp/cli.mjs";

const url = "https://alidocs.dingtalk.com/i/nodes/realNode";
const args = { url, profile: "dingOrg:user1", sheet_id: "sheet1", range: "A1:B2" };
function fixture(responses) {
  const calls = [];
  const runner = { runtime: async () => ({ version: "1.0.67" }), run: async argv => { calls.push(argv); if (!responses.length) throw Error("Unexpected call"); return responses.shift(); } };
  return { bridge: createBridge(runner), calls };
}
const native = { success: true, result: { extension: "axls", nodeId: "realNode", name: "Test" } };
const full = { cells: [[{ value: "001" }, { value: "=A1" }], [{ value: "9007199254740993" }, { value: null }]], rowIndices: [1, 2], colIndices: ["A", "B"], returnedRange: "A1:B2", hasMore: false, truncationReasons: [] };

test("read preserves precise cells, coordinate mappings, formulas and selected identity", async () => {
  const { bridge, calls } = fixture([native, full]);
  const result = await bridge.call("read_dingtalk_sheet_cells", { ...args, value_render_option: "formula" });
  assert.equal(result.completeness.complete, true);
  assert.equal(result.result.cells[1][0].value, "9007199254740993");
  assert.deepEqual(result.result.rowIndices, [1, 2]);
  assert.equal(result.result.cells[0][1].value, "=A1");
  for (const call of calls) assert.equal(call[call.indexOf("--profile") + 1], args.profile);
  assert.ok(calls[1].includes("formula"));
});

test("uploaded Excel files and AI tables never reach sheet commands", async () => {
  for (const extension of ["xlsx", "xls", "xlsm", "csv", "able", "adoc"]) {
    const { bridge, calls } = fixture([{ result: { extension, nodeId: "realNode" }, success: true }]);
    await assert.rejects(bridge.call("read_dingtalk_sheet_csv", args), { code: "RESOURCE_NOT_ONLINE_SHEET" });
    assert.equal(calls.length, 1);
  }
});

test("shortcut content reads resolve to target without touching entry data", async () => {
  const { bridge, calls } = fixture([
    { result: { extension: "dlink", fileId: "entry1" } },
    { result: { linkSourceInfo: { extension: "dlink", nodeId: "entry2" } } },
    { result: { linkSourceInfo: { extension: "axls", nodeId: "target1" } } },
    { ok: true, data: { count: 1, sheets: [{ sheetId: "s1", title: "Sheet1" }] } }
  ]);
  const result = await bridge.call("get_dingtalk_workbook", { url, profile: args.profile });
  assert.deepEqual(result.resource.shortcuts, ["entry1", "entry2"]);
  assert.equal(calls[3][calls[3].indexOf("--node") + 1], "target1");
});

test("shortcut cycles, unknown types and missing targets fail closed", async () => {
  const cases = [
    [[{ result: { extension: "dlink", nodeId: "realNode" } }, { result: { linkSourceInfo: { extension: "dlink", nodeId: "realNode" } } }], "SHORTCUT_LOOP"],
    [[{ result: { extension: "dlink", nodeId: "realNode" } }, { result: {} }], "SHORTCUT_TARGET_MISSING"],
    [[{ result: { name: "Unknown" } }], "RESOURCE_TYPE_UNKNOWN"]
  ];
  for (const [responses, code] of cases) {
    const { bridge } = fixture(responses);
    await assert.rejects(bridge.call("get_dingtalk_workbook", { url, profile: args.profile }), { code });
  }
});

test("all arguments are validated before any external call", async () => {
  const invalid = [
    { ...args, profile: "dingOrg" }, { ...args, profile: "dingOrg:user1,dingOther:user2" },
    { ...args, sheet_id: "--yes" }, { ...args, range: "Sheet2!A1:B2" },
    { ...args, range: "A1:XFD1048576" }, { ...args, range: "B2:A1" },
    { ...args, range: "A:A" }, { ...args, max_chars: 0 }, { ...args, value_render_option: "unknown" },
    { ...args, url: "https://alidocs.dingtalk.com.attacker.invalid/i/nodes/n" },
    { ...args, extra: "arbitrary CLI" }
  ];
  for (const candidate of invalid) {
    const { bridge, calls } = fixture([]);
    await assert.rejects(bridge.call("read_dingtalk_sheet_csv", candidate));
    assert.equal(calls.length, 0);
  }
});

test("URLs restrict trusted host, reject short shares, canonicalize node tracking", () => {
  assert.equal(validateUrl(url + "?utm_scene=space&iframeQuery=anything").node, "realNode");
  for (const value of ["http://alidocs.dingtalk.com/i/nodes/a", "https://x:password@alidocs.dingtalk.com/i/nodes/a", "https://alidocs.dingtalk.com:8080/i/nodes/a", "file:///tmp/x", "https://alidocs.dingtalk.com/i/nodes/%2f", "https://alidocs.dingtalk.com/i/p/share/sheets/a"]) assert.throws(() => validateUrl(value));
  const legacy = "https://alidocs.dingtalk.com/spreadsheetv2/key123/edit?dentryKey=key123&type=s";
  assert.equal(validateUrl(legacy).node, legacy);
});

test("partial and uncertain reads cannot be reported as complete", () => {
  assert.equal(completionOf(full, "A1:B2").complete, true);
  assert.equal(completionOf({ ...full, hasMore: true }, "A1:B2").complete, false);
  assert.equal(completionOf({ ...full, truncationReasons: ["max_chars"] }, "A1:B2").complete, false);
  assert.equal(completionOf({ ...full, returnedRange: "A1:B1" }, "A1:B2").complete, false);
  assert.equal(completionOf({ cells: [] }, "A1:B2").complete, null);
  assert.equal(completionOf({ ...full, returnedRange: null }, "A1:B2").complete, null);
});

test("oversize cells return a useful error, never silently cut JSON", async () => {
  const { bridge } = fixture([native, { ...full, cells: [[{ value: "X".repeat(200001) }]] }]);
  await assert.rejects(bridge.call("read_dingtalk_sheet_cells", args), { code: "OUTPUT_LIMIT" });
});

test("DWS errors are recognized at top level and within envelopes even with exit zero", () => {
  for (const value of [{ ok: false, error: { message: "denied" } }, { success: true, result: { success: false, message: "denied" } }, { isError: true }, { error: { code: "NO_PERMISSION" } }]) {
    assert.throws(() => parseCliResult({ code: 0, stdout: JSON.stringify(value) }), { code: "DWS_REQUEST_FAILED" });
  }
  assert.throws(() => parseCliResult({ code: 0, stdout: "Not JSON" }), { code: "CLI_RESPONSE_INVALID" });
  assert.throws(() => parseCliResult({ code: 0, stdout: "null" }), { code: "CLI_RESPONSE_INVALID" });
});

test("credentials are redacted from nested data and diagnostics", () => {
  const result = redact({ accessToken: "secret-value", result: [{ refresh_token: "secret-value", message: "Bearer secret-value access_token=secret-value" }] });
  assert.ok(!JSON.stringify(result).includes("secret-value"));
});

test("macOS loader warnings do not hide structured native errors or expose diagnostics", () => {
  const stderr = 'objc[1234]: duplicate runtime class at /private/synthetic-runtime/path\n' + JSON.stringify({ error: { category: "api", code: 1, reason: "business_error", server_error_code: "40026", message: "no authority to perform this operation; Bearer synthetic-secret-value" } });
  assert.throws(() => parseCliResult({ code: 1, stdout: "", stderr }), error => {
    assert.equal(error.code, "DWS_REQUEST_FAILED");
    assert.equal(error.details.reason, "business_error");
    assert.equal(error.details.server_error_code, "40026");
    assert.equal(error.details.message, "no authority to perform this operation; Bearer [REDACTED]");
    const visible = JSON.stringify(error);
    assert.ok(!visible.includes("synthetic-secret-value"));
    assert.ok(!visible.includes("synthetic-runtime"));
    return true;
  });
  assert.throws(() => parseCliResult({ code: 1, stdout: JSON.stringify({ ok: false, error: { upstream_code: "SYSTEM_ERROR", message: "business error" } }) }), error => error.code === "DWS_REQUEST_FAILED" && error.details.upstream_code === "SYSTEM_ERROR");
});

test("stderr parsing does not guess JSON inside arbitrary or incomplete diagnostics", () => {
  for (const stderr of [
    'unrelated diagnostic\n{"error":{"message":"denied"}}',
    'objc[1234]: warning without a structured error\n',
    'objc[1234]: warning\n{"error":',
    'objc[1234]: warning\n{"error":{"message":"denied"}}\nunrelated suffix',
  ]) assert.throws(() => parseCliResult({ code: 1, stdout: "", stderr }), { code: "CLI_RESPONSE_INVALID" });
  assert.throws(() => parseCliResult({ code: 0, stdout: "", stderr: 'objc[1234]: warning\n{"success":true}' }), { code: "CLI_RESPONSE_INVALID" });
});

test("unsupported CLI versions stop before any resource API request", async () => {
  let executions = 0;
  const runner = createRunner({ execute: async () => { executions++; return { code: 0, stdout: "dws version v9.9.9 (example)" }; } });
  await assert.rejects(runner.run(["drive", "info"]), { code: "CLI_VERSION_MISMATCH" });
  assert.equal(executions, 1);
});

test("range limits prevent unbounded reads while keeping exact coordinates", () => {
  assert.equal(parseRange("a1:ax100").cells, 5000);
  assert.equal(parseRange("XFD1048576").address, "XFD1048576");
  assert.throws(() => parseRange("XFE1"));
  assert.throws(() => parseRange("A0"));
});
