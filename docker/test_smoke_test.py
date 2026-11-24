import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke_test', Path(__file__).with_name('smoke_test.py'))
smoke_test = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke_test)


class Clock:
    now = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeDocker:
    """Model only the public Docker subprocess boundary; never contact a daemon."""
    def __init__(self, smoke):
        self.smoke = smoke
        self.commands = []
        self.resources = {}
        self.states = [{'Status': 'running', 'Health': {'Status': 'healthy'}}]
        self.logs = [smoke_test.REGISTRATION_COMPLETE]
        self.expected = {'one': 'path:/opt/pa-bb/plugins/one',
                         'browser-automation': 'builtin:browser-automation'}
        self.plugins = [{'id': key, 'source': value, 'enabled': True}
                        for key, value in self.expected.items()]
        self.gtk_failure = False
        self.search = {'version': 1, 'available': True, 'matches': 2}
        self.search_failure = False
        self.email = {'version': 1, 'available': True, 'messages': 1, 'isolated': True, 'read': True}
        self.email_failure = False
        self.timeouts = []
        self.failures = {}
        self.after_write = {}

    @staticmethod
    def next_value(values):
        return values.pop(0) if len(values) > 1 else values[0]

    def run(self, command, *, capture_output, text, errors, timeout):
        assert command[0] == 'docker'
        assert capture_output and text and errors == 'replace' and 0 < timeout <= 90
        args = command[1:]
        self.commands.append(args)
        self.timeouts.append(timeout)
        key = tuple(args[:2])
        if key in self.failures:
            return self.fail(self.failures[key], command)
        kind, operation = key
        output = ''
        if key == ('image', 'inspect'):
            output = 'sha256:' + 'a' * 64
        elif operation == 'ls':
            name = self.smoke.container if kind == 'container' else self.smoke.volume
            output = name if (kind, name) in self.resources else ''
        elif operation == 'create':
            name = args[args.index('--name') + 1] if kind == 'container' else args[-1]
            self.resources[kind, name] = self.smoke.owner
            output = name
        elif operation == 'inspect':
            if args[3] == '{{json .State}}':
                output = json.dumps(self.next_value(self.states))
            else:
                output = json.dumps({smoke_test.OWNER_LABEL: self.resources[kind, args[-1]]})
        elif operation in {'start', 'stop'}:
            pass
        elif operation == 'rm':
            del self.resources[kind, args[-1]]
        elif operation == 'logs':
            output = self.next_value(self.logs)
        elif operation == 'exec':
            if args[3:] == ['python3', '-c', 'import ctypes; ctypes.CDLL("libgtk-3.so.0")']:
                if self.gtk_failure:
                    return self.fail(True, command)
            elif args[3] == 'python3':
                assert args[-1] == smoke_test.INVENTORY_SCRIPT
                output = json.dumps(self.expected)
            elif args[4] == smoke_test.CLI:
                output = json.dumps({'plugins': self.plugins})
            elif args[-1] == '/opt/pa-bb/docker/email-smoke.mjs':
                if self.email_failure:
                    return self.fail(True, command)
                output = json.dumps(self.email)
            else:
                if self.search_failure:
                    return self.fail(True, command)
                output = json.dumps(self.search)
        else:
            raise AssertionError(f'Unexpected Docker command: {args}')
        if key in self.after_write:
            return self.fail(self.after_write[key], command)
        return subprocess.CompletedProcess(command, 0, output, '')

    @staticmethod
    def fail(failure, command):
        if callable(failure):
            failure()
        if isinstance(failure, BaseException):
            raise failure
        return subprocess.CompletedProcess(command, 1, 'PRIVATE_OUTPUT', 'SECRET_TOKEN')


