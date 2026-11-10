#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { validateProfile, validateUrl } from "../mcp/bridge.mjs";

const cliArgs = process.argv.slice(2), options = {};
for (let i = 0; i < cliArgs.length; i += 2) {
  if (!["--url", "--profile"].includes(cliArgs[i]) || !cliArgs[i + 1] || options[cliArgs[i]]) throw new Error("Usage: smoke.mjs [--url URL --profile corpId:userId]");
  options[cliArgs[i]] = cliArgs[i + 1];
}
if (options["--url"]) { validateUrl(options["--url"]); validateProfile(options["--profile"]); }
const server = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const reader = createInterface({ input: child.stdout }), pending = new Map();
let sequence = 0;
reader.on("line", line => {
  const response = JSON.parse(line), item = pending.get(response.id);
  if (!item) return;
  pending.delete(response.id); clearTimeout(item.timer);
  if (response.error) item.reject(new Error(JSON.stringify(response.error))); else item.resolve(response.result);
});
child.on("error", error => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); } pending.clear(); });
child.on("exit", () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("MCP server exited")); } pending.clear(); });
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP request timed out")); }, 170000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
}
async function call(name, args = {}) {
  console.error(`Checking ${name}...`);
  const result = await request("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || "Tool error");
  return result.structuredContent || JSON.parse(result.content[0].text);
}
function payload(value) { for (let i = 0; i < 6 && value && typeof value === "object"; i++) { if (value.sheets || value.cells || value.csv !== undefined) break; value = value.result ?? value.data ?? value; } return value; }
try {
  console.error("Checking MCP initialization...");
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dingtalk-bridge-smoke", version: "0.4.1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  if (listed.tools.length !== 20) throw new Error("Expected twenty tools");
  const status = await call("get_dingtalk_status", options["--profile"] ? { profile: options["--profile"] } : {});
  const report = { protocol: initialized.protocolVersion, plugin_version: initialized.serverInfo.version, tool_count: listed.tools.length, cli_version: status.cli_version, local_authenticated: status.auth.authenticated ?? false, live_access_verified: false };
  if (options["--url"]) {
    const common = { url: options["--url"], profile: options["--profile"] };
    const resource = await call("inspect_dingtalk_resource", common);
    if (resource.resource.type !== "online_spreadsheet") throw new Error("Resource is not an online spreadsheet");
    const workbook = await call("get_dingtalk_workbook", common);
    const sheets = payload(workbook.result)?.sheets;
    if (!Array.isArray(sheets) || sheets.length === 0) throw new Error("No worksheets returned");
    const sheet_id = sheets[0].sheetId;
    if (!sheet_id) throw new Error("Worksheet ID missing");
    const info = await call("get_dingtalk_sheet_info", { ...common, sheet_id });
    const sample = { ...common, sheet_id, range: "A1:C3" };
    const csv = await call("read_dingtalk_sheet_csv", sample);
    const cells = await call("read_dingtalk_sheet_cells", { ...sample, value_render_option: "raw_value" });
    const formulas = await call("read_dingtalk_sheet_cells", { ...sample, value_render_option: "formula" });
    if ([csv, cells, formulas].some(r => r.completeness.complete !== true)) throw new Error("Sample range was not returned completely");
    const raw = payload(cells.result), formula = payload(formulas.result);
    if (!Array.isArray(raw?.cells) || !Array.isArray(formula?.cells)) throw new Error("Precise cell arrays missing");
    report.live_access_verified = true;
    report.resource_type = resource.resource.type;
    report.worksheet_count = sheets.length;
    report.worksheets = sheets.map(s => ({ id: s.sheetId, title: s.title }));
    report.sample_range = sample.range;
    report.csv_complete = csv.completeness.complete;
    report.cells_complete = cells.completeness.complete;
    report.formulas_complete = formulas.completeness.complete;
    report.cell_rows = raw.cells.length;
    report.sheet_info_returned = !!info.result;
    report.cell_values_logged = false;
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { reader.close(); child.stdin.end(); child.kill(); }
