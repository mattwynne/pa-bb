"""Disposable local-image check: python3 docker/smoke_test.py IMAGE.

Only generated, labelled resources are inspected or removed. No host home,
accounts, published ports, or provider operations are used.
"""
import argparse
import json
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path


REGISTRATION_COMPLETE = 'PA plugins registered. Connect accounts in BB settings.'
OWNER_LABEL = 'io.pa-bb.smoke'
CLI = '/home/bb/.local/lib/node_modules/bb-app/host-daemon/dist/bb'
# Read manifests independently of entrypoint registration, so verification cannot
# accidentally succeed merely because register_plugins() returned successfully.
INVENTORY_SCRIPT = r'''
import json, pathlib, re
expected = {}
for manifest in sorted(pathlib.Path('/opt/pa-bb/plugins').glob('*/package.json')):
    package = json.loads(manifest.read_text())
    if not isinstance(package.get('bb'), dict):
        continue
    name = package['name'].split('/')[-1].removeprefix('bb-plugin-').lower()
    identity = re.sub('[^a-z0-9-]', '-', name).strip('-')
    if not identity or identity in expected:
        raise ValueError('Invalid image inventory')
    expected[identity] = 'path:' + str(manifest.parent)
if not expected or 'browser-automation' in expected:
    raise ValueError('Invalid image inventory')
expected['browser-automation'] = 'builtin:browser-automation'
print(json.dumps(expected))
'''
# Exercise the application's own capability probe and descriptor-backed search,
# not merely a version string. All writes are generated fixtures inside /tmp.
SEARCH_SCRIPT = r'''
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '/opt/pa-bb/plugins/icloud/adapters/note-store.ts';
import { NoteSearch } from '/opt/pa-bb/plugins/icloud/adapters/note-search.ts';

async function verifySearch() {
  const root = await mkdtemp(join(tmpdir(), 'pa-bb-smoke-search-'));
  let search;
  try {
    const vault = join(root, 'vault');
    await mkdir(join(vault, '.hidden'), { recursive: true });
    await writeFile(join(vault, '.gitignore'), '*.md\n');
    await writeFile(join(vault, 'Visible.md'), 'generated search needle\n');
    await writeFile(join(vault, '.hidden', 'Hidden.md'), 'generated search needle\n');
    await writeFile(join(vault, 'Other.md'), 'generated control\n');
    const store = new NoteStore(join(root, 'state'));
    search = new NoteSearch(store, {
      paths: () => [], reader: (_id, path) => store.searchReader(vault, path),
    });
    const capability = await search.capability();
    if (capability.version !== 1 || capability.available !== true) throw new Error();
    const query = { mirrorId: 'smoke', revision: 1, projection: 'hits' };
    const hits = await search.next({ ...query, text: 'needle' }, vault, () => {});
    const paths = hits.candidates.map(candidate => candidate.path).sort();
    if (JSON.stringify(paths) !== JSON.stringify(['.hidden/Hidden.md', 'Visible.md']) ||
        hits.visited !== 3 || hits.warnings.length !== 0 || hits.nextCursor !== null) throw new Error();
    const empty = await search.next({ ...query, text: 'absent' }, vault, () => {});
    if (empty.candidates.length !== 0 || empty.warnings.length !== 0 || empty.nextCursor !== null) throw new Error();
    return { version: 1, available: true, matches: paths.length };
  } finally {
    try { await search?.stop(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
verifySearch().then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error('Generated note-search verification failed.'); process.exitCode = 1;
});
'''


class SmokeError(RuntimeError):
    pass


