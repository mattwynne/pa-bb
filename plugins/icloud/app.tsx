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
type Status = z.infer<typeof statusSchema>;
type Folder = { id: string; name: string; ancestors: string[] };
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/icloud/docs/setup.md';
type Mirror = Status['mirrors'][number];
function mirrorStatus(mirror: Mirror, connected: boolean) {
  if (mirror.phase === 'retained') return 'Previous mirror kept';
  if (mirror.phase === 'running') return mirror.recovering ? 'Recovering…' : 'Syncing…';
  if (mirror.phase === 'ready') return 'Sync enabled';
  if (mirror.phase === 'paused') return 'Paused';
  if (mirror.blocker === 'reconnect') return connected ? 'Resume required' : 'Reconnect required';
  if (mirror.blocker === 'capacity') return 'Storage blocked';
  if (mirror.blocker === 'configuration') return 'Configuration blocked';
  if (mirror.blocker === 'initialization') return 'Setup blocked';
  if (mirror.blocker === 'rebuild') return 'Recovery required';
  return mirror.retryPending ? 'Retry pending' : 'Sync unsuccessful';
}
function failureMessage(mirror: Mirror, connected: boolean) {
  if (mirror.recovering) return 'A previous attempt did not complete. Rclone is attempting normal recovery. The last successful sync remains unchanged until this run finishes.';
  if (mirror.blocker === 'reconnect') return connected ? 'Apple is connected again. Choose Resume to check and sync this folder. The local copy may be stale.' : 'Apple authorization needs attention. Reconnect, then choose Resume for this folder. The local copy may be stale.';
  if (mirror.blocker === 'capacity') return 'Sync stopped because recovery storage or host free space is insufficient. A fresh mirror is not a capacity fix. The local copy may be stale.';
  if (mirror.blocker === 'configuration') return 'Sync stopped because the host or rclone configuration needs attention. The local copy may be stale.';
  if (mirror.blocker === 'initialization') return 'Initial preparation did not complete. This folder will not sync until you choose a supported recovery path.';
  if (mirror.blocker === 'rebuild') return 'Rclone cannot safely continue this mirror automatically. The local folder, unsent edits and recovery copies are kept; the local copy may be stale.';
  if (mirror.retryPending && mirror.failure === 'interrupted') return 'Sync was interrupted. Rclone will attempt recovery on the next scheduled run. The local copy may be stale.';
  if (mirror.retryPending && mirror.failure === 'source_changed') return 'Files changed while recovery copies were being made. BB will make fresh recovery copies and retry on the next schedule. The local copy may be stale.';
  if (mirror.retryPending) return 'The last sync did not complete. BB will retry the ordinary protected sync on the next schedule. The local copy may be stale.';
  return 'The last sync did not complete and automatic retries are paused. Retry uses the ordinary recovery-copy and rclone safety checks; it does not force resync.';
}
function ICloudSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [loadError, setLoadError] = useState(''); const [notice, setNotice] = useState('');
  const [account, setAccount] = useState(''); const [password, setPassword] = useState(''); const [answer, setAnswer] = useState('');
  const [reconnect, setReconnect] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null); const [trail, setTrail] = useState<Folder[]>([]);
  const [browsing, setBrowsing] = useState(false); const browseRequest = useRef(0);
  const polling = useRef(false);
  async function refresh(quiet = false) {
    try { setState(await rpc.call('status', null)); setLoadError(''); if (!quiet) setError(''); }
    catch { setLoadError('Could not load iCloud status. Check BB and try again.'); }
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
    try { setState(await operation()); setNotice(message); }
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
      setState(result); if (result.connected) { setReconnect(false); setAccount(''); setFolders(null); setTrail([]); }
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
    if (initial && !window.confirm('Enable two-way sync for this folder? BB will download its files, then send local edits and deletions back to iCloud about once a minute. Both conflicting versions and bounded recovery copies are kept.')) return;
    void act(() => rpc.call('enable', { id }));
  }
  function rebuild(id: string) {
    if (!window.confirm('Download a fresh mirror from iCloud and enable syncing for it? The previous local folder and any unsent edits will be kept separately, not merged or uploaded. Review those edits before using the fresh mirror.')) return;
    void act(() => rpc.call('rebuild', { id }));
  }
  return <section className="pa-icloud" aria-label="iCloud connection and synced folders">
    <ConnectionHeading title={!state ? 'Connection' : state.challenge ? 'Finish connecting' : state.connected ? 'Connected' : 'Get started'}
      action={state?.connected && <ConnectionButton tone="secondary" disabled={busy} onClick={() => { setReconnect(true); closeBrowser(); }}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Reconnect</ConnectionButton>} />
    {(error || loadError) && <ConnectionAlert>{error || loadError}</ConnectionAlert>}
    {notice && <p role="status">{notice}</p>}
    {!state ? <ConnectionEmpty>{loadError ? 'Connection status unavailable.' : 'Loading connection…'}</ConnectionEmpty> : <>
      {!state.available && <ConnectionAlert>{state.prerequisite}</ConnectionAlert>}
      {(!state.connected || reconnect || state.challenge) && <ConnectionSetup title={state.challenge ? 'Enter your Apple verification code' : 'Connect your Apple account'}>
        {!state.challenge && <ol><li>Check that <strong>Access iCloud Data on the Web</strong> is enabled in Apple’s iCloud settings.</li><li>Enter your ordinary Apple account password below. Apple will ask you to approve the sign-in and enter a verification code.</li><li>After connecting, choose a folder. Nothing syncs until you enable it.</li></ol>}
        <form className="pa-icloud__form" onSubmit={event => void submit(event)}>
          {state.challenge ? <><label htmlFor="icloud-code">Verification code</label><input id="icloud-code" type="password" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={answer} onChange={event => setAnswer(event.target.value)} /><p>Approve the sign-in on a trusted Apple device, then enter its six-digit code.</p></> : <>
            <label htmlFor="icloud-account">Apple account email</label><input id="icloud-account" type="email" autoComplete="username" required maxLength={320} value={account} onChange={event => setAccount(event.target.value)} />
            <label htmlFor="icloud-password">Apple password</label><input id="icloud-password" type="password" autoComplete="current-password" required maxLength={4096} value={password} onChange={event => setPassword(event.target.value)} />
          </>}
          <ConnectionButton type="submit" tone="primary" disabled={busy || !state.available}>{busy ? 'Connecting…' : state.challenge ? 'Verify code' : 'Connect account'}</ConnectionButton>
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
        <p>Last successful sync: {mirror.lastSuccess ? new Date(mirror.lastSuccess).toLocaleString() : 'Not yet'}</p>
        {mirror.failure && mirror.phase !== 'retained' && <ConnectionAlert>{failureMessage(mirror, state.connected)}</ConnectionAlert>}
        {mirror.phase === 'retained' ? <p>This previous local folder will not sync again. Any unsent edits remain there for review; integrations can find it in the folder inventory.</p>
          : mirror.phase === 'failed' && mirror.blocker === 'reconnect' ? <ConnectionDisclosure summary="Recovery steps"><p>{state.connected ? 'Resume uses the ordinary recovery-copy and rclone safety checks.' : 'Reconnect Apple in BB. After authorization succeeds, choose Resume; reconnection alone does not restart syncing.'}</p>{state.connected && <ConnectionButton tone="primary" disabled={busy} aria-label={`Resume ${mirror.folder.name}`} onClick={() => enable(mirror.id, false)}><Icon name="Play" className="pa-icloud__icon" aria-hidden />Resume</ConnectionButton>}<ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && (mirror.blocker === 'capacity' || mirror.blocker === 'configuration') ? <ConnectionDisclosure summary="Recovery steps"><p>{mirror.blocker === 'capacity' ? 'Fix recovery storage first. Ask the host operator if needed, then Retry.' : 'Fix the supported rclone and host configuration first. Ask the host operator if needed, then Retry.'}</p><ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`Retry ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('retry', { id: mirror.id }))}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Retry sync</ConnectionButton><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && (mirror.blocker === 'initialization' || mirror.blocker === 'rebuild') ? <ConnectionDisclosure summary="Recovery steps"><p>Create a fresh mirror only if you want a new local view downloaded from current iCloud. The previous local folder and unsent edits stay separate; this does not merge or repair them.</p><ConnectionButton tone="primary" disabled={busy || !state.connected} onClick={() => rebuild(mirror.id)}><Icon name="FolderPlus" fallback="Folder" className="pa-icloud__icon" aria-hidden />Create fresh mirror</ConnectionButton><p>For merging unsent edits or restoring recovery copies, ask the host operator to review them first.</p><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.phase === 'failed' && mirror.blocker === null ? mirror.retryPending ? <ConnectionButton tone="secondary" disabled={busy} aria-label={`Pause ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}><Icon name="Pause" className="pa-icloud__icon" aria-hidden />Pause</ConnectionButton> : <ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`Retry ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('retry', { id: mirror.id }))}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Retry sync</ConnectionButton>
          : mirror.phase === 'running' ? <p>Sync controls are available when this run finishes.</p>
          : mirror.enabled ? <ConnectionButton tone="secondary" disabled={busy} aria-label={`Pause ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}><Icon name="Pause" className="pa-icloud__icon" aria-hidden />Pause</ConnectionButton>
          : <ConnectionButton tone="primary" disabled={busy || !state.connected} aria-label={`${mirror.initialized ? 'Resume' : 'Enable sync for'} ${mirror.folder.name}`} onClick={() => enable(mirror.id, !mirror.initialized)}><Icon name="Play" className="pa-icloud__icon" aria-hidden />{mirror.initialized ? 'Resume' : 'Enable sync'}</ConnectionButton>}
      </li>)}</ul>
      {state.mirrors.length > 0 && <ConnectionDisclosure summary="Sync and file safety"><p>Sync runs about once a minute. Renames propagate as a new file and a deletion. Conflicting edits keep both versions. Before syncing, BB keeps recovery versions on the host, reusing unchanged verified copies. Versions are retained for 30 days within a 1 GiB budget; if safe backup space runs out, syncing stops. Temporary failures remain visible and retry on the normal schedule unless you Pause. Critical, configuration and recovery-data failures stay stopped.</p></ConnectionDisclosure>}
    </>}
    <ConnectionFooter><ConnectionButton tone="secondary" disabled={busy} onClick={() => void refresh()}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Refresh status</ConnectionButton>
      {state?.connected && <ConnectionButton tone="secondary" disabled={busy} onClick={() => { if (window.confirm('Disconnect Apple and pause all syncing? Local folders and recovery copies remain on the host.')) void act(() => rpc.call('disconnect', null), 'Apple disconnected. Local folders remain available.'); }}><Icon name="CloudOff" fallback="X" className="pa-icloud__icon" aria-hidden />Disconnect</ConnectionButton>}
      {state?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'icloud-sync', component: ICloudSettings }); });
