"""Capture and verify a private backup of a Compose deployment's configuration."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


MANIFEST = 'manifest.json'
MAX_BYTES = 16 * 1024 * 1024
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}')
CONTAINER_ID = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')


class SnapshotError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise SnapshotError(message)


def inspect_container(name):
    try:
        result = subprocess.run(
            ['docker', 'inspect', '--type', 'container', '--', name],
            capture_output=True, check=True, timeout=30,
        )
        [container] = json.loads(result.stdout)
        labels = container['Config']['Labels']
        identity = {
            'id': container['Id'],
            'image': container['Image'],
            'project': labels['com.docker.compose.project'],
            'service': labels['com.docker.compose.service'],
            'composeFiles': labels['com.docker.compose.project.config_files'].split(','),
        }
        require(container['State']['Running'] is True, 'baseline container is not running')
        require(CONTAINER_ID.fullmatch(identity['id']), 'invalid baseline container ID')
        require(identity['project'] and identity['service'], 'missing Compose project or service')
        return identity
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        raise SnapshotError('could not read the running Compose container and its file list') from None


def read_regular(path, *, private=False):
    flags = os.O_RDONLY | os.O_NONBLOCK
    if private:
        flags |= os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags), 'rb') as handle:
        before = os.fstat(handle.fileno())
        require(stat.S_ISREG(before.st_mode), f'not a regular configuration file: {path}')
        if private:
            require(before.st_uid == os.geteuid() and stat.S_IMODE(before.st_mode) == 0o600,
                    f'backup file must have private ownership and mode 0600: {path}')
        require(before.st_size <= MAX_BYTES, f'configuration file exceeds size limit: {path}')
        data = handle.read(MAX_BYTES + 1)
        after = path.stat()
        require(len(data) == before.st_size and (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns
        ) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                f'configuration file changed while being read: {path}')
    return data


def write_private(path, data):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    with os.fdopen(os.open(path, flags, 0o600), 'wb') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def check_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700,
            f'backup directory must be owned by the operator and have mode 0700: {path}')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inventory(args, inspect):
    require(IMAGE_ID.fullmatch(args.expected_image), '--expected-image must be the old image ID (sha256:...)')
    require(REVISION.fullmatch(args.candidate_sha), '--candidate-sha must be the full server Git SHA')
    require(args.env_file, 'declare all effective env files with --env-file')
    container = inspect(args.container)
    require(container['image'] == args.expected_image, 'running image does not match the expected old image')
    require(container['composeFiles'], 'the live container has no Compose configuration file list')
    paths = []
    for value in [*container['composeFiles'], *args.env_file, *args.config_file]:
        path = Path(value)
        require(path.is_absolute(), f'configuration path must be absolute: {value}')
        if path not in paths:
            paths.append(path)
    return container, paths


def read_config_inventory(paths):
    return [read_regular(path) for path in paths]


def capture(args, inspect=inspect_container):
    container, paths = inventory(args, inspect)
    contents = read_config_inventory(paths)
    check_directory(args.snapshot.parent)
    args.snapshot.mkdir(mode=0o700)
    check_directory(args.snapshot)

    files = []
    for index, (path, data) in enumerate(zip(paths, contents), start=1):
        name = f'config-{index:03}.backup'
        output = args.snapshot / name
        write_private(output, data)
        require(digest(read_regular(output, private=True)) == digest(data), f'backup verification failed: {path}')
        files.append({'source': str(path), 'backup': name, 'bytes': len(data), 'sha256': digest(data)})

    current_container, current_paths = inventory(args, inspect)
    require((container, paths) == (current_container, current_paths), 'baseline container or Compose files changed')
    require(contents == read_config_inventory(paths), 'live configuration changed during backup')
    manifest = {
        'schema': 1,
        'phase': 'PRE_DEPLOY',
        'capturedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'candidateSha': args.candidate_sha,
        'container': container,
        'files': files,
    }
    write_private(args.snapshot / MANIFEST, (json.dumps(manifest, indent=2) + '\n').encode())
    sync_directory(args.snapshot)
    sync_directory(args.snapshot.parent)
    return len(files)


def check(args, inspect=inspect_container):
    check_directory(args.snapshot.parent)
    check_directory(args.snapshot)
    manifest = json.loads(read_regular(args.snapshot / MANIFEST, private=True))
    require(manifest['schema'] == 1 and manifest['phase'] == 'PRE_DEPLOY', 'not a pre-deploy configuration snapshot')
    require(manifest['candidateSha'] == args.candidate_sha, 'snapshot belongs to a different candidate')
    container, paths = inventory(args, inspect)
    require(manifest['container'] == container, 'running container or Compose files changed since capture')
    require([entry['source'] for entry in manifest['files']] == [str(path) for path in paths],
            'declared configuration inventory differs from the snapshot')
    for index, (entry, path) in enumerate(zip(manifest['files'], paths), start=1):
        name = f'config-{index:03}.backup'
        require(entry['backup'] == name, 'unexpected backup filename')
        saved = read_regular(args.snapshot / name, private=True)
        require(len(saved) == entry['bytes'] and digest(saved) == entry['sha256'], f'backup is incomplete: {path}')
        require(digest(read_regular(path)) == entry['sha256'], f'live configuration changed: {path}')
    require(inventory(args, inspect) == (container, paths), 'baseline container or Compose files changed during check')
    return len(paths)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('capture', 'check'))
    parser.add_argument('--container', required=True, help='name or ID of the running baseline service container')
    parser.add_argument('--expected-image', required=True, help='old local image ID from the rollout record')
    parser.add_argument('--candidate-sha', required=True, help='full Git SHA of the release candidate')
    parser.add_argument('--env-file', required=True, action='append', help='effective env file; repeat as needed')
    parser.add_argument('--config-file', default=[], action='append', help='additional config file; repeat as needed')
    parser.add_argument('--snapshot', required=True, type=Path, help='new snapshot directory under a private parent')
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, 'run on the deployment host as root')
        require(args.snapshot.is_absolute(), '--snapshot must be an absolute host-local path')
        os.umask(0o077)
        count = (capture if args.action == 'capture' else check)(args)
    except (OSError, SnapshotError, ValueError, KeyError, TypeError) as error:
        print(f'Pre-deploy configuration gate failed: {error}', file=sys.stderr)
        return 1
    print(f'PRE_DEPLOY {args.action}: {count} configuration files verified for {args.candidate_sha}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
