#!/usr/bin/env python3
"""Plan, then optionally copy a new versioned backup onto a separate mounted filesystem."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid


spec = importlib.util.spec_from_file_location("check_backup", Path(__file__).with_name("check-backup.py"))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


def validate_destination(source, backup_dir, destination):
    for origin in (source, backup_dir):
        if origin == destination or origin in destination.parents or destination in origin.parents:
            raise ValueError("source_and_destination_overlap")
        if origin.stat().st_dev == destination.stat().st_dev:
            raise ValueError("destination_uses_source_filesystem")
    if not source.is_dir() or not backup_dir.is_dir() or not destination.is_dir():
        raise ValueError("source_or_destination_is_not_a_directory")


def create(source, backup_dir, destination, apply=False, max_age_hours=36, folders=("upload", "library", "profile")):
    source, backup_dir, destination = (path.resolve(strict=True) for path in (source, backup_dir, destination))
    validate_destination(source, backup_dir, destination)
    database, issues, latest = health.database_check(backup_dir, max_age_hours, datetime.now().timestamp())
    if issues:
        raise ValueError(",".join(issues))
    selected = [folder for folder in folders if (source / folder).is_dir()]
    if not selected:
        raise ValueError("source_original_folders_missing")
    count = total = 0

    def failed_walk(error):
        raise error

    for folder in selected:
        if (source / folder).is_symlink():
            raise ValueError("source_symlink_requires_explicit_mapping")
        for parent, directories, files in os.walk(source / folder, onerror=failed_walk):
            for name in [*directories, *files]:
                if (Path(parent) / name).is_symlink():
                    raise ValueError("source_symlink_requires_explicit_mapping")
            for name in files:
                total += (Path(parent) / name).stat().st_size
                count += 1
    if shutil.disk_usage(destination).free < total + database["compressedBytes"] + 64 * 1024 * 1024:
        raise ValueError("insufficient_destination_space")
    result = {"mode": "apply" if apply else "plan", "originalFiles": count,
              "sourceBytes": total, "databaseBytes": database["compressedBytes"],
              "newVersionedSnapshot": True, "existingVersionsModified": False,
              "pointInTimeConsistency": "not-established"}
    if not apply:
        return result
    if shutil.which("rsync") is None:
        raise ValueError("rsync_not_installed")
    snapshot = destination / ("mjora-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12])
    snapshot.mkdir(mode=0o700)
    (snapshot / "backups").mkdir(mode=0o700)
    result["snapshotName"] = snapshot.name
    try:
        commands = [(["rsync", "--archive", "--ignore-existing", "--", *["./" + folder for folder in selected], str(snapshot) + "/"], source),
                    (["rsync", "--archive", "--ignore-existing", "--", str(latest), str(snapshot / "backups") + "/"], None)]
        for command, cwd in commands:
            process = subprocess.run(command, cwd=cwd, capture_output=True, timeout=24 * 3600)
            if process.returncode:
                raise ValueError("rsync_copy_failed")
        verified = health.check(source, backup_dir, snapshot, max_age_hours, folders)
        result["verification"] = verified
        if verified["status"] != "ok":
            raise ValueError("snapshot_verification_failed:" + ",".join(verified["issues"]))
        # This records file verification, not a successful application restore or an atomic DB/media snapshot.
        (snapshot / "VERIFIED-FILES.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return result
    except (OSError, ValueError, subprocess.TimeoutExpired):
        (snapshot / "INCOMPLETE").touch(mode=0o600)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Create a new snapshot; default only reports the plan")
    parser.add_argument("--max-age-hours", type=float, default=36)
    parser.add_argument("--media-folder", action="append")
    args = parser.parse_args()
    folders = args.media_folder or ["upload", "library", "profile"]
    if args.max_age_hours <= 0 or any(Path(folder).is_absolute() or ".." in Path(folder).parts or folder in {"", "."} for folder in folders):
        parser.error("Use a positive maximum age and relative media folders without '..'")
    os.umask(0o077)
    try:
        result = create(args.source_root, args.backup_dir, args.destination, args.apply, args.max_age_hours, folders)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        # Do not put original filenames or infrastructure paths into monitoring output.
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({"status": "critical", "reason": reason}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
