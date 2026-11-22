import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import type { Diagnose } from '../core/ports.ts';

const stageId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const stageName = new RegExp(`^\\.obsidian-bb-${stageId}\\.tmp$`);
export const obsidianStageExclude = `.obsidian-bb-{{${stageId}}}.tmp`;
const coalesceMs = 400;

// Local changes are hints. The regular poll still discovers changes made
// during native sync, missed filesystem events and cloud-only changes.
export class MirrorWakeups {
  private watchers = new Map<string, FSWatcher>();
  private failed = new Set<string>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private stopped = false;

  constructor(private readonly sync: (ids: ReadonlySet<string>) => Promise<boolean>, private readonly diagnose: Diagnose) {}

  observe(id: string, directory: string) {
    if (this.stopped || this.watchers.has(id)) return;
    try {
      const watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
        if (this.watchers.get(id) !== watcher || (filename && stageName.test(basename(filename)))) return;
        this.dirty.add(id);
        this.schedule();
      });
      this.watchers.set(id, watcher);
      this.failed.delete(id);
      watcher.on('error', () => {
        if (this.watchers.get(id) !== watcher) return;
        this.suspend(id);
        this.watchFailure(id);
      });
    } catch { this.watchFailure(id); }
  }

  private watchFailure(id: string) {
    if (this.failed.has(id)) return;
    this.failed.add(id);
    this.diagnose('mirror_watch', 'unavailable');
  }

  suspend(id: string) {
    const watcher = this.watchers.get(id);
    this.watchers.delete(id);
    watcher?.close();
  }

  private schedule() {
    if (this.timer || this.flushing || this.stopped || !this.dirty.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, coalesceMs);
    this.timer.unref();
  }

  private async flush() {
    this.flushing = true;
    const targets = this.dirty;
    this.dirty = new Set();
    try {
      // Busy means another admitted operation owns the service. Retain
      // coalesced hints until it drains without creating another native turn.
      if (!(await this.sync(targets))) for (const id of targets) this.dirty.add(id);
    } catch { this.diagnose('mirror_wake', 'unavailable'); }
    finally { this.flushing = false; this.schedule(); }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.dirty.clear();
    for (const id of this.watchers.keys()) this.suspend(id);
  }
}
