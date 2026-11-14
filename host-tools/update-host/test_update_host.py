"""Pure offline tests. Synthetic bundles, profiles, enrollment and identity only."""
import datetime as dt
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
from types import SimpleNamespace

MODULE = Path(__file__).with_name('update_host.py')
spec = importlib.util.spec_from_file_location('update_host', MODULE)
uh = importlib.util.module_from_spec(spec) if MODULE.exists() else None
if uh:
    spec.loader.exec_module(uh)
UTC = dt.timezone.utc
NOW = dt.datetime(2030, 1, 1, tzinfo=UTC)
TEAM, DEVICE = 'EXAMPLETEAM', 'SYNTHETIC-PAIRED-PHONE'
MAIN, SHARE, GROUP = 'invalid.example.app', 'invalid.example.app.share', 'group.invalid.example.app'
TOKEN = 'synthetic-dedicated-update-token-0123456789'


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    path.chmod(0o600)


def write_plist(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(data))


class FakeTools:
    """Only simulates the fixed local Apple commands used by the real Installer."""
    def __init__(self):
        self.installs = 0
        self.commands = []
        self.available = True
        self.locked = False
        self.transport = 'localNetwork'
        self.before_version, self.before_build = '1.0.0', '1'
        self.after_version, self.after_build = '1.0.1', '2'
        self.signature_valid = True
        self.signing_team = TEAM
        self.fail_install = False
        self.mutate_after_install = None
        self.device = DEVICE
        self.signed_overrides = {}

    def __call__(self, argv, timeout=60):
        self.commands.append(argv)
        if argv[:4] == ['/usr/bin/security', 'cms', '-D', '-i']:
            return Path(argv[-1]).read_bytes()
        if argv[0] == '/usr/bin/codesign':
            if '--verify' in argv:
                if '--test-requirement' in argv and not argv[argv.index('--test-requirement') + 1].startswith('=anchor apple generic and certificate leaf[subject.OU] = '):
                    raise uh.UpdateError('invalidPackage')
                if not self.signature_valid or ('--test-requirement' in argv and self.signing_team != TEAM):
                    raise uh.UpdateError('invalidPackage')
                return b''
            entitlements = plistlib.loads((Path(argv[-1]) / 'embedded.mobileprovision').read_bytes())['Entitlements']
            entitlements.update(self.signed_overrides)
            return plistlib.dumps(entitlements)
        if argv[:4] == ['/usr/bin/xcrun', 'devicectl', 'list', 'devices']:
            if not self.available:
                raise uh.UpdateError('needsPhone')
            output = Path(argv[argv.index('--json-output') + 1])
            write_json(output, {'result': {'devices': [{'hardwareProperties': {'udid': self.device},
                'connectionProperties': {'transportType': self.transport, 'tunnelState': 'connected'}}]}})
            return b''
        if argv[:5] == ['/usr/bin/xcrun', 'devicectl', 'device', 'info', 'apps']:
            if self.locked:
                raise uh.UpdateError('needsUnlock')
            output = Path(argv[argv.index('--json-output') + 1])
            version, build = (self.after_version, self.after_build) if self.installs else (self.before_version, self.before_build)
            write_json(output, {'result': {'apps': [{'bundleIdentifier': MAIN, 'version': version, 'bundleVersion': build}]}})
            return b''
        if argv[:5] == ['/usr/bin/xcrun', 'devicectl', 'device', 'install', 'app']:
            self.installs += 1
            if self.fail_install:
                raise uh.UpdateError('failed')
            if self.mutate_after_install:
                self.mutate_after_install()
            return b''
        raise AssertionError('Unexpected command: ' + repr(argv))


class OfflineConnection:
    def __init__(self, request):
        self.input, self.output, self.timeout = io.BytesIO(request), bytearray(), None
        self.closed, self.handshakes, self.shutdowns = False, 0, []

    def makefile(self, mode, *args):
        return self.input

    def sendall(self, data):
        self.output.extend(data)

    def settimeout(self, timeout):
        self.timeout = timeout

    def do_handshake(self):
        self.handshakes += 1

    def shutdown(self, how):
        self.shutdowns.append(how)

    def close(self):
        self.closed = True


