"""Git reconciliation and real Ansible execution with synthetic CLIs only."""
import getpass
import grp
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('pa_manifest', ROOT / 'roles/pa_bb_plugins/files/manifest.py')
manifest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manifest)
SENTINEL = 'PRIVATE-account-token-note-sentinel'


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pa-app-test-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve()
        self.repo = self.path / 'repo'
        self.repo.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.package('kept')
        self.git('add', '.')
        self.git('commit', '-qm', 'Generated manifests')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def package(self, directory, name=None):
        path = self.repo / 'plugins' / directory
        path.mkdir(parents=True, exist_ok=True)
        (path / 'package.json').write_text(json.dumps({'name': name or 'bb-plugin-' + directory, 'bb': {'server': './server.ts'}}))
        (path / 'package-lock.json').write_text('{}')
        return path

    def installed(self, identity='kept', enabled=True, source=None):
        return {'id': identity, 'source': source or 'path:' + str(self.repo / 'plugins' / identity),
                'enabled': enabled, 'provenance': 'direct', 'private': SENTINEL}

    def plan(self, installed):
        _, desired = manifest.discover(self.repo)
        return manifest.plan(self.repo, desired, installed)


class ManifestReconciliationTests(GitFixture):
    def test_only_main_manifests_count_not_ignored_or_other_branch_packages(self):
        self.package('ignored')
        self.git('checkout', '-qb', 'development')
        self.package('branch-only')
        self.git('add', 'plugins/branch-only')
        self.git('commit', '-qm', 'Unpublished plugin')
        before = self.git('status', '--porcelain')
        revision, desired = manifest.discover(self.repo)
        self.assertEqual([p['id'] for p in desired], ['kept'])
        self.assertEqual(revision, self.git('rev-parse', 'main'))
        self.assertEqual(self.git('status', '--porcelain'), before)
        self.assertEqual(self.git('branch', '--show-current'), 'development')

    def test_missing_registration_is_planned_without_reinstalling_disabled_plugin(self):
        result = self.plan([self.installed(enabled=False)])
        self.assertTrue(result['plugins'][0]['installed'])
        self.assertFalse(result['plugins'][0]['enabled'])
        self.assertEqual(result['retired'], [])
        self.assertFalse(self.plan([])['plugins'][0]['installed'])

    def test_retired_checkout_path_is_removed_but_independent_sources_are_kept(self):
        result = self.plan([self.installed('retired'), self.installed('hands-free', source='path:' + str(self.path / 'hands-free')),
                            self.installed('external', source='git:https://example.invalid/other.git')])
        self.assertEqual([p['id'] for p in result['retired']], ['retired'])
        self.assertEqual([p['id'] for p in result['preserved']], ['hands-free', 'external'])
        self.assertNotIn(SENTINEL, json.dumps(result))

    def test_same_id_source_transition_is_refused(self):
        with self.assertRaises(manifest.Refusal):
            self.plan([self.installed(source='path:/different-checkout')])

    def test_duplicate_id_is_refused(self):
        self.package('duplicate', 'bb-plugin-kept')
        self.git('add', '.')
        self.git('commit', '-qm', 'Duplicate')
        with self.assertRaises(manifest.Refusal):
            manifest.discover(self.repo)

    def test_changed_working_identity_is_refused_without_overwriting(self):
        self.package('kept', 'bb-plugin-different')
        with self.assertRaises(manifest.Refusal):
            manifest.discover(self.repo)
        self.assertIn('different', (self.repo / 'plugins/kept/package.json').read_text())

    def test_duplicate_installed_id_is_refused(self):
        with self.assertRaises(manifest.Refusal):
            self.plan([self.installed(), self.installed()])

    def test_empty_desired_set_cannot_delete_everything(self):
        self.git('rm', '-qr', 'plugins')
        self.git('commit', '-qm', 'Empty')
        with self.assertRaises(manifest.Refusal):
            manifest.discover(self.repo)

    def test_missing_lock_is_refused(self):
        (self.repo / 'plugins/kept/package-lock.json').unlink()
        with self.assertRaises(manifest.Refusal):
            manifest.discover(self.repo)

    def test_symlink_escape_is_refused(self):
        plugin = self.repo / 'plugins/kept'
        outside = self.path / 'outside'
        plugin.rename(outside)
        plugin.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(manifest.Refusal):
            manifest.discover(self.repo)


