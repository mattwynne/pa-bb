import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { sourceModePorts, sourceGeneration, loopbackServer, receiptDirectory } from '../adapters/source-mode.ts';
import type { IntegrationId, SourceSwitch } from '../core/application-model.ts';
import { SourceSwitchError } from '../core/application-model.ts';
import { Application } from '../core/application.ts';
import type { ApplicationPorts } from '../core/application.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
import type { z } from 'zod';
import type { reviewSchema } from '../core/application-model.ts';
import { componentIds, originUrl } from '../core/workspace.ts';
type Review = z.infer<typeof reviewSchema>;

async function fixture(id: IntegrationId = 'fastmail', target: 'local' | 'github' = 'local') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pa-source-mode-'))), checkout = join(home, 'repo'), path = join(checkout, 'plugins', id), receiptRoot = join(home, 'receipts');
  await mkdir(path, { recursive: true });
  const manifest = { name: `bb-plugin-${id}`, version: '0.3.0', engines: { bb: '>=0.46.0', bbPluginSdk: '>=0.6.37 <1' }, bb: { server: './server.ts' } };
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest)); await writeFile(join(path, 'server.ts'), 'export default () => {};');
  let installed = true, disabled = false, conflict = false, updateConflict = false, changed = false, calls = 0;
  let installFailure = false, loseRemove = false, loseInstall = false, pauseFailure = false, auth = false, redirect = false, wrongSource = false;
  let currentTarget = target === 'local' ? 'github' : 'local';
  const events: string[] = [], logs: string[] = [], bodies: unknown[] = [], headers: unknown[] = [], remembered: unknown[] = [];
  const mirrors = [{ id: randomUUID(), enabled: false, phase: 'paused' }, { id: randomUUID(), enabled: false, phase: 'retained' }], owned = new Set([mirrors[0].id]);
  const jobId = randomUUID(), nativeJob = randomUUID();
  const plugin = () => ({ id, version: '0.3.0', rootDir: currentTarget === 'local' ? path : join(home, 'snapshot', id), enabled: !disabled, status: 'needs-configuration', statusDetail: null, app: { hasApp: false } });
  const source = () => currentTarget === 'local' ? { requested: `path:${path}`, resolved: `path:${path}` } : { requested: `git:${originUrl}@main`, resolved: `git:${originUrl}@main (${(changed ? 'b' : 'a').repeat(40)})`, subdirectory: `plugins/${id}` };
  let afterDelete: (() => Promise<void>) | undefined;
  let heldJob: string | null = jobId;
  const sync = () => ({ updatePause: { version: 1, jobId: heldJob }, mirrors });
  const server = createServer(async (req, res) => {
    calls++; headers.push(req.headers);
    let body = ''; for await (const chunk of req) body += chunk;
    if (body) bodies.push(JSON.parse(body));
    const json = (value: unknown, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (auth) return json({ error: 'PRIVATE_SENTINEL cookie token' }, 401);
    if (redirect) { res.writeHead(302, { Location: 'http://private.example/PRIVATE_SENTINEL' }); return res.end(); }
    const route = req.url?.replace('/api/v1', '');
    if (route === '/plugins' && req.method === 'GET') return json({ plugins: installed ? [plugin()] : [] });
    if (route === '/plugins/install-jobs' && req.method === 'GET') return json({ jobs: conflict ? [{ id: nativeJob, state: 'running' }] : [] });
    if (route === '/plugins/update-jobs' && req.method === 'GET') return json({ jobs: updateConflict ? [{ id: nativeJob, state: 'running' }] : [] });
    if (route === `/plugins/${id}/source`) return json(wrongSource && currentTarget === target ? { requested: 'https://PRIVATE_SENTINEL' } : source());
    if (route === '/plugins/icloud/rpc/status') return json({ ok: true, result: sync() });
    if (route === '/plugins/icloud/rpc/pause') {
      events.push('user-pause'); const input = JSON.parse(body);
      if (pauseFailure && events.filter(e => e === 'user-pause').length === 2) return json({ error: 'PRIVATE_SENTINEL body' }, 500);
      owned.delete(input.id); return json({ ok: true, result: sync() });
    }
    if (route === `/plugins/${id}` && req.method === 'DELETE') {
      events.push('remove'); installed = false; await afterDelete?.();
      if (loseRemove) return req.socket.destroy();
      return json({ ok: true });
    }
    if (route === '/plugins/install' && req.method === 'POST') {
      events.push('install'); currentTarget = target;
      if (loseInstall) return req.socket.destroy();
      return json({ ok: true, job: { id: nativeJob, state: 'queued' } }, 202);
    }
    if (route === `/plugins/install-jobs/${nativeJob}`) {
      events.push('poll'); if (installFailure) return json({ job: { id: nativeJob, state: 'failed', error: 'PRIVATE_SENTINEL response body' } });
      installed = true; return json({ job: { id: nativeJob, state: 'succeeded', plugin: plugin() } });
    }
    return json({ error: 'PRIVATE_SENTINEL unexpected' }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bb = { server: { loopbackBaseUrl: baseUrl, experimental_dataDir: '/fixture/bb-read-only' }, log: { warn: (value: string) => logs.push(value) }, sdk: {
    plugins: { list: async () => ({ plugins: installed ? [plugin()] : [] }), getSource: async () => source(), installJobs: { list: async () => conflict ? [{ id: nativeJob, state: 'running' }] : [] }, experimental_updateJobs: { list: async () => updateConflict ? [{ id: nativeJob, state: 'running' }] : [] }, callRpc: async (args: { method: string; input: unknown }) => {
      if (args.method === 'pause') {
        assert.deepEqual(args.input, { updateJob: jobId }); events.push('barrier'); heldJob = jobId;
      }
      return sync();
    } },
    system: { version: async () => ({ currentVersion: '0.47.1' }) },
  } } as unknown as BbPluginApi;
  const makePorts = (overrides: Partial<Parameters<typeof sourceModePorts>[1]> = {}) => sourceModePorts(bb, { receiptRoot, checkout: async () => checkout, manifest: async () => manifest, remember: async (...args) => { remembered.push(args); }, ...overrides });
  const ports = makePorts();
  const at = new Date().toISOString();
  const receipt: SourceSwitch = { jobId, reviewId: randomUUID(), id, target, phase: 'ready', reason: null, startedAt: at, updatedAt: at, removalAttempted: false, removed: false, installAdmitted: false, pauseHandoff: false, syncReserved: id === 'icloud' || id === 'obsidian', manualRecovery: false, configuration: 'reset_expected', actual: null };
  const review: Review = { id: receipt.reviewId, at, rows: [], runtime: null,
    workspace: { head: 'a'.repeat(40), originHead: 'b'.repeat(40), dirty: false, ahead: false, behind: false,
      components: Object.fromEntries(componentIds.map(id => [id, { local: false, upstream: false, working: 'a'.repeat(64), origin: 'a'.repeat(64) }])) as NonNullable<Review['workspace']>['components'] },
    inventory: [{ id, sourceEnabled: true, sourceMode: target === 'local' ? 'managed' : 'local', sourceGeneration: sourceGeneration(plugin(), source()), installed: '0.3.0', state: 'current', local: 'stock', prerequisite: null }] };
  const wait = async () => {
    for (let i = 0; i < 1000; i++) { const result = await ports.observe(); if (result && ['complete', 'attention'].includes(result.phase)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('Runner did not finish');
  };
  const restore = async () => {
    assert.equal(owned.size, 0, 'release must have no resume rights'); assert.ok(mirrors.every(m => !m.enabled));
    events.push('restore'); heldJob = null;
  };
  const recoveryApp = (sourceMode = ports) => new Application({ sourceMode, restore, inspect: async () => [], inventory: () => review.inventory!,
    validateMix: async () => {}, quiesce: async () => { throw Error('Recovery must not re-reserve'); }, update: async () => { throw Error('Recovery must not install'); },
    load: async () => ({ review: null, job: null }), save: async () => {}, diagnose: (stage, code) => logs.push(`pa-updates stage=${stage} outcome=${code}`),
  } satisfies ApplicationPorts);
  return { ports, makePorts, recoveryApp, restore, receipt, review, path, receiptRoot, home, bb, events, logs, bodies, headers, remembered, owned, mirrors,
    manual: (mode: 'local' | 'github' = target, present = true) => { currentTarget = mode; installed = present; },
    prepare: () => ports.prepare(receipt, review), wait, calls: () => calls,
    onDelete: (callback: () => Promise<void>) => { afterDelete = callback; },
    hold: (value: string | null) => { heldJob = value; },
    set: (flags: Partial<Record<'disabled' | 'conflict' | 'updateConflict' | 'changed' | 'installFailure' | 'loseRemove' | 'loseInstall' | 'pauseFailure' | 'auth' | 'redirect' | 'wrongSource', boolean>>) => {
      disabled = flags.disabled ?? disabled; conflict = flags.conflict ?? conflict; updateConflict = flags.updateConflict ?? updateConflict; changed = flags.changed ?? changed; installFailure = flags.installFailure ?? installFailure; loseRemove = flags.loseRemove ?? loseRemove; loseInstall = flags.loseInstall ?? loseInstall; pauseFailure = flags.pauseFailure ?? pauseFailure; auth = flags.auth ?? auth; redirect = flags.redirect ?? redirect; wrongSource = flags.wrongSource ?? wrongSource;
    },
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(home, { recursive: true, force: true }); },
  };
}
test('server URL is exact loopback only; durable directory is private and instance-scoped', () => {
  assert.equal(loopbackServer('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  assert.equal(loopbackServer('http://[::1]:1234'), 'http://[::1]:1234');
  for (const value of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://user:secret@127.0.0.1:1234', 'http://127.1:1234', 'http://127.0.0.1:1234/api', 'http://127.0.0.1:1234/?token=PRIVATE_SENTINEL', 'http://example.com:1234']) assert.throws(() => loopbackServer(value));
  assert.notEqual(receiptDirectory('/fixture/a', '/owner'), receiptDirectory('/fixture/b', '/owner'));
  assert.ok(!receiptDirectory('/fixture/a', '/owner').includes('/fixture'));
});
test('finite detached runner admits one remove/install, verifies activation and records settings loss', async () => {
  const f = await fixture('pa-updates');
  try {
    await f.prepare(); assert.equal(f.calls(), 0, 'prepare does not make raw REST writes');
    const script = await readFile(join(f.receiptRoot, 'runner.mjs'), 'utf8');
    assert.ok(!/from ['"]|npx|process\.env|Bearer/.test(script));
    assert.ok([...script.matchAll(/import\(['"]([^'"]+)['"]\)/g)].every(match => match[1].startsWith('node:')));
    assert.equal((await stat(f.receiptRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.receiptRoot, 'intent.json'))).mode & 0o777, 0o600);
    const immutable = await readFile(join(f.receiptRoot, 'intent.json'), 'utf8');
    assert.equal(JSON.parse(immutable).serverPid, process.pid);
    await f.ports.launch(f.receipt);
    const identity = JSON.parse(await readFile(join(f.receiptRoot, 'launch.json'), 'utf8'));
    assert.equal(identity.jobId, f.receipt.jobId); assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
    for (const name of ['ready.json', 'permit.json']) assert.deepEqual(JSON.parse(await readFile(join(f.receiptRoot, name), 'utf8')), identity);
    const result = await f.wait(); assert.equal(result.phase, 'complete'); assert.equal(result.configuration, 'deleted');
    assert.deepEqual(f.events.filter(e => ['remove', 'install'].includes(e)), ['remove', 'install']);
    assert.equal(await readFile(join(f.receiptRoot, 'intent.json'), 'utf8'), immutable);
    await assert.rejects(f.ports.launch(f.receipt));
    const restarted = sourceModePorts(f.bb, { receiptRoot: f.receiptRoot, manifest: async () => { throw Error(); }, remember: async () => {} });
    await restarted.observe(); await restarted.observe(true);
    assert.equal(f.events.filter(e => e === 'install').length, 1);
    assert.ok(f.headers.every(h => !JSON.stringify(h).includes('authorization') && !JSON.stringify(h).includes('cookie') && !Object.hasOwn(h as object, 'origin')));
    assert.ok(f.bodies.some(body => JSON.stringify(body) === JSON.stringify({ source: `path:${f.path}`, selection: { kind: 'root' } })));
    assert.ok(!JSON.stringify([result, f.logs]).includes(f.path));
  } finally { await f.close(); }
});
for (const flag of ['disabled', 'conflict', 'updateConflict', 'changed'] as const) test(`preflight refuses ${flag} without a native mutation`, async () => {
  const f = await fixture(); try { f.set({ [flag]: true }); await assert.rejects(f.prepare()); assert.deepEqual(f.events, []); } finally { await f.close(); }
});
for (const flag of ['changed', 'conflict', 'updateConflict', 'auth', 'redirect'] as const) test(`runner rechecks ${flag} after readiness and stops before remove`, async () => {
  const f = await fixture(); try {
    await f.prepare(); f.set({ [flag]: true }); await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.phase, 'attention'); assert.equal(result.removalAttempted, false); assert.equal(result.configuration, 'reset_expected'); assert.deepEqual(f.events, []);
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});
for (const flag of ['installFailure', 'loseRemove', 'loseInstall', 'wrongSource'] as const) test(`${flag} never retries an uncertain mutation and keeps honest manual recovery`, async () => {
  const f = await fixture(); try {
    await f.prepare(); f.set({ [flag]: true }); await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.phase, 'attention'); assert.equal(result.manualRecovery, true);
    assert.equal(result.configuration, flag === 'loseRemove' ? 'possibly_deleted' : 'deleted');
    assert.equal(result.reason, flag === 'installFailure' ? 'install_failed' : flag === 'loseRemove' ? 'remove_uncertain' : flag === 'loseInstall' ? 'install_uncertain' : 'verification_failed');
    await f.ports.observe(); await f.ports.observe();
    assert.equal(f.events.filter(e => e === 'remove').length, 1); assert.equal(f.events.filter(e => e === 'install').length, flag === 'loseRemove' ? 0 : 1);
    assert.equal(f.logs.length, 1); assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});
for (const partial of [false, true]) test(`pause handoff ${partial ? 'partially fails without removal' : 'revokes all owned resumes before removal'}`, async () => {
  const f = await fixture('icloud'); try {
    // Include the actual provider in adapter preflight; its status capability is
    // checked by the runner under an already reserved/drained job UUID.
    await f.prepare(); f.set({ pauseFailure: partial }); await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(f.events.filter(e => e === 'user-pause').length, 2); assert.equal(f.owned.size, 0);
    assert.equal(result.pauseHandoff, !partial); assert.equal(f.events.includes('remove'), !partial);
    assert.equal(result.syncReserved, true, 'runner never releases or re-reserves');
    assert.equal(result.reason, partial ? 'pause_incomplete' : null);
  } finally { await f.close(); }
});
test('current-version source switches allow edited/ahead work and never discard local bytes', async () => {
  const f = await fixture(); try {
    f.review.workspace!.dirty = true; f.review.workspace!.ahead = true;
    await writeFile(join(f.path, 'server.ts'), 'export default () => "uncommitted";');
    await f.prepare(); await assert.rejects(f.prepare(), 'a second prepare cannot reset the admission gate');
    await f.ports.launch(f.receipt); assert.equal((await f.wait()).phase, 'complete');
    assert.equal(await readFile(join(f.path, 'server.ts'), 'utf8'), 'export default () => "uncommitted";');
    assert.deepEqual(f.review.rows, [], 'switches do not require an update offer');
    await f.ports.observe(true); await f.ports.observe(true); assert.equal(f.remembered.length, 1);
    await writeFile(join(f.path, 'server.ts'), 'export default () => "later work";');
    assert.equal((await f.ports.observe(true))?.phase, 'complete', 'settled receipt is historical, not authority to bless later work');
    assert.equal(f.remembered.length, 1);
  } finally { await f.close(); }
});
test('switch back uses managed GitHub main and retains edited local code', async () => {
  const f = await fixture('fastmail', 'github'); try {
    f.review.workspace!.dirty = true; f.review.workspace!.ahead = true;
    await f.prepare(); await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.phase, 'complete'); assert.equal(result.configuration, 'deleted');
    assert.ok(f.bodies.some(body => JSON.stringify(body) === JSON.stringify({ source: `git:${originUrl}@main`, selection: { kind: 'subdirectory', path: 'plugins/fastmail' } })));
    assert.equal(await readFile(join(f.path, 'server.ts'), 'utf8'), 'export default () => {};');
    assert.equal(f.remembered.length, 0);
  } finally { await f.close(); }
});
test('missing declared local runtime dependencies refuse preparation before any settings-reset boundary', async () => {
  const f = await fixture('pa-updates'); try {
    const file = join(f.path, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, dependencies: { semver: '7.7.4' } }));
    await assert.rejects(f.prepare(), (error: unknown) => error instanceof SourceSwitchError && error.sourceReason === 'dependencies_missing');
    assert.deepEqual(f.events, []); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
test('runtime dependency resolution is read-only, excludes dev tools and permits the public SDK shim', async () => {
  const f = await fixture('pa-updates'); try {
    const file = join(f.path, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, dependencies: { semver: '7.7.4', '@get-bb/plugin-sdk': '0.6.37' }, devDependencies: { 'absent-private-test-tool': '1.0.0' } }));
    const module = join(f.path, 'node_modules/semver'); await mkdir(module, { recursive: true });
    await writeFile(join(module, 'package.json'), JSON.stringify({ name: 'semver', version: '7.7.4', main: 'index.js' }));
    await writeFile(join(module, 'index.js'), 'throw new Error("PRIVATE_SENTINEL dependency must not execute");');
    await f.prepare(); await f.ports.launch(f.receipt); assert.equal((await f.wait()).phase, 'complete');
    assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});
test('dependencies removed after preparation are rechecked before native removal', async () => {
  const f = await fixture('pa-updates'); try {
    const file = join(f.path, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, dependencies: { semver: '7.7.4' } }));
    const module = join(f.path, 'node_modules/semver'); await mkdir(module, { recursive: true });
    await writeFile(join(module, 'package.json'), JSON.stringify({ name: 'semver', version: '7.7.4', main: 'index.js' }));
    await writeFile(join(module, 'index.js'), 'export default {};');
    await f.prepare(); await rm(join(f.path, 'node_modules'), { recursive: true });
    await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.reason, 'dependencies_missing'); assert.equal(result.removalAttempted, false); assert.equal(result.configuration, 'reset_expected'); assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
test('loopback identity cannot be retargeted between preparation and launch', async () => {
  const f = await fixture(); try {
    await f.prepare(); Object.defineProperty(f.bb.server, 'loopbackBaseUrl', { value: 'http://127.0.0.1:1' });
    await assert.rejects(f.ports.launch(f.receipt)); assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
test('uncommitted work after completed activation is never blessed as applied', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.ports.launch(f.receipt); await f.wait();
    await writeFile(join(f.path, 'server.ts'), 'export default () => "later uncommitted work";');
    assert.equal((await f.ports.observe(true))?.phase, 'complete'); assert.equal(f.remembered.length, 0);
    await f.ports.observe(true); assert.equal(f.logs.length, 1); assert.match(f.logs[0], /stage=source-observe outcome=changed$/);
  } finally { await f.close(); }
});
test('observer refuses reservation release if the retained sync hold changed after reinstall', async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); await f.ports.launch(f.receipt); assert.equal((await f.wait()).phase, 'complete');
    f.mirrors[0].enabled = true;
    const observed = await f.ports.observe(true); assert.equal(observed?.phase, 'attention'); assert.equal(observed?.reason, 'pause_required'); assert.equal(observed?.syncReserved, true);
  } finally { await f.close(); }
});
test('missing canonical target or mismatched package metadata never removes an installed plugin', async () => {
  for (const missing of [false, true]) {
    const f = await fixture(); try {
      if (missing) await rm(f.path, { recursive: true });
      else await writeFile(join(f.path, 'package.json'), JSON.stringify({ name: 'bb-plugin-other', version: '0.3.0' }));
      await assert.rejects(f.prepare()); assert.deepEqual(f.events, []);
    } finally { await f.close(); }
  }
});
test('expired filesystem receipt becomes manual recovery without a process spawn or native call', async () => {
  const f = await fixture(); try {
    await f.prepare();
    await writeFile(join(f.receiptRoot, 'receipt.json'), JSON.stringify({ ...f.receipt, startedAt: new Date(Date.now() - 13 * 60_000).toISOString() }));
    const result = await f.ports.observe(); assert.equal(result?.phase, 'attention'); assert.equal(result?.reason, 'interrupted'); assert.equal(result?.manualRecovery, true); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
test('owned child dying before readiness leaves a recoverable pre-write terminal failure, not a stranded ready receipt', async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); await writeFile(join(f.receiptRoot, 'runner.mjs'), 'process.exit(1);');
    await assert.rejects(f.ports.launch(f.receipt));
    const raw = JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8'));
    assert.equal(raw.phase, 'attention'); assert.equal(raw.reason, 'unavailable');
    assert.equal(raw.removalAttempted, false); assert.equal(raw.removed, false); assert.equal(raw.installAdmitted, false);
    assert.equal(raw.configuration, 'reset_expected'); assert.equal(raw.manualRecovery, true); assert.equal(raw.syncReserved, true);
    await assert.rejects(readFile(join(f.receiptRoot, 'permit.json')), { code: 'ENOENT' });
    assert.equal(f.events.length, 0);
    const app = f.recoveryApp(); await app.start(); const recovered = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(recovered.sourceSwitch?.recovery, 'aborted_before_removal'); assert.equal(recovered.sourceSwitch?.manualRecovery, false);
    assert.equal(recovered.sourceSwitch?.syncReserved, false); assert.equal(f.events.filter(e => e === 'user-pause').length, f.mirrors.length);
    assert.equal(f.events.filter(e => e === 'restore').length, 1); assert.equal(f.events.includes('remove') || f.events.includes('install'), false);
  } finally { await f.close(); }
});
test('disabled source preflight ignores stale enabled client facts and returns the disabled reason', async () => {
  const f = await fixture(); try {
    f.set({ disabled: true }); assert.equal(f.review.inventory![0].sourceEnabled, true);
    await assert.rejects(f.prepare(), (error: unknown) => error instanceof SourceSwitchError && error.sourceReason === 'disabled');
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
test('explicit recovery verifies manual target reinstall, unblocks checks, and never learns applied bytes or retries native writes', async () => {
  const f = await fixture(); try {
    await f.prepare(); f.set({ installFailure: true }); await f.ports.launch(f.receipt); await f.wait();
    f.manual(); const app = f.recoveryApp(); await app.start();
    const recovered = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(recovered.sourceSwitch?.phase, 'complete'); assert.equal(recovered.sourceSwitch?.recovery, 'target_verified');
    assert.equal(recovered.sourceSwitch?.manualRecovery, false); assert.equal(recovered.sourceSwitch?.configuration, 'deleted');
    await app.refresh(); assert.equal(f.remembered.length, 0);
    assert.ok((await app.review()).review); assert.equal(f.events.filter(e => e === 'remove').length, 1); assert.equal(f.events.filter(e => e === 'install').length, 1);
    const raw = JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8'));
    assert.equal(raw.manualRecovery, false); assert.equal(raw.recovery, 'target_verified');
    const next = f.recoveryApp(); await next.start(); assert.equal(next.status().sourceSwitch?.manualRecovery, false);
  } finally { await f.close(); }
});
for (const state of ['wrong', 'absent', 'install-job', 'update-job'] as const) test(`recovery retains manual state for ${state}`, async () => {
  const f = await fixture(); try {
    await f.prepare(); f.set({ installFailure: true }); await f.ports.launch(f.receipt); await f.wait();
    f.manual(state === 'wrong' ? 'github' : 'local', state !== 'absent');
    if (state === 'install-job') f.set({ conflict: true });
    if (state === 'update-job') f.set({ updateConflict: true });
    const app = f.recoveryApp(); await app.start(); await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.equal(app.status().sourceSwitch?.manualRecovery, true); assert.equal(f.events.includes('restore'), false);
    assert.equal(f.events.filter(e => e === 'remove').length, 1); assert.equal(f.events.filter(e => e === 'install').length, 1);
    assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});
test('derived running expiry is never a recoverable raw terminal receipt', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.ports.settle({ ...f.receipt, phase: 'running', startedAt: new Date(Date.now() - 13 * 60_000).toISOString() });
    const app = f.recoveryApp(); await app.start(); assert.equal(app.status().sourceSwitch?.phase, 'attention');
    await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.equal(JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8')).phase, 'running');
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
test('recovery safely aborts before removal only at the exact original registration', async () => {
  const f = await fixture(); try {
    await f.prepare(); await f.ports.settle({ ...f.receipt, phase: 'attention', reason: 'changed', manualRecovery: true });
    f.set({ changed: true }); const app = f.recoveryApp(); await app.start();
    await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    f.set({ changed: false }); const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(result.sourceSwitch?.phase, 'attention'); assert.equal(result.sourceSwitch?.recovery, 'aborted_before_removal');
    assert.equal(result.sourceSwitch?.manualRecovery, false); assert.equal(result.sourceSwitch?.removalAttempted, false);
    assert.equal(result.sourceSwitch?.configuration, 'reset_expected'); assert.ok((await app.review()).review); assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
test('paired recovery pauses every mirror, never releases partial ownership, then releases empty rights', async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); await f.ports.settle({ ...f.receipt, phase: 'attention', reason: 'pause_incomplete', manualRecovery: true });
    f.set({ pauseFailure: true }); const app = f.recoveryApp(); await app.start();
    await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.equal(app.status().sourceSwitch?.manualRecovery, true); assert.equal(app.status().sourceSwitch?.syncReserved, true);
    assert.equal(f.events.includes('restore'), false); assert.equal((await f.ports.observe())?.pauseHandoff, false);
    f.set({ pauseFailure: false }); const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(result.sourceSwitch?.recovery, 'aborted_before_removal'); assert.equal(result.sourceSwitch?.manualRecovery, false);
    assert.equal(result.sourceSwitch?.syncReserved, false); assert.ok(f.mirrors.every(m => !m.enabled)); assert.equal(f.owned.size, 0);
    assert.equal(f.events.filter(e => e === 'user-pause').length, 4); assert.equal(f.events.filter(e => e === 'restore').length, 1);
    assert.equal(f.events.includes('remove') || f.events.includes('install'), false);
  } finally { await f.close(); }
});
test('paired manual target recovery keeps folders paused and tolerates a lost successful cleanup response', async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); f.set({ installFailure: true }); await f.ports.launch(f.receipt); await f.wait(); f.manual();
    // Crash/response loss after recovery handoff and restore but before final
    // receipt settlement must have an explicit, verifiable path out.
    const handoff = await f.ports.recover(f.receipt.jobId); assert.equal(handoff.pauseHandoff, true); await f.restore();
    const app = f.recoveryApp(); await app.start(); const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(result.sourceSwitch?.phase, 'complete'); assert.equal(result.sourceSwitch?.syncReserved, false);
    assert.equal(result.sourceSwitch?.manualRecovery, false); assert.equal(f.owned.size, 0); assert.ok(f.mirrors.every(m => !m.enabled));
  } finally { await f.close(); }
});
test('disposal fences a delayed pause observation without joining its native read or writing a stale receipt', async () => {
  const f = await fixture('icloud'), controller = new AbortController(), entered = deferred(), gate = deferred();
  try {
    await f.prepare(); await f.ports.launch(f.receipt); await f.wait(); f.mirrors[0].enabled = true;
    const original = f.bb.sdk.plugins.callRpc;
    f.bb.sdk.plugins.callRpc = async args => { entered.resolve(); await gate.promise; return original(args); };
    const old = f.makePorts({ active: () => controller.signal.throwIfAborted() });
    const observing = old.observe(true); await entered.promise; controller.abort(); await old.drain();
    await f.ports.settle({ ...f.receipt, phase: 'attention', reason: 'changed', manualRecovery: true });
    const replacement = await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8');
    gate.resolve(); await assert.rejects(observing);
    assert.equal(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8'), replacement);
  } finally { gate.resolve(); await f.close(); }
});
test('disposal fences delayed applied observation before remember or observed-marker writes', async () => {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), gate = deferred();
  try {
    await f.prepare(); await f.ports.launch(f.receipt); await f.wait();
    const original = f.bb.sdk.plugins.list;
    f.bb.sdk.plugins.list = async args => { entered.resolve(); await gate.promise; return original(args); };
    const old = f.makePorts({ active: () => controller.signal.throwIfAborted() });
    const observing = old.observe(true); await entered.promise; controller.abort(); await old.drain();
    await writeFile(join(f.receiptRoot, 'observed.json'), JSON.stringify({ jobId: 'replacement' }));
    gate.resolve(); await assert.rejects(observing);
    assert.equal(f.remembered.length, 0); assert.equal(JSON.parse(await readFile(join(f.receiptRoot, 'observed.json'), 'utf8')).jobId, 'replacement');
  } finally { gate.resolve(); await f.close(); }
});
test('disposal drains only issued filesystem writes, and admits no stale write after replacement starts', async () => {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), gate = deferred();
  try {
    await f.prepare();
    const old = f.makePorts({ active: () => controller.signal.throwIfAborted(), atomicWrite: async (path, value) => { entered.resolve(); await gate.promise; await writeFile(path, JSON.stringify(value)); } });
    const settling = old.settle({ ...f.receipt, phase: 'attention', reason: 'changed' });
    const rejection = assert.rejects(settling); await entered.promise; controller.abort();
    let drained = false; const draining = old.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false); gate.resolve(); await draining; await rejection;
    await f.ports.settle({ ...f.receipt, phase: 'attention', reason: 'unavailable' });
    await assert.rejects(old.settle({ ...f.receipt, phase: 'attention', reason: 'changed' }));
    assert.equal(JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8')).reason, 'unavailable');
  } finally { gate.resolve(); await f.close(); }
});
test('edited local generation after review is refused before removal', async () => {
  const f = await fixture(); try {
    await f.prepare(); await writeFile(join(f.path, 'server.ts'), 'export default () => "changed";');
    await f.ports.launch(f.receipt); const result = await f.wait(); assert.equal(result.reason, 'changed'); assert.equal(result.removalAttempted, false);
  } finally { await f.close(); }
});

async function seedOwnedRunner(f: Awaited<ReturnType<typeof fixture>>, pid: number) {
  for (const name of ['launch', 'ready', 'permit']) await writeFile(join(f.receiptRoot, name + '.json'), JSON.stringify({ jobId: f.receipt.jobId, pid }));
}
async function setServerPid(f: Awaited<ReturnType<typeof fixture>>, serverPid: number | null) {
  const file = join(f.receiptRoot, 'intent.json'), intent = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...intent, serverPid }));
}
const absentProcess = () => { throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ESRCH' }); };

for (const id of ['fastmail', 'icloud'] as const) for (const phase of ['ready', 'running'] as const) test(`${id} raw ${phase} owned runner death permits explicit recovery, never startup transfer or replay`, async () => {
  const f = await fixture(id); try {
    await f.prepare();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid!; assert.ok(pid > 0); await new Promise<void>(resolve => child.once('close', () => resolve()));
    await seedOwnedRunner(f, pid);
    await f.ports.settle({ ...f.receipt, phase });
    const raw = await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8');
    const app = f.recoveryApp(); await app.start();
    assert.equal(app.status().sourceSwitch?.phase, 'attention', 'positive owned death is visible immediately, not after expiry');
    assert.equal(app.status().sourceSwitch?.reason, 'interrupted');
    await app.refresh();
    assert.equal(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8'), raw); assert.deepEqual(f.events, []);
    const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
    assert.equal(result.sourceSwitch?.recovery, 'aborted_before_removal'); assert.equal(result.sourceSwitch?.manualRecovery, false);
    assert.equal(result.sourceSwitch?.configuration, 'reset_expected');
    assert.deepEqual(f.events, id === 'icloud' ? ['user-pause', 'user-pause', 'restore'] : []);
  } finally { await f.close(); }
});

for (const state of ['alive', 'EPERM', 'unknown', 'missing', 'mismatched-job', 'mismatched-pid', 'reused-pid'] as const) test(`raw runner recovery blocks ${state} ownership`, async () => {
  const f = await fixture(); try {
    await f.prepare(); await seedOwnedRunner(f, process.pid); await f.ports.settle({ ...f.receipt, phase: 'running' });
    if (state === 'missing') await rm(join(f.receiptRoot, 'ready.json'));
    if (state === 'mismatched-job') await writeFile(join(f.receiptRoot, 'permit.json'), JSON.stringify({ jobId: randomUUID(), pid: process.pid }));
    if (state === 'mismatched-pid') await writeFile(join(f.receiptRoot, 'ready.json'), JSON.stringify({ jobId: f.receipt.jobId, pid: process.pid + 1 }));
    const ports = f.makePorts({ probeProcess: () => {
      if (['alive', 'reused-pid'].includes(state)) return;
      if (state === 'EPERM' || state === 'unknown') throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: state });
      absentProcess();
    } });
    const app = f.recoveryApp(ports); await app.start();
    await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.equal(JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8')).phase, 'running');
    assert.deepEqual(f.events, []); assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});

for (const phase of ['running', 'attention'] as const) for (const state of ['alive', 'EPERM', 'unknown', 'reused-pid', 'missing', 'gone', 'original'] as const) test(`${phase} attempted unconfirmed DELETE requires original server gone: ${state}`, async () => {
  const f = await fixture(); try {
    await f.prepare(); await seedOwnedRunner(f, 12345); await setServerPid(f, state === 'missing' ? null : 12346);
    await f.ports.settle({ ...f.receipt, phase, reason: phase === 'attention' ? 'remove_uncertain' : null, manualRecovery: phase === 'attention', removalAttempted: true, configuration: 'possibly_deleted' });
    f.manual(state === 'original' ? 'github' : 'local');
    const ports = f.makePorts({ probeProcess: pid => {
      if (pid === 12345 || state === 'gone' || state === 'original') return absentProcess();
      if (state === 'EPERM' || state === 'unknown') throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: state });
    } });
    const app = f.recoveryApp(ports); await app.start();
    if (state === 'gone') {
      const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
      assert.equal(result.sourceSwitch?.recovery, 'target_verified'); assert.equal(result.sourceSwitch?.configuration, 'possibly_deleted');
      assert.equal(result.sourceSwitch?.removed, false); assert.equal(result.sourceSwitch?.installAdmitted, false);
    } else await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});

for (const state of ['alive', 'EPERM', 'missing', 'gone', 'changed', 'active-job', 'post-removal', 'enabled', 'running'] as const) test(`null-hold Pause recovery is restart-gated with same-job barrier: ${state}`, async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); await setServerPid(f, state === 'missing' ? null : 12346); f.hold(null);
    await f.ports.settle({ ...f.receipt, phase: 'attention', reason: 'pause_required', manualRecovery: true,
      ...(state === 'post-removal' ? { removalAttempted: true, removed: true, configuration: 'deleted' as const } : {}) });
    if (state === 'changed') f.set({ changed: true });
    if (state === 'active-job') f.set({ updateConflict: true });
    if (state === 'post-removal') f.manual();
    if (state === 'enabled') f.mirrors[0].enabled = true;
    if (state === 'running') f.mirrors[0].phase = 'running';
    const ports = f.makePorts({ probeProcess: () => {
      if (state === 'alive') return;
      if (state === 'EPERM') throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'EPERM' });
      absentProcess();
    } });
    const app = f.recoveryApp(ports); await app.start(); await app.refresh(); assert.deepEqual(f.events, []);
    if (state === 'gone') {
      const result = await app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId });
      assert.equal(result.sourceSwitch?.syncReserved, false); assert.equal(result.sourceSwitch?.manualRecovery, false);
      assert.deepEqual(f.events, ['barrier', 'user-pause', 'user-pause', 'restore']); assert.equal(f.owned.size, 0);
      assert.ok(f.mirrors.every(m => !m.enabled));
    } else { await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId })); assert.deepEqual(f.events, []); }
    assert.ok(!JSON.stringify(f.logs).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});

