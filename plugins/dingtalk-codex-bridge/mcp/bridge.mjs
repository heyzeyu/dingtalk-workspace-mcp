import { BridgeError, DWS_VERSION, createRunner, redact } from "./cli.mjs";
import { createOperations, OPERATION_TOOL_DEFINITIONS } from "./operations.mjs";
import { createWorkspace, WORKSPACE_TOOL_DEFINITIONS } from "./workspace.mjs";
import { createAdapters, ADAPTER_TOOL_DEFINITIONS } from "./adapters.mjs";
import { createConnection, CONNECTION_TOOL_DEFINITIONS } from "./connection.mjs";

const text = (description) => ({ type: "string", description });
const url = text("Full HTTPS alidocs.dingtalk.com online spreadsheet URL; node links are type-checked before reading.");
const profile = text("Exact corpId:userId from get_dingtalk_status or list_dingtalk_profiles. One account only.");
const sheetId = text("Stable worksheet ID returned by get_dingtalk_workbook. Do not guess or use a title.");
const range = text("Required bounded A1 range, e.g. A1:F30; no sheet prefix or whole-column ranges; at most 5,000 cells.");
const render = { type: "string", enum: ["formatted_value", "raw_value", "formula"], description: "Display text, raw calculation value, or formula source." };
const common = { url, profile };
const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
function tool(name, title, description, inputSchema) { return { name, title, description, inputSchema, annotations }; }
export const TOOL_DEFINITIONS = [
  tool("get_dingtalk_status", "Check DingTalk login", "Check pinned CLI and local login metadata. A snapshot is not proof of live API access. Credentials are never returned.", schema({ profile }, [])),
  tool("list_dingtalk_profiles", "List DingTalk accounts", "List locally configured accounts without switching organizations. Select one exact corpId:userId before business calls.", schema({})),
  tool("inspect_dingtalk_resource", "Inspect DingTalk link", "Identify resource type and resolve bounded shortcut chains. Uploaded xlsx and AI tables are distinguished from online spreadsheets.", schema(common)),
  tool("get_dingtalk_workbook", "List DingTalk worksheets", "Type-check the link and list stable worksheet IDs and names. Call this before choosing sheet_id.", schema(common)),
  tool("get_dingtalk_sheet_info", "Read worksheet structure", "Read worksheet bounds, merged ranges and available structural metadata for the selected sheet.", schema({ ...common, sheet_id: sheetId })),
  tool("read_dingtalk_sheet_csv", "Read worksheet values", "Read a bounded range as annotated CSV with coordinate mappings and completeness facts. A partial result is explicitly marked. For exact cell structure use read_dingtalk_sheet_cells.", schema({ ...common, sheet_id: sheetId, range, value_render_option: render, max_chars: { type: "integer", minimum: 1000, maximum: 100000, default: 50000 } }, ["url", "profile", "sheet_id", "range"])),
  tool("read_dingtalk_sheet_cells", "Read precise cells", "Read bounded per-cell JSON, including available hyperlink/validation information; choose raw_value or formula explicitly when needed. Keep coordinate mappings. No writes.", schema({ ...common, sheet_id: sheetId, range, value_render_option: render }, ["url", "profile", "sheet_id", "range"])),
  ...OPERATION_TOOL_DEFINITIONS,
  ...WORKSPACE_TOOL_DEFINITIONS,
  ...ADAPTER_TOOL_DEFINITIONS,
  ...CONNECTION_TOOL_DEFINITIONS
];

