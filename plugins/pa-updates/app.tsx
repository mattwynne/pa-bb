import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { ApplicationStatus, CheckProgress, IntegrationId, IntegrationInventoryRow, FailureCode } from './core/application-model.ts';
import type { RuntimeId } from './core/runtime-model.ts';
import { codeState } from './core/workspace.ts';
import { hasFreshOffers } from './core/notice.ts';
import { reviewDecision } from './core/decision.ts';
import './app.css';
const labels = { 'google-calendar': ['Calendar', 'Calendar'], fastmail: ['Fastmail', 'Mail'], 'google-drive': ['Google Drive', 'FolderOpen'], icloud: ['iCloud', 'Cloud'], obsidian: ['Obsidian', 'Notebook'], 'pa-updates': ['PA updater', 'RotateCcw'] } as const;
const order: IntegrationId[] = ['fastmail', 'google-calendar', 'google-drive', 'icloud', 'obsidian', 'pa-updates'];
const runtimeLabels: Record<RuntimeId, string> = { pi: 'Pi', codex: 'Codex', bb: 'BB' };
const runtimeIcons = { pi: 'Terminal', codex: 'Code', bb: 'Zap' } as const;
const failures: Record<FailureCode, string> = {
  not_installed: 'This CLI is not installed. Set it up through BB’s normal provider controls.',
  sync_recovery: 'Some iCloud folders need recovery and were left paused. Open iCloud settings for recovery instructions. Completed changes are kept.',
  busy: 'BB is busy or has running threads. Check again when they finish, or review permission to interrupt them.',
  unsupported_install: 'This installation cannot use the supported update operation.',
  unavailable: 'Could not finish this step. Check BB and your connection, then check again.',
  baseline_unknown: 'Could not verify the applied code. Nothing will be overwritten.',
  changed: 'The code changed after this check. Check again before applying it.',
  incompatible: 'The available code does not meet this installation’s requirements.',
  paired_migration: 'These older iCloud/Obsidian versions need their documented stopped paired upgrade.',
  maintenance_unavailable: 'Could not reserve an iCloud update window. Completed changes are kept.',
  interrupted: 'The operation was interrupted. Check its saved results before retrying; uncertain changes are not retried automatically.',
  storage: 'Update history could not be saved or read. Applying code is stopped until storage works again.',
  source_work: 'The working copy has local work. Ask PA to review it before bringing in origin’s changes.',
  local_pending: 'A BB restart loads the working folder too. Apply or resolve pending local edits first.',
};
function Label({ id }: { id: IntegrationId }) { return <span className="pa-update-label"><Icon name={labels[id][1]} className="pa-update-icon" /><span>{labels[id][0]}</span></span>; }
function RuntimeLabel({ id }: { id: RuntimeId }) { return <span className="pa-update-label"><Icon name={runtimeIcons[id]} className="pa-update-icon" /><span>{runtimeLabels[id]}</span></span>; }
function Checking() { return <span className="pa-update-current"><Icon name="RotateCcw" className="pa-update-spinner" aria-hidden={true} />Checking…</span>; }
function Current({ confirmed, historical = false }: { confirmed: boolean; historical?: boolean }) {
  return historical ? <>Not updated</> : confirmed ? <span className="pa-update-current"><Icon name="Check" className="pa-update-check" aria-hidden={true} />Up to date</span> : <>Couldn’t check</>;
}
function componentState(row: IntegrationInventoryRow) {
  if (row.local === 'custom' || row.development === 'unpublished' || row.workspace?.local)
    return row.workspace?.upstream ? 'both' : 'local';
  if (row.development === 'unknown' || row.state === 'unavailable') return 'unknown';
  if (row.workspace) return codeState(row.workspace, row.applied ?? null);
  return row.state === 'offered' ? 'upstream' : row.state === 'current' && row.local === 'stock' ? 'current' : 'unknown';
}
function CodeStatus({ row, confirmed, historical = false }: { row: IntegrationInventoryRow; confirmed: boolean; historical?: boolean }) {
  const state = componentState(row);
  if (state === 'current') return <Current confirmed={confirmed} historical={historical} />;
  const text = { local: 'Local changes', upstream: 'Updates available', both: 'Local and upstream changes', unapplied: 'Changes ready to apply', unknown: 'Couldn’t check' }[state];
  const unapplied = (state === 'local' || state === 'both') && row.applied && row.workspace && row.applied !== row.workspace.working;
  return <>{text}{unapplied && <span className="pa-updates-muted"> · Not applied</span>}</>;
}
function components(review: ApplicationStatus['review']): IntegrationInventoryRow[] {
  return order.flatMap(id => {
    const inventory = review?.inventory?.find(row => row.id === id), offer = review?.rows.find(row => row.id === id);
    return inventory ? [inventory] : offer ? [{ ...offer, state: 'offered' as const }] : [];
  });
}
function Progress({ value, previous, error }: { value: CheckProgress; previous: ApplicationStatus['review']; error: boolean }) {
  return <div className="pa-update-ordinary" role="group" aria-label="Check progress" aria-live="polite">
    {order.filter(id => !value.integrationsDone || value.integrations.some(row => row.id === id)).map(id => {
      const row = value.integrations.find(row => row.id === id), version = row?.installed ?? components(previous).find(row => row.id === id)?.installed;
      return <div className="pa-update-card pa-update-version" data-check-id={id} key={id}><Label id={id} /><span>{version && <>{version} · </>}{row ? <CodeStatus row={row} confirmed={!error} /> : error ? 'Couldn’t check' : <Checking />}</span></div>;
    })}
    {(Object.keys(runtimeLabels) as RuntimeId[]).filter(id => !value.runtimeDone || value.runtime.some(row => row.id === id)).map(id => {
      const row = value.runtime.find(row => row.id === id), version = row?.installed ?? previous?.runtime?.rows.find(row => row.id === id)?.installed;
      return <div className="pa-update-card pa-update-version" data-check-id={id} key={id}><RuntimeLabel id={id} /><span>{version && <>{version} · </>}{!row ? error ? 'Couldn’t check' : <Checking /> : row.state === 'current' ? <Current confirmed={!error && !!row.installed && !row.reason} /> : row.state === 'ready' ? 'Updates available' : 'Couldn’t check'}</span></div>;
    })}
  </div>;
}
function receiptText(row: NonNullable<ApplicationStatus['job']>['receipts'][number], applying: boolean) {
  return row.outcome === 'kept' ? 'Kept local' : row.outcome === 'skipped' ? 'Not updated' : row.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : row.outcome === 'activating' ? 'Applying…' : row.actual ? `${row.outcome === 'updated' ? 'Applied changes' : 'Unchanged'} · ${row.actual}` : applying ? 'Waiting…' : 'Not updated';
}
export function UpdatesPanel() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [state, setState] = useState<ApplicationStatus | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [confirmInterruptingThreads, setConsent] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const generation = useRef(0), mounted = useRef(true), requestedReview = useRef<string | null>(null);
  async function read() {
    const request = ++generation.current;
    try { const next = await rpc.call('applicationStatus', null); if (mounted.current && request === generation.current) { setState(next); setError(false); } }
    catch { if (mounted.current && request === generation.current) { setError(true); setUnconfirmed(true); } }
  }
  useRealtime('application', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  useEffect(() => { setConsent(false); setUnconfirmed(false); }, [state?.review?.id]);
  const unresolved = !!state?.job && (state.job.receipts.some(row => row.outcome === 'uncertain') && !!state.job.selfIntent && Date.now() - Date.parse(state.job.selfIntent.requestedAt) < 15 * 60_000 || state.job.runtimeReceipts.some(row => row.id === 'bb' && row.outcome === 'uncertain'));
  useEffect(() => {
    if (!busy && !state?.applying && !state?.checking && !unresolved) return;
    const timer = setInterval(() => { void read(); }, 1000); return () => clearInterval(timer);
  }, [busy, state?.applying, state?.checking, unresolved]);
  async function act(action: 'review' | 'apply' | 'applyLocal' | 'resumeSync') {
    if (action === 'review') requestedReview.current = state?.review?.id ?? '';
    setBusy(true); setError(false);
    try {
      if (action === 'applyLocal') { if (state?.review) await rpc.call('applyLocal', { reviewId: state.review.id }); }
      else if (action === 'apply') { if (state?.review) await rpc.call('apply', { reviewId: state.review.id, choices: [], confirmInterruptingThreads }); }
      else await rpc.call(action, null);
      await read();
    } catch { if (mounted.current) { setError(true); setUnconfirmed(true); } }
    finally { requestedReview.current = null; if (mounted.current) setBusy(false); }
  }
  const review = state?.review ?? null, rows = components(review), runtime = review?.runtime;
  const job = state?.job?.reviewId === review?.id ? state?.job : null;
  const progress = state?.checking && state.progress && (!job || state.progress.requested) ? state.progress : null;
  const pending = busy || !!state?.applying || !!state?.checking;
  const failure = progress ? null : state?.failure ?? job?.failure;
  const completedReview = requestedReview.current !== null && review?.id !== requestedReview.current && !state?.checking && !state?.applying;
  const confirmed = !error && !unconfirmed && !state?.failure && (!state?.checking || completedReview) && (requestedReview.current === null || completedReview);
  const historical = !!review && (Date.now() - Date.parse(review.at) >= 6 * 60 * 60_000 || !!state?.offers && state.offers.checkedAt !== review.at);
  const runtimeRows = runtime?.rows ?? [], runtimeOffers = runtimeRows.filter(row => row.state === 'ready' && row.available);
  const sourceReady = !!review?.workspace?.behind && !review.workspace.dirty && !review.workspace.ahead;
  const sourceHeld = !!review?.workspace?.behind && !sourceReady;
  const localCount = review?.localRows?.length ?? 0;
  const count = (review?.rows ?? []).filter(row => reviewDecision(row) === 'automatic' && !row.prerequisite).length + runtimeOffers.length + Number(sourceReady);
  const restarting = runtimeOffers.some(row => row.id === 'bb'), needsConsent = restarting && (runtime?.runningThreadCount ?? 0) > 0;
  const target = progress?.target ?? runtime?.target;
  const local = rows.some(row => ['local', 'both'].includes(componentState(row)));
  const disconnectedLocal = rows.some(row => row.sourceMode === 'managed' && row.workspace?.local && row.applied && row.applied !== row.workspace.working);
  return <section className="pa-updates" aria-label="Update PA">
    <div className="pa-updates-body">
      {(error || failure || pending || job || !review) && <p role="status" aria-live="polite">{error ? 'Update status unavailable' : failure ? 'Update needs attention' : state?.applying ? state.job?.phase === 'restarting' ? 'BB is updating and restarting…' : 'Applying changes…' : pending ? 'Checking…' : job ? job.phase === 'complete' ? 'Update finished' : 'Update needs attention' : 'Check for PA updates'}</p>}
      {error && <p role="alert">Could not read the saved result. Check before retrying; an interrupted response does not mean the operation failed.</p>}
      {failure && <p role="alert">{failures[failure]}</p>}
      {target && <p className="pa-updates-muted">Server: <strong title={target.id}>{target.name}</strong></p>}
      {progress ? <Progress value={progress} previous={review} error={error} /> : <>
        <div className="pa-update-ordinary">{rows.map(row => {
          const receipt = job?.receipts.find(receipt => receipt.id === row.id), offer = review?.rows.find(offer => offer.id === row.id);
          return <div className="pa-update-card pa-update-version" key={row.id}><Label id={row.id} /><span>{receipt ? receiptText(receipt, !!state?.applying) : <>{row.installed === 'unknown' ? 'Version unknown' : row.installed}{offer && reviewDecision(offer) === 'automatic' && offer.available !== row.installed ? <> → <strong>{offer.available}</strong></> : null}{' · '}<CodeStatus row={row} confirmed={confirmed} historical={!!job && historical} /></>}</span></div>;
        })}</div>
        <div className="pa-update-ordinary">{runtimeRows.map(row => {
          const receipt = job?.runtimeReceipts.find(receipt => receipt.id === row.id);
          const result = receipt ? receipt.outcome === 'failed' ? 'Update failed' : receipt.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : receipt.outcome === 'activating' ? 'Updating…' : receipt.actual ? `Installed ${receipt.actual}` : state?.applying ? 'Waiting…' : 'Not updated' : null;
          return <div className="pa-update-card" key={row.id}><div className="pa-update-version"><RuntimeLabel id={row.id} /><span>{result ?? <>{row.installed ?? (row.source === 'missing' ? 'Not installed' : 'Version unknown')}{row.state === 'ready' ? <> → <strong>{row.available}</strong></> : row.state === 'current' ? <> · <Current confirmed={confirmed && !!row.installed && !row.reason} historical={!!job && historical} /></> : ' · Couldn’t check'}</>}</span></div>{!receipt && row.reason && row.reason !== 'unavailable' && <p className="pa-updates-muted">{failures[row.reason]}</p>}</div>;
        })}</div>
        {job?.sourceUpdate && <p className="pa-updates-muted">{job.sourceUpdate.outcome === 'updated' ? 'Working copy updated from origin.' : job.sourceUpdate.outcome === 'held' ? 'Working copy kept. Ask PA to review its local work before pulling updates.' : job.sourceUpdate.outcome === 'uncertain' ? 'Working-copy update uncertain. Ask PA to inspect Git before retrying.' : 'Updating the working copy…'}</p>}
        {!job && sourceHeld && <p className="pa-updates-muted">Origin has updates, but the working copy has local work. Ask PA to review it first.</p>}
        {!job && sourceReady && !rows.some(row => row.workspace?.upstream) && <p className="pa-updates-muted">The working copy has updates from origin.</p>}
        {!job && local && <p className="pa-updates-muted">Local work is kept. Applying does not commit or push it.</p>}
        {!job && disconnectedLocal && <p className="pa-updates-muted">BB is not using the working folder yet, so these local edits cannot be applied here.</p>}
        {!job && restarting && <p>BB will restart. Settings and data stay.</p>}
        {!job && needsConsent && <label className="pa-update-consent"><input type="checkbox" checked={confirmInterruptingThreads} disabled={pending} onChange={event => setConsent(event.target.checked)} /><span>Allow the BB restart to interrupt {runtime?.runningThreadCount} running threads.</span></label>}
      </>}
      {state?.job?.syncReserved && !state.applying && <p role="alert">iCloud remains reserved. Check any uncertain result before resuming. Folders you explicitly paused stay paused.</p>}
    </div>
    <footer>{state?.job?.syncReserved && !state.applying ? <button disabled={pending} onClick={() => void act('resumeSync')}>Resume previously enabled folders</button> : !progress && !job && count > 0 ? <button className="pa-update-primary" disabled={pending || !!failure || error || unconfirmed || needsConsent && !confirmInterruptingThreads} onClick={() => void act('apply')}>Update PA</button> : null}
      {!progress && !job && localCount > 0 && <button className={count ? undefined : 'pa-update-primary'} disabled={pending || !!failure || error || unconfirmed} onClick={() => void act('applyLocal')}>Apply local changes</button>}
      <button type="button" disabled={pending || state?.job?.syncReserved} onClick={() => void act('review')}>{review ? 'Check again' : 'Check for updates'}</button>
    </footer>
  </section>;
}
function UpdateNotice() {
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState();
  const [available, setAvailable] = useState(false), mounted = useRef(true), generation = useRef(0);
  async function read() {
    const request = ++generation.current;
    try { const state = await rpc.call('applicationStatus', null); if (mounted.current && request === generation.current) setAvailable(hasFreshOffers(state)); }
    catch { if (mounted.current && request === generation.current) setAvailable(false); }
  }
  useRealtime('application', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  return available ? <a className="pa-update-notice" href="/settings/plugins/pa-updates"><Icon name="RotateCcw" /> PA update available</a> : null;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'updates', component: UpdatesPanel });
  app.experimental_sidebarFooter.register({ kind: 'action', id: 'updates', label: 'PA updates', icon: 'RotateCcw', onActivate: context => context.openPluginDetails() });
  app.slots.experimental_appOverlay({ id: 'update-notice', component: UpdateNotice });
});
