import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { CloudKitPhotos, isPhotoLibrary } from '../adapters/cloudkit-photos.ts';
import type { PhotoZone } from '../adapters/cloudkit-photos.ts';
import { PhotoIndex } from '../adapters/photo-index.ts';
import { PhotoPrimitives } from '../adapters/photo-primitives.ts';
import { PhotoVersions } from '../adapters/photo-versions.ts';
import { photoAsset, photosContract } from '../core/photos-contract.ts';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';

const library = 'PrimarySync';
const zone: PhotoZone = { area: 'private', zoneID: { zoneName: library } };
const session = {
  account: 'synthetic-account-binding', endpoint: new URL('https://ck.example.icloud.com'),
  cookies: 'X-APPLE-WEBAUTH-PCS-Photos=PRIVATE_COOKIE', pcsRequired: true,
};
const signal = () => new AbortController().signal;
const fields = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, value]) => [key, { value }]));
const asset = (n: number, overrides: Record<string, unknown> = {}) => ({
  recordName: `asset-${n}`, recordType: 'CPLAsset',
  fields: fields({ masterRef: { recordName: `master-${n}` }, assetDate: Date.UTC(2024, 0, 1 + n), addedDate: Date.UTC(2025, 0, 1),
    ...overrides }),
});
const master = (n: number, overrides: Record<string, unknown> = {}) => ({
  recordName: `master-${n}`, recordType: 'CPLMaster',
  fields: fields({ filenameEnc: Buffer.from('Generated.jpg').toString('base64'),
    resOriginalRes: { size: 64_000, downloadURL: 'https://photos.example.icloud.com/original?private=SIGNED' },
    resOriginalFileType: 'public.jpeg', resOriginalWidth: 1200, resOriginalHeight: 800, originalOrientation: 6,
    resJPEGThumbRes: { size: 256, downloadURL: 'https://photos.example.icloud.com/expired?private=SIGNED' },
    resJPEGThumbWidth: 300, resJPEGThumbHeight: 200, resJPEGThumbFileType: 'public.jpeg', ...overrides }),
});
const input = { library, album: null, order: 'newest' as const, offset: 0, limit: 12 };
const count = (total: number) => Response.json({ batch: [{ records: [{ fields: fields({ itemCount: total }) }] }] });
const zones = () => Response.json({ zones: [{ zoneID: zone.zoneID }] });
const emptyChanges = () => Response.json({ zones: [{ records: [], syncToken: 'ready', moreComing: false }] });
const handler = (run: (path: string, body: any, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('content-type'), 'text/plain');
    const { pathname, searchParams } = new URL(String(url));
    assert.equal(searchParams.get('getCurrentSyncToken'), 'true');
    return run(pathname.replace('/database/1/com.apple.photos.cloud/production/', ''), JSON.parse(String(init?.body)), init!);
  };
const fixture = (db: Database.Database, wire: typeof fetch, now: () => number = Date.now, media: typeof fetch = fetch) => {
  const logs: string[] = [];
  const diagnose = (stage: string, reason: string) => logs.push(`${stage} ${reason}`);
  const cloud = new CloudKitPhotos(async () => session, wire, 0);
  const versions = new PhotoVersions(cloud, diagnose, media, now);
  const primitives = new PhotoPrimitives(cloud, new PhotoIndex(db), versions, diagnose, () => true, now);
  return { primitives, logs, cloud, versions };
};
async function eventually<T>(check: () => Promise<T>, predicate: (result: T) => boolean) {
  for (let i = 0; i < 200; i++) {
    const result = await check();
    if (predicate(result)) return result;
    await delay(5);
  }
  assert.fail('Timed out waiting for generated index work');
}

