import { type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import { FilesystemVault } from './filesystem-vault.ts';
import { LocalReceipts } from './local-receipts.ts';
import { noteRpcContract } from './icloud-note-contract.ts';
import { desktopConfiguration, DesktopLinks, type DesktopConfiguration } from './desktop-links.ts';
import { VaultError } from '../core/ports.ts';
import type { MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration, DesktopLinkOperation, InventoryInput, Inventory, NoteParser, PathMove } from '../core/ports.ts';
import { validateRelativePath, validateNotePath } from './local-notes.ts';
import { MarkdownNotes } from './markdown-notes.ts';

const local = z.object({ available: z.boolean(), reason: z.enum(['ownership', 'recovery_required', 'source_changed']).nullable(), pendingAgeMs: z.number().int().nonnegative().nullable(), applicationBlocker: z.enum(['application_uncertain', 'native_recovery']).nullable() }).strict();
const filesystemMode = z.enum(['ready', 'legacy_pending', 'legacy_conflict', 'unavailable']);
const absoluteDirectory = z.string().min(1).max(4096).refine(p => isAbsolute(p) && p !== '/' && normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p));
const directoryResult = noteRpcContract.mirrorDirectory.output.extend({ directory: absoluteDirectory });
const directoryGrantResult = noteRpcContract.mirrorDirectoryGrant.output.extend({ directory: absoluteDirectory,
  rootDev: noteRpcContract.mirrorDirectoryGrant.output.shape.rootDev.max(20), rootIno: noteRpcContract.mirrorDirectoryGrant.output.shape.rootIno.max(20) });
