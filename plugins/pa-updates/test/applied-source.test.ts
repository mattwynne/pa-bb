import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppliedSources } from '../adapters/applied-source.ts';
import { ApplicationError } from '../core/application-model.ts';
const source = 'a'.repeat(64), path = '/synthetic/plugins/google-calendar';
test('checking never invents an applied record; explicit native-load confirmation persists by plugin and path', async () => {
  let value: unknown, writes = 0;
  const store = { load: async () => value, save: async (next: unknown) => { writes++; value = structuredClone(next); } };
  const records = new AppliedSources(store, new AbortController().signal);
  assert.equal(await records.get('google-calendar', path), null); assert.equal(writes, 0);
  await records.remember('google-calendar', path, source); assert.equal(writes, 1);
  assert.equal(await records.get('google-calendar', path), source);
  assert.equal(await records.get('google-calendar', '/different/path'), null);
  const reloaded = new AppliedSources(store, new AbortController().signal);
  assert.equal(await reloaded.get('google-calendar', path), source);
});
test('last-applied content alone is not current-load proof after a file generation changed', async () => {
  let value: unknown;
  const store = { load: async () => value, save: async (next: unknown) => { value = structuredClone(next); } };
  const first = new AppliedSources(store, new AbortController().signal);
  await first.remember('google-calendar', path, source, 'b'.repeat(64));
  const afterRestart = new AppliedSources(store, new AbortController().signal);
  assert.equal(await afterRestart.confirmed('google-calendar', path, 'b'.repeat(64)), true);
  assert.equal(await afterRestart.get('google-calendar', path), source);
  assert.equal(await afterRestart.confirmed('google-calendar', path, 'c'.repeat(64)), false, 'restored bytes with new metadata cannot get a green check');
});
test('failed storage cannot bless a source fingerprint or leak exception content', async () => {
  const records = new AppliedSources({ load: async () => null, save: async () => { throw new Error('PRIVATE_SENTINEL'); } }, new AbortController().signal);
  await assert.rejects(records.remember('google-calendar', path, source), error => error instanceof ApplicationError && error.category === 'storage' && !error.message.includes('PRIVATE_SENTINEL'));
  assert.equal(await records.get('google-calendar', path), null);
});
test('disposal drains an issued record write and prevents its old continuation from advancing memory', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), writing = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const records = new AppliedSources({ load: async () => null, save: async () => { entered(); await gate; } }, controller.signal);
  const remember = records.remember('google-calendar', path, source), rejected = assert.rejects(remember, error => error instanceof ApplicationError && error.category === 'interrupted');
  await writing; controller.abort(); let drained = false;
  const drain = records.drain().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false);
  release(); await drain; await rejected; assert.equal(drained, true);
});
