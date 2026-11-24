import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import type { Diagnose, DesktopLinkOperation, PathMove, PathMoveReceipt, Receipt, Resolution, VaultFiles } from '../core/ports.ts';
import { digest, equivalent, identity, LocalNotes, validateNotePath, validateRelativePath } from './local-notes.ts';
import type { DirectoryGrant } from './local-notes.ts';
import { fileIdentity, LocalReceipts } from './local-receipts.ts';
import type { FileIdentity, LocalReceipt } from './local-receipts.ts';
import type { DesktopLinks } from './desktop-links.ts';

type Target = { mirrorId: string; revision: number; path: string };
type DirectoryLookup = (mirrorId: string, revision: number, signal?: AbortSignal) => Promise<string>;
type Observed = Awaited<ReturnType<LocalNotes['observe']>>;
type Copy = Awaited<ReturnType<LocalNotes['conflictCopies']>>[number];
type Conflict = { canonical: Observed; copies: Copy[]; logical: NonNullable<Observed>; incoming: NonNullable<Observed> };
type Token = { target: Target; root: string; identity: FileIdentity; version: string; expires: number };

const versionIdentity = (info: Stats) => ({ ...fileIdentity(info), birthtime: info.birthtimeMs });

export class FilesystemVault {
  private files = new LocalNotes();
  private tokens = new Map<string, Token>();
  constructor(private directory: DirectoryLookup, private grant: (id: string, revision: number, signal?: AbortSignal) => Promise<DirectoryGrant>,
    private ledger: LocalReceipts, private diagnose: Diagnose) {}

  async desktopRoot(id: string, revision: number, requested: string | undefined, signal: AbortSignal) {
    const grant = await this.grant(id, revision, signal);
    let prefix = requested;
    if (prefix === undefined) {
      const { roots, incomplete } = await this.files.vaultRoots(grant.directory);
      if (incomplete || roots.length !== 1) throw new VaultError('unsupported', 'Configure the exact Desktop vault root.');
      prefix = roots[0]!;
    }
    if (prefix) validateRelativePath(prefix);
    return this.files.desktopRoot(grant, prefix);
  }

  async desktopRun(id: string, revision: number, root: Awaited<ReturnType<FilesystemVault['desktopRoot']>>,
    desktop: DesktopLinks, operation: DesktopLinkOperation, signal: AbortSignal, assertSelected: () => void, before?: () => Promise<void>) {
    return desktop.run({ id, directory: root.directory, identity: [root.dev, root.ino, root.settingsDev, root.settingsIno].join(':') }, operation, async (phase, request) => {
      const current = await this.desktopRoot(id, revision, root.prefix, request);
      if (current.directory !== root.directory || current.dev !== root.dev || current.ino !== root.ino ||
          current.settingsDev !== root.settingsDev || current.settingsIno !== root.settingsIno) throw new VaultError('source_unavailable');
      if (phase === 'before_command') await before?.();
    }, signal, assertSelected);
  }

  private async moved(root: string, row: Extract<LocalReceipt, { kind: 'move' }>, saves: LocalReceipt[] = []) {
    if (await this.files.entry(root, row.path)) return false;
    const target = await this.files.entry(root, row.destination);
    let expected: FileIdentity & { birthtime?: number } = { ...row.inode, birthtime: row.birthtime };
    if (!row.directory && expected.birthtime !== undefined) for (const save of saves) {
      if (save.kind !== 'save' || save.outcome !== 'saved_locally_pending_sync' || save.path !== row.destination ||
          save.mirrorId !== row.mirrorId || !identity(row.root, save.root) || !save.previousIdentity ||
          !identity(expected, save.previousIdentity) || expected.birthtime !== save.previousIdentity.birthtime ||
          save.birthtime === undefined) continue;
      expected = { ...save.inode, birthtime: save.birthtime };
    }
    if (!target || !identity(target, expected) || (expected.birthtime !== undefined && expected.birthtime !== target.birthtimeMs) ||
        (row.directory ? !target.isDirectory() : !target.isFile())) return false;
    if (!row.tree || row.directory) return true;
    const folder = await this.files.entry(root, row.tree.to);
    return !await this.files.entry(root, row.tree.from) && !!folder?.isDirectory() && identity(folder, row.tree.inode);
  }

