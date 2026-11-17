import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("create-backup.py")
spec = importlib.util.spec_from_file_location("create_backup", SCRIPT)
copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copy)


class CreateBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.destination = self.root / "destination"
        self.dumps = self.source / "backups"
        self.dumps.mkdir(parents=True)
        (self.source / "upload").mkdir()
        (self.source / "upload" / "photo.jpg").write_bytes(b"original")
        self.destination.mkdir()
        (self.dumps / "immich-db-backup-fixture.sql.gz").write_bytes(gzip.compress(b"-- PostgreSQL database dump\n"))

    def test_same_filesystem_is_refused_before_any_copy(self):
        with self.assertRaisesRegex(ValueError, "destination_uses_source_filesystem"):
            copy.create(self.source, self.dumps, self.destination, apply=True)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_nested_original_mount_sharing_destination_is_refused_before_writing(self):
        nested = self.source / "library" / "mounted"
        nested.mkdir(parents=True)
        original = nested / "photo.jpg"
        original.write_bytes(b"nested original")
        destination, mounted, file = (path.resolve() for path in (self.destination, nested, original))
        real_stat = Path.stat
        for kind in ("directory", "file"):
            with self.subTest(kind=kind):
                def mounted_stat(path, *args, **kwargs):
                    stat = real_stat(path, *args, **kwargs)
                    canonical = Path(os.path.realpath(path))
                    shared = (canonical == mounted or mounted in canonical.parents) if kind == "directory" else canonical == file
                    device = 2 if canonical == destination or destination in canonical.parents or shared else 1
                    return SimpleNamespace(**{key: device if key == "st_dev" else getattr(stat, key)
                                              for key in dir(stat) if key.startswith("st_")})
                with patch.object(Path, "stat", mounted_stat), patch.object(copy.subprocess, "run") as run:
                    with self.assertRaisesRegex(ValueError, "destination_uses_source_filesystem"):
                        copy.create(self.source, self.dumps, self.destination)
                self.assertEqual(list(self.destination.iterdir()), [])
                run.assert_not_called()

    def test_overlapping_destination_is_refused(self):
        nested = self.source / "nested"
        nested.mkdir()
        with self.assertRaisesRegex(ValueError, "source_and_destination_overlap"):
            copy.validate_destination(self.source, self.dumps, nested)

    def test_default_plan_never_creates_a_snapshot_or_starts_rsync(self):
        # Fixture source and destination share the temporary filesystem; the production guard has its own test.
        with patch.object(copy, "validate_destination"), patch.object(copy.subprocess, "run") as run:
            result = copy.create(self.source, self.dumps, self.destination)
        self.assertEqual(result["mode"], "plan")
        self.assertEqual(result["originalFiles"], 1)
        self.assertEqual(list(self.destination.iterdir()), [])
        run.assert_not_called()

    def test_source_symlink_is_refused(self):
        (self.source / "upload" / "alias.jpg").symlink_to(self.source / "upload" / "photo.jpg")
        with patch.object(copy, "validate_destination"):
            with self.assertRaisesRegex(ValueError, "source_symlink"):
                copy.create(self.source, self.dumps, self.destination, apply=True)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_selected_folder_parent_symlink_is_refused_before_copy(self):
        (self.source / "real" / "nested").mkdir(parents=True)
        (self.source / "real" / "nested" / "photo.jpg").write_bytes(b"original")
        (self.source / "alias").symlink_to(self.source / "real", target_is_directory=True)
        with patch.object(copy, "validate_destination"):
            with self.assertRaisesRegex(ValueError, "source_symlink"):
                copy.create(self.source, self.dumps, self.destination, folders=["alias/nested"])
        self.assertEqual(list(self.destination.iterdir()), [])

    def apply_on_fixture_filesystem(self, folders):
        real_check = copy.health.check

        def same_fixture_filesystem(*args, **kwargs):
            result = real_check(*args, **kwargs)
            result["issues"] = [issue for issue in result["issues"] if issue != "replica_uses_source_filesystem"]
            result["status"] = "critical" if result["issues"] else "ok"
            return result

        with patch.object(copy, "validate_destination"), patch.object(copy.health, "check", side_effect=same_fixture_filesystem):
            return copy.create(self.source, self.dumps, self.destination, apply=True, folders=folders)

    @unittest.skipUnless(shutil.which("rsync"), "rsync is required for the actual synthetic copy")
    def test_nested_media_selection_preserves_relative_layout(self):
        nested = self.source / "library" / "nested"
        nested.mkdir(parents=True)
        (nested / "photo.jpg").write_bytes(b"nested original")
        result = self.apply_on_fixture_filesystem(["library/nested"])
        snapshot = self.destination / result["snapshotName"]
        self.assertEqual((snapshot / "library" / "nested" / "photo.jpg").read_bytes(), b"nested original")
        self.assertFalse((snapshot / "nested").exists())
        self.assertEqual(result["originalFiles"], 1)

    @unittest.skipUnless(shutil.which("rsync"), "rsync is required for the actual synthetic copy")
    def test_normalized_overlapping_selections_are_copied_and_counted_once(self):
        nested = self.source / "upload" / "nested"
        nested.mkdir()
        (nested / "other.jpg").write_bytes(b"nested")
        result = self.apply_on_fixture_filesystem(["./upload/", "upload", "upload/nested", "upload//nested/"])
        snapshot = self.destination / result["snapshotName"]
        self.assertEqual(result["originalFiles"], 2)
        self.assertEqual(result["sourceBytes"], len(b"originalnested"))
        self.assertEqual(sorted(str(path.relative_to(snapshot)) for path in snapshot.rglob("*.jpg")),
                         ["upload/nested/other.jpg", "upload/photo.jpg"])
        self.assertEqual(result["verification"]["replica"]["filesChecked"], 2)

    @unittest.skipUnless(shutil.which("rsync"), "rsync is required for the actual synthetic copy")
    def test_multiple_nested_directories_keep_distinct_parents(self):
        for parent in ("library", "profile"):
            folder = self.source / parent / "nested"
            folder.mkdir(parents=True)
            (folder / "same-name.jpg").write_bytes(parent.encode())
        result = self.apply_on_fixture_filesystem(["library/nested/", "profile/nested/"])
        snapshot = self.destination / result["snapshotName"]
        for parent in ("library", "profile"):
            self.assertEqual((snapshot / parent / "nested" / "same-name.jpg").read_bytes(), parent.encode())
        self.assertEqual(result["originalFiles"], 2)

    @unittest.skipUnless(shutil.which("rsync"), "rsync is required for the actual synthetic copy")
    def test_apply_creates_verified_versions_without_overwriting_previous_copy(self):
        # Exercise actual local rsync; only mount independence is simulated for this synthetic fixture.
        real_check = copy.health.check

        def same_fixture_filesystem(*args, **kwargs):
            result = real_check(*args, **kwargs)
            result["issues"] = [issue for issue in result["issues"] if issue != "replica_uses_source_filesystem"]
            result["status"] = "critical" if result["issues"] else "ok"
            return result

        with patch.object(copy, "validate_destination"), patch.object(copy.health, "check", side_effect=same_fixture_filesystem):
            first = copy.create(self.source, self.dumps, self.destination, apply=True)
            (self.source / "upload" / "photo.jpg").write_bytes(b"later version")
            second = copy.create(self.source, self.dumps, self.destination, apply=True)
        old = self.destination / first["snapshotName"]
        new = self.destination / second["snapshotName"]
        self.assertNotEqual(old, new)
        self.assertEqual((old / "upload" / "photo.jpg").read_bytes(), b"original")
        self.assertEqual((new / "upload" / "photo.jpg").read_bytes(), b"later version")
        self.assertEqual(json.loads((new / "VERIFIED-FILES.json").read_text())["pointInTimeConsistency"], "not-established")

    @unittest.skipUnless(shutil.which("rsync"), "rsync is required for the actual synthetic copy")
    def test_failed_verification_preserves_an_incomplete_copy(self):
        with patch.object(copy, "validate_destination"):
            with self.assertRaisesRegex(ValueError, "snapshot_verification_failed"):
                copy.create(self.source, self.dumps, self.destination, apply=True)
        snapshots = list(self.destination.iterdir())
        self.assertEqual(len(snapshots), 1)
        self.assertTrue((snapshots[0] / "INCOMPLETE").exists())
        self.assertFalse((snapshots[0] / "VERIFIED-FILES.json").exists())


if __name__ == "__main__":
    unittest.main()
