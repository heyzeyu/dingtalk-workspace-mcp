import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export class McpClient {
  constructor() {
    this.sequence = 0; this.pending = new Map();
    this.child = spawn(process.execPath, [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.lines = createInterface({ input: this.child.stdout });
    this.child.stderr.on("data", () => {}); // Never log credentials or unstructured subprocess diagnostics.
    this.lines.on("line", line => {
      let response;
      try { response = JSON.parse(line); } catch { return this.fail(new Error("MCP returned invalid JSON")); }
      const item = this.pending.get(response.id);
      if (!item) return;
      this.pending.delete(response.id); clearTimeout(item.timer);
      if (response.error) item.reject(new Error(JSON.stringify(response.error))); else item.resolve(response.result);
    });
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("MCP server exited")));
  }
  fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("MCP request timed out; audit writes before retrying")); }, 360000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async initialize() {
    const initialized = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dingtalk-full-validation", version: "0.4.0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return initialized;
  }
  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const value = result.structuredContent || JSON.parse(result.content[0].text);
    if (result.isError) { const error = new Error(JSON.stringify(value.error)); error.details = value.error; throw error; }
    return value;
  }
  close() { this.lines.close(); this.child.stdin.end(); this.child.kill(); this.fail(new Error("MCP client closed")); }
}

export function findResult(value, predicate) {
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  for (const key of ["result", "data", "sheet", "document"]) { const found = findResult(value[key], predicate); if (found) return found; }
  return null;
}
