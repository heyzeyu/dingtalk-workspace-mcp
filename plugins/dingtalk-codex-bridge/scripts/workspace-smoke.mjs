#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { McpClient } from "./mcp-client.mjs";
import { validateProfile } from "../mcp/bridge.mjs";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!["--profile", "--report", "--write"].includes(process.argv[i]) || !process.argv[i + 1]) throw Error("Usage: workspace-smoke.mjs --profile CORP:USER --report NEW_PATH [--write own-fixtures]");
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
validateProfile(options.profile);
if (!options.report) throw Error("New report path required.");
if (options.write !== undefined && options.write !== "own-fixtures") throw Error("Only --write own-fixtures is supported.");
try { await access(options.report); throw Error("Existing live report; audit previous operations rather than replaying."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const client = new McpClient(), report = { version: "0.4.0", reads: [], writes: [], resources: {}, complete: false };
let saving = Promise.resolve();
const save = () => { const snapshot = JSON.stringify(report, null, 2) + "\n"; saving = saving.then(() => writeFile(options.report, snapshot, { mode: 0o600 })); return saving; };
function find(value, predicate) { if (!value || typeof value !== "object") return null; if (predicate(value)) return value; for (const child of Object.values(value)) { const found = find(child, predicate); if (found) return found; } return null; }
const facts = error => ({ code: error.details?.code || "ASSERTION_FAILED", reason: error.details?.details?.reason, message: String(error.details?.details?.message || error.message).replace(/https?:\/\/\S+/gu, "[URL]").slice(0, 400) });
async function read(command, parameters = {}) { return client.call("read_dingtalk_command", { command, profile: options.profile, parameters }); }
async function write(command, parameters = {}, flags = {}) { return client.call("write_dingtalk_command", { command, profile: options.profile, parameters, ...flags }); }
async function stage(label, action) {
  console.error(label); const item = { label, status: "started" }; report.writes.push(item); await save();
  try { await action(); item.status = "verified"; } catch (error) { item.status = "needs_audit"; item.error = facts(error); throw error; } finally { await save(); }
}
try {
  const init = await client.initialize(); assert.equal(init.serverInfo.version, "0.4.0");
  const list = await client.request("tools/list"); assert.equal(list.tools.length, 20);
  const cases = [
    ["contact user get-self", {}], ["calendar book list", {}], ["todo task list", { page: "1", size: "3", "query-all": false }],
    ["wiki space list", { limit: "3", type: "myWikiSpace" }], ["drive list-spaces", { "space-type": "mySpace" }],
    ["doc list", { limit: 3 }], ["minutes list mine", { limit: 1 }], ["report template list", {}],
    ["oa approval list-pending", { limit: "1", page: "1" }], ["aitable base list", { limit: 1 }],
    ["devdoc article search", { query: "获取单元格区域", size: "1", page: "1" }], ["event list", { "enabled-only": true }]
  ];
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < cases.length) {
      const [command, parameters] = cases[next++]; console.error(`Reading ${command}...`);
      const started = Date.now();
      try {
        const result = await read(command, parameters);
        report.reads.push({ command, status: "api_returned", elapsed_ms: Date.now() - started, response_kind: result.result?.output_kind || "json", response_bytes: JSON.stringify(result.result).length });
      } catch (error) { report.reads.push({ command, status: "failed", elapsed_ms: Date.now() - started, error: facts(error) }); }
      await save();
    }
  }));
  if (options.write === "own-fixtures") {
    const marker = `DWS-MCP-验收-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    await stage("Create independent document and verify text", async () => {
      const result = await write("doc create", { name: marker, content: `# Workspace MCP 验收\n\n${marker}\n\n这是一份独立的插件验收文档。` });
      const node = find(result.result, object => typeof object.nodeId === "string" || typeof object.dentryUuid === "string");
      report.resources.document_receipt = result.result; await save();
      if (!node) throw Error("No document node ID; inspect receipt without repeating create.");
      report.resources.document_id = node.nodeId || node.dentryUuid; await save();
      const fetched = await read("doc read", { node: report.resources.document_id });
      assert.ok(JSON.stringify(fetched.result).includes(marker));
    });
    await stage("Append document content and verify", async () => {
      const node = report.resources.document_id;
      await write("doc update", { node, mode: "append", content: "\n追加验收：读写链路通过。" });
      assert.ok(JSON.stringify((await read("doc read", { node })).result).includes("追加验收：读写链路通过"));
    });
    await stage("Create task assigned only to current user and verify", async () => {
      const created = await write("todo task create", { title: marker, executors: options.profile.split(":")[1] });
      report.resources.task_receipt = created.result; await save();
      const task = find(created.result, object => typeof object.taskId === "string" || typeof object.id === "string");
      if (!task) throw Error("No task ID; inspect receipt without repeating create.");
      report.resources.task_id = task.taskId || task.id; await save();
      const fetched = await read("todo task get", { "task-id": report.resources.task_id });
      assert.ok(JSON.stringify(fetched.result).includes(marker));
    });
    await stage("Complete own test task and verify terminal state", async () => {
      await write("todo task update", { "task-id": report.resources.task_id, done: "true" });
      const result = await read("todo task get", { "task-id": report.resources.task_id });
      const done = find(result.result, object => object.done === true || object.isDone === true || object.status === "completed");
      assert.ok(done, "Completion flag was not verified");
    });
    await stage("Create independent AI Table Base and verify", async () => {
      const result = await write("aitable base create", { name: marker.slice(0, 45) });
      report.resources.aitable_receipt = result.result; await save();
      const base = find(result.result, object => typeof object.baseId === "string" || typeof object.nodeId === "string");
      if (!base) throw Error("No Base ID; inspect receipt without repeating create.");
      report.resources.base_id = base.baseId || base.nodeId; await save();
      const fetched = await read("aitable base get", { "base-id": report.resources.base_id });
      assert.ok(JSON.stringify(fetched.result).includes(marker.slice(0, 45)));
    });
  }
  report.complete = report.reads.every(item => item.status === "api_returned");
  if (!report.complete) process.exitCode = 1;
  console.log(JSON.stringify({ report: options.report, reads_returned: report.reads.filter(r => r.status === "api_returned").length, reads_failed: report.reads.filter(r => r.status === "failed").map(r => ({ command: r.command, error: r.error })), verified_write_stages: report.writes.filter(r => r.status === "verified").length }, null, 2));
} catch (error) { report.error = facts(error); console.error(JSON.stringify(report.error)); process.exitCode = 1; }
finally { await save(); client.close(); }
