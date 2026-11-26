import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { FolderDeliveryQueue, folderDeliverySchema, publishQueuedFolderMove, type FolderDeliveryFeed } from '../adapters/folder-delivery.ts';

const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mirror = 'mirror-1';
const target = {binary:'/native',remote:'icloud:generated',workdir:'/baselines',binding:'binding'} as const;
const operationId = '685a3030-7981-4cbc-984a-35454ac456d6';
const source = 'Original/Folder';
const path = 'Archive/Folder';
const alternate = 'Archive/Folder 2';
const before = Array.from({length:65},(_,i) => ({path:`${i}.md`,kind:'file' as const,size:3,hash:hash('a')}));
const after = before.map((entry,i) => i === 64 ? {...entry,hash:hash('b')} : entry);

async function fixture(t:TestContext) {
  const root = await mkdtemp(join(tmpdir(),'bb-folder-delivery-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(root,{recursive:true,force:true}); });
  await mkdir(join(root,path),{recursive:true});
  for (const sql of folderDeliverySchema) db.exec(sql);
  const queue = new FolderDeliveryQueue(db);
  queue.stage(mirror,null,{cursor:2,hasMore:false,moves:[]});
  queue.stage(mirror,2,{cursor:3,hasMore:false,moves:[{
    sequence:3,operationId,source,path,sourceFingerprint:hash(before),destinationFingerprint:hash(after),
  }]});
  const reads:string[] = [];
  const feed:FolderDeliveryFeed = {
    async changes() { throw new Error('fixture already staged'); },
    async page(_mirror,id,side,offset) {
      assert.equal(id,operationId);
      reads.push(`${side}:${offset}`);
      const all = side === 'source' ? before : after;
      const end = Math.min(offset+64,all.length);
      return {path:side === 'source' ? source : path,fingerprint:hash(all),
        total:all.length,entries:all.slice(offset,end),nextOffset:end < all.length ? end : null};
    },
  };
  return {root,queue,feed,reads};
}

test('folder delivery reads both complete manifests and recovers without resubmitting the move', async t => {
  const {root,queue,feed,reads} = await fixture(t);
  const payloads:Record<string,unknown>[] = [];
  const worker = {
    async noteDeliveryCommand(_target:unknown, command:string, payload:Record<string,unknown>) {
      assert.equal(command,'relocate-folder');
      payloads.push(payload);
      if (payloads.length === 1) throw new Error('lost reply');
      return {outcome:'folder_published',folder:{source:{documentId:'doc',parentId:'parent',etag:'revision'},
        destinationParent:'parent',method:'move'}};
    },
  };
  await assert.rejects(publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true),/lost reply/);
  assert.deepEqual(payloads[0],{operationId,source,path,folderEntries:before});
  assert.deepEqual([...reads].sort(),['destination:0','destination:64','source:0','source:64']);
  assert.equal(queue.oldest(mirror)?.dispatched,1);
  await publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true);
  assert.deepEqual(payloads[1],{operationId,source,path});
  assert.equal(reads.length,4);
  assert.equal(queue.oldest(mirror),undefined);
});

test('folder delivery leaves the provider-created alternate available for recovery', async t => {
  const {root,queue,feed} = await fixture(t);
  let count = 0;
  const worker = {
    async noteDeliveryCommand() { count++; return {outcome:'folder_collision',alternatePath:alternate}; },
  };
  assert.equal(await publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true),'folder_collision');
  assert.equal(queue.oldest(mirror)?.alternate,alternate);
  await publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true);
  assert.equal(count,1);
});

test('folder delivery rejects tampered manifest bytes before staging any provider request', async t => {
  const {root,queue,feed} = await fixture(t);
  const original = feed.page;
  feed.page = async (...args) => {
    const result = await original(...args) as {entries:Array<(typeof before)[number]>};
    if (args[2] === 'destination' && args[3] === 64) result.entries[0] = {...result.entries[0]!,hash:hash('tampered')};
    return result;
  };
  const worker = {async noteDeliveryCommand() { assert.fail('provider dispatch'); }};
  await assert.rejects(publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true),/source_changed/);
  assert.equal(queue.oldest(mirror)?.dispatched,0);
});

test('folder delivery retries only after the worker proves the prior request was never dispatched', async t => {
  const {root,queue,feed} = await fixture(t);
  const frames:Record<string,unknown>[] = [];
  const worker = {
    async noteDeliveryCommand(_target:unknown,_command:string,payload:Record<string,unknown>) {
      frames.push(payload);
      if (frames.length === 1) throw new Error('transport interrupted');
      return {outcome:frames.length === 2 ? 'folder_not_dispatched' : 'folder_refused'};
    },
  };
  await assert.rejects(publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true),/transport interrupted/);
  await publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true);
  assert.equal(queue.oldest(mirror)?.dispatched,0);
  await publishQueuedFolderMove(mirror,target,worker,queue,feed,root,()=>true);
  assert.equal(frames.length,3);
  assert.equal(frames[1]!.folderEntries,undefined);
  assert.deepEqual(frames[2]!.folderEntries,before);
  assert.equal(queue.oldest(mirror),undefined);
});
