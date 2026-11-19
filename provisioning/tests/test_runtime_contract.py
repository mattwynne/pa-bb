"""Portable bootstrap and service safety contracts; no real package operations."""
from pathlib import Path
import unittest
import yaml
from jinja2 import Environment

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'roles/pa_bb_runtime'


class RuntimeContractTests(unittest.TestCase):
    def test_existing_tools_are_never_upgraded_or_overwritten(self):
        tasks = yaml.safe_load((RUNTIME / 'tasks/tool.yml').read_text())
        install = next(t for t in tasks if t['name'] == 'Install only an absent runtime tool')
        self.assertEqual(install['when'], 'not pa_bb_tool_path.stat.exists')
        self.assertIn('creates', install['ansible.builtin.command'])
        refuse = next(t for t in tasks if t['name'] == 'Refuse to overwrite a broken installed runtime')
        guard = Environment().compile_expression(refuse['ansible.builtin.assert']['that'])
        self.assertTrue(guard(pa_bb_tool_path={'stat': {'exists': False}}))
        self.assertTrue(guard(pa_bb_tool_path={'stat': {'exists': True}}, pa_bb_tool_before={'rc': 0}))
        self.assertFalse(guard(pa_bb_tool_path={'stat': {'exists': True}}, pa_bb_tool_before={'rc': 1}))
        self.assertFalse(any('notify' in t for t in tasks))

    def test_ordinary_application_setup_has_no_restart_handler(self):
        source = (RUNTIME / 'tasks/main.yml').read_text()
        self.assertNotIn('notify:', source)
        self.assertNotIn('state: restarted', source)
        self.assertIn('Refuse implicit startup', source)
        self.assertIn('installKind', source)
        self.assertIn('force: false', source)

    def test_stock_service_preserves_native_updates_without_private_defaults(self):
        source = (RUNTIME / 'templates/bb.service.j2').read_text()
        self.assertIn('--in-app-updates', source)
        self.assertIn('{{ pa_bb_user }}', source)
        self.assertIn('{{ pa_bb_home }}', source)
        self.assertNotIn('/home/', source)
        self.assertNotIn('fork', source)

    def test_codex_only_inspects_login_and_never_exposes_its_output(self):
        tasks = yaml.safe_load((RUNTIME / 'tasks/codex.yml').read_text())
        check = next(t for t in tasks if t['name'] == 'Check Codex login without exposing account details')
        self.assertEqual(check['ansible.builtin.command']['argv'][-2:], ['login', 'status'])
        self.assertTrue(check['no_log'])
        fail = Environment().compile_expression(check['failed_when'])
        for rc, text, expected in [(0, 'Signed in', False), (1, 'Not logged in', False), (1, 'PRIVATE FAILURE', True), (127, 'Not found', True)]:
            self.assertEqual(fail(pa_bb_codex_login={'rc': rc, 'stdout': '', 'stderr': text}), expected)
        for task in tasks:
            self.assertNotIn('auth.json', str(task))
            self.assertNotIn('notify', task)
            if 'ansible.builtin.debug' in task:
                self.assertNotIn('.stdout', str(task['ansible.builtin.debug']))
                self.assertNotIn('.stderr', str(task['ansible.builtin.debug']))

    def test_workspace_launchers_keep_pins_and_refuse_partial_installations(self):
        source = (RUNTIME / 'tasks/uv.yml').read_text()
        self.assertIn('workspace_uv_version: "0.13.7"', source)
        self.assertIn('c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83', source)
        self.assertIn('workspace_uv_paths.results[0].stat.exists == workspace_uv_paths.results[1].stat.exists', source)
        self.assertIn('unsafe_writes: false', source)
        for unwanted in ['systemctl', 'notify:', 'pip install', 'auth.json', 'refresh_token']:
            self.assertNotIn(unwanted, source)

    def test_dev_mode_uses_native_commands_and_never_enables_plugins(self):
        role = ROOT / 'roles/pa_bb_development'
        self.assertTrue(yaml.safe_load((role / 'defaults/main.yml').read_text())['pa_bb_dev_mode'])
        service = (role / 'templates/plugin.service.j2').read_text()
        self.assertIn('plugin dev', service)
        self.assertIn('PartOf={{ pa_bb_service_name }}.service pa-bb-dev.target', service)
        self.assertIn('User={{ pa_bb_user }}', service)
        tasks = (role / 'tasks/main.yml').read_text()
        self.assertIn("selectattr('enabled')", tasks)
        for unwanted in ['plugin enable', 'plugin disable', 'plugin install', 'pkill', 'killall', 'state: restarted']:
            self.assertNotIn(unwanted, tasks)
        self.assertFalse((role / 'handlers/main.yml').exists())

    def test_read_only_manifest_script_never_fetches_or_mutates_git(self):
        source = (ROOT / 'roles/pa_bb_plugins/files/manifest.py').read_text()
        for command in ["'fetch'", "'pull'", "'reset'", "'checkout'", "'switch'", "'stash'", "'merge'"]:
            self.assertNotIn(command, source)
        self.assertIn("'ls-tree'", source)
        self.assertIn("'show'", source)
