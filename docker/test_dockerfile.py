"""Keep inline Docker pins aligned with provisioning, without requiring Ansible."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = (ROOT / 'Dockerfile').read_text()
ROLES = ROOT / 'provisioning/roles'


def scalar(text, key):
    # The compared manifest fields are simple one-line YAML scalars.
    match = re.search(r'^\s*' + re.escape(key) + r':\s*([^\n]+)$', text, re.MULTILINE)
    if not match:
        raise AssertionError(f'Missing provisioning scalar: {key}')
    return match[1].strip().strip('\'"')


class DockerfileTests(unittest.TestCase):
    def test_application_pins_match_ansible(self):
        args = dict(re.findall(r'^ARG (\w+)=(\S+)$', DOCKERFILE, re.MULTILINE))
        runtime = (ROLES / 'pa_bb_runtime/defaults/main.yml').read_text()
        for tool in ['bb', 'pi', 'codex', 'claude']:
            with self.subTest(tool=tool):
                self.assertEqual(args[f'{tool.upper()}_VERSION'], scalar(runtime, f'pa_bb_{tool}_seed'))
        uv = (ROLES / 'pa_bb_runtime/tasks/uv.yml').read_text()
        self.assertEqual(args['UV_VERSION'], scalar(uv, 'workspace_uv_version'))
        self.assertEqual(args['UV_SHA256'], scalar(uv, 'workspace_uv_sha256'))
        manifest = (ROLES / 'pa_bb_host_dependencies/vars/main.yml').read_text()
        rclone = manifest.split('  rclone:\n', 1)[1]
        self.assertEqual(args['RCLONE_VERSION'], scalar(rclone, 'version'))
        self.assertEqual(args['RCLONE_ARCHIVE_SHA256'], scalar(rclone, 'archive_sha256'))
        self.assertEqual(args['RCLONE_BINARY_SHA256'], scalar(rclone, 'binary_sha256'))
        self.assertEqual(args['CHROME_KEY_SHA256'], scalar(manifest, 'key_sha256'))
        self.assertEqual(args['RIPGREP_VERSION'], scalar(manifest.split('  ripgrep:\n', 1)[1], 'version'))
        for key in ['RIPGREP_ARCHIVE_SHA256', 'RIPGREP_BINARY_SHA256']:
            self.assertRegex(args[key], r'^[0-9a-f]{64}$')
        for name in args:
            with self.subTest(argument=name):
                self.assertRegex(DOCKERFILE, r'\$(?:' + name + r'\b|\{' + name + r'\})')

    def test_run_commands_have_valid_shell_syntax(self):
        unfolded = DOCKERFILE.replace('\\\n', '')
        for line in unfolded.splitlines():
            if line.startswith('RUN '):
                with self.subTest(command=line[:80]):
                    result = subprocess.run(['/bin/sh', '-n'], input=line[4:],
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_rclone_check_does_not_inherit_its_boolean_version_flag(self):
        # Docker exposes ARG values to RUN. rclone treats RCLONE_VERSION as a
        # boolean --version flag, not the release number used for the download.
        check = next(line.strip() for line in DOCKERFILE.splitlines()
                     if 'rclone version;' in line)
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp)
            for name, body in [('rclone', 'test -z "${RCLONE_VERSION+x}"\n'),
                               ('uv', 'exit 0\n'), ('uvx', 'exit 0\n')]:
                path = tools / name
                path.write_text('#!/bin/sh\n' + body)
                path.chmod(0o755)
            result = subprocess.run(['/bin/sh', '-ec', check], capture_output=True,
                                    text=True, env={**os.environ, 'RCLONE_VERSION': '1.75.2',
                                                   'PATH': str(tools) + ':' + os.environ['PATH']})
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_ripgrep_uses_verified_upstream_binary_not_bookworm_package(self):
        unfolded = DOCKERFILE.replace('\\\n', '')
        installs = re.findall(r'apt-get install -y --no-install-recommends\s+([^;]+);', unfolded)
        self.assertTrue(installs)
        self.assertTrue(all('ripgrep' not in command.split() for command in installs))
        self.assertIn('ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz', DOCKERFILE)
        self.assertIn('"$RIPGREP_ARCHIVE_SHA256  /tmp/ripgrep.tar.gz" | sha256sum -c -', DOCKERFILE)
        self.assertIn('"$RIPGREP_BINARY_SHA256  /tmp/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg" | sha256sum -c -', DOCKERFILE)
        self.assertIn('/usr/local/bin/rg;', DOCKERFILE)
        self.assertIn('/usr/local/share/licenses/ripgrep/LICENSE-MIT', DOCKERFILE)

    def test_image_omits_experimental_hermes_runtime(self):
        self.assertNotIn('hermes', DOCKERFILE.lower())
        self.assertRegex(DOCKERFILE, r'ARG NPM_VERSION=\d+\.\d+\.\d+\n')
        self.assertIn('npm install -g "npm@$NPM_VERSION"', DOCKERFILE)

    def test_node_base_without_ansible(self):
        self.assertIn('FROM node:24-bookworm-slim\n', DOCKERFILE)
        self.assertNotIn('ansible-playbook', DOCKERFILE)
        self.assertNotIn('ansible-core', DOCKERFILE)
        self.assertFalse((ROOT / 'docker/build.yml').exists())
        self.assertIn('USER bb\n', DOCKERFILE)
        self.assertIn('VOLUME ["/home/bb"]', DOCKERFILE)
        self.assertIn('npm ci --include=dev', DOCKERFILE)


if __name__ == '__main__':
    unittest.main()
