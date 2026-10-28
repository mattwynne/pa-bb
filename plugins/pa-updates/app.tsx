import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState, useSdk, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { ApplicationStatus, CheckProgress, IntegrationId, IntegrationInventoryRow, FailureCode, SourceSwitch, SwitchSourceInput, InstalledSource } from './core/application-model.ts';
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
const modeLabel = (target: 'github' | 'local') => target === 'local' ? 'Local development' : 'GitHub';
const installCommand = (id: IntegrationId, target: 'github' | 'local') => target === 'local'
  ? `bb plugin install "path:$HOME/src/pa-bb/plugins/${id}" --yes`
  : `bb plugin install git:https://github.com/mattwynne/pa-bb.git@main --subdirectory plugins/${id} --yes`;
const sourceFailures: Record<NonNullable<SourceSwitch['reason']>, string> = {
  changed: 'The source changed after this check. Check again before confirming a new switch.',
  busy: 'BB is busy. Wait for running operations to finish, then check again.',
  unsupported: 'BB could not confirm support for switching this plugin’s installed source. Check again before trying a new switch.',
  disabled: 'Enable this plugin in BB first, then check again.',
  dependencies_missing: 'In this plugin’s working folder, run npm ci. Then check again and confirm a new switch.',
  unavailable: 'The source could not be verified. Check BB and the standard working folder, then check again.',
  storage: 'The saved result could not be written or read. Resolve storage before continuing.',
  pause_required: 'File-writing folders must be safely paused. Check iCloud and Obsidian before continuing.',
  pause_incomplete: 'Folder pausing is incomplete. Keep folders paused and check their settings before recovery.',
  remove_uncertain: 'Removal is uncertain. Inspect the installed plugin in BB before any manual repair.',
  install_uncertain: 'Installation is uncertain. Inspect the installed plugin in BB before any manual repair.',
  install_failed: 'The source change failed. Check the installed source before trying again.',
  verification_failed: 'The intended source could not be verified. Inspect the installed plugin before manual repair.',
  interrupted: 'The switch was interrupted. Inspect the installed plugin before manual repair; nothing is retried automatically.',
};
const sourceRecoveryNotice = 'Recovery is not verified yet. Check the intended source and wait for active jobs to finish. Nothing was installed or removed by this check. Keep folders paused and follow the manual repair instructions.';
function LocalFacts({ workspace }: { workspace: NonNullable<ApplicationStatus['review']>['workspace'] }) {
  return <p className="pa-update-source-facts">Origin: {workspace?.configuredOrigin ?? 'Unavailable'}{' · '}
    {workspace ? workspace.dirty ? 'Edited files' : 'No edited files' : 'Edited files unknown'}{' · '}
    {workspace?.originComparisonMatches === true ? workspace.ahead ? 'Unpushed commits' : 'No unpushed commits' : 'Unpushed commits unverified'}
  </p>;
}
function SourceConfirmation({ selection, close, confirm }: { selection: SwitchSourceInput; close: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.showModal(); cancel.current?.focus();
    return () => { dialog.current?.close(); opener?.focus(); };
  }, []);
  return <dialog ref={dialog} className="pa-update-dialog" aria-labelledby="pa-source-title" aria-describedby="pa-source-warning" onCancel={close} onClose={close} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <h2 id="pa-source-title">Switch {labels[selection.id][0]} to {modeLabel(selection.target)}?</h2>
    <p id="pa-source-warning">Settings and data stay. BB will reload this plugin from the selected source.</p>
    <p>Source files and commits are kept. Local development runs the working folder, including edited files; nothing is committed, pushed or reset.</p>
    {selection.target === 'local' && <p>Do not edit this plugin until the switch finishes.</p>}
    {(selection.id === 'icloud' || selection.id === 'obsidian') && <p>File-writing folders pause during the switch. Only previously enabled folders resume after verification.</p>}
    {selection.id === 'pa-updates' && <><p>This reloads this page. Keep these instructions outside BB: if the page does not return, check the installed source before running this command on the BB server, then reopen Settings.</p><code>{installCommand(selection.id, selection.target)}</code><p>Local development needs the standard working folder and its dependencies.</p></>}
    <div className="pa-update-dialog-actions"><button ref={cancel} type="button" onClick={close}>Cancel</button><button type="button" className="pa-update-primary" onClick={confirm}>Switch source</button></div>
  </dialog>;
}
function SourceResult({ receipt, pending, recover }: { receipt: SourceSwitch; pending: boolean; recover: () => void }) {
  const active = !['complete', 'attention'].includes(receipt.phase);
  const notStarted = receipt.configuration === 'preserved' && receipt.phase === 'attention' && receipt.reason === 'unsupported' && !receipt.installAdmitted && !receipt.syncReserved && !receipt.manualRecovery;
  return <div className="pa-update-source-result" role="status" aria-live="polite">
    <p><strong>{labels[receipt.id][0]} · {modeLabel(receipt.target)}</strong>{' · '}{active ? 'Switching source…' : receipt.phase === 'complete' ? 'Source switched' : notStarted ? 'Switch did not start' : ['aborted_before_removal', 'original_verified'].includes(receipt.recovery ?? '') ? 'Original source kept' : 'Source switch needs attention'}</p>
    {active && <p>{receipt.installAdmitted ? 'Installing and verifying the intended source. Do not retry.' : 'Preparing the source and saving the result.'}</p>}
    {receipt.phase === 'attention' && !receipt.recovery && receipt.reason && <p>{sourceFailures[receipt.reason]}</p>}
    <p>{receipt.configuration === 'preserved' ? 'Settings and data are kept.' : receipt.configuration === 'deleted' ? 'BB settings, saved credentials and schedules were deleted. Reconnect and reconfigure as needed.' : receipt.configuration === 'possibly_deleted' ? 'BB settings, saved credentials and schedules may have been deleted. Do not assume they were restored.' : 'Settings deletion was planned; no completed reset is confirmed.'} Source files and commits are kept.</p>
    {(receipt.pauseHandoff || receipt.syncReserved) && <p>{receipt.configuration === 'preserved' ? receipt.syncReserved ? 'File-writing folders remain reserved until verification finishes.' : 'The update reservation was released. Only previously enabled folders may resume.' : 'iCloud and Obsidian folders remain paused. Reconfigure before choosing to resume them.'}</p>}
    {receipt.phase === 'attention' && (receipt.manualRecovery || receipt.syncReserved) && <>
      <p>Inspect BB’s installed plugin first. If repair is needed, reinstall the intended {modeLabel(receipt.target)} source on the BB server:</p><code>{installCommand(receipt.id, receipt.target)}</code>
      <p>Then choose Check recovery. It verifies the current source and safe pause cleanup; it never installs, removes or retries. Missing or wrong sources and active jobs cannot be cleared.</p>
      <p>If BB cannot verify an interrupted native operation or pause window, finish any running work and restart BB before checking recovery again.</p>
      <button type="button" disabled={pending} onClick={recover}>Check recovery</button>
    </>}
  </div>;
}
function components(review: ApplicationStatus['review'], sources?: InstalledSource[] | null): IntegrationInventoryRow[] {
  return order.flatMap(id => {
    const inventory = review?.inventory?.find(row => row.id === id), offer = review?.rows.find(row => row.id === id), source = sources?.find(row => row.id === id);
    return inventory ? [inventory] : offer ? [{ ...offer, state: 'offered' as const }] : source ? [{ id, installed: source.installed, local: 'unknown' as const, state: 'unavailable' as const, prerequisite: null }] : [];
  });
}
function sameSource(row: IntegrationInventoryRow, source: InstalledSource | undefined) {
  return !!source?.sourceGeneration && source.sourceGeneration === row.sourceGeneration && source.sourceMode === row.sourceMode && source.sourceEnabled === row.sourceEnabled;
}
function Progress({ value, previous, error }: { value: CheckProgress; previous: ApplicationStatus['review']; error: boolean }) {
  return <div className="pa-update-ordinary" role="group" aria-label="Check progress" aria-live="polite">
    {order.filter(id => !value.integrationsDone || value.integrations.some(row => row.id === id)).map(id => {
      const row = value.integrations.find(row => row.id === id), version = row?.installed ?? components(previous).find(row => row.id === id)?.installed;
      return <div className="pa-update-card pa-update-version" data-check-id={id} key={id}><Label id={id} /><span>{version && <>{version} · </>}{row ? <CodeStatus row={row} confirmed={!error && (row.sourceMode !== 'local' || row.originComparisonMatches === true)} /> : error ? 'Couldn’t check' : <Checking />}</span></div>;
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
  const rpc = useRpc<typeof rpcContract>(), connection = useRealtimeConnectionState(), sdk = useSdk();
  const [state, setState] = useState<ApplicationStatus | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<InstalledSource[] | null>(null), [sourcesChecking, setSourcesChecking] = useState(true);
  const [confirmInterruptingThreads, setConsent] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const [selection, setSelection] = useState<SwitchSourceInput | null>(null), [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const generation = useRef(0), mounted = useRef(true), requestedReview = useRef<string | null>(null), sourceWriting = useRef(false);
  async function read() {
    const request = ++generation.current;
    try {
      const [next, installed] = await Promise.all([rpc.call('applicationStatus', null), rpc.call('installedSources', null).catch(() => null)]);
      if (mounted.current && request === generation.current) { setState(next); setSources(installed); setSourcesChecking(false); setError(false); }
    }
    catch { if (mounted.current && request === generation.current) { setError(true); setUnconfirmed(true); setSources(null); setSourcesChecking(false); } }
  }
  useRealtime('application', () => { void read(); });
  useEffect(() => sdk.subscribe({ event: 'system:changed', callback: event => {
    if (!event.changes.includes('plugins-changed')) return;
    // Close an old confirmation immediately; an external install isn't consent
    // for another write. Refresh native facts only, not the saved update review.
    setSelection(null); setSources(null); setSourcesChecking(true); void read();
  } }), [sdk]);
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  useEffect(() => { setConsent(false); setUnconfirmed(false); setSourceNotice(null); }, [state?.review?.id]);
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
  async function sourceAction(input: SwitchSourceInput | { jobId: string }) {
    if (sourceWriting.current) return;
    sourceWriting.current = true; setSelection(null); setSourceNotice(null); setBusy(true); setError(false);
    try {
      const next = 'jobId' in input ? await rpc.call('acknowledgeSourceRecovery', input) : await rpc.call('switchSource', input);
      if (mounted.current) {
        generation.current++; setState(next);
        if ('jobId' in input && next.sourceSwitch?.phase === 'attention' && (next.sourceSwitch.manualRecovery || next.sourceSwitch.syncReserved)) setSourceNotice(sourceRecoveryNotice);
      }
      await read(); // Admission is not completion. Continue observing the saved receipt.
    } catch {
      if (mounted.current) {
        setUnconfirmed(true);
        setSourceNotice('jobId' in input ? sourceRecoveryNotice : 'The switch response was interrupted. The switch may have been admitted. Inspect the saved result before confirming another switch. Nothing is retried automatically.');
      }
      await read(); // Read only: a lost response may still have a saved, active receipt.
    }
    finally { sourceWriting.current = false; if (mounted.current) setBusy(false); }
  }
  const review = state?.review ?? null, rows = components(review, sources), runtime = review?.runtime;
  const sourcesCurrent = sources !== null && rows.length === sources.length && rows.every(row => sameSource(row, sources.find(source => source.id === row.id)));
  const sourceReceipt = state?.sourceSwitch;
  const sourceBlocked = !!sourceReceipt && (!['complete', 'attention'].includes(sourceReceipt.phase) || sourceReceipt.manualRecovery || sourceReceipt.syncReserved);
  const sourceConsumed = !!review && sourceReceipt?.reviewId === review.id;
  const job = state?.job?.reviewId === review?.id ? state?.job : null;
  const progress = state?.checking && state.progress && (!job || state.progress.requested) ? state.progress : null;
  const pending = busy || !!state?.applying || !!state?.checking;
  const operationBlocked = pending || sourceBlocked;
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
      {job?.phase === 'complete' && !operationBlocked && <p className="pa-updates-muted">Check again to enable source switching.</p>}
      {error && <p role="alert">Could not read the saved result. Check before retrying; an interrupted response does not mean the operation failed.</p>}
      {failure && <p role="alert">{failures[failure]}</p>}
      {sourceReceipt && <SourceResult receipt={sourceReceipt} pending={pending} recover={() => void sourceAction({ jobId: sourceReceipt.jobId })} />}
      {sourceNotice && <p role="status">{sourceNotice}</p>}
      {state && !sources && <p role="status">{sourcesChecking ? 'Checking installed sources…' : 'Installed sources unavailable. Check again before applying or switching.'}</p>}
      {sources && !sourcesCurrent && !progress && <p className="pa-updates-muted" role="status">Installed sources changed since this check. Check again to verify code before applying or switching.</p>}
      {target && <p className="pa-updates-muted">Server: <strong title={target.id}>{target.name}</strong></p>}
      {!progress && rows.some(row => row.sourceSwitchSupported !== true) && <p className="pa-updates-muted">Some source switches could not be verified on this BB and remain disabled.</p>}
      {progress ? <Progress value={progress} previous={review} error={error} /> : <>
        <div className="pa-update-ordinary">{rows.map(row => {
          const receipt = job?.receipts.find(receipt => receipt.id === row.id), offer = review?.rows.find(offer => offer.id === row.id);
          const switched = sourceConsumed && sourceReceipt?.id === row.id ? sourceReceipt : null;
          const currentSource = sources?.find(source => source.id === row.id), sourceCurrent = sameSource(row, currentSource);
          const complete = switched?.phase === 'complete', mode = currentSource?.sourceMode;
          const eligible = sourceCurrent && row.sourceSwitchSupported === true && (mode === 'managed' || mode === 'local') && !!row.sourceGeneration && currentSource?.sourceEnabled === true && !!review?.workspace;
          const next = mode === 'managed' ? 'local' : 'github';
          return <div className="pa-update-card" data-source-id={row.id} key={row.id}>
            <div className="pa-update-version"><Label id={row.id} /><span>{switched ? complete ? <>{switched.actual ?? 'Version unverified'} · Switched to {modeLabel(switched.target)}</> : ['aborted_before_removal', 'original_verified'].includes(switched.recovery ?? '') ? 'Original source kept · Check again' : switched.phase === 'attention' ? 'Source needs attention' : 'Switching source…' : receipt ? receiptText(receipt, !!state?.applying) : <>{(currentSource?.installed ?? row.installed) === 'unknown' ? 'Version unknown' : currentSource?.installed ?? row.installed}{sourceCurrent && offer && reviewDecision(offer) === 'automatic' && offer.available !== row.installed ? <> → <strong>{offer.available}</strong></> : null}{' · '}{sourceCurrent ? <CodeStatus row={row} confirmed={confirmed && (row.sourceMode !== 'local' || row.originComparisonMatches === true)} historical={!!job && historical} /> : sources && !currentSource ? 'Not installed' : 'Code unverified'}</>}</span></div>
            <div className="pa-update-source-line"><span>{mode === 'managed' ? 'GitHub' : mode === 'local' ? 'Local development' : 'Source unavailable'}</span>
              {(mode === 'managed' || mode === 'local') && <button type="button" className="pa-update-source-action" aria-label={`Switch ${labels[row.id][0]} to ${modeLabel(next)}`} disabled={!eligible || !sourcesCurrent || operationBlocked || sourceConsumed || !!job || !!state?.job?.syncReserved || !confirmed} onClick={() => review && setSelection({ reviewId: review.id, id: row.id, target: next, confirmSwitch: true })}>Switch to {modeLabel(next)}</button>}
            </div>
            {mode === 'local' && sourceCurrent && (!switched || complete) && <LocalFacts workspace={review?.workspace} />}
            {currentSource?.sourceEnabled === false ? <p className="pa-update-source-facts">Enable this plugin in BB first, then check again.</p> : sourceCurrent && !eligible && row.sourceSwitchSupported === true && <p className="pa-update-source-facts">{mode === 'unsupported' ? 'This source cannot be switched here.' : 'Check again to verify the source, enablement and standard working folder.'}</p>}
          </div>;
        })}</div>
        <div className="pa-update-ordinary">{runtimeRows.map(row => {
          const receipt = job?.runtimeReceipts.find(receipt => receipt.id === row.id);
          const managedSeparately = row.id === 'bb' && row.reason === 'unsupported_install' && rows.some(row => row.sourceSwitchSupported === true);
          const result = managedSeparately ? `${row.installed ?? 'Version unknown'} · Managed separately` : receipt ? receipt.outcome === 'failed' ? 'Update failed' : receipt.outcome === 'uncertain' ? 'Result uncertain — check before retrying' : receipt.outcome === 'activating' ? 'Updating…' : receipt.actual ? `Installed ${receipt.actual}` : state?.applying ? 'Waiting…' : 'Not updated' : null;
          return <div className="pa-update-card" key={row.id}><div className="pa-update-version"><RuntimeLabel id={row.id} /><span>{result ?? <>{row.installed ?? (row.source === 'missing' ? 'Not installed' : 'Version unknown')}{row.state === 'ready' ? <> → <strong>{row.available}</strong></> : row.state === 'current' ? <> · <Current confirmed={confirmed && !!row.installed && !row.reason} historical={!!job && historical} /></> : ' · Couldn’t check'}</>}</span></div>{!receipt && !managedSeparately && row.reason && row.reason !== 'unavailable' && <p className="pa-updates-muted">{failures[row.reason]}</p>}</div>;
        })}</div>
        {job?.sourceUpdate && <p className="pa-updates-muted">{job.sourceUpdate.outcome === 'updated' ? 'Working copy updated from origin.' : job.sourceUpdate.outcome === 'held' ? 'Working copy kept. Ask PA to review its local work before pulling updates.' : job.sourceUpdate.outcome === 'uncertain' ? 'Working-copy update uncertain. Ask PA to inspect Git before retrying.' : 'Updating the working copy…'}</p>}
        {!job && !sourceConsumed && sourceHeld && <p className="pa-updates-muted">Origin has updates, but the working copy has local work. Ask PA to review it first.</p>}
        {!job && !sourceConsumed && sourceReady && !rows.some(row => row.workspace?.upstream) && <p className="pa-updates-muted">The working copy has updates from origin.</p>}
        {!job && !sourceConsumed && local && <p className="pa-updates-muted">Local work is kept. Applying does not commit or push it.</p>}
        {!job && !sourceConsumed && disconnectedLocal && <p className="pa-updates-muted">BB is not using the working folder yet, so these local edits cannot be applied here.</p>}
        {!job && restarting && <p>BB will restart. Settings and data stay.</p>}
        {!job && needsConsent && <label className="pa-update-consent"><input type="checkbox" checked={confirmInterruptingThreads} disabled={pending} onChange={event => setConsent(event.target.checked)} /><span>Allow the BB restart to interrupt {runtime?.runningThreadCount} running threads.</span></label>}
      </>}
      {state?.job?.syncReserved && !state.applying && <p role="alert">iCloud remains reserved. Check any uncertain result before resuming. Folders you explicitly paused stay paused.</p>}
    </div>
    <footer>{state?.job?.syncReserved && !state.applying ? <button disabled={operationBlocked} onClick={() => void act('resumeSync')}>Resume previously enabled folders</button> : !progress && !job && count > 0 ? <button className="pa-update-primary" disabled={operationBlocked || !sourcesCurrent || sourceConsumed || !!failure || error || unconfirmed || needsConsent && !confirmInterruptingThreads} onClick={() => void act('apply')}>Update PA</button> : null}
      {!progress && !job && localCount > 0 && <button className={count ? undefined : 'pa-update-primary'} disabled={operationBlocked || !sourcesCurrent || sourceConsumed || !!failure || error || unconfirmed} onClick={() => void act('applyLocal')}>Apply local changes</button>}
      <button type="button" disabled={operationBlocked || state?.job?.syncReserved} onClick={() => void act('review')}>{review ? 'Check again' : 'Check for updates'}</button>
    </footer>
    {sourceConsumed && !sourceBlocked && <p className="pa-updates-muted">This review was used for a source switch. Check again before updating or switching another plugin.</p>}
    {selection && <SourceConfirmation selection={selection} close={() => setSelection(null)} confirm={() => { if (!operationBlocked && sourcesCurrent && !sourceConsumed && !job && confirmed && review?.id === selection.reviewId) void sourceAction(selection); else setSelection(null); }} />}
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
