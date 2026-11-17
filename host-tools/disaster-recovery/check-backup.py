#!/usr/bin/env python3
"""Read-only checks for an Immich database dump and a mounted original-file copy."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import time
import zlib


def digest(path):
    before = path.stat()
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino, after.st_size, after.st_mtime_ns
    ):
        raise OSError("File changed while being checked")
    return value.hexdigest(), after.st_size


def database_check(directory, max_age_hours, now):
    result = {"present": False}
    issues = []
    try:
        candidates = [path for path in directory.glob("immich-db-backup-*.sql.gz")
                      if path.is_file() and not path.is_symlink()]
        if not candidates:
            return result, ["database_backup_missing"], None
        latest = max(candidates, key=lambda path: path.stat().st_mtime_ns)
        result["present"] = True
        result["ageHours"] = round((now - latest.stat().st_mtime) / 3600, 2)
        if now - latest.stat().st_mtime > max_age_hours * 3600:
            issues.append("database_backup_stale")
        if latest.stat().st_mtime > now + 300:
            issues.append("database_backup_future_timestamp")
        total = 0
        header = b""
        with gzip.open(latest, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                if not header:
                    header = chunk[:65536]
                total += len(chunk)
        result["gzipIntegrity"] = True
        result["dumpHeader"] = b"PostgreSQL database dump" in header
        result["decompressedBytes"] = total
        result["sha256"], result["compressedBytes"] = digest(latest)
        if not result["dumpHeader"]:
            issues.append("database_dump_header_missing")
        return result, issues, latest
    except (OSError, EOFError, zlib.error):
        result["gzipIntegrity"] = False
        return result, issues + ["database_backup_unreadable_or_corrupt"], None


def compare_originals(source, replica, folders):
    result = {"filesChecked": 0, "bytesChecked": 0, "missingFiles": 0,
              "mismatchedFiles": 0, "unreadableFiles": 0}
    found_root = False
    source_devices = set()

    def failed_walk(_error):
        result["unreadableFiles"] += 1

    for folder in folders:
        origin = source / folder
        if not origin.exists():
            continue
        found_root = True
        if origin.is_symlink() or not origin.is_dir():
            result["unreadableFiles"] += 1
            continue
        source_devices.add(origin.stat().st_dev)
        for parent, directories, files in os.walk(origin, onerror=failed_walk):
            source_devices.add(Path(parent).stat().st_dev)
            for name in list(directories):
                directory = Path(parent) / name
                if directory.is_symlink():
                    directories.remove(name)
                    result["unreadableFiles"] += 1
                else:
                    source_devices.add(directory.stat().st_dev)
            for name in files:
                path = Path(parent) / name
                relative = path.relative_to(source)
                other = replica / relative
                try:
                    if path.is_symlink() or any(replica.joinpath(*relative.parts[:index]).is_symlink()
                                                for index in range(1, len(relative.parts) + 1)):
                        raise OSError("Symlinks are not verified")
                    source_devices.add(path.stat().st_dev)
                    if not other.exists():
                        result["missingFiles"] += 1
                        continue
                    first, size = digest(path)
                    second, other_size = digest(other)
                    result["filesChecked"] += 1
                    result["bytesChecked"] += size
                    if first != second or size != other_size:
                        result["mismatchedFiles"] += 1
                except OSError:
                    result["unreadableFiles"] += 1
    issues = []
    if not found_root:
        issues.append("source_original_folders_missing")
    if result["missingFiles"] or result["mismatchedFiles"] or result["unreadableFiles"]:
        issues.append("original_replica_incomplete_or_changed")
    return result, issues, source_devices


def check(source, backup_dir, replica=None, max_age_hours=36, folders=("upload", "library", "profile"), now=None):
    now = time.time() if now is None else now
    database, issues, latest = database_check(backup_dir, max_age_hours, now)
    report = {"schemaVersion": 1, "checkedAt": datetime.fromtimestamp(now, timezone.utc).isoformat(),
              "scope": "database archive and current original-file comparison",
              "database": database, "replica": {"configured": replica is not None}}
    if replica is None:
        issues.append("replica_not_configured")
    else:
        try:
            source, replica = source.resolve(strict=True), replica.resolve(strict=True)
            if source == replica or source in replica.parents or replica in source.parents:
                issues.append("source_and_replica_overlap")
            else:
                files, media_issues, source_devices = compare_originals(source, replica, folders)
                source_devices.update({source.stat().st_dev, backup_dir.stat().st_dev})
                if latest is not None:
                    source_devices.add(latest.stat().st_dev)
                separate = replica.stat().st_dev not in source_devices
                report["replica"]["filesystemSeparated"] = separate
                if not separate:
                    issues.append("replica_uses_source_filesystem")
                report["replica"].update(files)
                issues.extend(media_issues)
                if latest is not None:
                    copy = replica / "backups" / latest.name
                    if copy.is_symlink() or not copy.is_file() or digest(copy)[0] != database.get("sha256"):
                        issues.append("database_replica_missing_or_changed")
        except OSError:
            issues.append("replica_or_source_unavailable")
    report["issues"] = sorted(set(issues))
    report["status"] = "critical" if issues else "ok"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--replica-root", type=Path)
    parser.add_argument("--max-age-hours", type=float, default=36)
    parser.add_argument("--media-folder", action="append", help="Relative original-file folder; repeat to replace defaults")
    args = parser.parse_args()
    folders = args.media_folder or ["upload", "library", "profile"]
    if args.max_age_hours <= 0 or any(Path(folder).is_absolute() or ".." in Path(folder).parts for folder in folders):
        parser.error("Use a positive maximum age and relative media folders without '..'")
    report = check(args.source_root, args.backup_dir, args.replica_root, args.max_age_hours, folders)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
