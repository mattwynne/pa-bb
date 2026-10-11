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
const failureCopy: Record<string, string> = {
  source_changed: 'Files changed while recovery copies were being made. Sync paused before applying sync changes; existing files and copies are kept for review.',
  capacity: 'Recovery storage is full or the host has too little free space. Sync paused before it could safely continue.',
  authentication: 'Apple authorization needs attention. Reconnect, then have the sync state reviewed before resuming.',
  interrupted: 'The previous run was interrupted. Local files and recovery copies are kept; the baseline needs review.',
  recovery_required: 'The sync records or recovery copies need review. No automatic repair has been attempted.',
};
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
    void act(() => rpc.call('enable', { id }), initial ? 'Initial preparation finished. Check the folder status below.' : 'Sync resumed.');
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
        <div className="pa-icloud__mirror-head"><strong className="pa-icloud__mirror-name"><Icon name="Folder" className="pa-icloud__icon" aria-hidden />{mirror.folder.name}</strong><span role="status">{mirror.phase === 'retained' ? 'Previous mirror kept' : mirror.phase === 'failed' ? 'Needs recovery' : mirror.phase === 'ready' ? 'Sync enabled' : mirror.phase === 'running' ? 'Syncing…' : 'Paused'}</span></div>
        {mirror.phase === 'running' && <SyncProgressView progress={mirror.progress} folderName={mirror.folder.name} />}
        <p>Last successful sync: {mirror.lastSuccess ? new Date(mirror.lastSuccess).toLocaleString() : 'Not yet'}</p>
        {mirror.failure && mirror.phase !== 'retained' && <ConnectionAlert>{failureCopy[mirror.failure] ?? 'The last sync did not complete. Local files and recovery copies are kept; review the sync state before continuing.'}</ConnectionAlert>}
        {mirror.phase === 'retained' ? <p>This previous local folder will not sync again. Any unsent edits remain there for review; integrations can find it in the folder inventory.</p> : mirror.phase === 'failed' && mirror.failure === 'source_changed' ? <ConnectionDisclosure summary="Recovery steps"><p>Ask the host operator to review the unfinished recovery copies and the next safe sync attempt. No automatic repair or retry has been attempted.</p><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure> : mirror.phase === 'failed' ? <ConnectionDisclosure summary="Recovery steps"><p>Reconnect if Apple access expired. You can download a fresh mirror from iCloud while keeping this previous local folder and its unsent edits. This does not repair or resync the previous folder.</p><ConnectionButton tone="secondary" disabled={busy || !state.connected} onClick={() => {
            if (window.confirm('Download a fresh mirror from iCloud and enable syncing for it? The previous local folder and any unsent edits will be kept separately, not merged or uploaded. Review those edits before using the fresh mirror.')) void act(() => rpc.call('rebuild', { id: mirror.id }), 'Check the new mirror below. The previous local folder is kept.');
          }}><Icon name="FolderPlus" fallback="Folder" className="pa-icloud__icon" aria-hidden />Create fresh mirror</ConnectionButton><p>For merging unsent edits or restoring recovery copies, ask the host operator to review them first.</p><ConnectionGuide href={GUIDE}>Recovery guide ↗</ConnectionGuide></ConnectionDisclosure>
          : mirror.enabled ? <ConnectionButton tone="secondary" disabled={busy || mirror.phase === 'running'} aria-label={`Pause ${mirror.folder.name}`} onClick={() => void act(() => rpc.call('pause', { id: mirror.id }))}><Icon name="Pause" className="pa-icloud__icon" aria-hidden />Pause</ConnectionButton>
          : <ConnectionButton tone="primary" disabled={busy || !state.connected || mirror.phase === 'running'} aria-label={`${mirror.initialized ? 'Resume' : 'Enable sync for'} ${mirror.folder.name}`} onClick={() => enable(mirror.id, !mirror.initialized)}><Icon name="Play" className="pa-icloud__icon" aria-hidden />{mirror.initialized ? 'Resume' : 'Enable sync'}</ConnectionButton>}
      </li>)}</ul>
      {state.mirrors.length > 0 && <ConnectionDisclosure summary="Sync and file safety"><p>Sync runs about once a minute. Renames propagate as a new file and a deletion. Conflicting edits keep both versions. Before syncing, BB keeps recovery versions on the host, reusing unchanged verified copies. Versions are retained for 30 days within a 1 GiB budget; if safe backup space runs out, syncing pauses. Large deletions and failed runs require review.</p></ConnectionDisclosure>}
    </>}
    <ConnectionFooter><ConnectionButton tone="secondary" disabled={busy} onClick={() => void refresh()}><Icon name="ArrowReloadHorizontal" fallback="Repeat" className="pa-icloud__icon" aria-hidden />Refresh status</ConnectionButton>
      {state?.connected && <ConnectionButton tone="secondary" disabled={busy} onClick={() => { if (window.confirm('Disconnect Apple and pause all syncing? Local folders and recovery copies remain on the host.')) void act(() => rpc.call('disconnect', null), 'Apple disconnected. Local folders remain available.'); }}><Icon name="CloudOff" fallback="X" className="pa-icloud__icon" aria-hidden />Disconnect</ConnectionButton>}
      {state?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'icloud-sync', component: ICloudSettings }); });
