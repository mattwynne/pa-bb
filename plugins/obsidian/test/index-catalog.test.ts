import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { ICloud } from '../adapters/icloud.ts';
import type { FilesystemVault } from '../adapters/filesystem-vault.ts';
import { VaultError } from '../core/ports.ts';

const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const revoked = (error: unknown) => error instanceof VaultError && error.category === 'source_unavailable';
async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'obsidian-synthetic-catalog-'));
  const { bb, harness } = createFakePluginHost({ pluginId: 'obsidian' });
  const controls: { ready: boolean; beforeStatus?: (background: boolean) => Promise<void> } = { ready: true };
  await writeFile(join(folder, 'One.md'), 'synthetic');
  const inode = await stat(folder, { bigint: true });
  const applied = deferred();
  let grants = 0;
  const sdk = { plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc({ method, input, outputSchema, signal }: { method: string; input: any; outputSchema: { parse(value: unknown): unknown }; signal?: AbortSignal }) {
      if (method === 'noteConfigure') return outputSchema.parse({ ok: true, value: { revision: input.revision } });
      if (method === 'mirrorDirectoryCapabilities') return outputSchema.parse({ mirrorDirectoryGrantVersion: 1 });
      if (method === 'mirrorDirectoryGrant') {
        grants++;
        if (!controls.ready) throw new Error('synthetic denial');
        return outputSchema.parse({ directory: folder, rootDev: inode.dev.toString(), rootIno: inode.ino.toString() });
      }
      assert.equal(method, 'status'); await controls.beforeStatus?.(!!signal);
      return outputSchema.parse({ noteAccessVersion: 2, mirrorAccessVersion: 3,
        available: true, connected: true, challenge: null,
        mirrors: [{ id: 'one', folder: { name: 'Synthetic' }, initialized: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null,
          filesystem: controls.ready ? 'ready' : 'unavailable', local: { available: controls.ready, reason: null, pendingAgeMs: null, applicationBlocker: null } }],
      });
    },
  } } as unknown as BbPluginApi['sdk'];
  const icloud = new ICloud(sdk, () => {}, bb.storage.kv);
  const filesystem = (icloud as unknown as { filesystem: FilesystemVault }).filesystem;
  // Only instrument the test double to know exactly when a status revocation
  // reaches the eligibility gate, rather than relying on elapsed time.
  const setEligible = filesystem.index.setEligible.bind(filesystem.index);
  filesystem.index.setEligible = (revision, ids, reconcile) => {
    setEligible(revision, ids, reconcile);
    if (!controls.ready && !ids.length) applied.release();
  };
  const state = { revision: 1, vaultIds: ['one'] };
  icloud.indexConfiguration(state);
  t.after(async () => { await icloud.stop(); await harness.lifecycle.dispose(); await rm(folder, { recursive: true, force: true }); });
  await icloud.configure(state);
  const lease = await icloud.index('one', 1);
  return { icloud, filesystem, controls, lease, applied: applied.promise, grants: () => grants };
}

test('earlier-started background check can observe a later denial and must retire the lane', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t), background = deferred(), resume = deferred();
  t.after(() => resume.release());
  f.controls.beforeStatus = async isBackground => { if (isBackground) { background.release(); await resume.promise; } };
  // Leave the startup continuation before starting the periodic turn.
  await delay(0); t.mock.timers.tick(300_000);
  await background.promise;
  assert.equal((await f.icloud.snapshot()).filesystem?.one, 'ready');
  f.lease.assertValid();
  f.controls.ready = false; resume.release();
  await f.applied;
  assert.throws(() => f.lease.assertValid(), revoked);
  f.controls.ready = true; // no new check published
  await assert.rejects(f.icloud.index('one', 1), revoked);
});

test('a ready observation held in local processing cannot resurrect a lane after a newer denial', async t => {
  const f = await fixture(t), entered = deferred(), resume = deferred();
  const searcher = f.filesystem.searcher, capability = searcher.capability.bind(searcher);
  t.after(() => resume.release());
  searcher.capability = async () => { entered.release(); await resume.promise; return capability(); };
  // Hold a background ready observation after the provider already replied so
  // another foreground check can observe the subsequent denial.
  const lateReady = (f.icloud as unknown as { observeCatalog(): ReturnType<ICloud['snapshot']> }).observeCatalog();
  await entered.promise;
  f.controls.ready = false;
  assert.equal((await f.icloud.snapshot()).filesystem?.one, 'unavailable');
  await f.applied;
  assert.throws(() => f.lease.assertValid(), revoked);
  f.controls.ready = true; resume.release();
  assert.equal((await lateReady).filesystem?.one, 'ready');
  const checked = f.grants();
  await assert.rejects(f.icloud.index('one', 1), revoked);
  assert.equal(f.grants(), checked);
});
