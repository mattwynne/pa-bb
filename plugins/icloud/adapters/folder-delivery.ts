import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CloudError } from '../core/ports.ts';
import type { ManagedNativeMirror, RcloneProcess } from './rclone-process.ts';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(1024).refine(value =>
  !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
const entry = z.discriminatedUnion('kind', [
  z.strictObject({path:relative,kind:z.literal('directory')}),
  z.strictObject({path:relative,kind:z.literal('file'),size:revision,hash}),
]);
const move = z.strictObject({
  sequence:revision,operationId:z.string().uuid(),source:relative,path:relative,
  sourceFingerprint:hash,destinationFingerprint:hash,
});
export const folderMovePage = z.strictObject({cursor:revision,hasMore:z.boolean(),moves:z.array(move).max(32)});
export const folderManifestPage = z.strictObject({
  path:relative,fingerprint:hash,total:revision.max(10_000),entries:z.array(entry).max(64),
  nextOffset:revision.max(10_000).nullable(),
}).nullable();
const identityPart = z.string().min(1).max(512);
const workerReply = z.discriminatedUnion('outcome', [
  z.strictObject({outcome:z.literal('folder_published'),folder:z.strictObject({
    source:z.strictObject({documentId:identityPart,parentId:identityPart,etag:identityPart}),
    destinationParent:identityPart,method:z.literal('move'),
  })}),
  z.strictObject({outcome:z.literal('folder_collision'),alternatePath:relative}),
  z.strictObject({outcome:z.enum(['refused','uncertain','folder_not_dispatched','folder_refused'])}),
]);
type FolderMove = z.infer<typeof move>;
type FolderEntry = z.infer<typeof entry>;
type Side = 'source' | 'destination';
type QueuedMove = FolderMove & {dispatched:number; alternate:string|null};

export interface FolderDeliveryFeed {
  changes(id:string, after:number|null):Promise<unknown>;
  page(id:string, operationId:string, side:Side, offset:number, signal:AbortSignal):Promise<unknown>;
}

export const folderDeliverySchema = [
  'CREATE TABLE icloud_folder_delivery_cursor (mirror TEXT PRIMARY KEY, sequence INTEGER NOT NULL)',
  `CREATE TABLE icloud_folder_delivery_pending (
    mirror TEXT NOT NULL, sequence INTEGER NOT NULL, operationId TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL, path TEXT NOT NULL, sourceFingerprint TEXT NOT NULL, destinationFingerprint TEXT NOT NULL,
    dispatched INTEGER NOT NULL DEFAULT 0, alternate TEXT, PRIMARY KEY (mirror,sequence)
  )`,
] as const;

const maxQueued = 128;

export class FolderDeliveryQueue {
  constructor(private readonly db:Database.Database) {}

  cursor(id:string) {
    const row = this.db.prepare('SELECT sequence FROM icloud_folder_delivery_cursor WHERE mirror = ?').get(id) as {sequence:number}|undefined;
    return row?.sequence ?? null;
  }

  stage(id:string, from:number|null, input:unknown) {
    const parsed = folderMovePage.safeParse(input);
    if (!parsed.success) throw new CloudError('invalid_selection');
    const page = parsed.data;
    let previous = from ?? 0;
    for (const pending of page.moves) {
      if (pending.sequence <= previous || pending.sequence > page.cursor) throw new CloudError('source_changed');
      previous = pending.sequence;
    }
    if (page.cursor < previous || (page.hasMore && (!page.moves.length || previous !== page.cursor)) ||
      (from === null && (page.hasMore || page.moves.length))) throw new CloudError('source_changed');
    this.db.transaction(() => {
      if (this.cursor(id) !== from) throw new CloudError('source_changed');
      const row = this.db.prepare('SELECT count(*) AS count FROM icloud_folder_delivery_pending WHERE mirror = ?').get(id) as {count:number};
      if (row.count + page.moves.length > maxQueued) throw new CloudError('capacity');
      const insert = this.db.prepare(`INSERT INTO icloud_folder_delivery_pending
        (mirror,sequence,operationId,source,path,sourceFingerprint,destinationFingerprint) VALUES(?,?,?,?,?,?,?)`);
      for (const record of page.moves) {
        insert.run(id,record.sequence,record.operationId,record.source,record.path,record.sourceFingerprint,record.destinationFingerprint);
      }
      this.db.prepare(`INSERT INTO icloud_folder_delivery_cursor (mirror,sequence) VALUES(?,?)
        ON CONFLICT(mirror) DO UPDATE SET sequence = excluded.sequence`).run(id,page.cursor);
    }).immediate();
  }

  oldest(id:string) {
    return this.db.prepare(`SELECT sequence,operationId,source,path,sourceFingerprint,destinationFingerprint,dispatched,alternate
      FROM icloud_folder_delivery_pending WHERE mirror = ? ORDER BY sequence LIMIT 1`).get(id) as QueuedMove|undefined;
  }

  dispatch(id:string, operationId:string) {
    return this.db.prepare('UPDATE icloud_folder_delivery_pending SET dispatched = 1 WHERE mirror = ? AND operationId = ? AND dispatched = 0')
      .run(id,operationId).changes === 1;
  }

  releaseUndispatched(id:string, operationId:string) {
    this.db.prepare('UPDATE icloud_folder_delivery_pending SET dispatched = 0 WHERE mirror = ? AND operationId = ? AND alternate IS NULL')
      .run(id,operationId);
  }

  settle(id:string, operationId:string) {
    this.db.prepare('DELETE FROM icloud_folder_delivery_pending WHERE mirror = ? AND operationId = ?').run(id,operationId);
  }

  preserveCollision(id:string, operationId:string, path:string) {
    this.db.prepare('UPDATE icloud_folder_delivery_pending SET alternate = ? WHERE mirror = ? AND operationId = ? AND dispatched = 1 AND alternate IS NULL')
      .run(path,id,operationId);
  }
}

async function readManifest(feed:FolderDeliveryFeed, id:string, record:FolderMove, side:Side, signal:AbortSignal) {
  const path = side === 'source' ? record.source : record.path;
  const fingerprint = side === 'source' ? record.sourceFingerprint : record.destinationFingerprint;
  const entries:FolderEntry[] = [];
  let total:number|undefined;
  for (;;) {
    signal.throwIfAborted();
    const checked = folderManifestPage.safeParse(await feed.page(id,record.operationId,side,entries.length,signal));
    const page = checked.success ? checked.data : null;
    if (!page || page.path !== path || page.fingerprint !== fingerprint || (total !== undefined && page.total !== total))
      throw new CloudError('source_changed');
    total = page.total;
    entries.push(...page.entries);
    if (entries.length > total || page.nextOffset !== (entries.length < total ? entries.length : null) ||
      (entries.length < total && page.entries.length === 0)) throw new CloudError('source_changed');
    if (page.nextOffset === null) break;
  }
  if (new Set(entries.map(item => item.path)).size !== entries.length ||
      createHash('sha256').update(JSON.stringify(entries)).digest('hex') !== fingerprint)
    throw new CloudError('source_changed');
  return entries;
}

async function localFolder(root:string, path:string) {
  let current = root;
  const parts = path.split('/');
  for (const part of parts) {
    current = join(current,part);
    try { if (!(await lstat(current)).isDirectory()) return 'other'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
  }
  return 'directory';
}

export async function publishQueuedFolderMove(id:string, target:ManagedNativeMirror, worker:Pick<RcloneProcess,'noteDeliveryCommand'>,
  queue:FolderDeliveryQueue, feed:FolderDeliveryFeed, root:string, canStart:()=>boolean,
) {
  const pending = queue.oldest(id);
  if (!pending || pending.alternate || !canStart()) return;
  const {source,path,operationId} = pending;
  let folderEntries:FolderEntry[]|undefined;
  if (!pending.dispatched) {
    // A same-name cross-parent transition keeps the original iCloud folder ID.
    if (source.split('/').at(-1) !== path.split('/').at(-1) || source === path ||
      await localFolder(root,source) !== 'absent' || await localFolder(root,path) !== 'directory') {
      queue.settle(id,operationId);
      return;
    }
    const signal = AbortSignal.timeout(10_000);
    const [before,after] = await Promise.all([
      readManifest(feed,id,pending,'source',signal),readManifest(feed,id,pending,'destination',signal),
    ]);
    if (after.length !== before.length || after.some((item,index) => item.path !== before[index]!.path || item.kind !== before[index]!.kind))
      throw new CloudError('source_changed');
    if (!canStart() || await localFolder(root,source) !== 'absent' || await localFolder(root,path) !== 'directory') return;
    if (!canStart()) return;
    if (!queue.dispatch(id,operationId)) throw new CloudError('source_changed');
    folderEntries = before;
  }
  const result = workerReply.safeParse(await worker.noteDeliveryCommand(target,'relocate-folder',{
    operationId,source,path,...(folderEntries === undefined ? {} : {folderEntries}),
  }));
  if (!result.success) throw new CloudError('unavailable');
  const reply = result.data;
  if (reply.outcome === 'folder_collision') {
    const parent = (value:string) => value.slice(0,value.lastIndexOf('/')+1);
    if (reply.alternatePath === path || reply.alternatePath === source || parent(reply.alternatePath) !== parent(path))
      throw new CloudError('source_changed');
    queue.preserveCollision(id,operationId,reply.alternatePath);
    return 'folder_collision' as const;
  }
  if (reply.outcome === 'folder_not_dispatched') {
    queue.releaseUndispatched(id,operationId);
    return;
  }
  if (reply.outcome === 'folder_published' || reply.outcome === 'folder_refused' ||
    (reply.outcome === 'refused' && folderEntries !== undefined)) queue.settle(id,operationId);
}
