import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Obsidian, READ_LIMITS } from '../core/service.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { VaultError } from '../core/ports.ts';
import { CatalogFake, FilesFake, MemoryState, hash } from './fakes.ts';
const target = { vaultId: 'one', path: 'Long.md' };
const long = '\uFEFF# Checklist\r\n' + '- [ ] Preserve 😀 é and CRLF\r\n'.repeat(1700);
async function setup(text = long) {
  const catalog = new CatalogFake(), files = new FilesFake(), repository = new MemoryState(); let now = 0;
  const service = new Obsidian(catalog, files, new MarkdownNotes(), repository, randomUUID, () => now, () => {});
  await service.start(); await service.connect('one'); files.notes.set('one/Long.md', text);
  return { service, catalog, files, repository, advance: (ms: number) => { now += ms; } };
}
const rejectedEdit = (service: Obsidian, expectedHash: string, reader = '') => assert.rejects(service.edit({ ...target, expectedHash, append: 'MUST NOT SAVE' }, undefined, reader), /complete_read_required/);
async function finish(service: Obsidian, first: Awaited<ReturnType<Obsidian['read']>>, reader = '', selector?: { version: 'incoming'; token: string }) {
  const pages = [first];
  while (pages.at(-1)!.nextCursor) pages.push(await service.read({ ...target, selector, cursor: pages.at(-1)!.nextCursor! }, undefined, reader));
  return pages;
}
test('sequential bounded pages preserve every original character; only final empty acknowledgement grants proof', async () => {
  // Below the independent semantic-parser bound, but above the read budget.
  const text = '\uFEFF# Checklist\r\n' + 'Keep 😀 é\r\n'.repeat(4600);
  assert.ok(Buffer.byteLength(text) < 65536); assert.ok(text.length > 48000);
  const { service, files } = await setup(text);
  let page = await service.read(target), delivered = '', offset = 0, count = 0;
  assert.ok(page.nextCursor); assert.equal(page.complete, false);
  while (page.nextCursor) {
    assert.equal(page.offset, offset); assert.equal(page.hash, hash(text)); assert.equal(page.complete, false); assert.equal(page.editReady, false);
    assert.ok(JSON.stringify(page).length <= READ_LIMITS.serialized);
    assert.equal(page.totalChars, text.length); assert.equal(page.totalBytes, Buffer.byteLength(text));
    delivered += page.text; offset = page.nextOffset; count++;
    await rejectedEdit(service, page.hash!);
    page = await service.read({ ...target, cursor: page.nextCursor });
  }
  assert.ok(count >= 2); assert.equal(page.text, ''); assert.equal(page.offset, text.length);
  assert.equal(page.complete, true); assert.equal(page.editReady, true); assert.equal(delivered, text);
  assert.equal(hash(delivered), page.hash);
  await service.edit({ ...target, expectedHash: page.hash!, replacements: [{ oldText: '# Checklist', newText: '# Reviewed' }] });
  assert.equal(files.notes.get('one/Long.md'), text.replace('# Checklist', '# Reviewed'));
});
test('missing, forged, cross-target, cross-reader, replayed and overlapping continuations cannot skip content', async () => {
  const { service } = await setup('x'.repeat(50000));
  const first = await service.read(target, undefined, 'reader-a');
  await rejectedEdit(service, first.hash!, 'reader-a');
  for (const request of [{ ...target, cursor: randomUUID() }, { ...target, path: 'Other.md', cursor: first.nextCursor! }]) await assert.rejects(service.read(request, undefined, 'reader-a'), /cursor_expired/);
  await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }, undefined, 'reader-b'), /cursor_expired/);
  const outcomes = await Promise.allSettled([service.read({ ...target, cursor: first.nextCursor! }, undefined, 'reader-a'), service.read({ ...target, cursor: first.nextCursor! }, undefined, 'reader-a')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const second = (outcomes.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<Obsidian['read']>>>).value;
  assert.ok('offset' in second && 'nextOffset' in first);
  assert.equal(second.offset, first.nextOffset); assert.equal(second.complete, false);
  await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }, undefined, 'reader-a'), /cursor_expired/);
  await rejectedEdit(service, first.hash!, 'reader-a');
  const final = await service.read({ ...target, cursor: second.nextCursor! }, undefined, 'reader-a');
  assert.equal(final.editReady, true); await rejectedEdit(service, final.hash!, 'reader-b');
});
test('a changed note, hash/content mismatch or incomplete producer response fails closed', async () => {
  for (const change of ['note', 'hash', 'incomplete'] as const) {
    const { service, files } = await setup('x'.repeat(50000)); const first = await service.read(target);
    const read = files.read.bind(files);
    if (change === 'note') files.notes.set('one/Long.md', 'y'.repeat(50000));
    else files.read = async (...args) => ({ ...await read(...args), ...(change === 'hash' ? { hash: 'a'.repeat(64) } : { complete: false as true }) });
    await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }), /conflict|unsupported/);
    await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }), /cursor_expired/);
    await rejectedEdit(service, first.hash!); assert.equal(files.saved.length, 0);
  }
});
test('configuration, local safety, expiration, restart and cancellation revoke incomplete reads; cloud progress does not', async () => {
  for (const change of ['configuration', 'safety', 'idle', 'lifetime', 'stop', 'cancel'] as const) {
    const { service, catalog, advance } = await setup('x'.repeat(50000)); const first = await service.read(target);
    if (change === 'configuration') { await service.remove('one'); await service.connect('one'); }
    if (change === 'safety') catalog.value.sources[0].local.reason = 'source_changed';
    if (change === 'idle') advance(READ_LIMITS.idleMs + 1);
    if (change === 'lifetime') advance(READ_LIMITS.lifetimeMs + 1);
    if (change === 'stop') service.stop();
    const controller = new AbortController(); if (change === 'cancel') controller.abort();
    await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }, controller.signal), /cursor_expired|conflict|cancelled/);
  }
  const { service, catalog } = await setup('x'.repeat(50000)); const first = await service.read(target);
  catalog.value.connected = false; catalog.value.sources[0].phase = 'running'; catalog.value.sources[0].lastSuccess = null;
  const pages = await finish(service, first); assert.equal(pages.at(-1)!.editReady, true);
});
test('all incoming pages remain token-guarded and never grant ordinary proof, including identical logical bytes and absence', async () => {
  const text = 'x'.repeat(50000); const { service, files } = await setup(text); const token = randomUUID();
  files.conflicts.set('one/Long.md', { incoming: text, inspection: { token, logicalHash: hash(text), incomingHash: hash(text), incomingAbsent: false } });
  const selector = { version: 'incoming' as const, token };
  const first = await service.read({ ...target, selector });
  await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }), /cursor_expired/);
  const pages = await finish(service, first, '', selector); assert.equal(pages.map(p => p.text).join(''), text);
  assert.equal(pages.at(-1)!.complete, true); assert.equal(pages.at(-1)!.editReady, false); await rejectedEdit(service, hash(text));
  const stale = await service.read({ ...target, selector }); files.conflicts.delete('one/Long.md');
  await assert.rejects(service.read({ ...target, selector, cursor: stale.nextCursor! }), /conflict/);
  files.conflicts.set('one/Long.md', { incoming: null, inspection: { token, logicalHash: hash(text), incomingHash: null, incomingAbsent: true } });
  const absent = await service.read({ ...target, selector }); assert.equal(absent.absent, true); assert.equal(absent.editReady, false); assert.equal(absent.nextCursor, null);
});
test('sections never paginate or grant proof; semantic parser bounds remain independent of textual completeness', async () => {
  const { service } = await setup('# Heading\n' + 'x'.repeat(50000));
  const section = await service.read({ ...target, heading: 'Heading' }); assert.equal(section.nextCursor, null); assert.equal(section.complete, false); await rejectedEdit(service, section.hash!);
  await assert.rejects(service.read({ ...target, heading: 'Heading', cursor: randomUUID() }), /invalid_query/);
  const large = await setup('x'.repeat(70000)); const pages = await finish(large.service, await large.service.read(target));
  assert.equal(pages.at(-1)!.complete, true); assert.equal(pages.at(-1)!.editReady, false); assert.ok(pages.at(-1)!.warnings.includes('parser_limit'));
  await rejectedEdit(large.service, pages[0].hash!);
});
test('escaped JSON, surrogate page boundaries, empty notes, exact final pages and session capacity are bounded', async () => {
  for (const text of ['', 'x'.repeat(48000), 'x'.repeat(48001), 'x'.repeat(47999) + '😀end', '\\'.repeat(40000), '\u0000'.repeat(30000)]) {
    const { service } = await setup(text); const pages = await finish(service, await service.read(target));
    assert.equal(pages.map(p => p.text).join(''), text); assert.equal(pages.at(-1)!.complete, true);
    for (const page of pages) { assert.ok(JSON.stringify(page).length <= READ_LIMITS.serialized); assert.equal(Buffer.from(page.text ?? '').toString('utf8'), page.text ?? ''); }
  }
  const { service } = await setup('x'.repeat(50000)); const first = await service.read(target);
  for (let i = 0; i < READ_LIMITS.sessions; i++) await service.read(target);
  await assert.rejects(service.read({ ...target, cursor: first.nextCursor! }), /cursor_expired/);
});
test('in-flight continuations retain capacity reservations and release them on success and every failure', async () => {
  for (const failure of [false, true]) {
    const { service, files } = await setup('x'.repeat(50000));
    const starts = await Promise.all(Array.from({ length: READ_LIMITS.sessions }, () => service.read(target)));
    const read = files.read.bind(files); let entered = 0, allEntered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { allEntered = r; }), gate = new Promise<void>(r => { release = r; });
    files.read = async (...args) => {
      const note = await read(...args);
      if (entered < READ_LIMITS.sessions) {
        entered++; if (entered === READ_LIMITS.sessions) allEntered(); await gate;
        if (failure) throw new VaultError('unavailable');
      }
      return note;
    };
    const pending = starts.map(page => service.read({ ...target, cursor: page.nextCursor! }));
    // Observe rejections before releasing the gate to avoid unhandled promises.
    const settled = Promise.allSettled(pending); await ready;
    for (let i = 0; i < READ_LIMITS.sessions; i++) await assert.rejects(service.read(target), /capacity/);
    release(); const results = await settled;
    assert.equal(results.filter(r => r.status === 'fulfilled').length, failure ? 0 : READ_LIMITS.sessions);
    if (!failure) for (const result of results) {
      assert.equal(result.status, 'fulfilled'); const page = (result as PromiseFulfilledResult<Awaited<ReturnType<Obsidian['read']>>>).value;
      assert.equal((await service.read({ ...target, cursor: page.nextCursor! })).editReady, true);
    }
    // Failed and successful reservations must both be gone. All four slots are reusable.
    const fresh = await Promise.all(Array.from({ length: READ_LIMITS.sessions }, () => service.read(target)));
    for (const page of fresh) assert.ok((await service.read({ ...target, cursor: page.nextCursor! })).nextCursor);
  }
});
test('removal or source safety changes during a late page read cannot publish bytes or proof', async () => {
  for (const change of ['remove', 'safety', 'cancel'] as const) {
    const { service, files, catalog } = await setup('x'.repeat(50000)); const first = await service.read(target);
    let release!: () => void, entered!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
    const read = files.read.bind(files); files.read = async (...args) => { const result = await read(...args); entered(); await gate; return result; };
    const controller = new AbortController(); const pending = service.read({ ...target, cursor: first.nextCursor! }, controller.signal);
    await ready;
    if (change === 'remove') await service.remove('one');
    if (change === 'safety') catalog.value.sources[0].local.reason = 'source_changed';
    if (change === 'cancel') controller.abort();
    release(); await assert.rejects(pending, /not_connected|conflict|cancelled/);
    assert.equal(files.saved.length, 0);
  }
});
test('final acknowledgement rechecks note, expiration and CAS before any edit', async () => {
  for (const change of ['note', 'expired-in-flight', 'cas'] as const) {
    const { service, files, advance } = await setup('x'.repeat(50000));
    const first = await service.read(target); const lastContent = await service.read({ ...target, cursor: first.nextCursor! });
    assert.equal(lastContent.complete, false); assert.ok(lastContent.nextCursor);
    if (change === 'note') files.notes.set('one/Long.md', 'y'.repeat(50000));
    if (change === 'expired-in-flight') { const read = files.read.bind(files); files.read = async (...args) => { const note = await read(...args); advance(READ_LIMITS.idleMs + 1); return note; }; }
    const finishing = service.read({ ...target, cursor: lastContent.nextCursor! });
    if (change !== 'cas') { await assert.rejects(finishing, /conflict|cursor_expired/); await rejectedEdit(service, first.hash!); }
    else {
      const complete = await finishing; assert.equal(complete.editReady, true); files.notes.set('one/Long.md', 'New external edit');
      await assert.rejects(service.edit({ ...target, expectedHash: complete.hash!, append: 'bad' }), /conflict/); assert.equal(files.notes.get('one/Long.md'), 'New external edit');
    }
    assert.equal(files.saved.length, 0);
  }
});
test('uncertain write after a paged proof still requires exact receipt inspection and never replays', async () => {
  const { service, files, repository } = await setup('x'.repeat(50000));
  const pages = await finish(service, await service.read(target)); const commit = files.commit.bind(files);
  files.commit = async input => { await commit(input); throw new VaultError('uncertain'); };
  await assert.rejects(service.edit({ ...target, expectedHash: pages.at(-1)!.hash!, append: 'Once' }), /uncertain/);
  const operationId = repository.value.pending![0].operationId;
  assert.equal(files.saved.length, 1); assert.equal(files.notes.get('one/Long.md'), 'x'.repeat(50000) + 'Once');
  const status = await service.status({ ...target, operationId }); assert.equal(status.receipts[0].operationId, operationId); assert.equal(status.uncertainOperations.length, 0);
  assert.equal(files.saved.length, 1);
});