  async movePath(input: PathMove, revision: number, run: (before: () => Promise<void>) => Promise<unknown>): Promise<PathMoveReceipt> {
    const { vaultId, path, destination, operationId, expectedHash, kind } = input;
    const folder = kind === 'folder';
    (folder ? validateRelativePath : validateNotePath)(destination);
    if (path === destination || (folder && (destination.startsWith(path + '/') || path.startsWith(destination + '/')))) throw new VaultError('invalid_path');
    const endpoints = { vaultId, path, destination, operationId };
    try {
      const row = await this.mutate<Extract<LocalReceipt, { kind: 'move' }>>(
        { mirrorId: vaultId, path, revision, ...(folder ? { directory: true as const } : {}) },
        async (root, check, begin, changed, rootIdentity) => {
          const source = await this.files.entry(root, path);
          const base = {
            kind: 'move' as const, mirrorId: vaultId, path, destination, operationId,
            hash: expectedHash ?? digest(''), root: rootIdentity, inode: fileIdentity(source ?? rootIdentity),
            at: new Date().toISOString(), birthtime: source?.birthtimeMs, ...(folder ? { directory: true as const } : {}),
          };
          const verify = async () => {
            await check();
            const current = await this.files.entry(root, path);
            if (!source || !current || !identity(source, current) || (folder ? !current.isDirectory() : !current.isFile()) ||
              await this.files.entry(root, destination)) throw new VaultError('conflict', 'Check the source and choose an unoccupied destination.');
            if (!folder) {
              if (expectedHash && (await this.files.observe(root, path))?.hash !== expectedHash) throw new VaultError('conflict');
              await this.clearPath(root, path);
              await this.clearPath(root, destination);
            }
          };
          await verify();
          await begin({ ...base, outcome: 'uncertain' });
          const applied = await run(async () => { await verify(); changed(); });
          if (applied === false) return { ...base, outcome: 'not_moved' };
          if (!await this.moved(root, { ...base, outcome: 'uncertain' })) throw new VaultError('uncertain');
          await check();
          return { ...base, outcome: 'moved_locally_pending_sync' };
        });
      return { ...endpoints, outcome: row.outcome };
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      if (error.category === 'uncertain') return { ...endpoints, outcome: 'uncertain' };
      if (['conflict', 'invalid_path', 'cancelled'].includes(error.category)) return { ...endpoints, outcome: 'not_moved' };
      throw error;
    }
  }

  async moveReceipt(vaultId: string, revision: number, operationId: string): Promise<PathMoveReceipt | null> {
    return this.ledger.run(async () => {
      const ledger = await this.ledger.load();
      const index = ledger.findIndex(r => r.kind === 'move' && r.mirrorId === vaultId && r.operationId === operationId);
      const row = ledger[index];
      if (!row || row.kind !== 'move') return null;
      let current = await this.reconcile(row, revision);
      if (current.kind !== 'move') return null;
      if (current.outcome === 'moved_locally_pending_sync') {
        try {
          const root = await this.directory(vaultId, revision);
          if (!identity(current.root, await this.files.rootIdentity(root)) || !await this.moved(root, current, ledger.slice(index + 1)))
            current = { ...current, outcome: 'uncertain' };
        } catch { current = { ...current, outcome: 'uncertain' }; }
      }
      return { vaultId, path: current.path, destination: current.destination, operationId, outcome: current.outcome };
    });
  }

  private async access<T>(mirrorId: string, revision: number, action: (root: string) => Promise<T>, signal?: AbortSignal) {
    const root = await this.directory(mirrorId, revision, signal);
    try {
      if (signal?.aborted) throw new VaultError('cancelled');
      const rootIdentity = async () => {
        try { return await this.files.rootIdentity(root); }
        catch { throw new VaultError('source_unavailable'); }
      };
      const before = await rootIdentity();
      try { return await action(root); }
      finally {
        if (!identity(before, await rootIdentity())) { throw new VaultError('source_unavailable'); }
      }
    } catch (error) { throw this.report(error); }
  }

  private report(error: unknown, committed = false): VaultError {
    if (error instanceof VaultError && error.diagnosticReported && !committed) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    const category = committed ? 'uncertain' : error instanceof VaultError ? error.category :
      code === 'ENOSPC' || code === 'EDQUOT' ? 'capacity' : code === 'ELOOP' ? 'invalid_path' : 'unavailable';
    this.diagnose('filesystem', category);
    return new VaultError(category, committed ? 'Inspect the exact operation receipt before making another change.' :
      error instanceof VaultError ? error.nextAction : 'Check the local vault and reread before preparing a change.', true);
  }

