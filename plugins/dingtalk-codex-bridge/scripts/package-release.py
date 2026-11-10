#!/usr/bin/env python3
"""Build a shareable source ZIP with a pinned public brand asset.

No DWS invocation, credential-store access, business API or network is involved.
Private marker files are optional, operator-supplied and never included.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import unquote
import zipfile


class ReleaseError(ValueError):
    pass


SECRET_PATTERNS = (
    ("private_key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("service_token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|xox[baprs]-[A-Za-z0-9-]{25,})\b")),
    ("jwt", re.compile(rb"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b")),
    ("credential_literal", re.compile(rb"(?i)(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|webhook[_-]?token|password)[\"']?\s*[:=]\s*[\"']([A-Za-z0-9+/=]{24,})[\"']")),
)
DENIED_COMPONENTS = {".git", ".dws", ".env", ".DS_Store", "__MACOSX", "node_modules", "__pycache__", "downloads", "minutes-downloads", "minutes-transcripts"}
DENIED_SUFFIXES = {".log", ".db", ".sqlite", ".sqlite3", ".key", ".pem", ".p12", ".pfx", ".pyc", ".zip", ".xlsx", ".xls", ".mp3", ".mp4"}
PINNED_PUBLIC_ASSETS = {
    # Unmodified public favicon linked by https://www.dingtalk.com/.
    "plugins/dingtalk-codex-bridge/assets/dingtalk.png": "b3fb0715857df5d23213b5265166fabcb7f7b4b290890d7b5682a027cf39c85d",
}


def portable_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ReleaseError("Allowlist entries must be portable relative file paths.")
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or str(p) != value or ":" in value:
        raise ReleaseError("Unsafe path in release allowlist.")
    if any(part in DENIED_COMPONENTS or part.startswith(".env.") for part in p.parts) or p.suffix.lower() in DENIED_SUFFIXES:
        raise ReleaseError("Runtime, credential, binary or generated data cannot enter this source release.")
    return p


def private_markers(paths=()):
    markers = [str(Path.home())]
    for path in paths:
        values = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(values, list) or any(not isinstance(v, str) or len(v.encode("utf-8")) < 4 for v in values):
            raise ReleaseError("Private marker file must be a JSON list of strings of at least four UTF-8 bytes.")
        markers.extend(values)
    return tuple(dict.fromkeys(v.encode("utf-8") for v in markers))


def inspect_content(name, content, markers, *, path_only=False):
    if name in PINNED_PUBLIC_ASSETS and not path_only:
        if hashlib.sha256(content).hexdigest() != PINNED_PUBLIC_ASSETS[name]:
            raise ReleaseError("Public brand asset differs from the reviewed official bytes.")
        # Only these exact public bytes may bypass text decoding. The path still
        # undergoes private-marker checks; other binary content remains rejected.
        content = b""
    if b"\x00" in content:
        raise ReleaseError(f"Unexpected binary content in {name}.")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ReleaseError(f"Non-UTF-8 file in text-only source release: {name}.") from error
    def decoded(value):
        return unquote(re.sub(r"\\u([0-9a-fA-F]{4})", lambda match: chr(int(match[1], 16)), value).replace("\\/", "/"))
    views = [name, text, decoded(name), decoded(text)]
    if any(marker.decode("utf-8") in view for marker in markers for view in views):
        raise ReleaseError("Private marker detected in an allowlisted path or file; matched values and private filenames are intentionally not printed.")
    for category, pattern in SECRET_PATTERNS:
        if any(pattern.search(view.encode("utf-8", errors="surrogatepass")) for view in views):
            raise ReleaseError(f"Potential {category} in an allowlisted path or file; credential values and private filenames are intentionally not printed.")


def collect_files(root, markers=(), excluded_paths=()):
    root = Path(root).resolve(strict=True)
    manifest_path = root / "release-files.json"
    if manifest_path.is_symlink():
        raise ReleaseError("Release manifest cannot be a symlink.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    names = manifest.get("files")
    if manifest.get("format") != 1 or not isinstance(names, list) or not names or "release-files.json" not in names:
        raise ReleaseError("A nonempty version-1 allowlist including itself is required.")
    if len(set(names)) != len(names):
        raise ReleaseError("Duplicate release paths.")
    result = {}
    excluded = {Path(p).resolve(strict=True) for p in excluded_paths}
    for name in sorted(names):
        inspect_content(name, b"", markers, path_only=True)
        relative = portable_path(name)
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ReleaseError(f"Symlink cannot enter release: {name}.")
        if not current.is_file() or not current.resolve().is_relative_to(root):
            raise ReleaseError(f"Missing or out-of-root release file: {name}.")
        if current.resolve() in excluded:
            raise ReleaseError("Private marker files cannot enter a release, even if explicitly allowlisted.")
        content = current.read_bytes()
        inspect_content(name, content, markers)
        result[name] = content
    return result


def build_package(root, output, marker_paths=()):
    root = Path(root).resolve(strict=True)
    output = Path(output).absolute()
    output_parent = output.parent.resolve(strict=True)
    output = output_parent / output.name
    if output.is_relative_to(root):
        raise ReleaseError("Write releases outside the source tree.")
    markers = private_markers(marker_paths)
    files = collect_files(root, markers, marker_paths)
    metadata_path = "plugins/dingtalk-codex-bridge/.codex-plugin/plugin.json"
    metadata = json.loads(files[metadata_path])
    version = metadata["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ReleaseError("Unexpected plugin version.")
    prefix = f"dingtalk-codex-bridge-{version}/"
    checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in files.items()).encode("utf-8")
    inspect_content("FILES.sha256", checksums, markers)
    entries = {**files, "FILES.sha256": checksums}
    created = False
    try:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(fd, "wb") as handle, zipfile.ZipFile(handle, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in entries.items():
                info = zipfile.ZipInfo(prefix + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                info.extra = b""
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(output) as archive:
            if archive.testzip() is not None or set(archive.namelist()) != {prefix + n for n in entries}:
                raise ReleaseError("ZIP CRC or membership verification failed.")
            for name, expected in entries.items():
                actual = archive.read(prefix + name)
                if actual != expected:
                    raise ReleaseError("ZIP payload changed during creation.")
                inspect_content(name, actual, markers)
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return {"version": version, "files": len(entries), "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "crc_verified": True, "allowlist_verified": True, "private_marker_count": len(markers), "privacy_scan": "passed", "credential_patterns": "passed", "output": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--private-markers", type=Path, action="append", default=[])
    args = parser.parse_args()
    try:
        print(json.dumps(build_package(args.root, args.output, args.private_markers), ensure_ascii=False, indent=2))
    except (ReleaseError, FileExistsError) as error:
        parser.exit(1, f"Release refused: {error}\n")


if __name__ == "__main__":
    main()