test('manifest identity edited during DELETE leaves configuration deleted and never installs another ID', async () => {
  const f = await fixture(); try {
    await f.prepare(); f.onDelete(async () => {
      const file = join(f.path, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...manifest, name: 'bb-plugin-unrelated' }));
    });
    await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.phase, 'attention'); assert.equal(result.reason, 'changed'); assert.equal(result.configuration, 'deleted');
    assert.equal(result.removed, true); assert.equal(result.installAdmitted, false); assert.deepEqual(f.events, ['remove']);
  } finally { await f.close(); }
});

for (const change of ['source', 'dependencies'] as const) test(`${change} edited during DELETE is rechecked before install admission`, async () => {
  const f = await fixture(); try {
    if (change === 'dependencies') {
      const file = join(f.path, 'package.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...manifest, dependencies: { semver: '7.7.4' } }));
      const module = join(f.path, 'node_modules/semver'); await mkdir(module, { recursive: true });
      await writeFile(join(module, 'package.json'), JSON.stringify({ name: 'semver', main: 'index.js' }));
      await writeFile(join(module, 'index.js'), 'throw Error("PRIVATE_SENTINEL");');
    }
    await f.prepare(); f.onDelete(async () => {
      if (change === 'dependencies') await rm(join(f.path, 'node_modules'), { recursive: true });
      else await writeFile(join(f.path, 'server.ts'), 'export default () => "later work";');
    });
    await f.ports.launch(f.receipt); const result = await f.wait();
    assert.equal(result.reason, change === 'source' ? 'changed' : 'dependencies_missing');
    assert.equal(result.configuration, 'deleted'); assert.equal(result.removed, true); assert.equal(result.installAdmitted, false);
    assert.deepEqual(f.events, ['remove']); assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});

for (const state of ['changed', 'install-job', 'update-job'] as const) test(`dead raw running owner cannot bypass ${state} recovery guard`, async () => {
  const f = await fixture('icloud'); try {
    await f.prepare(); await seedOwnedRunner(f, 12345); await f.ports.settle({ ...f.receipt, phase: 'running' });
    if (state === 'changed') f.set({ changed: true });
    if (state === 'install-job') f.set({ conflict: true });
    if (state === 'update-job') f.set({ updateConflict: true });
    const app = f.recoveryApp(f.makePorts({ probeProcess: absentProcess })); await app.start(); await app.refresh();
    await assert.rejects(app.acknowledgeSourceRecovery({ jobId: f.receipt.jobId }));
    assert.equal(JSON.parse(await readFile(join(f.receiptRoot, 'receipt.json'), 'utf8')).phase, 'running'); assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