  children(id: string, revision: number, folder: string, signal?: AbortSignal) {
    return this.access(id, revision, async root => {
      const result = await this.files.children(root, folder);
      if (result.incomplete) this.diagnose('filesystem', 'unavailable');
      return result;
    }, signal);
  }

  vaultRoots(id: string, revision: number) {
    return this.access(id, revision, async root => {
      const result = await this.files.vaultRoots(root);
      if (result.incomplete) this.diagnose('filesystem', result.warnings[0] ?? 'unavailable');
      return result;
    });
  }

  read(id: string, revision: number, path: string, signal?: AbortSignal) {
    return this.access(id, revision, root => this.files.read(root, path), signal);
  }

  private async conflict(root: string, path: string): Promise<Conflict | null> {
    validateNotePath(path);
    const copies = await this.files.conflictCopies(root, path);
    if (!copies.length) return null;
    const canonical = await this.files.observe(root, path);
    const local = copies.filter(c => c.side === 'bb');
    const remote = copies.filter(c => c.side === 'icloud');
    const logical = canonical ?? local[0]?.observation;
    if (!logical || remote.length !== 1 || local.length > 1 ||
      (canonical && local.length && canonical.hash !== local[0].observation.hash)) {
      throw new VaultError('conflict', 'Multiple or ambiguous conflict copies need inspection in the vault directory.');
    }
    return { canonical, copies, logical, incoming: remote[0].observation };
  }

  private conflictVersion(conflict: Conflict) {
    const stamp = (value: Observed) => value && [value.hash, value.info.dev, value.info.ino, value.info.mtimeMs, value.info.ctimeMs];
    return JSON.stringify([stamp(conflict.canonical), ...conflict.copies.map(c => [c.path, stamp(c.observation)]).sort()]);
  }

  private async guardedConflict(root: string, target: Target, token: string) {
    const entry = this.tokens.get(token);
    const conflict = await this.conflict(root, target.path);
    if (!entry || entry.expires < Date.now() || entry.root !== root || entry.target.mirrorId !== target.mirrorId ||
      entry.target.revision !== target.revision || entry.target.path !== target.path || !conflict ||
      !identity(entry.identity, await this.files.rootIdentity(root)) || this.conflictVersion(conflict) !== entry.version) {
      throw new VaultError('conflict', 'Inspect the exact conflict again before proceeding.');
    }
    return conflict;
  }

