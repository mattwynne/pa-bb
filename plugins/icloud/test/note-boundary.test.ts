import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { createHash, randomUUID as random } from 'node:crypto';
const randomUUID = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${random().slice(15)}`; };
import { spawn } from 'node:child_process';
import { NoteStore, NoteError, validateNotePath } from '../adapters/note-store.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const native = process.platform === 'linux';
async function fixture(options = {}) {
  const root = await mkdtemp('/tmp/icloud-note-boundary-'); const vault = root + '/mirrors/synthetic';
  await mkdir(vault, { recursive: true }); await mkdir(vault + '/nested');
  await writeFile(vault + '/nested/Note.md', '---\r\naliases: [Launch]\r\n---\r\nOriginal\r\n');
  const store = new NoteStore(root + '/note-operations', options);
  return { root, vault, store, async close() { await rm(root, { recursive: true, force: true }); } };
}
test('only bounded relative Markdown paths are eligible', () => {
  for (const path of ['/absolute.md', '../escape.md', 'nested/../escape.md', 'nested//Note.md', 'C:\\escape.md', 'file.txt', 'nul\0.md', './Note.md', 'nested/./Note.md']) assert.throws(() => validateNotePath(path), NoteError);
  for (const path of ['Note.md', '.hidden/nested/Note.md', 'Unicode 空白.md']) assert.equal(validateNotePath(path), path);
});
test('conditional replace retains only the affected previous note and deduplicates transport retries', { skip: !native }, async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const input = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: before.text + 'Decision\r\n', kind: 'replace' as const };
    const receipt = await f.store.commit(f.vault, input, new AbortController().signal);
    assert.equal(receipt.outcome, 'saved_locally_pending_sync'); assert.equal(receipt.hash, hash(input.text));
    assert.deepEqual(await f.store.commit(f.vault, input, new AbortController().signal), receipt);
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), input.text);
    assert.equal(await readFile(f.root + '/note-operations/' + input.operationId + '/previous', 'utf8'), before.text);
    assert.equal((await readdir(f.root + '/note-operations')).length, 1);
    await assert.rejects(f.store.commit(f.vault, { ...input, text: 'different' }, new AbortController().signal), (e: any) => e.category === 'operation_reused');
    await assert.rejects(f.store.commit(f.vault, { ...input, operationId: randomUUID() }, new AbortController().signal), (e: any) => e.category === 'conflict');
  } finally { await f.close(); }
});
test('exclusive creation and existing-folder requirement never overwrite', { skip: !native }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'Created.md', expectedHash: null, text: 'Created\n', kind: 'create' as const };
    await f.store.commit(f.vault, input, new AbortController().signal);
    await assert.rejects(f.store.commit(f.vault, { ...input, operationId: randomUUID() }, new AbortController().signal), (e: any) => e.category === 'conflict');
    await assert.rejects(f.store.commit(f.vault, { ...input, operationId: randomUUID(), path: 'missing/Note.md' }, new AbortController().signal));
    assert.equal(await readFile(f.vault + '/Created.md', 'utf8'), input.text);
  } finally { await f.close(); }
});
test('symlink notes and parent directories cannot expose or replace outside bytes', { skip: !native }, async () => {
  const f = await fixture();
  try {
    await mkdir(f.root + '/outside'); await writeFile(f.root + '/outside/Secret.md', 'sentinel-private');
    await symlink(f.root + '/outside', f.vault + '/escape'); await symlink(f.root + '/outside/Secret.md', f.vault + '/Secret.md');
    for (const path of ['escape/Secret.md', 'Secret.md']) {
      await assert.rejects(f.store.read(f.vault, path));
      await assert.rejects(f.store.commit(f.vault, { operationId: randomUUID(), mirrorId: 'synthetic', path, expectedHash: hash('sentinel-private'), text: 'replacement', kind: 'replace' }, new AbortController().signal));
    }
    assert.equal(await readFile(f.root + '/outside/Secret.md', 'utf8'), 'sentinel-private');
  } finally { await f.close(); }
});
for (const stage of ['previous', 'stage', 'journal', 'before_commit'] as const) test(`failure at ${stage} leaves the original intact with bounded errors`, { skip: !native }, async () => {
  const f = await fixture({ fault: (at: string) => { if (at === stage) throw Object.assign(new Error('sentinel-private-error'), { code: 'ENOSPC' }); } });
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md');
    await assert.rejects(f.store.commit(f.vault, { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'changed', kind: 'replace' }, new AbortController().signal), (e: any) => { assert.doesNotMatch(JSON.stringify(e) + e.message, /sentinel|\/tmp\//); return true; });
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), before.text);
  } finally { await f.close(); }
});
test('capacity refusal and cancellation do not change a note', { skip: !native }, async () => {
  const f = await fixture({ maxRecoveryBytes: 1 });
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const input = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'changed', kind: 'replace' as const };
    await assert.rejects(f.store.commit(f.vault, input, new AbortController().signal), (e: any) => e.category === 'capacity');
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(new NoteStore(f.root + '/cancelled').commit(f.vault, input, cancelled.signal), (e: any) => e.category === 'cancelled');
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), before.text);
  } finally { await f.close(); }
});
test('restart reconciles a lost receipt from staged inode identity, never reappending', { skip: !native }, async () => {
  const f = await fixture({ fault: (at: string) => { if (at === 'after_commit') throw new Error('lost reply'); } });
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const input = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: before.text + 'Append once\r\n', kind: 'replace' as const };
    await assert.rejects(f.store.commit(f.vault, input, new AbortController().signal), (e: any) => e.category === 'uncertain');
    const restarted = new NoteStore(f.root + '/note-operations');
    await restarted.reconcile('synthetic', f.vault);
    const receipt = await restarted.commit(f.vault, input, new AbortController().signal);
    assert.equal(receipt.outcome, 'saved_locally_pending_sync');
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), input.text);
    assert.equal((await restarted.receipts({ mirrorId: 'synthetic', limit: 20 })).length, 1);
  } finally { await f.close(); }
});
test('a crash before the first receipt leaves only safe orphan staging, not a permanently blocked sync', { skip: !native }, async () => {
  const f = await fixture();
  try {
    const id = randomUUID(); await mkdir(f.root + '/note-operations', { mode: 0o700 }); await mkdir(f.root + '/note-operations/' + id, { mode: 0o700 });
    await writeFile(f.root + '/note-operations/' + id + '/receipt-next', '{partial');
    await f.store.reconcile('synthetic', f.vault);
    assert.deepEqual(await f.store.receipts({ mirrorId: 'synthetic', limit: 20 }), []);
    assert.equal((await readdir(f.root + '/note-operations')).length, 0);
  } finally { await f.close(); }
});
test('settled failures release staging bytes and recovery accounts for retained stages', { skip: !native }, async () => {
  const f = await fixture({ fault: (at: string) => { if (at === 'before_commit') throw new Error('stop'); } });
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const id = randomUUID();
    await assert.rejects(f.store.commit(f.vault, { operationId: id, mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'stage', kind: 'replace' }, new AbortController().signal));
    assert.equal((await readdir(f.root + '/note-operations/' + id)).includes('stage'), false);
    assert.equal((await f.store.receipts({ mirrorId: 'synthetic', limit: 20 }))[0].outcome, 'not_saved');
  } finally { await f.close(); }
});
test('BOM and CRLF bytes survive conditional replacement', { skip: !native }, async () => {
  const f = await fixture();
  try {
    const text = '\uFEFF---\r\naliases: [Original]\r\n---\r\nText\r\n'; await writeFile(f.vault + '/BOM.md', text);
    const before = await f.store.read(f.vault, 'BOM.md'); assert.equal(before.text, text); assert.equal(before.hash, hash(text));
    await f.store.commit(f.vault, { operationId: randomUUID(), mirrorId: 'synthetic', path: 'BOM.md', expectedHash: before.hash, text: text + 'Append\r\n', kind: 'replace' }, new AbortController().signal);
    assert.equal(await readFile(f.vault + '/BOM.md', 'utf8'), text + 'Append\r\n');
  } finally { await f.close(); }
});
for (const stage of ['previous', 'stage', 'journal', 'before_commit', 'after_commit']) test(`SIGKILL at ${stage} reconciles without replay or partial bytes`, { skip: !native }, async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const input = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: before.text + 'Once\\r\\n', kind: 'replace' as const };
    const code = `import { NoteStore } from ${JSON.stringify(new URL('../adapters/note-store.ts', import.meta.url).href)}; const store = new NoteStore(${JSON.stringify(f.root + '/note-operations')}, { fault: at => { if (at === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL'); } }); await store.commit(${JSON.stringify(f.vault)}, ${JSON.stringify(input)}, new AbortController().signal);`;
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], { stdio: 'ignore' });
    const signal = await new Promise<string | null>((resolve, reject) => { child.on('error', reject); child.on('exit', (_code, signal) => resolve(signal)); }); assert.equal(signal, 'SIGKILL');
    const restarted = new NoteStore(f.root + '/note-operations'); await restarted.reconcile('synthetic', f.vault);
    const receipt = (await restarted.receipts({ mirrorId: 'synthetic', limit: 20 }))[0];
    assert.equal(receipt.outcome, stage === 'after_commit' ? 'saved_locally_pending_sync' : 'not_saved');
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), stage === 'after_commit' ? input.text : before.text);
    const replay = await restarted.commit(f.vault, input, new AbortController().signal); assert.deepEqual(replay, receipt);
  } finally { await f.close(); }
});
test('expired definite receipts can be pruned without ever allowing an old transport retry to commit again', { skip: !native }, async () => {
  let now = Date.now(); const f = await fixture({ maxOperations: 1, clock: () => now });
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); const first = { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'First', kind: 'replace' as const };
    await f.store.commit(f.vault, first, new AbortController().signal); now += 31 * 86400000;
    const time = now.toString(16).padStart(12, '0'); const nextId = `${time.slice(0, 8)}-${time.slice(8)}-7${random().slice(15)}`;
    await f.store.commit(f.vault, { ...first, operationId: nextId, expectedHash: hash('First'), text: 'Second' }, new AbortController().signal);
    await assert.rejects(f.store.commit(f.vault, first, new AbortController().signal), (e: any) => e.category === 'operation_expired');
    assert.equal(await readFile(f.vault + '/nested/Note.md', 'utf8'), 'Second'); assert.equal((await f.store.receipts({ mirrorId: 'synthetic', limit: 20 })).length, 1);
  } finally { await f.close(); }
});
test('settled journals are reconciled once per native generation, not reread on every note access', { skip: !native }, async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.vault, 'nested/Note.md'); await f.store.commit(f.vault, { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'First', kind: 'replace' }, new AbortController().signal);
    await f.store.reconcile('synthetic', f.vault); let loads = 0; const original = (f.store as any).load.bind(f.store); (f.store as any).load = async (...args: any[]) => { loads++; return original(...args); };
    await f.store.reconcile('synthetic', f.vault); await f.store.reconcile('synthetic', f.vault); assert.equal(loads, 0);
    const restarted = new NoteStore(f.root + '/note-operations'); await restarted.reconcile('synthetic', f.vault); assert.equal((await restarted.receipts({ mirrorId: 'synthetic', limit: 20 }))[0].outcome, 'saved_locally_pending_sync');
  } finally { await f.close(); }
});
test('a parent symlink swap before commit cannot redirect the destination', { skip: !native }, async () => {
  let swapped = false; const f = await fixture({ fault: async (at: string) => {
    if (at === 'before_commit' && !swapped) { swapped = true; await rename(f.vault + '/nested', f.vault + '/moved'); await symlink(f.root + '/outside', f.vault + '/nested'); }
  } });
  try {
    await mkdir(f.root + '/outside'); await writeFile(f.root + '/outside/Note.md', 'outside untouched');
    const before = await f.store.read(f.vault, 'nested/Note.md');
    await assert.rejects(f.store.commit(f.vault, { operationId: randomUUID(), mirrorId: 'synthetic', path: 'nested/Note.md', expectedHash: before.hash, text: 'changed', kind: 'replace' }, new AbortController().signal));
    assert.equal(await readFile(f.root + '/outside/Note.md', 'utf8'), 'outside untouched');
    assert.equal(await readFile(f.vault + '/moved/Note.md', 'utf8'), before.text);
  } finally { await f.close(); }
});
