"""Tests of handoff utilities only. Every temporary test report below is synthetic."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import validate_evidence as ve
import pack_evidence as pe


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='adl-helper-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'public'
        self.root.mkdir()
        self.report = self.root / 'report.json'
        self.report.write_text('{"synthetic_fixture": true}\n', encoding='utf-8')
        self.path = self.root / 'evidence.manifest.json'
        self.doc = {
            'schema_version': '1', 'project': 'agent-decision-layer',
            'run_id': 'synthetic-helper-test', 'created_at': '2026-09-22T00:00:00Z',
            'source': {'commit': 'a' * 40, 'dirty': False},
            'providers': [{'id': 'mock', 'kind': 'mock', 'synthetic': True, 'model': 'synthetic-test'}],
            'artifacts': [self.artifact('report', 'report.json')],
            'gates': [self.gate('unit')],
        }
        self.save()

    def artifact(self, aid, relative):
        p = self.root / relative
        return {'id': aid, 'path': relative, 'classification': 'public',
                'size_bytes': p.stat().st_size, 'sha256': ve.file_sha256(p)}

    def gate(self, gid, provider=None):
        return {'id': gid, 'kind': ve.GATE_KINDS[gid], 'status': 'PASS',
                'exit_code': 0, 'artifact_ids': ['report'], 'provider_id': provider}

    def save(self):
        self.path.write_text(json.dumps(self.doc, ensure_ascii=False), encoding='utf-8')

    def check(self, profile='collection'):
        self.save()
        return ve.validate(self.path, profile)[1]

    def engineering(self):
        self.doc['gates'] = [self.gate(g) for g in ve.ENGINEERING]

    def local(self):
        self.engineering()
        self.doc['providers'].append({'id': 'local', 'kind': 'local', 'synthetic': False,
          'model': 'synthetic-validator-fixture-not-real-inference', 'model_revision': 'fixture',
          'weights_sha256': 'b' * 64, 'offline_enforced': True, 'offline_method': 'fixture declaration'})
        self.doc['gates'] += [self.gate(g, 'local') for g in ('local-inference','local-offline','semantic-eval','system-eval')]

    def test_valid_collection(self):
        self.assertEqual(self.check(), [])

    def test_nonpass_collection_preserved(self):
        self.doc['gates'][0].update(status='BLOCKED', exit_code=None, reason='Fixture lacks dependency')
        self.assertEqual(self.check(), [])

    def test_engineering_all_required(self):
        self.engineering()
        self.assertEqual(self.check('engineering'), [])

    def test_engineering_missing_gate(self):
        self.assertTrue(self.check('engineering'))

    def test_skipped_not_pass(self):
        self.engineering()
        self.doc['gates'][0].update(status='SKIPPED', reason='not executed')
        self.assertTrue(self.check('engineering'))

    def test_dirty_qualified_rejected(self):
        self.engineering()
        self.doc['source']['dirty'] = True
        self.assertTrue(self.check('engineering'))
        self.assertEqual(self.check('collection'), [])

    def test_missing_sha_rejected(self):
        self.doc['source']['commit'] = 'main'
        self.assertTrue(self.check())

    def test_hash_changed(self):
        self.report.write_text('changed', encoding='utf-8')
        self.assertTrue(any('SHA-256' in e for e in self.check()))

    def test_size_wrong(self):
        self.doc['artifacts'][0]['size_bytes'] += 1
        self.assertTrue(any('size_bytes' in e for e in self.check()))

    def test_private_classification(self):
        self.doc['artifacts'][0]['classification'] = 'private'
        self.assertTrue(self.check())

    def test_path_traversal(self):
        for p in ('../report.json', '/tmp/report.json', 'dir/../report.json', 'dir\\report.json', 'C:/report.json', './report.json', 'a//b', 'a\x00b', 'a./b'):
            with self.subTest(p=p):
                self.doc['artifacts'][0]['path'] = p
                self.assertTrue(self.check())

    def test_private_file_names(self):
        for p in ('.env', '.env.production', '.local/report.json', 'credentials.json', 'model.gguf', 'key.pem'):
            with self.subTest(p=p):
                self.doc['artifacts'][0]['path'] = p
                self.assertTrue(self.check())

    def test_symlink_rejected(self):
        link = self.root / 'linked.json'
        try:
            link.symlink_to(self.report)
        except OSError:
            self.skipTest('platform disallows symlinks')
        self.doc['artifacts'][0]['path'] = 'linked.json'
        self.assertTrue(self.check())

    def test_manifest_symlink_rejected(self):
        link = self.base / 'manifest-link.json'
        try:
            link.symlink_to(self.path)
        except OSError:
            self.skipTest('platform disallows symlinks')
        self.assertTrue(ve.validate(link)[1])

    def test_duplicate_artifact_id(self):
        self.doc['artifacts'].append(copy.deepcopy(self.doc['artifacts'][0]))
        self.assertTrue(self.check())

    def test_duplicate_path(self):
        self.doc['artifacts'].append({**self.doc['artifacts'][0], 'id': 'other'})
        self.assertTrue(self.check())

    def test_manifest_self_reference(self):
        self.doc['artifacts'][0]['path'] = 'evidence.manifest.json'
        self.assertTrue(self.check())

    def test_duplicate_json_key(self):
        self.path.write_text('{"schema_version":"1","schema_version":"1"}')
        self.assertTrue(ve.validate(self.path)[1])

    def test_nan_json_rejected(self):
        self.path.write_text('{"x": NaN}')
        self.assertTrue(ve.validate(self.path)[1])

    def test_invalid_json_rejected(self):
        self.path.write_text('{ broken')
        self.assertTrue(ve.validate(self.path)[1])

    def test_nonobject_root(self):
        self.path.write_text('[]')
        self.assertTrue(ve.validate(self.path)[1])

    def test_timezone_required(self):
        self.doc['created_at'] = '2026-09-22T00:00:00'
        self.assertTrue(self.check())

    def test_mock_cannot_claim_real(self):
        self.doc['providers'][0]['synthetic'] = False
        self.assertTrue(self.check())

    def test_malformed_provider_and_gate_types(self):
        for kind in (None, [], {}, 9):
            with self.subTest(kind=kind):
                self.doc['providers'][0]['kind'] = kind
                self.assertTrue(self.check())
        del self.doc['providers'][0]['kind']
        self.assertTrue(self.check())
        for field in ('kind', 'status', 'provider_id'):
            for value in ([], {}):
                with self.subTest(field=field, value=value):
                    self.doc['gates'][0][field] = value
                    self.assertTrue(self.check())

    def test_pass_requires_integer_zero(self):
        for value in (True, '0', 1, None):
            self.doc['gates'][0]['exit_code'] = value
            self.assertTrue(self.check())

    def test_nonpass_requires_nonempty_reason(self):
        self.doc['gates'][0]['status'] = 'FAIL'
        for value in (None, '', '  '):
            self.doc['gates'][0]['reason'] = value
            self.assertTrue(self.check())

    def test_missing_artifact_reference(self):
        self.doc['gates'][0]['artifact_ids'] = ['absent']
        self.assertTrue(self.check())

    def test_wrong_kind_cannot_satisfy_gate(self):
        self.doc['gates'][0]['kind'] = 'host'
        self.assertTrue(self.check())

    def test_unknown_provider_reference(self):
        self.doc['gates'][0]['provider_id'] = 'unknown'
        self.assertTrue(self.check())

    def test_local_declaration_complete(self):
        self.local()
        self.assertEqual(self.check('local-qualified'), [])

    def test_local_mock_not_qualified(self):
        self.local()
        self.doc['providers'][1]['synthetic'] = True
        self.assertTrue(self.check('local-qualified'))

    def test_local_requires_offline(self):
        self.local()
        self.doc['providers'][1]['offline_enforced'] = False
        self.assertTrue(self.check('local-qualified'))

    def test_local_requires_weights(self):
        self.local()
        self.doc['providers'][1]['weights_sha256'] = None
        self.assertTrue(self.check('local-qualified'))

    def test_same_provider_for_quality(self):
        self.local()
        self.doc['gates'][-1]['provider_id'] = 'mock'
        self.assertTrue(self.check('local-qualified'))

    def test_invalid_provider_id_qualified_is_error_not_crash(self):
        self.local()
        self.doc['gates'][-4]['provider_id'] = []
        self.assertTrue(self.check('local-qualified'))

    def test_cloud_declaration(self):
        self.engineering()
        self.doc['providers'].append({'id':'cloud','kind':'typesafe','synthetic':False,'model':'fixture-only'})
        self.doc['gates'] += [self.gate(g,'cloud') for g in ('cloud-inference','semantic-eval','system-eval')]
        self.assertEqual(self.check('cloud-qualified'), [])
        self.assertTrue(self.check('local-qualified'))

    def test_pack_whitelist_only(self):
        (self.root / 'not-listed-secret.txt').write_text('synthetic excluded content')
        out = self.base / 'package.zip'
        result = pe.pack(self.path, out, 'collection')
        self.assertEqual(result['uploaded'], 'false')
        with zipfile.ZipFile(out) as z:
            self.assertEqual(set(z.namelist()), {'evidence.manifest.json', 'report.json'})
            self.assertEqual(hashlib.sha256(z.read('report.json')).hexdigest(), self.doc['artifacts'][0]['sha256'])

    def test_pack_deterministic_in_same_environment(self):
        a,b = self.base/'a.zip',self.base/'b.zip'
        pe.pack(self.path,a,'collection'); pe.pack(self.path,b,'collection')
        self.assertEqual(a.read_bytes(),b.read_bytes())

    def test_pack_no_overwrite(self):
        out=self.base/'exists.zip';out.write_text('keep me')
        with self.assertRaises(ValueError): pe.pack(self.path,out,'collection')
        self.assertEqual(out.read_text(),'keep me')

    def test_pack_not_inside_staging(self):
        with self.assertRaises(ValueError): pe.pack(self.path,self.root/'bad.zip','collection')

    def test_pack_validation_failure_has_no_output(self):
        out=self.base/'invalid.zip'
        with self.assertRaises(ValueError): pe.pack(self.path,out,'engineering')
        self.assertFalse(out.exists())

    def test_pack_refuses_changed_content_and_cleans(self):
        out=self.base/'raced.zip'
        original=pe.safe_artifact_path
        def change_then_resolve(root, relative):
            self.report.write_text('changed during packaging')
            return original(root,relative)
        with patch.object(pe,'safe_artifact_path',side_effect=change_then_resolve):
            with self.assertRaises(ValueError): pe.pack(self.path,out,'collection')
        self.assertFalse(out.exists())

    def test_cli_reports_validity_not_test_truth(self):
        proc=subprocess.run([sys.executable,str(ROOT/'scripts/validate_evidence.py'),str(self.path)],capture_output=True,text=True,check=False)
        self.assertEqual(proc.returncode,0)
        result=json.loads(proc.stdout)
        self.assertIn('not proof',result['scope'])
        self.assertEqual(result['validation'],'PASS')

    def test_cli_missing_manifest_nonzero(self):
        proc=subprocess.run([sys.executable,str(ROOT/'scripts/validate_evidence.py'),str(self.base/'absent')],capture_output=True,text=True,check=False)
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual(json.loads(proc.stdout)['validation'],'FAIL')

    def test_collection_can_report_inconclusive(self):
        self.doc['gates'][0].update(status='INCONCLUSIVE',exit_code=2,reason='insufficient sample')
        self.assertEqual(self.check(),[])


if __name__ == '__main__':
    unittest.main()
