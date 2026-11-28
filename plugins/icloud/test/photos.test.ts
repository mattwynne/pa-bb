import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';

test('Photos uses the existing account, requires the verified caller, and revokes download tickets on disconnect', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const provider = new FakeCloudProvider();
  const repository = new MemoryState();
  repository.value.connected = true;
  const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'photos' } };
  let bad = false, calls = 0;
  const bytes = Buffer.from([0, 255, 1, 0]);
  await plugin(host.bb, { provider, repository, photoRemote: {
    async list(path) {
      calls++;
      if (bad) throw new Error('PRIVATE_PHOTO_FAILURE');
      if (path.length === 0) return { list: [{ Name: 'Album', Path: 'Album', IsDir: true, Size: -1 }] };
      assert.deepEqual(path, ['Album']);
      return { list: [{ Name: 'café #1.jpg', Path: 'Album/café #1.jpg', IsDir: false, Size: 4 }] };
    },
    async object(path) {
      assert.deepEqual(path, ['Album', 'café #1.jpg']);
      return Object.assign(Readable.from([bytes], { objectMode: false }), {
        statusCode: 200, headers: { 'content-length': '4' },
      }) as unknown as IncomingMessage;
    },
  } });
  const { behavior } = host.harness;
  const rpc = (method: string, input: unknown) => behavior.callRpc(method, input, caller) as Promise<any>;
  try {
    assert.equal(await rpc('photosStatus', null), 'shared');
    await assert.rejects(behavior.callRpc('photosBrowse', { parent: null }), /host-verified Photos/);
    assert.equal(calls, 0);
    const root = await rpc('photosBrowse', { parent: null });
    const album = await rpc('photosBrowse', { parent: { listing: root.listing, index: 0 } });
    const selection = { listing: album.listing, index: 0, mode: 'download' };
    const { ticket } = await rpc('photosTicket', selection);
    const download = (id: string) => behavior.fetchHttp('GET', `/photo-download?ticket=${id}`);
    const response = await download(ticket);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition')!, /attachment.*caf%C3%A9%20%231.jpg/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal((await download(ticket)).status, 404);
    bad = true;
    const failure = await rpc('photosBrowse', { parent: null });
    assert.equal(failure.ok, false);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /iCloud photos_browse unknown/);
    assert.doesNotMatch(JSON.stringify([failure, host.harness.inspection.logEntries]), /PRIVATE_PHOTO_FAILURE/);
    const stale = await rpc('photosTicket', selection);
    await behavior.callRpc('disconnect', null);
    assert.equal(await rpc('photosStatus', null), 'disconnected');
    assert.equal((await download(stale.ticket)).status, 404);
    assert.equal(provider.prepared + provider.synced, 0);
  } finally { await host.harness.lifecycle.dispose(); }
});

const version = spawnSync('rclone', ['version'], { encoding: 'utf8' });
const native = process.platform === 'linux' && /^rclone v1\.(?:75\.2|76\.0)\r?\n/.test(version.stdout ?? '');
test('native photo reads share the named remote and stream an exact nested file', { skip: !native }, async () => {
  const temp = await mkdtemp('/tmp/icloud-photos-test-');
  const root = join(temp, 'icloud');
  const fixture = join(temp, 'fixture');
  const process = new RcloneProcess(root);
  const signal = AbortSignal.timeout(30_000);
  try {
    await mkdir(join(fixture, 'Album'), { recursive: true });
    await writeFile(join(fixture, 'Album', 'café #1.jpg'), 'generated');
    await process.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: fixture }, opt: { nonInteractive: true } });
    const result = await process.listPhotos(['Album'], signal);
    assert.equal(result.list[0].Path, 'Album/café #1.jpg');
    const download = await process.openPhoto(['Album', 'café #1.jpg'], signal);
    assert.equal(download.statusCode, 200);
    const chunks: Buffer[] = [];
    for await (const chunk of download) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'generated');
  } finally { await process.stop(); await rm(temp, { recursive: true, force: true }); }
});
