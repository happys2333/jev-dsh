"""The Linux Hub snapshot symlink must not become a dangling model path."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from local_decider.download_weights import run
from local_decider.lock import load_lock

class DownloadTest(unittest.TestCase):
    def test_snapshot_symlink_resolved_before_hard_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'synthetic-gguf-fixture'
            blob = root/'cache/blobs/model'
            blob.parent.mkdir(parents=True)
            blob.write_bytes(data)
            snapshot = root/'cache/snapshots/rev/model.gguf'
            snapshot.parent.mkdir(parents=True)
            snapshot.symlink_to('../../blobs/model')
            raw = json.loads(load_lock().path.read_text())
            raw['weights']['bytes'] = len(data)
            raw['weights']['sha256'] = hashlib.sha256(data).hexdigest()
            lock_path = root/'models.lock.json'
            lock_path.write_text(json.dumps(raw))
            hub = SimpleNamespace(hf_hub_download=lambda *args, **kwargs: str(snapshot))
            with patch.dict('sys.modules', {'huggingface_hub': hub}), patch.dict('os.environ'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(run(lock_path, root, False), 0)
            target = load_lock(lock_path).weights_path(root)
            self.assertTrue(target.is_file())
            self.assertFalse(target.is_symlink())
            self.assertEqual(target.read_bytes(), data)
