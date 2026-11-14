#!/usr/bin/env python3
"""Authenticated, confirmation-only HTTPS host for one privately prepared iOS app."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import plistlib
import re
import signal
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import uuid

UTC = dt.timezone.utc
MAX_BODY = 2048
CONFIRMATION_LIFETIME = dt.timedelta(minutes=10)
CODES = {'needsPhone', 'needsUnlock', 'signInRequired', 'invalidPackage', 'busy', 'failed', 'invalidConfig'}
RETRYABLE = {'needsPhone', 'needsUnlock', 'busy'}
METADATA = ('releaseId', 'version', 'build', 'notes')
LOG = logging.getLogger('confirmed-update-host')


class UpdateError(Exception):
    """Only predefined, non-sensitive message codes cross an API/log boundary."""
    def __init__(self, code):
        self.code = code if code in CODES else 'failed'
        super().__init__(self.code)


def parse_time(value):
    value = dt.datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))


def read_json(path):
    return strict_json(Path(path).read_bytes())


def atomic_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(json_bytes(value) + b'\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def private_dir(path):
    path = Path(path).expanduser()
    if path.is_symlink():
        raise UpdateError('invalidConfig')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
        raise UpdateError('invalidConfig')
    path.chmod(0o700)
    return path


def private_file(path):
    path = Path(path).expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise UpdateError('invalidConfig')
    return path


def target_identity_sha256(config):
    """Bind the manifest to the fixed enrollment target without publishing its values."""
    keys = ('teamId', 'deviceUDID', 'mainBundleId', 'shareBundleId', 'appGroup')
    return hashlib.sha256(json_bytes({key: config[key] for key in keys})).hexdigest()


def _tree_fingerprint(root, source=False):
    root = Path(root).expanduser()
    if root.is_symlink() or not root.is_dir():
        raise UpdateError('invalidPackage')
    root, digest = root.resolve(), hashlib.sha256()
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if source:
            # Keep byte-for-byte compatibility with the native renewal helper's fingerprint().
            generated = {'xcuserdata', '.swiftpm', '.build', 'DerivedData', 'build'}
            pinned = path.name == 'Package.resolved' or path.suffix in ('.xcscheme', '.xcconfig', '.xcsettings')
            workspace = any(part.endswith('.xcworkspace') for part in relative.parts)
            if '.git' in relative.parts or (not pinned and (generated.intersection(relative.parts) or workspace or path.name == '.DS_Store')):
                continue
        if path.is_symlink():
            raise UpdateError('invalidPackage')
        mode = path.stat().st_mode
        if stat.S_ISREG(mode):
            digest.update(str(relative).encode() + b'\0')
            with path.open('rb') as input_file:
                for chunk in iter(lambda: input_file.read(1024 * 1024), b''):
                    digest.update(chunk)
            digest.update(b'\0')
        elif not stat.S_ISDIR(mode):
            raise UpdateError('invalidPackage')
    return digest.hexdigest()


def tree_sha256(root):
    """SHA256(sorted relative UTF-8 path + NUL + file bytes + NUL); no symlinks."""
    return _tree_fingerprint(root)


def source_fingerprint(root):
    return _tree_fingerprint(root, source=True)


def _hex_digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def version_key(version, build):
    def components(value, maximum):
        if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,' + str(maximum - 1) + '}', value):
            raise UpdateError('invalidPackage')
        numbers = tuple(int(number) for number in value.split('.'))
        return numbers + (0,) * (maximum - len(numbers))
    return components(version, 4), components(build, 3)


def load_config(path):
    try:
        cfg = read_json(private_file(path))
        required = {'schemaVersion', 'hostId', 'listenHost', 'listenPort', 'certificatePath', 'privateKeyPath',
                    'accessTokenPath', 'manifestPath', 'stateDir', 'renewalConfigPath', 'teamId', 'deviceUDID',
                    'mainBundleId', 'shareBundleId', 'appGroup', 'approvedEnrollmentSHA256'}
        if not isinstance(cfg, dict) or set(cfg) != required or type(cfg['schemaVersion']) is not int or cfg['schemaVersion'] != 1:
            raise ValueError()
        if type(cfg['listenPort']) is not int or not 1024 <= cfg['listenPort'] <= 65535:
            raise ValueError()
        for key in required - {'schemaVersion', 'listenPort'}:
            if not isinstance(cfg[key], str) or not cfg[key] or len(cfg[key]) > 4096 or any(ord(c) < 32 for c in cfg[key]):
                raise ValueError()
        for key in ['certificatePath', 'privateKeyPath', 'accessTokenPath', 'manifestPath', 'stateDir', 'renewalConfigPath']:
            if not Path(cfg[key]).is_absolute():
                raise ValueError()
        if not _hex_digest(cfg['approvedEnrollmentSHA256']) or cfg['mainBundleId'] == cfg['shareBundleId']:
            raise ValueError()
        _read_token(cfg)
        renewal = read_json(private_file(cfg['renewalConfigPath']))
        if not Path(renewal['state_dir']).expanduser().is_absolute():
            raise ValueError()
        return cfg
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise UpdateError('invalidConfig') from None


def _read_token(cfg):
    token = private_file(cfg['accessTokenPath']).read_text().strip()
    if not re.fullmatch(r'[\x21-\x7e]{32,256}', token):
        raise UpdateError('invalidConfig')
    return token.encode('ascii')


class ToolRunner:
    """Fixed argv only; output is never logged or returned through HTTP."""
    def __call__(self, argv, timeout=60):
        try:
            child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                stdout, stderr = child.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
                raise UpdateError('needsPhone' if argv[0] == '/usr/bin/xcrun' else 'invalidPackage') from None
        except OSError:
            raise UpdateError('signInRequired' if argv[0] == '/usr/bin/security' else 'failed') from None
        if child.returncode:
            diagnostic = (stdout + stderr).lower()
            if b'locked' in diagnostic or b'unlock' in diagnostic:
                code = 'needsUnlock'
            elif b'expired' in diagnostic or b'identity' in diagnostic or b'sign in' in diagnostic:
                code = 'signInRequired'
            elif argv[0] == '/usr/bin/xcrun' and 'install' not in argv:
                code = 'needsPhone'
            else:
                code = 'invalidPackage' if argv[0] != '/usr/bin/xcrun' else 'failed'
            raise UpdateError(code)
        return stdout


class Installer:
    def __init__(self, config, run=None, now=None):
        self.cfg = config
        self.run = run or ToolRunner()
        self.now = now or (lambda: dt.datetime.now(UTC))
        self.renewal_path = Path(config['renewalConfigPath'])
        self.state = private_dir(read_json(self.renewal_path)['state_dir'])
        self.bundles = (config['mainBundleId'], config['shareBundleId'])

    @contextlib.contextmanager
    def renewal_lock(self):
        with (self.state / 'run.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UpdateError('busy') from None
            yield

    def confirmable(self, manifest):
        with self.renewal_lock():
            return self.validate(manifest)

    def _baseline(self):
        receipt = self.state / 'success.json'
        renewal = read_json(self.renewal_path)
        values = ({key: value['expires'] for key, value in read_json(receipt)['profiles'].items()}
                  if receipt.exists() else renewal['baseline_expirations'])
        if set(values) != set(self.bundles):
            raise UpdateError('invalidPackage')
        return {bundle: parse_time(value) for bundle, value in values.items()}

    def _entitlements(self, entitlements, bundle):
        if (entitlements.get('application-identifier') != self.cfg['teamId'] + '.' + bundle
                or entitlements.get('com.apple.developer.team-identifier') != self.cfg['teamId']
                or entitlements.get('com.apple.security.application-groups') != [self.cfg['appGroup']]
                or 'com.apple.developer.networking.wifi-info' in entitlements):
            raise UpdateError('invalidPackage')

    def validate(self, manifest):
        try:
            required = {'schemaVersion', 'releaseId', 'version', 'build', 'notes', 'appPath', 'appSHA256',
                        'sourceRevision', 'sourceRoot', 'sourceSHA256', 'enrollmentSHA256', 'targetIdentitySHA256'}
            if not isinstance(manifest, dict) or set(manifest) != required or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != 1:
                raise UpdateError('invalidPackage')
            for key in required - {'schemaVersion'}:
                if not isinstance(manifest[key], str):
                    raise UpdateError('invalidPackage')
            if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', manifest['releaseId'])
                    or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', manifest['version']) or len(manifest['version']) > 64
                    or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', manifest['build']) or len(manifest['build']) > 64
                    or len(manifest['notes']) > 4096
                    or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', manifest['sourceRevision'])):
                raise UpdateError('invalidPackage')
            for key in ['appSHA256', 'sourceSHA256', 'enrollmentSHA256', 'targetIdentitySHA256']:
                if not _hex_digest(manifest[key]):
                    raise UpdateError('invalidPackage')
            app, source = Path(manifest['appPath']), Path(manifest['sourceRoot'])
            if (not app.is_absolute() or not source.is_absolute() or app.suffix != '.app'
                    or manifest['targetIdentitySHA256'] != target_identity_sha256(self.cfg)
                    or tree_sha256(app) != manifest['appSHA256'] or source_fingerprint(source) != manifest['sourceSHA256']
                    or manifest['enrollmentSHA256'] != self.cfg['approvedEnrollmentSHA256']
                    or hashlib.sha256((app / 'LocalServerIdentity.json').read_bytes()).hexdigest() != manifest['enrollmentSHA256']):
                raise UpdateError('invalidPackage')
            renewal = read_json(self.renewal_path)
            project = (source / renewal['project']).resolve()
            if not project.is_relative_to(source.resolve()) or not project.exists():
                raise UpdateError('invalidPackage')
            extensions = sorted((app / 'PlugIns').glob('*.appex'))
            if len(extensions) != 1:
                raise UpdateError('invalidPackage')
            profiles, previous = {}, self._baseline()
            if not re.fullmatch(r'[A-Z0-9]{6,20}', self.cfg['teamId']):
                raise UpdateError('invalidPackage')
            requirement = '=anchor apple generic and certificate leaf[subject.OU] = "' + self.cfg['teamId'] + '"'
            for path, bundle in zip([app, extensions[0]], self.bundles):
                self.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--test-requirement', requirement, str(path)])
                info = plistlib.loads((path / 'Info.plist').read_bytes())
                if (info.get('CFBundleIdentifier') != bundle or info.get('CFBundleShortVersionString') != manifest['version']
                        or info.get('CFBundleVersion') != manifest['build']
                        or (bundle == self.bundles[0] and info.get('MJoraSourceRevision') != manifest['sourceRevision'])):
                    raise UpdateError('invalidPackage')
                profile = plistlib.loads(self.run(['/usr/bin/security', 'cms', '-D', '-i', str(path / 'embedded.mobileprovision')]))
                self._entitlements(profile.get('Entitlements', {}), bundle)
                if (profile.get('TeamIdentifier') != [self.cfg['teamId']] or self.cfg['deviceUDID'] not in profile.get('ProvisionedDevices', [])
                        or not isinstance(profile.get('UUID'), str) or not profile['UUID'] or not profile.get('ExpirationDate')):
                    raise UpdateError('invalidPackage')
                expires = parse_time(profile['ExpirationDate'])
                if expires <= self.now():
                    raise UpdateError('signInRequired')
                if expires < previous[bundle]:
                    raise UpdateError('invalidPackage')
                signed = plistlib.loads(self.run(['/usr/bin/codesign', '-d', '--entitlements', ':-', '--xml', str(path)]))
                self._entitlements(signed, bundle)
                if signed.get('get-task-allow', False) != profile['Entitlements'].get('get-task-allow', False):
                    raise UpdateError('invalidPackage')
                profiles[bundle] = {'uuid': profile['UUID'], 'expires': expires.isoformat()}
            return profiles
        except (OSError, ValueError, KeyError, TypeError, AttributeError, plistlib.InvalidFileException):
            raise UpdateError('invalidPackage') from None

    def _phone(self):
        with tempfile.TemporaryDirectory(prefix='phone-', dir=self.state) as temporary:
            devices = Path(temporary) / 'devices.json'
            self.run(['/usr/bin/xcrun', 'devicectl', 'list', 'devices', '--timeout', '30', '--json-output', str(devices)], timeout=45)
            matching = [d for d in read_json(devices)['result']['devices'] if d.get('hardwareProperties', {}).get('udid') == self.cfg['deviceUDID']]
            if len(matching) != 1:
                raise UpdateError('needsPhone')
            connection = matching[0].get('connectionProperties', {})
            if connection.get('transportType') not in {'localNetwork', 'wired'}:
                raise UpdateError('needsPhone')
            apps = Path(temporary) / 'apps.json'
            self.run(['/usr/bin/xcrun', 'devicectl', 'device', 'info', 'apps', '--device', self.cfg['deviceUDID'],
                      '--bundle-id', self.bundles[0], '--timeout', '30', '--json-output', str(apps)], timeout=45)
            matching = [app for app in read_json(apps)['result']['apps'] if app.get('bundleIdentifier') == self.bundles[0]]
            if len(matching) != 1:
                raise UpdateError('invalidPackage')  # Never perform an initial installation.
            return matching[0], {'transport': connection['transportType'], 'tunnel_state': connection.get('tunnelState', 'unknown')}

    def install(self, manifest, not_after):
        with self.renewal_lock():
            try:
                profiles = self.validate(manifest)
                provenance_path = self.renewal_path.parent / 'source-provenance.json'
                provenance = read_json(provenance_path) if provenance_path.exists() else None
                if provenance is not None and not isinstance(provenance, dict):
                    raise UpdateError('invalidPackage')
                before, connection = self._phone()
                expected = (manifest['version'], manifest['build'])
                actual = (before.get('version'), before.get('bundleVersion'))
                if self.now() >= not_after:
                    raise UpdateError('failed')
                if version_key(*actual) > version_key(*expected):
                    raise UpdateError('invalidPackage')
                # Always install the approved bytes before repinning, even if the reported version is equal.
                self.run(['/usr/bin/xcrun', 'devicectl', 'device', 'install', 'app', '--device', self.cfg['deviceUDID'],
                          '--timeout', '120', manifest['appPath']], timeout=150)
                after, connection = self._phone()
                if (after.get('version'), after.get('bundleVersion')) != expected:
                    raise UpdateError('failed')
                # Recheck bytes, signatures, source, enrollment and both profiles after device verification.
                if self.validate(manifest) != profiles:
                    raise UpdateError('invalidPackage')
                renewal = read_json(self.renewal_path)
                renewal.update(source_root=manifest['sourceRoot'], source_sha256=manifest['sourceSHA256'])
                receipt = {'operation': 'confirmed-version-update', 'installed_at': self.now().isoformat(), 'profiles': profiles,
                           'device_connection': connection, **{key: manifest[key] for key in
                           ['releaseId', 'version', 'build', 'sourceRoot', 'sourceRevision', 'sourceSHA256', 'appSHA256', 'enrollmentSHA256', 'targetIdentitySHA256']}}
                # Both writes occur only after a verified installation, while holding the native renewal lock.
                atomic_json(self.renewal_path, renewal)
                atomic_json(self.state / 'success.json', receipt)
                atomic_json(self.state / 'update-provenance.json', receipt)
                if provenance is not None:
                    provenance.update(sourceRevision=manifest['sourceRevision'], pinnedSHA256=manifest['sourceSHA256'],
                                      verifiedAt=receipt['installed_at'], **{key: manifest[key] for key in
                                      ['sourceRoot', 'releaseId', 'version', 'build']})
                    if 'sourceSHA256' in provenance:
                        provenance['sourceSHA256'] = manifest['sourceSHA256']
                    atomic_json(provenance_path, provenance)
                return receipt
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                raise UpdateError('failed') from None


class UpdateService:
    def __init__(self, config, installer=None, now=None):
        self.cfg = config
        self.now = now or (lambda: dt.datetime.now(UTC))
        self.installer = installer or Installer(config, now=self.now)
        self.token = _read_token(config)
        self.state = private_dir(config['stateDir'])
        self.jobs_path = self.state / 'confirmed-jobs.json'
        self.mutex, self.worker_mutex = threading.Lock(), threading.Lock()
        self.jobs = read_json(self.jobs_path) if self.jobs_path.exists() else {'jobs': {}, 'activeRequestId': None}
        self._validate_saved_jobs()

    def _validate_saved_jobs(self):
        try:
            if set(self.jobs) != {'jobs', 'activeRequestId'} or not isinstance(self.jobs['jobs'], dict):
                raise ValueError()
            for request, job in self.jobs['jobs'].items():
                if str(uuid.UUID(request)) != request or job['state'] not in {'queued', 'installing', 'succeeded', 'failed'}:
                    raise ValueError()
                confirmed, expires = parse_time(job['confirmedAt']), parse_time(job['expiresAt'])
                if expires - confirmed != CONFIRMATION_LIFETIME or confirmed > self.now() or not _hex_digest(job['manifestSHA256']):
                    raise ValueError()
            active = self.jobs['activeRequestId']
            if active is not None and active not in self.jobs['jobs']:
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise UpdateError('invalidConfig') from None

    def _manifest(self):
        try:
            return read_json(private_file(self.cfg['manifestPath']))
        except (OSError, ValueError, TypeError):
            raise UpdateError('invalidPackage') from None

    def _save(self):
        atomic_json(self.jobs_path, self.jobs)

    def _installation(self):
        active = self.jobs['activeRequestId']
        if not active:
            return {'state': 'idle'}
        job = self.jobs['jobs'][active]
        return {key: job[key] for key in ['state', 'releaseId', 'messageCode'] if key in job}

    def status(self):
        with self.mutex:
            installation = self._installation()
        try:
            manifest = self._manifest()
            self.installer.validate(manifest)
            latest = {key: manifest[key] for key in METADATA}
        except UpdateError as error:
            latest = None
            if installation['state'] in {'idle', 'succeeded', 'failed'}:
                installation = {'state': 'failed', 'messageCode': error.code if error.code in {'signInRequired', 'invalidPackage'} else 'invalidPackage'}
        return {'schemaVersion': 1, 'hostId': self.cfg['hostId'], 'latest': latest, 'installation': installation}

    def handle(self, method, path, headers, body):
        try:
            supplied = headers.get('Authorization', '').encode('utf-8')
            if not hmac.compare_digest(supplied, b'Bearer ' + self.token):
                return 401, {'messageCode': 'failed'}
            if method == 'GET' and path == '/v1/status':
                return 200, self.status()
            if method != 'POST' or path != '/v1/install':
                return 404, {'messageCode': 'failed'}
            if len(body) > MAX_BODY or headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                return 400, {'messageCode': 'failed'}
            try:
                request = strict_json(body)
                if not isinstance(request, dict) or set(request) != {'releaseId', 'requestId'} or not isinstance(request['releaseId'], str):
                    raise ValueError()
                request_id = str(uuid.UUID(request['requestId']))
            except (ValueError, TypeError, AttributeError):
                return 400, {'messageCode': 'failed'}
            confirmed_at = self.now()
            with self.mutex:
                if request_id in self.jobs['jobs']:
                    job = self.jobs['jobs'][request_id]
                    if job['releaseId'] != request['releaseId']:
                        return 409, {'messageCode': 'invalidPackage'}
                    return 202, {'state': 'queued', 'releaseId': job['releaseId']}
                active = self.jobs['activeRequestId']
                if active and self.jobs['jobs'][active]['state'] in {'queued', 'installing'}:
                    if parse_time(self.jobs['jobs'][active]['expiresAt']) > self.now():
                        return 409, {'messageCode': 'busy'}
                    self.jobs['jobs'][active].update(state='failed', messageCode='failed')
                manifest = self._manifest()
                self.installer.confirmable(manifest)
                if request['releaseId'] != manifest['releaseId']:
                    return 409, {'messageCode': 'invalidPackage'}
                now = confirmed_at
                if self.now() >= now + CONFIRMATION_LIFETIME:
                    return 409, {'messageCode': 'failed'}
                job = {'releaseId': request['releaseId'], 'manifestSHA256': hashlib.sha256(json_bytes(manifest)).hexdigest(),
                    'confirmedAt': now.isoformat(), 'expiresAt': (now + CONFIRMATION_LIFETIME).isoformat(), 'state': 'queued'}
                updated = {'jobs': {**self.jobs['jobs'], request_id: job}, 'activeRequestId': request_id}
                atomic_json(self.jobs_path, updated)
                self.jobs = updated
                return 202, {'state': 'queued', 'releaseId': request['releaseId']}
        except UpdateError as error:
            return 409, {'messageCode': error.code if error.code != 'invalidConfig' else 'failed'}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return 500, {'messageCode': 'failed'}

    def run_pending(self):
        if not self.worker_mutex.acquire(blocking=False):
            return
        try:
            with self.mutex:
                active = self.jobs['activeRequestId']
                if not active:
                    return
                job = self.jobs['jobs'][active]
                if job['state'] not in {'queued', 'installing'}:
                    return
                expires = parse_time(job['expiresAt'])
                if self.now() >= expires:
                    job.update(state='failed', messageCode='failed')
                    self._save()
                    return
                job['state'] = 'installing'
                job.pop('messageCode', None)
                self._save()
            try:
                manifest = self._manifest()
                if hashlib.sha256(json_bytes(manifest)).hexdigest() != job['manifestSHA256']:
                    raise UpdateError('invalidPackage')
                self.installer.install(manifest, expires)
                result, code = 'succeeded', None
            except UpdateError as error:
                code = error.code if error.code != 'invalidConfig' else 'failed'
                result = 'queued' if code in RETRYABLE and self.now() < expires else 'failed'
            except Exception:
                result, code = 'failed', 'failed'
            with self.mutex:
                job['state'] = result
                if code:
                    job['messageCode'] = code
                else:
                    job.pop('messageCode', None)
                self._save()
            LOG.info('confirmed-job %s%s', result, ' ' + code if code else '')
        finally:
            self.worker_mutex.release()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = 'ConfirmedUpdateHost'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        pass  # Never log request lines, headers, bearer tokens or client-supplied text.

    def _dispatch(self):
        try:
            lengths = self.headers.get_all('Content-Length', [])
            auths = self.headers.get_all('Authorization', [])
            if not auths:
                self._respond(401, {'messageCode': 'failed'})
                return
            if (len(auths) != 1 or self.headers.get('Transfer-Encoding') or len(lengths) > 1
                    or (self.command == 'POST' and len(lengths) != 1)):
                self._respond(400, {'messageCode': 'failed'})
                return
            length = int(lengths[0]) if lengths else 0
            if length < 0 or length > MAX_BODY or (self.command == 'GET' and length):
                self._respond(400, {'messageCode': 'failed'})
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self._respond(400, {'messageCode': 'failed'})
                return
            code, payload = self.server.service.handle(self.command, self.path, self.headers, body)
            self._respond(code, payload)
        except ValueError:
            self._respond(400, {'messageCode': 'failed'})
        except OSError:
            self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        self._respond(code, {'messageCode': 'failed'})

    def _respond(self, code, payload):
        encoded = json_bytes(payload)
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    do_GET = _dispatch
    do_POST = _dispatch


class UpdateHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, *args, **kwargs):
        self.handler_slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def get_request(self):
        raw, address = super().get_request()
        raw.settimeout(10)
        try:
            return self.tls_context.wrap_socket(raw, server_side=True, do_handshake_on_connect=False), address
        except Exception:
            raw.close()
            raise

    def process_request(self, request, client_address):
        if not self.handler_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            try:
                self.shutdown_request(request)
            finally:
                self.handler_slots.release()
            raise

    @staticmethod
    def expire_connection(request):
        # shutdown interrupts a buffered header/body read even when its makefile holds the socket.
        try:
            request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        finally:
            request.close()

    def process_request_thread(self, request, client_address):
        deadline = None
        try:
            deadline = threading.Timer(10, self.expire_connection, args=(request,))
            deadline.daemon = True
            deadline.start()
            request.settimeout(10)
            request.do_handshake()
            super().process_request_thread(request, client_address)
        except OSError:
            self.shutdown_request(request)
        except Exception:
            self.shutdown_request(request)
            self.handle_error(request, client_address)
        finally:
            if deadline is not None:
                deadline.cancel()
            self.handler_slots.release()

    def handle_error(self, request, client_address):
        LOG.error('request failed')  # Default handler prints raw exception data.


def serve(config):
    # A second daemon must not reload and replay the same persistent confirmation concurrently.
    state = private_dir(config['stateDir'])
    with (state / 'host.lock').open('a') as host_lock:
        try:
            fcntl.flock(host_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpdateError('busy') from None
        service = UpdateService(config)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(config['certificatePath'], str(private_file(config['privateKeyPath'])))
        server = UpdateHTTPServer((config['listenHost'], config['listenPort']), RequestHandler)
        server.service = service
        server.tls_context = context
        stop = threading.Event()
        def worker():
            while not stop.is_set():
                try:
                    service.run_pending()
                except Exception:
                    LOG.error('worker failed')
                stop.wait(5)
        thread = threading.Thread(target=worker, name='confirmed-install-worker', daemon=True)
        thread.start()
        try:
            server.serve_forever(poll_interval=0.5)
        finally:
            stop.set()
            server.server_close()
            thread.join(timeout=1)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--check-config', action='store_true', help='Validate configuration and prepared package without installing')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        config = load_config(args.config)
        if args.check_config:
            Installer(config).validate(read_json(private_file(config['manifestPath'])))
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(config['certificatePath'], str(private_file(config['privateKeyPath'])))
            print('Configuration and prepared package valid; no installation requested.')
        else:
            serve(config)
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        code = error.code if isinstance(error, UpdateError) else 'failed'
        LOG.error('%s', code)
        print('Update host unavailable: ' + code)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
