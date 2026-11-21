"""Start stock BB and register missing plugins through its public CLI."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path('/opt/pa-bb')
CLI = ['node', str(Path.home() / '.local/lib/node_modules/bb-app/host-daemon/dist/bb')]


def inventory():
    desired = {}
    for manifest in sorted((ROOT / 'plugins').glob('*/package.json')):
        package = json.loads(manifest.read_text())
        if not isinstance(package.get('bb'), dict):
            continue
        identity = re.sub(r'[^a-z0-9-]', '-', re.sub(
            r'^bb-plugin-', '', package['name'].split('/')[-1]).lower()).strip('-')
        if not identity or identity in desired:
            raise RuntimeError('Invalid or duplicate plugin identity in image.')
        desired[identity] = 'path:' + str(manifest.parent)
    if not desired:
        raise RuntimeError('No PA plugins found in image.')
    desired['browser-automation'] = 'builtin:browser-automation'
    return desired


def cli(*args):
    # Do not expose installed-plugin metadata or account details in Docker logs.
    result = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError('BB plugin command failed; inspect BB before retrying startup.')
    return json.loads(result.stdout)


def register_plugins():
    desired = inventory()
    before = {p['id']: p for p in cli('plugin', 'list', '--json')['plugins']}
    # Validate every source before attempting any installation. Never move sources,
    # reinstall existing plugins, change enablement, or remove retired plugins.
    for identity, source in desired.items():
        if identity in before and before[identity]['source'] != source:
            raise RuntimeError(f'Plugin source mismatch: {identity}. No sources were changed.')
    for identity, source in desired.items():
        if identity not in before:
            print(f'Installing plugin: {identity}', flush=True)
            cli('plugin', 'install', source, '--yes', '--json')
    after = {p['id']: p for p in cli('plugin', 'list', '--json')['plugins']}
    for identity, source in desired.items():
        expected_enabled = before[identity]['enabled'] if identity in before else True
        if (identity not in after or after[identity]['source'] != source
                or after[identity]['enabled'] != expected_enabled):
            raise RuntimeError(f'Plugin registration not confirmed: {identity}. Inspect before retrying.')


def main():
    os.umask(0o077)
    server = subprocess.Popen(['bb-app', '--server-bind-host', '0.0.0.0', '--in-app-updates'])

    def stop(signum, _frame):
        server.send_signal(signum)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError('BB exited before becoming ready.')
            try:
                with urlopen('http://127.0.0.1:38886/api/v1/system/version', timeout=2) as response:
                    if json.load(response).get('installKind') != 'npm':
                        raise RuntimeError('Expected stock npm BB.')
                break
            except (URLError, TimeoutError):
                time.sleep(2)
        else:
            raise RuntimeError('BB did not become ready within five minutes.')
        register_plugins()
        print('PA plugins registered. Connect accounts in BB settings.', flush=True)
        return server.wait()
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f'PA startup failed: {error}', file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Unexpected exceptions may contain private CLI output.
        print('PA startup failed. Inspect BB plugin state before restarting; see docker/README.md.', file=sys.stderr)
        sys.exit(1)
