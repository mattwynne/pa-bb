"""Fail publication for fixable HIGH/CRITICAL findings in a Trivy JSON report."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

SEVERITIES = {'UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'}


def fixable_counts(report):
    if (not isinstance(report, dict) or report.get('SchemaVersion') != 2
            or not isinstance(report.get('Results'), list)):
        raise ValueError('Invalid Trivy report')
    counts = Counter()
    for result in report['Results']:
        if not isinstance(result, dict):
            raise ValueError('Invalid Trivy result')
        vulnerabilities = result.get('Vulnerabilities')
        if vulnerabilities is None:
            continue
        if not isinstance(vulnerabilities, list):
            raise ValueError('Invalid vulnerability list')
        for vulnerability in vulnerabilities:
            if not isinstance(vulnerability, dict):
                raise ValueError('Invalid vulnerability')
            severity = vulnerability.get('Severity')
            fixed = vulnerability.get('FixedVersion', '')
            if not isinstance(severity, str) or severity not in SEVERITIES or not isinstance(fixed, str):
                raise ValueError('Invalid vulnerability fields')
            if severity in {'HIGH', 'CRITICAL'} and fixed.strip():
                counts[severity] += 1
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args(argv)
    try:
        counts = fixable_counts(json.loads(args.report.read_text()))
    except (OSError, UnicodeError, ValueError):
        print('Vulnerability gate failed: unreadable, malformed or unsupported Trivy report.', file=sys.stderr)
        return 1
    print(f"Fixable package findings: CRITICAL={counts['CRITICAL']}, HIGH={counts['HIGH']}.")
    if counts:
        print('Publication blocked. Inspect the image-vulnerabilities artifact.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
