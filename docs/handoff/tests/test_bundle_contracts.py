"""Consistency checks for this specification bundle, not application tests."""
from __future__ import annotations
import csv
import json
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import validate_evidence as ve

class BundleContractTests(unittest.TestCase):
    def test_all_json_parse(self):
        for path in sorted(ROOT.rglob('*.json')):
            with self.subTest(path=path.relative_to(ROOT)):
                json.loads(path.read_text(encoding='utf-8'),object_pairs_hook=ve._unique_object,parse_constant=ve._reject_constant)

    def test_tasks_are_dag_not_execution_results(self):
        tasks=json.loads((ROOT/'contracts/tasks.json').read_text())
        self.assertFalse(tasks['isExecutionResult'])
        nodes={t['id']:t for t in tasks['milestones']}
        self.assertEqual(len(nodes),9)
        visited=set()
        def visit(key,stack):
            self.assertIn(key,nodes)
            self.assertNotIn(key,stack)
            if key in visited:return
            for dep in nodes[key]['dependsOn']:visit(dep,stack|{key})
            visited.add(key)
        for key,row in nodes.items():
            self.assertEqual(row['status'],'TODO');visit(key,set())

    def test_test_matrix_has_74_pending_cases(self):
        with (ROOT/'contracts/test-matrix.csv').open(encoding='utf-8',newline='') as f:
            rows=list(csv.DictReader(f))
        self.assertEqual(len(rows),74)
        self.assertEqual(len({r['id'] for r in rows}),74)
        for row in rows:
            self.assertEqual(row['status'],'NOT_RUN')
            self.assertEqual(row['evidence_kind'],ve.GATE_KINDS[row['gate']])
            self.assertTrue(row['expected'])

    def test_samples_explicitly_synthetic(self):
        samples=[json.loads(line) for line in (ROOT/'examples/decision-cases.jsonl').read_text().splitlines()]
        self.assertEqual(len(samples),10)
        self.assertEqual(len({r['id'] for r in samples}),10)
        for row in samples:
            self.assertIs(row['synthetic'],True)
            self.assertEqual(row['split'],'development-only')

    def test_default_off_not_auto_upload(self):
        conf=json.loads((ROOT/'templates/adl.config.example.json').read_text())
        self.assertEqual(conf['mode'],'off');self.assertEqual(conf['egress']['mode'],'deny')
        for feature in conf['features'].values():self.assertFalse(feature['enabled'])
        plan=json.loads((ROOT/'templates/upload-plan.example.json').read_text())
        self.assertFalse(plan['authorized'])

    def test_pins_are_exact(self):
        data=json.loads((ROOT/'contracts/sources.lock.json').read_text())
        for repo in data['repositories']:self.assertRegex(repo['ref'],r'^[0-9a-f]{40}$')
        self.assertEqual(data['implementationVerification'],'NOT_RUN')

    def test_unfilled_manifest_not_pass(self):
        _,errors=ve.validate(ROOT/'templates/evidence.manifest.template.json')
        self.assertTrue(errors)

    def test_types_do_not_import_host(self):
        code=(ROOT/'contracts/core-types.ts').read_text()
        self.assertNotIn('from ',code)
        self.assertIn("'INSUFFICIENT_CONTEXT'",code)
        self.assertIn("'abstain' | 'ask' | 'deny' | 'cancel'",code)

if __name__=='__main__':unittest.main()
