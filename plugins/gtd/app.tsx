import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { definePluginApp, useRpc, useSdk, useBbNavigate, useRealtimeConnectionState, experimental_useSidebarThreads as useThreads, experimental_useSidebarThreadSplit as useSplit, experimental_ThreadActionsMenu as ThreadMenu, experimental_ThreadActionsContextMenu as ThreadContextMenu, experimental_Icon as Icon, experimental_ThreadStatusGlyph as StatusGlyph, experimental_THREAD_CONTEXT_SEGMENT_GROUPS, ThreadTitle, type ExperimentalThreadContextSegmentInput, type PluginNavPanelProps, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import { rpcContract, reference, projectName } from './contract.ts';
import type { Area, Project } from './core/model.ts';
import { enclosingArea } from './core/area-presentation.ts';
import { areasIndex, panelHref, readRoute, recordDestination, unassignedArea, type Destination, type PanelPath } from './app-routes.ts';
import { ProjectCorrespondence } from './project-correspondence.tsx';
import { ProjectNextAction } from './project-next-action.tsx';
import { useAreaMailStatus } from './area-mail-status.ts';
import { AreaStandard } from './area-standard.tsx';
import { AreaActions } from './area-actions.tsx';
import { FoldableSection } from './foldable-section.tsx';
import './app.css';
const key = (source: string, id: string) => JSON.stringify([source, id]);
let inventoryRevision = 0;
function refreshInventory(fresh = false) {
  ++inventoryRevision;
  window.dispatchEvent(new CustomEvent('gtd:inventory', { detail: fresh }));
}

type InventoryState = { projects: Project[]; areas: Area[]; source: string; revision: number; error: string; projectsPartial: boolean; areasPartial: boolean; malformedFrontmatter: string[] };
const emptyInventory: InventoryState = { projects: [], areas: [], source: '', revision: -1, error: '', projectsPartial: false, areasPartial: false, malformedFrontmatter: [] };
type InventoryRpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type InventoryResponse = Awaited<ReturnType<typeof browseInventory>>;
type Pending<T> = { promise: Promise<T>; users: number };
function subscribe<T>(pending: Map<string, Pending<T>>, key: string, load: () => Promise<T>) {
  let entry = pending.get(key);
  if (!entry) {
    entry = { promise: load(), users: 0 };
    pending.set(key, entry);
  }
  const current = entry;
  const clear = () => { if (pending.get(key) === current) pending.delete(key); };
  if (current.users++ === 0) void current.promise.then(clear, clear);
  return { promise: current.promise, release: () => { if (--current.users === 0) clear(); } };
}
const pendingInventory = new Map<string, Pending<InventoryResponse>>();
async function browseInventory(rpc: InventoryRpc, includeAreas: boolean, fresh: boolean) {
  return rpc.call('browseInventory', { includeAreas, ...(fresh ? { fresh } : {}) });
}

function useInventory(includeAreas: boolean, enabled = true) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const [state, set] = useState(emptyInventory);
  const [{ revision, fresh }, revise] = useState(() => ({ revision: inventoryRevision, fresh: false }));
  useEffect(() => {
    const fn = (event: Event) => revise({ revision: inventoryRevision, fresh: (event as CustomEvent<boolean>).detail });
    window.addEventListener('gtd:inventory', fn);
    return () => window.removeEventListener('gtd:inventory', fn);
  }, []);
  useEffect(() => {
    if (!enabled) { set(emptyInventory); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: (() => void) | undefined;
    const load = () => {
      const panelKey = `${revision}:panel`;
      const requestKey = includeAreas || pendingInventory.has(panelKey) ? panelKey : `${revision}:projects`;
      const { promise, release: unsubscribe } = subscribe(pendingInventory, requestKey, () => browseInventory(client.current, includeAreas, includeAreas && fresh));
      release = unsubscribe;
      void promise.then(({ projects, areas }) => {
        if (alive) set({
          projects: projects.projects, areas: includeAreas ? areas?.areas ?? [] : [], source: projects.source.id, revision, error: '',
          projectsPartial: !projects.complete, areasPartial: includeAreas && !areas?.complete,
          malformedFrontmatter: [...new Set([...(projects.malformedFrontmatter ?? []), ...(includeAreas ? areas?.malformedFrontmatter ?? [] : [])])],
        });
      }, () => {
        if (alive) set(previous => ({
          ...previous, revision, error: previous.source ? 'GTD could not refresh. Showing the last loaded inventory.'
            : 'GTD could not load. Check its vault settings and try again.',
        }));
      });
    };
    if (includeAreas) load();
    // Give a sidebar mounting in the same render a chance to provide the
    // projects. Other thread surfaces only request projects.
    else timer = setTimeout(load, 0);
    return () => { alive = false; release?.(); if (timer !== undefined) clearTimeout(timer); };
  }, [enabled, includeAreas, revision, fresh]);
  const fetching = enabled && revision !== state.revision;
  return { ...(enabled ? state : emptyInventory), fetching, loading: !enabled || (fetching && !state.source && !state.error) };
}

function useAutomaticInventoryRefresh(busy: boolean, fetching: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const client = useRef(rpc);
  client.current = rpc;
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false);
  const reconcileThreadLinks = useRef(false);
  const [queued, queue] = useState(false);
  const [watchError, setWatchError] = useState(false);
  const retryWatch = useRef<() => void>(undefined);

  useEffect(() => {
    if (!queued || busy || fetching) return;
    const timer = setTimeout(() => {
      queue(false);
      refreshInventory(true);
      if (reconcileThreadLinks.current) {
        reconcileThreadLinks.current = false;
        linksChanged();
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [queued, busy, fetching]);

  useEffect(() => {
    if (connection !== 'connected') return;
    if (connectedBefore.current) {
      reconcileThreadLinks.current = true;
      queue(true);
    }
    connectedBefore.current = true;
  }, [connection]);

  useEffect(() => {
    let disposed = false, checking = false, failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: string | undefined;
    const check = async () => {
      if (disposed || checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const revision = await client.current.call('inventoryRevision', null);
        if (!disposed && revision !== null) {
          if (failed || revision !== previous) queue(true);
          previous = revision;
          failed = false;
          setWatchError(false);
        }
      } catch {
        if (!disposed) {
          failed = true;
          setWatchError(true);
        }
      } finally {
        checking = false;
        if (!disposed) timer = setTimeout(check, failed ? 10000 : 2000);
      }
    };
    const reconcile = () => {
      if (document.visibilityState === 'hidden') return;
      reconcileThreadLinks.current = true;
      queue(true);
      probe();
    };
    const probe = () => {
      clearTimeout(timer);
      void check();
    };
    retryWatch.current = probe;
    window.addEventListener('focus', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    void check();
    return () => {
      disposed = true;
      retryWatch.current = undefined;
      clearTimeout(timer);
      window.removeEventListener('focus', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
    };
  }, []);
  return { watchError, retryWatch };
}

let linkRevision = 0;
function linksChanged() {
  ++linkRevision;
  window.dispatchEvent(new Event('gtd:changed'));
}
type ThreadLinks = { project?: unknown; area?: unknown };
const pendingLinks = new Map<string, Pending<Record<string, ThreadLinks>>>();
function useLinks(ids: Iterable<string>) {
  const sdk = useSdk();
  const client = useRef(sdk);
  client.current = sdk;
  const [state, set] = useState<{ links: Record<string, ThreadLinks>; error: boolean; signature: string; revision: number }>({ links: {}, error: false, signature: '', revision: -1 });
  const [revision, revise] = useState(() => linkRevision);
  const signature = JSON.stringify([...new Set(ids)].sort());
  useEffect(() => { const fn = () => revise(linkRevision); window.addEventListener('gtd:changed', fn); return () => window.removeEventListener('gtd:changed', fn); }, []);
  useEffect(() => {
    let alive = true;
    const key = JSON.stringify([signature, revision]);
    const { promise, release } = subscribe(pendingLinks, key, async () => {
      const roster: string[] = JSON.parse(signature);
      const sdk = client.current;
      const links: Record<string, ThreadLinks> = Object.create(null);
      for (let i = 0; i < roster.length; i += 200) {
        const batch = await sdk.threads.experimental_listPluginMetadata({ threadIds: roster.slice(i, i + 200) });
        for (const value of batch.threads) links[value.threadId] = { project: value.metadata.project, area: value.metadata.area };
      }
      return links;
    });
    void promise.then(
      links => { if (alive) set({ links, error: false, signature, revision }); },
      () => { if (alive) set({ links: {}, error: true, signature, revision }); },
    );
    return () => { alive = false; release(); };
  }, [signature, revision]);
  const loading = signature !== state.signature || revision !== state.revision;
  return { links: state.links, error: !loading && state.error, loading,
    hasCurrentRoster: signature === state.signature && !state.error };
}
function useDisclosure() {
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
  const detailsProps: React.ComponentPropsWithRef<'details'> = { ref: menu,
    onToggle: event => setOpen(event.currentTarget.open),
    onBlur: event => {
      const details = event.currentTarget;
      // A tap can blur the summary without moving focus to the tapped control.
      // Pointer events handle clicks and taps outside the disclosure.
      if (details.open && event.relatedTarget && !details.contains(event.relatedTarget)) details.open = false;
    },
    onKeyDown: event => {
      if (event.key !== 'Escape' || !event.currentTarget.open) return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus(event.currentTarget);
    },
  };
  return { detailsProps, trigger, close: () => { if (menu.current) closeAndFocus(menu.current); } };
}
function RowActions({ project, source, disabled, actions }: {
  project: Project; source: string; disabled: boolean;
  actions: { label: string; run: (trigger: HTMLElement) => void }[];
}) {
  const { detailsProps, trigger, close } = useDisclosure();
  return <details className="gtd-menu" {...detailsProps}>
    <summary className="gtd-row-action" ref={trigger} data-gtd-project-action={key(source, project.id)} aria-label={`Actions for project ${project.title}`}><Icon name="MoreHorizontal" aria-hidden="true" /></summary>
    <div className="gtd-menu-items">
      {actions.map(action =>
        <button key={action.label} disabled={disabled} onClick={() => {
          if (!trigger.current) return;
          close();
          action.run(trigger.current);
        }}>{action.label}</button>)}
    </div>
  </details>;
}
function CreateProjectDialog({ area, source, onClose }: {
  area: Area; source: string; onClose: (created: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const headingId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const name = projectName.safeParse(draft);
  useLayoutEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  const close = (created = false) => {
    if (saving.current) return;
    dialog.current?.close();
    onClose(created);
  };
  const submit = async () => {
    if (!name.success || saving.current || unconfirmed) return;
    const operationId = crypto.randomUUID();
    saving.current = true;
    setPending(true);
    setError('');
    const result = await rpc.call('createProject', { source, id: area.id, name: name.data, operationId })
      .catch(() => ({ state: 'uncertain' } as const));
    saving.current = false;
    setPending(false);
    if (result.state === 'created') {
      close(true);
    } else if (result.state === 'uncertain') {
      setUnconfirmed(true);
      setError(`Obsidian could not confirm the save. Check the project list and the Obsidian receipt before trying again. Operation ID ${operationId}.`);
    } else {
      setError(result.state === 'exists' ? 'This name is already in use in Projects. Choose a different name.'
        : 'The project could not be saved. Check the Area and vault status, then try again.');
      input.current?.focus();
    }
  };
  return <dialog ref={dialog} className="gtd-project-dialog" aria-labelledby={headingId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id={headingId}>Add project</h2>
      <p id={descriptionId} className="gtd-create-description">Create an active project in {area.title}.</p>
      <label>Project name
        <input ref={input} value={draft} maxLength={240} readOnly={pending || unconfirmed}
          onChange={event => { setDraft(event.target.value); setError(''); }} enterKeyHint="done" />
      </label>
      {draft.trim() && !name.success && <p className="gtd-create-description">Use a valid Obsidian filename.</p>}
      {error && <p className="gtd-create-description" role="alert">{error}</p>}
      {pending && <p className="gtd-create-description" role="status">Saving in Obsidian…</p>}
      <div className="gtd-edit-actions">
        <button type="button" disabled={pending} onClick={() => close()}>{unconfirmed ? 'Close' : 'Cancel'}</button>
        {!unconfirmed && <button type="submit" disabled={!name.success || pending}>Create project</button>}
      </div>
    </form>
  </dialog>;
}
function ProjectActionDialog({ action, project, areas, onClose }: {
  action: 'done' | 'area'; project: Project; areas: Area[]; onClose: (areaPath?: string) => void;
}) {
  const headingId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [area, selectArea] = useState('');
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  const close = (value?: string) => { dialog.current?.close(); onClose(value); };
  const title = action === 'area' ? 'Move to Area' : project.status === 'done' ? 'Archive linked threads' : 'Mark as done';
  return <dialog ref={dialog} className="gtd-project-dialog" aria-labelledby={headingId}
    onCancel={event => { event.preventDefault(); close(); }}
    onKeyDown={event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <form onSubmit={event => { event.preventDefault(); close(action === 'area' ? area : ''); }}>
      <h2 id={headingId}>{title}</h2>
      {action === 'area' ? <label>Area
        <select value={area} onChange={event => selectArea(event.target.value)}>
          <option value="">Choose an Area</option>
          {areas.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label> : <p>{project.status === 'done'
        ? `Archive all BB threads linked to “${project.title}”.`
        : `Move “${project.title}” to Done and archive all its linked BB threads.`}</p>}
      <div className="gtd-edit-actions">
        <button type="button" onClick={() => close()} autoFocus>Cancel</button>
        <button type="submit" disabled={action === 'area' && !area}>{action === 'area' ? 'Move' : title}</button>
      </div>
    </form>
  </dialog>;
}
function PanelLink({ destination, onClick, ...props }: React.ComponentPropsWithoutRef<'a'> & { destination: Destination }) {
  const navigate = useBbNavigate();
  return <a {...props} href={panelHref(destination)} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (props['aria-current'] !== 'page') navigate.toPluginPanel(destination.panel, { subPath: destination.subPath });
  }} />;
}

function useComposerProject({ threadId }: ExperimentalThreadContextSegmentInput) {
  const { threads } = useThreads();
  const topLevel = threads.find(thread => thread.id === threadId)?.parentThreadId === null;
  const { links, hasCurrentRoster } = useLinks(topLevel ? [threadId] : []);
  return topLevel && hasCurrentRoster ? reference.safeParse(links[threadId]?.project).data : undefined;
}

function ComposerProjectSummary(input: ExperimentalThreadContextSegmentInput) {
  const project = useComposerProject(input);
  if (!project) return null;
  const title = project.id.split('/').at(-1)?.replace(/\.md$/, '') || project.id;
  const label = `GTD Project ${title}`;
  return <PanelLink className="gtd-composer-project" destination={recordDestination('projects', project.source, project.id)}
    aria-label={label} title={label}>
    <Icon name="ListTodo" aria-hidden="true" />
    <span>GTD Project <span className="gtd-composer-project-title">{title}</span></span>
  </PanelLink>;
}

function ThreadRow({ thread, showArchived }: { thread: PluginSidebarThread; showArchived?: boolean }) {
  const navigate = useBbNavigate(); const split = useSplit(thread.id);
  const target = { ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null };
  return <ThreadContextMenu thread={target}><div className="gtd-thread">
    <a href={thread.href} {...split.splitProps} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate.toThread(thread.id); }}>
      <StatusGlyph indicator={thread.indicator} /><ThreadTitle threadId={thread.id} />
    </a>
    {showArchived && thread.isArchived && <span className="gtd-row-status">Archived</span>}
    <ThreadMenu thread={target} trigger={({ className, ...props }) => <button {...props} className={className ? `gtd-row-action ${className}` : 'gtd-row-action'} aria-label={`Actions for ${thread.displayTitle}`}><Icon name="MoreHorizontal" aria-hidden="true" /></button>} />
  </div></ThreadContextMenu>;
}

const projectStatuses = { active: 'Active', someday: 'Someday', done: 'Done', all: 'All' } as const;
type ProjectFilter = keyof typeof projectStatuses;
// Keep the filter when BB unmounts the Areas panel to show a project or thread.
let lastProjectFilter: ProjectFilter = 'active';
const threadStatuses = ['active', 'archived'] as const;
type ThreadFilter = typeof threadStatuses[number];
const linkedThreadFilters = new Map<string, ThreadFilter[]>();

function FilterControls({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  const { detailsProps, trigger } = useDisclosure();
  return <div className="gtd-list-actions">
    <details className="gtd-menu gtd-filter" {...detailsProps}>
      <summary ref={trigger} aria-label={`Filter by ${label.toLowerCase()}`}><Icon name="SlidersHorizontal" aria-hidden="true" />Filter</summary>
      <div className="gtd-menu-items" role="group" aria-label={label}>{children}</div>
    </details>
    {action}
  </div>;
}

function FilterOption({ type, name, label, checked, disabled, onChange }: {
  type: 'radio' | 'checkbox'; name?: string; label: string; checked: boolean; disabled?: boolean; onChange: () => void;
}) {
  return <label title={disabled ? 'Keep at least one filter selected' : undefined}>
    <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
    {label}{checked && <Icon name="Check" aria-hidden="true" />}
  </label>;
}

function ThreadList({ threads, showArchived }: { threads: PluginSidebarThread[]; showArchived?: boolean }) {
  return <ul className="gtd-rows">{threads.map(thread => <li key={thread.id}><ThreadRow thread={thread} showArchived={showArchived} /></li>)}</ul>;
}

function useThreadRoster(filters?: ThreadFilter[]) {
  const sidebar = useThreads(filters && { experimental_lifecycles: filters });
  const threads = sidebar.threads.filter(thread => !thread.isHidden && (filters?.includes(thread.isArchived ? 'archived' : 'active') ?? !thread.isArchived));
  return { sidebar, threads, ...useLinks(threads.map(thread => thread.id)) };
}

function ThreadReadStatus({ loading, error, metadataError }: { loading: boolean; error: boolean; metadataError: boolean }) {
  return <>
    {loading && <p role="status">Loading linked threads…</p>}
    {error && <div className="gtd-read-error">
      <p role="alert">{metadataError ? 'Linked threads could not load.' : 'Linked threads could not load. Reload BB to try again.'}</p>
      {metadataError && <button type="button" onClick={event => {
        event.currentTarget.closest('.gtd-nav')?.querySelector('h1')?.focus({ preventScroll: true });
        linksChanged();
      }}>Retry linked threads</button>}
    </div>}
  </>;
}

function LinkedThreads({ kind, id, source, action }: {
  kind: 'area' | 'project'; id: string; source: string; action?: React.ReactNode;
}) {
  const identity = key(source, id);
  const [selected, setSelected] = useState<ThreadFilter[]>(() => linkedThreadFilters.get(identity) ?? ['active']);
  const { sidebar, threads, links, loading, error, hasCurrentRoster } = useThreadRoster(selected);
  const archived = sidebar.experimental_archived;
  const matching = !hasCurrentRoster ? [] : threads.filter(thread => {
    const project = links[thread.id]?.project;
    // A project association takes precedence over a direct Area association.
    const stored = kind === 'project' ? project : project === undefined ? links[thread.id]?.area : undefined;
    const ref = reference.safeParse(stored).data;
    return ref?.source === source && ref.id === id;
  }).sort((left, right) => Number(left.isArchived) - Number(right.isArchived));
  const pending = sidebar.status === 'loading' || archived?.status === 'loading' || loading;
  const failed = sidebar.status === 'error' || archived?.status === 'error' || error;
  const toggle = (status: ThreadFilter) => {
    const next = selected.includes(status) ? selected.filter(value => value !== status) : [...selected, status];
    if (next.length) {
      linkedThreadFilters.set(identity, next);
      setSelected(next);
    }
  };
  const tools = <FilterControls label="Thread status" action={action}>
    {threadStatuses.map(status => <FilterOption key={status} type="checkbox" label={status === 'active' ? 'Active' : 'Archived'}
      checked={selected.includes(status)} disabled={selected.length === 1 && selected.includes(status)} onChange={() => toggle(status)} />)}
  </FilterControls>;
  return <FoldableSection title={kind === 'area' ? 'Area threads' : 'Linked threads'} className="gtd-linked" tools={tools}>
    <ThreadReadStatus loading={pending} error={failed} metadataError={error} />
    {!!matching.length && <ThreadList threads={matching} showArchived={selected.length > 1} />}
    {!matching.length && !pending && !failed && <p className="gtd-empty gtd-thread-empty" role="status">
      <Icon name="MessageSquare" aria-hidden="true" />
      {archived?.hasNextPage ? 'No threads in the loaded pages.' : 'No threads'}
    </p>}
    {archived?.hasNextPage && <>
      {archived.isFetchNextPageError && <p role="alert">More archived threads could not load.</p>}
      <button className="gtd-load-more" type="button" disabled={archived.isFetchingNextPage}
        onClick={() => { void archived.fetchNextPage().catch(() => {}); }}>
        {archived.isFetchingNextPage ? 'Loading more…' : archived.isFetchNextPageError ? 'Retry archived threads' : 'Show more archived threads'}
      </button>
    </>}
  </FoldableSection>;
}

function ThreadAssociations({ inventory }: { inventory: InventoryState }) {
  const { sidebar, threads, links, loading, error, hasCurrentRoster } = useThreadRoster();
  const pending = loading || sidebar.status === 'loading';
  const failed = error || sidebar.status === 'error';
  const unassigned: PluginSidebarThread[] = [], projects: PluginSidebarThread[] = [], areas: PluginSidebarThread[] = [];
  const projectIds = new Set(inventory.projects.map(project => project.id));
  const areaIds = new Set(inventory.areas.map(area => area.id));
  const showAssociations = sidebar.status === 'ready' && hasCurrentRoster;
  if (showAssociations) for (const thread of threads) {
    const { project, area } = links[thread.id] ?? {};
    if (project !== undefined) {
      const ref = reference.safeParse(project).data;
      if (!ref || ref.source !== inventory.source || !projectIds.has(ref.id)) projects.push(thread);
    } else if (area !== undefined) {
      const ref = reference.safeParse(area).data;
      if (!ref || ref.source !== inventory.source || !areaIds.has(ref.id)) areas.push(thread);
    } else unassigned.push(thread);
  }
  return <>
    <ThreadReadStatus loading={pending} error={failed} metadataError={error} />
    {showAssociations && <>
      <details><summary>Unassigned threads ({unassigned.length})</summary><ThreadList threads={unassigned} /></details>
      {!!areas.length && <details open><summary>Unavailable Area ({areas.length})</summary><ThreadList threads={areas} /></details>}
      {!!projects.length && <details open><summary>Unavailable project ({projects.length})</summary>
        <p>Use the thread menu to reassign or unlink.</p><ThreadList threads={projects} />
      </details>}
    </>}
  </>;
}

function GtdPanel({ panel, subPath }: PluginNavPanelProps & { panel: PanelPath }) {
  const inventory = useInventory(true);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const statusGroup = useId();
  const areaCountPrefix = useId();
  const [status, setStatus] = useState(() => lastProjectFilter);
  const [showAssociations, setShowAssociations] = useState(false);
  const [busy, setBusy] = useState(''); const busyRef = useRef(false); const [notice, setNotice] = useState('');
  const { watchError, retryWatch } = useAutomaticInventoryRefresh(!!busy, inventory.fetching);
  const [projectAction, setProjectAction] = useState<{ kind: 'done' | 'area'; project: Project; trigger: HTMLElement }>();
  const [createTarget, setCreateTarget] = useState<string>();
  const addProject = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<HTMLElement>(null);
  const restoreAfterChange = useRef<{ identity: string; trigger: HTMLElement }>(undefined);
  useLayoutEffect(() => {
    const previous = restoreAfterChange.current;
    const panel = nav.current;
    if (!previous || !panel || busy || inventory.fetching) return;
    restoreAfterChange.current = undefined;
    const document = panel.ownerDocument;
    const root = panel.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    if (active && active !== document.body && active !== previous.trigger) return;
    if (!active && root instanceof ShadowRoot && document.activeElement !== document.body && document.activeElement !== root.host) return;
    // An action can move its row. Find it by source and ID after the inventory settles.
    const trigger = Array.from(panel.querySelectorAll<HTMLElement>('[data-gtd-project-action]'))
      .find(action => action.dataset.gtdProjectAction === previous.identity);
    (trigger ?? heading.current)?.focus({ preventScroll: true });
  }, [busy, inventory.fetching]);
  useLayoutEffect(() => {
    const panel = nav.current, previous = focused.current;
    if (!panel || !previous || previous.isConnected) return;
    focused.current = null;
    const document = panel.ownerDocument, root = panel.getRootNode();
    if (document.activeElement === document.body ||
        (root instanceof ShadowRoot && document.activeElement === root.host && !root.activeElement))
      heading.current?.focus({ preventScroll: true });
  }, [inventory.revision]);
  // Retain a request ID for the life of this action, including uncertain failures.
  const requests = useRef(new Map<string, string>());
  const run = async (id: string, task: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(id); setNotice(''); try { await task(); } catch { setNotice('Change not confirmed. Inspect threads or Obsidian receipts before trying again.'); } finally { busyRef.current = false; setBusy(''); } };
  const newThread = (item: Area | Project, kind: 'area' | 'project') => void run(item.id, async () => {
    const k = (kind === 'area' ? 'gtd-new-area:' : 'gtd-new:') + key(inventory.source, item.id);
    let requestId = requests.current.get(k) ?? sessionStorage.getItem(k);
    const completed = Number(sessionStorage.getItem(k + ':completed') ?? 0);
    // Reuse a fast completion during the double-click window, even across reload.
    if (completed && Date.now() - completed > 1000) { requests.current.delete(k); sessionStorage.removeItem(k); requestId = null; }
    if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(k, requestId); sessionStorage.setItem(k, requestId); sessionStorage.removeItem(k + ':completed'); }
    sessionStorage.setItem(k, requestId);
    const result = await rpc.call(kind === 'area' ? 'newAreaThread' : 'newThread', { source: inventory.source, id: item.id, requestId });
    sessionStorage.setItem(k + ':completed', String(Date.now()));
    navigate.toThread(result.threadId); linksChanged();
  });
  const eligibleAreas = inventory.areas.filter(area => (area.id.endsWith('.md') && !/[\[\]#|%]/.test(area.id)));
  const changeProject = (project: Project, change: { kind: 'done' } | { kind: 'area'; areaPath: string }, trigger?: HTMLElement) => {
    if (trigger) restoreAfterChange.current = { identity: key(inventory.source, project.id), trigger };
    void run(project.id, async () => {
      try { setNotice((await rpc.call('changeProject', { source: inventory.source, id: project.id, change })).message); }
      finally { refreshInventory(true); linksChanged(); }
    });
  };

  const route = readRoute(panel, subPath);
  const ready = !!inventory.source;
  const record = 'record' in route ? route.record : undefined;
  const sameSource = record?.source === inventory.source;
  const project = route.kind === 'project' && sameSource ? inventory.projects.find(item => item.id === record?.id) : undefined;
  const area = route.kind === 'area' && sameSource ? inventory.areas.find(item => item.id === record?.id) : undefined;
  const owningArea = project && enclosingArea(inventory.areas, project.areaId);
  const unassigned = route.kind === 'unassigned';
  const partial = inventory.projectsPartial || inventory.areasPartial;
  const missing = ready && !inventory.error && !!record && !area && !project;
  const missingIncomplete = sameSource && (route.kind === 'area' ? inventory.areasPartial : inventory.projectsPartial);
  const title = project?.title ?? area?.title ?? (unassigned ? 'Unassigned area' :
    route.kind === 'index' ? 'Areas' : route.kind === 'project' ? 'Project' : route.kind === 'area' ? 'Area' : 'Page unavailable');
  const areaDestination = (item: Area) => recordDestination('areas', inventory.source, item.id);
  const entries = inventory.areas.map(area => ({ title: area.title, destination: areaDestination(area), area }));
  const projectsByArea = useMemo(() => {
    const groups = new Map<string | undefined, Project[]>();
    for (const item of inventory.projects) {
      const areaId = enclosingArea(inventory.areas, item.areaId)?.id;
      const group = groups.get(areaId);
      if (group) group.push(item);
      else groups.set(areaId, [item]);
    }
    return groups;
  }, [inventory.projects, inventory.areas]);
  const unassignedProjects = projectsByArea.get(undefined) ?? [];
  const hasUnassigned = unassigned || !!unassignedProjects.length;
  const inArea = area ? projectsByArea.get(area.id) ?? [] : unassignedProjects;
  const visible = inArea.filter(p => status === 'all' || p.status === status);
  const mailRows = useAreaMailStatus(inventory.source, area?.id ?? (unassigned ? null : undefined), status,
    inventory.revision, visible.length > 0);
  const lastPage = useRef('');
  useLayoutEffect(() => {
    const region = nav.current;
    const page = panelHref({ panel, subPath });
    if (!ready || !region || page === lastPage.current) return;
    lastPage.current = page;
    heading.current?.focus({ preventScroll: true });
    region.scrollTop = 0;
  }, [panel, subPath, ready]);

  const newThreadAction = (item: Area | Project, kind: 'area' | 'project') =>
    <button className="gtd-row-action" aria-label={`New thread for ${kind === 'area' ? 'Area ' : ''}${item.title}`} title="New thread"
      disabled={!!busy} onClick={() => newThread(item, kind)}><Icon name="MessageSquarePlus" aria-hidden="true" /></button>;
  const projectActions = (project: Project) => <>
    {newThreadAction(project, 'project')}
    <RowActions project={project} source={inventory.source} disabled={!!busy || !(project.id.endsWith('.md'))} actions={[
      ...(eligibleAreas.length ? [{ label: 'Move to Area…', run: (trigger: HTMLElement) => setProjectAction({ kind: 'area', project, trigger }) }] : []),
      { label: project.status === 'done' ? 'Archive linked threads' : 'Mark as done', run: trigger => setProjectAction({ kind: 'done', project, trigger }) },
    ]} />
  </>;
  return <section className="gtd-nav" aria-label="Personal GTD projects" ref={nav}
    onFocusCapture={event => { focused.current = event.target as HTMLElement; }}
    onBlurCapture={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focused.current = null;
    }}>
    <div className="gtd-content">
      <header className="gtd-page-header">
        {route.kind !== 'index' && <nav className="gtd-crumbs" aria-label="Breadcrumb">
          <PanelLink destination={areasIndex}>Areas</PanelLink>
          {project && (owningArea || !inventory.areasPartial || !project.areaId) && <>
            <span aria-hidden="true">/</span>
            <PanelLink destination={owningArea ? areaDestination(owningArea) : unassignedArea}>{owningArea?.title ?? 'Unassigned area'}</PanelLink>
          </>}
        </nav>}
        <div className="gtd-page-heading">
          <h1 tabIndex={-1} ref={heading}>{title}</h1>
          {project && projectActions(project)}
        </div>
      </header>
      {inventory.loading && <p role="status">Loading GTD…</p>}
      {(inventory.error || watchError || partial) && <div className="gtd-read-error">
        {inventory.error && <p role="alert">{inventory.error}</p>}
        {watchError && !inventory.error && <p role="status">GTD could not check for vault changes.</p>}
        {partial && <p role="status">Some projects or Areas could not be loaded. Inventory totals are unconfirmed.</p>}
        <button type="button" aria-label="Retry GTD inventory" aria-disabled={inventory.fetching} onClick={() => {
          if (inventory.fetching) return;
          heading.current?.focus({ preventScroll: true });
          if (watchError) retryWatch.current?.();
          refreshInventory(true);
        }}>Retry</button>
      </div>}
      {inventory.malformedFrontmatter.length > 0 && <details className="gtd-frontmatter-errors">
        <summary>Notes with invalid frontmatter</summary>
        <ul>{inventory.malformedFrontmatter.map(path => <li key={path}>{path}</li>)}</ul>
      </details>}
      {route.kind === 'invalid' && <p className="gtd-empty">This GTD address is invalid. Open a page from Areas.</p>}
      {missing && <p className="gtd-empty" role="status">{!sameSource ? 'This link is for a different GTD source.' : missingIncomplete ?
        'This record could not be found in the partial inventory.' : `This ${route.kind === 'area' ? 'Area' : 'project'} is unavailable in the current inventory.`}</p>}
      {ready && route.kind === 'index' && <>
        {entries.length || hasUnassigned ? <ul className="gtd-rows">
          {(hasUnassigned ? [...entries, { title: 'Unassigned area', destination: unassignedArea, area: undefined }] : entries).map(({ title, destination, area }, index) => {
            const count = projectsByArea.get(area?.id)?.filter(project => project.status === 'active').length ?? 0;
            const countId = `${areaCountPrefix}-${index}`;
            return <li key={panelHref(destination)}>
              <PanelLink className="gtd-browser-link" destination={destination} aria-label={title} aria-describedby={partial ? undefined : countId}>
                <span>{title}</span>
                {!partial && <span id={countId} className="gtd-area-project-count">{count} {count === 1 ? 'project' : 'projects'}</span>}
                <Icon name="ChevronRight" aria-hidden="true" />
              </PanelLink>
            </li>;
          })}
        </ul> : <p className="gtd-empty">{inventory.areasPartial ? 'No Areas in the loaded inventory.' : 'No Areas yet.'}</p>}
        <details className="gtd-associations" open={showAssociations} onToggle={event => setShowAssociations(event.currentTarget.open)}>
          <summary>Thread associations</summary>
          {showAssociations && <ThreadAssociations inventory={inventory} />}
        </details>
      </>}
      {ready && (area || unassigned) && <>
        {area && <AreaStandard key={`standard:${key(inventory.source, area.id)}`} source={inventory.source} id={area.id} hasNote={area.id.endsWith('.md')} />}
        {area && <AreaActions key={`actions:${key(inventory.source, area.id)}`} source={inventory.source} id={area.id} revision={inventory.revision} />}
        <FoldableSection key={`projects:${key(inventory.source, area?.id ?? '')}`} title="Projects" tools={
          <FilterControls label="Project status" action={area && <button ref={addProject} type="button" className="gtd-row-action"
            aria-label="Add project" title="Add project" disabled={!!busy || !!inventory.error}
            onClick={() => setCreateTarget(key(inventory.source, area.id))}><Icon name="Plus" aria-hidden="true" /></button>}>
            {(Object.keys(projectStatuses) as ProjectFilter[]).map(value => <FilterOption key={value} type="radio" name={statusGroup}
              label={projectStatuses[value]} checked={status === value} onChange={() => { lastProjectFilter = value; setStatus(value); }} />)}
          </FilterControls>
        }>
          {visible.length ? <ul className="gtd-rows">{visible.map(item => {
            const mail = mailRows && (mailRows.get(item.id) ?? 'incomplete');
            return <li key={item.id} className="gtd-project-row">
              <PanelLink className="gtd-browser-link" destination={recordDestination('projects', inventory.source, item.id)}>
                {item.title}{status === 'all' && <span className="gtd-row-status">{item.status[0].toUpperCase() + item.status.slice(1)}</span>}
                <Icon name="ChevronRight" aria-hidden="true" />
              </PanelLink>
              {mail && mail !== 'clear' && <span className="gtd-project-mail" data-mail={mail}>
                {mail === 'unread' ? 'Unread email' : 'Mail status incomplete'}
              </span>}
              {projectActions(item)}
            </li>;
          })}</ul> : <p className="gtd-empty" role="status">{partial ? 'No matching projects in the loaded inventory.' :
            !inArea.length ? (area ? 'No projects in this Area yet.' : 'No unassigned projects.') :
              `No ${status} projects ${area ? 'in this Area' : 'without an Area'}.`}</p>}
        </FoldableSection>
        {area && <LinkedThreads key={key(inventory.source, area.id)} kind="area" id={area.id} source={inventory.source}
          action={newThreadAction(area, 'area')} />}
      </>}
      {project && <React.Fragment key={key(inventory.source, project.id)}>
        <ProjectNextAction source={inventory.source} id={project.id} revision={inventory.revision} />
        <ProjectCorrespondence key={JSON.stringify([inventory.source, project.id])} source={inventory.source} id={project.id} revision={inventory.revision} />
        <LinkedThreads kind="project" id={project.id} source={inventory.source} />
      </React.Fragment>}
      {notice && <p role="status">{notice}</p>}
    </div>
    {area && createTarget === key(inventory.source, area.id) && <CreateProjectDialog area={area} source={inventory.source} onClose={created => {
      setCreateTarget(undefined);
      addProject.current?.focus({ preventScroll: true });
      if (created) {
        if (status !== 'active' && status !== 'all') { lastProjectFilter = 'active'; setStatus('active'); }
        setNotice('Project created in Obsidian.');
        refreshInventory(true);
      }
    }} />}
    {projectAction && <ProjectActionDialog action={projectAction.kind} project={projectAction.project} areas={eligibleAreas} onClose={value => {
      const { kind, project, trigger } = projectAction;
      setProjectAction(undefined);
      (trigger.isConnected ? trigger : heading.current)?.focus({ preventScroll: true });
      if (value !== undefined) changeProject(project, kind === 'done' ? { kind } : { kind, areaPath: value }, trigger);
    }} />}
  </section>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'projects', path: 'areas', title: 'GTD', icon: 'ListTodo',
    component: props => <GtdPanel {...props} panel="areas" /> });
  // The former project browser URL still opens the Areas index.
  app.slots.navPanel({ id: 'project-pages', path: 'projects', title: 'GTD', icon: 'ListTodo',
    experimental_hideFromNavigation: true, component: props => <GtdPanel {...props} panel="projects" /> });
  app.slots.experimental_threadContextSegment({
    id: 'gtd-project', title: 'GTD Project', group: experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread, order: 20,
    useVisible: input => !!useComposerProject(input), summary: ComposerProjectSummary,
  });
  app.slots.experimental_threadAction({ id: 'project', title: 'GTD project', icon: 'ListTodo', group: 'organize',
    useData: ({ threadIds }) => ({ inventory: useInventory(false, threadIds.length > 0), ...useLinks(threadIds), threadIds: new Set(threadIds), rpc: useRpc<typeof rpcContract>() }),
    item: ({ thread, data }) => {
      const { inventory } = data;
      const stored = data.links[thread.id]?.project;
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
        : linkError ? 'Thread association could not load.' : '';
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
        choices: { items: data.error || inventory.error ? [{ id: 'retry', label: 'Retry GTD', selected: false, disabled: false }, ...items] : items,
          hint: status || 'Changes only the personal GTD association.' },
        run: async ({ value }) => {
          if (value === 'retry' && (data.error || inventory.error)) {
            if (data.error) linksChanged();
            if (inventory.error) refreshInventory(true);
            return;
          }
          const choice = items.find(item => item.id === value);
          if (!choice || choice.disabled) throw new Error('This GTD association choice is unavailable.');
          await data.rpc.call('associate', { threadId: thread.id, project: choice.project });
          linksChanged();
        },
      };
    },
  });
});
