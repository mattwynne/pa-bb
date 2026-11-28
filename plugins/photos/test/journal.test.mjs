import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { registerPhotos } from '../dist/server.js';
import { fitJpeg, gridThumbnail, photoRendition, ThumbnailQueue, ticketBatches } from '../journal-images.ts';
import { gridGeometry, gridWindow, indexProgress, monthAt, monthJump, observeIndex, pageOffsets } from '../journal-model.ts';

const library = 'fixture-library';
const scope = { library, album: null, order: 'newest' };
const resource = (width, height) => ({ width, height, bytes: 10_000, type: 'image/jpeg' });
const asset = index => ({
  id: `test-photo-${index}`, created: '2026-06-02T12:00:00Z', added: null, width: 4000, height: 3000,
  kind: 'photo', favorite: false, filename: null, duration: null,
  versions: { thumb: resource(240, 180), medium: resource(800, 600), large: resource(4000, 3000) },
});
const readIndex = (indexed, total, state = 'indexing') => ({ state, indexed, total, updatedAt: null, error: null });
const caller = { experimental_caller: { kind: 'client' } };
const privateValue = 'SYNTHETIC_PRIVATE_VALUE';
const fixtureTicket = '123e4567-e89b-42d3-a456-426614174000';
const badResponse = { ok: false, error: privateValue };

test('Journal RPCs pass typed bounded reads to iCloud under a client-only gate and redact failures', async () => {
  let count = 10_000;
  let fault;
  const forwarded = [];
  const host = createFakePluginHost({ pluginId: 'photos', agentSkillIds: ['photos'], sdk: { plugins: {
    callRpc({ pluginId, method, input, signal }) {
      assert.equal(pluginId, 'icloud');
      assert.ok(signal instanceof AbortSignal);
      forwarded.push({ method, input });
      if (fault === 'throw') throw Object.assign(new Error(privateValue), { code: privateValue });
      if (fault === 'provider') return badResponse;
      if (fault === 'malformed') return { ok: true, assets: [privateValue] };
      if (fault === 'index') return { ok: true, ...readIndex(3200, count, 'error'), error: privateValue };
      if (fault === 'reconnect') return { ok: true, ...readIndex(3200, count, 'error'), error: 'Reconnect Apple in iCloud settings' };
      if (method === 'photoLibraries') return { ok: true, libraries: [{ id: library, name: 'Fixture', kind: 'personal' }] };
      if (method === 'photoIndexStatus') return { ok: true, ...readIndex(3200, count) };
      if (method === 'photoAssets') return { ok: true, total: count, assets: Array.from(
        { length: Math.min(input.limit, count - input.offset) }, (_, i) => asset(input.offset + i)),
      };
      if (method === 'photoMonths') return { ok: true, months: [{ month: '2026-06', offset: 0, count }] };
      if (method === 'photoAlbums') return { ok: true, albums: [{ id: 'a', name: 'Fixture', parent: null, kind: 'album', count }] };
      if (method === 'photoVersionTickets') return { ok: true, tickets: Object.fromEntries(input.ids.map(id => [id, fixtureTicket])) };
      assert.fail(method);
    },
  } } });
  const storage = { get: async () => null };
  await registerPhotos(host.bb, { grainStorage: storage, groupStorage: storage });
  try {
    const call = (name, input, context = caller) => host.harness.behavior.callRpc(name, input, context);
    assert.equal((await call('photoLibraries', null)).libraries[0].id, library);
    assert.equal((await call('photoIndexStatus', { library })).indexed, 3200);
    assert.equal((await call('photoAlbums', { library })).albums[0].id, 'a');
    assert.equal((await call('photoMonths', scope)).months[0].count, count);
    const id = asset(30).id;
    assert.deepEqual((await call('photoVersionTickets', { library, ids: [id], version: 'thumb' })).tickets, { [id]: fixtureTicket });
    for (const total of [10_000, 100_000]) {
      count = total;
      const offset = count - 47;
      const result = await call('photoAssets', { ...scope, offset, limit: 100 });
      assert.equal(result.total, count);
      assert.equal(result.assets.length, 47);
      assert.equal(result.assets[0].id, asset(offset).id);
      assert.deepEqual(forwarded.at(-1), { method: 'photoAssets', input: { ...scope, offset, limit: 100 } });
    }
    const deniedAt = forwarded.length;
    await assert.rejects(() => call('photoAssets', { ...scope, offset: 0, limit: 201 }));
    await assert.rejects(() => call('photoVersionTickets', { library, ids: Array(201).fill(id), version: 'thumb' }));
    await assert.rejects(() => call('photoMonths', scope, { experimental_caller: { kind: 'plugin', pluginId: 'fixture' } }), /Photos settings/);
    assert.equal(forwarded.length, deniedAt);
    for (fault of ['throw', 'provider', 'malformed', 'index', 'reconnect']) {
      const result = fault === 'index' || fault === 'reconnect'
        ? await call('photoIndexStatus', { library }) : await call('photoAssets', { ...scope, offset: 0, limit: 100 });
      assert.equal(result.ok, fault === 'index' || fault === 'reconnect');
      assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
      if (fault === 'reconnect') assert.equal(result.error, 'Reconnect Apple in iCloud settings.');
    }
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /Photos photoAssets unavailable/);
    assert.match(logs, /Photos photoAssets provider_failure/);
    assert.doesNotMatch(logs, new RegExp(privateValue));
  } finally { await host.harness.lifecycle.dispose(); }
});