function bad(message) { throw new BridgeError("INVALID_ARGUMENT", message); }
function argsObject(value, allowed) {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Tool arguments must be an object.");
  if (Object.keys(value).some(k => !allowed.includes(k))) bad("Unsupported tool argument.");
  return value;
}
export function validateId(value, label = "ID") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(value)) bad(`${label} must be a stable ID from a real result.`);
  return value;
}
export function validateProfile(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}:[A-Za-z0-9_-]{1,256}$/u.test(value)) bad("profile must be one exact corpId:userId, not an organization name or multiple profiles.");
  return value;
}
export function validateUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f]/u.test(value)) bad("url must be an absolute HTTPS DingTalk document URL without whitespace.");
  let parsed;
  try { parsed = new URL(value); } catch { bad("Invalid URL."); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "alidocs.dingtalk.com" || parsed.username || parsed.password || parsed.port) bad("Only HTTPS alidocs.dingtalk.com links without credentials or custom ports are supported.");
  if (parsed.pathname.includes("/i/p/")) throw new BridgeError("SHARE_LINK_UNSUPPORTED", "This is an external share link. If the document is saved in your document space, locate that resource there; a share link cannot be treated as a node ID.");
  const node = parsed.pathname.match(/^\/i\/nodes\/([A-Za-z0-9_-]{1,256})\/?$/u);
  if (node) return { kind: "node", node: node[1], url: `https://alidocs.dingtalk.com/i/nodes/${node[1]}` };
  if (/^\/spreadsheetv2\/[A-Za-z0-9_-]+(?:\/|$)/u.test(parsed.pathname)) return { kind: "legacy_sheet", node: value, url: value };
  throw new BridgeError("URL_UNSUPPORTED", "This URL format is not supported. Use a document-space node link or a spreadsheetv2 direct link.");
}

function colNumber(value) { return [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); }
export function parseRange(value, maxCells = 5000) {
  if (typeof value !== "string" || value.length > 48) bad("range must be a bounded A1 range.");
  const match = value.toUpperCase().match(/^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/u);
  if (!match) bad("Use a bounded range such as A1:F30, without sheet prefixes.");
  const c1 = colNumber(match[1]), r1 = Number(match[2]);
  const c2 = colNumber(match[3] || match[1]), r2 = Number(match[4] || match[2]);
  if (c2 < c1 || r2 < r1 || c2 > 16384 || r2 > 1048576) bad("range is reversed or exceeds bridge row/column limits.");
  const cells = (r2 - r1 + 1) * (c2 - c1 + 1);
  if (cells > maxCells) bad(`Read at most ${maxCells} cells per call; split this range into blocks.`);
  return { address: value.toUpperCase(), c1, c2, r1, r2, cells };
}

function unwrap(value, marker) {
  let current = value;
  for (let i = 0; i < 4; i++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    if (marker(current)) return current;
    if (current.result !== undefined) current = current.result;
    else if (current.data !== undefined) current = current.data;
    else break;
  }
  return current;
}
export function completionOf(response, requested) {
  const data = unwrap(response, v => "hasMore" in v || "returnedRange" in v || "cells" in v || "csv" in v);
  if (!data || typeof data !== "object" || typeof data.hasMore !== "boolean") return { complete: null, reason: "completion_metadata_missing", requested_range: requested };
  const reasons = data.truncationReasons;
  if (reasons !== undefined && !Array.isArray(reasons)) return { complete: null, reason: "completion_metadata_invalid", requested_range: requested };
  if (data.hasMore || reasons?.length) return { complete: false, reason: "partial_result", requested_range: requested, returned_range: data.returnedRange ?? null, has_more: data.hasMore, truncation_reasons: reasons ?? [] };
  try {
    const actual = parseRange(data.returnedRange), wanted = parseRange(requested);
    const complete = actual.r1 === wanted.r1 && actual.r2 === wanted.r2 && actual.c1 === wanted.c1 && actual.c2 === wanted.c2;
    return { complete, reason: complete ? "requested_range_returned" : "returned_range_mismatch", requested_range: requested, returned_range: actual.address, has_more: false, truncation_reasons: [] };
  } catch { return { complete: null, reason: "returned_range_missing_or_invalid", requested_range: requested, returned_range: data.returnedRange ?? null }; }
}

