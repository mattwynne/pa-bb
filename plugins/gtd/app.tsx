import React, { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useSdk, useBbNavigate, experimental_useSidebarThreads as useThreads, experimental_useSidebarThreadSplit as useSplit, experimental_ThreadActionsMenu as ThreadMenu, experimental_ThreadActionsContextMenu as ThreadContextMenu, experimental_Icon as Icon, experimental_ThreadStatusGlyph as StatusGlyph, ThreadTitle, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import { rpcContract, reference } from './contract.ts';
import type { Area, Project } from './core/model.ts';
import { enclosingArea } from './core/area-presentation.ts';
import './app.css';
const key = (source: string, id: string) => JSON.stringify([source, id]);
function changed() { window.dispatchEvent(new Event('gtd:changed')); }
function useInventory() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, set] = useState<{ projects: Project[]; areas: Area[]; source: string; revision: number; error: string; partial: boolean; directoryGap: boolean }>({ projects: [], areas: [], source: '', revision: -1, error: '', partial: false, directoryGap: false });
  const [revision, revise] = useState(0);
  useEffect(() => { const fn = () => revise(x => x + 1); window.addEventListener('gtd:changed', fn); return () => window.removeEventListener('gtd:changed', fn); }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const projects: Project[] = [], areas: Area[] = []; let partial = false, directoryGap = false, source = '', cursor: string | undefined;
      do { const p = await rpc.call('listProjects', { status: 'all', ...(cursor ? { cursor } : {}) }); if (cursor && source !== p.source.id) throw new Error('The GTD project source changed.'); projects.push(...p.projects); source = p.source.id; partial ||= p.coverage === 'partial'; directoryGap ||= p.warnings.includes('directory_enumeration_unavailable'); cursor = p.nextCursor ?? undefined; } while (cursor);
      do { const p = await rpc.call('listAreas', cursor ? { cursor } : {}); areas.push(...p.areas); partial ||= p.coverage === 'partial' || p.source.id !== source; cursor = p.nextCursor ?? undefined; } while (cursor);
      if (alive) set({ projects, areas, source, revision, error: '', partial, directoryGap });
    })().catch(() => { if (alive) set({ projects: [], areas: [], source: '', revision, error: 'GTD could not load. Check its vault settings, then refresh.', partial: false, directoryGap: false }); });
    return () => { alive = false; };
  }, [rpc, revision]);
  const loading = revision !== state.revision;
  return { ...state, loading, error: loading ? '' : state.error };
}
function useLinks(ids: string[]) {
  const sdk = useSdk();
  const [state, set] = useState<{ links: Record<string, unknown>; error: boolean; signature: string; revision: number }>({ links: {}, error: false, signature: '', revision: -1 });
  const [revision, revise] = useState(0);
  const signature = JSON.stringify(ids);
  useEffect(() => { const fn = () => revise(x => x + 1); window.addEventListener('gtd:changed', fn); return () => window.removeEventListener('gtd:changed', fn); }, []);
  useEffect(() => { let alive = true; void (async () => {
    const next: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < ids.length; i += 200) {
      const batch = await sdk.threads.experimental_listPluginMetadata({ threadIds: ids.slice(i, i + 200) });
      for (const value of batch.threads) next[value.threadId] = value.metadata.project;
    }
    if (alive) set({ links: next, error: false, signature, revision });
  })().catch(() => { if (alive) set({ links: {}, error: true, signature, revision }); }); return () => { alive = false; }; }, [sdk, signature, revision]);
  const loading = signature !== state.signature || revision !== state.revision;
  return { links: state.links, error: !loading && state.error, loading };
}
function RenameMenu({ label, disabled, onRename }: { label: string; disabled: boolean; onRename: () => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = menu.current;
    if (!open || !details) return;
    const dismissOutside = (event: PointerEvent) => {
      if (details.open && !event.composedPath().includes(details)) details.open = false;
    };
    details.ownerDocument.addEventListener('pointerdown', dismissOutside, true);
    return () => details.ownerDocument.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);
  const closeAndFocus = (details: HTMLDetailsElement) => {
    details.open = false;
    trigger.current?.focus();
  };
  return <details className="gtd-menu" ref={menu}
    onToggle={event => setOpen(event.currentTarget.open)}
    onBlur={event => {
      const details = event.currentTarget;
      if (details.open && !details.contains(event.relatedTarget)) details.open = false;
    }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus(event.currentTarget);
    }}>
    <summary className="gtd-row-action" ref={trigger} aria-label={label}><Icon name="MoreHorizontal" aria-hidden="true" /></summary>
    <button disabled={disabled} onClick={() => { if (menu.current) closeAndFocus(menu.current); onRename(); }}>Rename</button>
  </details>;
}
function Group({ title, children, actions, initialOpen = true, kind = 'section' }: { title: string; children: React.ReactNode; actions?: React.ReactNode; initialOpen?: boolean; kind?: 'section' | 'project' }) {
  const [open, setOpen] = useState(initialOpen);
  return <div className="gtd-group"><div className="gtd-group-heading"><button className={`gtd-collapse gtd-label gtd-label--${kind}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? 'ChevronDown' : 'ChevronRight'} aria-hidden="true" /> {title}</button>{actions}</div>{open && <div className="gtd-indent">{children}</div>}</div>;
}
function ThreadRow({ thread }: { thread: PluginSidebarThread }) {
  const navigate = useBbNavigate(); const split = useSplit(thread.id);
  const target = { ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null };
  return <ThreadContextMenu thread={target}><div className="gtd-thread">
    <a href={thread.href} {...split.splitProps} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate.toThread(thread.id); }}>
      <StatusGlyph indicator={thread.indicator} /><ThreadTitle threadId={thread.id} />
    </a><ThreadMenu thread={target} trigger={({ className, ...props }) => <button {...props} className={className ? `gtd-row-action ${className}` : 'gtd-row-action'} aria-label={`Actions for ${thread.displayTitle}`}><Icon name="MoreHorizontal" aria-hidden="true" /></button>} />
  </div></ThreadContextMenu>;
}
function GtdPanel() {
  const inventory = useInventory(); const rpc = useRpc<typeof rpcContract>(); const navigate = useBbNavigate(); const sidebar = useThreads();
  const threads = sidebar.threads.filter(t => !t.isHidden && !t.isArchived);
  const { links, error: linkError, loading: linksLoading } = useLinks(threads.map(t => t.id));
  const [status, setStatus] = useState('active');
  const [busy, setBusy] = useState(''); const busyRef = useRef(false); const [notice, setNotice] = useState('');
  // Retain a request ID for the life of this action, including uncertain failures.
  const requests = useRef(new Map<string, string>());
  const run = async (id: string, task: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(id); setNotice(''); try { await task(); } catch { setNotice('Change not confirmed. Inspect threads or Obsidian receipts before trying again.'); } finally { busyRef.current = false; setBusy(''); } };
  const rename = (kind: 'area' | 'project', item: Area) => {
    const title = window.prompt(`Rename ${kind}`, item.title); if (!title?.trim() || title.trim() === item.title) return;
    void run(item.id, async () => { const result = await rpc.call(kind === 'area' ? 'renameArea' : 'renameProject', { source: inventory.source, id: item.id, title: title.trim() }); setNotice(result.outcome === 'saved_locally_pending_sync' ? 'Title saved locally; cloud delivery is not verified.' : 'Save unconfirmed. Inspect Obsidian receipts before another edit.'); changed(); });
  };
  const newThread = (project: Project) => void run(project.id, async () => {
    const k = 'gtd-new:' + key(inventory.source, project.id);
    let requestId = requests.current.get(k) ?? sessionStorage.getItem(k);
    const completed = Number(sessionStorage.getItem(k + ':completed') ?? 0);
    // Reuse a fast completion during the double-click window, even across reload.
    if (completed && Date.now() - completed > 1000) { requests.current.delete(k); sessionStorage.removeItem(k); requestId = null; }
    if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(k, requestId); sessionStorage.setItem(k, requestId); sessionStorage.removeItem(k + ':completed'); }
    const result = await rpc.call('newThread', { source: inventory.source, id: project.id, requestId });
    sessionStorage.setItem(k + ':completed', String(Date.now()));
    navigate.toThread(result.threadId); changed();
  });
  const row = (t: PluginSidebarThread) => <ThreadRow key={t.id} thread={t} />;
  const visible = inventory.projects.filter(p => status === 'all' || p.status === status);
  const inArea = (area: Area) => visible.filter(p => enclosingArea(inventory.areas, p.areaId)?.id === area.id);
  const shownAreas = inventory.areas.filter(area => status === 'all' || inArea(area).length > 0);
  const unassignedProjects = visible.filter(p => !enclosingArea(inventory.areas, p.areaId));
  const projectRow = (p: Project) => <Group key={p.id} title={p.title} kind="project" actions={<>
    <button className="gtd-row-action" aria-label={`New thread for ${p.title}`} title={`Start an AI thread for ${p.title}`} disabled={!!busy || inventory.loading} onClick={() => newThread(p)}><Icon name="MessageSquarePlus" aria-hidden="true" /></button>
    <RenameMenu label={`Actions for project ${p.title}`} disabled={!!busy || (p.id.endsWith('/') && !p.notePath)} onRename={() => rename('project', p)} />
  </>}>
    {threads.filter(t => { const r = reference.safeParse(links[t.id]); return r.success && key(r.data.source, r.data.id) === key(inventory.source, p.id); }).map(row)}{!threads.some(t => { const r = reference.safeParse(links[t.id]); return r.success && key(r.data.source, r.data.id) === key(inventory.source, p.id); }) && <p className="gtd-muted">No linked threads</p>}</Group>;
  const unassigned = threads.filter(t => !reference.safeParse(links[t.id]).success);
  const missing = threads.filter(t => { const r = reference.safeParse(links[t.id]); return r.success && !inventory.projects.some(p => key(inventory.source, p.id) === key(r.data.source, r.data.id)); });
  return <section className="gtd-nav" aria-label="Personal GTD projects">
    <div className="gtd-content">
      <div className="gtd-controls">
        <label>Projects <select aria-label="Project status" value={status} onChange={e => setStatus(e.target.value)}>{['active', 'all', 'deferred', 'someday', 'done'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
        <button aria-label="Refresh GTD" disabled={inventory.loading} onClick={changed}>Refresh</button>
      </div>
      {sidebar.status === 'loading' && <p role="status">Loading BB threads…</p>}
      {sidebar.status === 'error' && <p role="alert">BB threads could not load. Reload BB to try again.</p>}
      {(inventory.loading || linksLoading) && <p role="status">Loading GTD…</p>}
      {(inventory.error || linkError) && <p role="alert">{inventory.error || 'Thread associations could not load. Refresh before making changes.'}</p>}
      {inventory.partial && <p role="status">Partial inventory. {inventory.directoryGap ? 'Obsidian cannot enumerate directories: empty or attachment-only project/Area folders may be omitted. Inventory totals are unconfirmed.' : 'Some projects or areas may be unavailable.'}</p>}
      {!inventory.error && !inventory.loading && !linksLoading && !linkError && <>
        {shownAreas.map(area => <Group key={area.id} title={area.title} initialOpen={inArea(area).length > 0} actions={<RenameMenu label={`Actions for area ${area.title}`} disabled={!!busy || area.id.endsWith('/')} onRename={() => rename('area', area)} />} >{inArea(area).map(projectRow)}</Group>)}
        {!!unassignedProjects.length && <Group title="Unassigned area">{unassignedProjects.map(projectRow)}</Group>}
        {!visible.length && <p className="gtd-muted">No matching projects</p>}
        {status !== 'all' && shownAreas.length < inventory.areas.length && <button onClick={() => setStatus('all')}>Show all Areas</button>}
        <Group title={`Unassigned threads (${unassigned.length})`} initialOpen={false}>{unassigned.map(row)}</Group>
        {!!missing.length && <Group title={`Unavailable project (${missing.length})`}><p className="gtd-muted">Missing, deleted, or from another source. Use the thread menu to reassign or unlink.</p>{missing.map(row)}</Group>}
      </>}
      {notice && <p role="status">{notice}</p>}
    </div>
  </section>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'projects', path: 'projects', title: 'Personal GTD projects', icon: 'ListTodo', component: GtdPanel });
  app.slots.experimental_threadAction({ id: 'project', title: 'GTD project', icon: 'ListTodo', group: 'organize',
    useData: ({ threadIds }) => ({ inventory: useInventory(), ...useLinks([...threadIds]), threadIds: new Set(threadIds), rpc: useRpc<typeof rpcContract>() }),
    item: ({ thread, data }) => {
      const { inventory } = data;
      const stored = data.links[thread.id];
      const association = reference.safeParse(stored).data;
      const linksLoading = data.loading || !data.threadIds.has(thread.id);
      const linkError = data.error || (stored !== undefined && !association);
      const linkKnown = !linksLoading && !linkError;
      const inventoryReady = !inventory.loading && !inventory.error;
      const projects = inventoryReady ? inventory.projects : [];
      const current = linkKnown && association?.source === inventory.source
        ? projects.find(project => project.id === association.id)
        : undefined;
      const linkStatus = linksLoading ? 'Loading thread association…'
        : linkError ? 'Thread association could not load. Refresh GTD to try again.' : '';
      const projectStatus = inventory.loading ? 'Loading GTD projects…' : inventory.error;
      const status = [linkStatus, projectStatus].filter(Boolean).join(' ')
        || (association && !current ? 'The linked GTD project is unavailable.' : '');
      const items = [
        { id: 'unlink', label: 'No GTD project', selected: linkKnown && !association, disabled: !linkKnown || !association, project: null },
        ...projects.map(project => ({
          id: `project:${project.id}`, label: project.title, selected: project === current, disabled: !linkKnown,
          project: { source: inventory.source, id: project.id },
        })),
      ];
      return {
        label: 'GTD project',
        icon: 'ListTodo',
        detail: status || current?.title || 'No GTD project',
        choices: { items, hint: status || 'Changes only the personal GTD association.' },
        run: async ({ value }) => {
          const choice = items.find(item => item.id === value);
          if (!choice || choice.disabled) throw new Error('This GTD association choice is unavailable.');
          await data.rpc.call('associate', { threadId: thread.id, project: choice.project });
          changed();
        },
      };
    },
  });
});
