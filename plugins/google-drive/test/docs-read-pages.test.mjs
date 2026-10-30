import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveService } from '../core/service.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';
import { failureCategory } from '../diagnostic.mjs';

const paragraph = text => ({ paragraph: { elements: [{ textRun: { content: text } }] } });
async function fixture(text) {
  let now = 1, reads = 0;
  const store = createMemoryStore();
  await store.addAccount({ subject: 'subject-a', email: 'a@example.test', refreshToken: 'secret' });
  await store.addAccount({ subject: 'subject-b', email: 'b@example.test', refreshToken: 'secret' });
  const drive = { getFile: async () => ({ name: 'title', mimeType: 'application/vnd.google-apps.document' }),
    readDoc: async () => { reads++; return { tabs: [{ documentTab: { body: { content: [paragraph(text)] } }, childTabs: [{ documentTab: { body: { content: [paragraph('child')] } } }] }] }; } };
  const service = createDriveService({ store, drive, oauth: {}, clock: () => now });
  const args = { account: 'a@example.test', document: 'doc-a' };
  return { service, drive, store, args, advance: ms => { now += ms; }, reads: () => reads };
}

test('pages preserve ordered snapshot and surrogate boundaries, independent of provider changes', async () => {
  const text = 'x'.repeat(99999) + '😀' + '\n'.repeat(110000);
  const h = await fixture(text);
  let page = await h.service.execute('gdocs_read', h.args, 'thread-a');
  assert.equal(page.text.length, 99999); assert.equal(page.truncated, true); assert.equal(page.complete, false);
  h.drive.readDoc = async () => { throw Error('must not refetch'); };
  let combined = page.text;
  while (page.nextCursor) {
    const previous = page;
    page = await h.service.execute('gdocs_read', { ...h.args, cursor: page.nextCursor }, 'thread-a');
    assert.equal(page.offset, previous.nextOffset); assert.ok(JSON.stringify(page).length <= 200000);
    combined += page.text;
  }
  assert.equal(combined, text + 'child'); assert.equal(page.complete, true); assert.equal(page.truncated, false);
  assert.equal(page.totalChars, combined.length); assert.equal(h.reads(), 1);
  assert.equal('editReady' in page, false); h.service.dispose();
});

test('continuations are single-use, scoped, expiring and invalidated on disposal', async () => {
  const h = await fixture('x'.repeat(100001));
  const start = () => h.service.execute('gdocs_read', h.args, 'thread-a');
  let page = await start();
  const calls = await Promise.allSettled([h.service.execute('gdocs_read', { ...h.args, cursor: page.nextCursor }, 'thread-a'), h.service.execute('gdocs_read', { ...h.args, cursor: page.nextCursor }, 'thread-a')]);
  assert.deepEqual(calls.map(x => x.status).sort(), ['fulfilled', 'rejected']);
  for (const [args, reader] of [[{ account: 'b@example.test', document: 'doc-a' }, 'thread-a'], [h.args, 'thread-b'], [{ ...h.args, document: 'other' }, 'thread-a']]) {
    page = await start(); await assert.rejects(() => h.service.execute('gdocs_read', { ...args, cursor: page.nextCursor }, reader), e => e.code === 'docs_cursor_expired');
  }
  page = await start(); h.advance(300000);
  await assert.rejects(() => h.service.execute('gdocs_read', { ...h.args, cursor: page.nextCursor }, 'thread-a'), e => e.code === 'docs_cursor_expired');
  page = await start(); h.service.dispose();
  await assert.rejects(() => h.service.execute('gdocs_read', { ...h.args, cursor: page.nextCursor }, 'thread-a'), e => e.code === 'docs_cursor_expired');
});

test('capacity, removal, malformed tabs and diagnostics fail closed', async () => {
  const h = await fixture('x'.repeat(100001));
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await h.service.execute('gdocs_read', h.args));
  await assert.rejects(() => h.service.execute('gdocs_read', h.args), e => e.code === 'docs_read_capacity');
  await h.service.removeAccount('subject-a');
  await assert.rejects(() => h.service.execute('gdocs_read', { ...h.args, cursor: pages[0].nextCursor }), e => e.code === 'docs_cursor_expired');
  await h.store.addAccount({ subject: 'subject-a', email: 'a@example.test', refreshToken: 'secret' });
  h.drive.readDoc = async () => ({ tabs: [{ childTabs: [] }] });
  await assert.rejects(() => h.service.execute('gdocs_read', h.args), e => e.code === 'docs_read_incomplete');
  assert.equal(failureCategory({ code: 'docs_read_incomplete', message: 'secret private content' }), 'docs_read_incomplete');
  assert.equal(failureCategory({ code: 'docs_cursor_expired', message: 'secret private content' }), 'docs_cursor_expired');
  h.service.dispose();
});

test('aggregate snapshot bytes limit applies before the four-session limit and releases on disposal', async () => {
  const h = await fixture('x'.repeat(3 * 1024 * 1024));
  const one = await h.service.execute('gdocs_read', h.args);
  const two = await h.service.execute('gdocs_read', h.args);
  assert.ok(one.nextCursor && two.nextCursor);
  await assert.rejects(() => h.service.execute('gdocs_read', h.args), e => e.code === 'docs_read_capacity');
  h.service.dispose();
});

test('disposal or account removal during initial provider read prevents a page and cursor', async () => {
  for (const action of ['dispose', 'remove']) {
    const h = await fixture('x'.repeat(100001));
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    h.drive.readDoc = async () => { started(); await pending; return { body: { content: [paragraph('x'.repeat(100001))] } }; };
    const read = h.service.execute('gdocs_read', h.args);
    await entered;
    if (action === 'dispose') h.service.dispose(); else await h.service.removeAccount('subject-a');
    release();
    await assert.rejects(read, e => e.code === 'docs_cursor_expired');
    h.service.dispose();
  }
});

test('failed or oversized provider reads return no page and reserve no snapshot capacity', async () => {
  const h = await fixture('x'.repeat(100001));
  for (const error of [Object.assign(new Error('private provider content'), { status: 503 }), Object.assign(new Error('private content'), { code: 'response_too_large' })]) {
    h.drive.readDoc = async () => { throw error; };
    await assert.rejects(() => h.service.execute('gdocs_read', h.args), e => e === error);
  }
  h.drive.readDoc = async () => ({ body: { content: [paragraph('x'.repeat(100001))] } });
  for (let i = 0; i < 4; i++) assert.ok((await h.service.execute('gdocs_read', h.args)).nextCursor);
  h.service.dispose();
});
