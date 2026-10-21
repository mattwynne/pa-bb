"""Exercise the real user role with fake CLIs; no server or root package tasks."""
import getpass
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
SENTINEL = 'PRIVATE-PROVIDER-TOKEN-sentinel'


@unittest.skipUnless(shutil.which('ansible-playbook'), 'requires ansible-core 2.16+')
class BrowserRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pa-bb-role-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)
        self.state = self.path / 'state.json'
        self.calls = self.path / 'calls.jsonl'
        self.write_state([])
        cli = self.path / 'bb'
        cli.write_text('''#!/usr/bin/python3
import json, pathlib, sys
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps(args) + '\\n')
state = json.loads((root / 'state.json').read_text())
if (root / 'fail').exists():
    print('PRIVATE-PROVIDER-TOKEN-sentinel', file=sys.stderr)
    sys.exit(1)
if args == ['plugin', 'list', '--json']:
    print(json.dumps({'plugins': state}))
elif args == ['plugin', 'install', 'builtin:browser-automation', '--yes', '--json']:
    if (root / 'fail-install').exists():
        print('PRIVATE-PROVIDER-TOKEN-sentinel', file=sys.stderr)
        sys.exit(1)
    state = [{'id': 'browser-automation', 'source': 'builtin:browser-automation',
              'enabled': True, 'status': 'running'}]
    (root / 'state.json').write_text(json.dumps(state))
    print('{}')
elif args == ['plugin', 'enable', 'browser-automation', '--json']:
    state[0].update(enabled=True, status='running')
    (root / 'state.json').write_text(json.dumps(state))
    print('{}')
else:
    sys.exit(2)
''')
        cli.chmod(0o755)
        for name, output in [('npm', '10.0.0'), ('google-chrome-stable', 'Google Chrome test')]:
            executable = self.path / name
            executable.write_text('#!/bin/sh\necho "' + output + '"\n')
            executable.chmod(0o755)
        play = [{
            'hosts': 'all', 'connection': 'local', 'gather_facts': False,
            'vars': {
                'pa_bb_user': getpass.getuser(), 'pa_bb_home': str(self.path),
                'pa_bb_cli_argv': [str(cli)],
                'pa_bb_user_path': str(self.path) + ':/usr/bin:/bin',
                'ansible_python_interpreter': '/usr/bin/python3',
                'ansible_remote_tmp': str(self.path / 'remote'),
            },
            'roles': ['pa_bb_browser_automation'],
        }]
        self.play = self.path / 'play.yml'
        self.play.write_text(yaml.safe_dump(play))

    def write_state(self, plugins):
        self.state.write_text(json.dumps(plugins))

    def installed(self, enabled=True, source='builtin:browser-automation', status='running'):
        return [{'id': 'browser-automation', 'source': source, 'enabled': enabled,
                 'status': status, 'privateMetadata': SENTINEL}]

    def run_role(self, *args, success=True):
        env = dict(os.environ, ANSIBLE_ROLES_PATH=str(ROOT / 'roles'),
                   ANSIBLE_LOCAL_TEMP=str(self.path / 'local'), ANSIBLE_NOCOLOR='1')
        result = subprocess.run(['ansible-playbook', '-i', 'localhost,', str(self.play), *args],
                                env=env, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=60)
        self.assertEqual(result.returncode == 0, success, result.stdout)
        self.assertNotIn(SENTINEL, result.stdout)
        return result.stdout

    def mutations(self):
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return [call for call in calls if call[:2] != ['plugin', 'list']]

    def test_fresh_install_then_repeat_has_zero_changes(self):
        self.run_role()
        self.assertEqual(self.mutations(), [['plugin', 'install', 'builtin:browser-automation', '--yes', '--json']])
        self.assertIn('changed=0', self.run_role())
        self.assertEqual(len(self.mutations()), 1)

    def test_disabled_plugin_is_enabled_without_reinstall(self):
        self.write_state(self.installed(enabled=False, status='disabled'))
        self.run_role()
        self.assertEqual(self.mutations(), [['plugin', 'enable', 'browser-automation', '--json']])

    def test_check_mode_does_not_install_or_enable(self):
        self.run_role('--check')
        self.assertEqual(self.mutations(), [])
        self.assertEqual(json.loads(self.state.read_text()), [])
        self.write_state(self.installed(enabled=False))
        self.run_role('--check')
        self.assertEqual(self.mutations(), [])

    def test_root_service_user_is_refused(self):
        play = yaml.safe_load(self.play.read_text())
        play[0]['vars']['pa_bb_user'] = 'root'
        self.play.write_text(yaml.safe_dump(play))
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_missing_home_is_refused(self):
        play = yaml.safe_load(self.play.read_text())
        del play[0]['vars']['pa_bb_home']
        self.play.write_text(yaml.safe_dump(play))
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_unexpected_source_is_refused(self):
        self.write_state(self.installed(source='path:/unexpected'))
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_old_npm_is_refused_before_install(self):
        (self.path / 'npm').write_text('#!/bin/sh\necho 9.4.0\n')
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_failed_state_read_does_not_install_or_leak(self):
        (self.path / 'fail').touch()
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_failed_install_is_not_retried_and_does_not_leak(self):
        (self.path / 'fail-install').touch()
        self.run_role(success=False)
        self.assertEqual(len(self.mutations()), 1)

    def test_enabled_but_failed_plugin_does_not_pass_verification(self):
        self.write_state(self.installed(status='error'))
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])


if __name__ == '__main__':
    unittest.main()
