import unittest
from pathlib import Path
from unittest.mock import patch

from local_decider import lock


class PackageDataTests(unittest.TestCase):
    def test_bundled_lock_matches_public_lock(self):
        public = Path(__file__).resolve().parents[1] / 'models.lock.json'
        self.assertEqual(lock.DEFAULT_LOCK.read_bytes(), public.read_bytes())

    def test_source_checkout_keeps_data_root(self):
        self.assertEqual(lock.default_data_root(), Path(__file__).resolve().parents[2])

    def test_installed_package_requires_explicit_data_root(self):
        with patch.object(lock, '__file__', '/tmp/isolated/site-packages/local_decider/lock.py'):
            with self.assertRaisesRegex(ValueError, '--repo-root'):
                lock.default_data_root()
