import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('check_vulnerabilities.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def report(*vulnerabilities):
    return {'SchemaVersion': 2, 'Results': [{'Vulnerabilities': list(vulnerabilities)}, {},
                                         {'Vulnerabilities': None}]}


class VulnerabilityGateTests(unittest.TestCase):
    def run_gate(self, contents):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            path.write_text(contents)
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                code = gate.main([str(path)])
        self.assertNotIn('PRIVATE_SENTINEL', output.getvalue())
        return code, output.getvalue()

    def test_fixable_high_and_critical_block_but_keep_occurrence_counts(self):
        data = report({'Severity': 'CRITICAL', 'FixedVersion': '2.0'},
                      {'Severity': 'HIGH', 'FixedVersion': '1.1'},
                      {'Severity': 'HIGH', 'FixedVersion': '1.1'})
        code, output = self.run_gate(json.dumps(data))
        self.assertEqual(code, 2)
        self.assertIn('CRITICAL=1, HIGH=2', output)

    def test_unfixed_and_lower_severity_findings_remain_report_only(self):
        data = report({'Severity': 'CRITICAL'}, {'Severity': 'HIGH', 'FixedVersion': ''},
                      {'Severity': 'MEDIUM', 'FixedVersion': '2.0'},
                      {'Severity': 'LOW', 'FixedVersion': '1.1'},
                      {'Severity': 'UNKNOWN'})
        self.assertEqual(self.run_gate(json.dumps(data))[0], 0)
        self.assertEqual(self.run_gate(json.dumps(report()))[0], 0)

    def test_malformed_or_unsupported_reports_fail_closed_without_echoing_content(self):
        for data in [None, [], {}, {'SchemaVersion': 3, 'Results': []},
                     {'SchemaVersion': 2, 'Results': [None]},
                     {'SchemaVersion': 2, 'Results': [{'Vulnerabilities': 'PRIVATE_SENTINEL'}]},
                     report('PRIVATE_SENTINEL'), report({'Severity': 'PRIVATE_SENTINEL'}),
                     report({'Severity': ['HIGH']}), report({'Severity': 'HIGH', 'FixedVersion': None})]:
            with self.subTest(data=data):
                self.assertEqual(self.run_gate(json.dumps(data))[0], 1)
        self.assertEqual(self.run_gate('PRIVATE_SENTINEL not JSON')[0], 1)

    def test_missing_report_is_an_operational_error(self):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(output):
            self.assertEqual(gate.main([str(Path(directory) / 'missing.json')]), 1)
        self.assertIn('unreadable', output.getvalue())
