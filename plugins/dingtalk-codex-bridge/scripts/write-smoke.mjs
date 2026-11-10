#!/usr/bin/env node
// This explicit acceptance script creates ONE test worksheet. It never overwrites existing worksheets.
import { writeFile, access, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { McpClient, findResult } from "./mcp-client.mjs";
import { validateUrl, validateProfile } from "../mcp/bridge.mjs";

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!["--url", "--profile", "--report", "--name", "--resume"].includes(process.argv[i]) || !process.argv[i + 1]) throw new Error("Usage: write-smoke.mjs --url URL --profile CORP:USER --report NEW_PATH --name UNIQUE_NAME [--resume audited]");
  flags[process.argv[i].slice(2)] = process.argv[i + 1];
}
validateUrl(flags.url); validateProfile(flags.profile);
if (!flags.report || !flags.name) throw new Error("New report path and unique test worksheet name are required.");
let previous;
try {
  await access(flags.report);
  if (flags.resume !== "audited") throw new Error("Report already exists. Audit its last operation before continuing; this script never blindly replays writes.");
  previous = JSON.parse(await readFile(flags.report, "utf8"));
  if (previous.workbook_url !== flags.url || previous.name !== flags.name || previous.steps.some(step => step.status !== "passed")) throw new Error("Resume needs a matching report whose previous writes have ALL been independently read back and marked passed.");
} catch (error) { if (error.code !== "ENOENT") throw error; }
const client = new McpClient(), common = { url: flags.url, profile: flags.profile };
const report = previous || { version: "0.4.0", name: flags.name, workbook_url: flags.url, sheet_id: null, complete: false, steps: [] };
delete report.error; delete report.next_action;
const save = () => writeFile(flags.report, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function stage(label, action) {
  if (report.steps.some(step => step.label === label && step.status === "passed")) { console.error(`Already verified: ${label}`); return; }
  console.error(label);
  const entry = { label, status: "started" }; report.steps.push(entry); await save();
  const value = await action(); entry.status = "passed"; await save(); return value;
}
const mutate = (operation, parameters = {}, extra = {}) => client.call("write_dingtalk_sheet_operation", { ...common, operation, ...(report.sheet_id ? { sheet_id: report.sheet_id } : {}), parameters, ...extra });
const read = (operation, parameters = {}, extra = {}) => client.call("read_dingtalk_sheet_operation", { ...common, operation, ...(report.sheet_id ? { sheet_id: report.sheet_id } : {}), parameters, ...extra });
async function cells(range, mode = "raw_value") {
  const result = await client.call("read_dingtalk_sheet_cells", { ...common, sheet_id: report.sheet_id, range, value_render_option: mode });
  assert.equal(result.completeness.complete, true);
  const data = findResult(result, v => Array.isArray(v.cells));
  if (!data) throw new Error("No cell array returned");
  return data.cells;
}
const cell = text => ({ type: "text", text: String(text) });
try {
  const initialized = await client.initialize();
  await stage("Initialize MCP and discover writes", async () => {
    assert.equal(initialized.serverInfo.version, "0.4.0");
    const catalog = await client.call("describe_dingtalk_sheet_operation");
    assert.equal(catalog.count, 99);
  });
  await stage("Create test worksheet and verify its stable ID", async () => {
    const result = await mutate("new", { name: flags.name });
    const created = findResult(result, v => typeof v.sheetId === "string");
    if (created) { report.sheet_id = created.sheetId; await save(); }
    const book = await client.call("get_dingtalk_workbook", common);
    const sheets = findResult(book, v => Array.isArray(v.sheets))?.sheets || [];
    const matches = sheets.filter(s => s.title === flags.name);
    assert.equal(matches.length, 1);
    report.sheet_id = matches[0].sheetId; await save();
  });
  await stage("Write sample data and formulas, verify formula source and calculation", async () => {
    const values = [["项目", "数量", "单价", "金额"], ["测试A", 2, 10, "=B2*C2"], ["测试B", 3, 20, "=B3*C3"]].map(row => row.map(cell));
    await mutate("range update", { range: "A1:D3", values });
    const formulas = await cells("D2:D3", "formula");
    assert.equal(formulas[0][0].value, "=B2*C2");
    const data = await cells("A1:D3");
    assert.equal(data[0][0].value, "项目"); assert.equal(Number(data[1][3].value), 20); assert.equal(Number(data[2][3].value), 60);
  });
  await stage("Modify existing value and verify recalculated formula", async () => {
    await mutate("range update", { range: "B2", values: [[cell(4)]] });
    const data = await cells("B2:D2"); assert.equal(Number(data[0][0].value), 4); assert.equal(Number(data[0][2].value), 40);
  });
  await stage("Append a row and read it back", async () => {
    await mutate("append", { values: [["测试C", 1, 30, "=B4*C4"]] });
    const data = await cells("A4:D4"); assert.equal(data[0][0].value, "测试C"); assert.equal(Number(data[0][3].value), 30);
  });
  await stage("Write CSV with overwrite intent and preserve text IDs", async () => {
    await mutate("csv-put", { "start-cell": "F1", csv: "编号,说明\n00123,CSV验收\n", "auto-convert": false });
    const data = await cells("F1:G2"); assert.equal(data[1][0].value, "00123");
  });
  await stage("Apply header formatting and verify styles", async () => {
    await mutate("range set-style", { range: "A1:D1", "bg-color": "#0089FF", "font-color": "#FFFFFF", "font-weight": "bold" });
    const data = await cells("A1:D1");
    const styles = data[0][0].cellStyles || data[0][0].style;
    if (!styles) throw new Error("Style mutation returned but cell style readback is unavailable; cannot mark verified");
    assert.equal(styles.fontWeight, "bold");
    assert.equal(styles.backgroundColor?.toUpperCase(), "#0089FF");
    assert.equal(styles.fontColor?.toUpperCase(), "#FFFFFF");
    report.style_readback = styles;
  });
  await stage("Freeze header and update column width with metadata verification", async () => {
    await mutate("update", { "frozen-row-count": 1 });
    await mutate("update-dimension", { dimension: "COLUMNS", "start-index": "A", length: "4", "pixel-size": 120 });
    const info = await read("info", { include: ["frozen", "col_widths"] });
    const structure = findResult(info, value => typeof value.frozenRowCount === "number");
    assert.equal(structure?.frozenRowCount, 1);
    assert.equal(structure?.colWidths?.length, 4);
    assert.ok(structure.colWidths.every(column => column.pixelSize === 120));
    report.structure_readback = info.result;
  });
  await stage("Sort rows and verify order", async () => {
    await mutate("range sort", { range: "A1:D4", "has-header": true, "sort-keys": [{ column: "B", ascending: true }] });
    const data = await cells("A2:B4"); assert.deepEqual(data.map(row => Number(row[1].value)), [1, 3, 4]);
  });
  await stage("Find test row on server", async () => {
    const found = await read("find", { range: "A1:D4", query: "测试C" });
    assert.ok(JSON.stringify(found.result).includes("测试C"));
    report.find_readback = found.result;
  });
  report.complete = true;
  console.log(JSON.stringify({ complete: true, test_worksheet: flags.name, worksheet_id: report.sheet_id, workbook_url: flags.url, passed_steps: report.steps.filter(s => s.status === "passed").length, report: flags.report }, null, 2));
} catch (error) {
  report.error = error.details || { message: error.message };
  report.next_action = "Inspect the last started operation and read back its target. Do not blindly replay this script.";
  console.error(error.message); process.exitCode = 1;
} finally { await save(); client.close(); }
