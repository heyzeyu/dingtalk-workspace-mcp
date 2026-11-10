import { readFileSync } from "node:fs";
import { readFile, realpath, stat, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError, redact } from "./cli.mjs";

export const CATALOG = JSON.parse(readFileSync(new URL("./sheet-catalog.json", import.meta.url), "utf8"));
const operations = new Map(CATALOG.operations.map(item => [item.operation, item]));
const reads = CATALOG.operations.filter(item => item.effect === "read").map(item => item.operation);
const writes = CATALOG.operations.filter(item => item.effect !== "read").map(item => item.operation);
const base = {
  operation: { type: "string", description: "Exact operation returned by describe_dingtalk_sheet_operation, e.g. range update, append, new, range set-style, chart create, export." },
  profile: { type: "string", description: "Exact corpId:userId. No implicit account switching." },
  url: { type: "string", description: "Existing workbook URL; required for operations with a node parameter. Omit for new workbook creation, template discovery and import tasks." },
  sheet_id: { type: "string", description: "Real stable worksheet ID; required whenever the operation accepts sheet-id, except optional workbook-wide CSV export." },
  parameters: { type: "object", description: "Only native parameters returned by describe. Pass JSON fields as objects/arrays; do not supply node, sheet-id, global flags or arbitrary commands." }
};
const input = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const OPERATION_TOOL_DEFINITIONS = [
  { name: "describe_dingtalk_sheet_operation", title: "Discover full sheet operations", description: "List all 99 pinned official Sheet operations or inspect one operation's parameters, semantics and confirmation requirements. Local metadata only. Inspect before using an unfamiliar operation.", inputSchema: input({ operation: base.operation, category: { type: "string", description: "Optional exact family/prefix, e.g. chart, range, filter, version." } }, []), annotations: readHints },
  { name: "read_dingtalk_sheet_operation", title: "Run advanced sheet reads and exports", description: "Execute an allowlisted Sheet read, e.g. find, formula-verify, chart list, version list or xlsx/CSV export. File paths are confined to Downloads or DINGTALK_BRIDGE_FILES_DIR. No arbitrary CLI.", inputSchema: input({ ...base, operation: { ...base.operation, enum: reads } }, ["operation", "profile"]), annotations: readHints },
  { name: "write_dingtalk_sheet_operation", title: "Create and edit DingTalk spreadsheets", description: "Execute allowlisted Sheet mutations: create, cell/CSV/formula writes, append, worksheets, rows/columns, styles, sort, filters, charts, pivot tables, images, versions and import. User intent must authorize the change. Read back before claiming success; never blindly retry an unknown write. Comments require explicit comment/message intent.", inputSchema: input({ ...base, operation: { ...base.operation, enum: writes }, dry_run: { type: "boolean", default: false }, confirmed: { type: "boolean", default: false, description: "Set true only when the user's existing instructions authorize the specific destructive operation and exact target. Reuse authorization already given; do not ask again unnecessarily." } }, ["operation", "profile"]), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }
];