function resourceType(extension) {
  if (extension === "axls") return "online_spreadsheet";
  if (extension === "able") return "ai_table";
  if (["xlsx", "xls", "xlsm", "csv"].includes(extension)) return "uploaded_spreadsheet_file";
  if (extension === "adoc") return "document";
  return "unsupported";
}

export function createBridge(runner = createRunner(), { env = process.env, connectionDependencies = {} } = {}) {
  const cli = (argv, account, options = {}) => runner.run([...argv, ...(account ? ["--profile", account] : []), "--format", "json", "--timeout", "30"], { timeout: options.longRunning ? 330000 : 40000, allowPrimitive: options.mutation ?? false, cwd: options.cwd });
  const full = createOperations({ cli, spreadsheet, validateId, validateProfile, validateUrl, parseRange, env });
  const workspace = createWorkspace({ runner, sheetCall: full.call, validateProfile, validateId, env });
  const adapters = createAdapters({ runner, workspace, validateProfile, env });
  const connection = createConnection({ runner, env, readStatus: localStatus, prepareStatus: account => localStatus(account, false), ...connectionDependencies });
  const verifiedResources = new Map();
  async function localStatus(account, readonly = true) {
    const runtime = await runner.runtime();
    const snapshot = await cli(["auth", "status", ...(readonly ? ["--readonly"] : [])], account);
    const data = unwrap(snapshot, v => "authenticated" in v || "reason" in v);
    const fields = ["authenticated", "refresh_token_valid", "expires_at", "refresh_expires_at", "corp_id", "corp_name", "user_id", "user_name", "reason", "hint", "message"];
    const state = Object.fromEntries(fields.filter(k => data?.[k] !== undefined).map(k => [k, data[k]]));
    const suggested = data?.corp_id && data?.user_id ? `${data.corp_id}:${data.user_id}` : null;
    return { cli_version: runtime.version, required_cli_version: DWS_VERSION, local_snapshot: readonly, live_access_verified: false, profile: suggested, auth: redact(state), ...(state.authenticated === false ? { next_action: { tool: "connect_dingtalk", message: "在当前聊天连接钉钉，插件会安装依赖并保持设备授权。" } } : {}) };
  }
  async function inspect(link, account) {
    if (link.kind === "legacy_sheet") return { type: "online_spreadsheet", extension: "axls", node: link.node, url: link.url, evidence: "spreadsheetv2_url", shortcuts: [] };
    let response = await cli(["drive", "info", "--node", link.node], account);
    let data = unwrap(response, v => "extension" in v);
    if (!data || typeof data.extension !== "string") throw new BridgeError("RESOURCE_TYPE_UNKNOWN", "DWS did not return a document extension; the resource cannot be treated as a spreadsheet.");
    let node = validateId(data.nodeId || data.fileId || link.node, "resource node ID");
    const shortcuts = [], visited = new Set();
    while (data.extension === "dlink") {
      if (visited.has(node) || shortcuts.length >= 5) throw new BridgeError("SHORTCUT_LOOP", "Shortcut cycle or maximum of 5 shortcut hops reached.");
      visited.add(node); shortcuts.push(node);
      // Drive's fileId, when present, is the shortcut entry ID expected by doc info.
      const entry = validateId(data.fileId || node, "shortcut entry ID");
      response = await cli(["doc", "info", "--node", entry], account);
      const info = unwrap(response, v => "linkSourceInfo" in v);
      const target = info?.linkSourceInfo;
      if (!target || typeof target.extension !== "string" || !target.nodeId) throw new BridgeError("SHORTCUT_TARGET_MISSING", "Shortcut target is missing; no sheet read was attempted.");
      node = validateId(target.nodeId, "shortcut target ID"); data = target;
      if (visited.has(node)) throw new BridgeError("SHORTCUT_LOOP", "Shortcut points to an already visited node.");
    }
    const extension = data.extension.toLowerCase();
    return { type: resourceType(extension), extension, node, title: data.name || data.title || null, workspace_id: data.workspaceId || null, folder_id: data.folderId || null, url: `https://alidocs.dingtalk.com/i/nodes/${node}`, evidence: "dws_metadata", shortcuts };
  }
  async function spreadsheet(link, account) {
    const key = `${account}|${link.kind}|${link.node}`;
    const cached = verifiedResources.get(key);
    if (cached && cached.expires > Date.now()) return cached.resource;
    const resource = await inspect(link, account);
    if (resource.type !== "online_spreadsheet") throw new BridgeError("RESOURCE_NOT_ONLINE_SHEET", "This resource is not a native DingTalk online spreadsheet. Uploaded Excel files require download/local analysis; AI tables use a separate interface.", { type: resource.type, extension: resource.extension });
    if (verifiedResources.size >= 128) verifiedResources.delete(verifiedResources.keys().next().value);
    verifiedResources.set(key, { resource, expires: Date.now() + 120000 });
    return resource;
  }
  async function call(name, rawArgs) {
    const def = TOOL_DEFINITIONS.find(t => t.name === name);
    if (!def) throw new BridgeError("UNKNOWN_TOOL", "Unknown tool.");
    const args = argsObject(rawArgs, Object.keys(def.inputSchema.properties));
    for (const key of def.inputSchema.required) if (args[key] === undefined) bad(`${key} is required.`);
    if (OPERATION_TOOL_DEFINITIONS.some(tool => tool.name === name)) return full.call(name, args);
    if (WORKSPACE_TOOL_DEFINITIONS.some(tool => tool.name === name)) return workspace.call(name, args);
    if (ADAPTER_TOOL_DEFINITIONS.some(tool => tool.name === name)) return adapters.call(name, args);
    if (CONNECTION_TOOL_DEFINITIONS.some(tool => tool.name === name)) return connection.call(name, args);
    if (name === "get_dingtalk_status") {
      const account = args.profile === undefined ? undefined : validateProfile(args.profile);
      return localStatus(account);
    }
    if (name === "list_dingtalk_profiles") return { local_snapshot: true, profiles: redact(await cli(["profile", "list"])) };
    const account = validateProfile(args.profile);
    const link = validateUrl(args.url);
    // Validate all selectors before any network call.
    const selected = args.sheet_id === undefined ? undefined : validateId(args.sheet_id, "sheet_id");
    let requested, valueRender, maxChars;
    if (name.startsWith("read_")) {
      requested = parseRange(args.range).address;
      valueRender = args.value_render_option ?? (name.endsWith("cells") ? "raw_value" : "formatted_value");
      if (!["formatted_value", "raw_value", "formula"].includes(valueRender)) bad("Unsupported value_render_option.");
      maxChars = args.max_chars ?? 50000;
      if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100000) bad("max_chars must be 1000..100000.");
    }
    if (name === "inspect_dingtalk_resource") return { profile: account, resource: await inspect(link, account) };
    const resource = await spreadsheet(link, account);
    let argv;
    if (name === "get_dingtalk_workbook") argv = ["sheet", "+list-sheets", "--node", resource.node];
    else if (name === "get_dingtalk_sheet_info") argv = ["sheet", "info", "--node", resource.node, "--sheet-id", selected];
    else {
      argv = name.endsWith("csv") ? ["sheet", "csv-get"] : ["sheet", "range", "read"];
      argv.push("--node", resource.node, "--sheet-id", selected, "--range", requested, "--value-render-option", valueRender);
      if (name.endsWith("csv")) argv.push("--max-chars", String(maxChars));
    }
    const result = await cli(argv, account);
    const output = { profile: account, resource, ...(selected ? { sheet_id: selected } : {}), ...(requested ? { completeness: completionOf(result, requested), value_render_option: valueRender } : {}), result: redact(result) };
    if (JSON.stringify(output).length > 200000) throw new BridgeError("OUTPUT_LIMIT", "Result is too large to return intact. Read a smaller range; no partial JSON was returned.");
    return output;
  }
  return { call, close: () => connection.close() };
}
