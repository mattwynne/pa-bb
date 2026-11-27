import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { category } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import type { PushChange } from '../core/push-change.ts';
import { selectedRemote } from './rclone-cloud-provider.ts';

export type PushOutcome = 'sent' | 'skipped' | string;
type Version = { size: number; modTime: number; dir: boolean };
type Rc = (method: string, body: Record<string, unknown>) => Promise<any>;

const same = (a: Version | undefined, b: Version | undefined) =>
  !!a && !!b && a.size === b.size && Math.abs(a.modTime - b.modTime) < 1000;
// bisync writes Go timestamps with nanoseconds and a colon-free offset.
const listingTime = (value: string) => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?([+-]\d\d)(\d\d)$/.exec(value);
  return match ? Date.parse(`${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${match[3]}:${match[4]}`) : NaN;
};

// BB knows each change it makes, so it copies that change to iCloud with stock
// rclone straight away. The next bisync scan sees identical bytes on both sides
// and moves on. If iCloud changed since BB last saw it, the push is skipped and
// the scan keeps both versions as a conflict. A failed push also waits for the scan.
export class DirectPush {
  private queues = new Map<string, Promise<void>>();
  private sent = new Map<string, Version>();
  constructor(private rc: Rc, private root: string, private eligible: (id: string) => Mirror | null,
    private report: (outcome: PushOutcome, kind: string, elapsedMs: number) => void) {}

  push(mirrorId: string, change: PushChange) {
    const kind = change.kind === 'move' && change.directory ? 'folder_move' : change.kind;
    const next = (this.queues.get(mirrorId) ?? Promise.resolve()).then(async () => {
      const started = performance.now();
      const outcome = await this.apply(mirrorId, change).catch(error => category(error));
      this.report(outcome, kind, Math.round(performance.now() - started));
    });
    this.queues.set(mirrorId, next);
    void next.finally(() => { if (this.queues.get(mirrorId) === next) this.queues.delete(mirrorId); });
    return next;
  }

  drain() { return Promise.allSettled([...this.queues.values()]); }

  private async apply(id: string, change: PushChange): Promise<PushOutcome> {
    const mirror = this.eligible(id);
    if (!mirror) return 'unavailable';
    const remote = selectedRemote(mirror);
    const key = (path: string) => `${id}\0${path}`;
    // Only overwrite or move what BB last saw in iCloud: its last push or the last scan.
    const unchanged = async (path: string, now: Version) => same(now, this.sent.get(key(path))) || same(now, await this.listed(id, path));
    const record = async (path: string) => {
      const now = await this.stat(remote, path);
      if (this.sent.size >= 4096) this.sent.clear();
      if (now) this.sent.set(key(path), now);
    };

    if (change.kind === 'write') {
      const now = await this.stat(remote, change.path);
      if (now && (now.dir || !await unchanged(change.path, now))) return 'skipped';
      await this.rc('operations/copyfile', { srcFs: join(this.root, 'mirrors', id), srcRemote: change.path, dstFs: remote, dstRemote: change.path });
      await record(change.path);
      return 'sent';
    }
    const caseOnly = change.path.toLowerCase() === change.destination.toLowerCase();
    const source = await this.stat(remote, change.path);
    if (!source || source.dir !== !!change.directory || (!caseOnly && await this.stat(remote, change.destination))) return 'skipped';
    if (change.directory) {
      // Same remote, no filters: rclone uses iCloud's server-side folder move.
      await this.rc('sync/move', { srcFs: `${remote}/${change.path}`, dstFs: `${remote}/${change.destination}`, deleteEmptySrcDirs: true });
      for (const stored of this.sent.keys()) if (stored.startsWith(key(change.path + '/'))) this.sent.delete(stored);
      return 'sent';
    }
    if (!await unchanged(change.path, source)) return 'skipped';
    await this.rc('operations/movefile', { srcFs: remote, srcRemote: change.path, dstFs: remote, dstRemote: change.destination });
    this.sent.delete(key(change.path));
    await record(change.destination);
    return 'sent';
  }

  private async stat(remote: string, path: string): Promise<Version | null> {
    const { item } = await this.rc('operations/stat', { fs: remote, remote: path, opt: {} }) ?? {};
    if (!item) return null;
    return { size: Number(item.Size), modTime: Date.parse(item.ModTime), dir: item.IsDir === true };
  }

  // The scan's cloud-side listing (path1) records what iCloud held when bisync last finished.
  private async listed(id: string, path: string): Promise<Version | undefined> {
    const directory = join(this.root, 'baselines', id);
    const name = (await readdir(directory)).find(file => file.endsWith('.path1.lst'));
    if (!name) return undefined;
    const suffix = ' ' + JSON.stringify(path);
    for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) {
      if (!line.startsWith('- ') || !line.endsWith(suffix)) continue;
      const [, size, , , time] = line.slice(0, -suffix.length).trim().split(/\s+/);
      return { size: Number(size), modTime: listingTime(time ?? ''), dir: false };
    }
    return undefined;
  }
}
