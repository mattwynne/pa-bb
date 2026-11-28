import { randomUUID } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import type { FilesystemVault } from './filesystem-vault.ts';

type Version = { text: string; modifiedMs: number };
export type Merge = (input: { path: string; local: Version; icloud: Version }, signal: AbortSignal) => Promise<string>;
type Vault = Pick<FilesystemVault, 'conflictPaths' | 'conflictVersions' | 'keepNewest' | 'resolve'>;
type Target = { mirrorId: string; revision: number };

const lines = (text: string) => text.split(/\r?\n/);
// True when every line of `small` appears in `large`, in order.
const contains = (large: string[], small: string[]) => {
  let i = 0;
  for (const line of large) if (i < small.length && line === small[i]) i++;
  return i === small.length;
};

// A note changed on one side only by adding lines needs no model.
export function plainResolution(local: string, icloud: string): 'keep_local' | 'accept_incoming' | null {
  const a = lines(local), b = lines(icloud);
  if (contains(a, b)) return 'keep_local';
  if (contains(b, a)) return 'accept_incoming';
  return null;
}

// Neither side changed a line both versions share, so a correct merge keeps it.
export function keepsSharedLines(local: string, icloud: string, merged: string) {
  const shared = new Set(lines(local).map(line => line.trim()).filter(Boolean));
  const other = new Set(lines(icloud).map(line => line.trim()));
  const result = new Set(lines(merged).map(line => line.trim()));
  for (const line of shared) if (other.has(line) && !result.has(line)) return false;
  return merged.trim().length > 0 || (!local.trim() && !icloud.trim());
}

// Resolves sync conflict copies in connected vaults without user setup. Notes
// are merged; other files keep their newest version. A conflict the sweeper
// cannot settle is retried after an hour.
export class ConflictSweeper {
  private deferred = new Map<string, number>();
  constructor(private vault: Vault, private targets: () => Target[], private merge: Merge,
    private report: (outcome: string, kind: 'note' | 'file') => void, private clock = Date.now) {}

  async sweep(signal: AbortSignal) {
    for (const target of this.targets()) {
      let paths: string[];
      try { paths = await this.vault.conflictPaths(target.mirrorId, target.revision, signal); }
      catch (error) { this.report(error instanceof VaultError ? error.category : 'unavailable', 'file'); continue; }
      for (const path of paths.slice(0, 20)) {
        if (signal.aborted) return;
        const key = `${target.mirrorId}\0${path}`;
        if ((this.deferred.get(key) ?? 0) > this.clock()) continue;
        const kind = path.endsWith('.md') ? 'note' : 'file';
        let outcome: string;
        try { outcome = kind === 'note' ? await this.note(target, path, signal) : await this.vault.keepNewest(target.mirrorId, target.revision, path); }
        catch (error) { outcome = error instanceof VaultError ? error.category : 'unavailable'; }
        if (!['merged', 'kept_local', 'kept_icloud', 'kept_newest', 'gone'].includes(outcome)) this.deferred.set(key, this.clock() + 60 * 60_000);
        else this.deferred.delete(key);
        this.report(outcome, kind);
      }
    }
  }

  private async note(target: Target, path: string, signal: AbortSignal) {
    const versions = await this.vault.conflictVersions(target.mirrorId, target.revision, path);
    if (!versions) return 'gone';
    const { local, icloud } = versions;
    const plain = plainResolution(local.text, icloud.text);
    let text: string | undefined;
    if (!plain) {
      text = await this.merge({ path, local, icloud }, signal);
      if (!keepsSharedLines(local.text, icloud.text, text)) return 'rejected';
    }
    await this.vault.resolve({ ...target, path, operationId: randomUUID(), token: versions.token,
      expectedLogicalHash: local.hash, expectedIncomingHash: icloud.hash, choice: plain ?? 'replace', text });
    return plain === 'keep_local' ? 'kept_local' : plain === 'accept_incoming' ? 'kept_icloud' : 'merged';
  }
}

// Runs one sweep at a time. A request during a sweep runs exactly one more
// afterwards, so a scan that finishes mid-sweep is never missed.
export class SweepTrigger {
  private running: Promise<void> | undefined;
  private again = false;
  constructor(private sweep: (signal: AbortSignal) => Promise<void>, private signal: AbortSignal) {}
  request(): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = this.sweep(this.signal).catch(() => {}).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; void this.request(); }
    });
    return this.running;
  }
  idle() { return this.running ?? Promise.resolve(); }
}