class SmokeTestTests(unittest.TestCase):
    def setUp(self):
        self.smoke = smoke_test.SmokeTest('local:test', timeout=5)
        self.docker = FakeDocker(self.smoke)
        self.clock = Clock()
        self.patches = [patch.object(smoke_test.subprocess, 'run', side_effect=self.docker.run),
                        patch.object(smoke_test.time, 'monotonic', side_effect=self.clock.monotonic),
                        patch.object(smoke_test.time, 'sleep', side_effect=self.clock.sleep)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def assert_cleaned(self):
        self.assertEqual(self.docker.resources, {})
        removed = [command[:2] for command in self.docker.commands if command[1] == 'rm']
        self.assertEqual(removed, [['container', 'rm'], ['volume', 'rm']])

    def assert_failure(self, message):
        with self.assertRaisesRegex(smoke_test.SmokeError, message) as raised:
            self.smoke.run()
        self.assertNotIn('PRIVATE_OUTPUT', str(raised.exception))
        self.assertNotIn('SECRET_TOKEN', str(raised.exception))
        return str(raised.exception)

    def test_success_uses_fresh_named_resources_and_required_options(self):
        self.assertEqual(self.smoke.run(), 2)
        create = next(c for c in self.docker.commands if c[:2] == ['container', 'create'])
        self.assertEqual(create[create.index('--name') + 1], self.smoke.container)
        self.assertIn('type=volume,source=' + self.smoke.volume + ',target=/home/bb', create)
        for option in ['linux/amd64', '--shm-size=1g', '--stop-timeout=60', '--pull=never']:
            self.assertIn(option, create)
        self.assertEqual(create[-1], 'sha256:' + 'a' * 64)
        self.assertFalse(any(option in create for option in ['-p', '-P', '--publish', '--publish-all']))
        self.assertNotEqual(self.smoke.container, smoke_test.SmokeTest('local:test').container)
        self.assert_cleaned()

    def test_note_search_capability_and_real_matches_are_required(self):
        variants = [None, 'PRIVATE_OUTPUT SECRET_TOKEN',
                    {'version': 1, 'available': False, 'reason': 'unsupported_version'},
                    {'version': 1, 'available': True, 'matches': 0},
                    {'version': 1, 'available': True, 'matches': 1},
                    {'version': 1, 'available': 1, 'matches': 2},
                    {'version': 2, 'available': True, 'matches': 2}]
        for result in variants:
            with self.subTest(result=result):
                self.docker.search = result
                self.assert_failure('Note-search capability')
                self.assertEqual(self.docker.resources, {})

    def test_search_command_failure_is_safe_and_cleans_up(self):
        self.docker.search_failure = True
        self.assert_failure('Note-search capability')
        self.assert_cleaned()

    def test_gtk_loader_failure_is_safe_and_cleans_up(self):
        self.docker.gtk_failure = True
        self.assert_failure('GTK 3 shared library could not be loaded')
        self.assert_cleaned()

    def test_success_executes_plugin_search_with_its_typescript_loader(self):
        self.assertEqual(self.smoke.run(), 2)
        search = next(c for c in self.docker.commands if c[:2] == ['container', 'exec']
                      and '--import' in c)
        self.assertIn('/opt/pa-bb/plugins/icloud/node_modules/tsx/dist/loader.mjs', search)
        self.assertIn('--input-type=module', search)
        self.assert_cleaned()

    def test_email_archive_read_import_and_isolation_are_required(self):
        variants = [None, 'PRIVATE_OUTPUT SECRET_TOKEN',
                    dict(self.docker.email, available=False),
                    dict(self.docker.email, messages=0),
                    dict(self.docker.email, messages=2),
                    dict(self.docker.email, messages=True),
                    dict(self.docker.email, version=2),
                    dict(self.docker.email, isolated=False),
                    dict(self.docker.email, read=False),
                    dict(self.docker.email, available=1)]
        for result in variants:
            with self.subTest(result=result):
                self.docker.email = result
                self.assert_failure('Email-archive capability')
                self.assertEqual(self.docker.resources, {})

    def test_email_command_failure_is_safe_and_cleans_up(self):
        self.docker.email_failure = True
        self.assert_failure('Email-archive capability')
        self.assert_cleaned()

    def test_email_check_has_a_bounded_budget_within_the_shared_deadline(self):
        self.smoke.timeout = 120
        self.assertEqual(self.smoke.run(), 2)
        index = next(i for i, c in enumerate(self.docker.commands)
                     if c[-1] == '/opt/pa-bb/docker/email-smoke.mjs')
        self.assertIn('--experimental-transform-types', self.docker.commands[index])
        self.assertEqual(self.docker.timeouts[index], 90)
        self.assert_cleaned()

    def test_extra_stock_plugins_are_allowed(self):
        self.docker.plugins.append({'id': 'stock', 'source': 'builtin:stock', 'enabled': False})
        self.assertEqual(self.smoke.run(), 2)
        self.assert_cleaned()

    def test_http_health_without_registration_times_out(self):
        self.docker.logs = ['HTTP ready PRIVATE_OUTPUT SECRET_TOKEN']
        self.assert_failure('Timed out')
        self.assertLessEqual(self.clock.now, 5)
        self.assertFalse(any(c[1] == 'exec' for c in self.docker.commands))
        self.assert_cleaned()

    def test_registration_without_healthy_state_times_out(self):
        self.docker.states[0]['Health']['Status'] = 'starting'
        self.assert_failure('Timed out')
        self.assert_cleaned()

    def test_registration_marker_is_latched_until_docker_healthy(self):
        self.docker.states.insert(0, {'Status': 'running', 'Health': {'Status': 'starting'}})
        self.docker.logs.append('later log output')
        self.assertEqual(self.smoke.run(), 2)
        self.assertEqual(self.clock.now, 2)
        self.assert_cleaned()

    def test_missing_healthcheck_cannot_pass(self):
        self.docker.states = [{'Status': 'running'}]
        self.assert_failure('Timed out')
        self.assert_cleaned()

    def test_early_exit_and_unhealthy_fail_immediately(self):
        for state, message in [({'Status': 'exited', 'ExitCode': 1}, 'exited'),
                               ({'Status': 'running', 'Health': {'Status': 'unhealthy'}}, 'unhealthy')]:
            with self.subTest(state=state):
                self.docker.states = [state]
                self.assert_failure(message)
                self.assertEqual(self.clock.now, 0)
                self.assertEqual(self.docker.resources, {})

    def test_startup_failure_marker_fails_even_if_healthy(self):
        self.docker.logs = ['PA startup failed: PRIVATE_OUTPUT SECRET_TOKEN']
        self.assert_failure('Entrypoint reported startup failure')
        self.assert_cleaned()

    def test_plugin_missing_wrong_source_disabled_and_duplicate_fail(self):
        original = list(self.docker.plugins)
        variants = [original[1:],
                    [dict(original[0], source='npm:wrong'), original[1]],
                    [dict(original[0], enabled=False), original[1]],
                    [dict(original[0], enabled=1), original[1]],
                    original + [original[0]]]
        for plugins in variants:
            with self.subTest(plugins=plugins):
                self.docker.plugins = plugins
                self.assert_failure('plugin|identity')
                self.assertEqual(self.docker.resources, {})

    def test_malformed_plugin_response_is_safe(self):
        self.docker.plugins = ['PRIVATE_OUTPUT SECRET_TOKEN']
        self.assert_failure('Invalid installed plugin identity')
        self.assert_cleaned()

    def test_verification_exec_command_failure_is_safe_and_cleans_up(self):
        self.docker.failures['container', 'exec'] = True
        self.assert_failure('Docker container command failed')
        self.assert_cleaned()

    def test_invalid_inventory_response_is_safe_and_cleans_up(self):
        self.docker.expected = 'PRIVATE_OUTPUT SECRET_TOKEN'
        self.assert_failure('Invalid image inventory')
        self.assert_cleaned()

    def test_unexpected_failure_is_suppressed_and_cleans_up(self):
        self.docker.failures['container', 'start'] = ValueError('PRIVATE_OUTPUT SECRET_TOKEN')
        self.assert_failure('Unexpected smoke-test failure')
        self.assert_cleaned()

    def test_start_command_failure_still_cleans_both_resources(self):
        self.docker.failures['container', 'start'] = True
        self.assert_failure('Docker container command failed')
        self.assert_cleaned()

    def test_timed_out_create_cleans_resource_created_by_daemon(self):
        self.docker.after_write['container', 'create'] = subprocess.TimeoutExpired('docker', 60)
        self.assert_failure('timed out')
        self.assert_cleaned()

    def test_timed_out_volume_create_is_also_cleaned(self):
        self.docker.after_write['volume', 'create'] = subprocess.TimeoutExpired('docker', 30)
        self.assert_failure('timed out')
        self.assertEqual(self.docker.resources, {})
        self.assertFalse(any(c[:2] == ['container', 'create'] for c in self.docker.commands))

    def test_missing_docker_fails_without_cleanup_writes(self):
        self.docker.failures['image', 'inspect'] = FileNotFoundError('PRIVATE_OUTPUT')
        self.assert_failure('unavailable')
        self.assertFalse(any(c[1] in {'create', 'stop', 'rm'} for c in self.docker.commands))

    def test_preexisting_resource_is_never_used_or_removed(self):
        self.docker.resources['volume', self.smoke.volume] = 'another-owner'
        self.assert_failure('already exists')
        self.assertFalse(any(c[1] in {'create', 'stop', 'rm'} for c in self.docker.commands))

    def test_cleanup_refuses_resource_with_changed_ownership(self):
        def replace_owner():
            self.docker.resources['container', self.smoke.container] = 'another-owner'
        self.docker.failures['container', 'start'] = replace_owner
        message = self.assert_failure('Docker container command failed')
        self.assertIn('ownership mismatch', message)
        self.assertIn(('container', self.smoke.container), self.docker.resources)
        self.assertFalse(any(c[:2] == ['container', 'rm'] for c in self.docker.commands))

    def test_cleanup_failure_turns_success_into_failure_and_continues(self):
        self.docker.failures['container', 'stop'] = True
        self.assert_failure('Smoke verification passed.*Cleanup failed')
        self.assert_cleaned()

    def test_unexpected_cleanup_failure_preserves_primary_and_continues(self):
        self.docker.logs = ['PA startup failed: details']
        self.docker.failures['container', 'rm'] = ValueError('PRIVATE_OUTPUT SECRET_TOKEN')
        message = self.assert_failure('Entrypoint reported startup failure')
        self.assertIn('Unexpected cleanup failure', message)
        self.assertTrue(any(c[:2] == ['volume', 'rm'] for c in self.docker.commands))

    def test_cleanup_preserves_primary_failure(self):
        self.docker.logs = ['PA startup failed: details']
        self.docker.failures['container', 'rm'] = True
        self.docker.failures['volume', 'rm'] = True
        message = self.assert_failure('Entrypoint reported startup failure')
        self.assertIn('Cleanup failed', message)
        self.assertEqual(len([c for c in self.docker.commands if c[1] == 'rm']), 2)

    def test_cleanup_inspection_failure_is_reported_without_removal(self):
        self.docker.failures['container', 'logs'] = lambda: self.docker.failures.update({
            ('container', 'ls'): True})
        self.assert_failure('Cleanup failed')
        self.assertFalse(any(c[:2] == ['container', 'rm'] for c in self.docker.commands))

    def test_signals_clean_up_and_restore_handlers(self):
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig):
                prior = signal.getsignal(sig)
                self.docker.failures['container', 'start'] = lambda: signal.getsignal(sig)(sig, None)
                self.assert_failure('Interrupted by signal')
                self.assertEqual(self.docker.resources, {})
                self.assertEqual(signal.getsignal(sig), prior)

    def test_repeated_termination_is_ignored_during_cleanup(self):
        observed = []

        def inspect_handler():
            observed.append(signal.getsignal(signal.SIGTERM))
        self.docker.failures['container', 'stop'] = inspect_handler
        self.assert_failure('Cleanup failed')
        self.assertEqual(observed, [signal.SIG_IGN])
        self.assert_cleaned()

    def test_main_returns_nonzero_on_cleanup_failure_without_raw_output(self):
        self.docker.failures['volume', 'rm'] = True
        output = io.StringIO()
        with patch.object(smoke_test, 'SmokeTest', return_value=self.smoke), \
                contextlib.redirect_stderr(output):
            self.assertEqual(smoke_test.main(['local:test']), 1)
        self.assertIn('Cleanup failed', output.getvalue())
        self.assertNotIn('SECRET_TOKEN', output.getvalue())


class ImageInventoryTests(unittest.TestCase):
    def test_inventory_reads_manifest_names_and_sources_not_directory_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / 'unrelated-directory'
            plugin.mkdir()
            (plugin / 'package.json').write_text(json.dumps({'name': '@pa/bb-plugin-Example_One', 'bb': {}}))
            other = root / 'not-a-plugin'
            other.mkdir()
            (other / 'package.json').write_text(json.dumps({'name': 'ignored'}))
            script = smoke_test.INVENTORY_SCRIPT.replace('/opt/pa-bb/plugins', str(root))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                exec(script, {})
            self.assertEqual(json.loads(output.getvalue()), {
                'example-one': 'path:' + str(plugin),
                'browser-automation': 'builtin:browser-automation',
            })

    def test_empty_image_inventory_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            script = smoke_test.INVENTORY_SCRIPT.replace('/opt/pa-bb/plugins', directory)
            with self.assertRaisesRegex(ValueError, 'Invalid image inventory'):
                exec(script, {})


if __name__ == '__main__':
    unittest.main()