  inspect(mirrorId: string, revision: number, path: string) {
    return this.access(mirrorId, revision, async root => {
      const conflict = await this.conflict(root, path);
      if (!conflict) return null;
      const token = randomUUID();
      if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value!);
      this.tokens.set(token, { target: { mirrorId, revision, path }, root, identity: await this.files.rootIdentity(root),
        version: this.conflictVersion(conflict), expires: Date.now() + 5 * 60_000 });
      return { token, logicalHash: conflict.logical.hash, incomingHash: conflict.incoming.hash, incomingAbsent: false };
    });
  }

  readIncoming(mirrorId: string, revision: number, path: string, token: string) {
    return this.access(mirrorId, revision, async root => {
      const { incoming } = await this.guardedConflict(root, { mirrorId, revision, path }, token);
      return { absent: false as const, text: incoming.text, hash: incoming.hash, readAt: new Date().toISOString(), complete: true as const };
    });
  }

  private mutate<T extends LocalReceipt>(target: Target & { directory?: true }, plan: (root: string, check: () => Promise<void>,
    begin: (row: T) => Promise<void>, committed: () => void, rootIdentity: FileIdentity) => Promise<T>) {
    return this.ledger.run(async () => {
      const root = await this.directory(target.mirrorId, target.revision);
      let intent: T | undefined, changed = false;
      try {
        (target.directory ? validateRelativePath : validateNotePath)(target.path);
        const rootIdentity = fileIdentity(await this.files.rootIdentity(root));
        const check = async () => {
          const authorized = await this.directory(target.mirrorId, target.revision);
          if (authorized !== root || !identity(rootIdentity, await this.files.rootIdentity(root))) throw new VaultError('source_unavailable');
        };
        const begin = async (row: T) => {
          await this.ledger.begin(row, row.kind === 'move' ? [row.path, row.destination, ...(row.tree ? [row.tree.from, row.tree.to] : [])] : [row.path]);
          intent = row;
        };
        const result = await plan(root, check, begin, () => { changed = true; }, rootIdentity);
        await this.ledger.finish(result);
        return result;
      } catch (error) {
        if (intent && !changed) {
          const outcome = intent.kind === 'move' ? 'not_moved' : 'not_saved';
          try { await this.ledger.finish({ ...intent, outcome } as LocalReceipt); }
          catch (stateError) { throw this.report(stateError, true); }
        }
        // Before publication a filesystem failure cannot leave a partial edit.
        const refusal = this.report(error, changed);
        if (!changed && refusal.category === 'unavailable') throw new VaultError('source_unavailable', refusal.nextAction, true);
        throw refusal;
      }
    });
  }

  private async clearPath(root: string, path: string) {
    if ((await this.files.conflictCopies(root, path)).length) throw new VaultError('conflict', 'Inspect and resolve the conflict copies first.');
  }

  async commit(input: Parameters<VaultFiles['commit']>[0]) {
    const { mirrorId, path, operationId, expectedHash, text } = input;
    const row = await this.mutate<Extract<LocalReceipt, { kind: 'save' }>>(input, async (root, check, begin, changed, rootIdentity) => {
      const current = await this.files.observe(root, path);
      if (input.kind === 'create' ? current || expectedHash !== null : !current || current.hash !== expectedHash) throw new VaultError('conflict');
      await this.clearPath(root, path);
      const base = { kind: 'save' as const, mirrorId, path, operationId, previousHash: expectedHash, hash: digest(text),
        root: rootIdentity, at: new Date().toISOString(), ...(current ? { previousIdentity: versionIdentity(current.info) } : {}) };
      let inode!: FileIdentity;
      let birthtime!: number;
      await this.files.publish(root, path, text, current, async stage => {
        inode = fileIdentity(stage);
        birthtime = stage.birthtimeMs;
        await begin({ ...base, inode, birthtime, outcome: 'uncertain' });
      }, async () => { await this.clearPath(root, path); await check(); }, changed);
      return { ...base, inode, birthtime, outcome: 'saved_locally_pending_sync' };
    });
    return this.saveReceipt(row);
  }

  async desktopCommit(input: Parameters<VaultFiles['commit']>[0], run: (before: () => Promise<void>) => Promise<unknown>) {
    const { mirrorId, path, operationId, expectedHash, text } = input;
    const attempted = await this.mutate<Extract<LocalReceipt, { kind: 'save' }>>(input, async (root, check, begin, changed, rootIdentity) => {
      const current = await this.files.observe(root, path);
      if (!current || current.hash !== expectedHash) throw new VaultError('conflict');
      const base = { kind: 'save' as const, mirrorId, path, operationId, previousHash: expectedHash, hash: digest(text),
        inode: fileIdentity(current.info), root: rootIdentity, at: new Date().toISOString(), previousIdentity: versionIdentity(current.info) };
      const verify = async () => {
        await this.clearPath(root, path);
        await check();
        if (!equivalent(current, await this.files.observe(root, path))) throw new VaultError('conflict');
      };
      await verify();
      await begin({ ...base, outcome: 'uncertain' });
      const applied = await run(async () => { await verify(); changed(); });
      if (applied === false) return { ...base, outcome: 'not_saved' };
      const updated = await this.files.observe(root, path);
      if (!updated || updated.hash !== base.hash) throw new VaultError('uncertain');
      await this.files.syncParent(root, path);
      await check();
      if (!equivalent(updated, await this.files.observe(root, path))) throw new VaultError('uncertain');
      return { ...base, inode: fileIdentity(updated.info), birthtime: updated.info.birthtimeMs, outcome: 'saved_locally_pending_sync' };
    });
    return this.saveReceipt(attempted);
  }

  async resolve(input: Resolution) {
    const { mirrorId, path, operationId, token } = input;
    const row = await this.mutate<Extract<LocalReceipt, { kind: 'resolution' }>>(input, async (root, check, begin, changed, rootIdentity) => {
      const conflict = await this.guardedConflict(root, input, token);
      if (input.expectedLogicalHash !== conflict.logical.hash || input.expectedIncomingHash !== conflict.incoming.hash) throw new VaultError('conflict');
      const text = input.choice === 'accept_incoming' ? conflict.incoming.text : input.choice === 'keep_local' ? conflict.logical.text : input.text;
      if (text === undefined) throw new VaultError('invalid_query');
      const base = { kind: 'resolution' as const, mirrorId, path, operationId, choice: input.choice, hash: digest(text), root: rootIdentity, at: new Date().toISOString() };
      let inode!: FileIdentity;
      await this.files.publish(root, path, text, conflict.canonical, async stage => {
        inode = fileIdentity(stage);
        await begin({ ...base, inode, outcome: 'uncertain' });
      }, async () => { await this.guardedConflict(root, input, token); await check(); }, changed);
      const canonical = await this.files.observe(root, path);
      if (!canonical || !identity(inode, canonical.info) || canonical.hash !== base.hash) throw new VaultError('uncertain');
      const copies = await this.files.conflictCopies(root, path);
      if (copies.length !== conflict.copies.length || !copies.every(copy => {
        const original = conflict.copies.find(c => c.path === copy.path);
        return original && equivalent(original.observation, copy.observation);
      })) throw new VaultError('uncertain');
      for (const copy of copies) {
        await check();
        if (!equivalent(canonical, await this.files.observe(root, path))) throw new VaultError('uncertain');
        await this.files.removeCopy(root, copy.path, copy.observation);
      }
      this.tokens.delete(token);
      const outcome = input.choice === 'accept_incoming' ? 'adopted_content' : 'saved_locally_pending_sync';
      return { ...base, inode, outcome };
    });
    return { hash: row.hash, outcome: row.outcome as 'adopted_content' | 'saved_locally_pending_sync' };
  }

  private saveReceipt({ mirrorId, path, operationId, at, outcome, hash, previousHash }: Extract<LocalReceipt, { kind: 'save' }>) {
    return { mirrorId, path, operationId, at, outcome, hash, previousHash };
  }

  private async reconcile(row: LocalReceipt, revision: number): Promise<LocalReceipt> {
    if (row.outcome !== 'uncertain') return row;
    try {
      const root = await this.directory(row.mirrorId, revision);
      if (!identity(row.root, await this.files.rootIdentity(root))) return row;
      if (row.kind === 'move') {
        if (!await this.moved(root, row)) return row;
        await this.files.syncParent(root, row.path);
        await this.files.syncParent(root, row.destination);
        if (!identity(row.root, await this.files.rootIdentity(root)) || !await this.moved(root, row)) return row;
        const result = { ...row, outcome: 'moved_locally_pending_sync' as const };
        await this.ledger.finish(result);
        return result;
      }
      const path = row.path;
      const written = await this.files.observe(root, path);
      if (!written || !identity(row.inode, written.info) || row.hash !== written.hash) return row;
      await this.files.syncParent(root, path);
      if (!equivalent(written, await this.files.observe(root, path))) return row;
      if (row.kind === 'resolution' && (await this.files.conflictCopies(root, row.path)).length) return row;
      if (!identity(row.root, await this.files.rootIdentity(root))) return row;
      const result = row.kind === 'resolution' && row.choice === 'accept_incoming' ? { ...row, outcome: 'adopted_content' as const } :
        { ...row, ...(row.kind === 'save' ? { birthtime: written.info.birthtimeMs } : {}), outcome: 'saved_locally_pending_sync' as const };
      await this.ledger.finish(result);
      return result;
    } catch (error) {
      if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('filesystem', 'uncertain');
      return row;
    }
  }

  async receipts(input: Parameters<VaultFiles['receipts']>[0]) {
    return this.ledger.run(async () => {
      const rows = (await this.ledger.load()).filter(r => r.kind !== 'move' && r.mirrorId === input.mirrorId &&
        (!input.path || r.path === input.path) && (!input.operationId || r.operationId === input.operationId) &&
        (!input.since || Date.parse(r.at) >= Date.parse(input.since)))
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit);
      const receipts: Receipt[] = [];
      for (const row of rows) {
        const r = input.operationId ? await this.reconcile(row, input.revision) : row;
        if (r.kind === 'save') receipts.push({ kind: 'save', ...this.saveReceipt(r) });
        if (r.kind === 'resolution' && (r.outcome === 'adopted_content' || r.outcome === 'saved_locally_pending_sync')) {
          receipts.push({ kind: 'resolution', mirrorId: r.mirrorId, path: r.path, operationId: r.operationId, at: r.at, outcome: r.outcome, hash: r.hash });
        }
      }
      return { known: rows.length > 0, receipts };
    });
  }

}
