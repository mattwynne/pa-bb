import { moveFolders, projectFolders, type MoveEndpoints } from '../core/project-move.ts';
import { randomUUID } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import type { Diagnose, NoteParser, Receipt, Resolution, VaultFiles } from '../core/ports.ts';
import { digest, equivalent, identity, LocalNotes, validateNotePath, validateRelativePath } from './local-notes.ts';
import { LocalSearch } from './local-search.ts';
import { FilesystemIndex, INDEX_LIMITS, type DirectoryGrantLookup } from './filesystem-index.ts';
import { MarkdownNotes } from './markdown-notes.ts';
import { fileIdentity, LocalReceipts } from './local-receipts.ts';
import type { FileIdentity, LocalReceipt } from './local-receipts.ts';
import { validateDesktopOperation, type DesktopLinks } from './desktop-links.ts';
import { desktopRenameUncertain, type DesktopLinkOperation } from '../core/ports.ts';
import { untilAborted } from '../core/vault-index.ts';

type Target = { mirrorId: string; revision: number; path: string };
type DirectoryLookup = (mirrorId: string, revision: number, signal?: AbortSignal) => Promise<string>;
type Observed = Awaited<ReturnType<LocalNotes['observe']>>;
type Copy = Awaited<ReturnType<LocalNotes['conflictCopies']>>[number];
type Conflict = { canonical: Observed; copies: Copy[]; logical: NonNullable<Observed>; incoming: NonNullable<Observed> };
type Token = { target: Target; root: string; identity: FileIdentity; version: string; expires: number };

export class FilesystemVault {
  readonly checksLinkPlanAtWrite = true as const;
  private files = new LocalNotes();
  readonly searcher = new LocalSearch(this.files);
  private tokens = new Map<string, Token>();

  readonly index: FilesystemIndex;
  constructor(private directory: DirectoryLookup, private grant: DirectoryGrantLookup, private ledger: LocalReceipts, private diagnose: Diagnose,
    parser: NoteParser = new MarkdownNotes(), private revoked: (id: string) => void = () => {}) {
    this.index = new FilesystemIndex(this.files, grant, parser, diagnose, INDEX_LIMITS, undefined, revoked);
  }

  desktopLink(target: { mirrorId: string; revision: number }, operation: DesktopLinkOperation, desktop: DesktopLinks, signal: AbortSignal, assertSelected: () => void) {
    const run = async () => {
      try {
        validateDesktopOperation(operation);
        assertSelected();
        const { mirrorId, revision } = target;
        const destination = operation.kind === 'rename' ? operation.destination : undefined;
        if (destination) this.ledger.assertNoOverlap(await this.ledger.load(), mirrorId, [operation.path, destination]);
        const getGrant = (abort: AbortSignal) => untilAborted(this.grant(mirrorId, revision, abort), abort);
        signal.throwIfAborted();
        const grant = await getGrant(signal);
        const selected = await this.files.desktopTarget(grant, operation.path, destination);
        const relative = (path: string) => selected.prefix ? path.slice(selected.prefix.length + 1) : path;
        const native = operation.kind === 'rename'
          ? { ...operation, path: relative(operation.path), destination: relative(operation.destination) }
          : { ...operation, path: relative(operation.path) };
        const check = async (afterClose: boolean, abort: AbortSignal) => {
          const currentGrant = await getGrant(abort);
          if (grant.directory !== currentGrant.directory || grant.rootDev !== currentGrant.rootDev || grant.rootIno !== currentGrant.rootIno)
            throw new VaultError('source_unavailable');
          const current = await this.files.desktopTarget(currentGrant, operation.path, destination, afterClose);
          if (current.directory !== selected.directory || current.dev !== selected.dev || current.ino !== selected.ino ||
              current.settingsDev !== selected.settingsDev || current.settingsIno !== selected.settingsIno) throw new VaultError('source_unavailable');
        };
        const result = await desktop.run({ id: mirrorId, directory: selected.directory }, native,
          (phase, abort) => check(phase === 'after_close', abort), signal, assertSelected);
        const inMirror = (path: string) => selected.prefix ? selected.prefix + '/' + path : path;
        try { assertSelected(); }
        catch (error) { throw result.kind === 'rename' ? desktopRenameUncertain() : error; }
        if (result.kind === 'rename') return { root: selected.prefix, result: { ...result, destination: inMirror(result.destination) } };
        let bytes = 2; // JSON array delimiters.
        const sources = result.sources.map((path, index) => {
          const translated = validateNotePath(inMirror(path));
          bytes += Buffer.byteLength(JSON.stringify(translated)) + (index ? 1 : 0);
          if (bytes > 512 * 1024) throw new VaultError('output_limit');
          return translated;
        });
        const checkAccess = async () => {
          await check(true, signal);
          assertSelected();
        };
        return { root: selected.prefix, result: { ...result, sources }, checkAccess };
      } catch (error) {
        if (signal.aborted && !(error instanceof VaultError && error.category === 'uncertain')) throw new VaultError('cancelled');
        throw this.report(error);
      }
    };
    return operation.kind === 'rename' ? this.ledger.run(run, signal) : run();
  }