@unittest.skipUnless(shutil.which('ansible-playbook'), 'requires ansible-core')
class PluginRoleTests(GitFixture):
    def setUp(self):
        super().setUp()
        self.state = self.path / 'state.json'
        self.state.write_text('[]')
        cli = self.path / 'bb'
        cli.write_text('''#!''' + sys.executable + '''
import json,pathlib,sys
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\\n')
state=json.loads((root/'state.json').read_text())
if (root/'fail').exists():
 print('PRIVATE-account-token-note-sentinel',file=sys.stderr);sys.exit(1)
if args==['plugin','list','--json']: print(json.dumps({'plugins':state}))
elif args[:2]==['plugin','install']:
 path=pathlib.Path(args[2].removeprefix('path:'))
 name=json.loads((path/'package.json').read_text())['name'].removeprefix('bb-plugin-')
 state.append({'id':name,'source':args[2],'enabled':True,'status':'running','provenance':'direct'})
 (root/'state.json').write_text(json.dumps(state)); print('{}')
elif args[:2]==['plugin','remove']:
 state=[p for p in state if p['id']!=args[2]]
 (root/'state.json').write_text(json.dumps(state)); print('{}')
else: sys.exit(2)
''')
        cli.chmod(0o755)
        npm = self.path / 'npm'
        npm.write_text('#!/bin/sh\nif [ -f "' + str(self.path / 'bad-deps') + '" ]; then echo PRIVATE-account-token-note-sentinel; exit 1; fi\necho "{}"\n')
        npm.chmod(0o755)
        self.variables = {
            'pa_bb_user': getpass.getuser(), 'pa_bb_group': grp.getgrgid(os.getgid()).gr_name,
            'pa_bb_home': str(self.path), 'pa_bb_source_dir': str(self.repo),
            'pa_bb_source_repo': 'https://example.invalid/never-cloned', 'pa_bb_source_ref': 'main',
            'pa_bb_cli_argv': [str(cli)], 'pa_bb_user_path': str(self.path) + ':' + os.environ['PATH'],
            'ansible_python_interpreter': sys.executable, 'ansible_become': False,
        }

    def run_role(self, check=False, success=True):
        play = self.path / 'play.yml'
        play.write_text(yaml.safe_dump([{'hosts': 'all', 'connection': 'local', 'gather_facts': False,
                                        'vars': self.variables, 'roles': ['pa_bb_plugins']}]))
        env = dict(os.environ, ANSIBLE_ROLES_PATH=str(ROOT / 'roles'), ANSIBLE_NOCOLOR='1')
        result = subprocess.run(['ansible-playbook', '-i', 'localhost,', str(play)] + (['--check'] if check else []),
                                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        self.assertEqual(result.returncode == 0, success, result.stdout)
        self.assertNotIn(SENTINEL, result.stdout)
        return result.stdout

    def mutations(self):
        calls = self.path / 'calls'
        return [a for a in map(json.loads, calls.read_text().splitlines()) if a[:2] != ['plugin', 'list']] if calls.exists() else []

    def test_fresh_then_repeat_is_zero_changes_and_no_reinstall(self):
        self.run_role()
        self.assertEqual(len(self.mutations()), 1)
        self.assertIn('changed=0', self.run_role())
        self.assertEqual(len(self.mutations()), 1)

    def test_disabled_registration_and_private_state_are_preserved(self):
        self.state.write_text(json.dumps([self.installed(enabled=False)]))
        self.run_role()
        self.assertEqual(self.mutations(), [])
        self.assertEqual(json.loads(self.state.read_text())[0]['private'], SENTINEL)
        self.assertFalse(json.loads(self.state.read_text())[0]['enabled'])

    def test_check_mode_never_installs_or_removes(self):
        self.state.write_text(json.dumps([self.installed('retired')]))
        self.run_role(check=True)
        self.assertEqual(self.mutations(), [])

    def test_missing_backup_refuses_retirement_before_any_install(self):
        self.state.write_text(json.dumps([self.installed('retired')]))
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_reviewed_private_backup_allows_only_retired_pa_removal(self):
        backup = self.path / 'backup.tar'
        backup.write_text('generated fixture')
        backup.chmod(0o600)
        self.variables['pa_bb_retirement_backup'] = str(backup)
        self.state.write_text(json.dumps([self.installed(), self.installed('retired'), self.installed('hands-free', source='path:' + str(self.path / 'hands-free'))]))
        self.run_role()
        self.assertEqual(self.mutations(), [['plugin', 'remove', 'retired', '--json']])
        self.assertIn('changed=0', self.run_role())

    def test_dependency_change_under_running_plugin_is_refused(self):
        self.state.write_text(json.dumps([self.installed()]))
        (self.path / 'bad-deps').touch()
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])

    def test_failed_inventory_read_is_bounded_and_does_not_mutate(self):
        (self.path / 'fail').touch()
        self.run_role(success=False)
        self.assertEqual(self.mutations(), [])


if __name__ == '__main__':
    unittest.main()
