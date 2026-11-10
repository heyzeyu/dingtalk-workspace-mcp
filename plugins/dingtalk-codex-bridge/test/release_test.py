import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).parents[1] / "scripts/package-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "source"
        self.root.mkdir()
        meta = "plugins/dingtalk-codex-bridge/.codex-plugin/plugin.json"
        (self.root / meta).parent.mkdir(parents=True)
        (self.root / meta).write_text(json.dumps({"version": "0.0.1"}))
        (self.root / "README.md").write_text("Shareable source fixture.")
        self.names = ["release-files.json", "README.md", meta]
        self.write_manifest()

    def write_manifest(self):
        (self.root / "release-files.json").write_text(json.dumps({"format": 1, "files": self.names}))

    def test_only_allowlisted_files_enter_zip_and_metadata_is_normalized(self):
        (self.root / "private-runtime-report.json").write_text('{"private":true}')
        output = self.base / "release.zip"
        result = release.build_package(self.root, output)
        self.assertTrue(result["crc_verified"])
        with zipfile.ZipFile(output) as z:
            self.assertEqual(len(z.namelist()), len(self.names) + 1)
            self.assertFalse(any("private-runtime" in n for n in z.namelist()))
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) and not i.extra for i in z.infolist()))

    def test_private_markers_stop_build_without_echoing_the_value(self):
        private = "PRIVATE_OWNER_CANARY_78349"
        (self.root / "README.md").write_text(private)
        markers = self.base / "markers.json"
        markers.write_text(json.dumps([private]))
        with self.assertRaises(release.ReleaseError) as caught:
            release.build_package(self.root, self.base / "refused.zip", [markers])
        self.assertNotIn(private, str(caught.exception))
        self.assertFalse((self.base / "refused.zip").exists())

    def test_symlink_and_path_escape_are_rejected(self):
        outside = self.base / "outside.txt"
        outside.write_text("private")
        (self.root / "README.md").unlink()
        (self.root / "README.md").symlink_to(outside)
        with self.assertRaises(release.ReleaseError):
            release.collect_files(self.root)
        for path in ["../outside.txt", "/absolute.txt", "x/../README.md", "x\\README.md"]:
            with self.assertRaises(release.ReleaseError):
                release.portable_path(path)

    def test_runtime_and_credential_files_cannot_be_allowlisted(self):
        for path in [".env", "cache/.env.local", "node_modules/a.js", "runtime.log", "state.db", "data.xlsx", "__pycache__/x.pyc"]:
            with self.assertRaises(release.ReleaseError):
                release.portable_path(path)

    def test_recognizable_credentials_are_rejected(self):
        key = ("-----BEGIN " + "PRIVATE KEY-----").encode()
        token = ("ghp_" + "A" * 36).encode()
        assignment = ('client_secret="' + "Z" * 32 + '"').encode()
        for value in [key, token, assignment]:
            with self.assertRaises(release.ReleaseError):
                release.inspect_content("fixture.txt", value, ())

    def test_existing_archive_is_not_overwritten(self):
        output = self.base / "existing.zip"
        output.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            release.build_package(self.root, output)
        self.assertEqual(output.read_bytes(), b"existing")

    def test_public_logo_is_included_unchanged_and_other_binary_data_is_rejected(self):
        name = "plugins/dingtalk-codex-bridge/assets/dingtalk.png"
        official = (Path(__file__).parents[1] / "assets/dingtalk.png").read_bytes()
        target = self.root / name
        target.parent.mkdir(parents=True)
        target.write_bytes(official)
        self.names.append(name)
        self.write_manifest()
        output = self.base / "with-logo.zip"
        release.build_package(self.root, output)
        with zipfile.ZipFile(output) as z:
            self.assertEqual(z.read("dingtalk-codex-bridge-0.0.1/" + name), official)
        for content in [b"", official + b"private appended content"]:
            with self.assertRaises(release.ReleaseError):
                release.inspect_content(name, content, ())
        with self.assertRaises(release.ReleaseError):
            release.inspect_content("assets/other.png", official, ())
        with self.assertRaises(release.ReleaseError):
            release.inspect_content(name, official, (b"dingtalk.png",))

    def test_marker_file_is_excluded_even_when_empty_and_allowlisted(self):
        marker_file = self.root / "markers.json"
        marker_file.write_text("[]")
        self.names.append("markers.json")
        self.write_manifest()
        with self.assertRaises(release.ReleaseError):
            release.build_package(self.root, self.base / "refused.zip", [marker_file])

    def test_escaped_markers_are_detected_without_echoing_private_filenames(self):
        private = "私有"
        marker = private.encode("utf-8")
        marker_file = self.base / "short-chinese-markers.json"
        marker_file.write_text(json.dumps([private]))
        self.assertIn(marker, release.private_markers([marker_file]))
        escaped = json.dumps({"name": private}, ensure_ascii=True).encode("utf-8")
        for name, content in [("safe.json", escaped), (f"docs/{private}.md", b"source")]:
            with self.assertRaises(release.ReleaseError) as caught:
                release.inspect_content(name, content, (marker,))
            self.assertNotIn(private, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
