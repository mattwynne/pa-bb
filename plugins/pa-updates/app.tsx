import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import type { ExperimentalSidebarFooterDisclosureProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { Status, Local } from './core/model.ts';
import './app.css';
const summary: Record<Status['comparison'], string> = {
  first: 'No check yet', no_plugin: 'No supported plugin installed', inventory_unavailable: 'Installed plugins unavailable',
  no_release: 'No published release', current: 'Google Calendar is current', available: 'Google Calendar update available',
  installed_newer: 'Installed version is newer — no downgrade offered', source_mismatch: 'Source differs from the published release',
  revision_unavailable: 'Installed revision unavailable', incompatible: 'Release requirements are not met',
  compatibility_unavailable: 'Could not check release requirements',
};
const localTitle: Record<Local['outcome'], string> = {
  local_changes: 'Local changes found', local_commits: 'Local commits not in release', clean: 'No local changes found',
  not_assessed: 'Local work not assessed', cannot_establish: 'Cannot establish safety',
};
const nextStep: Record<Local['reason'], string> = {
  observed: 'This is a read-only observation, not permission to install.',
  mapping_missing: 'Ask the operator to associate the Calendar development checkout, then check again.',
  no_candidate: 'A published release is needed to compare local commits.',
  unavailable: 'Ask the operator to check Git access and the checkout configuration.',
  unsupported: 'Ask the operator to check the repository layout and Git configuration.',
  target_missing: 'The release commit is not available locally. Ask the operator to make it available outside this check.',
  diverged: 'The checkout and release histories differ. Ask the operator to review the unpublished work.',
  changed: 'Files, the index or HEAD changed during inspection. Check again when editing has stopped.',
  limit: 'Inspection exceeded its time or output limit. Ask the operator to review this checkout.',
  cancelled: 'Inspection stopped. Check again.',
};
const date = (value: string) => new Date(value).toLocaleString();
export function UpdatesPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const rpc = useRpc<typeof rpcContract>(); const connection = useRealtimeConnectionState();
  const [state, setState] = useState<Status | null>(null); const [error, setError] = useState(false); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''); const generation = useRef(0); const mounted = useRef(true);
  async function read() {
    const request = ++generation.current;
    try { const status = await rpc.call('status', null); if (mounted.current && request === generation.current) { setState(status); setError(false); } }
    catch { if (mounted.current && request === generation.current) setError(true); }
  }
  useRealtime('status', () => { void read(); });
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; generation.current++; }; }, [connection]);
  async function check() {
    setBusy(true); setNotice(''); const request = ++generation.current;
    try { const status = await rpc.call('check', null); if (mounted.current && request === generation.current) { setState(status); setError(false); if (status.nextManualAt && Date.parse(status.nextManualAt) > Date.now()) setNotice(`Checks are limited to once a minute. Next check after ${date(status.nextManualAt)}.`); } }
    catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  const observation = state?.observation; const release = observation?.release; const installed = observation?.installed;
  return <section className="pa-updates" aria-label="Google Calendar updates" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } }}>
    <header><strong>Google Calendar updates</strong><button type="button" aria-label="Close PA updates" onClick={dismiss}>×</button></header>
    <div className="pa-updates-body">
      <p role="status" aria-live="polite">{busy || state?.checking ? 'Checking…' : state ? summary[state.comparison] : error ? 'Update status unavailable' : 'Loading check status…'}</p>
      {(error || state?.feedFailure) && <p role="alert">{error ? 'Could not read update status. Check BB and try again.' : `Could not check published releases (${state?.feedFailure}). Check your connection and try again.`}</p>}
      {state?.storageFailure && <p role="alert">Check history could not be stored or read. Ask the operator to check plugin storage before trusting release information.</p>}
      {state?.stale && <p className="pa-updates-warning">Last known release information — stale, not a fresh check.</p>}
      {installed && <p>Installed {installed.version}{release ? ` · Published ${release.plugins[0].version}` : ''}</p>}
      {observation && <div className="pa-updates-local"><h3>Local work</h3><p role="status" aria-live="polite">{localTitle[observation.local.outcome]}</p><p>{observation.local.reason === 'observed' && ['local_changes', 'local_commits'].includes(observation.local.outcome) ? 'Keep your work. Ask the operator to review and publish it before any future update.' : nextStep[observation.local.reason]}</p><p className="pa-updates-muted">Observed {date(observation.local.at)}</p></div>}
      {release && state?.comparison !== 'no_plugin' && <details><summary>Release notes</summary><p className="pa-updates-notes">{release.plugins[0].notes || 'No release notes.'}</p></details>}
      {(installed || release) && state?.comparison !== 'no_plugin' && <details><summary>Source revisions and requirements</summary>
        {installed && <><dl><dt>Installed revision</dt><dd>{installed.revision ?? 'Installed revision unavailable'}</dd></dl>{installed.revision?.length === 12 && <p>BB reports an abbreviated revision. An exact source match cannot be confirmed from it.</p>}</>}
        {release && <><dl><dt>Published revision</dt><dd>{release.sourceCommit}</dd><dt>Declared requirements</dt><dd>BB {release.plugins[0].engines.bb}; SDK {release.plugins[0].engines.bbPluginSdk}</dd></dl><p>Requirements are declarations, not a guarantee for every matching runtime. Verified minimum: BB 0.45.0 / SDK 0.6.15.</p>{observation?.runtime && <p>Checked against BB {observation.runtime.bb} / SDK {observation.runtime.sdk} (installed checker build).</p>}</>}
      </details>}
      {state?.lastSuccess && <p className="pa-updates-muted">Last successful release check: {date(state.lastSuccess)}</p>}
      {state?.lastAttempt && <p className="pa-updates-muted">Most recent attempt: {date(state.lastAttempt)}</p>}
    </div>
    <footer><button type="button" disabled={busy || state?.checking} onClick={() => void check()}>Check again</button>
      {notice && <p role="status">{notice}</p>}
      <p className="pa-updates-muted">Read-only pilot. No installs or restarts. Other PA plugins, BB and Pi are not assessed.</p>
    </footer>
  </section>;
}
export default definePluginApp(app => {
  app.experimental_sidebarFooter.register({ kind: 'disclosure', id: 'updates', label: 'PA updates', icon: 'RotateCcw', component: UpdatesPanel });
});
