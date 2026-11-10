import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace, WORKSPACE_CATALOG } from "../mcp/workspace.mjs";
import { validateId, validateProfile } from "../mcp/bridge.mjs";
import { BridgeError, parseCliResult, execCli } from "../mcp/cli.mjs";
import { verifyCatalog } from "../scripts/verify-catalog.mjs";

const profile = "dingFixture:userFixture";
function harness(env = {}) {
  const calls = [], sheets = [];
  const runner = { run: async (argv, options) => { calls.push({ argv, options }); return { success: true, result: { fixture: true } }; } };
  const workspace = createWorkspace({ runner, sheetCall: async (...args) => { sheets.push(args); return { delegated: true }; }, validateId, validateProfile, env: { DINGTALK_BRIDGE_FILES_DIR: os.tmpdir(), ...env } });
  return { workspace, calls, sheets, runner };
}

test("all 1502 callable business paths compile against 5874 observed native flags", async () => {
  const result = await verifyCatalog();
  assert.equal(result.schema_commands, 1559); assert.equal(result.indexed_commands, 1596);
  assert.equal(result.compiled, result.callable_business_commands); assert.equal(result.compiled, 1502);
  assert.equal(result.checked_native_flags, 5874);
  assert.equal(result.checked_available_native_flags, 5794);
  assert.deepEqual(result.metadata_flag_drift, []); assert.deepEqual(result.compilation_failures, []); assert.equal(result.remote_calls, 0);
});

test("discovery paginates and preserves unavailable/local workflow distinctions", async () => {
  const { workspace, calls } = harness();
  const first = await workspace.call("discover_dingtalk_commands", { product: "chat", limit: 3 });
  assert.equal(first.commands.length, 3); assert.equal(first.has_more, true); assert.equal(first.total, 243);
  const missing = await workspace.call("discover_dingtalk_commands", { mode: "unavailable", limit: 100 });
  assert.equal(missing.total, 33); assert.equal(calls.length, 0);
  for (const command of ["auth reset", "dev app credentials get", "mcp url get", "pat chmod"]) {
    const detail = await workspace.call("describe_dingtalk_command", { command });
    assert.equal(detail.mode, "local_workflow");
  }
});

test("real execution stays on the exact native path and explicit account", async () => {
  const { workspace, calls } = harness();
  await workspace.call("read_dingtalk_command", { command: "contact user get-self", profile });
  assert.deepEqual(calls[0].argv.slice(0, 3), ["contact", "user", "get-self"]);
  assert.ok(calls[0].argv.includes(`--profile=${profile}`));
  assert.equal(calls[0].options.allowText, true);
});

test("messages, mail and approval previews never invoke CLI or remote services", async () => {
  const { workspace, calls } = harness();
  for (const [command, parameters] of [
    ["chat message send", {}],
    ["mail message send", { content: "fixture", from: "fixture@example.invalid", subject: "fixture", to: "fixture@example.invalid" }],
    ["oa approval approve", { "instance-id": "fixture", "task-id": "fixture" }]
  ]) {
    const result = await workspace.call("write_dingtalk_command", { command, profile, parameters, dry_run: true });
    assert.equal(result.remote_called, false); assert.equal(result.local_preview, true);
  }
  assert.equal(calls.length, 0);
});

test("unavailable, lifecycle and arbitrary command/global flag escape hatches are blocked", async () => {
  const { workspace, calls } = harness();
  for (const command of ["auth reset", "pat chmod", "mcp published invoke", "chat thread promote", "sh -c echo"]) {
    await assert.rejects(workspace.call("write_dingtalk_command", { command, profile, parameters: {}, confirmed: true }));
  }
  for (const key of ["profile", "mock", "client-secret", "jq"]) await assert.rejects(workspace.call("read_dingtalk_command", { command: "contact user get-self", profile, parameters: { [key]: "escape" } }));
  assert.equal(calls.length, 0);
});

test("business formats/timeouts are not overwritten by global output controls", async () => {
  const { workspace, calls } = harness();
  const entry = WORKSPACE_CATALOG.commands.find(c => c.command === "aitable +export-data");
  const parameters = Object.fromEntries(Object.entries(entry.parameters).filter(([, p]) => p.required).map(([k, p]) => [k, p.type === "integer" ? 1 : "fixture"]));
  await workspace.call("read_dingtalk_command", { command: entry.command, profile, parameters });
  assert.ok(!calls[0].argv.includes("--format=json"));
  await workspace.call("read_dingtalk_command", { command: "audit export", profile });
  assert.ok(calls[1].argv.includes("--format=jsonl"));
});