test('Grid jumps to deep offsets and keeps a bounded window at desktop and narrow widths', () => {
  for (const total of [10_000, 100_000]) for (const width of [1280, 390]) {
    const { columns, stride } = gridGeometry(width);
    const target = total - 777;
    const months = [{ month: '2026-06', offset: 0, count: target }, { month: '2004-12', offset: target, count: 777 }];
    const top = monthJump(months[1], columns, stride);
    const visible = gridWindow(total, columns, stride, top, 803);
    assert.equal(visible.rows, Math.ceil(total / columns));
    assert.equal(visible.first, Math.floor(target / columns));
    assert.ok((visible.stop - visible.start) * columns < 100);
    assert.equal(monthAt(months, target - 1), 0);
    assert.equal(monthAt(months, target), 1);
    const pages = pageOffsets(visible.first * columns, visible.end * columns, total);
    assert.ok(pages.length <= 2);
    assert.deepEqual(pageOffsets(visible.first * columns, visible.end * columns, total, true), [...pages].reverse());
    assert.deepEqual(pageOffsets(visible.first * columns, visible.end * columns, target - 777), []);
  }
});

test('Index progress publishes partial data and stops polling when ready or on cancellation', async () => {
  const values = [readIndex(0, null, 'empty'), readIndex(3200, 9792), readIndex(9792, 9792, 'ready')];
  const seen = [];
  let pauses = 0;
  const controller = new AbortController();
  await observeIndex(async () => values.shift(), value => seen.push(value), controller.signal, async () => { pauses++; });
  assert.deepEqual(seen.map(value => value.state), ['empty', 'indexing', 'ready']);
  assert.equal(indexProgress(seen[1]), 'Gathering your library · 3,200 of 9,792');
  assert.equal(pauses, 2);
  await observeIndex(async () => seen[1], () => controller.abort(), controller.signal, async () => {});
  assert.equal(controller.signal.aborted, true);
});

const preview = index => gridThumbnail({ library, asset: asset(index) }, 170);
const nextRound = async () => { for (let i = 0; i < 5; i++) await setImmediate(); };

test('Thumbnails select a version by pixel size and batch by version with an upper bound of 200', () => {
  assert.equal(preview(1).version, 'thumb');
  assert.equal(gridThumbnail({ library, asset: asset(1) }, 300).version, 'medium');
  const photo = asset(2);
  delete photo.versions.medium;
  assert.equal(gridThumbnail({ library, asset: photo }, 300).version, 'large');
  assert.equal(gridThumbnail({ library, asset: { ...asset(3), kind: 'video' } }, 300).version, 'thumb');
  assert.notEqual(preview(1).key, gridThumbnail({ library, asset: asset(1) }, 300).key);
  const requests = Array.from({ length: 201 }, (_, i) => preview(i));
  requests.push(gridThumbnail({ library, asset: asset(1) }, 300));
  assert.deepEqual(ticketBatches(requests).map(batch => [batch[0].version, batch.length]), [
    ['thumb', 200], ['thumb', 1], ['medium', 1],
  ]);
});