  private async access<T>(mirrorId: string, revision: number, action: (root: string) => Promise<T>, signal?: AbortSignal) {
    const root = await this.directory(mirrorId, revision, signal);
    try {
      if (signal?.aborted) throw new VaultError('cancelled');
      const rootIdentity = async () => {
        try { return await this.files.rootIdentity(root); }
        catch { this.revoked(mirrorId); throw new VaultError('source_unavailable'); }
      };
      const before = await rootIdentity();
      try { return await action(root); }
      finally {
        if (!identity(before, await rootIdentity())) { this.revoked(mirrorId); throw new VaultError('source_unavailable'); }
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

  checkAccess(id: string, revision: number, signal?: AbortSignal) {
    return this.access(id, revision, async () => {}, signal);
  }

  list(id: string, revision: number, signal?: AbortSignal) {
    return this.access(id, revision, async root => {
      const result = await this.files.list(root);
      if (result.incomplete) this.diagnose('filesystem', result.warnings.includes('scan_limit') ? 'capacity' : 'unavailable');
      return result;
    }, signal);
  }

  listLinkTargets(id: string, revision: number, scope: string) {
    return this.access(id, revision, root => this.files.list(root, true, scope));
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

  search(input: Parameters<VaultFiles['search']>[0], signal?: AbortSignal) {
    return this.access(input.mirrorId, input.revision, root => this.searcher.next(input, root, signal), signal);
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
        root: rootIdentity, at: new Date().toISOString() };
      let inode!: FileIdentity;
      await this.files.publish(root, path, text, current, async stage => {
        inode = fileIdentity(stage);
        await begin({ ...base, inode, outcome: 'uncertain' });
      }, async () => { await this.clearPath(root, path); await check(); }, changed);
      return { ...base, inode, outcome: 'saved_locally_pending_sync' };
    });
    return this.saveReceipt(row);
  }

  private async inspectProjectMove(root: string, input: MoveEndpoints) {
    const folders = projectFolders(input)!;
    if (await this.files.entry(root, folders.to)) throw new VaultError('conflict', 'The destination project folder already exists.');
    if (input.project === 'standalone' && await this.files.entry(root, folders.from))
      throw new VaultError('conflict', 'The project has a support folder. Prepare the move again.');
    if (await this.files.entry(root, input.destination)) throw new VaultError('conflict', 'The destination landing note already exists.');
    await this.clearPath(root, input.destination);
    await this.clearPath(root, input.path);
    if (input.project === 'paired') {
      const tree = await this.files.projectTree(root, folders.from);
      await this.files.checkProjectFolderMove(root, folders.to, tree.info);
      return tree;
    }
  }

  listProjectMove(...[input, indexed]: Parameters<NonNullable<VaultFiles['listProjectMove']>>) {
    return this.access(input.mirrorId, input.revision, async root => {
      if (input.directory) {
        const inventory = async () => {
          if (!indexed) return this.files.list(root, true, input.root, true);
          const { lease, signal } = indexed;
          await lease.checkMembership(signal, root);
          const { view } = lease;
          const scope = input.root ?? '';
          const within = (path: string) => !scope || path === scope || path.startsWith(scope + '/');
          const missing = [...lease.blockers, ...view.omissions].find(({ path }) => within(path) || !path || scope.startsWith(path + '/'));
          if (missing) {
            throw new VaultError('index_incomplete', `The vault index has incomplete coverage at ${missing.path.slice(0, 1024) || 'the mirror root'}. Inspect unsupported entries or conflict copies before preparing another move.`);
          }
          return { paths: view.notes.filter(note => within(note.path)).map(note => note.path),
            attachments: (view.attachments ?? []).filter(within).sort(), incomplete: false, warnings: [] };
        };
        if (input.afterMove) {
          if (await this.files.entry(root, input.path) || !(await this.files.entry(root, input.destination))?.isDirectory())
            throw new VaultError('conflict', 'A folder endpoint changed after the move.');
          return inventory();
        }
        const rows = await this.ledger.load();
        this.ledger.assertNoOverlap(rows.filter(row => row.operationId !== input.operationId), input.mirrorId, [input.path, input.destination]);
        const { evidence: folderEvidence } = await this.inspectFolderMove(root, input);
        return { ...await inventory(), folderEvidence };
      }
      if (!input.afterMove) await this.inspectProjectMove(root, input);
      return this.files.list(root, true, input.root);
    }, indexed?.signal);
  }

  private async inspectFolderMove(root: string, input: MoveEndpoints) {
    const folders = moveFolders(input)!;
    if (await this.files.entry(root, folders.to))
      throw new VaultError('conflict', 'The destination folder path is occupied.');
    const tree = await this.files.projectTree(root, folders.from, { destination: folders.to });
    const targetParent = await this.files.checkProjectFolderMove(root, folders.to, tree.info);
    const evidence = digest(JSON.stringify([fileIdentity(await this.files.rootIdentity(root)),
      fileIdentity(targetParent), fileIdentity(tree.info), tree.info.ctimeMs, tree.fingerprint]));
    return { folders, tree, targetParent, evidence };
  }

  private async moveFolder(input: Parameters<NonNullable<VaultFiles['move']>>[0]) {
    const { mirrorId, path, destination, operationId, expectedHash, checkLinkPlan } = input;
    if (!checkLinkPlan) throw new VaultError('unsupported', 'Folder moves require a verified link plan.');
    return this.mutate<Extract<LocalReceipt, { kind: 'move' }>>(input, async (root, check, begin, changed, rootIdentity) => {
      const { folders, tree, targetParent, evidence } = await this.inspectFolderMove(root, input);
      if (evidence !== expectedHash) throw new VaultError('conflict', 'The source tree or destination parent changed after preview.');
      const inode = fileIdentity(tree.info);
      const receipt = { kind: 'move' as const, directory: true as const, mirrorId, path, destination, operationId,
        hash: expectedHash, root: rootIdentity, inode, at: new Date().toISOString(),
        tree: { ...folders, inode, fingerprint: tree.fingerprint } };
      await begin({ ...receipt, outcome: 'uncertain' });
      await this.files.moveProjectFolder(root, path, destination, tree.info, async () => {
        const assertPlan = await checkLinkPlan();
        const fresh = await this.inspectFolderMove(root, input);
        if (fresh.evidence !== evidence) throw new VaultError('conflict', 'The source tree or destination parent changed before rename.');
        await check();
        assertPlan();
      }, changed, targetParent);
      if (await this.folderMoveLocation(root, receipt) !== 'destination') throw new VaultError('uncertain');
      return { ...receipt, outcome: 'moved_locally_pending_sync' };
    }).then(({ outcome }) => ({ outcome }));
  }

  async move(input: Parameters<NonNullable<VaultFiles['move']>>[0]) {
    if (input.directory) return this.moveFolder(input);
    const { mirrorId, path, destination, operationId, expectedHash, project } = input;
    return this.mutate<Extract<LocalReceipt, { kind: 'move' }>>(input, async (root, check, begin, changed, rootIdentity) => {
      validateNotePath(destination);
      if (destination === path) throw new VaultError('invalid_path');
      const current = await this.files.observe(root, path);
      if (!current || current.hash !== expectedHash || await this.files.observe(root, destination)) throw new VaultError('conflict');
      await this.clearPath(root, path);
      await this.clearPath(root, destination);
      const tree = project ? await this.inspectProjectMove(root, input) : undefined;
      const folders = projectFolders(input);
      const base = { kind: 'move' as const, mirrorId, path, destination, operationId, hash: expectedHash,
        inode: fileIdentity(current.info), root: rootIdentity, at: new Date().toISOString() };
      if (tree && folders) {
        const expectedNotes = input.movedNotes;
        const notes = [path, ...tree.notes.map(name => folders.from + '/' + name)];
        if (!expectedNotes || notes.length !== expectedNotes.size) throw new VaultError('conflict');
        for (const note of notes) {
          if ((await this.files.observe(root, note))?.hash !== expectedNotes.get(note)) throw new VaultError('conflict');
        }
        const receipt = { ...base, tree: { ...folders, inode: fileIdentity(tree.info), fingerprint: tree.fingerprint } };
        await begin({ ...receipt, outcome: 'uncertain' });
        const moveFolder = async () => {
          const fresh = await this.files.projectTree(root, folders.from);
          if (!identity(fresh.info, tree.info) || fresh.fingerprint !== tree.fingerprint) throw new VaultError('conflict');
          await this.files.moveProjectFolder(root, folders.from, folders.to, fresh.info, check, changed);
        };
        await this.files.move(root, path, destination, current, async () => {
          await this.clearPath(root, path);
          await this.clearPath(root, destination);
          await check();
        }, changed, moveFolder, input.checkLinkPlan);
        const state = await this.projectMoveState(root, receipt);
        if (state.outcome !== 'moved_locally_pending_sync') throw new VaultError('uncertain');
        return { ...receipt, outcome: state.outcome };
      }
      await begin({ ...base, outcome: 'uncertain' });
      await this.files.move(root, path, destination, current, async () => {
        if (project === 'standalone' && folders && (await this.files.entry(root, folders.from) || await this.files.entry(root, folders.to)))
          throw new VaultError('conflict', 'Project support changed after planning.');
        await this.clearPath(root, path);
        await this.clearPath(root, destination);
        await check();
      }, changed, undefined, input.checkLinkPlan);
      return { ...base, outcome: 'moved_locally_pending_sync' };
    }).then(({ outcome }) => ({ outcome }));
  }

  private async folderMoveLocation(root: string, row: Pick<Extract<LocalReceipt, { kind: 'move' }>, 'tree' | 'directory'>) {
    const tree = row.tree!;
    const oldFolder = await this.files.entry(root, tree.from);
    const newFolder = await this.files.entry(root, tree.to);
    const intact = async (path: string) => {
      const current = await this.files.projectTree(root, path, row.directory ? { destination: path } : undefined);
      return identity(tree.inode, current.info) && tree.fingerprint === current.fingerprint;
    };
    return !oldFolder && newFolder?.isDirectory() && await intact(tree.to) ? 'destination' :
      !newFolder && oldFolder?.isDirectory() && await intact(tree.from) ? 'source' : 'unverified';
  }

  private async projectMoveState(root: string, row: Omit<Extract<LocalReceipt, { kind: 'move' }>, 'outcome'>) {
    const folder = await this.folderMoveLocation(root, row);
    if (row.directory) return { outcome: folder === 'destination' ? 'moved_locally_pending_sync' : 'uncertain' } as const;
    const oldNote = await this.files.observe(root, row.path);
    const newNote = await this.files.observe(root, row.destination);
    const original = (note: Observed) => note && identity(row.inode, note.info) && row.hash === note.hash;
    const landing = original(oldNote) && original(newNote) ? 'both' :
      !oldNote && original(newNote) ? 'destination' : !newNote && original(oldNote) ? 'source' : 'unverified';
    const outcome = folder === 'destination' && landing === 'destination' ? 'moved_locally_pending_sync' :
      folder === 'source' && landing === 'source' ? 'uncertain' :
      folder !== 'unverified' && landing !== 'unverified' ? 'partial' : 'uncertain';
    return { outcome, components: { landing, folder } };
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
      if (row.kind === 'move' && row.tree) {
        if ((await this.projectMoveState(root, row)).outcome !== 'moved_locally_pending_sync') return row;
        await this.files.syncParent(root, row.tree.from);
        await this.files.syncParent(root, row.tree.to);
        if (!identity(row.root, await this.files.rootIdentity(root)) ||
          (await this.projectMoveState(root, row)).outcome !== 'moved_locally_pending_sync') return row;
        const result = { ...row, outcome: 'moved_locally_pending_sync' as const };
        await this.ledger.finish(result);
        return result;
      }
      const path = row.kind === 'move' ? row.destination : row.path;
      const written = await this.files.observe(root, path);
      if (!written || !identity(row.inode, written.info) || row.hash !== written.hash) return row;
      await this.files.syncParent(root, path);
      if (!equivalent(written, await this.files.observe(root, path))) return row;
      if (row.kind === 'move') {
        if (await this.files.observe(root, row.path)) return row;
        await this.files.syncParent(root, row.path);
        if (await this.files.observe(root, row.path)) return row;
      }
      if (row.kind === 'resolution' && (await this.files.conflictCopies(root, row.path)).length) return row;
      if (!identity(row.root, await this.files.rootIdentity(root))) return row;
      const result = row.kind === 'move' ? { ...row, outcome: 'moved_locally_pending_sync' as const } :
        row.kind === 'resolution' && row.choice === 'accept_incoming' ? { ...row, outcome: 'adopted_content' as const } :
        { ...row, outcome: 'saved_locally_pending_sync' as const };
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

  async moveReceipts(input: Parameters<NonNullable<VaultFiles['moveReceipts']>>[0]) {
    return this.ledger.run(async () => {
      const row = (await this.ledger.load()).find(r => r.kind === 'move' && r.mirrorId === input.mirrorId && r.operationId === input.operationId);
      if (!row) return [];
      const result = await this.reconcile(row, input.revision);
      if (result.kind !== 'move') return [];
      if (result.outcome === 'uncertain' && result.tree) {
        try {
          const root = await this.directory(result.mirrorId, input.revision);
          if (identity(result.root, await this.files.rootIdentity(root))) {
            const { outcome, components } = await this.projectMoveState(root, result);
            return [{ outcome: outcome === 'partial' ? outcome : 'uncertain', components }];
          }
        } catch { this.diagnose('filesystem', 'uncertain'); }
      }
      return [{ outcome: result.outcome }];
    });
  }
}
