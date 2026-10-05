import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcilePiRegistration, removePiRegistration } from '../src/pi-registration.mjs';

async function commandsFromFreshPi(root, agentDir) {
  const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-context-files'], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const result = await new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      const timer = setTimeout(() => reject(new Error(`Pi RPC timeout: ${stderr}`)), 15000);
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.on('data', data => {
        stdout += data;
        let end;
        while ((end = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, end);
          stdout = stdout.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.id === 'commands') {
              clearTimeout(timer);
              resolve(message);
            }
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Pi exited ${code}: ${stderr}`)); });
      child.stdin.write('{"id":"commands","type":"get_commands"}\n');
    });
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data.commands.map(command => command.name);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

const root = await mkdtemp(join(tmpdir(), 'pa-bb-pi-spike-'));
const packageDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'pi-extension');
const agentDir = join(root, 'agent');
try {
  await reconcilePiRegistration({ agentDir, packageDir });
  assert.ok((await commandsFromFreshPi(root, agentDir)).includes('pa-bb-discovery-spike'));
  const updatedPackage = join(root, 'updated-package');
  await cp(packageDir, updatedPackage, { recursive: true });
  await reconcilePiRegistration({ agentDir, packageDir: updatedPackage });
  assert.ok((await commandsFromFreshPi(root, agentDir)).includes('pa-bb-discovery-spike'));
  await removePiRegistration({ agentDir });
  assert.ok(!(await commandsFromFreshPi(root, agentDir)).includes('pa-bb-discovery-spike'));
  console.log('Fresh Pi RPC sessions discovered packaged extension on install/update and not after removal.');
} finally {
  await rm(root, { recursive: true, force: true });
}
