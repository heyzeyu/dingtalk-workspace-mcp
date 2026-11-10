import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspace } from "../mcp/workspace.mjs";
import { validateId, validateProfile } from "../mcp/bridge.mjs";

const profile = "dingFixture:userFixture";
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "dws-privacy-"))), root = path.join(temp, "allowed"), outside = path.join(temp, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, "input.json"), '{"fixture":true}');
  await writeFile(path.join(root, "body.md"), "![private](file:///private/fixture.png)");
  await writeFile(path.join(outside, "private.json"), '{"private":true}');
  await symlink(outside, path.join(root, "escape"));
  const calls = [], runner = { run: async (argv, options) => { calls.push({ argv, options }); return { success: true }; } };
  const workspace = createWorkspace({ runner, sheetCall: () => { throw Error("Unexpected Sheet delegation"); }, validateId, validateProfile, env: { DINGTALK_BRIDGE_FILES_DIR: root } });
  return { temp, root, outside, calls, runner, workspace, close: () => rm(temp, { recursive: true, force: true }) };
}

test("inline image paths from literal text, local body files and stdin never reach native execution", async () => {
  const f = await fixture();
  try {
    for (const content of ["![x](file:///private/fixture.png)", "![x](../../private.png)", "![x](https://example.invalid/image.png)", "@body.md"]) {
      await assert.rejects(f.workspace.call("write_dingtalk_command", { command: "chat message send", profile, parameters: { "open-dingtalk-id": "fixtureUser", content }, confirmed: true }), { code: "IMPLICIT_MEDIA_NOT_ALLOWED" });
    }
    await assert.rejects(f.workspace.call("write_dingtalk_command", { command: "chat +messages-send", profile, parameters: { text: "-", "body-stdin": true, "open-dingtalk-id": "fixtureUser" }, stdin: "![x](/private/fixture.png)", confirmed: true }), { code: "IMPLICIT_MEDIA_NOT_ALLOWED" });
    assert.equal(f.calls.length, 0);
    await f.workspace.call("write_dingtalk_command", { command: "chat message send", profile, parameters: { "open-dingtalk-id": "fixtureUser", content: "hello", "ai-tag": false }, confirmed: true });
    assert.ok(f.calls[0].argv.includes("--ai-tag=false"));
    await f.workspace.call("write_dingtalk_command", { command: "chat message send", profile, parameters: { "open-dingtalk-id": "fixtureUser", content: "![image](mediaid:@fixture_media)" }, confirmed: true });
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("JSON file alternatives and absolute template files share the root and symlink boundary", async () => {
  const f = await fixture();
  try {
    for (const [command, key] of [["mind create", "source"], ["whiteboard create-with-content", "source"], ["oa approval template create", "from-document"]]) {
      const item = f.workspace.commands.get(command);
      for (const value of [path.join(f.outside, "private.json"), "escape/private.json"]) await assert.rejects(f.workspace.prepare(item, { parameters: { [key]: value } }, { validateRequired: false }), { code: "FILE_OUTSIDE_ALLOWED_DIRECTORY" });
      const compiled = await f.workspace.prepare(item, { parameters: { [key]: "input.json" } }, { validateRequired: false });
      assert.ok(compiled.argv.includes(`--${key}=${key === "from-document" ? path.join(f.root, "input.json") : "input.json"}`));
    }
    const item = f.workspace.commands.get("mind create");
    const json = await f.workspace.prepare(item, { parameters: { source: { version: 1, nodes: [] } } }, { validateRequired: false });
    assert.ok(json.argv.some(v => v.startsWith('--source={"version":1')));
  } finally { await f.close(); }
});

test("arrays, checkpoints, baselines and native literal-or-file aliases cannot skip file validation", async () => {
  const f = await fixture();
  try {
    for (const [command, key, value] of [
      ["doc +create-with-media", "media-files", ["escape/private.json"]],
      ["aitable +attachment-put", "additional-files", ["escape/private.json"]],
      ["aitable +task-report", "baseline", "escape/private.json"],
      ["aitable +task-report", "checkpoint", "escape/private.json"],
      ["aitable +build-plan", "plan", "escape/private.json"],
      ["doc +create", "content", "@escape/private.json"]
    ]) await assert.rejects(f.workspace.prepare(f.workspace.commands.get(command), { parameters: { [key]: value } }, { validateRequired: false }), { code: "FILE_OUTSIDE_ALLOWED_DIRECTORY" });
    await assert.rejects(f.workspace.prepare(f.workspace.commands.get("aitable +record-query"), { parameters: { "export-output": "escape/new.ndjson" } }, { validateRequired: false }), { code: "FILE_OUTSIDE_ALLOWED_DIRECTORY" });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("omitted native output and overwrite flags are rejected before a read starts", async () => {
  const f = await fixture();
  try {
    for (const command of ["drive download", "drive download-version"]) {
      await assert.rejects(f.workspace.call("read_dingtalk_command", { command, profile, parameters: { node: "fixtureNode" } }), { code: "EXPLICIT_OUTPUT_REQUIRED" });
      await assert.rejects(f.workspace.call("read_dingtalk_command", { command, profile, parameters: { node: "fixtureNode", output: "new.bin", overwrite: true } }), { code: "FILE_OVERWRITE_NOT_ALLOWED" });
    }
    await f.workspace.call("read_dingtalk_command", { command: "drive download", profile, parameters: { node: "fixtureNode", output: "new.bin" } });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.cwd, f.root); assert.ok(f.calls[0].argv.includes("--output=new.bin"));
    await assert.rejects(f.workspace.call("read_dingtalk_command", { command: "drive download", profile, parameters: { node: "fixtureNode", output: "input.json" } }), { code: "LOCAL_FILE_EXISTS" });
  } finally { await f.close(); }
});

test("conditional resource and transcript downloads require an explicit new destination", async () => {
  const f = await fixture();
  try {
    for (const [command, parameters] of [["chat +search-msg", { query: "fixture", "download-resources": true }], ["minutes +detail", { id: "fixture", "transcript-output": "file" }], ["minutes +download", { id: "fixture" }], ["mail message export", { email: "fixture@example.invalid", id: "fixture" }]]) await assert.rejects(f.workspace.call("read_dingtalk_command", { command, profile, parameters }), { code: "EXPLICIT_OUTPUT_REQUIRED" });
    await assert.rejects(f.workspace.call("read_dingtalk_command", { command: "mail message export", profile, parameters: { email: "fixture@example.invalid", id: "fixture", filename: "../outside" } }), { code: "INVALID_ARGUMENT" });
    assert.equal(f.calls.length, 0);
    await f.workspace.call("read_dingtalk_command", { command: "contact user get-self", profile });
    assert.equal(f.calls[0].options.cwd, f.root);
  } finally { await f.close(); }
});

test("native directory outputs are created only after preview and remain in the allowed root", async () => {
  const f = await fixture();
  try {
    f.runner.run = async (argv, options) => { f.calls.push({ argv, options }); const directory = argv.find(x => x.startsWith("--output-dir=")).split("=")[1]; await writeFile(path.join(options.cwd, directory, "fixture.txt"), "fixture"); return { success: true }; };
    const result = await f.workspace.call("read_dingtalk_command", { command: "minutes +detail", profile, parameters: { id: "fixture", "transcript-output": "file", "output-dir": "transcripts-new" } });
    assert.equal(result.local_files[0].kind, "directory"); assert.equal(result.local_files[0].verified_nonempty, true);
  } finally { await f.close(); }
});

test("loaded body files cannot introduce a second file or stdin reference", async () => {
  const f = await fixture();
  try {
    for (const body of ["@/private/fixture.txt", "  @../../private.txt", "-\n"]) {
      await writeFile(path.join(f.root, "nested.txt"), body);
      await assert.rejects(f.workspace.call("write_dingtalk_command", { command: "doc +create", profile, parameters: { content: "@nested.txt" }, confirmed: true }), { code: "NESTED_FILE_REFERENCE" });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("URL-only download metadata does not require a conflicting file output", async () => {
  const f = await fixture();
  try {
    for (const command of ["drive download", "drive download-version"]) {
      const entry = f.workspace.commands.get(command);
      const parameters = Object.fromEntries(Object.entries(entry.parameters).filter(([, spec]) => spec.required).map(([key, spec]) => [key, spec.type === "integer" ? 1 : "fixture"]));
      await f.workspace.call("read_dingtalk_command", { command, profile, parameters: { ...parameters, "url-only": true } });
    }
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => !call.argv.some(arg => arg.startsWith("--output="))));
  } finally { await f.close(); }
});

test("new archive directories remain nonexistent until the native atomic publisher creates them", async () => {
  const f = await fixture();
  try {
    f.runner.run = async (argv, options) => { const output = argv.find(arg => arg.startsWith("--output=")).slice(9), destination = path.join(options.cwd, output); await assert.rejects(access(destination)); await mkdir(destination); await writeFile(path.join(destination, "fixture.json"), "{}"); return { success: true }; };
    const entry = f.workspace.commands.get("minutes +export-pack");
    const parameters = Object.fromEntries(Object.entries(entry.parameters).filter(([, spec]) => spec.required).map(([key, spec]) => [key, spec.type === "array" ? ["fixture"] : "fixture"]));
    const result = await f.workspace.call("read_dingtalk_command", { command: entry.command, profile, parameters: { ...parameters, output: "archive-new" } });
    assert.equal(result.local_files[0].verified_nonempty, true);
  } finally { await f.close(); }
});
