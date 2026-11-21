import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('entrypoint', Path(__file__).with_name('entrypoint.py'))
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)


class StartupTests(unittest.TestCase):
    def test_inventory_uses_package_names_not_directory_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / 'plugins' / 'arbitrary-directory'
            plugin.mkdir(parents=True)
            (plugin / 'package.json').write_text(json.dumps({
                'name': '@pa/bb-plugin-example', 'bb': {},
            }))
            with patch.object(entrypoint, 'ROOT', root):
                self.assertEqual(entrypoint.inventory(), {
                    'example': 'path:' + str(plugin),
                    'browser-automation': 'builtin:browser-automation',
                })

    def test_empty_inventory_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(entrypoint, 'ROOT', Path(directory)):
                with self.assertRaises(RuntimeError):
                    entrypoint.inventory()

    def run_registration(self, before, desired, failure=False):
        installed = copy.deepcopy(before)
        installs = []

        def cli(*args):
            if args[:2] == ('plugin', 'list'):
                return {'plugins': copy.deepcopy(installed)}
            self.assertEqual(args[:2], ('plugin', 'install'))
            installs.append(args[2])
            if failure:
                raise RuntimeError('uncertain installation')
            identity = next(key for key, value in desired.items() if value == args[2])
            installed.append({'id': identity, 'source': args[2], 'enabled': True})
            return {}

        with patch.object(entrypoint, 'inventory', return_value=desired), \
                patch.object(entrypoint, 'cli', side_effect=cli):
            entrypoint.register_plugins()
        return installs, installed

    def test_fresh_install_and_repeat(self):
        desired = {'one': 'path:/opt/pa-bb/plugins/one',
                   'browser-automation': 'builtin:browser-automation'}
        installs, after = self.run_registration([], desired)
        self.assertEqual(installs, list(desired.values()))
        installs, repeated = self.run_registration(after, desired)
        self.assertEqual(installs, [])
        self.assertEqual(repeated, after)

    def test_disabled_independent_and_retired_plugins_preserved(self):
        before = [
            {'id': 'one', 'source': 'path:/opt/pa-bb/plugins/one', 'enabled': False},
            {'id': 'other', 'source': 'npm:other', 'enabled': True},
            {'id': 'retired', 'source': 'path:/opt/pa-bb/plugins/retired', 'enabled': False},
        ]
        installs, after = self.run_registration(before, {'one': before[0]['source']})
        self.assertEqual(installs, [])
        self.assertEqual(after, before)

    def test_source_mismatch_refused_before_any_mutation(self):
        with patch.object(entrypoint, 'inventory', return_value={
                'new': 'path:/new', 'existing': 'path:/expected'}), \
                patch.object(entrypoint, 'cli', return_value={'plugins': [
                    {'id': 'existing', 'source': 'npm:existing', 'enabled': True},
                ]}) as cli:
            with self.assertRaisesRegex(RuntimeError, 'source mismatch'):
                entrypoint.register_plugins()
            self.assertEqual(cli.call_count, 1)

    def test_uncertain_install_not_retried(self):
        with patch.object(entrypoint, 'inventory', return_value={'one': 'path:/one'}), \
                patch.object(entrypoint, 'cli', side_effect=[
                    {'plugins': []}, RuntimeError('uncertain'),
                ]) as cli:
            with self.assertRaisesRegex(RuntimeError, 'uncertain'):
                entrypoint.register_plugins()
            self.assertEqual(cli.call_count, 2)

    def test_nonzero_cli_output_is_not_leaked(self):
        import subprocess
        with patch.object(entrypoint.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 1, 'PRIVATE', 'SECRET')):
            with self.assertRaises(RuntimeError) as error:
                entrypoint.cli('plugin', 'list', '--json')
            self.assertNotIn('PRIVATE', str(error.exception))
            self.assertNotIn('SECRET', str(error.exception))


if __name__ == '__main__':
    unittest.main()