class SmokeTest:
    def __init__(self, image, timeout=300):
        self.image = image
        self.timeout = timeout
        self.owner = uuid.uuid4().hex
        self.container = 'pa-bb-smoke-' + self.owner
        self.volume = self.container + '-home'
        self.attempted = []
        self.state = 'not-started'
        self.health = 'unknown'
        self.registered = False

    def docker(self, *args, timeout=30):
        try:
            result = subprocess.run(['docker', *args], capture_output=True,
                                    text=True, errors='replace', timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise SmokeError(f'Docker {args[0]} command unavailable or timed out ({args[1]}).') from None
        if result.returncode:
            # Docker/CLI errors may contain arbitrary output. Never echo them.
            raise SmokeError(f'Docker {args[0]} command failed ({args[1]}).')
        return result

    def exists(self, kind, name):
        field = '.Names' if kind == 'container' else '.Name'
        args = ['--all'] if kind == 'container' else []
        result = self.docker(kind, 'ls', *args, '--filter',
                             f'name=^{"/" if kind == "container" else ""}{name}$',
                             '--format', '{{' + field + '}}')
        return name in result.stdout.splitlines()

    def owned(self, kind, name):
        field = '.Config.Labels' if kind == 'container' else '.Labels'
        result = self.docker(kind, 'inspect', '--format', '{{json ' + field + '}}', name)
        labels = self.decode(result.stdout)
        return isinstance(labels, dict) and labels.get(OWNER_LABEL) == self.owner

    @staticmethod
    def decode(text):
        try:
            return json.loads(text)
        except (ValueError, TypeError):
            raise SmokeError('Invalid Docker or BB JSON response.') from None

    def start(self):
        image_id = self.docker('image', 'inspect', '--format', '{{.Id}}', '--', self.image).stdout.strip()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise SmokeError('Expected a locally built image ID.')
        for kind, name in [('container', self.container), ('volume', self.volume)]:
            if self.exists(kind, name):
                raise SmokeError('Generated resource name already exists; refusing to use it.')
        self.attempted.append(('volume', self.volume))
        self.docker('volume', 'create', '--label', f'{OWNER_LABEL}={self.owner}', self.volume)
        if not self.owned('volume', self.volume):
            raise SmokeError('Fresh home volume ownership not confirmed.')
        # Record attempts before writes: a timed-out Docker client may still have
        # created the resource. Cleanup rechecks the private ownership label.
        self.attempted.append(('container', self.container))
        self.docker('container', 'create', '--name', self.container,
                    '--label', f'{OWNER_LABEL}={self.owner}', '--platform', 'linux/amd64',
                    '--pull=never', '--mount', f'type=volume,source={self.volume},target=/home/bb',
                    '--shm-size=1g', '--stop-timeout=60', image_id, timeout=60)
        if not self.owned('container', self.container):
            raise SmokeError('Fresh container ownership not confirmed.')
        self.docker('container', 'start', self.container)

    def wait_and_verify(self):
        deadline = time.monotonic() + self.timeout

        def remaining(maximum=30):
            seconds = deadline - time.monotonic()
            if seconds <= 0:
                raise SmokeError('Timed out waiting for healthy, registered startup.')
            return min(maximum, seconds)

        while True:
            state = self.decode(self.docker('container', 'inspect', '--format',
                                '{{json .State}}', self.container, timeout=remaining()).stdout)
            if not isinstance(state, dict):
                raise SmokeError('Invalid container state.')
            self.state = state.get('Status') if state.get('Status') in {
                'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'
            } else 'unknown'
            health = state.get('Health') or {}
            self.health = health.get('Status') if isinstance(health, dict) else None
            if self.health not in {'starting', 'healthy', 'unhealthy'}:
                self.health = 'unknown'
            if self.state != 'running':
                raise SmokeError('Container exited or failed to run during startup.')
            if self.health == 'unhealthy':
                raise SmokeError('Container became unhealthy during startup.')
            logs = self.docker('container', 'logs', '--tail', '200', self.container,
                               timeout=remaining())
            lines = (logs.stdout + '\n' + logs.stderr).splitlines()
            if any(line.startswith('PA startup failed') for line in lines):
                raise SmokeError('Entrypoint reported startup failure.')
            self.registered = self.registered or REGISTRATION_COMPLETE in lines
            if self.health == 'healthy' and self.registered:
                break
            time.sleep(min(2, remaining()))

        expected = self.decode(self.docker('container', 'exec', self.container,
                               'python3', '-c', INVENTORY_SCRIPT, timeout=remaining()).stdout)
        actual = self.decode(self.docker('container', 'exec', self.container,
                             'node', CLI, 'plugin', 'list', '--json', timeout=remaining()).stdout)
        if (not isinstance(expected, dict) or len(expected) < 2
                or expected.get('browser-automation') != 'builtin:browser-automation'
                or not isinstance(actual, dict) or not isinstance(actual.get('plugins'), list)):
            raise SmokeError('Invalid image inventory or installed plugin list.')
        installed = {}
        for plugin in actual['plugins']:
            if not isinstance(plugin, dict) or not isinstance(plugin.get('id'), str):
                raise SmokeError('Invalid installed plugin identity.')
            if plugin['id'] in installed:
                raise SmokeError('Duplicate installed plugin identity.')
            installed[plugin['id']] = plugin
        for identity, source in expected.items():
            plugin = installed.get(identity)
            if not plugin or plugin.get('source') != source or plugin.get('enabled') is not True:
                raise SmokeError('Expected plugin missing, source mismatched, or disabled.')
        try:
            self.docker('container', 'exec', self.container, 'python3', '-c',
                        'import ctypes; ctypes.CDLL("libgtk-3.so.0")', timeout=remaining())
        except SmokeError:
            raise SmokeError('GTK 3 shared library could not be loaded.') from None
        try:
            search = self.decode(self.docker('container', 'exec', self.container,
                'node', '--import', '/opt/pa-bb/plugins/icloud/node_modules/tsx/dist/loader.mjs',
                '--input-type=module', '-e', SEARCH_SCRIPT, timeout=remaining()).stdout)
        except SmokeError:
            raise SmokeError('Note-search capability check failed.') from None
        if (not isinstance(search, dict) or search.get('version') != 1
                or search.get('available') is not True or search.get('matches') != 2):
            raise SmokeError('Note-search capability or generated matches not confirmed.')
        try:
            email = self.decode(self.docker('container', 'exec', self.container,
                'node', '--experimental-transform-types', '/opt/pa-bb/docker/email-smoke.mjs',
                timeout=remaining(90)).stdout)
        except SmokeError:
            raise SmokeError('Email-archive capability check failed.') from None
        if (not isinstance(email, dict) or email.get('version') != 1
                or email.get('available') is not True or type(email.get('messages')) is not int
                or email.get('messages') != 1 or email.get('isolated') is not True
                or email.get('read') is not True):
            raise SmokeError('Email-archive capability or generated round trip not confirmed.')
        remaining()
        return len(expected)

    def cleanup(self):
        errors = []
        for kind, name in reversed(self.attempted):
            try:
                if not self.exists(kind, name):
                    continue
                if not self.owned(kind, name):
                    raise SmokeError('Resource ownership mismatch; refusing cleanup.')
                if kind == 'container':
                    try:
                        self.docker('container', 'stop', '--time', '60', name, timeout=70)
                    except SmokeError as error:
                        errors.append(str(error))
                    self.docker('container', 'rm', '--force', name)
                else:
                    self.docker('volume', 'rm', name)
            except SmokeError as error:
                errors.append(str(error))
            except Exception:
                errors.append('Unexpected cleanup failure (details suppressed).')
        return errors

    def run(self):
        previous = {}
        failure = None
        count = None

        def interrupted(signum, _frame):
            raise SmokeError(f'Interrupted by signal {signum}.')

        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, interrupted)
        try:
            self.start()
            count = self.wait_and_verify()
        except SmokeError as error:
            failure = str(error)
        except Exception:
            failure = 'Unexpected smoke-test failure (details suppressed).'
        finally:
            # A second termination request must not interrupt resource cleanup.
            for sig in previous:
                signal.signal(sig, signal.SIG_IGN)
            try:
                cleanup_errors = self.cleanup()
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        if failure or cleanup_errors:
            summary = f'state={self.state}, health={self.health}, registered={self.registered}'
            message = (failure or 'Smoke verification passed.') + f' [{summary}]'
            if cleanup_errors:
                message += ' Cleanup failed: ' + '; '.join(cleanup_errors)
            raise SmokeError(message)
        return count


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', help='locally built image reference (never pulled)')
    args = parser.parse_args(argv)
    try:
        count = SmokeTest(args.image).run()
        script = Path(__file__).with_name('smoke_obsidian_desktop.sh')
        subprocess.run(['bash', str(script), args.image], check=True, timeout=270)
    except SmokeError as error:
        print(f'Smoke test failed: {error}', file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError) as error:
        print(f'Obsidian Desktop smoke test failed ({type(error).__name__}).', file=sys.stderr)
        return 1
    print(f'Smoke test passed: healthy, registration complete, {count} expected plugins verified; note search, Obsidian Desktop and email archive verified; cleaned up.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