test('CloudKit discovers and deduplicates library zones and issues count and rank requests in both directions', async () => {
  const api = new CloudKitPhotos(async () => session, handler((path, body) => {
    if (path === 'private/changes/database') return Response.json({ zones: [
      { zoneID: zone.zoneID }, { zoneID: { zoneName: 'SharedSync-A', ownerRecordName: 'owner-A' } },
      { zoneID: { zoneName: 'CMM-not-a-library' } }, { zoneID: { zoneName: 'SharedSync-old' }, deleted: true },
    ] });
    if (path === 'shared/changes/database') return Response.json({ zones: [
      { zoneID: { zoneName: 'SharedSync-A' } }, { zoneID: { zoneName: 'SharedSync-B' } },
    ] });
    assert.deepEqual(body.zoneID ?? body.batch[0].zoneID, zone.zoneID);
    if (path.endsWith('/batch')) {
      assert.deepEqual(body.batch[0].query.filterBy.fieldValue.value, ['CPLAssetByAssetDateWithoutHiddenOrDeleted']);
      return count(150);
    }
    assert.equal(body.resultsLimit, 6);
    assert.ok(body.desiredKeys.includes('resJPEGThumbRes'));
    assert.ok(!body.desiredKeys.includes('faces'));
    const [rank, direction] = body.query.filterBy.map((row: any) => row.fieldValue.value);
    assert.equal(rank, direction === 'ASCENDING' ? 0 : 149);
    return Response.json({ records: [master(rank), asset(rank)], syncToken: 'seed' });
  }), 0);
  const discovered = await api.libraries(signal());
  assert.deepEqual([...discovered.keys()], [library, 'SharedSync-A', 'SharedSync-B']);
  assert.equal(discovered.get('SharedSync-A')?.zoneID.ownerRecordName, 'owner-A');
  assert.equal(discovered.get('SharedSync-B')?.area, 'shared');
  assert.equal(isPhotoLibrary('CMM-not-a-library'), false);
  assert.equal(await api.count(zone, signal()), 150);
  assert.equal((await api.page(zone, 0, 'oldest', 3, signal())).records[1].recordName, 'asset-0');
  assert.equal((await api.page(zone, 149, 'newest', 3, signal())).token, 'seed');
});

test('newest pages survive a stopped indexer, then paged deltas update metadata and remove hidden and deleted assets', async () => {
  const db = new Database(':memory:');
  let now = Date.UTC(2026, 0, 1);
  let nextPage: 'interrupted' | 'resumed' = 'interrupted';
  let delta = false;
  const ranks: number[] = [];
  const wire = handler(async (path, body, init) => {
    if (path.endsWith('changes/database')) return zones();
    if (path.endsWith('/batch')) return count(120);
    if (path.endsWith('records/query')) {
      const rank: number = body.query.filterBy[0].fieldValue.value;
      ranks.push(rank);
      if (rank === 27 && nextPage === 'interrupted') {
        await delay(10_000, undefined, { signal: init.signal! });
        assert.fail('The resumed index fixture was not interrupted');
      }
      const size = body.resultsLimit / 2;
      // The API may interleave or reorder records within a rank page.
      const values = Array.from({ length: size }, (_, i) => rank - i).reverse();
      return Response.json({ records: [...values.map(masterRow), ...values.map(assetRow)], syncToken: rank === 119 ? 'seed' : 'later-query-token' });
    }
    if (path.endsWith('records/lookup')) {
      assert.deepEqual(body.records, [{ recordName: 'master-120' }]);
      return Response.json({ records: [master(120)] });
    }
    assert.ok(path.endsWith('changes/zone'));
    const since = body.zones[0].syncToken;
    if (!delta) {
      assert.equal(since, 'seed');
      return emptyChanges();
    }
    if (since === 'ready') return Response.json({ zones: [{
      records: [
        asset(3, { isFavorite: 1, assetDate: null }),
        { recordName: 'asset-4', deleted: true },
        asset(5, { isHidden: 1 }),
        { recordName: 'master-6', recordType: 'CPLMaster', deleted: true },
      ],
      syncToken: 'delta-1', moreComing: true,
    }] });
    assert.equal(since, 'delta-1');
    return Response.json({ zones: [{ records: [asset(120)], syncToken: 'delta-2', moreComing: false }] });
  });
  const assetRow = (n: number) => asset(n), masterRow = (n: number) => master(n);
  let f = fixture(db, wire, () => now);
  try {
    await eventually(() => f.primitives.status(library), value => value.indexed === 100 && ranks.length === 2);
    assert.deepEqual((await f.primitives.assets(input)).assets.map(row => row.id).slice(0, 3), ['asset-119', 'asset-118', 'asset-117']);
    assert.equal((await f.primitives.assets(input)).total, 120);
    await f.primitives.cancel();
    nextPage = 'resumed';
    f = fixture(db, wire, () => now);
    assert.equal((await eventually(() => f.primitives.status(library), value => value.state === 'ready')).indexed, 120);
    assert.deepEqual(ranks, [119, 27, 27]);
    const monthMarks = (await f.primitives.months(input)).months;
    assert.deepEqual(monthMarks.slice(0, 2), [{ month: '2024-04', offset: 0, count: 29 }, { month: '2024-03', offset: 29, count: 31 }]);
    const old = await f.primitives.assets({ ...input, order: 'oldest' });
    assert.deepEqual([old.assets[0].id, old.assets[0].width, old.assets[0].height], ['asset-0', 800, 1200]);
    assert.equal(old.assets[0].versions.thumb?.type, 'image/jpeg');
    assert.equal(JSON.stringify(db.prepare('SELECT payload FROM photo_library_masters').all()).includes('SIGNED'), false);
    delta = true;
    now += 61_000;
    assert.equal((await eventually(() => f.primitives.status(library), value => value.state === 'ready')).total, 118);
    const after = await f.primitives.assets({ ...input, order: 'oldest' });
    assert.ok(after.assets.find(row => row.id === 'asset-3')?.favorite);
    assert.equal((await f.primitives.months({ ...input, order: 'oldest' })).months[0].offset, 1);
    assert.ok(!after.assets.some(row => ['asset-4', 'asset-5', 'asset-6'].includes(row.id)));
    assert.equal((await f.primitives.assets(input)).assets[0].id, 'asset-120');
    assert.equal(db.prepare('SELECT token FROM photo_library_index').pluck().get(), 'delta-2');
    assert.deepEqual(f.logs, []);
  } finally { await f.primitives.cancel(); db.close(); }
});

