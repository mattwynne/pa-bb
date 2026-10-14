import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { RcloneCloudProvider } from '../adapters/rclone-cloud-provider.ts';
import { plugin } from '../server.ts';
import { statusSchema } from '../contract.ts';
import { diagnosticsSchema } from '../core/diagnostics.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';

const mirror = (id: string): Mirror => ({ id, folder: { id: Buffer.from(id).toString('base64url'), name: 'Synthetic folder', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00.000Z', failure: null, blocker: null });
const reconnect = async (harness: ReturnType<typeof createFakePluginHost>['harness']) => {
  const start = await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"sentinel-password"}' });
  assert.equal(start.status, 200);
  const finish = await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
  assert.equal(finish.status, 200);
};

// Stock v1.75.2 emits this exact native error in iclouddrive/api/client.go
// and iclouddrive/icloud.go. RC wraps backend errors in HTTP 500, not 401.
const expired = 'trust token expired, please reauth';
async function rcFixture() {
  const root = await mkdtemp('/tmp/icloud-auth-');
  let failure: unknown = null; let status = 500;
  const server = createServer((req, res) => {
    if (req.url === '/operations/list' && failure !== null) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof failure === 'string' ? failure : JSON.stringify(failure));
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"list":[]}'); }
  });
  await new Promise<void>(resolve => server.listen(join(root, 'control.sock'), resolve));
  class FixtureProcess extends RcloneProcess { async ensure() {} }
  const process = new FixtureProcess(root);
  return { root, process, fail: (error: unknown, httpStatus = 500) => { failure = error; status = httpStatus; }, async close() { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true }); } };
}

test('private RC recognizes only the exact stock-native expiry error, never arbitrary provider messages', async () => {
  const fixture = await rcFixture();
  try {
    for (const [body, category] of [
      [{ status: 500, error: expired, input: { token: 'sentinel-token' }, path: 'operations/list' }, 'authentication'],
      [{ status: 500, error: 'sentinel-private-authentication-401-password' }, 'sync_failed'],
      [{ status: 500, error: `sentinel-content: ${expired}` }, 'sync_failed'],
      [{ status: 500, error: `${expired}: sentinel-content` }, 'sync_failed'],
      [{ status: 500, error: { message: expired } }, 'sync_failed'],
      ['sentinel-not-json', 'sync_failed'],
    ] as const) {
      fixture.fail(body);
      await assert.rejects(fixture.process.call('operations/list', { fs: 'icloud:', remote: '', opt: { dirsOnly: true } }), error => {
        assert.ok(error instanceof CloudError); assert.equal(error.category, category);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /sentinel|trust token/); return true;
      });
    }
    fixture.fail({ error: expired });
    await assert.rejects(fixture.process.call('operations/list', { fs: 'other:', remote: '' }), /sync_failed/);
    for (const status of [401, 403, 503]) {
      fixture.fail({ error: expired, input: { token: 'sentinel-token' } }, status);
      await assert.rejects(fixture.process.call('operations/list', { fs: 'icloud:', remote: '' }), /sync_failed/);
    }
  } finally { await fixture.close(); }
});

test('stock RC expiry at reload blocks all enabled recoverable folders with bounded diagnostics', async () => {
  const fixture = await rcFixture(); const host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState(); repository.value.connected = true;
  repository.value.mirrors = [mirror('one'), mirror('two'), { ...mirror('paused'), enabled: false, phase: 'paused' }];
  fixture.fail({ status: 500, error: expired, input: { token: 'sentinel-token' } });
  const provider = new RcloneCloudProvider(fixture.root, fixture.process.call.bind(fixture.process), async () => '', async () => {}, async () => {});
  try {
    await plugin(host.bb, { provider, repository });
    const status = statusSchema.parse(await host.harness.behavior.callRpc('status', null));
    assert.equal(status.connected, false);
    assert.deepEqual(status.mirrors.map(m => m.blocker), ['reconnect', 'reconnect', null]);
    assert.equal(status.mirrors[2].phase, 'paused');
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /restore_connection authentication/); assert.doesNotMatch(logs + JSON.stringify(status), /sentinel|trust token/);
  } finally { await host.harness.lifecycle.dispose(); await fixture.close(); }
});

