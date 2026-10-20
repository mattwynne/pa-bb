import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import type { ExperimentalSidebarFooterDisclosureProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { Status } from './core/model.ts';
import type { ApplicationStatus, IntegrationId, FailureCode } from './core/application-model.ts';
import type { RuntimeId } from './core/runtime-model.ts';
import { hasFreshOffers } from './core/notice.ts';
import './app.css';
const labels = { 'google-calendar': ['Calendar', 'Calendar'], fastmail: ['Fastmail', 'Mail'], 'google-drive': ['Google Drive', 'FolderOpen'], icloud: ['iCloud', 'Cloud'], obsidian: ['Obsidian', 'Notebook'] } as const;
const runtimeLabels: Record<RuntimeId, string> = { pi: 'Pi CLI', codex: 'Codex CLI', bb: 'BB' };
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
function Label({ id }: { id: IntegrationId }) { return <span className="pa-update-label"><Icon name={labels[id][1]} className="pa-update-icon" /><span>{labels[id][0]}</span></span>; }
export function UpdatesPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [state, setState] = useState<ApplicationStatus | null>(null), [discovery, setDiscovery] = useState<Status | null>(null);
  const [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Partial<Record<IntegrationId, 'keep' | 'install'>>>({});
  const [confirmInterruptingThreads, setConfirmInterruptingThreads] = useState(false);
  const generation = useRef(0), mounted = useRef(true);
  async function read() {
    const request = ++generation.current;
    try { const [next, notes] = await Promise.all([rpc.call('applicationStatus', null), rpc.call('status', null)]); if (mounted.current && request === generation.current) { setState(next); setDiscovery(notes); setError(false); } }
    catch { if (mounted.current && request === generation.current) setError(true); }
  }
  useRealtime('application', () => { void read(); });
  useRealtime('status', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  useEffect(() => { setChoices({}); setConfirmInterruptingThreads(false); }, [state?.review?.id]);
  useEffect(() => {
    const unresolvedBb = state?.job?.bbIntent && state.job.runtimeReceipts.some(row => row.id === 'bb' && row.outcome === 'uncertain');
    if (!busy && !state?.applying && !state?.checking && !unresolvedBb) return;
    const timer = setInterval(() => { void read(); }, 1000); return () => clearInterval(timer);
  }, [busy, state?.applying, state?.checking, state?.job?.phase]);
  async function act(action: 'review' | 'apply' | 'resumeSync') {
    setBusy(true); setError(false);
    try {
      if (action === 'apply' && state?.review) await rpc.call('apply', { reviewId: state.review.id, choices: state.review.rows.filter(row => row.local === 'custom').map(row => ({ id: row.id, choice: choices[row.id] ?? 'keep' })), confirmInterruptingThreads });
      else if (action !== 'apply') await rpc.call(action, null);
      await read();
    } catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  const rows = state?.review?.rows ?? [], custom = rows.filter(row => row.local === 'custom'), ordinary = rows.filter(row => row.local === 'stock'), unknown = rows.filter(row => row.local === 'unknown');
  const pending = busy || state?.applying || state?.checking || discovery?.checking;
  const reviewedJob = state?.job?.reviewId === state?.review?.id ? state?.job : null;
  const runtime = state?.review?.runtime, runtimeRows = runtime?.rows ?? [];
  const runtimeOffers = runtimeRows.filter(row => row.state === 'ready');
  const bbOffered = runtimeOffers.some(row => row.id === 'bb');
  const needsConsent = bbOffered && (runtime?.runningThreadCount ?? 0) > 0;
  const installCount = ordinary.length + custom.filter(row => choices[row.id] === 'install').length + runtimeOffers.length;
  const failure = state?.failure ?? reviewedJob?.failure;
  return <section className="pa-updates" aria-label="Update PA" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } }}>
    <header><strong>Update PA</strong><button type="button" aria-label="Close PA updates" onClick={dismiss}>×</button></header>
    <div className="pa-updates-body">
      <p role="status" aria-live="polite">{error ? 'Update status unavailable' : failure ? reviewedJob?.phase === 'attention' ? 'Update needs attention' : 'Check failed — previous results may be out of date' : state?.applying ? state.job?.phase === 'restarting' ? 'BB is updating and restarting…' : 'Updating PA…' : busy || state?.checking ? 'Checking installed versions and local changes…' : reviewedJob ? reviewedJob.phase === 'complete' ? 'Update finished' : 'Update needs attention' : !state?.review ? 'Check for PA updates' : rows.length || runtimeOffers.length ? 'PA updates available' : 'No updates offered' }</p>
      {error && <p role="alert">Could not read the result. Reopen this panel to check the saved job; do not assume the update failed.</p>}
      {failure && <p role="alert">{failures[failure]}</p>}
      {runtime && <p className="pa-updates-muted">{runtime.target ? <>PA server: <strong title={runtime.target.id}>{runtime.target.name}</strong>. Pi and Codex updates run here, not on the computer viewing this panel.</> : 'The PA server could not be identified. Runtime updates are unavailable; no other machine will be used.'}</p>}
      {!reviewedJob && <>
        {custom.length > 0 && <><h3>Local changes</h3><p>Your versions stay unless you choose a released version.</p><div className="pa-update-bulk"><button disabled={pending} onClick={() => setChoices({})}>Keep all local</button><button disabled={pending} onClick={() => setChoices(Object.fromEntries(custom.map(row => [row.id, 'install'])))}>Install all released</button></div>
          <div className="pa-update-choices">{custom.map(row => <div className="pa-update-row" key={row.id}><Label id={row.id} /><p className="pa-updates-muted">Installed {row.installed} · Currently available {row.available}</p><div className="pa-update-toggle" role="group" aria-label={`${labels[row.id][0]} local changes`}><button disabled={pending} aria-pressed={(choices[row.id] ?? 'keep') === 'keep'} onClick={() => setChoices(current => ({ ...current, [row.id]: 'keep' }))}>Keep local</button><button disabled={pending} aria-pressed={choices[row.id] === 'install'} onClick={() => setChoices(current => ({ ...current, [row.id]: 'install' }))}>Install released version</button></div></div>)}</div>
          <p className="pa-updates-muted">Installing a released version replaces that integration’s local code, interface and assets—not its settings, credentials or account data.</p></>}
        {ordinary.length > 0 && <div className="pa-update-ordinary"><h3>{custom.length ? 'Also updating' : 'Updating'}</h3>{ordinary.map(row => <div className="pa-update-version" key={row.id}><Label id={row.id} /><span>{row.installed} → {row.available}</span></div>)}</div>}
        {unknown.map(row => <div className="pa-update-row" key={row.id}><Label id={row.id} /><p>{prerequisites[row.prerequisite ?? 'baseline_unknown'] ?? failures[row.prerequisite ?? 'baseline_unknown']}</p></div>)}
        {runtimeRows.length > 0 && <div className="pa-update-ordinary"><h3>PA runtime</h3>{runtimeRows.map(row => <div className="pa-update-row" key={row.id}><strong>{runtimeLabels[row.id]}</strong><p>{row.installed ? `Installed ${row.installed}` : row.source === 'missing' ? 'Not installed' : 'Installed version unknown'}{row.state === 'ready' ? ` → ${row.available}` : row.state === 'current' ? ' · No update offered' : ' · Update unavailable'}</p>{row.reason && <p className="pa-updates-muted">{failures[row.reason]}</p>}</div>)}</div>}
        {runtimeOffers.some(row => row.id !== 'bb') && <p className="pa-updates-muted">CLI receipts report the installed version. Existing provider processes and sessions may keep their previous version until their normal restart or release.</p>}
        {bbOffered && <p>BB updates last and restarts through its native launcher. Reopen this panel after reconnecting to see the saved result.</p>}
        {needsConsent && <label className="pa-update-consent"><input type="checkbox" checked={confirmInterruptingThreads} disabled={pending} onChange={event => setConfirmInterruptingThreads(event.target.checked)} /><span>Allow the BB restart to interrupt running threads ({runtime?.runningThreadCount} currently running).</span></label>}
        {installCount > 0 && <p className="pa-updates-muted">A newer compatible release may arrive during the update. The result will show what was actually installed.</p>}
      </>}
      {reviewedJob && <ul className="pa-update-results">{reviewedJob.receipts.map(row => <li key={row.id}><Label id={row.id} /><span>{row.outcome === 'skipped' ? 'Not updated' : row.outcome === 'kept' ? `Kept local ${row.actual}` : row.actual ? `Installed ${row.actual}${row.actual !== row.preview ? ` (previewed ${row.preview})` : ''}` : row.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : row.outcome === 'activating' ? 'Installing…' : state?.applying ? 'Waiting…' : 'Not updated'}</span></li>)}{reviewedJob.runtimeReceipts.map(row => <li key={row.id}><strong>{runtimeLabels[row.id]}</strong><span>{row.outcome === 'failed' ? `${runtimeLabels[row.id]} update failed${row.actual ? ` · Running ${row.actual}` : ''}` : row.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : row.outcome === 'activating' ? row.id === 'bb' ? 'Updating through BB’s launcher…' : 'Installing…' : row.actual ? `Installed ${row.actual}${row.actual !== row.preview ? ` (previewed ${row.preview})` : ''}` : state?.applying ? 'Waiting…' : 'Not updated'}</span></li>)}</ul>}
      {rows.length > 0 && <details><summary>Release notes</summary>{rows.map(row => {
        const published = discovery?.observation?.release?.plugins.find(item => item.id === row.id && item.version === row.available);
        return <div key={row.id}><h3>{labels[row.id][0]} · preview {row.available}</h3><p className="pa-updates-notes">{published?.notes || 'No published notes available for this preview.'}</p></div>;
      })}{discovery?.stale && <p className="pa-updates-muted">Last known release notes; the release check could not be refreshed.</p>}</details>}
      {state?.job?.syncReserved && !state.applying && <p role="alert">iCloud remains reserved for this update. If an install result is uncertain, wait for BB’s native update to finish—or restart BB—before resuming. Folders you explicitly paused stay paused.</p>}
    </div>
    <footer>{state?.job?.syncReserved && !state.applying ? <button disabled={pending} onClick={() => void act('resumeSync')}>Resume previously enabled folders</button> : !reviewedJob && installCount > 0 ? <button className="pa-update-primary" disabled={pending || !!state?.failure || error || (needsConsent && !confirmInterruptingThreads)} onClick={() => void act('apply')}>Update PA</button> : null}
      <button type="button" disabled={pending || state?.job?.syncReserved} onClick={() => void act('review')}>{state?.review ? 'Check again' : 'Check for updates'}</button>
      <p className="pa-updates-muted">Uses each component’s supported released update. Settings, credentials and account data stay in place.</p>
    </footer>
  </section>;
}
function UpdateNotice() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [available, setAvailable] = useState(false), [showReview, setShowReview] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), generation = useRef(0);
  useEffect(() => { if (showReview) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [showReview]);
  async function read() {
    const request = ++generation.current;
    try {
      const state = await rpc.call('applicationStatus', null);
      if (mounted.current && request === generation.current) setAvailable(hasFreshOffers(state));
    } catch { if (mounted.current && request === generation.current) setAvailable(false); }
  }
  useRealtime('application', () => { void read(); }); useRealtime('status', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  return <>{available && <button type="button" className="pa-update-notice" onClick={() => setShowReview(true)}><Icon name="RotateCcw" /> PA update available</button>}
    <dialog ref={dialog} className="pa-update-dialog" aria-label="PA updates" onCancel={() => setShowReview(false)} onClose={() => setShowReview(false)}>{showReview && <UpdatesPanel dismiss={() => setShowReview(false)} />}</dialog></>;
}
export default definePluginApp(app => {
  app.experimental_sidebarFooter.register({ kind: 'disclosure', id: 'updates', label: 'PA updates', icon: 'RotateCcw', component: UpdatesPanel });
  app.slots.experimental_appOverlay({ id: 'update-notice', component: UpdateNotice });
});
