"""Credential references retain their meaning across the Jev spelling correction."""
import contextlib
import io
import unittest
from unittest.mock import MagicMock, patch
from local_decider import service
from local_decider.lock import default_lock_path

class NamingTest(unittest.TestCase):
    def run_service(self, environment, argv=()):
        server = MagicMock()
        server.server_address = ('127.0.0.1', 12345)
        with patch.dict('os.environ', environment, clear=True), patch.object(service, 'load_lock'), \
             patch.object(service.LocalScorer, 'load'), patch.object(service, 'Decider'), \
             patch.object(service.signal, 'signal'), patch.object(service, 'serve', return_value=server) as serve, \
             contextlib.redirect_stderr(io.StringIO()):
            result = service.main(list(argv))
        return result, serve

    def test_new_token_name_is_used(self):
        result, serve = self.run_service({'JEV_LOCAL_TOKEN': 'synthetic-new'})
        self.assertEqual(result, 0)
        self.assertEqual(serve.call_args.args[3], 'synthetic-new')

    def test_legacy_token_name_remains_supported(self):
        result, serve = self.run_service({'JEY_LOCAL_TOKEN': 'synthetic-legacy'})
        self.assertEqual(result, 0)
        self.assertEqual(serve.call_args.args[3], 'synthetic-legacy')

    def test_new_token_wins(self):
        result, serve = self.run_service({'JEV_LOCAL_TOKEN': 'synthetic-new', 'JEY_LOCAL_TOKEN': 'synthetic-legacy'})
        self.assertEqual(result, 0)
        self.assertEqual(serve.call_args.args[3], 'synthetic-new')

    def test_empty_new_token_does_not_fall_back(self):
        result, serve = self.run_service({'JEV_LOCAL_TOKEN': '', 'JEY_LOCAL_TOKEN': 'synthetic-legacy'})
        self.assertEqual(result, 2)
        serve.assert_not_called()

    def test_explicit_variable_is_respected(self):
        result, serve = self.run_service({'JEY_LOCAL_TOKEN': 'synthetic-legacy'}, ['--token-env', 'JEV_LOCAL_TOKEN'])
        self.assertEqual(result, 2)
        serve.assert_not_called()

    def test_model_lock_aliases(self):
        with patch.dict('os.environ', {'JEY_MODEL_LOCK': '/tmp/legacy-lock'}, clear=True):
            self.assertEqual(str(default_lock_path()), '/tmp/legacy-lock')
        with patch.dict('os.environ', {'JEV_MODEL_LOCK': '/tmp/new-lock', 'JEY_MODEL_LOCK': '/tmp/legacy-lock'}, clear=True):
            self.assertEqual(str(default_lock_path()), '/tmp/new-lock')