class UpdateHostTests(unittest.TestCase):
    def setUp(self):
        if uh is None:
            self.fail('Confirmed update host is not implemented')
        self.temp = tempfile.TemporaryDirectory(prefix='update-host-offline-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.clock = NOW
        self.cfg = {'schemaVersion': 1, 'hostId': 'synthetic-host', 'listenHost': '127.0.0.1', 'listenPort': 9443,
                    'certificatePath': str(self.root / 'tls.pem'), 'privateKeyPath': str(self.root / 'tls.key'),
                    'accessTokenPath': str(self.root / 'token'), 'manifestPath': str(self.root / 'release.json'),
                    'stateDir': str(self.root / 'update-state'), 'renewalConfigPath': str(self.root / 'renewal.json'),
                    'teamId': TEAM, 'deviceUDID': DEVICE, 'mainBundleId': MAIN, 'shareBundleId': SHARE, 'appGroup': GROUP,
                    'approvedEnrollmentSHA256': hashlib.sha256(b'synthetic-local-enrollment').hexdigest()}
        (self.root / 'token').write_text(TOKEN + '\n')
        (self.root / 'token').chmod(0o600)
        self.source = self.root / 'source'
        (self.source / 'project.xcodeproj').mkdir(parents=True)
        (self.source / 'main.swift').write_text('reviewed source')
        self.app = self.root / 'Prepared.app'
        for path, bundle in [(self.app, MAIN), (self.app / 'PlugIns/Share.appex', SHARE)]:
            write_plist(path / 'Info.plist', {'CFBundleIdentifier': bundle, 'CFBundleShortVersionString': '1.0.1', 'CFBundleVersion': '2', 'MJoraSourceRevision': 'a' * 40})
            write_plist(path / 'embedded.mobileprovision', self.profile(bundle))
        (self.app / 'LocalServerIdentity.json').write_bytes(b'synthetic-local-enrollment')
        self.renewal = {'state_dir': str(self.root / 'renewal-state'), 'source_root': str(self.root / 'previous-source'),
                        'source_sha256': '0' * 64, 'project': 'project.xcodeproj', 'derived_data': '/synthetic/preserve-derived',
                        'app_path': '/synthetic/preserve-app.app', 'package_cache': '/synthetic/preserve-cache',
                        'baseline_expirations': {b: (NOW + dt.timedelta(days=1)).isoformat() for b in [MAIN, SHARE]}}
        write_json(self.root / 'renewal.json', self.renewal)
        self.manifest = {'schemaVersion': 1, 'releaseId': 'release-1.0.1-2', 'version': '1.0.1', 'build': '2', 'notes': 'Prepared update',
                         'appPath': str(self.app), 'appSHA256': uh.tree_sha256(self.app), 'sourceRevision': 'a' * 40,
                         'sourceRoot': str(self.source), 'sourceSHA256': uh.source_fingerprint(self.source),
                         'enrollmentSHA256': self.cfg['approvedEnrollmentSHA256'], 'targetIdentitySHA256': uh.target_identity_sha256(self.cfg)}
        self.save_manifest()
        self.tools = FakeTools()
        self.installer = uh.Installer(self.cfg, run=self.tools, now=lambda: self.clock)
        self.service = uh.UpdateService(self.cfg, installer=self.installer, now=lambda: self.clock)
        self.auth = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}

    def profile(self, bundle):
        return {'UUID': bundle + '-synthetic-profile', 'ExpirationDate': (NOW + dt.timedelta(days=3)).replace(tzinfo=None),
                'TeamIdentifier': [TEAM], 'ProvisionedDevices': [DEVICE], 'Entitlements': {
                    'application-identifier': TEAM + '.' + bundle, 'com.apple.developer.team-identifier': TEAM,
                    'com.apple.security.application-groups': [GROUP]}}

    def save_manifest(self):
        write_json(self.root / 'release.json', self.manifest)

    def confirm(self, request_id=None, **extra):
        body = {'releaseId': self.manifest['releaseId'], 'requestId': request_id or str(uuid.uuid4()), **extra}
        return self.service.handle('POST', '/v1/install', self.auth, json.dumps(body).encode())

    def test_status_is_authenticated_metadata_only_and_never_installs(self):
        for authorization in ['', 'Bearer wrong', 'Basic ' + TOKEN, 'Bearer nonascii-\u2603']:
            code, _ = self.service.handle('GET', '/v1/status', {'Authorization': authorization}, b'')
            self.assertEqual(code, 401)
        code, status = self.service.handle('GET', '/v1/status', self.auth, b'')
        self.assertEqual(code, 200)
        self.assertEqual(status['latest'], {k: self.manifest[k] for k in ['releaseId', 'version', 'build', 'notes']})
        serialized = json.dumps(status)
        for private in [TOKEN, str(self.root), DEVICE, TEAM, 'appSHA256', 'sourceRoot', 'enrollmentSHA256']:
            self.assertNotIn(private, serialized)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)

    def test_confirmation_allows_only_release_and_uuid_and_bounded_json(self):
        for extra in [{'appPath': '/bad'}, {'url': 'https://invalid.example'}, {'command': 'anything'}, {'deviceUDID': 'another'}]:
            self.assertEqual(self.confirm(**extra)[0], 400)
        for body in [b'{}', b'{', b'[]', b'x' * 2049,
                     json.dumps({'releaseId': self.manifest['releaseId'], 'requestId': 'not-uuid'}).encode(),
                     b'{"releaseId":"x","releaseId":"y","requestId":"00000000-0000-0000-0000-000000000000"}']:
            self.assertEqual(self.service.handle('POST', '/v1/install', self.auth, body)[0], 400)
        self.assertEqual(self.service.handle('POST', '/v1/install', {}, b'{}')[0], 401)
        self.assertEqual(self.tools.installs, 0)

    def test_only_confirmed_job_installs_then_repins_source_and_records_receipt(self):
        old_config = dict(self.renewal)
        self.assertEqual(self.confirm()[0], 202)
        self.assertEqual(self.tools.installs, 0)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 1)
        status = self.service.handle('GET', '/v1/status', self.auth, b'')[1]
        self.assertEqual(status['installation']['state'], 'succeeded')
        updated = json.loads((self.root / 'renewal.json').read_text())
        expected = {**old_config, 'source_root': str(self.source), 'source_sha256': self.manifest['sourceSHA256']}
        self.assertEqual(updated, expected)
        receipt = json.loads((self.root / 'renewal-state/success.json').read_text())
        self.assertEqual(set(receipt['profiles']), {MAIN, SHARE})
        self.assertEqual(receipt['releaseId'], self.manifest['releaseId'])
        self.assertEqual(receipt['sourceRevision'], self.manifest['sourceRevision'])
        self.assertEqual(receipt['operation'], 'confirmed-version-update')
        self.assertNotIn('renewed', json.dumps(receipt))
        self.assertEqual(receipt['device_connection']['transport'], 'localNetwork')

    def test_confirmation_is_idempotent_across_restart_and_release_is_bound(self):
        request = str(uuid.uuid4())
        self.assertEqual(self.confirm(request)[0], 202)
        self.assertEqual(self.confirm(request.upper())[0], 202)
        self.service = uh.UpdateService(self.cfg, installer=self.installer, now=lambda: self.clock)
        self.service.run_pending()
        self.assertEqual(self.confirm(request)[0], 202)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 1)
        self.manifest['releaseId'] = 'a-different-release'
        self.save_manifest()
        self.assertEqual(self.confirm(request)[0], 409)

    def test_confirmed_job_expires_after_ten_minutes_and_startup_does_not_rearm(self):
        self.confirm()
        self.clock += dt.timedelta(minutes=10, seconds=1)
        self.service = uh.UpdateService(self.cfg, installer=self.installer, now=lambda: self.clock)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(self.service.status()['installation']['state'], 'failed')

    def test_busy_lock_and_unreachable_phone_retry_only_within_confirmation_window(self):
        self.confirm()
        state = self.root / 'renewal-state'
        state.mkdir(exist_ok=True)
        with (state / 'run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.service.run_pending()
        self.assertEqual(self.service.status()['installation']['messageCode'], 'busy')
        self.tools.available = False
        self.service.run_pending()
        self.assertEqual(self.service.status()['installation']['messageCode'], 'needsPhone')
        self.assertEqual(self.tools.installs, 0)
        self.tools.available = True
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 1)

    def test_other_phone_and_locked_phone_are_not_installed(self):
        self.confirm()
        for field, value, code in [('device', 'UNAPPROVED', 'needsPhone'), ('locked', True, 'needsUnlock')]:
            saved = getattr(self.tools, field)
            setattr(self.tools, field, value)
            self.service.run_pending()
            self.assertEqual(self.tools.installs, 0)
            self.assertEqual(self.service.status()['installation']['messageCode'], code)
            setattr(self.tools, field, saved)

    def test_wired_transport_is_supported_and_recorded_without_wireless_claim(self):
        self.tools.transport = 'wired'
        self.confirm()
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 1)
        receipt = json.loads((self.root / 'renewal-state/success.json').read_text())
        self.assertEqual(receipt['device_connection']['transport'], 'wired')

    def test_confirmation_revalidates_package_under_native_lock(self):
        with (self.root / 'renewal-state/run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, response = self.confirm()
        self.assertEqual(code, 409)
        self.assertEqual(response['messageCode'], 'busy')
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)

    def test_main_and_share_must_both_match_identity_while_same_expiry_is_allowed(self):
        self.tools.signed_overrides = {'get-task-allow': True}
        with self.assertRaises(uh.UpdateError):
            self.installer.validate(self.manifest)

    def test_changed_manifest_after_confirmation_never_installs(self):
        self.confirm()
        self.manifest['notes'] = 'changed after confirmation'
        self.save_manifest()
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(self.service.status()['installation']['messageCode'], 'invalidPackage')

    def test_changed_app_or_source_or_enrollment_or_target_never_installs(self):
        source_bytes = (self.source / 'main.swift').read_bytes()
        enrollment_bytes = (self.app / 'LocalServerIdentity.json').read_bytes()
        mutations = [lambda: (self.app / 'new-file').write_text('changed'),
                     lambda: (self.source / 'main.swift').write_text('changed'),
                     lambda: (self.app / 'LocalServerIdentity.json').write_bytes(b'changed'),
                     lambda: self.cfg.update(deviceUDID='CHANGED')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                mutation()
                # Updating the package digest cannot override a changed approved enrollment.
                candidate = {**self.manifest, 'appSHA256': uh.tree_sha256(self.app)} if (self.app / 'LocalServerIdentity.json').read_bytes() != enrollment_bytes else self.manifest
                with self.assertRaises(uh.UpdateError):
                    self.installer.validate(candidate)
                (self.app / 'new-file').unlink(missing_ok=True)
                (self.source / 'main.swift').write_bytes(source_bytes)
                (self.app / 'LocalServerIdentity.json').write_bytes(enrollment_bytes)
                self.cfg['deviceUDID'] = DEVICE
                self.installer.validate(self.manifest)
        self.assertEqual(self.tools.installs, 0)

    def test_profiles_exact_identity_and_expiry_and_matching_bundle_versions_required(self):
        share = self.app / 'PlugIns/Share.appex'
        original = (share / 'embedded.mobileprovision').read_bytes()
        for mutation in [lambda p: p.update(TeamIdentifier=['OTHER']), lambda p: p.update(ProvisionedDevices=['OTHER']),
                         lambda p: p['Entitlements'].update({'application-identifier': TEAM + '.' + MAIN}),
                         lambda p: p['Entitlements'].update({'com.apple.security.application-groups': ['other']}),
                         lambda p: p['Entitlements'].update({'com.apple.developer.networking.wifi-info': True}),
                         lambda p: p.update(ExpirationDate=(NOW - dt.timedelta(seconds=1)).replace(tzinfo=None)),
                         lambda p: p.update(ExpirationDate=(NOW + dt.timedelta(hours=1)).replace(tzinfo=None))]:
            p = plistlib.loads(original)
            mutation(p)
            write_plist(share / 'embedded.mobileprovision', p)
            self.manifest['appSHA256'] = uh.tree_sha256(self.app)
            with self.assertRaises(uh.UpdateError):
                self.installer.validate(self.manifest)
        (share / 'embedded.mobileprovision').write_bytes(original)
        info = plistlib.loads((share / 'Info.plist').read_bytes())
        info['CFBundleVersion'] = '1'
        write_plist(share / 'Info.plist', info)
        self.manifest['appSHA256'] = uh.tree_sha256(self.app)
        with self.assertRaises(uh.UpdateError):
            self.installer.validate(self.manifest)

    def test_equal_installed_expiry_is_valid_but_expired_package_not_offered(self):
        self.renewal['baseline_expirations'] = {b: (NOW + dt.timedelta(days=3)).isoformat() for b in [MAIN, SHARE]}
        write_json(self.root / 'renewal.json', self.renewal)
        self.installer.validate(self.manifest)
        self.clock += dt.timedelta(days=4)
        status = self.service.status()
        self.assertIsNone(status['latest'])
        self.assertEqual(status['installation']['messageCode'], 'signInRequired')

    def test_invalid_signature_and_signed_entitlements_are_refused(self):
        self.tools.signature_valid = False
        with self.assertRaises(uh.UpdateError):
            self.installer.validate(self.manifest)
        self.tools.signature_valid = True
        self.tools.signed_overrides = {'com.apple.developer.team-identifier': 'OTHER'}
        with self.assertRaises(uh.UpdateError):
            self.installer.validate(self.manifest)
        self.assertEqual(self.tools.installs, 0)

    def test_failed_install_or_postcheck_does_not_repin_or_change_success_receipt(self):
        success = self.root / 'renewal-state/success.json'
        baseline = {'profiles': {b: {'uuid': 'old', 'expires': self.renewal['baseline_expirations'][b]} for b in [MAIN, SHARE]}}
        write_json(success, baseline)
        config_bytes, success_bytes = (self.root / 'renewal.json').read_bytes(), success.read_bytes()
        self.confirm()
        self.tools.after_build = 'WRONG'
        self.service.run_pending()
        self.assertEqual(self.service.status()['installation']['state'], 'failed')
        self.assertEqual((self.root / 'renewal.json').read_bytes(), config_bytes)
        self.assertEqual(success.read_bytes(), success_bytes)

    def test_package_mutation_during_install_does_not_repin(self):
        self.confirm()
        self.tools.mutate_after_install = lambda: (self.app / 'tampered').write_text('changed')
        self.service.run_pending()
        self.assertEqual(json.loads((self.root / 'renewal.json').read_text()), self.renewal)
        self.assertFalse((self.root / 'renewal-state/success.json').exists())

    def test_tree_hash_is_deterministic_covers_generated_files_and_rejects_symlinks(self):
        a, b = self.root / 'a', self.root / 'b'
        a.mkdir(); b.mkdir()
        for root, order in [(a, ['z', 'a']), (b, ['a', 'z'])]:
            for name in order:
                (root / name).write_bytes(name.encode())
        self.assertEqual(uh.tree_sha256(a), uh.tree_sha256(b))
        (a / '.DS_Store').write_bytes(b'signed-package-content')
        self.assertNotEqual(uh.tree_sha256(a), uh.tree_sha256(b))
        (a / 'link').symlink_to(b)
        with self.assertRaises(uh.UpdateError):
            uh.tree_sha256(a)

    def test_source_fingerprint_matches_existing_renewal_rules(self):
        initial = uh.source_fingerprint(self.source)
        for name in ['build/file', '.git/config', 'project.xcodeproj/project.xcworkspace/generated', 'DerivedData/output']:
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('ignored')
        self.assertEqual(uh.source_fingerprint(self.source), initial)
        pinned = self.source / 'project.xcodeproj/project.xcworkspace/Package.resolved'
        pinned.write_text('pinned')
        self.assertNotEqual(uh.source_fingerprint(self.source), initial)

    def test_same_version_confirmation_still_installs_approved_bytes_before_repin(self):
        self.tools.before_version, self.tools.before_build = '1.0.1', '2'
        self.confirm()
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 1)

    def test_new_confirmation_cannot_downgrade_the_installed_phone_version(self):
        self.tools.before_version, self.tools.before_build = '1.0.2', '3'
        self.confirm()
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(self.service.status()['installation']['messageCode'], 'invalidPackage')

    def test_codesign_certificate_must_match_configured_apple_team(self):
        self.tools.signing_team = 'OTHERTEAM'
        with self.assertRaises(uh.UpdateError):
            self.installer.validate(self.manifest)
        self.assertEqual(self.tools.installs, 0)

    def test_unpersisted_confirmation_cannot_start_worker_install(self):
        real_write = uh.atomic_json
        def disk_full(path, data):
            if Path(path).name == 'confirmed-jobs.json':
                raise OSError('synthetic disk failure with private data')
            real_write(path, data)
        with patch.object(uh, 'atomic_json', side_effect=disk_full):
            self.assertEqual(self.confirm()[0], 500)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)

    def test_expired_duplicate_does_not_extend_confirmation(self):
        request = str(uuid.uuid4())
        self.confirm(request)
        self.clock += dt.timedelta(minutes=11)
        self.assertEqual(self.confirm(request)[0], 202)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(self.service.status()['installation']['state'], 'failed')

    def test_failed_install_preserves_prior_source_and_receipt(self):
        success = self.root / 'renewal-state/success.json'
        baseline = {'profiles': {b: {'uuid': 'old', 'expires': self.renewal['baseline_expirations'][b]} for b in [MAIN, SHARE]}}
        write_json(success, baseline)
        old_config, old_receipt = (self.root / 'renewal.json').read_bytes(), success.read_bytes()
        self.confirm()
        self.tools.fail_install = True
        self.service.run_pending()
        self.assertEqual(self.service.status()['installation']['state'], 'failed')
        self.assertEqual((self.root / 'renewal.json').read_bytes(), old_config)
        self.assertEqual(success.read_bytes(), old_receipt)

    def http(self, request):
        connection = OfflineConnection(request)
        uh.RequestHandler(connection, ('127.0.0.1', 0), SimpleNamespace(service=self.service))
        return bytes(connection.output)

    def test_http_adapter_preserves_auth_and_body_limits_without_network(self):
        response = self.http(b'GET /v1/status HTTP/1.1\r\nHost: example.invalid\r\n\r\n')
        self.assertIn(b' 401 ', response)
        response = self.http(('GET /v1/status HTTP/1.1\r\nAuthorization: Bearer ' + TOKEN + '\r\n\r\n').encode())
        self.assertIn(b' 200 ', response)
        self.assertIn(b'Cache-Control: no-store', response)
        for extra in ['Content-Length: 2049\r\n', 'Content-Length: 2\r\nContent-Length: 2\r\n',
                      'Transfer-Encoding: chunked\r\n', 'Content-Length: -1\r\n', 'Content-Length: nope\r\n']:
            response = self.http(('POST /v1/install HTTP/1.1\r\nAuthorization: Bearer ' + TOKEN + '\r\n' + extra + '\r\n{}').encode())
            self.assertIn(b' 400 ', response)
        self.assertEqual(self.tools.installs, 0)

    def test_http_parser_errors_never_echo_client_private_text(self):
        private_marker = 'synthetic-private-marker'
        response = self.http(('UNSUPPORTED-' + private_marker + ' /v1/status HTTP/1.1\r\n\r\n').encode())
        self.assertNotIn(private_marker.encode(), response)
        self.assertIn(b'"messageCode":"failed"', response)

    def test_tls_handshake_is_bounded_before_accepting_requests(self):
        server = object.__new__(uh.UpdateHTTPServer)
        raw = OfflineConnection(b'')
        encrypted = object()
        def wrap(connection, **kwargs):
            self.assertEqual(raw.timeout, 10)
            self.assertTrue(kwargs['server_side'])
            self.assertFalse(kwargs['do_handshake_on_connect'])
            return encrypted
        server.tls_context = SimpleNamespace(wrap_socket=wrap)
        address = ('127.0.0.1', 0)
        with patch.object(uh.ThreadingHTTPServer, 'get_request', return_value=(raw, address)):
            self.assertEqual(server.get_request(), (encrypted, address))

    def server_without_network(self):
        with patch.object(uh.ThreadingHTTPServer, '__init__', return_value=None):
            return uh.UpdateHTTPServer(('example.invalid', 0), uh.RequestHandler)

    def assert_all_handler_permits_available(self, server):
        acquired = [server.handler_slots.acquire(blocking=False) for _ in range(8)]
        self.assertEqual(acquired, [True] * 8)
        self.assertFalse(server.handler_slots.acquire(blocking=False))
        for _ in acquired:
            server.handler_slots.release()

    def test_handler_concurrency_refuses_ninth_connection_without_starting_thread(self):
        server = self.server_without_network()
        requests = [OfflineConnection(b'') for _ in range(9)]
        with patch.object(uh.ThreadingHTTPServer, 'process_request') as dispatch:
            for request in requests:
                server.process_request(request, ('127.0.0.1', 0))
            self.assertEqual(dispatch.call_count, 8)
        self.assertTrue(requests[-1].closed)
        self.assertEqual(requests[-1].handshakes, 0)
        with patch.object(uh.ThreadingHTTPServer, 'process_request_thread'):
            for request in requests[:8]:
                server.process_request_thread(request, ('127.0.0.1', 0))
        self.assert_all_handler_permits_available(server)

    def test_handler_thread_start_failure_closes_connection_and_releases_permit(self):
        server = self.server_without_network()
        request = OfflineConnection(b'')
        with patch.object(uh.ThreadingHTTPServer, 'process_request', side_effect=RuntimeError('synthetic start failure')):
            with self.assertRaises(RuntimeError):
                server.process_request(request, ('127.0.0.1', 0))
        self.assertTrue(request.closed)
        self.assert_all_handler_permits_available(server)

    def test_thread_start_cleanup_failure_still_releases_handler_permit(self):
        server = self.server_without_network()
        request = OfflineConnection(b'')
        with patch.object(uh.ThreadingHTTPServer, 'process_request', side_effect=RuntimeError('synthetic start failure')), patch.object(server, 'shutdown_request', side_effect=OSError('synthetic close failure')):
            with self.assertRaises((RuntimeError, OSError)):
                server.process_request(request, ('127.0.0.1', 0))
        self.assert_all_handler_permits_available(server)

    def test_absolute_deadline_includes_handshake_and_cannot_slide_with_header_reads(self):
        server = self.server_without_network()
        request = OfflineConnection(b'')
        self.assertTrue(server.handler_slots.acquire(blocking=False))
        timers = []
        class ManualTimer:
            def __init__(self, interval, callback, args=()):
                self.interval, self.callback, self.args = interval, callback, args
                self.started, self.cancelled = False, False
                timers.append(self)
            def start(self):
                self.started = True
            def cancel(self):
                self.cancelled = True
        def handshake():
            self.assertEqual(len(timers), 1)
            self.assertTrue(timers[0].started)
            self.assertEqual(timers[0].interval, 10)
            request.handshakes += 1
        request.do_handshake = handshake
        def slow_headers(*args):
            self.assertEqual(request.handshakes, 1)
            for _ in range(20):
                request.settimeout(10)  # Header progress must not reset the absolute timer.
            self.assertEqual(len(timers), 1)
            timers[0].callback(*timers[0].args)
            self.assertTrue(request.closed)
            self.assertIn(uh.socket.SHUT_RDWR, request.shutdowns)
        with patch.object(uh.threading, 'Timer', ManualTimer), patch.object(uh.ThreadingHTTPServer, 'process_request_thread', side_effect=slow_headers):
            server.process_request_thread(request, ('127.0.0.1', 0))
        self.assertTrue(timers[0].cancelled)
        self.assert_all_handler_permits_available(server)

    def test_handshake_failure_releases_handler_permit_and_closes_socket(self):
        server = self.server_without_network()
        request = OfflineConnection(b'')
        request.do_handshake = lambda: (_ for _ in ()).throw(uh.ssl.SSLError('synthetic handshake failure'))
        self.assertTrue(server.handler_slots.acquire(blocking=False))
        with patch.object(uh.ThreadingHTTPServer, 'process_request_thread') as dispatch:
            server.process_request_thread(request, ('127.0.0.1', 0))
        dispatch.assert_not_called()
        self.assertTrue(request.closed)
        self.assert_all_handler_permits_available(server)

    def test_wrong_signed_source_revision_never_installs_or_repins(self):
        info = plistlib.loads((self.app / 'Info.plist').read_bytes())
        info['MJoraSourceRevision'] = 'b' * 40
        write_plist(self.app / 'Info.plist', info)
        self.manifest['appSHA256'] = uh.tree_sha256(self.app)
        self.save_manifest()
        self.assertEqual(self.confirm()[0], 409)
        self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(json.loads((self.root / 'renewal.json').read_text()), self.renewal)
        self.assertIsNone(self.service.status()['latest'])

    def test_verified_install_merges_runtime_source_provenance_preserving_helper_metadata(self):
        path = self.root / 'source-provenance.json'
        previous = {'sourceRevision': '0' * 40, 'pinnedSHA256': '0' * 64, 'sourceSHA256': '0' * 64,
                    'localOverrides': ['preserved signing policy'], 'helper': {'sha256': 'preserved-helper'},
                    'dependency': {'name': 'preserved-dependency', 'sha256': 'preserved-digest'}}
        write_json(path, previous)
        self.confirm()
        self.service.run_pending()
        merged = json.loads(path.read_text())
        for key in ['localOverrides', 'helper', 'dependency']:
            self.assertEqual(merged[key], previous[key])
        self.assertEqual(merged['sourceRevision'], self.manifest['sourceRevision'])
        self.assertEqual(merged['pinnedSHA256'], self.manifest['sourceSHA256'])
        self.assertEqual(merged['sourceSHA256'], self.manifest['sourceSHA256'])
        for key in ['sourceRoot', 'releaseId', 'version', 'build']:
            self.assertEqual(merged[key], self.manifest[key])
        self.assertEqual(merged['verifiedAt'], NOW.isoformat())

    def test_failed_install_leaves_runtime_source_provenance_unchanged(self):
        path = self.root / 'source-provenance.json'
        write_json(path, {'sourceRevision': '0' * 40, 'pinnedSHA256': '0' * 64, 'helper': {'sha256': 'preserve'}})
        previous = path.read_bytes()
        self.confirm()
        self.tools.fail_install = True
        self.service.run_pending()
        self.assertEqual(path.read_bytes(), previous)

    def test_slow_validation_cannot_extend_ten_minute_confirmation_budget(self):
        original = self.installer.confirmable
        def slow(manifest):
            result = original(manifest)
            self.clock += dt.timedelta(minutes=2)
            return result
        with patch.object(self.installer, 'confirmable', side_effect=slow):
            self.assertEqual(self.confirm()[0], 202)
        saved = json.loads((self.root / 'update-state/confirmed-jobs.json').read_text())
        job = saved['jobs'][saved['activeRequestId']]
        self.assertEqual(uh.parse_time(job['confirmedAt']), NOW)
        self.assertEqual(uh.parse_time(job['expiresAt']), NOW + dt.timedelta(minutes=10))

    def test_phone_wait_cannot_start_install_after_confirmation_deadline(self):
        self.confirm()
        original = self.installer._phone
        def slow():
            result = original()
            self.clock += dt.timedelta(minutes=11)
            return result
        with patch.object(self.installer, '_phone', side_effect=slow):
            self.service.run_pending()
        self.assertEqual(self.tools.installs, 0)
        self.assertEqual(self.service.status()['installation']['state'], 'failed')

    def test_configuration_validates_token_and_rejects_public_secrets_in_errors(self):
        config = self.root / 'host.json'
        write_json(config, self.cfg)
        self.assertEqual(uh.load_config(config)['hostId'], self.cfg['hostId'])
        (self.root / 'token').write_text('short')
        with self.assertRaises(uh.UpdateError) as result:
            uh.load_config(config)
        self.assertEqual(str(result.exception), 'invalidConfig')
        self.assertNotIn(str(self.root), str(result.exception))


if __name__ == '__main__':
    unittest.main()
