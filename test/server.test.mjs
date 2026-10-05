import assert from 'node:assert/strict';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../server.ts';

function bbWithSetting(piAgentDir) {
  const messages = [];
  const bb = {
    settings: { define: fields => {
      assert.equal(fields.piAgentDir.default, '');
      return { get: async () => ({ piAgentDir }) };
    } },
    log: { info: message => messages.push(message) },
    onDispose: () => { throw new Error('Persistent Pi registration must not be removed on dispose'); },
  };
  return { bb, messages };
}

test('plugin does not modify Pi without explicit agent-directory opt-in', async () => {
  const { bb, messages } = bbWithSetting('');
  await plugin(bb);
  assert.match(messages[0], /disabled/);
});

test('plugin registers packaged Pi extension at explicit absolute directory on load and reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-bb-server-'));
  try {
    const agentDir = join(root, 'agent');
    const { bb, messages } = bbWithSetting(agentDir);
    await plugin(bb);
    const link = join(agentDir, 'extensions/pa-bb-google');
    assert.match(await readlink(link), /spike\/pi-extension$/);
    await plugin(bb);
    assert.ok(messages.some(message => message.includes('created')));
    assert.ok(messages.some(message => message.includes('current')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('relative agent directory fails before creating a registration', async () => {
  const { bb } = bbWithSetting('./not-the-agent-dir');
  await assert.rejects(plugin(bb), /absolute path/);
});
