import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { Status } from './core/model.ts';
import type { ApplicationStatus, CheckProgress, IntegrationId, IntegrationInventoryRow, FailureCode } from './core/application-model.ts';
import type { RuntimeId } from './core/runtime-model.ts';
import { hasFreshOffers } from './core/notice.ts';
import './app.css';
const labels = { 'google-calendar': ['Calendar', 'Calendar'], fastmail: ['Fastmail', 'Mail'], 'google-drive': ['Google Drive', 'FolderOpen'], icloud: ['iCloud', 'Cloud'], obsidian: ['Obsidian', 'Notebook'] } as const;
const runtimeLabels: Record<RuntimeId, string> = { pi: 'Pi', codex: 'Codex', bb: 'BB' };
const runtimeIcons = { pi: 'Terminal', codex: 'Code', bb: 'Zap' } as const;
const failures: Record<FailureCode, string> = {
  not_installed: 'This CLI is not installed. Set it up through BB’s normal provider controls before using PA updates.',
  sync_recovery: 'Some iCloud folders need recovery and were left paused. The update reservation has been released. Open iCloud settings and follow those folders’ recovery instructions; completed changes are listed below.',
  busy: 'BB is busy or has running threads. Wait for the work to finish, or check again to review permission to interrupt threads for the BB restart.',
  unsupported_install: 'This installation cannot use the native released update. Use BB’s normal update instructions for its installation type.',
  unavailable: 'Could not finish this step. Check BB and your connection, then check again. Completed changes are listed below.',
  baseline_unknown: 'The original installed build could not be verified. This is not evidence of local changes. This integration will not be replaced.',
  changed: 'The installation changed after your review. Check again and choose whether to replace the new local changes.',
  incompatible: 'The available versions do not meet this installation’s requirements. Nothing further will be installed.',
  paired_migration: 'These iCloud/Obsidian versions need the documented stopped paired upgrade. This automatic flow supports their current 0.3.x versions only.',
  maintenance_unavailable: 'Updater-aware iCloud Pause support is unavailable. Check its installed release before continuing; completed changes are listed below.',
  interrupted: 'The update was interrupted. Check the recorded results before starting again; uncertain installs are not retried automatically.',
  storage: 'Update history could not be saved or read. Updates are stopped until plugin storage is working again.',
};
const prerequisites: Partial<Record<FailureCode, string>> = {
  unavailable: 'Could not check this integration. Check BB and your connection, then check again.',
  incompatible: 'The available release does not meet this integration’s requirements. This integration will not be replaced.',
};
function inventoryStatus(row: IntegrationInventoryRow) {
  const status = row.state === 'current' ? row.local === 'stock' ? 'Up to date' : row.local === 'custom' ? 'Local changes' : 'Changes unverified'
    : row.state === 'pinned' ? 'Version pinned' : row.state === 'offered' ? 'Update available' : row.prerequisite === 'baseline_unknown' ? 'Changes unverified' : row.prerequisite === 'incompatible' ? 'Update unavailable' : 'Couldn’t check';
  return row.local === 'custom' && row.state !== 'current' ? `Local changes · ${status}` : status;
}
function Checking() { return <span className="pa-update-current"><Icon name="RotateCcw" className="pa-update-spinner" aria-hidden={true} />Checking…</span>; }
function CurrentStatus({ confirmed, checking }: { confirmed: boolean; checking: boolean }) {
  return confirmed ? <span className="pa-update-current"><Icon name="Check" className="pa-update-check" aria-hidden={true} />Up to date</span> : checking ? <Checking /> : <>Couldn’t check</>;
}
function DevelopmentStatus({ state }: { state: IntegrationInventoryRow['development'] }) {
  return state === 'unpublished' ? <span className="pa-development-badge" title="Development checkout changes, not installed code">Unpublished local changes</span> : state === 'unknown' ? <span className="pa-development-unknown">Couldn’t check local work</span> : null;
}
function InventoryResult({ row, confirmed, checking }: { row: IntegrationInventoryRow; confirmed: boolean; checking: boolean }) {
  const concern = row.development === 'unpublished' || row.development === 'unknown';
  const current = row.state === 'current' && row.local === 'stock';
  return <>{current ? concern ? null : <CurrentStatus confirmed={confirmed && row.installed !== 'unknown' && !row.prerequisite} checking={checking} /> : inventoryStatus(row)}{concern && !current ? ' · ' : null}<DevelopmentStatus state={row.development} /></>;
}
function Label({ id }: { id: IntegrationId }) { return <span className="pa-update-label"><Icon name={labels[id][1]} className="pa-update-icon" /><span>{labels[id][0]}</span></span>; }
function RuntimeLabel({ id }: { id: RuntimeId }) { return <span className="pa-update-label"><Icon name={runtimeIcons[id]} className="pa-update-icon" /><span>{runtimeLabels[id]}</span></span>; }
function ProgressRows({ progress, previous, error }: { progress: CheckProgress; previous: ApplicationStatus['review']; error: boolean }) {
  const integrationOrder = [...new Set([...(previous?.inventory?.map(row => row.id) ?? []), ...(Object.keys(labels) as IntegrationId[])])];
  return <div className="pa-update-ordinary" role="group" aria-label="Check progress" aria-live="polite">
    {integrationOrder.filter(id => !progress.integrationsDone || progress.integrations.some(row => row.id === id)).map(id => {
      const row = progress.integrations.find(row => row.id === id);
      const installed = row?.installed ?? previous?.inventory?.find(row => row.id === id)?.installed ?? previous?.rows.find(row => row.id === id)?.installed;
      return <div className="pa-update-card pa-update-version" data-check-id={id} key={id}><Label id={id} /><span>{installed && <>{installed === 'unknown' ? 'Version unknown' : installed} · </>}{!row ? error ? 'Couldn’t check' : <Checking /> : <InventoryResult row={row} confirmed={!error} checking={false} />}</span></div>;
    })}
    {(Object.keys(runtimeLabels) as RuntimeId[]).filter(id => !progress.runtimeDone || progress.runtime.some(row => row.id === id)).map(id => {
      const row = progress.runtime.find(row => row.id === id);
      const installed = row ? row.installed : previous?.runtime?.rows.find(row => row.id === id)?.installed;
      return <div className="pa-update-card pa-update-version" data-check-id={id} key={id}><RuntimeLabel id={id} /><span>{installed ? <>{installed} · </> : row?.source === 'missing' ? 'Not installed · ' : null}{!row ? error ? 'Couldn’t check' : <Checking /> : row.state === 'current' ? <CurrentStatus confirmed={!error && !!row.installed && !row.reason} checking={false} /> : row.state === 'ready' ? 'Update available' : row.reason === 'unavailable' ? 'Couldn’t check' : 'Update unavailable'}</span></div>;
    })}
  </div>;
}
export function UpdatesPanel() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [state, setState] = useState<ApplicationStatus | null>(null), [discovery, setDiscovery] = useState<Status | null>(null);
  const [error, setError] = useState(false), [busy, setBusy] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const [choices, setChoices] = useState<Partial<Record<IntegrationId, 'keep' | 'install'>>>({});
  const [confirmInterruptingThreads, setConfirmInterruptingThreads] = useState(false);
  const generation = useRef(0), mounted = useRef(true), body = useRef<HTMLDivElement>(null);
  const reviewAtRequest = useRef<{ id: string | null } | null>(null);
  async function read() {
    const request = ++generation.current;
    try { const [next, notes] = await Promise.all([rpc.call('applicationStatus', null), rpc.call('status', null)]); if (mounted.current && request === generation.current) { setState(next); setDiscovery(notes); setError(false); } }
    catch { if (mounted.current && request === generation.current) { setError(true); setUnconfirmed(true); } }
  }
  useRealtime('application', () => { void read(); });
  useRealtime('status', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  useEffect(() => { setChoices({}); setConfirmInterruptingThreads(false); setUnconfirmed(false); body.current?.scrollTo({ top: 0 }); }, [state?.review?.id]);
  useEffect(() => {
    const unresolvedBb = state?.job?.bbIntent && state.job.runtimeReceipts.some(row => row.id === 'bb' && row.outcome === 'uncertain');
    if (!busy && !state?.applying && !state?.checking && !unresolvedBb) return;
    const timer = setInterval(() => { void read(); }, 1000); return () => clearInterval(timer);
  }, [busy, state?.applying, state?.checking, state?.job?.phase]);
  async function act(action: 'review' | 'apply' | 'resumeSync') {
    if (action === 'review') reviewAtRequest.current = { id: state?.review?.id ?? null };
    setBusy(true); setError(false);
    try {
      if (action === 'apply' && state?.review) await rpc.call('apply', { reviewId: state.review.id, choices: state.review.rows.filter(row => row.local === 'custom').map(row => ({ id: row.id, choice: choices[row.id] ?? 'keep' })), confirmInterruptingThreads });
      else if (action !== 'apply') await rpc.call(action, null);
      await read();
    } catch { if (mounted.current) { setError(true); setUnconfirmed(true); } }
    finally { reviewAtRequest.current = null; if (mounted.current) setBusy(false); }
  }
  const rows = state?.review?.rows ?? [], custom = rows.filter(row => row.local === 'custom'), ordinary = rows.filter(row => row.local === 'stock'), unknown = rows.filter(row => row.local === 'unknown');
  const inventory = (state?.review?.inventory ?? []).filter(row => !rows.some(offer => offer.id === row.id));
  const developmentFor = (id: IntegrationId) => state?.review?.inventory?.find(row => row.id === id)?.development;
  const pending = busy || state?.applying || state?.checking || discovery?.checking;
  const reviewedJob = state?.job?.reviewId === state?.review?.id ? state?.job : null;
  const runtime = state?.review?.runtime, runtimeRows = runtime?.rows ?? [];
  const runtimeOffers = runtimeRows.filter(row => row.state === 'ready');
  const bbOffered = runtimeOffers.some(row => row.id === 'bb');
  const needsConsent = bbOffered && (runtime?.runningThreadCount ?? 0) > 0;
  const installCount = ordinary.length + custom.filter(row => choices[row.id] === 'install').length + runtimeOffers.length;
  const visibleRuntimeRows = ordinary.length + custom.length + runtimeOffers.length > 0 ? runtimeRows.filter(row => row.state !== 'current') : runtimeRows;
  const progress = state?.checking && state.progress && (!reviewedJob || state.progress.requested) ? state.progress : null;
  const failure = progress ? null : state?.failure ?? reviewedJob?.failure;
  // The final realtime result can arrive before the waiting review RPC returns.
  const completedReview = !!reviewAtRequest.current && !!state?.review && state.review.id !== reviewAtRequest.current.id && !state.checking && !state.applying;
  const currentConfirmed = (!pending || completedReview) && !error && !failure && !unconfirmed;
  const shownTarget = progress?.target ?? runtime?.target;
  return <section className="pa-updates" aria-label="Update PA">
    <div className="pa-updates-body" ref={body}>
      <p role="status" aria-live="polite">{error ? 'Update status unavailable' : failure ? reviewedJob?.phase === 'attention' ? 'Update needs attention' : 'Check failed — previous results may be out of date' : state?.applying ? state.job?.phase === 'restarting' ? 'BB is updating and restarting…' : 'Updating PA…' : busy || state?.checking ? 'Checking installed versions and local changes…' : reviewedJob ? reviewedJob.phase === 'complete' ? 'Update finished' : 'Update needs attention' : !state?.review ? 'Check for PA updates' : rows.length || runtimeOffers.length ? '' : 'No updates offered' }</p>
      {error && <p role="alert">Could not read the result. Reopen this panel to check the saved job; do not assume the update failed.</p>}
      {failure && <p role="alert">{failures[failure]}</p>}
      {(shownTarget || runtime && !progress) && <p className="pa-updates-muted">{shownTarget ? <>Server: <strong title={shownTarget.id}>{shownTarget.name}</strong></> : 'The PA server could not be identified. Runtime updates are unavailable; no other machine will be used.'}</p>}
      {(progress?.integrations ?? state?.review?.inventory ?? []).some(row => row.development === 'unpublished') && <p className="pa-updates-muted">Development checkout changes are not installed.</p>}
      {progress && <ProgressRows progress={progress} previous={state?.review ?? null} error={error} />}
      {!progress && !reviewedJob && <>
        {custom.length > 0 && <><h3>Local changes</h3><div className="pa-update-bulk"><button disabled={pending} onClick={() => setChoices({})}>Keep all local</button><button disabled={pending} onClick={() => setChoices(Object.fromEntries(custom.map(row => [row.id, 'install'])))}>Install all released</button></div>
          <div className="pa-update-choices">{custom.map(row => <div className="pa-update-row" key={row.id}><div className="pa-update-version"><Label id={row.id} /><span>{row.installed} → <strong>{row.available}</strong>{' '}<DevelopmentStatus state={developmentFor(row.id)} /></span></div><div className="pa-update-toggle" role="group" aria-label={`${labels[row.id][0]} local changes`}><button disabled={pending} aria-pressed={(choices[row.id] ?? 'keep') === 'keep'} onClick={() => setChoices(current => ({ ...current, [row.id]: 'keep' }))}>Keep local</button><button disabled={pending} aria-pressed={choices[row.id] === 'install'} onClick={() => setChoices(current => ({ ...current, [row.id]: 'install' }))}>Install released version</button></div></div>)}</div>
          <p className="pa-updates-muted">Installing a release replaces local changes, not settings or data.</p></>}
        {ordinary.length > 0 && <div className="pa-update-ordinary">{custom.length > 0 && <h3>Also updating</h3>}{ordinary.map(row => <div className="pa-update-card pa-update-version" key={row.id}><Label id={row.id} /><span>{row.installed} → <strong>{row.available}</strong>{' '}<DevelopmentStatus state={developmentFor(row.id)} /></span></div>)}</div>}
        {unknown.map(row => <div className="pa-update-card" key={row.id}><Label id={row.id} /><p>{prerequisites[row.prerequisite ?? 'baseline_unknown'] ?? failures[row.prerequisite ?? 'baseline_unknown']}</p><DevelopmentStatus state={developmentFor(row.id)} /></div>)}
        {inventory.length > 0 && <div className="pa-update-ordinary">{inventory.map(row => <div className="pa-update-card pa-update-version" key={row.id}><Label id={row.id} /><span>{row.installed === 'unknown' ? 'Version unknown' : row.installed} · <InventoryResult row={row} confirmed={currentConfirmed} checking={!!pending} /></span></div>)}</div>}
        {visibleRuntimeRows.length > 0 && <div className="pa-update-ordinary">{visibleRuntimeRows.map(row => <div className="pa-update-card" key={row.id}><div className="pa-update-version"><RuntimeLabel id={row.id} /><span>{row.installed ?? (row.source === 'missing' ? 'Not installed' : 'Installed version unknown')}{row.state === 'ready' ? <> → <strong>{row.available}</strong></> : row.state === 'current' ? <> · <CurrentStatus confirmed={currentConfirmed && !!row.installed && !row.reason} checking={!!pending} /></> : row.reason === 'unavailable' ? ' · Couldn’t check' : ' · Update unavailable'}</span></div>{row.reason && <p className="pa-updates-muted">{failures[row.reason]}</p>}</div>)}</div>}
        {installCount > 0 && <p>{bbOffered ? 'BB will restart. ' : ''}Settings and data stay.</p>}
        {needsConsent && <label className="pa-update-consent"><input type="checkbox" checked={confirmInterruptingThreads} disabled={pending} onChange={event => setConfirmInterruptingThreads(event.target.checked)} /><span>Allow the BB restart to interrupt running threads ({runtime?.runningThreadCount} currently running).</span></label>}
      </>}
      {!progress && reviewedJob && <ul className="pa-update-results">{reviewedJob.receipts.map(row => <li key={row.id}><Label id={row.id} /><span>{row.outcome === 'skipped' ? 'Not updated' : row.outcome === 'kept' ? `Kept local ${row.actual}` : row.actual ? `Installed ${row.actual}${row.actual !== row.preview ? ` (previewed ${row.preview})` : ''}` : row.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : row.outcome === 'activating' ? 'Installing…' : state?.applying ? 'Waiting…' : 'Not updated'}</span></li>)}{reviewedJob.runtimeReceipts.map(row => <li key={row.id}><RuntimeLabel id={row.id} /><span>{row.outcome === 'failed' ? `${runtimeLabels[row.id]} update failed${row.actual ? ` · Installed ${row.actual}` : ''}` : row.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : row.outcome === 'activating' ? row.id === 'bb' ? 'Updating…' : 'Installing…' : row.actual ? `Installed ${row.actual}${row.actual !== row.preview ? ` (previewed ${row.preview})` : ''}` : state?.applying ? 'Waiting…' : 'Not updated'}</span></li>)}</ul>}
      {!progress && rows.length > 0 && <details><summary>Release notes</summary>{rows.map(row => {
        const published = discovery?.observation?.release?.plugins.find(item => item.id === row.id && item.version === row.available);
        return <div key={row.id}><h3>{labels[row.id][0]} · preview {row.available}</h3><p className="pa-updates-notes">{published?.notes || 'No published notes available for this preview.'}</p></div>;
      })}{discovery?.stale && <p className="pa-updates-muted">Last known release notes; the release check could not be refreshed.</p>}</details>}
      {state?.job?.syncReserved && !state.applying && <p role="alert">iCloud remains reserved for this update. If an install result is uncertain, wait for BB’s native update to finish—or restart BB—before resuming. Folders you explicitly paused stay paused.</p>}
    </div>
    <footer>{state?.job?.syncReserved && !state.applying ? <button disabled={pending} onClick={() => void act('resumeSync')}>Resume previously enabled folders</button> : !progress && !reviewedJob && installCount > 0 ? <button className="pa-update-primary" disabled={pending || !!state?.failure || error || (needsConsent && !confirmInterruptingThreads)} onClick={() => void act('apply')}>Update PA</button> : null}
      <button type="button" disabled={pending || state?.job?.syncReserved} onClick={() => void act('review')}>{state?.review ? 'Check again' : 'Check for updates'}</button>
    </footer>
  </section>;
}
function UpdateNotice() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [available, setAvailable] = useState(false);
  const mounted = useRef(true), generation = useRef(0);
  async function read() {
    const request = ++generation.current;
    try {
      const state = await rpc.call('applicationStatus', null);
      if (mounted.current && request === generation.current) setAvailable(hasFreshOffers(state));
    } catch { if (mounted.current && request === generation.current) setAvailable(false); }
  }
  useRealtime('application', () => { void read(); }); useRealtime('status', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  return available ? <a className="pa-update-notice" href="/settings/plugins/pa-updates"><Icon name="RotateCcw" /> PA update available</a> : null;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'updates', component: UpdatesPanel });
  app.experimental_sidebarFooter.register({ kind: 'action', id: 'updates', label: 'PA updates', icon: 'RotateCcw', onActivate: context => context.openPluginDetails() });
  app.slots.experimental_appOverlay({ id: 'update-notice', component: UpdateNotice });
});