const mirror = z.object({ id: z.string(), folder: z.object({ name: z.string() }), initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), local: local.optional(), filesystem: filesystemMode.optional() });
const status = z.object({ search: z.unknown().optional(), mirrorAccessVersion: z.number().int().nullish(), noteAccessVersion: z.number().int().nullable(), available: z.boolean(), connected: z.boolean(), challenge: z.string().nullable(), mirrors: z.array(mirror) });
const unavailable = (setup: string, nextAction: string): Catalog => ({ setup, nextAction, sources: [], connected: false, compatible: false });
export class ICloud implements MirrorCatalog, VaultFiles {
  private filesystem?: FilesystemVault;
  private desktopRunner?: DesktopLinks;
  private configuration?: Configuration;
  private launch?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = new AbortController();
  private checking?: Promise<Catalog>;
  private root?: Awaited<ReturnType<FilesystemVault['desktopRoot']>>;

  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose, kv?: BbPluginApi['storage']['kv'],
    private parser: NoteParser = new MarkdownNotes(), private setup: DesktopConfiguration | undefined = desktopConfiguration()) {
    if (kv) {
      this.filesystem = new FilesystemVault(this.directory.bind(this), this.directoryGrant.bind(this), new LocalReceipts(kv), diagnose);
      if (setup) this.desktopRunner = new DesktopLinks({ desktop: setup.desktop, cli: setup.cli }, diagnose);
    }
  }

  async stop() {
    this.stopping.abort();
    clearTimeout(this.timer);
    await this.desktopRunner?.stop();
    await this.launch;
  }

  desktopConfiguration(value: Configuration) {
    if (this.configuration?.revision === value.revision) return;
    this.configuration = value;
    this.root = undefined;
    if (this.setup && !value.vaultIds.includes(this.setup.vaultId)) {
      void this.desktopRunner?.reset().catch(() => this.diagnose('desktop_cleanup', 'unavailable'));
    }
    this.startDesktop();
  }

  private startDesktop() {
    const state = this.configuration, id = this.setup?.vaultId;
    if (!id || !state?.vaultIds.includes(id) || this.stopping.signal.aborted || this.launch) return;
    clearTimeout(this.timer);
    this.launch = (async () => {
      const catalog = await this.snapshot();
      if (!catalog.compatible || catalog.filesystem?.[id] !== 'ready' ||
          !catalog.sources.some(source => source.id === id && source.local.available)) throw new VaultError('source_unavailable');
      await this.request('noteConfigure', { revision: state.revision, mirrorIds: state.vaultIds }, false, this.stopping.signal);
      await this.desktop(id, state.revision, { kind: 'start' }, this.stopping.signal);
    })().catch(error => {
      if (!this.stopping.signal.aborted && !(error instanceof VaultError && error.diagnosticReported))
        this.diagnose('desktop_start', error instanceof VaultError ? error.category : 'unavailable');
    }).finally(() => {
      this.launch = undefined;
      if (this.stopping.signal.aborted || !this.configuration?.vaultIds.includes(id)) return;
      this.timer = setTimeout(() => this.startDesktop(), this.desktopRunner?.running ? 30_000 : 5_000);
      this.timer.unref();
    });
  }

  private async desktopAccess(vaultId: string, revision: number, signal?: AbortSignal) {
    const filesystem = this.filesystem, runner = this.desktopRunner;
    if (!filesystem || !runner || this.setup?.vaultId !== vaultId) throw new VaultError('desktop_setup',
      'Configure Obsidian Desktop and select this connected vault.');
    const request = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(40_000), ...(signal ? [signal] : [])]);
    const check = () => {
      if (request.aborted) throw new VaultError('cancelled');
      if (this.configuration?.revision !== revision || !this.configuration.vaultIds.includes(vaultId)) throw new VaultError('not_connected');
    };
    check();
    const root = this.root ?? await filesystem.desktopRoot(vaultId, revision, this.setup.root, request);
    check();
    this.root = root;
    const relative = (path: string) => {
      validateRelativePath(path);
      if (root.prefix && !path.startsWith(root.prefix + '/')) throw new VaultError('invalid_path');
      return root.prefix ? path.slice(root.prefix.length + 1) : path;
    };
    const inMirror = (path: string) => validateRelativePath(root.prefix ? root.prefix + '/' + path : path);
    const run = async (operation: DesktopLinkOperation, before?: () => Promise<void>) => {
      try {
        const result = await filesystem.desktopRun(vaultId, revision, root, runner, operation, request, check, before);
        return 'value' in result ? result.value : undefined;
      } catch (error) {
        if (error instanceof VaultError && error.category === 'source_unavailable') {
          this.root = undefined;
          await runner.reset();
        }
        throw error;
      }
    };
    return { relative, inMirror, root, filesystem, run };
  }

  async desktop(vaultId: string, revision: number, operation: DesktopLinkOperation, signal?: AbortSignal) {
    const { relative, inMirror, run } = await this.desktopAccess(vaultId, revision, signal);
    switch (operation.kind) {
    case 'start': return run(operation);
    case 'backlinks': {
      const rows = z.array(z.object({ file: z.string() })).max(10000).parse(await run({ ...operation, path: relative(operation.path) }));
      return rows.map(row => validateNotePath(inMirror(row.file)));
    }
    case 'search': return z.array(z.object({ file: z.string(), matches: z.array(z.object({ line: z.number().int().positive(), text: z.string() })) }))
      .max(10001).parse(await run(operation)).map(row => ({ ...row, file: validateNotePath(inMirror(row.file)) }));
    case 'tasks': {
      const rows = z.array(z.object({ file: z.string(), line: z.coerce.number().int().positive(), text: z.string(), status: z.string().min(1).max(2) })).max(10000)
        .parse(await run(operation.path ? { ...operation, path: relative(operation.path) } : operation));
      return rows.map(row => ({ ...row, file: validateNotePath(inMirror(row.file)) }));
    }
    default: throw new VaultError('unsupported');
    }
  }

  async desktopNote(vaultId: string, revision: number, path: string, signal?: AbortSignal) {
    const { relative, run } = await this.desktopAccess(vaultId, revision, signal);
    const text = await run({ kind: 'eval', code: `(async () => {
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(relative(path))});
      return file?.extension === "md" ? JSON.stringify(await app.vault.read(file)) : null;
    })()` });
    if (text === null) throw new VaultError('missing');
    if (typeof text !== 'string') throw new VaultError('desktop_reply');
    return text;
  }

  async desktopTargets(vaultId: string, revision: number, path: string, links: string[], signal?: AbortSignal) {
    const { relative, inMirror, root, run } = await this.desktopAccess(vaultId, revision, signal);
    const query = JSON.stringify({ links, source: relative(path), prefix: root.prefix });
    const output = await run({ kind: 'eval', code: `(() => {
      const {links, source, prefix} = ${query};
      const files = app.vault.getFiles();
      const parent = p => p.includes("/") ? p.slice(0,p.lastIndexOf("/")) : "";
      const normalized = p => {
        const parts = [];
        for (const part of p.split("/")) {
          if (part === "..") {
            if (!parts.length) return null;
            parts.pop();
          } else if (part && part !== ".") parts.push(part);
        }
        return parts.join("/");
      };
      return links.map(link => {
        if (!link) return {status:"resolved",target:source};
        if (prefix && link.startsWith(prefix + "/")) link = link.slice(prefix.length+1);
        const relative = link.startsWith("./") || link.startsWith("../");
        const name = normalized(relative ? parent(source)+"/"+link : link);
        if (!name) return {status:"missing"};
        const variants = [name.toLowerCase(), name.toLowerCase()+".md"];
        const resolve = rows => rows.length === 1 ? {status:"resolved",target:rows[0].path} :
          {status:"ambiguous",candidates:rows.slice(0,20).map(f=>f.path)};
        const exact = files.filter(f=>variants.includes(f.path.toLowerCase()));
        if (exact.length) return resolve(exact);
        if (link.startsWith("/") || relative) return {status:"missing"};
        const suffix = files.filter(f=>variants.some(v=>f.path.toLowerCase().endsWith("/"+v)));
        const near = suffix.filter(f=>parent(f.path) === parent(source));
        if (near.length) return resolve(near);
        if (suffix.length > 1) return resolve(suffix);
        const target = app.metadataCache.getFirstLinkpathDest(link,source)?.path;
        return target ? {status:"resolved",target} : {status:app.metadataCache.isCacheClean()?"missing":"incomplete"};
      });
    })()` });
    return z.array(z.object({ status: z.enum(['resolved', 'ambiguous', 'missing', 'incomplete']),
      target: z.string().optional(), candidates: z.array(z.string()).max(20).optional() }))
      .length(links.length).parse(output).map(res => ({ status: res.status,
        ...(res.target ? { target: inMirror(res.target) } : {}), ...(res.candidates ? { candidates: res.candidates.map(inMirror) } : {}) }));
  }

  async vaultInventory(input: InventoryInput, revision: number, signal?: AbortSignal): Promise<Inventory> {
    const { relative, inMirror, root, run } = await this.desktopAccess(input.vaultId, revision, signal);
    const prefix = input.root === root.prefix ? '' : input.root ? relative(input.root) : '';
    const folders = input.folders?.map(folder => folder === root.prefix ? '' : relative(folder));
    const metadataFolders = input.metadataFolders?.map(folder => folder === root.prefix ? '' : relative(folder));
    const criteria = JSON.stringify({ prefix, folders, metadataFolders, fields: input.fields, tags: input.tags ?? false });
    const output = await run({ kind: 'eval', code: String.raw`(async () => {
      const { prefix, folders, metadataFolders, fields, tags } = ${criteria};
      const inside = (p, r) => !r || p === r || p.startsWith(r + "/");
      const visible = () => app.vault.getAllLoadedFiles().filter(f => inside(f.path, prefix) &&
        (!folders || folders.some(folder => inside(f.path, folder))));
      const files = visible();
      const signature = files.map(f => f.path).sort().join("\n");
      let incomplete = files.length > 10000;
      const notes = [], directories = [];
      const unknown = [], checked = [];
      for (const file of files.slice(0, 10000)) {
        const selected = !metadataFolders || metadataFolders.some(folder => inside(file.path, folder));
        if (selected && file.path !== "/" && (fields.length || metadataFolders)) checked.push(file.path);
        if (Array.isArray(file.children)) {
          if (file.path !== "/") directories.push(file.path);
        } else if (file.extension === "md") {
          const cache = selected ? app.metadataCache.getFileCache(file) : null;
          const fm = cache?.frontmatter;
          const properties = Object.fromEntries(fields.filter(k => fm && Object.hasOwn(fm, k)).map(k => [k, fm[k]]));
          const row = { path: file.path, properties, malformed: false };
          if (tags) {
            row.tags = [...(cache?.tags ?? []).map(t => t.tag), ...(Array.isArray(fm?.tags) ? fm.tags : typeof fm?.tags === "string" ? [fm.tags] : [])].filter(t => typeof t === "string");
          }
          if (selected && !fm && fields.length) unknown.push([file, row]);
          notes.push(row);
        }
      }
      // Only frontmatter missing from Desktop's metadata can need source verification.
      for (let i = 0; i < unknown.length; i += 32) {
        await Promise.all(unknown.slice(i, i + 32).map(async ([file, row]) => {
          try {
            const text = await app.vault.cachedRead(file);
            if (/^\uFEFF?---(?:\r?\n|$)|^---(?:\r?\n|$)/.test(text)) {
              const closing = /^---[ \t]*\r?$/m.exec(text.slice(text.indexOf("\n") + 1));
              if (!closing || closing.index > 32768) row.malformed = true;
              else row.frontmatter = text.slice(0, text.indexOf("\n") + 1 + closing.index + closing[0].length);
            }
          } catch { row.malformed = true; incomplete = true; }
        }));
      }
      const missing = new Set();
      for (let i = 0; i < checked.length; i += 32) {
        await Promise.all(checked.slice(i, i + 32).map(async path => {
          try { if (!await app.vault.adapter.exists(path)) missing.add(path); }
          catch { missing.add(path); }
        }));
      }
      return {
        notes: notes.filter(row => !missing.has(row.path)), folders: directories.filter(path => !missing.has(path)),
        incomplete: incomplete || missing.size > 0 || signature !== visible().map(f => f.path).sort().join("\n"),
      };
    })()` });
    const parsed = z.object({ notes: z.array(z.object({ path: z.string(), properties: z.record(z.string(), z.unknown()),
      malformed: z.boolean(), frontmatter: z.string().max(33000).optional(), tags: z.array(z.string()).max(1000).optional() })).max(10000),
      folders: z.array(z.string()).max(10000), incomplete: z.boolean() }).parse(output);
    return {
      notes: parsed.notes.map(({ path, properties, malformed, frontmatter, tags }) => ({
        path: validateNotePath(inMirror(path)), properties,
        malformed: malformed || (!!frontmatter && this.parser.frontmatter(frontmatter).warnings.length > 0),
        ...(tags ? { tags } : {}),
      })),
      folders: [...(root.prefix && !prefix ? [root.prefix] : []), ...parsed.folders.map(inMirror)],
      incomplete: parsed.incomplete,
    };
  }

  async desktopCommit(input: Parameters<VaultFiles['commit']>[0], previous: string, signal?: AbortSignal) {
    if (Buffer.byteLength(JSON.stringify(previous) + JSON.stringify(input.text)) > 100_000)
      throw new VaultError('capacity', 'Use a smaller note for a Desktop task or single-property edit.');
    const { relative, run, filesystem } = await this.desktopAccess(input.mirrorId, input.revision, signal);
    const args = JSON.stringify({ path: relative(input.path), previous, updated: input.text });
    const operation = { kind: 'write' as const, code: `(async () => {
      const {path, previous, updated} = ${args};
      const file = app.vault.getAbstractFileByPath(path);
      if (file?.extension !== "md") return false;
      const mismatch = new Error();
      try {
        await app.vault.process(file, text => {
          if (file.path !== path || text !== previous) throw mismatch;
          return updated;
        });
        if (file.path !== path) throw new Error();
        return true;
      } catch (cause) {
        if (cause === mismatch) return false;
        throw cause;
      }
    })()` };
    return filesystem.desktopCommit(input, before => run(operation, before));
  }

  async movePath(input: PathMove, revision: number, signal?: AbortSignal) {
    const { relative, run, filesystem } = await this.desktopAccess(input.vaultId, revision, signal);
    const operation = { kind: 'move' as const, path: relative(input.path), destination: relative(input.destination) };
    return filesystem.movePath(input, revision, before => run(operation, before));
  }

  async moveReceipt(vaultId: string, revision: number, operationId: string) {
    const local = await this.filesystem?.moveReceipt(vaultId, revision, operationId);
    if (local) return local;
    const legacy = await this.call('noteMoveReceipts', { mirrorId: vaultId, revision, operationId });
    const row = legacy[0];
    return row ? { vaultId, path: row.path, destination: row.destination, operationId, outcome: row.outcome } : null;
  }

  snapshot(options?: { fresh: true; signal?: AbortSignal }): Promise<Catalog> {
    if (options?.fresh) return this.checkCatalog(options.signal);
    return this.checking ??= this.checkCatalog().finally(() => { this.checking = undefined; });
  }

  private async checkCatalog(signal?: AbortSignal): Promise<Catalog> {
    try {
      const plugins = await this.sdk.plugins.list();
      if (signal?.aborted) throw new VaultError('cancelled');
      const plugin = plugins.plugins.find(p => p.id === 'icloud');
      if (!plugin || !plugin.enabled || plugin.status !== 'running') {
        if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
        if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
        return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
      }
      const state = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: status, signal });
      if (signal?.aborted) throw new VaultError('cancelled');
      const filesystem = state.mirrorAccessVersion === 3 ? Object.fromEntries(state.mirrors.map(m => [m.id, m.filesystem ?? 'unavailable'])) : undefined;
      const catalog: Catalog = { filesystem, search: { version: 1, available: !!this.desktopRunner?.running, reason: this.desktopRunner?.running ? null : 'unavailable' }, setup: 'ready', nextAction: null, connected: state.connected, compatible: state.noteAccessVersion === 2,
        sources: state.mirrors.map(m => ({ id: m.id, name: m.folder.name, initialized: m.initialized, enabled: m.enabled, cloudConnected: state.connected, phase: m.phase, lastSuccess: m.lastSuccess, failure: m.failure, local: {
          available: !!m.local?.available && filesystem?.[m.id] !== 'unavailable',
          reason: m.local?.reason ?? (!m.local || filesystem?.[m.id] === 'unavailable' ? 'source_changed' : null),
          pendingAgeMs: m.local?.pendingAgeMs ?? null,
          applicationBlocker: m.local?.applicationBlocker ?? null,
        } })) };
      if (catalog.compatible && state.mirrors.some(m => !m.local)) throw new Error('Invalid v2 local capability');
      if (!catalog.compatible) return { ...catalog, setup: 'incompatible', nextAction: 'Update iCloud and Obsidian together for compatible vault access.' };
      if (!state.available) return { ...catalog, setup: 'host_prerequisite', nextAction: 'Ask the operator to check the host requirements shown in iCloud settings.' };
      if (!state.mirrors.length) return { ...catalog, setup: 'no_folder', nextAction: 'Choose a vault folder in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'running')) return { ...catalog, setup: 'initial_sync_running', nextAction: 'Wait for initial sync to finish in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'failed')) return { ...catalog, setup: 'initial_sync_failed', nextAction: 'Inspect the initial-sync failure in iCloud settings.' };
      if (!state.mirrors.some(m => m.initialized)) return { ...catalog, setup: 'sync_disabled', nextAction: 'Enable sync for the selected folder and finish initial sync.' };
      if (state.challenge) return { ...catalog, setup: 'apple_verification', nextAction: 'Finish Apple verification in iCloud settings; sound local notes remain accessible.' };
      if (!state.connected) return { ...catalog, setup: 'apple_disconnected', nextAction: 'Apple is disconnected; sound local notes remain accessible but cloud delivery is stopped.' };
      return catalog;
    } catch {
      if (!signal?.aborted) this.diagnose('catalog', 'unavailable');
      return unavailable('check_failed', 'Could not check iCloud. Keep your settings and choose Check again.');
    }
  }
  private async call<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain = false): Promise<any> {
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    // Configuration must remain removable and historical receipts inspectable
    // even when a source is blocked. Content access obeys current local safety.
    const mirrorId = (input as { mirrorId?: string }).mirrorId;
    if (mirrorId && method !== 'noteReceipts' && method !== 'noteMoveReceipts' && !catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    return this.request(method, input, uncertain);
  }
  private async directory(mirrorId: string, revision: number, signal?: AbortSignal): Promise<string> {
    try {
      const value = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'mirrorDirectory',
        input: { mirrorId, revision }, outputSchema: directoryResult, signal });
      return value.directory;
    } catch {
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('rpc', 'source_unavailable');
      throw new VaultError('source_unavailable', 'iCloud could not authorize direct local access. Check the mirror in iCloud settings.', true);
    }
  }

  private async directoryGrant(mirrorId: string, revision: number, signal?: AbortSignal) {
    try {
      return await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'mirrorDirectoryGrant',
        input: { mirrorId, revision }, outputSchema: directoryGrantResult, signal });
    } catch {
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('rpc', 'source_unavailable');
      throw new VaultError('source_unavailable', 'iCloud could not grant the local root identity. Check compatible plugin versions and local source access.', true);
    }
  }

  private async route<T>(mirrorId: string, local: (filesystem: FilesystemVault) => Promise<T>, legacy: () => Promise<T>) {
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    if (!catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    if (catalog.filesystem?.[mirrorId] !== 'ready') return legacy();
    if (!this.filesystem) throw new VaultError('source_unavailable');
    return local(this.filesystem);
  }

  private async request<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain: boolean, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new VaultError('cancelled');
    const contract = noteRpcContract[method];
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method, input: { version: 2, ...(input as object) }, outputSchema: contract.output as z.ZodType<any>, signal });
      if (!result.ok) {
        this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true);
      }
      return result.value;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('rpc', uncertain ? 'uncertain' : 'unavailable');
      throw new VaultError(uncertain ? 'uncertain' : 'unavailable', uncertain ? 'The mutation reply was lost. Inspect its scoped operation receipt; do not repeat the change.' : 'Check iCloud is updated and running, then choose Check again.', true);
    }
  }
  async configure(value: Configuration) {
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    await this.request('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }, false);
  }
  vaultRoots(mirrorId: string, revision: number) {
    return this.route(mirrorId, files => files.vaultRoots(mirrorId, revision), () => this.request('noteVaultRoots', { mirrorId, revision }, false));
  }
  children(mirrorId: string, revision: number, folder: string) {
    return this.route(mirrorId, files => files.children(mirrorId, revision, folder), () => this.request('noteChildren', { mirrorId, revision, folder }, false));
  }
  read(mirrorId: string, revision: number, path: string) {
    return this.route(mirrorId, files => files.read(mirrorId, revision, path), () => this.request('noteRead', { mirrorId, revision, path }, false));
  }
  readIncoming(mirrorId: string, revision: number, path: string, token: string) {
    return this.route(mirrorId, files => files.readIncoming(mirrorId, revision, path, token),
      () => this.request('noteRead', { mirrorId, revision, path, selector: { version: 'incoming', token } }, false));
  }
  inspect(mirrorId: string, revision: number, path: string) {
    return this.route(mirrorId, files => files.inspect(mirrorId, revision, path), () => this.request('noteInspectConflict', { mirrorId, revision, path }, false));
  }
  commit(input: Parameters<VaultFiles['commit']>[0]) {
    return this.route(input.mirrorId, files => files.commit(input), () => this.request('noteCommit', input, true));
  }
  resolve(input: Parameters<VaultFiles['resolve']>[0]) {
    return this.route(input.mirrorId, files => files.resolve(input), () => this.request('noteResolveConflict', input, true));
  }
  async receipts(input: Parameters<VaultFiles['receipts']>[0]): ReturnType<VaultFiles['receipts']> {
    const local = await this.filesystem?.receipts(input);
    if (input.operationId && local?.known) return local.receipts;
    const legacy: Awaited<ReturnType<VaultFiles['receipts']>> = await this.call('noteReceipts', input);
    return [...(local?.receipts ?? []), ...legacy].sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit);
  }
}
