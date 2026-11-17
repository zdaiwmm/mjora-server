import gzip
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


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