test('an expired cursor rebuilds and removes rows absent from the replacement scan', async () => {
  let rebuilding = false;
  let now = Date.UTC(2026, 0, 1);
  const db = new Database(':memory:');
  const f = fixture(db, handler((path, body) => {
    if (path.endsWith('changes/database')) return zones();
    if (path.endsWith('/batch')) return count(rebuilding ? 1 : 2);
    if (path.endsWith('records/query')) return Response.json({
      records: rebuilding ? [asset(1), master(1)] : [asset(0), master(0), asset(1), master(1)], syncToken: rebuilding ? 'rebuilt' : 'seed',
    });
    if (body.zones[0].syncToken === 'ready') {
      assert.ok(rebuilding);
      return Response.json({ zones: [{ serverErrorCode: 'CHANGE_TOKEN_EXPIRED', reason: 'PRIVATE_PROVIDER_DETAIL' }] });
    }
    return emptyChanges();
  }), () => now);
  try {
    assert.equal((await eventually(() => f.primitives.status(library), value => value.state === 'ready')).indexed, 2);
    rebuilding = true;
    now += 61_000;
    assert.equal((await eventually(() => f.primitives.status(library), value => value.state === 'ready')).indexed, 1);
    assert.deepEqual((await f.primitives.assets(input)).assets.map(row => row.id), ['asset-1']);
    assert.deepEqual(f.logs, []);
  } finally { await f.primitives.cancel(); db.close(); }
});

