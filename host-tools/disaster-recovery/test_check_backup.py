import gzip
from contextlib import contextmanager, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("check-backup.py")
spec = importlib.util.spec_from_file_location("check_backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.replica = self.root / "replica"
        self.dumps = self.source / "backups"
        self.dumps.mkdir(parents=True)
        (self.source / "upload").mkdir()
        (self.replica / "upload").mkdir(parents=True)
        (self.replica / "backups").mkdir()
        self.photo = self.source / "upload" / "private-name.jpg"
        self.photo.write_bytes(b"original bytes")
        (self.replica / "upload" / self.photo.name).write_bytes(self.photo.read_bytes())
        self.dump = self.dumps / "immich-db-backup-fixture.sql.gz"
        self.dump.write_bytes(gzip.compress(b"-- PostgreSQL database dump\nCREATE TABLE fixture(id int);\n"))
        self.copy_dump()

    def copy_dump(self):
        (self.replica / "backups" / self.dump.name).write_bytes(self.dump.read_bytes())

    def check(self, replica=True):
        return backup.check(self.source, self.dumps, self.replica if replica else None)

    @contextmanager
    def independent_replica(self, source_mounts=()):
        """Model device numbers only; paths, file contents and symlinks are real."""
        replica = self.replica.resolve()
        source_mounts = tuple(path.resolve() for path in source_mounts)
        real_stat = Path.stat

        def mounted_stat(path, *args, **kwargs):
            value = real_stat(path, *args, **kwargs)
            lexical = Path(os.path.abspath(path))
            canonical = Path(os.path.realpath(path))
            on_replica = canonical == replica or replica in canonical.parents
            on_source = any(lexical == mount or mount in lexical.parents for mount in source_mounts)
            device = 2 if on_replica and not on_source else 1
            return SimpleNamespace(**{key: device if key == "st_dev" else getattr(value, key)
                                      for key in dir(value) if key.startswith("st_")})

        with patch.object(Path, "stat", mounted_stat):
            yield

    def test_independent_replica_with_all_files_verified_is_ok(self):
        with self.independent_replica():
            result = self.check()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["issues"], [])
        self.assertTrue(result["replica"]["filesystemSeparated"])

    def test_nested_replica_directory_and_file_on_source_filesystem_are_critical(self):
        for mount in (self.replica / "upload", self.replica / "upload" / self.photo.name):
            with self.subTest(mount=mount.name), self.independent_replica([mount]):
                result = self.check()
            self.assertEqual(result["status"], "critical")
            self.assertFalse(result["replica"]["filesystemSeparated"])
            self.assertIn("replica_uses_source_filesystem", result["issues"])

    def test_empty_replica_directory_on_source_filesystem_is_critical(self):
        (self.source / "upload" / "empty").mkdir()
        other = self.replica / "upload" / "empty"
        other.mkdir()
        with self.independent_replica([other]):
            result = self.check()
        self.assertEqual(result["status"], "critical")
        self.assertFalse(result["replica"]["filesystemSeparated"])

    def test_database_replica_file_on_source_filesystem_is_critical(self):
        other = self.replica / "backups" / self.dump.name
        with self.independent_replica([other]):
            result = self.check()
        self.assertEqual(result["status"], "critical")
        self.assertFalse(result["replica"]["filesystemSeparated"])
        self.assertIn("replica_uses_source_filesystem", result["issues"])

    def test_database_parent_symlink_is_rejected_by_cli(self):
        other = self.replica / "backups"
        (other / self.dump.name).unlink()
        other.rmdir()
        other.symlink_to(self.dumps, target_is_directory=True)
        output = io.StringIO()
        argv = [str(SCRIPT), "--source-root", str(self.source), "--backup-dir", str(self.dumps),
                "--replica-root", str(self.replica)]
        with self.independent_replica(), patch.object(sys, "argv", argv), redirect_stdout(output):
            code = backup.main()
        result = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "critical")
        self.assertIn("database_replica_missing_or_changed", result["issues"])
        self.assertFalse(result["replica"]["filesystemSeparated"])
        self.assertNotIn(str(self.source), output.getvalue())

    def test_unreadable_replica_cannot_report_separation_verified(self):
        other = (self.replica / "upload" / self.photo.name).resolve()
        real_digest = backup.digest

        def unreadable(path, *args, **kwargs):
            if path == other:
                raise PermissionError("synthetic denial")
            return real_digest(path, *args, **kwargs)

        with self.independent_replica(), patch.object(backup, "digest", side_effect=unreadable):
            result = self.check()
        self.assertEqual(result["status"], "critical")
        self.assertIn("original_replica_incomplete_or_changed", result["issues"])
        self.assertFalse(result["replica"]["filesystemSeparated"])

    def test_digest_rejects_filesystem_change_during_read(self):
        real_stat = Path.stat
        calls = 0

        def changed_device(path, *args, **kwargs):
            nonlocal calls
            value = real_stat(path, *args, **kwargs)
            calls += 1
            return SimpleNamespace(**{key: calls if key == "st_dev" else getattr(value, key)
                                      for key in dir(value) if key.startswith("st_")})

        with patch.object(Path, "stat", changed_device):
            with self.assertRaises(OSError):
                backup.digest(self.photo)

    def test_replica_mount_change_before_hashing_is_not_missed(self):
        other = (self.replica / "upload" / self.photo.name).resolve()
        transfer_started = False
        real_digest = backup.digest
        with self.independent_replica():
            model_stat = Path.stat

            def changed_mount(path, *args, **kwargs):
                value = model_stat(path, *args, **kwargs)
                if Path(path) == other and transfer_started:
                    return SimpleNamespace(**{key: 1 if key == "st_dev" else getattr(value, key)
                                              for key in dir(value) if key.startswith("st_")})
                return value

            def digest_after_mount_change(path, *args, **kwargs):
                nonlocal transfer_started
                if path == other:
                    transfer_started = True
                return real_digest(path, *args, **kwargs)

            with patch.object(Path, "stat", changed_mount), patch.object(backup, "digest", side_effect=digest_after_mount_change):
                result = self.check()
        self.assertEqual(result["status"], "critical")
        self.assertFalse(result["replica"]["filesystemSeparated"])
        self.assertIn("replica_uses_source_filesystem", result["issues"])

    def test_database_alone_never_reports_complete_protection(self):
        result = self.check(replica=False)
        self.assertEqual(result["status"], "critical")
        self.assertTrue(result["database"]["gzipIntegrity"])
        self.assertEqual(result["issues"], ["replica_not_configured"])

    def test_matching_copy_on_same_filesystem_remains_critical(self):
        result = self.check()
        self.assertEqual(result["issues"], ["replica_uses_source_filesystem"])
        self.assertEqual(result["replica"]["filesChecked"], 1)
        self.assertEqual(result["replica"]["mismatchedFiles"], 0)

    def test_nested_original_mount_sharing_replica_filesystem_is_critical(self):
        nested = self.source / "library" / "mounted"
        nested.mkdir(parents=True)
        original = nested / "photo.jpg"
        original.write_bytes(b"nested original")
        other = self.replica / "library" / "mounted" / original.name
        other.parent.mkdir(parents=True)
        other.write_bytes(original.read_bytes())
        replica, mounted, file = (path.resolve() for path in (self.replica, nested, original))
        real_stat = Path.stat
        for kind in ("directory", "file"):
            with self.subTest(kind=kind):
                def mounted_stat(path, *args, **kwargs):
                    stat = real_stat(path, *args, **kwargs)
                    canonical = Path(os.path.realpath(path))
                    shared = (canonical == mounted or mounted in canonical.parents) if kind == "directory" else canonical == file
                    device = 2 if canonical == replica or replica in canonical.parents or shared else 1
                    return SimpleNamespace(**{key: device if key == "st_dev" else getattr(stat, key)
                                              for key in dir(stat) if key.startswith("st_")})
                with patch.object(Path, "stat", mounted_stat):
                    result = self.check()
                self.assertFalse(result["replica"]["filesystemSeparated"])
                self.assertEqual(result["issues"], ["replica_uses_source_filesystem"])

    def test_stale_dump_is_detected(self):
        timestamp = time.time() - 48 * 3600
        os.utime(self.dump, (timestamp, timestamp))
        self.assertIn("database_backup_stale", self.check()["issues"])

    def test_future_dump_timestamp_is_detected(self):
        timestamp = time.time() + 3600
        os.utime(self.dump, (timestamp, timestamp))
        self.assertIn("database_backup_future_timestamp", self.check()["issues"])

    def test_corrupt_or_truncated_gzip_is_detected(self):
        self.dump.write_bytes(self.dump.read_bytes()[:-5])
        result = self.check()
        self.assertIn("database_backup_unreadable_or_corrupt", result["issues"])
        self.assertFalse(result["database"]["gzipIntegrity"])

    def test_arbitrary_gzip_is_not_a_database_dump(self):
        self.dump.write_bytes(gzip.compress(b"unrelated archive"))
        self.assertIn("database_dump_header_missing", self.check()["issues"])

    def test_same_size_file_corruption_is_detected(self):
        (self.replica / "upload" / self.photo.name).write_bytes(b"modified bytes")
        result = self.check()
        self.assertEqual(result["replica"]["mismatchedFiles"], 1)
        self.assertIn("original_replica_incomplete_or_changed", result["issues"])

    def test_missing_original_and_database_copy_are_detected(self):
        (self.replica / "upload" / self.photo.name).unlink()
        (self.replica / "backups" / self.dump.name).unlink()
        result = self.check()
        self.assertEqual(result["replica"]["missingFiles"], 1)
        self.assertIn("database_replica_missing_or_changed", result["issues"])

    def test_replica_symlink_is_not_treated_as_a_copy(self):
        other = self.replica / "upload" / self.photo.name
        other.unlink()
        other.symlink_to(self.photo)
        result = self.check()
        self.assertEqual(result["replica"]["unreadableFiles"], 1)
        self.assertIn("original_replica_incomplete_or_changed", result["issues"])

    def test_source_and_replica_must_not_overlap(self):
        result = backup.check(self.source, self.dumps, self.source)
        self.assertIn("source_and_replica_overlap", result["issues"])

    def test_cli_returns_monitorable_failure_without_private_names(self):
        process = subprocess.run([sys.executable, str(SCRIPT), "--source-root", str(self.source),
                                  "--backup-dir", str(self.dumps)], capture_output=True, text=True)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)["status"], "critical")
        self.assertNotIn(str(self.source), process.stdout)
        self.assertNotIn(self.photo.name, process.stdout)


if __name__ == "__main__":
    unittest.main()