function invalid(message) { throw new BridgeError("INVALID_ARGUMENT", message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
const jsonKeys = new Set(["values", "operations", "sheets", "styles", "properties", "criteria", "filter-criteria", "condition", "cell-style", "data-bar-style", "options", "sort-keys", "ranges"]);
const boundedReads = new Set(["csv-get", "range read", "+read", "table-get", "formula-verify"]);
const noNodeCreates = new Set(["create", "create-with-data", "template apply", "import create"]);

export function createOperations({ cli, spreadsheet, validateId, validateProfile, validateUrl, parseRange, env = process.env }) {
  const filesRoot = path.resolve(env.DINGTALK_BRIDGE_FILES_DIR || path.join(os.homedir(), "Downloads"));
  async function resolveLocalFile(value, { output = false, extension } = {}) {
    if (typeof value !== "string" || !value || /[\x00\r\n]/u.test(value)) invalid("File path must be a non-empty local path.");
    const root = await realpath(filesRoot);
    const requested = path.resolve(root, value);
    const resolved = output ? path.join(await realpath(path.dirname(requested)), path.basename(requested)) : await realpath(requested);
    const relative = path.relative(root, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new BridgeError("FILE_OUTSIDE_ALLOWED_DIRECTORY", "Files must stay inside Downloads or the explicitly configured DINGTALK_BRIDGE_FILES_DIR; symlinks cannot escape it.");
    if (extension && !extension.includes(path.extname(resolved).toLowerCase())) invalid(`Expected file extension: ${extension.join(", ")}`);
    if (output) {
      try { await lstat(resolved); throw new BridgeError("LOCAL_FILE_EXISTS", "Export destination already exists. Choose a new filename."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) invalid("Input must be a regular file at most 20 MB.");
    }
    return resolved;
  }
  async function localFile(value, options) {
    try { return await resolveLocalFile(value, options); }
    catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("LOCAL_FILE_UNAVAILABLE", "Local file or parent directory is missing/inaccessible. Check the filename, allowed directory and filesystem permissions.");
    }
  }
  async function jsonValue(value) {
    if (typeof value === "string") {
      if (value.startsWith("@")) value = await readFile(await localFile(value.slice(1), { extension: [".json"] }), "utf8");
      try { return JSON.parse(value); } catch { invalid("This parameter requires JSON; pass an object/array or valid inline JSON."); }
    }
    if (!plain(value) && !Array.isArray(value)) invalid("This parameter requires a JSON object or array.");
    return value;
  }
  function matrix(value, label) {
    if (!Array.isArray(value) || !value.length || !Array.isArray(value[0]) || !value[0].length || value.some(row => !Array.isArray(row) || row.length !== value[0].length) || value.length * value[0].length > 5000) invalid(`${label} must be a rectangular non-empty matrix of at most 5,000 cells.`);
  }
  async function prepare(item, args) {
    const params = args.parameters ?? {};
    if (!plain(params)) invalid("parameters must be an object.");
    const allowed = Object.keys(item.parameters).filter(k => !["node", "sheet-id", "yes"].includes(k));
    if (Object.keys(params).some(k => !allowed.includes(k))) invalid("Unsupported operation parameter. Inspect the operation schema; node, sheet-id and global flags cannot be overridden.");
    if (Object.hasOwn(item.parameters, "node") && !args.url) invalid("url is required for this operation.");
    if (!Object.hasOwn(item.parameters, "node") && args.url !== undefined) invalid("This operation does not accept an existing workbook URL.");
    if (Object.hasOwn(item.parameters, "sheet-id")) {
      if (args.sheet_id === undefined && item.operation !== "export-csv") invalid("sheet_id is required; select a real worksheet explicitly.");
      if (args.sheet_id !== undefined) validateId(args.sheet_id, "sheet_id");
    } else if (args.sheet_id !== undefined) invalid("This operation does not take sheet_id.");
    for (const [key, spec] of Object.entries(item.parameters)) {
      if (["node", "sheet-id", "yes"].includes(key)) continue;
      if (spec.required && params[key] === undefined) invalid(`Missing operation parameter: ${key}`);
    }
    const argv = [], normalized = {};
    for (const [key, raw] of Object.entries(params)) {
      const spec = item.parameters[key];
      let value = raw;
      if (key === "file" || key === "batch") value = await localFile(raw, { extension: key === "batch" ? [".json"] : item.operation === "import create" ? [".xlsx", ".xls"] : undefined });
      else if (key === "output") value = await localFile(raw, { output: true, extension: item.operation === "export" ? [".xlsx"] : [".csv"] });
      else if (key === "csv" && typeof raw === "string" && raw.startsWith("@")) value = "@" + await localFile(raw.slice(1), { extension: [".csv", ".tsv"] });
      else if (spec.format === "json" || jsonKeys.has(key) || key.endsWith("-json")) {
        // A few keys have non-JSON meanings in specific operations.
        const literal = (key === "source" || key === "range");
        if (!literal) value = await jsonValue(raw);
      } else if (typeof raw === "string" && (raw.startsWith("@") || raw === "-")) invalid("File/stdin indirection is not supported for this parameter.");
      if (key === "values") {
        matrix(value, "values");
        if (item.operation === "range update") {
          const target = parseRange(params.range);
          if (value.length !== target.r2 - target.r1 + 1 || value[0].length !== target.c2 - target.c1 + 1) invalid("values dimensions must exactly match range.");
          if (value.some(row => row.some(cell => !plain(cell)))) invalid("range update values must be cell objects, e.g. {type:'text',text:'hello'}; use csv-put for primitive values.");
        }
      }
      if (key === "operations") {
        if (!Array.isArray(value) || !value.length || value.length > 100) invalid("batch-update requires 1..100 operations.");
        for (const nested of value) {
          const target = operations.get(nested?.toolName);
          if (!target || target.effect === "read" || target.operation === "batch-update" || !plain(nested.input)) invalid("Invalid nested batch operation.");
          if (Object.keys(nested.input).some(k => !Object.hasOwn(target.parameters, k) || ["node", "yes", "file", "batch", "output"].includes(k))) invalid("Batch entries cannot override workbook, files or confirmation.");
          if (nested.input["sheet-id"] !== undefined) validateId(nested.input["sheet-id"], "batch sheet ID");
          for (const v of Object.values(nested.input)) if (typeof v === "string" && (v.startsWith("@") || v === "-")) invalid("Batch file/stdin indirection is not allowed.");
        }
      }
      if (["source-sheet-id", "target-sheet-id"].includes(key)) validateId(value, key);
      if (["range", "source-range", "target-range", "start-cell"].includes(key) && !["group-dimension", "ungroup-dimension"].includes(item.operation)) parseRange(value);
      if (item.operation === "range update" && key === "range" && !value.includes(":")) value = `${value}:${value}`;
      if (["boolean", "integer", "number", "array"].includes(spec.type)) {
        if (spec.type === "boolean" && typeof value !== "boolean") invalid(`${key} must be boolean.`);
        if (spec.type === "integer" && !Number.isSafeInteger(value)) invalid(`${key} must be a safe integer.`);
        if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) invalid(`${key} must be numeric.`);
        if (spec.type === "array" && !Array.isArray(value)) invalid(`${key} must be an array.`);
      } else if (spec.type === "string" && typeof value !== "string" && !(spec.format === "json" || jsonKeys.has(key) || key.endsWith("-json"))) invalid(`${key} must be a string.`);
      if (spec.enum && !spec.enum.some(candidate => String(candidate) === String(value))) invalid(`${key} is outside its allowed enum.`);
      normalized[key] = value;
      if (spec.type === "array") {
        for (const entry of value) { if (typeof entry !== "string") invalid(`${key} must contain strings.`); argv.push(`--${key}=${entry}`); }
      } else argv.push(`--${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
    if (boundedReads.has(item.operation)) {
      if (!normalized.range) invalid("A bounded range is required for this read; use info to find data boundaries.");
      parseRange(normalized.range);
    }
    if (["export", "export-csv"].includes(item.operation) && !normalized.output) invalid("Exports require an explicit new output filename inside the allowed files directory.");
    if (Buffer.byteLength(JSON.stringify(normalized)) > 150000) invalid("Parameters exceed 150 KB. Split the operation or use an allowed local input file.");
    return { argv, normalized };
  }
  async function call(name, args = {}) {
    if (name === "describe_dingtalk_sheet_operation") {
      if (args.operation) {
        const item = operations.get(args.operation);
        if (!item) invalid("Unknown pinned Sheet operation.");
        return { cli_version: CATALOG.version, ...item, parameters: Object.fromEntries(Object.entries(item.parameters).filter(([key]) => !["node", "sheet-id", "yes"].includes(key))), url_required: "node" in item.parameters, sheet_id_supported: "sheet-id" in item.parameters, files_directory: filesRoot };
      }
      return { cli_version: CATALOG.version, operations: CATALOG.operations.filter(item => !args.category || item.operation === args.category || item.operation.startsWith(args.category + " ")).map(({ operation, effect, risk, confirmation }) => ({ operation, effect, risk, confirmation })), count: CATALOG.operations.length, files_directory: filesRoot };
    }
    const item = operations.get(args.operation);
    if (!item) invalid("Unknown pinned Sheet operation.");
    const write = name === "write_dingtalk_sheet_operation";
    if (write === (item.effect === "read")) invalid("Operation must use the correct read or write tool.");
    for (const key of ["dry_run", "confirmed"]) if (args[key] !== undefined && typeof args[key] !== "boolean") invalid(`${key} must be boolean.`);
    if (write && item.confirmation === "user_required" && !args.dry_run && !args.confirmed) throw new BridgeError("CONFIRMATION_REQUIRED", "This operation needs authorization for its exact target. If the user's existing instructions already grant it, set confirmed=true; otherwise show the concrete change first.");
    const account = validateProfile(args.profile);
    const link = args.url === undefined ? undefined : validateUrl(args.url);
    const { argv, normalized } = await prepare(item, args);
    if (args.dry_run) return { operation: item.operation, profile: account, local_preview: true, remote_called: false, mutation: { submitted: false, dry_run: true, verification: "not_applied" }, plan: redact(["sheet", ...item.operation.split(" "), ...argv, ...(link ? [`--node=${link.node}`] : []), ...(args.sheet_id ? [`--sheet-id=${args.sheet_id}`] : []), `--profile=${account}`]), resource_validation: "URL syntax only; no metadata lookup during local preview" };
    const resource = link ? await spreadsheet(link, account) : null;
    const command = ["sheet", ...item.operation.split(" "), ...argv];
    if (resource) command.push(`--node=${resource.node}`);
    if (args.sheet_id !== undefined) command.push(`--sheet-id=${args.sheet_id}`);
    if (args.dry_run) command.push("--dry-run");
    if (write && args.confirmed) command.push("--yes");
    let result;
    const fileOperation = normalized.file || normalized.batch || normalized.output || (typeof normalized.csv === "string" && normalized.csv.startsWith("@"));
    try { result = await cli(command, account, { mutation: write && !args.dry_run, longRunning: ["import create", "export", "create-with-data"].includes(item.operation), cwd: fileOperation ? filesRoot : undefined }); }
    catch (error) {
      if (write && !args.dry_run && ["CLI_TIMEOUT", "CLI_RESPONSE_INVALID", "OUTPUT_LIMIT"].includes(error.code)) throw new BridgeError("MUTATION_OUTCOME_UNKNOWN", "The write may have been applied. Read back the target or resume the returned task; do not blindly repeat create, append, import or other writes.", { cause: error.code, operation: item.operation });
      throw error;
    }
    const output = { operation: item.operation, profile: account, ...(resource ? { resource } : {}), ...(args.sheet_id ? { sheet_id: args.sheet_id } : {}), ...(write ? { mutation: { submitted: !args.dry_run, dry_run: args.dry_run ?? false, verification: args.dry_run ? "not_applied" : "read_back_required", retry: "never_blindly_replay" } } : {}), result: redact(result) };
    if (normalized.output) {
      const info = await stat(normalized.output).catch(() => null);
      output.local_file = { path: normalized.output, exists: !!info?.isFile(), bytes: info?.size ?? 0, verified_nonempty: !!info?.isFile() && info.size > 0 };
      if (!output.local_file.verified_nonempty) throw new BridgeError("EXPORT_NOT_VERIFIED", "No nonempty local file was found. Do not claim the export is complete.", { result: redact(result) });
    }
    if (noNodeCreates.has(item.operation) && !args.dry_run) output.mutation.verification = "verify_returned_node_and_content";
    return output;
  }
  return { call };
}
