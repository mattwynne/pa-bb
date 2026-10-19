import test from 'node:test';
import assert from 'node:assert/strict';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { readFile } from 'node:fs/promises';
import { ICloud } from '../adapters/icloud.ts';
const local = { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null };
const mirror = { id: 'one', folder: { name: 'Generated' }, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00Z', failure: null, local };
function fixture() {
  let plugins: any[] = [{ id: 'icloud', enabled: true, status: 'running' }]; const state: any = { noteAccessVersion: 2, available: true, connected: true, challenge: null, mirrors: [structuredClone(mirror)] }; let failed = false; let rpcFailure = '';
  const logs: string[] = []; const calls: Array<{ method: string; input: any }> = [];
  const sdk = { plugins: { async list() { if (failed) throw new Error('sentinel-private token /private/path'); return { plugins }; }, async callRpc(request: any) { calls.push({ method: request.method, input: request.input }); if (request.method === rpcFailure) throw new Error('sentinel-private-content /private/root token'); const value = request.method === 'status' ? state : { ok: false, category: 'busy', nextAction: 'Check the note status.' }; return request.outputSchema.parse(value); } } } as unknown as BbPluginApi['sdk'];
  return { adapter: new ICloud(sdk, (stage, category) => logs.push(`Obsidian ${stage} ${category}`)), state, logs, calls, setPlugins(value: any[]) { plugins = value; }, fail() { failed = true; }, failRpc(method: string) { rpcFailure = method; } };
}
test('v2 catalog has no filesystem roots or inventory dependency', async () => { const f = fixture(); const result = await f.adapter.snapshot(); assert.equal(result.sources[0].id, 'one'); assert.equal(result.sources[0].local.available, true); assert.doesNotMatch(JSON.stringify(result), /private|sentinel|localFolder/); assert.deepEqual(f.calls.map(c => c.method), ['status']); });
for (const [setup, mutate] of [
  ['missing', (f: ReturnType<typeof fixture>) => f.setPlugins([])], ['disabled', (f: ReturnType<typeof fixture>) => f.setPlugins([{ id: 'icloud', enabled: false }])], ['starting', (f: ReturnType<typeof fixture>) => f.setPlugins([{ id: 'icloud', enabled: true, status: 'starting' }])],
  ['incompatible', (f: ReturnType<typeof fixture>) => { f.state.noteAccessVersion = 1; delete f.state.mirrors[0].local; }], ['host_prerequisite', (f: ReturnType<typeof fixture>) => { f.state.available = false; }], ['apple_verification', (f: ReturnType<typeof fixture>) => { f.state.challenge = 'verification_code'; }], ['apple_disconnected', (f: ReturnType<typeof fixture>) => { f.state.connected = false; }],
  ['no_folder', (f: ReturnType<typeof fixture>) => { f.state.mirrors = []; }], ['sync_disabled', (f: ReturnType<typeof fixture>) => Object.assign(f.state.mirrors[0], { initialized: false, enabled: false, lastSuccess: null, phase: 'paused', local: { ...local, available: false, reason: 'source_changed' } })], ['initial_sync_running', (f: ReturnType<typeof fixture>) => Object.assign(f.state.mirrors[0], { initialized: false, lastSuccess: null, phase: 'running', local: { ...local, available: false, reason: 'source_changed' } })], ['initial_sync_failed', (f: ReturnType<typeof fixture>) => Object.assign(f.state.mirrors[0], { initialized: false, lastSuccess: null, phase: 'failed', local: { ...local, available: false, reason: 'source_changed' } })],
] as const) test(`source setup distinguishes ${setup}`, async () => { const f = fixture(); mutate(f); const result = await f.adapter.snapshot(); assert.equal(result.setup, setup); assert.ok(result.nextAction); });
test('missing or incompatible search capability never disables the v2 read/write boundary',async()=>{
 for(const capability of [undefined,{version:2,available:true,reason:null},{version:1,available:true,reason:'sentinel-private'}]){const f=fixture();f.state.search=capability;const catalog=await f.adapter.snapshot();assert.equal(catalog.compatible,true);assert.equal(catalog.setup,'ready');assert.equal(catalog.search?.available,false);assert.equal(catalog.sources[0].local.available,true);await assert.rejects(f.adapter.read('one',1,'Launch.md'),(e:any)=>e.category==='busy');assert.ok(f.calls.some(c=>c.method==='noteRead'));assert.doesNotMatch(JSON.stringify([catalog,f.logs]),/sentinel|private/);}
});
test('mismatch blocks every note admission even with apparently usable source', async () => { const f = fixture(); f.state.noteAccessVersion = 1; for (const run of [() => f.adapter.configure({ revision: 1, vaultIds: ['one'] }), () => f.adapter.list('one', 1), () => f.adapter.read('one', 1, 'Launch.md'), () => f.adapter.commit({ mirrorId: 'one', revision: 1, operationId: crypto.randomUUID(), path: 'Launch.md', kind: 'create', expectedHash: null, text: '' }), () => f.adapter.receipts({ mirrorId: 'one', revision: 1, limit: 1 }), () => f.adapter.inspect('one', 1, 'Launch.md'), () => f.adapter.readIncoming('one', 1, 'Launch.md', crypto.randomUUID()), () => f.adapter.resolve({ mirrorId: 'one', revision: 1, path: 'Launch.md', operationId: crypto.randomUUID(), token: crypto.randomUUID(), expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'accept_incoming' })]) await assert.rejects(run(), (e: any) => e.category === 'incompatible'); assert.equal(f.calls.filter(c => c.method !== 'status').length, 0); });
test('failed checks are not guessed missing/reset and errors never disclose raw provider data', async () => { const f = fixture(); f.fail(); const result = await f.adapter.snapshot(); assert.equal(result.setup, 'check_failed'); assert.deepEqual(f.logs, ['Obsidian catalog unavailable']); assert.doesNotMatch(JSON.stringify([result, f.logs]), /sentinel|private|token/); });
test('known RPC failure is handled once at its boundary and version included', async () => { const f = fixture(); await assert.rejects(f.adapter.configure({ revision: 1, vaultIds: ['one'] }), (e: any) => e.category === 'busy' && e.diagnosticReported === true); assert.deepEqual(f.logs, ['Obsidian rpc busy']); assert.equal(f.calls[1].input.version, 2); });
test('the independent boundary contract copy has no drift', async () => { assert.equal(await readFile(new URL('../adapters/icloud-note-contract.ts', import.meta.url), 'utf8'), await readFile(new URL('../../icloud/core/note-contract.ts', import.meta.url), 'utf8')); });
test('local safety blocks note RPCs despite ready cloud; historical receipt inspection remains scoped', async () => {
  const f = fixture(); f.state.mirrors[0].local = { ...local, available: false, reason: 'source_changed' };
  for (const run of [() => f.adapter.list('one', 1), () => f.adapter.read('one', 1, 'Note.md'), () => f.adapter.inspect('one', 1, 'Note.md'), () => f.adapter.readIncoming('one', 1, 'Note.md', crypto.randomUUID()), () => f.adapter.commit({ mirrorId: 'one', revision: 1, operationId: crypto.randomUUID(), path: 'Note.md', kind: 'create', expectedHash: null, text: 'x' }), () => f.adapter.resolve({ mirrorId: 'one', revision: 1, path: 'Note.md', operationId: crypto.randomUUID(), token: crypto.randomUUID(), expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'accept_incoming' })]) await assert.rejects(run(), (e: any) => e.category === 'source_unavailable');
  assert.equal(f.calls.filter(c => c.method !== 'status').length, 0);
  await assert.rejects(f.adapter.receipts({ mirrorId: 'one', revision: 1, limit: 1 }), (e: any) => e.category === 'busy');
  assert.equal(f.calls.at(-1)?.input.version, 2);
});
test('transport failures at receipt, guarded read, inspect and mutation boundaries never disclose synthetic sentinels', async () => {
  for (const [method, run, category] of [
    ['noteReceipts', (a: ICloud) => a.receipts({ mirrorId: 'one', revision: 1, limit: 1 }), 'unavailable'],
    ['noteRead', (a: ICloud) => a.readIncoming('one', 1, 'Note.md', crypto.randomUUID()), 'unavailable'],
    ['noteInspectConflict', (a: ICloud) => a.inspect('one', 1, 'Note.md'), 'unavailable'],
    ['noteCommit', (a: ICloud) => a.commit({ mirrorId: 'one', revision: 1, operationId: crypto.randomUUID(), path: 'Note.md', kind: 'create', expectedHash: null, text: 'x' }), 'uncertain'],
    ['noteResolveConflict', (a: ICloud) => a.resolve({ mirrorId: 'one', revision: 1, path: 'Note.md', operationId: crypto.randomUUID(), token: crypto.randomUUID(), expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'accept_incoming' }), 'uncertain'],
  ] as const) {
    const f = fixture(); f.failRpc(method);
    await assert.rejects(run(f.adapter), (error: any) => { assert.equal(error.category, category); assert.equal(error.diagnosticReported, true); assert.doesNotMatch(JSON.stringify([error.nextAction, f.logs]), /sentinel|private-content|private\/root|token/); return true; });
  }
});
