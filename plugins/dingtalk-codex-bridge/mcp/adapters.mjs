import { spawn } from "node:child_process";
import { BridgeError, redact, parseCliResult } from "./cli.mjs";
import { createFiles } from "./files.mjs";

const input = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
export const ADAPTER_TOOL_DEFINITIONS = [
  { name: "invoke_dingtalk_published_mcp", title: "Invoke a published DingTalk MCP tool", description: "Call an explicitly selected published service/tool through the official CLI's fresh input-Schema gate. Discover with mcp published tools first. Local previews do not call the remote service. Actual invocation needs user authorization for the exact tool, parameters and side effects.", inputSchema: input({ profile: { type: "string" }, mcp_id: { type: "string" }, tool: { type: "string" }, parameters: { type: "object" }, dry_run: { type: "boolean", default: true }, confirmed: { type: "boolean", default: false } }, ["profile", "mcp_id", "tool"]), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: "call_dingtalk_openapi", title: "Call official DingTalk OpenAPI", description: "Raw API adapter for a separately configured custom application. Default user OAuth alone is insufficient. Only api.dingtalk.com/oapi.dingtalk.com, bounded paging and allowed local multipart files. Actual requests need exact user authorization; dry_run is local-only. No credential values in requests.", inputSchema: input({ method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, host: { type: "string", enum: ["api.dingtalk.com", "oapi.dingtalk.com"] }, path: { type: "string" }, query: { type: "object" }, body: { type: "object" }, file: { type: "object", properties: { field: { type: "string" }, path: { type: "string" } }, required: ["path"], additionalProperties: false }, page_limit: { type: "integer", minimum: 1, maximum: 10 }, dry_run: { type: "boolean", default: true }, confirmed: { type: "boolean", default: false } }, ["method", "path"]), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: "listen_dingtalk_events", title: "Listen to bounded DingTalk events", description: "Adapt event consume/+listen-im to a 1–30 second, at-most-20-event MCP call. Uses graceful shutdown and DWS ownership cleanup; never SIGKILLs the event consumer. Creating a listener requires user intent. dry_run builds a local plan without subscribing. Reuse an existing subscription only when explicitly selected.", inputSchema: input({ profile: { type: "string" }, mode: { type: "string", enum: ["consume", "listen-im"] }, event_keys: { type: "array", items: { type: "string" }, maxItems: 10 }, parameters: { type: "object" }, seconds: { type: "integer", minimum: 1, maximum: 30 }, max_events: { type: "integer", minimum: 1, maximum: 20 }, dry_run: { type: "boolean", default: false } }, ["profile"]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
];
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function bad(message) { throw new BridgeError("INVALID_ARGUMENT", message); }

export function createAdapters({ runner, workspace, validateProfile, env = process.env, spawnProcess = spawn }) {
  const files = createFiles(env);
  async function published(args) {
    const profile = validateProfile(args.profile);
    if (typeof args.mcp_id !== "string" || !/^[1-9][0-9]{0,19}$/u.test(args.mcp_id) || typeof args.tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(args.tool)) bad("Use a real published numeric service ID and exact tool name.");
    if (args.parameters !== undefined && !plain(args.parameters)) bad("parameters must be an object.");
    const params = JSON.stringify(args.parameters ?? {});
    if (Buffer.byteLength(params) > 150000) bad("Tool parameters exceed 150 KB.");
    const argv = ["mcp", "published", "invoke", args.mcp_id, args.tool, `--params=${params}`, `--profile=${profile}`, "--format=json"];
    if (args.dry_run !== false) return { local_preview: true, remote_called: false, plan: redact(argv), runtime_schema_validation: "performed_by_native_cli_on_actual_invocation" };
    if (args.confirmed !== true) throw new BridgeError("CONFIRMATION_REQUIRED", "The exact published tool and side effects must be authorized before actual invocation.");
    try { return { mutation: { submitted: true, verification: "verify_remote_business_result" }, result: redact(await runner.run([...argv, "--yes"], { timeout: 60000, allowPrimitive: true })) }; }
    catch (error) { if (["CLI_TIMEOUT", "OUTPUT_LIMIT", "CLI_RESPONSE_INVALID"].includes(error.code)) throw new BridgeError("MUTATION_OUTCOME_UNKNOWN", "Published tool outcome is unknown; do not repeat without checking its business result."); throw error; }
  }
  async function raw(args) {
    const method = args.method, host = args.host || "api.dingtalk.com", route = args.path;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !["api.dingtalk.com", "oapi.dingtalk.com"].includes(host)) bad("Unsupported HTTP method or host.");
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || route.includes("?") || route.includes("#") || /[\x00-\x20\x7f\\]/u.test(route) || route.split("/").includes("..")) bad("Use an absolute API path on the selected official host, without URL/query/fragment or traversal.");
    for (const key of ["query", "body"]) if (args[key] !== undefined && !plain(args[key])) bad(`${key} must be an object.`);
    if (Object.keys(args.query || {}).some(k => /^(?:access[_-]?token|authorization|app[_-]?secret|client[_-]?secret)$/iu.test(k))) bad("Credentials are owned by the native CLI, not query parameters.");
    const pages = args.page_limit ?? 1;
    if (!Number.isInteger(pages) || pages < 1 || pages > 10) bad("page_limit must be 1..10.");
    if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") bad("dry_run must be boolean.");
    const argv = ["api", method, route, `--base-url=https://${host}`, "--format=json"];
    if (args.query) argv.push(`--params=${JSON.stringify(args.query)}`);
    if (args.body) argv.push(`--data=${JSON.stringify(args.body)}`);
    if (pages > 1) argv.push("--page-all", `--page-limit=${pages}`);
    if (args.file) {
      if (!plain(args.file) || Object.keys(args.file).some(k => !["field", "path"].includes(k)) || !/^[A-Za-z0-9_-]+$/u.test(args.file.field || "file")) bad("Invalid multipart file descriptor.");
      argv.push(`--file=${args.file.field || "file"}=${await files.resolve(args.file.path)}`);
    }
    if (Buffer.byteLength(JSON.stringify(argv)) > 150000) bad("Request parameters exceed 150 KB.");
    if (args.dry_run !== false) return { local_preview: true, remote_called: false, auth_model: "custom_application_not_user_profile", plan: redact(argv), pagination_limit: pages };
    if (args.confirmed !== true) throw new BridgeError("CONFIRMATION_REQUIRED", "Actual Raw API calls require authorization for the exact method, endpoint and payload. Default user login does not establish custom-app credentials.");
    let result;
    try { result = await runner.run(argv, { timeout: 60000, cwd: args.file ? files.root : undefined, allowPrimitive: method === "GET" ? "read" : true }); }
    catch (error) { if (method !== "GET" && ["CLI_TIMEOUT", "OUTPUT_LIMIT", "CLI_RESPONSE_INVALID"].includes(error.code)) throw new BridgeError("MUTATION_OUTCOME_UNKNOWN", "Raw request outcome is unknown; read back the business object before retrying."); throw error; }
    return { auth_model: "custom_application_not_user_profile", method, host, path: route, ...(method !== "GET" ? { mutation: { submitted: true, verification: "read_back_required" } } : {}), result: redact(result) };
  }
  async function events(args) {
    const profile = validateProfile(args.profile), seconds = args.seconds ?? 10, max = args.max_events ?? 10;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30 || !Number.isInteger(max) || max < 1 || max > 20) bad("Event limits are 1–30 seconds and 1–20 records.");
    const mode = args.mode ?? "consume", command = mode === "consume" ? "event consume" : mode === "listen-im" ? "event +listen-im" : null;
    if (!command) bad("Unknown event adapter mode.");
    const parameters = args.parameters ?? {};
    if (!plain(parameters)) bad("parameters must be an object.");
    const allowed = mode === "consume" ? ["user", "open-dingtalk-id", "group", "calendar-ids", "change-types", "role-types", "filter-json", "subscribe-id", "query", "event-types", "name"] : ["kind", "events", "chat-id", "chat-query", "user", "user-query", "open-dingtalk-id", "query"];
    if (Object.keys(parameters).some(k => !allowed.includes(k))) bad("This bounded adapter does not accept bus/endpoint/file-routing overrides.");
    const keys = args.event_keys ?? [];
    if (!Array.isArray(keys) || keys.length > 10 || keys.some(k => typeof k !== "string" || !/^[a-z][a-z0-9_]+$/u.test(k))) bad("Invalid EventKeys.");
    if (mode === "consume" && !keys.length && !parameters["subscribe-id"]) bad("Provide EventKeys from event list, or an explicitly selected subscription ID.");
    const entry = workspace.commands.get(command);
    const prepared = await workspace.prepare(entry, { profile, parameters: { ...parameters, duration: `${seconds}s`, "max-events": max, ...(mode === "consume" ? { flatten: true } : {}) }, positionals: mode === "consume" ? keys : [] });
    const argv = [...prepared.argv, `--profile=${profile}`, "--format=ndjson"];
    if (args.dry_run === true) return { local_preview: true, remote_called: false, seconds, max_events: max, plan: redact(argv), cleanup: "native ownership rules; graceful shutdown" };
    const { executable } = await runner.runtime();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(executable, argv, { env: { ...env, DWS_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
      let buffer = "", stderr = "", bytes = 0, limited = false, done = false, graceTimer;
      const records = [];
      const stop = () => { child.stdin?.end(); child.kill("SIGTERM"); };
      const watchdog = setTimeout(() => { limited = true; stop(); graceTimer = setTimeout(() => finish(null, "cleanup_pending"), 10000); }, (seconds + 10) * 1000);
      function finish(code, cleanup = "native_graceful_cleanup") {
        if (done) return; done = true; clearTimeout(watchdog); clearTimeout(graceTimer);
        const result = { events: records, count: records.length, seconds, bounded: true, output_limited: limited, cleanup, exit_code: code, delivery_verified: records.length > 0 };
        if (code && !records.length) {
          try { parseCliResult({ code, stdout: "", stderr }); } catch (error) { return reject(error); }
        }
        resolve(result);
      }
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 180000) { limited = true; stop(); return; }
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/u); buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { if (records.length < max) records.push(redact(JSON.parse(line))); else limited = true; }
          catch { limited = true; }
        }
      });
      child.stderr.on("data", chunk => { if (stderr.length < 100000) stderr += chunk.toString("utf8"); });
      child.on("error", () => { clearTimeout(watchdog); clearTimeout(graceTimer); reject(new BridgeError("EVENT_PROCESS_FAILED", "Could not start the native event consumer.")); });
      child.on("close", code => { if (buffer.trim()) { try { if (records.length < max) records.push(redact(JSON.parse(buffer))); } catch { limited = true; } } finish(code); });
    });
  }
  return { call: (name, args) => name === "call_dingtalk_openapi" ? raw(args) : name === "invoke_dingtalk_published_mcp" ? published(args) : events(args) };
}