test('CloudKit serializes requests and honors Retry-After for 429 and 503', async () => {
  let now = 100_000, active = 0;
  const attempts: number[] = [];
  const api = new CloudKitPhotos(async () => session, handler(async () => {
    active++;
    assert.equal(active, 1);
    attempts.push(now);
    await delay(1);
    active--;
    if (attempts.length === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
    if (attempts.length === 2) return new Response(null, { status: 503, headers: { 'Retry-After': new Date(105_000).toUTCString() } });
    return count(7);
  }), 150, () => now, async ms => { now += ms; });
  assert.deepEqual(await Promise.all([api.count(zone, signal()), api.count(zone, signal())]), [7, 7]);
  assert.deepEqual(attempts, [100_000, 102_000, 105_000, 105_150]);
});

test('401, 421 and 423 stop after one saved-session refresh, with no sign-in path', async () => {
  for (const status of [401, 421, 423]) {
    let reads = 0;
    const requests: string[] = [];
    const api = new CloudKitPhotos(async () => ({ ...session, cookies: session.cookies + ++reads }),
      handler((path, _body, init) => {
        requests.push(new Headers(init.headers).get('cookie')!);
        assert.equal(path, 'private/internal/records/query/batch');
        return new Response('PRIVATE_RESPONSE', { status });
      }), 0);
    await assert.rejects(api.count(zone, signal()), /^CloudError: authentication$/);
    await assert.rejects(api.count(zone, signal()), /^CloudError: authentication$/);
    assert.equal(api.authFailed, true);
    assert.equal(requests.length, 2);
    assert.equal(reads, 2);
  }
  let reads = 0;
  const missing = new CloudKitPhotos(async () => { reads++; return { ...session, cookies: 'OTHER=1' }; },
    async () => assert.fail('Missing PCS must prevent requests'), 0);
  await assert.rejects(missing.count(zone, signal()), /^CloudError: authentication$/);
  await assert.rejects(missing.count(zone, signal()), /^CloudError: authentication$/);
  assert.equal(reads, 2);
});

test('live album pages, folders and version metadata use the published contract', async () => {
  const db = new Database(':memory:');
  const f = fixture(db, handler((path, body) => {
    if (path.endsWith('changes/database')) return zones();
    if (path.endsWith('/batch')) return count(2);
    if (body.query.recordType === 'CPLAlbumByPositionLive') return Response.json({ records: [
      { recordName: 'folder-id', fields: fields({ albumNameEnc: 'Rm9sZGVy', albumType: 3 }) },
      { recordName: 'album-id', fields: fields({ albumNameEnc: 'QWxidW0=', parentId: 'folder-id' }) },
    ] });
    assert.equal(body.query.recordType, 'CPLContainerRelationLiveByAssetDate');
    const [rank, direction, album] = body.query.filterBy.map((row: any) => row.fieldValue.value);
    assert.equal(rank, direction === 'ASCENDING' ? 0 : 1);
    assert.equal(album, 'album-id');
    return Response.json({ records: [master(1, { resVidFullRes: { size: 200 }, resVidFullFileType: 'public.mpeg-4' }),
      asset(0, { assetSubtypeV2: 2 }), master(0), asset(1, { duration: 15.5 })] });
  }));
  try {
    const { albums } = await f.primitives.albums(library);
    assert.deepEqual(albums.filter(row => row.kind !== 'smart'), [
      { id: 'folder-id', name: 'Folder', kind: 'folder', parent: null, count: null },
      { id: 'album-id', name: 'Album', kind: 'album', parent: 'folder-id', count: null },
    ]);
    const result = await f.primitives.assets({ ...input, album: 'album-id' });
    assert.equal(result.total, 2);
    assert.deepEqual(result.assets.map(row => [row.id, row.kind, row.duration]), [['asset-1', 'video', 15.5], ['asset-0', 'live', null]]);
    for (const row of result.assets) photoAsset.parse(row);
    assert.deepEqual((await f.primitives.assets({ ...input, album: 'album-id', order: 'oldest' })).assets.map(row => row.id), ['asset-0', 'asset-1']);
    assert.deepEqual(await f.primitives.months({ ...input, album: 'album-id' }), { months: [] });
    assert.equal((await f.primitives.albums(library)).albums.find(row => row.id === 'album-id')?.count, 2);
  } finally { await f.primitives.cancel(); db.close(); }
});

test('version tickets are reusable, honor expiry, and refresh a rejected signed URL without cookies', async () => {
  const db = new Database(':memory:');
  let now = Date.UTC(2026, 0, 1), lookups = 0, requests = 0, closed = 0;
  const f = fixture(db, handler((path, body) => {
    if (path.endsWith('changes/database')) return zones();
    if (path.endsWith('/batch')) return count(1);
    if (path.endsWith('changes/zone')) return emptyChanges();
    if (path.endsWith('records/query')) return Response.json({ records: [asset(0), master(0)], syncToken: 'seed' });
    lookups++;
    assert.deepEqual(body.desiredKeys, ['resJPEGThumbRes']);
    return Response.json({ records: [master(0, { resJPEGThumbRes: { size: 3, downloadURL: 'https://photos.example.icloud.com/fresh?private=SIGNED' } })] });
  }), () => now, async (url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    if (new URL(String(url)).pathname === '/expired') return new Response(null, { status: 403 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream', 'content-length': '3' } });
  });
  try {
    await eventually(() => f.primitives.status(library), value => value.state === 'ready');
    const { tickets } = await f.primitives.tickets(library, ['asset-0'], 'thumb');
    const ticket = tickets['asset-0']!;
    for (const minute of [0, 10]) {
      if (minute) now += minute * 60_000;
      const response = await f.versions.download(ticket, signal(), () => { closed++; });
      assert.equal(response.headers.get('cache-control'), 'private, max-age=86400');
      assert.equal(response.headers.get('content-type'), 'image/jpeg');
      assert.equal(response.headers.get('content-length'), '3');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    }
    assert.deepEqual([lookups, requests, closed], [1, 3, 2]);
    now += 5 * 60_000;
    await assert.rejects(f.versions.download(ticket, signal(), () => {}), /^CloudError: invalid_selection$/);
    assert.equal((await f.primitives.tickets(library, ['asset-0'], 'medium')).tickets['asset-0'], null);
  } finally { await f.primitives.cancel(); db.close(); }
});

test('index auth errors are visible through the RPC and server logs exclude provider data', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState();
  repository.value.connected = true;
  let requests = 0;
  const api = new CloudKitPhotos(async () => session, handler(path => {
    if (path.endsWith('changes/database')) return zones();
    requests++;
    return new Response('https://example.icloud.com/PRIVATE_SIGNED_URL', { status: 421 });
  }), 0);
  await plugin(host.bb, { provider: new FakeCloudProvider(), repository, photoCloud: api });
  const { behavior } = host.harness;
  const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'photos' } };
  try {
    for (const method of ['photoLibraries', 'photoIndexStatus', 'photoAssets', 'photoMonths', 'photoAlbums', 'photoVersionTickets'] as const) {
      const data = method === 'photoLibraries' ? null
        : method === 'photoAssets' ? input : method === 'photoMonths' ? { library, album: null, order: 'newest' }
        : method === 'photoVersionTickets' ? { library, ids: ['asset-0'], version: 'thumb' } : { library };
      await assert.rejects(behavior.callRpc(method, data), /host-verified Photos/);
    }
    const value = await eventually(
      async () => photosContract.photoIndexStatus.output.parse(await behavior.callRpc('photoIndexStatus', { library }, caller)),
      value => value.ok && value.state === 'error',
    );
    assert.equal(value.ok && value.error, 'Reconnect Apple in iCloud settings');
    assert.equal(requests, 1);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /iCloud photo_index_refresh authentication/);
    assert.doesNotMatch(JSON.stringify([value, host.harness.inspection.logEntries]), /PRIVATE_COOKIE|PRIVATE_SIGNED_URL/);
    const route = await behavior.fetchHttp('GET', '/photo-version?ticket=invalid');
    assert.equal(route.status, 404);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('contract schemas bound the page and ticket batch and accept partial versions', () => {
  const { photoAssets, photoVersionTickets, photoMonths, photoLibraries, photoAlbums, photoIndexStatus } = photosContract;
  assert.ok(photoLibraries.input.safeParse(null).success);
  assert.ok(!photoLibraries.input.safeParse({}).success);
  assert.ok(photoAssets.input.safeParse({ ...input, limit: 200 }).success);
  assert.ok(!photoAssets.input.safeParse({ ...input, limit: 201 }).success);
  assert.ok(!photoAssets.input.safeParse({ ...input, offset: -1 }).success);
  assert.ok(!photoAssets.input.safeParse({ ...input, aspect: 'square' }).success);
  assert.ok(!photoVersionTickets.input.safeParse({ library, ids: [], version: 'thumb' }).success);
  assert.ok(!photoVersionTickets.input.safeParse({ library, ids: Array(201).fill('asset-0'), version: 'thumb' }).success);
  assert.ok(!photoVersionTickets.input.safeParse({ library, ids: ['asset-0'], version: 'preview' }).success);
  assert.ok(photoVersionTickets.output.safeParse({ ok: true, tickets: { missing: null } }).success);
  assert.ok(!photoMonths.output.safeParse({ ok: true, months: [{ month: '2026-13', offset: 0, count: 5 }] }).success);
  assert.ok(photoAlbums.output.safeParse({ ok: true, albums: [{ id: 'dir', name: 'Dir', kind: 'folder', parent: null, count: null }] }).success);
  assert.ok(photoIndexStatus.output.safeParse({ ok: true, state: 'empty', indexed: 0, total: null, updatedAt: null, error: null }).success);
  assert.ok(photoAsset.safeParse({ id: 'asset-0', created: null, added: null, width: null, height: null, kind: 'photo',
    favorite: false, filename: null, duration: null, versions: {} }).success);
});

test('the local version route batches cold link lookups and permits only six concurrent streams', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState();
  repository.value.connected = true;
  const lookupSizes: number[] = [];
  let requests = 0;
  const api = new CloudKitPhotos(async () => session, handler((path, body) => {
    if (path.endsWith('changes/database')) return zones();
    if (path.endsWith('/batch')) return count(8);
    if (path.endsWith('changes/zone')) return emptyChanges();
    if (path.endsWith('records/query')) return Response.json({
      records: Array.from({ length: 8 }, (_, i) => [asset(i), master(i, { resJPEGThumbRes: { size: 1 } })]).flat(),
      syncToken: 'seed',
    });
    lookupSizes.push(body.records.length);
    return Response.json({ records: body.records.map(({ recordName }: { recordName: string }) => ({
      recordName, fields: fields({ resJPEGThumbRes: { downloadURL: 'https://photos.example.icloud.com/content?private=SIGNED' } }),
    })) });
  }), 0);
  await plugin(host.bb, { provider: new FakeCloudProvider(), repository, photoCloud: api, photoVersionTransport: async () => {
    requests++;
    return new Response(new ReadableStream<Uint8Array>(),
      { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1' } });
  } });
  const { behavior } = host.harness;
  const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'photos' } };
  try {
    await eventually(async () => photosContract.photoIndexStatus.output.parse(await behavior.callRpc('photoIndexStatus', { library }, caller)),
      value => value.ok && value.state === 'ready');
    const ids = Array.from({ length: 8 }, (_, i) => `asset-${i}`);
    const result = photosContract.photoVersionTickets.output.parse(await behavior.callRpc('photoVersionTickets', { library, ids, version: 'thumb' }, caller));
    assert.ok(result.ok);
    const queued = ids.map(id => behavior.fetchHttp('GET', `/photo-version?ticket=${result.tickets[id]}`));
    const opened = await Promise.all(queued.slice(0, 6));
    assert.equal(requests, 6);
    assert.deepEqual(lookupSizes, [8]);
    assert.equal(opened[0].status, 200);
    assert.equal(opened[0].headers.get('content-type'), 'image/jpeg');
    await opened[0].body!.cancel();
    await opened[1].body!.cancel();
    const rest = await Promise.all(queued.slice(6));
    assert.equal(requests, 8);
    await Promise.all([...opened.slice(2), ...rest].map(response => response.body!.cancel()));
    assert.deepEqual(lookupSizes, [8]);
  } finally { await host.harness.lifecycle.dispose(); }
});
