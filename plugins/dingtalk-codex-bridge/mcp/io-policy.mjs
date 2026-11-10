import { BridgeError } from "./cli.mjs";

const jsonSources = new Set(["mind create", "whiteboard create-with-content", "whiteboard render"]);
const alwaysOutputs = new Set(["drive download", "drive download-version", "doc +export", "doc +media-download", "doc +resource-download", "chat +messages-resource-download", "mail attachment download"]);
const basename = value => typeof value === "string" && value.length > 0 && !/[\\/\x00-\x1f:]/u.test(value) && ![".", ".."].includes(value);

export function filePolicy(item, key, parameters = {}) {
  const spec = item.parameters[key];
  if (!spec || ["boolean", "integer", "number"].includes(spec.type)) return null;
  if (key === "checkpoint") return { output: !(parameters.resume === true || /\+build-plan-verify$|\+task-report$/u.test(item.command)) };
  if (key === "plan" && item.command.startsWith("aitable +build-plan")) return { output: false };
  if (key === "baseline" && item.command === "aitable +task-report") return { output: false };
  if (key === "from-document" && item.command.startsWith("oa approval template ")) return { output: false, absolute: true };
  if (key === "source" && jsonSources.has(item.command)) return { output: false, jsonOrFile: true };
  if (key === "source" && item.command === "whiteboard update") return { output: false };
  if (key === "local-folder" && item.command.startsWith("drive ")) return { output: false, directory: true, absolute: true };
  if (/^(?:output|out|output-file|export-output|output-dir|download-dir|qr-file)$/u.test(key)) {
    const directory = key.endsWith("dir") || /目标目录|保存目录|新归档目录/u.test(spec.description || "") || item.command === "mail attachment download";
    return { output: true, directory };
  }
  if (/^(?:media-files|additional-files)$/u.test(key)) return { output: false };
  if ((spec.format === "json" || /JSON|json/u.test(spec.description || "")) && !/(?:^file$|(?:^|-)file$|^batch$|^attachment$)/u.test(key)) return null;
  if (spec.format === "file-path" || /(?:^file$|(?:^|-)file$|^input$|^batch$|^attachment$)/u.test(key) || /本地.{0,20}(?:文件|路径)|文件路径|[Ff]ile path|UTF-8.*文件/u.test(spec.description || "")) return { output: false };
  return null;
}

export function requiredDestinations(item, parameters = {}) {
  if (parameters["url-only"] === true && Object.hasOwn(item.parameters, "url-only")) return [];
  if (alwaysOutputs.has(item.command)) return ["output"];
  if (item.command === "mail message export") return ["filename"];
  if (parameters["download-resources"] === true && "output-dir" in item.parameters) return ["output-dir"];
  if (item.command === "minutes +detail" && ["file", "both"].includes(parameters["transcript-output"])) return ["output-dir"];
  if (item.command === "minutes +download" && parameters["url-only"] !== true && !parameters.output && !parameters["output-dir"]) return [parameters.ids ? "output-dir" : "output"];
  return [];
}

export function assertSafeOptions(item, parameters, { validateRequired = true } = {}) {
  if (parameters.overwrite === true) throw new BridgeError("FILE_OVERWRITE_NOT_ALLOWED", "Choose a new output path; this bridge does not enable native overwrite flags.");
  if (validateRequired) for (const key of requiredDestinations(item, parameters)) {
    if (!Object.hasOwn(parameters, key)) throw new BridgeError("EXPLICIT_OUTPUT_REQUIRED", `This operation requires an explicit new ${key} inside the allowed files directory.`);
  }
  if (item.command === "mail attachment download" && !basename(parameters.name)) throw new BridgeError("INVALID_ARGUMENT", "Attachment name must be a plain filename without path components.");
  if (item.command === "mail message export" && parameters.filename !== undefined && !basename(parameters.filename)) throw new BridgeError("INVALID_ARGUMENT", "Mail export filename must be a plain basename, without paths.");
}

export function assertNoImplicitMedia(item, value) {
  if (item.effect === "read" || !["chat", "doc", "markdown", "html", "mail"].includes(item.product)) return;
  function check(input) {
    if (typeof input === "string") {
      // Native Markdown parsers read/upload inline paths before sending. Only
      // existing media IDs avoid an implicit local/remote fetch. Use the explicit
      // guarded file-upload interface for local files instead.
      const withoutMediaIds = input.replace(/!\[[^\]\r\n]*\]\(\s*mediaid:[A-Za-z0-9_@/+=.:-]+\s*\)/gu, "");
      if (withoutMediaIds.includes("![")) throw new BridgeError("IMPLICIT_MEDIA_NOT_ALLOWED", "Inline Markdown images must reference an existing mediaid:. Upload local files through explicit guarded file parameters; embedded paths and URLs are not accepted.");
    } else if (input && typeof input === "object") for (const child of Object.values(input)) check(child);
  }
  check(value);
}
