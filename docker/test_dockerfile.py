"""Keep inline Docker pins aligned with provisioning, without requiring Ansible."""
from pathlib import Path
import re
import subprocess
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
        for tool in ['bb', 'pi', 'codex', 'claude', 'hermes']:
            with self.subTest(tool=tool):
                self.assertEqual(args[f'{tool.upper()}_VERSION'], scalar(runtime, f'pa_bb_{tool}_seed'))
        self.assertEqual(args['HERMES_INSTALLER_SHA256'], scalar(runtime, 'pa_bb_hermes_installer_sha256'))
        uv = (ROLES / 'pa_bb_runtime/tasks/uv.yml').read_text()
        self.assertEqual(args['UV_VERSION'], scalar(uv, 'workspace_uv_version'))
        self.assertEqual(args['UV_SHA256'], scalar(uv, 'workspace_uv_sha256'))
        manifest = (ROLES / 'pa_bb_host_dependencies/vars/main.yml').read_text()
        rclone = manifest.split('  rclone:\n', 1)[1]
        self.assertEqual(args['RCLONE_VERSION'], scalar(rclone, 'version'))
        self.assertEqual(args['RCLONE_ARCHIVE_SHA256'], scalar(rclone, 'archive_sha256'))
        self.assertEqual(args['RCLONE_BINARY_SHA256'], scalar(rclone, 'binary_sha256'))
        self.assertEqual(args['CHROME_KEY_SHA256'], scalar(manifest, 'key_sha256'))
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
