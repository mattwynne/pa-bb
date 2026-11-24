import { type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import { FilesystemVault } from './filesystem-vault.ts';
import { LocalReceipts } from './local-receipts.ts';
import { noteRpcContract } from './icloud-note-contract.ts';
import type { ManagedDesktop } from './desktop-install.ts';
import { DesktopLinks, type DesktopConfiguration } from './desktop-links.ts';
import { VaultError } from '../core/ports.ts';
import type { DesktopStatus, MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration, DesktopLinkOperation, InventoryInput, Inventory, NoteParser, PathMove } from '../core/ports.ts';
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
  readonly desktopNoteReauthorizes = true as const;
  private filesystem?: FilesystemVault;
  private desktopRunner?: DesktopLinks;
  private configuration?: Configuration;
  private launch?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = new AbortController();
  private admission?: { identity: string; completed: Promise<void> };
  private checking?: Promise<Catalog>;
  private roots = new Map<string, Awaited<ReturnType<FilesystemVault['desktopRoot']>>>();
  private startFailed = false;
  private pauseStartup = false;
  private readonly installStop = new AbortController();

  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose, kv?: BbPluginApi['storage']['kv'],
    private parser: NoteParser = new MarkdownNotes(), private setup?: DesktopConfiguration, private managed?: ManagedDesktop) {
    if (kv) {
      this.filesystem = new FilesystemVault(this.directory.bind(this), this.directoryGrant.bind(this), new LocalReceipts(kv), diagnose);
      const binaries = setup?.binaries ?? managed?.binaries;
      if (binaries) this.desktopRunner = new DesktopLinks(binaries, diagnose, !!managed);
    }
  }

  cancelInstallation() {
    this.installStop.abort();
  }

  async stop() {
    this.cancelInstallation();
    this.stopping.abort();
    clearTimeout(this.timer);
    await this.desktopRunner?.stop();
    await this.launch;
    await this.managed?.drain();
  }

  desktopConfiguration(value: Configuration) {
    if (this.configuration?.revision === value.revision) return;
    const removed = this.configuration?.vaultIds.some(id => !value.vaultIds.includes(id));
    this.configuration = value;
    this.roots.clear();
    this.pauseStartup = false;
    this.startFailed = false;
    if (removed) {
      void this.desktopRunner?.reset().catch(() => this.diagnose('desktop_cleanup', 'unavailable'));
    }
    this.startDesktop();
  }

  desktopStatus(): DesktopStatus {
    const mode = this.managed ? 'managed' : 'manual';
    if (!this.setup || (this.setup.vaultId && this.configuration?.vaultIds.length && !this.configuration.vaultIds.includes(this.setup.vaultId))) return { mode, state: 'configuration_needed' };
    if (this.managed && this.managed.state !== 'installed' && this.managed.state !== 'pending')
      return { mode, state: this.managed.state };
    const state = this.desktopRunner?.running ? 'ready' : this.startFailed ? 'start_failed' :
      this.configuration?.vaultIds.length ? 'starting' : 'pending';
    return { mode, state };
  }

  retryDesktop() {
    this.managed?.retry();
    this.pauseStartup = false;
    this.startFailed = false;
    this.startDesktop();
  }

  private startDesktop() {
    const state = this.configuration;
    if (!this.desktopRunner || !state?.vaultIds.length || this.stopping.signal.aborted ||
        this.launch || this.managed?.failed || this.pauseStartup) return;
    if (this.setup?.vaultId && !state.vaultIds.includes(this.setup.vaultId)) return;
    clearTimeout(this.timer);
    this.launch = (async () => {
      const catalog = await this.snapshot();
      const available = (id: string) => catalog.compatible && catalog.filesystem?.[id] === 'ready' &&
        catalog.sources.some(source => source.id === id && source.local.available);
      const active = this.desktopRunner?.activeVaultId;
      const id = this.setup?.vaultId ?? (active && state.vaultIds.includes(active) && available(active) ? active : state.vaultIds.find(available));
      if (!id || !available(id)) throw new VaultError('source_unavailable');
      await this.admitConfiguration(state);
      await this.desktop(id, state.revision, { kind: 'start' }, this.stopping.signal);
    })().catch(error => {
      if (this.configuration?.revision === state.revision) {
        this.startFailed = true;
        // A host launch failure needs operator action. Continue observing transient source availability.
        if (error instanceof VaultError && ['unavailable', 'desktop_timeout', 'desktop_restricted', 'desktop_reply', 'unsupported', 'invalid_path'].includes(error.category))
          this.pauseStartup = true;
      }
      if (!this.stopping.signal.aborted && !(error instanceof VaultError && error.diagnosticReported))
        this.diagnose('desktop_start', error instanceof VaultError ? error.category : 'unavailable');
    }).finally(() => {
      this.launch = undefined;
      if (this.stopping.signal.aborted || this.managed?.failed) return;
      if (this.configuration?.revision !== state.revision) { this.startDesktop(); return; }
      if (this.pauseStartup) return;
      this.timer = setTimeout(() => this.startDesktop(), this.desktopRunner?.running ? 30_000 : 5_000);
      this.timer.unref();
    });
  }

  private async desktopAccess(vaultId: string, revision: number, signal?: AbortSignal) {
    const filesystem = this.filesystem, runner = this.desktopRunner;
    if (!filesystem || !runner || !this.setup || (this.setup.vaultId && this.setup.vaultId !== vaultId)) throw new VaultError('desktop_setup',
      'Configure Obsidian Desktop and select this connected vault.');
    const lifetime = AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])]);
    let request = AbortSignal.any([lifetime, AbortSignal.timeout(40_000)]);
    const check = () => {
      if (request.aborted) throw new VaultError('cancelled');
      if (this.configuration?.revision !== revision || !this.configuration.vaultIds.includes(vaultId)) throw new VaultError('not_connected');
    };
    check();
    const root = this.roots.get(vaultId) ?? await filesystem.desktopRoot(vaultId, revision, this.setup.root, request);
    check();
    this.roots.set(vaultId, root);
    if (this.managed && this.managed.state !== 'installed') {
      await this.managed.ensure(this.installStop.signal, lifetime);
      request = AbortSignal.any([lifetime, AbortSignal.timeout(40_000)]);
      check();
    }
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
          this.roots.delete(vaultId);
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
    if (folders?.length === 0) {
      await run({ kind: 'start' });
      return { notes: [], folders: [], incomplete: false };
    }
    const criteria = JSON.stringify({ prefix, folders, metadataFolders, metadataDepth: input.metadataDepth, fields: input.fields, tags: input.tags ?? false });
    const output = await run({ kind: 'eval', code: String.raw`(async () => {
      const { prefix, folders, metadataFolders, metadataDepth, fields, tags } = ${criteria};
      const within = (p, r) => !r || p === r || p.startsWith(r + "/");
      const visible = () => app.vault.getAllLoadedFiles().filter(file =>
        (file.extension === "md" || Array.isArray(file.children)) && within(file.path, prefix) &&
        (!folders || folders.some(folder => within(file.path, folder))));
      const scopes = metadataFolders ?? [prefix];
      const selected = path => scopes.some(folder => within(path, folder) &&
        (metadataDepth === undefined || path === folder || path.slice(folder ? folder.length + 1 : 0).split("/").length <= metadataDepth));
      const files = visible();
      const signature = files.map(file => file.path).sort().join("\n");
      let incomplete = files.length > 10000;
      const notes = [], directories = [];
      const unknown = [], parents = new Map();
      for (const file of files.slice(0, 10000)) {
        const {path} = file;
        if (path === "/") continue;
        const includeMetadata = selected(path);
        if (includeMetadata && (fields.length || metadataFolders)) {
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          let children = parents.get(parent);
          if (!children) parents.set(parent, children = new Set());
          children.add(path);
        }
        if (Array.isArray(file.children)) {
          directories.push(path);
          if ((fields.length || metadataFolders) && selected(path + "/note.md") && !parents.has(path)) parents.set(path, new Set());
        } else {
          const cache = includeMetadata ? app.metadataCache.getFileCache(file) : null;
          const fm = cache?.frontmatter;
          const properties = Object.fromEntries(fields.filter(key => fm && Object.hasOwn(fm, key)).map(key => [key, fm[key]]));
          const row = { path, properties, malformed: false };
          if (tags) {
            row.tags = [...(cache?.tags ?? []).map(t => t.tag), ...(Array.isArray(fm?.tags) ? fm.tags : typeof fm?.tags === "string" ? [fm.tags] : [])].filter(t => typeof t === "string");
          }
          if (includeMetadata && !fm && fields.length) unknown.push([file, row]);
          notes.push(row);
        }
      }
      // Directory listings verify visible endpoint names in one call per
      // relevant parent. They also expose a name added ahead of Desktop's watcher.
      const missing = new Set();
      const groups = [...parents];
      for (let i = 0; i < groups.length; i += 32) {
        await Promise.all(groups.slice(i, i + 32).map(async ([parent, expected]) => {
          try {
            const listing = await app.vault.adapter.list(parent);
            const actual = new Set([...listing.folders, ...listing.files.filter(path => path.endsWith(".md"))]
              .filter(path => within(path, prefix) && selected(path) && (!folders || folders.some(folder => within(path, folder))) &&
                !path.split("/").some(part => part.startsWith("."))));
            for (const path of expected) if (!actual.has(path)) missing.add(path);
            for (const path of actual) if (!expected.has(path)) incomplete = true;
          } catch {
            for (const path of expected) missing.add(path);
          }
        }));
      }
      // Desktop represents invalid YAML and absent properties the same way.
      // Verify only the selected notes with missing cached frontmatter.
      for (let i = 0; i < unknown.length; i += 64) {
        await Promise.all(unknown.slice(i, i + 64).map(async ([file, row]) => {
          if (missing.has(row.path)) return;
          try {
            const text = await app.vault.cachedRead(file);
            if (/^(?:\uFEFF)?---(?:\r?\n|$)/.test(text)) {
              const closing = /^---[ \t]*\r?$/m.exec(text.slice(text.indexOf("\n") + 1));
              if (!closing || closing.index > 32768) row.malformed = true;
              else row.frontmatter = text.slice(0, text.indexOf("\n") + 1 + closing.index + closing[0].length);
            }
          } catch { row.malformed = true; incomplete = true; }
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

  desktopSnapshot(signal?: AbortSignal) {
    return this.checkCatalog(signal, true);
  }

  private async checkCatalog(signal?: AbortSignal, direct = false): Promise<Catalog> {
    try {
      if (!direct) {
        const plugins = await this.sdk.plugins.list();
        if (signal?.aborted) throw new VaultError('cancelled');
        const plugin = plugins.plugins.find(p => p.id === 'icloud');
        if (!plugin?.enabled || plugin.status !== 'running') {
          if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
          if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
          return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
        }
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
  private configurationKey(value: Configuration) {
    return JSON.stringify([value.revision, [...value.vaultIds].sort()]);
  }

  private admitConfiguration(value: Configuration) {
    const identity = this.configurationKey(value);
    // iCloud persists a successful note admission revision. Its exact
    // directory grant rechecks that revision plus current local access.
    if (this.admission?.identity === identity) return this.admission.completed;
    const completed = this.request('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }, false)
      .then(result => {
        if (result.revision !== value.revision) throw new VaultError('incompatible');
      }).catch(error => {
        if (this.admission?.completed === completed) this.admission = undefined;
        throw error;
      });
    this.admission = { identity, completed };
    return completed;
  }

  async configure(value: Configuration) {
    if (this.admission?.identity === this.configurationKey(value)) return this.admission.completed;
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    return this.admitConfiguration(value);
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
