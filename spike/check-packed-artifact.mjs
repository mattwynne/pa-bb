import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'pa-bb-plugin-pack-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], {
    cwd: pluginDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }));
  const installRoot = join(root, 'installation');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, join(root, packed.filename)], { stdio: 'inherit' });
  const installed = join(installRoot, 'node_modules', 'pa-bb');
  execFileSync(process.execPath, [join(pluginDir, 'spike/check-pi-discovery.mjs'), join(installed, 'spike/pi-extension')], { stdio: 'inherit' });
} finally {
  await rm(root, { recursive: true, force: true });
}
