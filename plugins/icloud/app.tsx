import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRpc, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import type { rpcContract, statusSchema } from './contract.js';
import { ConnectionHeading, ConnectionButton, ConnectionAlert, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionSetup, ConnectionDisclosure } from './connection-ui.js';
import { FolderBrowser } from './folder-browser.js';
import { SyncProgressView } from './sync-progress.js';
import './connection-ui.css';
import './app.css';
import { ICloudAttention, useInlineAttention, attentionCopy } from './attention-ui.tsx';
type Status = z.infer<typeof statusSchema>;
type Folder = { id: string; name: string; ancestors: string[] };
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/icloud/docs/setup.md';
type Mirror = Status['mirrors'][number];
function mirrorStatus(mirror: Mirror, connected: boolean) {
  if (mirror.phase === 'retained') return 'Previous mirror kept';
  if (mirror.phase === 'running' && mirror.blocker === 'rebuild') return 'Continuing interrupted sync…';
  if (mirror.phase === 'running') return mirror.recovering ? 'Retrying…' : 'Syncing…';
  if (mirror.phase === 'ready') return 'Sync enabled';
  if (mirror.phase === 'paused') return 'Paused';
  if (mirror.blocker === 'reconnect') return connected ? 'Resume required' : 'Reconnect required';
  if (mirror.blocker === 'capacity') return 'Storage blocked';
  if (mirror.blocker === 'configuration') return 'Configuration blocked';
  if (mirror.blocker === 'initialization') return 'Setup blocked';
  if (mirror.blocker === 'rebuild') return 'Recovery required';
  return mirror.retryPending ? 'Retry pending' : 'Sync unsuccessful';
}
function failureMessage(mirror: Mirror, connected: boolean, issue?: string) {
  if (mirror.blocker === 'reconnect' && issue === 'provider_rejected') return 'Apple returned HTTP 421. Cloud retries are held; sign-in may help, but expiry is not confirmed. Review the connection before resuming.';
  if (mirror.phase === 'running' && mirror.blocker === 'rebuild') return 'Checking the existing mirror and continuing only verified interrupted copies. Local note access stays paused until all recovery checks pass.';
  if (mirror.recovering) return 'The previous attempt did not complete. Retrying with rclone’s normal checks. The last successful sync changes only when this run finishes.';
  if (mirror.blocker === 'reconnect') return connected ? 'Apple is connected again. Choose Resume to check and sync this folder.' : 'Apple authorization needs attention. Reconnect, then choose Resume for this folder.';
  if (mirror.blocker === 'capacity') return 'Sync stopped because host storage or transfer capacity needs attention. A fresh mirror is not a capacity fix.';
  if (mirror.blocker === 'configuration') return 'Sync stopped because the host or rclone configuration needs attention.';
  if (mirror.blocker === 'initialization') return 'Initial preparation did not complete. This folder will not sync until you choose a supported recovery path.';
  if (mirror.blocker === 'rebuild') return 'Sync needs recovery checks. Local notes and unsent edits are kept. Continue checks whether this mirror can safely finish; otherwise it stays stopped.';
  if (mirror.retryPending && mirror.failure === 'interrupted') return 'Sync was interrupted. BB will retry with rclone’s normal checks on the next scheduled run.';
  if (mirror.retryPending && mirror.failure === 'source_changed') return 'Files changed during the previous attempt. BB will retry on the next schedule.';
  if (mirror.retryPending) return 'The last sync did not complete. BB will retry with rclone’s normal checks on the next schedule.';
  return 'The last sync did not complete and automatic retries are paused. Retry uses rclone’s normal checks; it does not force resync.';
}
function ICloudSettings() {
  const rpc = useRpc<typeof rpcContract>();
  useInlineAttention();
  const [attentionBusy, setAttentionBusy] = useState(false);
  const [state, setState] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [notice, setNotice] = useState('');
  const [account, setAccount] = useState(''); const [password, setPassword] = useState(''); const [answer, setAnswer] = useState('');
  const [reconnect, setReconnect] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null); const [trail, setTrail] = useState<Folder[]>([]);
  const [browsing, setBrowsing] = useState(false); const browseRequest = useRef(0);
  const polling = useRef(false);
  async function refresh(quiet = false) {
    try { setState(await rpc.call('status', null)); setLoadError(''); if (!quiet) setError(''); }
    catch { setLoadError('Status unavailable. Showing last-known status, not a new connection check. Check BB and refresh.'); }
  }
  const pollMs = busy || state?.mirrors.some(mirror => mirror.phase === 'running') ? 1_000 : 15_000;
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (polling.current) return;
      polling.current = true; void refresh(true).finally(() => { polling.current = false; });
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [pollMs]);
  async function act(operation: () => Promise<Status>, message = '') {
    setBusy(true); setError(''); setNotice('');
    try { setState(await operation()); if (message) setNotice(message); }
    catch { setError('The action did not complete. Refresh status; if a sync failed, review recovery before trying again.'); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const step = state?.challenge ? 'challenge' : 'connect';
    const value = step === 'challenge' ? { answer } : { account, password };
    // Clear secrets promptly; retain neither in application storage nor RPC history.
    setPassword(''); setAnswer('');
    try {
      const response = await fetch(`/api/v1/plugins/icloud/http/${step}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      const result = await response.json();
      if (!response.ok) throw new Error();
      setState(result); if (result.connected) { setNotice('Apple connected again. Sign-in and a connection check succeeded. No sync was started. Paused folders and recovery stops are unchanged.'); setReconnect(false); setAccount(''); setFolders(null); setTrail([]); }
    } catch { setError('Apple setup did not complete. Check your password or code, or start connecting again. Use your ordinary Apple password, not an app-specific password.'); }
    finally { setBusy(false); }
  }
  async function browse(next: Folder[]) {
    const request = ++browseRequest.current;
    setBusy(true); setBrowsing(true); setError('');
    try {
      const result = await rpc.call('browse', { parent: next.at(-1)?.id ?? null });
      if (request === browseRequest.current) { setFolders(result); setTrail(next); }
    } catch { if (request === browseRequest.current) setError('Could not list iCloud folders. A sync may still be running; wait for it to finish, then try again.'); }
    finally { setBusy(false); setBrowsing(false); }
  }
  function closeBrowser() { browseRequest.current++; setFolders(null); setTrail([]); }
  function enable(id: string, initial: boolean) {
    if (initial && !window.confirm('Enable two-way sync for this folder? BB will download its files, then send local edits and deletions back to iCloud about once a minute. Both conflicting versions are kept, but BB does not back up overwritten or deleted files.')) return;
    void act(() => rpc.call('enable', { id }));
  }
  function rebuild(id: string) {
    if (!window.confirm('Download a fresh mirror from iCloud and enable syncing for it? The previous local folder and any unsent edits will be kept separately, not merged or uploaded. Review those edits before using the fresh mirror.')) return;
    void act(() => rpc.call('rebuild', { id }));
  }
  return <section className="pa-icloud" aria-label="iCloud connection and synced folders">
    <ConnectionHeading title={!state ? 'Connection' : state.challenge ? 'Finish connecting' : state.connected ? 'Connected' : 'Get started'}
      action={state?.connected && !state.attention && <ConnectionButton tone="secondary" disabled={busy} onClick={() => { setReconnect(true); closeBrowser(); }}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Reconnect</ConnectionButton>} />
    {(error || loadError) && <ConnectionAlert>{error || loadError}</ConnectionAlert>}
    {notice && <p role="status">{notice}</p>}
    {!state ? <ConnectionEmpty>{loadError ? 'Connection status unavailable.' : 'Loading connection…'}</ConnectionEmpty> : <>
      {state.connectionCheck === 'unavailable' && (!state.attention || state.attention.stage === 'reminder') && <p role="status">Connection check unavailable. Showing the last-known connection; sign-in expiry is not confirmed.</p>}
      {!state.available && <ConnectionAlert>{state.prerequisite}</ConnectionAlert>}
      {state.attention && <aside className="pa-icloud__attention" aria-label={attentionCopy(state.attention.stage).title}>
        <strong>{attentionCopy(state.attention.stage).title}</strong>
        <p>{attentionCopy(state.attention.stage).description}</p>
        <div className="pa-icloud__attention-actions">
          {state.connected && !reconnect && <ConnectionButton tone="primary" disabled={busy} onClick={() => { setReconnect(true); closeBrowser(); }}>Reconnect Apple</ConnectionButton>}
          <ConnectionButton tone="secondary" disabled={attentionBusy || !!state.attention.snoozedUntil} onClick={() => {
            setAttentionBusy(true); setError('');
            void rpc.call('attentionAction', { generation: state.attention!.generation, action: 'snooze' }).then(async saved => {
              if (!saved) throw new Error();
              await refresh(true);
            }).catch(() => setError('Could not save the reminder. It has not been snoozed.')).finally(() => setAttentionBusy(false));
          }}>{state.attention.snoozedUntil ? 'Reminder snoozed until tomorrow' : 'Remind tomorrow'}</ConnectionButton>
        </div>
      </aside>}
      <ConnectionDisclosure summary="Sign-in reminders">
        <p>Last verified sign-in: {state.lastSignInCompletedAt ? new Date(state.lastSignInCompletedAt).toLocaleString() : 'Unknown — no verified date recorded'}.</p>
        <p>BB estimates a renewal reminder after 25 days, not an expiry date. Age alone never pauses sync. Reminders appear only while BB is open; no device notifications are sent.</p>
      </ConnectionDisclosure>
      {(!state.connected || reconnect || state.challenge) && <ConnectionSetup title={state.challenge ? 'Enter your Apple verification code' : 'Connect your Apple account'}>
        {!state.challenge && <ol><li>Check that <strong>Access iCloud Data on the Web</strong> is enabled in Apple’s iCloud settings.</li><li>Enter your ordinary Apple account password below. Apple will ask you to approve the sign-in and enter a verification code.</li><li>After connecting, choose a folder. Nothing syncs until you enable it.</li></ol>}
        <form className="pa-icloud__form" onSubmit={event => void submit(event)}>
          {state.challenge ? <><label htmlFor="icloud-code">Verification code</label><input id="icloud-code" type="password" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={answer} onChange={event => setAnswer(event.target.value)} /><p>Approve the sign-in on a trusted Apple device, then enter its six-digit code.</p></> : <>
            <label htmlFor="icloud-account">Apple account email</label><input id="icloud-account" type="email" autoComplete="username" required maxLength={320} value={account} onChange={event => setAccount(event.target.value)} />
            <label htmlFor="icloud-password">Apple password</label><input id="icloud-password" type="password" autoComplete="current-password" required maxLength={4096} value={password} onChange={event => setPassword(event.target.value)} />
          </>}
          <ConnectionButton type="submit" tone="primary" disabled={busy || !state.available}>{busy ? state.challenge ? 'Verifying…' : 'Connecting…' : state.challenge ? 'Verify code' : 'Connect account'}</ConnectionButton>
          {state.challenge && <ConnectionButton disabled={busy} onClick={() => void act(() => rpc.call('disconnect', null))}>Cancel setup</ConnectionButton>}
          {reconnect && state.connected && <ConnectionButton tone="secondary" disabled={busy} onClick={() => setReconnect(false)}><Icon name="X" className="pa-icloud__icon" aria-hidden />Cancel</ConnectionButton>}
        </form>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>}
      {state.connected && !reconnect && <>
        <ConnectionHeading title="Folders" action={<ConnectionButton tone="secondary" disabled={busy} onClick={() => void browse([])}><Icon name="FolderPlus" fallback="Folder" className="pa-icloud__icon" aria-hidden />{browsing && !folders ? 'Loading folders…' : 'Choose a folder'}</ConnectionButton>} />
        {!state.mirrors.length && !folders && <ConnectionEmpty>No folders selected. Choose a folder to make it available to BB.</ConnectionEmpty>}
        {folders && <FolderBrowser folders={folders} trail={trail} selected={state.mirrors} busy={busy} loading={browsing}
          onBrowse={next => void browse(next)} onSelect={folder => void act(() => rpc.call('select', { folderId: folder.id }), 'Folder selected. Enable sync when you are ready.')} onClose={closeBrowser} />}
      </>}
      <ul className="pa-icloud__mirrors">{state.mirrors.map(mirror => <li key={mirror.id}>
        <div className="pa-icloud__mirror-head"><strong className="pa-icloud__mirror-name"><Icon name="Folder" className="pa-icloud__icon" aria-hidden />{mirror.folder.name}</strong><span role="status">{mirrorStatus(mirror, state.connected)}</span></div>
        {mirror.phase === 'running' && <SyncProgressView progress={mirror.progress} folderName={mirror.folder.name} />}
        <p>Last successful host sync finished: {mirror.lastSuccess ? new Date(mirror.lastSuccess).toLocaleString(undefined, { timeZoneName: 'short' }) : 'No successful sync recorded (never synced or history unknown)'}</p>
        {mirror.failure && mirror.phase !== 'retained' && (mirror.recovering || mirror.retryPending
          ? <p role="status">{failureMessage(mirror, state.connected, state.attention?.stage)}</p>
          : <ConnectionAlert>{failureMessage(mirror, state.connected, state.attention?.stage)}</ConnectionAlert>)}
        {mirror.phase === 'failed' && mirror.initialized && mirror.blocker === 'rebuild' && <ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`Continue interrupted sync for ${mirror.folder.name}`} onClick={() => void act(async () => {
          const next = await rpc.call('continueInterrupted', { id: mirror.id });
          const result = next.mirrors.find(item => item.id === mirror.id);
          const passed = result && result.initialized && result.blocker === null && result.failure === null && ['ready', 'paused'].includes(result.phase);
          setNotice(passed ? 'Continuation checks passed. Preserved conflicts still need review.' : 'Continuation did not complete. The mirror remains stopped; saved edits are unchanged.');
          return next;
        })}>Continue interrupted sync</ConnectionButton>}
        {mirror.phase === 'retained' ? <p>This previous local folder will not sync again. Any unsent edits remain there for review; integrations can find it in the folder inventory.</p>
          : mirror.phase === 'failed' && mirror.blocker === 'reconnect' ? <ConnectionDisclosure summary="Recovery steps"><p>{state.connected ? 'Resume uses rclone’s normal checks.' : 'Reconnect Apple in BB. After authorization succeeds, choose Resume; reconnection alone does not restart syncing.'}</p>{state.connected && <ConnectionButton tone="primary" disabled={busy} aria-label={`Resume ${mirror.folder.name}`} onClick={() => enable(mirror.id, false)}><Icon name="Play" className="pa-icloud__icon" aria-hidden />Resume</ConnectionButton>}<ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && (mirror.blocker === 'capacity' || mirror.blocker === 'configuration') ? <ConnectionDisclosure summary="Recovery steps"><p>{mirror.blocker === 'capacity' ? 'Fix host storage or transfer capacity first. Ask the host operator if needed, then Retry.' : 'Fix the supported rclone and host configuration first. Ask the host operator if needed, then Retry.'}</p><ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`Retry ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('retry', { id: mirror.id }))}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Retry sync</ConnectionButton><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && (mirror.blocker === 'initialization' || mirror.blocker === 'rebuild') ? <ConnectionDisclosure summary="Recovery details and other options">{mirror.initialized && mirror.blocker === 'rebuild' && <><p>Continue interrupted sync verifies saved checkpoints and native conflict copies before one ordinary sync. It does not force resync or choose a winning version. If all checks pass, review preserved versions in the existing note conflict review. Scheduling resumes only if it was enabled.</p><p>If this remains stopped, preserve the files and ask the host operator to inspect recovery diagnostics. A fresh mirror is a separate option, not a repair.</p></>}<p>Create a fresh mirror only if you want a new local view downloaded from current iCloud. The previous local folder and unsent edits stay separate; this does not merge or repair them.</p><ConnectionButton tone="secondary" disabled={busy || !state.connected} onClick={() => rebuild(mirror.id)}><Icon name="FolderPlus" fallback="Folder" className="pa-icloud__icon" aria-hidden />Create fresh mirror</ConnectionButton><p>For merging unsent edits or restoring previously saved versions, ask the host operator to review them first.</p><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && mirror.blocker === null ? mirror.retryPending ? <ConnectionButton tone="secondary" disabled={busy} aria-label={`Pause ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}><Icon name="Pause" className="pa-icloud__icon" aria-hidden />Pause</ConnectionButton> : <ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`Retry ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('retry', { id: mirror.id }))}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Retry sync</ConnectionButton>
          : mirror.phase === 'running' ? <p>Sync controls are available when this run finishes.</p>
          : mirror.enabled ? <ConnectionButton tone="secondary" disabled={busy} aria-label={`Pause ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}><Icon name="Pause" className="pa-icloud__icon" aria-hidden />Pause</ConnectionButton>
          : <ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`${mirror.initialized ? 'Resume' : 'Enable sync for'} ${mirror.folder.name}`} onClick={() => enable(mirror.id, !mirror.initialized)}><Icon name="Play" className="pa-icloud__icon" aria-hidden />{mirror.initialized ? 'Resume' : 'Enable sync'}</ConnectionButton>}
        {mirror.phase !== 'running' && mirror.phase !== 'retained' && mirror.blocker !== null && mirror.enabled && <ConnectionButton tone="secondary" disabled={busy} aria-label={`Pause scheduling for ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}>Pause scheduling</ConnectionButton>}
        {!mirror.enabled && mirror.phase === 'failed' && <p>Scheduling is paused. The recovery reason and saved edits are unchanged.</p>}
      </li>)}</ul>
      {state.mirrors.length > 0 && <ConnectionDisclosure summary="Sync and file safety"><p>Sync runs about once a minute. Renames propagate as a new file and a deletion. Conflicting edits keep both versions. Rclone handles change detection, deletion checks and interrupted-sync recovery. BB does not create whole-folder backups or provide undo for overwrites and deletions. Previously saved recovery copies are left untouched. Temporary failures remain visible and retry on the normal schedule unless you Pause. Critical, storage and configuration failures stay stopped.</p></ConnectionDisclosure>}
    </>}
    <ConnectionFooter><ConnectionButton tone="secondary" onClick={() => void refresh()}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Refresh status</ConnectionButton>
      {state?.connected && <ConnectionButton tone="secondary" disabled={busy} onClick={() => { if (window.confirm('Disconnect Apple and pause all syncing? Local folders and any previously saved recovery copies remain on the host.')) void act(() => rpc.call('disconnect', null), 'Apple disconnected. Local folders remain available.'); }}><Icon name="CloudOff" fallback="X" className="pa-icloud__icon" aria-hidden />Disconnect</ConnectionButton>}
      {state?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'icloud-sync', component: ICloudSettings });
  // Missing optional mount leaves inline Settings notices; supported minimum is BB 0.49.
  app.slots.experimental_appOverlay?.({ id: 'icloud-attention', component: ICloudAttention });
});
