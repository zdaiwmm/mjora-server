from argparse import Namespace
import json
from pathlib import Path
import stat
import tempfile
import unittest

from config_snapshot import MANIFEST, SnapshotError, capture, check


class ConfigSnapshotTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.base = root / 'compose.yml'
        self.overlay = root / 'override.yml'
        self.env = root / '.env'
        self.extra = root / 'app.json'
        self.files = [self.base, self.overlay, self.env, self.extra]
        for index, path in enumerate(self.files):
            path.write_bytes(f'synthetic={index}\n'.encode())
        self.identity = {
            'id': 'a' * 64,
            'image': 'sha256:' + 'b' * 64,
            'project': 'test',
            'service': 'server',
            'composeFiles': [str(self.base), str(self.overlay)],
        }
        self.args = Namespace(
            snapshot=root / 'attempt',
            expected_image=self.identity['image'],
            candidate_sha='c' * 40,
            container='synthetic-server',
            env_file=[str(self.env)],
            config_file=[str(self.extra)],
        )

    def inspect(self, _):
        return self.identity.copy()

    def test_verifies_original_and_private_copies(self):
        self.assertEqual(capture(self.args, self.inspect), 4)
        self.assertEqual(check(self.args, self.inspect), 4)
        self.assertEqual(stat.S_IMODE(self.args.snapshot.stat().st_mode), 0o700)
        manifest = self.args.snapshot / MANIFEST
        self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600)
        self.assertNotIn('synthetic=', manifest.read_text())
        for source, row in zip(self.files, json.loads(manifest.read_text())['files']):
            copy = self.args.snapshot / row['backup']
            self.assertEqual(stat.S_IMODE(copy.stat().st_mode), 0o600)
            self.assertEqual(copy.read_bytes(), source.read_bytes())
        with self.assertRaises(FileExistsError):
            capture(self.args, self.inspect)

    def test_capture_fails_when_env_file_is_missing(self):
        self.env.unlink()
        with self.assertRaises(FileNotFoundError):
            capture(self.args, self.inspect)
        self.assertFalse(self.args.snapshot.exists())

    def test_detects_changed_config_and_corrupt_copy(self):
        capture(self.args, self.inspect)
        old = self.env.read_bytes()
        self.env.write_bytes(b'changed')
        with self.assertRaisesRegex(SnapshotError, 'live configuration changed'):
            check(self.args, self.inspect)
        self.env.write_bytes(old)
        (self.args.snapshot / 'config-003.backup').write_bytes(b'corrupt')
        with self.assertRaisesRegex(SnapshotError, 'backup is incomplete'):
            check(self.args, self.inspect)

    def test_requires_original_candidate_inventory_and_running_container(self):
        capture(self.args, self.inspect)
        with self.assertRaisesRegex(SnapshotError, 'different candidate'):
            check(Namespace(**{**vars(self.args), 'candidate_sha': 'd' * 40}), self.inspect)
        with self.assertRaisesRegex(SnapshotError, 'inventory differs'):
            check(Namespace(**{**vars(self.args), 'config_file': []}), self.inspect)
        self.identity['id'] = 'e' * 64
        with self.assertRaisesRegex(SnapshotError, 'running container or Compose files changed'):
            check(self.args, self.inspect)

    def test_wrong_predeploy_image_is_rejected_before_writing(self):
        self.identity['image'] = 'sha256:' + 'd' * 64
        with self.assertRaisesRegex(SnapshotError, 'expected old image'):
            capture(self.args, self.inspect)
        self.assertFalse(self.args.snapshot.exists())

    def test_distinguishes_post_deploy_receipt(self):
        capture(self.args, self.inspect)
        manifest = self.args.snapshot / MANIFEST
        manifest.write_text(manifest.read_text().replace('PRE_DEPLOY', 'POST_DEPLOYMENT_ONLY'))
        with self.assertRaisesRegex(SnapshotError, 'not a pre-deploy'):
            check(self.args, self.inspect)


if __name__ == '__main__':
    unittest.main()
