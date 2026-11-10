import { readFileSync } from "node:fs";
import { stat, realpath, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { BridgeError, redact } from "./cli.mjs";
import { createFiles } from "./files.mjs";
import { filePolicy, requiredDestinations, assertSafeOptions, assertNoImplicitMedia } from "./io-policy.mjs";

export const WORKSPACE_CATALOG = JSON.parse(readFileSync(new URL("./workspace-catalog.json", import.meta.url), "utf8"));
const commands = new Map(WORKSPACE_CATALOG.commands.map(item => [item.command, item]));
const prop = description => ({ type: "string", description });
const callFields = { command: prop("Exact command without dws, returned by discover/describe. Never a shell command."), profile: prop("Explicit corpId:userId for one account."), parameters: { type: "object", description: "Native local flags with typed values; JSON fields may be objects/arrays. Global identity/debug flags are not accepted." }, positionals: { type: "array", items: { type: "string" }, description: "Positional identifiers only when declared in native Usage." }, secret_refs: { type: "object", additionalProperties: { type: "string" }, description: "Credential flag -> configured DINGTALK_BRIDGE_SECRET_* environment variable name. Never put actual credentials in parameters." }, stdin: { type: "string", description: "Explicit bounded stdin content when the native command supports it." } };
const input = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const readHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WORKSPACE_TOOL_DEFINITIONS = [
  { name: "discover_dingtalk_commands", title: "Browse DingTalk Workspace capabilities", description: "Browse the complete pinned CLI catalogue by product, keyword or integration mode. Returns paged entries and exact counts, including unavailable and local-workflow commands.", inputSchema: input({ product: prop("Product ID, e.g. doc, todo, calendar, chat, mail, aitable."), query: prop("Case-insensitive text search."), mode: prop("mcp, event_adapter, utility_adapter, raw_adapter, published_adapter, local_workflow, unavailable or contract_drift."), offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }), annotations: readHints },
  { name: "describe_dingtalk_command", title: "Inspect an exact DingTalk command", description: "Read one pinned command's parameters, actual Cobra flag kinds, positional Usage, effects, integration status and local workflow. No remote request.", inputSchema: input({ command: callFields.command }, ["command"]), annotations: readHints },
  { name: "read_dingtalk_command", title: "Run a structured DingTalk query", description: "Run a catalogued public read command with one explicit account. Supports typed native parameters, bounded local files, JSON, NDJSON and documented text outputs. Does not execute unavailable, credential or local lifecycle commands.", inputSchema: input(callFields, ["command", "profile"]), annotations: readHints },
  { name: "write_dingtalk_command", title: "Run an authorized DingTalk mutation", description: "Run a catalogued business mutation. User instructions must authorize the target/action. Messages, emails, comments, approvals and notifications need their specific explicit intent. dry_run is a local-only preview: no CLI request or remote side effect. Read back all actual writes; never blindly retry unknown outcomes.", inputSchema: input({ ...callFields, dry_run: { type: "boolean", default: false }, confirmed: { type: "boolean", default: false, description: "Reuse existing user authorization for the exact destructive operation; only ask if it is missing." } }, ["command", "profile"]), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } }
];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function bad(message) { throw new BridgeError("INVALID_ARGUMENT", message); }
const forbidden = new Set(["profile", "client-id", "client-secret", "robot-client-secret", "debug", "verbose", "mock", "jq", "yes", "dry-run"]);
const endpoints = new Set(["base-url", "mcp-url", "pre-url", "personal-event-base-url", "stream-ticket-url", "disable-ssl-verify"]);
const secretFlags = new Set(["password", "token", "webhook-token"]);
const literalAtParameters = new Set(["media-id", "resource-id", "map-thumbnail-url"]);
const mediaTextParameters = new Set(["content", "markdown", "text", "body"]);
const csvQuote = value => /[,"\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function createWorkspace({ runner, sheetCall, validateProfile, validateId, env = process.env }) {
  const files = createFiles(env);
  async function prepare(item, args, { validateRequired = true } = {}) {
    const parameters = args.parameters ?? {}, refs = args.secret_refs ?? {};
    if (!plain(parameters) || !plain(refs)) bad("parameters and secret_refs must be objects.");
    assertSafeOptions(item, parameters, { validateRequired });
    assertNoImplicitMedia(item, [Object.fromEntries(Object.entries(parameters).filter(([key]) => mediaTextParameters.has(key))), args.stdin, args.positionals]);
    if (args.stdin !== undefined && (typeof args.stdin !== "string" || Buffer.byteLength(args.stdin) > 150000)) bad("stdin must be at most 150 KB of explicit content.");
    const supplied = new Set([...Object.keys(parameters), ...Object.keys(refs)]);
    for (const key of supplied) {
      if (!Object.hasOwn(item.parameters, key) || forbidden.has(key)) bad(`Unsupported or global parameter: ${key}`);
      if (endpoints.has(key)) throw new BridgeError("LOCAL_WORKFLOW_REQUIRED", "Endpoint/trust overrides belong to an explicit local setup workflow.");
      if (Object.hasOwn(parameters, key) && Object.hasOwn(refs, key)) bad(`Use one source for ${key}.`);
      if (secretFlags.has(key) && Object.hasOwn(parameters, key)) throw new BridgeError("SECRET_REFERENCE_REQUIRED", "Use a configured secret_refs environment name, not a credential value in the MCP request.");
    }
    if (validateRequired) for (const [key, spec] of Object.entries(item.parameters)) if (spec.required && !supplied.has(key) && !["yes", "dry-run", "format"].includes(key)) bad(`Missing required parameter: ${key}`);
    const argv = [], preview = [], outputs = [], outputDirectories = [], normalized = {}, redactions = []; let fileIO = false;
    for (const key of supplied) {
      const spec = item.parameters[key], kind = item.native_flags[key]?.kind || "string";
      let value = parameters[key], visible;
      if (Object.hasOwn(refs, key)) {
        if (!secretFlags.has(key) || typeof refs[key] !== "string" || !/^DINGTALK_BRIDGE_SECRET_[A-Z0-9_]+$/u.test(refs[key])) bad("Secret reference must name a configured DINGTALK_BRIDGE_SECRET_* variable for a credential flag.");
        if (!env[refs[key]]) throw new BridgeError("SECRET_NOT_CONFIGURED", "The referenced secret environment variable is not configured in this MCP server.");
        value = env[refs[key]]; redactions.push(value); visible = `[SECRET_REF:${refs[key]}]`;
      }
      let io = filePolicy(item, key, parameters);
      if (io?.jsonOrFile && (plain(value) || Array.isArray(value) || (typeof value === "string" && /^[\s]*[\[{]/u.test(value)))) {
        if (typeof value === "string") { try { value = JSON.parse(value); } catch { bad(`${key} is not valid inline JSON.`); } }
        io = null;
      }
      if (io && !(value === "-" && args.stdin !== undefined)) {
        const one = async entry => {
          if (io.jsonOrFile && typeof entry === "string" && entry.startsWith("@")) entry = entry.slice(1);
          const resolved = await files.resolve(entry, io);
          if (io.directory && !io.output) await files.checkTree(resolved);
          if (io.output) { outputs.push(resolved); if (io.directory && item.command !== "minutes +export-pack") outputDirectories.push(resolved); }
          return io.absolute ? resolved : path.relative(await realpath(files.root), resolved);
        };
        value = Array.isArray(value) ? await Promise.all(value.map(one)) : await one(value); fileIO = true;
      }
      else if (typeof value === "string" && value.startsWith("@") && !literalAtParameters.has(key)) {
        value = await files.read(value.slice(1)); fileIO = true;
        if (/JSON|json/u.test(spec.description || "") || spec.format === "json") { try { value = JSON.parse(value); } catch { bad(`${key} input is not valid JSON.`); } }
        if (typeof value === "string" && (/^\s*@/u.test(value) || value.trim() === "-")) throw new BridgeError("NESTED_FILE_REFERENCE", "Loaded file content must not trigger a second native file/stdin reference; use explicit literal stdin when appropriate.");
      }
      if (value === "-" && args.stdin === undefined) bad("stdin '-' requires explicit stdin content; implicit terminal input is not supported.");
      if (mediaTextParameters.has(key)) assertNoImplicitMedia(item, value);
      if (key === "filename" && item.command === "mail message export") { value = value.replace(/\.eml$/iu, ""); if (!value) bad("Mail export requires a nonempty filename."); }
      if ((key === "stdin" || key.endsWith("-stdin")) && value === true && args.stdin === undefined) bad("This stdin switch requires explicit stdin content.");
      if (spec.type === "boolean" && typeof value !== "boolean") bad(`${key} must be boolean.`);
      if (spec.type === "integer" && !Number.isSafeInteger(value)) bad(`${key} must be a safe integer.`);
      if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) bad(`${key} must be numeric.`);
      if (spec.type === "array" && (!Array.isArray(value) || value.length > 500)) bad(`${key} must be an array of at most 500 values.`);
      if (spec.type === "string" && typeof value !== "string") {
        if (!(plain(value) || Array.isArray(value)) || !(spec.format === "json" || /JSON|json|二维|对象/u.test(spec.description || ""))) bad(`${key} must be a string or its documented JSON structure.`);
        value = JSON.stringify(value);
      }
      if (typeof value === "string" && (value.includes("\0") || Buffer.byteLength(value) > 150000)) bad(`${key} contains NUL or exceeds 150 KB.`);
      if (spec.enum) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some(v => !spec.enum.some(candidate => String(candidate) === String(v)))) bad(`${key} is outside its declared enum.`);
      }
      normalized[key] = value;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (!["string", "number", "boolean"].includes(typeof entry)) bad(`${key} array values must be scalar.`);
        const encoded = kind === "strings" ? csvQuote(String(entry)) : String(entry);
        argv.push(`--${key}=${encoded}`); preview.push(`--${key}=${visible ?? encoded}`);
      }
    }
    const positionals = args.positionals ?? [];
    if (!Array.isArray(positionals) || positionals.length > 20 || positionals.some(p => typeof p !== "string" || !p || p.startsWith("-") || /[\x00\r\n]/u.test(p) || p.length > 1000)) bad("Invalid positional identifiers.");
    const syntax = item.usage?.find(u => u.startsWith(item.command))?.slice(item.command.length) || "";
    const placeholders = [...syntax.matchAll(/<([^>]+)>|\[([^\]]+)\]/gu)].map(m => m[1] || m[2]).filter(p => !["flags", "command"].includes(p));
    if (positionals.length && !placeholders.length) bad("This command does not declare positional arguments.");
    if (positionals.length < [...syntax.matchAll(/<[^>]+>/gu)].length) bad("Required positional identifiers are missing; inspect Usage.");
    if (positionals.length > placeholders.length && !placeholders.some(p => p.includes("..."))) bad("Too many positional identifiers.");
    if (item.command === "mail message export" && normalized.filename !== undefined) { outputs.push(await files.resolve(`${normalized.filename}.eml`, { output: true })); fileIO = true; }
    return { argv: [...item.command.split(" "), ...positionals, ...argv], preview: [...item.command.split(" "), ...positionals, ...preview], normalized, outputs, outputDirectories, redactions, input: args.stdin, cwd: fileIO ? await realpath(files.root) : undefined };
  }
  async function execute(item, args, write) {
    const profile = validateProfile(args.profile);
    if (write && item.confirmation === "user_required" && !args.confirmed && !args.dry_run) throw new BridgeError("CONFIRMATION_REQUIRED", "Use confirmed=true only when existing user instructions authorize this exact action and target.");
    for (const key of ["confirmed", "dry_run"]) if (args[key] !== undefined && typeof args[key] !== "boolean") bad(`${key} must be boolean.`);
    const prepared = await prepare(item, args);
    const sanitize = value => {
      let text = JSON.stringify(redact(value));
      for (const secret of prepared.redactions) text = text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
      return JSON.parse(text);
    };
    if (args.dry_run) return { command: item.command, profile, local_preview: true, remote_called: false, plan: sanitize([...prepared.preview, `--profile=${profile}`]), stdin_bytes: args.stdin === undefined ? 0 : Buffer.byteLength(args.stdin), effect: item.effect, confirmation: item.confirmation, runtime_validation: "catalog_types_and_actual_flag_contract_only" };
    if (item.product === "sheet") {
      const parameters = { ...args.parameters }; delete parameters.node; delete parameters["sheet-id"];
      const nativeNode = args.parameters?.node;
      const url = nativeNode === undefined ? undefined : nativeNode.startsWith("https://") ? nativeNode : `https://alidocs.dingtalk.com/i/nodes/${validateId(nativeNode)}`;
      return sheetCall(write ? "write_dingtalk_sheet_operation" : "read_dingtalk_sheet_operation", { operation: item.command.slice(6), profile, ...(url ? { url } : {}), ...(args.parameters?.["sheet-id"] ? { sheet_id: args.parameters["sheet-id"] } : {}), parameters, ...(args.confirmed ? { confirmed: true } : {}) });
    }
    const argv = [...prepared.argv, `--profile=${profile}`];
    const localFormat = item.native_flags.format?.local && item.parameters.format;
    if (item.command === "audit export") { if (!Object.hasOwn(prepared.normalized, "format")) argv.push("--format=jsonl"); }
    else if (item.command !== "aitable +export-data" && (!localFormat || !Object.hasOwn(prepared.normalized, "format"))) argv.push("--format=json");
    if (!Object.hasOwn(item.parameters, "timeout")) argv.push("--timeout=30");
    if (write && args.confirmed) argv.push("--yes");
    let result;
    const cwd = prepared.cwd ?? (item.mode === "mcp" ? await files.workingDirectory() : undefined);
    for (const directory of prepared.outputDirectories) await mkdir(directory, { mode: 0o700 });
    try { result = await runner.run(argv, { timeout: prepared.outputs.length || /\b(?:import|export|upload|download)\b/u.test(item.command) ? 330000 : 45000, cwd, input: prepared.input, allowPrimitive: write ? true : "read", allowText: !write }); }
    catch (error) {
      if (write && ["CLI_TIMEOUT", "OUTPUT_LIMIT", "CLI_RESPONSE_INVALID"].includes(error.code)) throw new BridgeError("MUTATION_OUTCOME_UNKNOWN", "This mutation may have been applied. Read back or query its task before any retry.", { command: item.command, cause: error.code });
      if (error instanceof BridgeError && prepared.redactions.length) throw new BridgeError(error.code, sanitize(error.message), error.details === undefined ? undefined : sanitize(error.details));
      throw error;
    }
    const response = { command: item.command, profile, ...(write ? { mutation: { submitted: true, verification: "read_back_required", retry: "never_blindly_replay" } } : {}), result: sanitize(result) };
    if (prepared.outputs.length) response.local_files = await Promise.all(prepared.outputs.map(async file => { const s = await stat(file).catch(() => null), directory = !!s?.isDirectory(), count = directory ? (await readdir(file)).length : undefined; return { path: file, exists: !!s, kind: directory ? "directory" : "file", bytes: s?.size ?? 0, ...(directory ? { entries: count } : {}), verified_nonempty: directory ? count > 0 : !!s?.isFile() && s.size > 0 }; }));
    return response;
  }
  async function call(name, args = {}) {
    if (name === "discover_dingtalk_commands") {
      const offset = args.offset ?? 0, limit = args.limit ?? 25;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) bad("Invalid catalogue pagination.");
      const query = args.query?.toLowerCase();
      const matches = WORKSPACE_CATALOG.commands.filter(item => (!args.product || item.product === args.product) && (!args.mode || item.mode === args.mode) && (!query || (item.command + " " + item.description).toLowerCase().includes(query)));
      return { summary: WORKSPACE_CATALOG.summary, total: matches.length, offset, has_more: offset + limit < matches.length, commands: matches.slice(offset, offset + limit).map(({ command, product, mode, effect, risk, confirmation, reason }) => ({ command, product, mode, effect, risk, confirmation, reason })) };
    }
    const item = commands.get(args.command);
    if (!item) bad("Unknown pinned command. Discover the exact command first.");
    if (name === "describe_dingtalk_command") return { version: "1.0.67", ...item, files_directory: files.root, bridge_required_destinations: requiredDestinations(item), local_io_policy: "Explicit checked new outputs; no overwrite flags; JSON-file, checkpoint and media inputs stay in the allowed root. Inline Markdown images require an existing mediaid: reference.", user_intent_required: /^(?:chat|ding|mail|oa) /u.test(item.command) ? "messages, notifications and approval changes require explicit intent" : undefined };
    if (item.mode === "utility_adapter" && name === "read_dingtalk_command") {
      const parameters = { ...(args.parameters || {}) };
      if (item.command === "auth status") parameters.readonly = true;
      if (item.command === "doctor" && Object.hasOwn(item.parameters, "json")) parameters.json = true;
      return execute({ ...item, effect: "read" }, { ...args, parameters }, false);
    }
    if (item.mode !== "mcp") throw new BridgeError(item.mode === "unavailable" ? "OFFICIALLY_UNAVAILABLE" : "SPECIALIZED_WORKFLOW_REQUIRED", item.reason, { command: item.command, mode: item.mode, guidance: "Use describe_dingtalk_command for its supported adapter or local workflow." });
    const write = name === "write_dingtalk_command";
    if (write === (item.effect === "read")) bad("Use the matching read/write interface.");
    return execute(item, args, write);
  }
  return { call, prepare, commands, files };
}