test("secret references are not echoed even if native output reflects the credential", async () => {
  const secret = "fixture-secret-with-strong-length";
  const { workspace, runner } = harness({ DINGTALK_BRIDGE_SECRET_PASSWORD: secret });
  runner.run = async () => ({ result: { unexpected_message: secret } });
  const result = await workspace.call("read_dingtalk_command", { command: "doc read", profile, parameters: { node: "fixture" }, secret_refs: { password: "DINGTALK_BRIDGE_SECRET_PASSWORD" } });
  assert.ok(!JSON.stringify(result).includes(secret));
  await assert.rejects(workspace.call("read_dingtalk_command", { command: "doc read", profile, parameters: { node: "fixture", password: secret } }), { code: "SECRET_REFERENCE_REQUIRED" });
});

test("local files are confined and converted to native workspace-relative paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dws-workspace-files-"));
  const root = path.join(dir, "allowed"), outside = path.join(dir, "outside");
  try {
    await mkdir(root); await mkdir(outside); await writeFile(path.join(root, "fixture.txt"), "data"); await writeFile(path.join(outside, "private.txt"), "private"); await symlink(outside, path.join(root, "escape"));
    const { workspace, calls } = harness({ DINGTALK_BRIDGE_FILES_DIR: root });
    await workspace.call("write_dingtalk_command", { command: "doc +media-upload", profile, confirmed: true, parameters: { node: "fixture", file: path.join(root, "fixture.txt") } });
    assert.ok(calls[0].argv.includes("--file=fixture.txt")); assert.equal(calls[0].options.cwd, await realpath(root));
    await assert.rejects(workspace.call("write_dingtalk_command", { command: "doc +media-upload", profile, confirmed: true, parameters: { node: "fixture", file: "escape/private.txt" } }), { code: "FILE_OUTSIDE_ALLOWED_DIRECTORY" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native StringSlice quoting and StringArray repetition keep element boundaries", async () => {
  const { workspace } = harness();
  const entry = workspace.commands.get("aicard lint");
  const compiled = await workspace.prepare(entry, { parameters: { "at-open-dingtalk-ids": ["a,b", 'q"z'] } });
  assert.ok(compiled.argv.includes('--at-open-dingtalk-ids="a,b"'));
  assert.ok(compiled.argv.includes('--at-open-dingtalk-ids="q""z"'));
});

test("stdin is explicit, preserved, and no implicit pipe wait is allowed", async () => {
  const { workspace, calls } = harness();
  await assert.rejects(workspace.call("write_dingtalk_command", { command: "doc create", profile, parameters: { name: "fixture", content: "-" } }), { code: "INVALID_ARGUMENT" });
  await workspace.call("write_dingtalk_command", { command: "doc create", profile, parameters: { name: "fixture", content: "-" }, stdin: "# 标题\n多行内容" });
  assert.equal(calls[0].options.input, "# 标题\n多行内容");
  const result = await execCli(process.execPath, ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s));"], { input: "stdin\n精确内容" });
  assert.equal(result.stdout, "stdin\n精确内容");
});

test("native text, NDJSON and boolean read results stay distinguishable", () => {
  assert.equal(parseCliResult({ code: 0, stdout: "# Markdown\n正文", allowText: true }).output_kind, "text");
  assert.equal(parseCliResult({ code: 0, stdout: '{"x":1}\n{"x":2}\n', allowText: true }).records.length, 2);
  assert.equal(parseCliResult({ code: 0, stdout: "false", allowPrimitive: "read" }).result, false);
});

test("successful unified envelopes with empty error placeholders are not failures", () => {
  const result = parseCliResult({ code: 0, stdout: JSON.stringify({ success: true, status: "success", error: {}, data: { bases: [] } }) });
  assert.deepEqual(result.data.bases, []);
  assert.throws(() => parseCliResult({ code: 0, stdout: JSON.stringify({ success: false, error: {} }) }), { code: "DWS_REQUEST_FAILED" });
  assert.throws(() => parseCliResult({ code: 0, stdout: JSON.stringify({ success: true, error: { reason: "denied" } }) }), { code: "DWS_REQUEST_FAILED" });
});

test("unknown workspace mutations are never retried", async () => {
  const { workspace, runner, calls } = harness();
  runner.run = async (...args) => { calls.push(args); throw new BridgeError("CLI_TIMEOUT", "timeout"); };
  await assert.rejects(workspace.call("write_dingtalk_command", { command: "todo task create", profile, parameters: { title: "fixture", executors: "userFixture" } }), { code: "MUTATION_OUTCOME_UNKNOWN" });
  assert.equal(calls.length, 1);
});