test('Thumbnail pool serves cache hits first, prioritizes visible tiles, and aborts superseded prefetch', async () => {
  const jpg = new Blob(['picture'], { type: 'image/jpeg' });
  const ticketCalls = [];
  const downloads = [];
  const rejectAborted = [];
  let active = 0;
  let maxActive = 0;
  const queue = new ThumbnailQueue({
    read: async keys => keys.map(key => key === preview(0).key ? jpg : undefined),
    write: async () => {},
    tickets: async requests => {
      ticketCalls.push(requests.map(item => item.asset.id));
      return Object.fromEntries(requests.map(item => [item.asset.id, item.asset.id]));
    },
    download: async (ticket, signal, priority) => {
      maxActive = Math.max(++active, maxActive);
      downloads.push([ticket, priority]);
      try {
        if (priority === 'low') await new Promise((_, reject) => signal.addEventListener('abort', () => {
          rejectAborted.push(ticket); reject(signal.reason);
        }, { once: true }));
        return jpg;
      } finally { active--; }
    },
  }, () => {});
  try {
    queue.setTargets([preview(0), preview(1)], Array.from({ length: 20 }, (_, i) => preview(i + 10)));
    await nextRound();
    assert.deepEqual(ticketCalls[0], ['test-photo-1']);
    assert.deepEqual(downloads[0], ['test-photo-1', 'high']);
    assert.equal(downloads.length, 7);
    assert.equal(maxActive, 6);
    assert.equal(queue.get(preview(0).key).blob, jpg);
    queue.setTargets([preview(99)], []);
    await nextRound();
    assert.equal(rejectAborted.length, 6);
    assert.deepEqual(downloads.at(-1), ['test-photo-99', 'high']);
    assert.equal(queue.get(preview(10).key), undefined);
    assert.ok(queue.get(preview(99).key));
  } finally { queue.dispose(); }
});

test('Gallery rendition reads Apple JPEG tickets and lowers resolution when quality alone cannot fit', async t => {
  const calls = [];
  let closed = false;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push([url, opts.credentials]);
    return new Response(new Blob(['apple-jpeg'], { type: 'image/jpeg' }));
  });
  const replace = (name, value) => {
    const existing = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => existing ? Object.defineProperty(globalThis, name, existing) : delete globalThis[name]);
  };
  replace('createImageBitmap', async blob => {
    assert.equal(await blob.text(), 'apple-jpeg');
    return { width: 4000, height: 3000, close() { closed = true; } };
  });
  replace('OffscreenCanvas', class {
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) { return new Blob([new Uint8Array(this.width > 1500 ? 1_000_001 : 350_000)], { type }); }
  });
  const photo = { library, asset: asset(123) };
  const rpc = { async call(name, input) {
    calls.push([name, input]);
    return { ok: true, tickets: { [photo.asset.id]: input.version === 'large' ? null : 'fixture / ticket' } };
  } };
  const result = await photoRendition(rpc, photo);
  assert.deepEqual(calls.map(([name, input]) => [name, input.version ?? input]), [
    ['photoVersionTickets', 'large'], ['photoVersionTickets', 'medium'],
    ['/api/v1/plugins/icloud/http/photo-version?ticket=fixture%20%2F%20ticket', 'same-origin'],
  ]);
  assert.equal(result.blob.type, 'image/jpeg');
  assert.ok(result.blob.size <= 1_000_000);
  assert.deepEqual([result.width, result.height], [1500, 1125]);
  assert.equal(closed, true);
  const unchanged = await fitJpeg(101, 60, async () => result.blob);
  assert.deepEqual([unchanged.width, unchanged.height], [101, 60]);
});
