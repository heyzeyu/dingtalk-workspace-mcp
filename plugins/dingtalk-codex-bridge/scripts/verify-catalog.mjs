#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WORKSPACE_CATALOG, createWorkspace } from "../mcp/workspace.mjs";
import { validateId, validateProfile } from "../mcp/bridge.mjs";
import { filePolicy, requiredDestinations } from "../mcp/io-policy.mjs";

export async function verifyCatalog() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dingtalk-catalog-verify-"));
  await writeFile(path.join(root, "fixture.json"), '{"fixture":true}');
  const workspace = createWorkspace({ runner: { run: () => { throw Error("Network/CLI execution forbidden during catalogue verification"); } }, sheetCall: () => { throw Error("Unexpected Sheet execution"); }, validateId, validateProfile, env: { DINGTALK_BRIDGE_FILES_DIR: root, DINGTALK_BRIDGE_SECRET_TEST: "not-real-test-secret" } });
  const failures = [], drift = []; let compiled = 0, checkedFlags = 0, checkedAvailableFlags = 0;
  try {
    for (const item of WORKSPACE_CATALOG.commands) {
      if (item.source !== "official-runtime-schema") continue;
      for (const key of Object.keys(item.parameters)) {
        if (item.native_flags[key]) { checkedFlags++; if (item.availability === "available") checkedAvailableFlags++; }
        else if (item.availability === "available") drift.push({ command: item.command, flag: key });
      }
      if (item.mode !== "mcp") continue;
      const parameters = {}, secret_refs = {};
      const bridgeRequired = requiredDestinations(item);
      for (const [key, spec] of Object.entries(item.parameters)) {
        if ((!spec.required && !bridgeRequired.includes(key)) || ["yes", "dry-run", "format"].includes(key)) continue;
        const desc = spec.description || "";
        const policy = filePolicy(item, key, parameters);
        let value;
        if (policy?.jsonOrFile) value = "{}";
        else if (policy?.output) value = `output-${compiled}-${key}.bin`;
        else if (policy?.directory) value = ".";
        else if (policy) value = spec.type === "array" ? ["fixture.json"] : "fixture.json";
        else if (spec.type === "boolean") value = key === "overwrite" ? false : true;
        else if (spec.type === "integer" || spec.type === "number") value = 1;
        else if (spec.type === "array") value = [spec.enum?.[0] ?? "fixture"];
        else if (spec.enum?.length) value = String(spec.enum[0]);
        else if (/^(?:output|out|output-file|output-dir|download-dir|qr-file)$/u.test(key)) value = `output-${compiled}.bin`;
        else if (/(?:^file$|(?:^|-)file$|^batch$|^attachment$)/u.test(key) || spec.format === "file-path") value = "fixture.json";
        else if (spec.format === "json" || /JSON|json|二维/u.test(desc)) value = /数组|array|二维/iu.test(desc) ? "[]" : "{}";
        else if (/^input$/u.test(key) || /本地.{0,20}(?:文件|路径)|文件路径|[Ff]ile path|UTF-8.*文件/u.test(desc)) value = "fixture.json";
        else if (spec.format === "date-time") value = "2026-11-09T10:00:00+08:00";
        else if (spec.format === "date") value = "2026-11-09";
        else value = "fixture";
        if (["password", "token", "webhook-token"].includes(key)) secret_refs[key] = "DINGTALK_BRIDGE_SECRET_TEST";
        else parameters[key] = value;
      }
      const syntax = item.usage?.find(u => u.startsWith(item.command))?.slice(item.command.length) || "";
      const positionals = [...syntax.matchAll(/<[^>]+>/gu)].map((_, i) => `fixture${i}`);
      try {
        const prepared = await workspace.prepare(item, { parameters, positionals, secret_refs, stdin: "fixture" });
        if (prepared.argv.slice(0, item.command.split(" ").length).join(" ") !== item.command) throw Error("Command path changed during compilation");
        compiled++;
      } catch (error) { failures.push({ command: item.command, error: error.code || error.name, message: error.message }); }
    }
    return { schema_commands: WORKSPACE_CATALOG.summary.native_schema_count, utility_commands: WORKSPACE_CATALOG.summary.utility_leaf_count, indexed_commands: WORKSPACE_CATALOG.commands.length, callable_business_commands: WORKSPACE_CATALOG.commands.filter(c => c.mode === "mcp").length, compiled, checked_native_flags: checkedFlags, checked_available_native_flags: checkedAvailableFlags, metadata_flag_drift: drift, compilation_failures: failures, remote_calls: 0 };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const result = await verifyCatalog(); console.log(JSON.stringify(result, null, 2));
  if (result.compilation_failures.length || result.metadata_flag_drift.length) process.exitCode = 1;
}
