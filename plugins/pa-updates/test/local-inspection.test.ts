import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { applicationPorts } from '../adapters/application.ts';
import { sourceDetails } from '../adapters/source-files.ts';

for (const bad of ['malformed-json', 'invalid-version', 'source-query-failed'] as const) test(`failed canonical path inspection (${bad}) holds BB restart`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'pa-path-inspection-')), checkout = join(home, 'repo'), root = join(checkout, 'plugins/google-calendar');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'server.ts'), 'export const value = "A";');
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const canonical = await realpath(root), original = await sourceDetails(root); let queryFailed = false;
  const marker = { version: 1, records: [{ id: 'google-calendar', path: canonical, source: original.fingerprint, stamp: original.stamp }] };
  const bb = { storage: { kv: { get: async (key: string) => key === 'applied-source-v1' ? marker : null, set: async () => { throw new Error('Inspection must not write'); } } }, log: { warn() {} }, sdk: {
    plugins: { list: async () => ({ plugins: [{ id: 'google-calendar', version: '1.0.0', rootDir: canonical, source: `path:${canonical}`, enabled: true, status: 'running', statusDetail: null, app: { hasApp: false, bundle: null } }] }),
      getSource: async () => { if (queryFailed) throw new Error('PRIVATE_SENTINEL'); return { requested: `path:${canonical}`, resolved: `path:${canonical}` }; },
      checkUpdates: async () => { throw new Error('Path inspection must not use channel discovery'); } },
    system: { config: async () => ({ primaryHostId: 'fixture' }), appUpdate: async () => ({ activity: { phase: 'idle' }, available: { channel: 'latest', commit: null, commitCount: null, subjects: [], version: '0.47.2' }, blocked: null,
      current: { version: '0.47.1', commit: null }, lastResult: null, runningThreadCount: 0, support: { kind: 'supported', mode: 'npm' } }) },
    hosts: { get: async () => ({ id: 'fixture', name: 'Fixture' }), providerCliStatus: async () => ({}) },
  } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb, undefined, async () => checkout);
  try {
    await ports.inspect(); assert.equal((await ports.runtime!.inspect()).rows.find(row => row.id === 'bb')?.state, 'ready');
    if (bad === 'source-query-failed') queryFailed = true;
    else await writeFile(join(root, 'package.json'), bad === 'malformed-json' ? '{' : JSON.stringify({ version: 'not-a-version' }));
    await ports.inspect();
    const row = (await ports.runtime!.inspect()).rows.find(row => row.id === 'bb');
    assert.equal(row?.state, 'unavailable'); assert.equal(row?.reason, 'local_pending');
  } finally { await ports.cancel?.(); await rm(home, { recursive: true, force: true }); }
});