test('a failed scheduled bisync verifies expiry through harmless RC without losing command evidence', async () => {
  const fixture = await rcFixture(); const host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState(); repository.value.connected = true; repository.value.mirrors = [mirror('one'), mirror('two')];
  const commands: string[] = [];
  const provider = new RcloneCloudProvider(fixture.root, fixture.process.call.bind(fixture.process), async args => {
    commands.push(args[0]); throw new CloudError('sync_failed', { kind: 'command_exit', exitCode: 1 });
  }, async () => {}, async () => {});
  try {
    await mkdir(join(fixture.root, 'baselines/one'), { recursive: true });
    await writeFile(join(fixture.root, 'baselines/one/initialized'), '1');
    await plugin(host.bb, { provider, repository });
    fixture.fail({ status: 500, error: expired, input: { token: 'sentinel-token' } });
    await host.harness.behavior.runSchedule('selected-folder-sync');
    const status = statusSchema.parse(await host.harness.behavior.callRpc('status', null));
    assert.equal(status.connected, false); assert.deepEqual(status.mirrors.map(m => m.blocker), ['reconnect', 'reconnect']);
    assert.deepEqual(commands, ['bisync']);
    const history = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null));
    assert.equal(history.runs.at(-1)!.failure, 'authentication');
    assert.deepEqual(history.runs.at(-1)!.evidence, { kind: 'command_exit', exitCode: 1 });
    assert.doesNotMatch(JSON.stringify(history) + JSON.stringify(host.harness.inspection.logEntries), /sentinel|trust token/);
  } finally { await host.harness.lifecycle.dispose(); await fixture.close(); }
});

test('a failed CLI command remains its original failure unless the read probe proves native expiry', async () => {
  const root = await mkdtemp('/tmp/icloud-auth-probe-');
  try {
    await mkdir(join(root, 'baselines/one'), { recursive: true });
    await mkdir(join(root, 'mirrors/one'), { recursive: true });
    await writeFile(join(root, 'baselines/one/initialized'), '1');
    for (const category of ['sync_failed', 'capacity', 'configuration', 'recovery_required', 'source_changed', 'interrupted'] as const) {
      for (const probe of ['success', 'sync_failed', 'authentication'] as const) {
        const original = new CloudError(category, { kind: 'command_exit', exitCode: 1 }); let reads = 0; let bisyncs = 0;
        const provider = new RcloneCloudProvider(root, async method => {
          if (method === 'operations/list') { reads++; if (probe !== 'success') throw new CloudError(probe); }
          return {};
        }, async args => { if (args[0] === 'bisync') bisyncs++; throw original; }, async () => {}, async () => {});
        await assert.rejects(provider.synchronize(mirror('one')), error => {
          if (category === 'sync_failed' && probe === 'authentication') {
            assert.ok(error instanceof CloudError); assert.equal(error.category, 'authentication'); assert.deepEqual(error.evidence, original.evidence);
          } else assert.equal(error, original);
          return true;
        });
        assert.equal(reads, category === 'sync_failed' ? 1 : 0); assert.equal(bisyncs, 1);
      }
    }
  } finally { await rm(root, { recursive: true }); }
});

for (const entry of ['scheduled-expiry', 'manual-reconnect', 'failed-reconnect'] as const) test(`${entry} requires each enabled folder to Resume, preserving paused and stronger blockers across reload`, async () => {
  const provider = new FakeCloudProvider(); const repository = new MemoryState(); repository.value.connected = true;
  const capacity: Mirror = { ...mirror('capacity'), phase: 'failed', failure: 'capacity', blocker: 'capacity' };
  const critical: Mirror = { ...mirror('critical'), phase: 'failed', failure: 'recovery_required', blocker: 'rebuild' };
  repository.value.mirrors = [mirror('one'), mirror('two'), { ...mirror('paused'), enabled: false, phase: 'paused' }, capacity, critical, { ...mirror('retained'), enabled: false, phase: 'retained' }];
  let host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider, repository });
  try {
    if (entry === 'scheduled-expiry') {
      provider.fail = 'authentication'; await host.harness.behavior.runSchedule('selected-folder-sync'); provider.fail = null;
    }
    if (entry === 'failed-reconnect') {
      provider.connect = async () => { throw new CloudError('sync_failed'); };
      const response = await host.harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"sentinel-password"}' });
      assert.equal(response.status, 400);
      provider.connect = FakeCloudProvider.prototype.connect;
    }
    await reconnect(host.harness);
    const attempts = provider.synced;
    await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, attempts);
    let status = statusSchema.parse(await host.harness.behavior.callRpc('status', null));
    assert.deepEqual(status.mirrors.map(m => m.blocker), ['reconnect', 'reconnect', null, 'capacity', 'rebuild', null]);
    assert.equal(status.mirrors[2].phase, 'paused'); assert.equal(status.mirrors[5].phase, 'retained');
    await host.harness.lifecycle.dispose();
    host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider, repository });
    await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, attempts);
    await host.harness.behavior.callRpc('enable', { id: 'one' }); assert.equal(provider.synced, attempts + 1);
    await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, attempts + 2);
    status = statusSchema.parse(await host.harness.behavior.callRpc('status', null));
    assert.equal(status.mirrors[1].blocker, 'reconnect'); assert.equal(status.mirrors[1].lastSuccess, '2026-01-01T00:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
