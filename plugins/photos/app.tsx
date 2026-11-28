import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionDisclosure, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.tsx';
import './connection-ui.css';
import './app.css';

const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/photos/README.md';
const HTTP = '/api/v1/plugins/photos/http';
type Status = { apple: 'disconnected' | 'verification' | 'saved'; grain: string | null };
type Entry = { name: string; directory: boolean; size: number | null };
type BrowseView = { listing: string; entries: Entry[]; total: number; path: string[] };

async function submit(path: string, value: object): Promise<Status> {
  const response = await fetch(`${HTTP}/${path}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const reply = await response.json();
  if (!reply.ok) throw new Error(reply.error);
  return reply.status;
}

function ApplePhotos({ state, setStatus, refresh }: { state: Status['apple']; setStatus(value: Status): void; refresh(): Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [view, setView] = useState<BrowseView | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const browserHeading = useRef<HTMLHeadingElement>(null);
  const focusBrowser = useRef(false);

  useEffect(() => {
    if (view && focusBrowser.current) { browserHeading.current?.focus(); focusBrowser.current = false; }
  }, [view]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Try the request again.'); }
    finally { setBusy(false); }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setPassword(''); setPreview(null); setView(null);
    await act(async () => {
      try { setStatus(await submit('apple-connect', { account, password })); setAccount(''); setReconnecting(false); }
      catch (error) { await refresh(); throw error; }
    });
  }

  async function verify(answer: string) {
    setCode('');
    await act(async () => {
      try { setStatus(await submit('apple-verify', { answer })); }
      catch (error) { await refresh(); throw error; }
    });
  }

  async function open(index: number | null, root = false) {
    setPreview(null);
    await act(async () => {
      const parent = view && !root ? { listing: view.listing, index } : null;
      const reply = await rpc.call('browse', { parent });
      if (!reply.ok) throw new Error(reply.error);
      const path = !parent || !view ? [] : index === null ? view.path.slice(0, -1) : [...view.path, view.entries[index].name];
      focusBrowser.current = true;
      setView({ ...reply, path });
    });
  }

  async function more() {
    if (!view) return;
    await act(async () => {
      const reply = await rpc.call('page', { listing: view.listing, offset: view.entries.length });
      if (!reply.ok) throw new Error(reply.error);
      setView({ ...view, entries: [...view.entries, ...reply.entries] });
    });
  }

  async function getFile(index: number, mode: 'download' | 'preview') {
    if (!view) return;
    await act(async () => {
      const reply = await rpc.call('download', { listing: view.listing, index, mode });
      if (!reply.ok) throw new Error(reply.error);
      const url = `${HTTP}/apple-download?ticket=${encodeURIComponent(reply.ticket)}`;
      if (mode === 'preview') setPreview({ name: view.entries[index].name, url });
      else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = view.entries[index].name;
        anchor.referrerPolicy = 'no-referrer';
        anchor.click();
      }
    });
  }

  return <section className="pa-photos__service" aria-label="iCloud Photos">
    <ConnectionHeading title="iCloud Photos" action={state === 'saved' && !reconnecting && <ConnectionButton tone="primary" disabled={busy} onClick={() => void open(null, true)}>Browse library</ConnectionButton>} />
    {busy && <p role="status" className="pa-photos__status">Working…</p>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {state === 'verification' ? <ConnectionSetup title="Verify your Apple account">
      <p>Enter the six-digit code from your trusted Apple device.</p>
      <form className="pa-photos__form" onSubmit={event => { event.preventDefault(); void verify(code); }}>
        <label>Verification code<input type="password" value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
        <div className="pa-photos__actions"><ConnectionButton type="submit" tone="primary" disabled={busy}>Verify</ConnectionButton>
          <ConnectionButton disabled={busy} onClick={() => void verify('sms')}>Send by SMS</ConnectionButton></div>
      </form>
      <ConnectionButton disabled={busy} onClick={() => void act(async () => setStatus(await submit('apple-disconnect', {})))}>Start over</ConnectionButton>
    </ConnectionSetup> : state === 'disconnected' || reconnecting ? <ConnectionSetup title={reconnecting ? 'Reconnect Apple' : 'Connect your Apple account'}>
      <p>Turn on <strong>Access iCloud Data on the Web</strong> on a trusted Apple device, then sign in here.</p>
      <form className="pa-photos__form" onSubmit={event => void signIn(event)}>
        <label>Apple account email<input type="email" value={account} onChange={event => setAccount(event.target.value)} autoComplete="username" maxLength={320} required /></label>
        <label>Apple password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" maxLength={4096} required /></label>
        <div className="pa-photos__actions"><ConnectionButton type="submit" tone="primary" disabled={busy}>Sign in with Apple account</ConnectionButton>
          {reconnecting && <ConnectionButton disabled={busy} onClick={() => { setReconnecting(false); setPassword(''); }}>Cancel</ConnectionButton>}</div>
      </form>
    </ConnectionSetup> : <>
      {!view && <ConnectionAccounts><ConnectionAccount initial="A" label="Apple account" status="Sign-in saved" /></ConnectionAccounts>}
      {view && <div className="pa-photos__browser" aria-label="Photo library browser">
        <div className="pa-photos__actions">
          {view.path.length > 0 && <ConnectionButton disabled={busy} onClick={() => void open(null)}>Up one level</ConnectionButton>}
          <h4 ref={browserHeading} tabIndex={-1} className="pa-photos__path">{view.path.length ? view.path.join(' / ') : 'Photo libraries'}</h4>
        </div>
        {preview && <figure className="pa-photos__preview"><figcaption className="pa-photos__actions"><span>{preview.name}</span>
          <ConnectionButton onClick={() => setPreview(null)}>Close preview</ConnectionButton></figcaption>
          <img src={preview.url} alt={preview.name} referrerPolicy="no-referrer" onError={() => { setError('This photo could not be opened. Try downloading the original.'); setPreview(null); }} />
        </figure>}
        {view.total === 0 ? <ConnectionEmpty>This location is empty.</ConnectionEmpty> : <ul className="pa-photos__items">
          {view.entries.map((entry, index) => <li key={entry.name}>
            {entry.directory ? <ConnectionButton disabled={busy} aria-label={`Open ${entry.name}`} onClick={() => void open(index)}>{entry.name}</ConnectionButton> : <>
              <span>{entry.name}</span><div className="pa-photos__actions">
                {(/\.(?:jpe?g|png|gif|webp)$/i.test(entry.name)) && <ConnectionButton disabled={busy} aria-label={`Preview ${entry.name}`} onClick={() => void getFile(index, 'preview')}>Preview</ConnectionButton>}
                <ConnectionButton disabled={busy} aria-label={`Download ${entry.name}`} onClick={() => void getFile(index, 'download')}>Download</ConnectionButton>
              </div>
            </>}
          </li>)}
        </ul>}
        {view.entries.length < view.total && <ConnectionButton disabled={busy} onClick={() => void more()}>Show more</ConnectionButton>}
      </div>}
      <ConnectionDisclosure summary="Manage Apple connection">
        <div className="pa-photos__actions"><ConnectionButton disabled={busy} onClick={() => { setError(''); setReconnecting(true); }}>Reconnect</ConnectionButton>
          <ConnectionButton disabled={busy} onClick={() => void act(async () => {
            setStatus(await submit('apple-disconnect', {})); setView(null); setPreview(null); setAccount('');
          })}>Disconnect</ConnectionButton></div>
      </ConnectionDisclosure>
    </>}
  </section>;
}

function Grain({ endpoint, setStatus }: { endpoint: string | null; setStatus(value: Status): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(endpoint ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Try the request again.'); }
    finally { setBusy(false); }
  }

  return <section className="pa-photos__service" aria-label="Grain">
    <ConnectionHeading title="Grain" />
    {busy && <p role="status" className="pa-photos__status">Checking Grain…</p>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {editing || !endpoint ? <ConnectionSetup title="Connect a Grain MCP server">
      <p>Enter the HTTPS MCP endpoint for your Grain instance. If the server requires a bearer token, get it from the instance operator.</p>
      <form className="pa-photos__form" onSubmit={event => {
        event.preventDefault(); setToken('');
        void act(async () => { setStatus(await submit('grain-connect', { endpoint: url, token })); setEditing(false); setVerified(true); });
      }}>
        <label>MCP endpoint<input type="url" placeholder="https://photos.example.com/mcp" value={url} onChange={event => setUrl(event.target.value)} maxLength={2048} required /></label>
        <label>Access token (optional)<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} maxLength={4096} /></label>
        <div className="pa-photos__actions"><ConnectionButton type="submit" tone="primary" disabled={busy}>Connect Grain</ConnectionButton>
          {endpoint && <ConnectionButton disabled={busy} onClick={() => { setToken(''); setEditing(false); setError(''); }}>Cancel</ConnectionButton>}</div>
      </form>
    </ConnectionSetup> : <>
      <ConnectionAccounts><ConnectionAccount initial="G" label={new URL(endpoint).host} status={verified ? 'MCP verified' : 'Connection saved'}
        action={<ConnectionButton disabled={busy} onClick={() => void act(async () => {
          setVerified(false);
          const result = await rpc.call('checkGrain', null);
          if (!result.ok) throw new Error(result.error);
          setVerified(true);
        })}>Check connection</ConnectionButton>} /></ConnectionAccounts>
      <ConnectionDisclosure summary="Manage Grain connection"><div className="pa-photos__actions">
        <ConnectionButton disabled={busy} onClick={() => { setUrl(endpoint); setError(''); setEditing(true); }}>Change endpoint</ConnectionButton>
        <ConnectionButton disabled={busy} onClick={() => void act(async () => {
          setStatus(await submit('grain-disconnect', {})); setUrl(''); setVerified(false);
        })}>Disconnect</ConnectionButton>
      </div></ConnectionDisclosure>
    </>}
  </section>;
}

function PhotosSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  async function refresh() {
    try { setStatus(await rpc.call('status', null)); setError(false); }
    catch { setError(true); }
  }
  useEffect(() => { void refresh(); }, []);
  return <div className="pa-photos">
    {error && <ConnectionAlert>Could not read your Photos settings. <ConnectionButton onClick={() => void refresh()}>Try again</ConnectionButton></ConnectionAlert>}
    {status ? <><ApplePhotos state={status.apple} setStatus={next => setStatus(current => current && { ...current, apple: next.apple })} refresh={refresh} />
      <Grain endpoint={status.grain} setStatus={next => setStatus(current => current && { ...current, grain: next.grain })} /></>
      : !error && <ConnectionEmpty><span role="status">Loading settings…</span></ConnectionEmpty>}
    <ConnectionFooter><ConnectionGuide href={GUIDE} /></ConnectionFooter>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'photos-connections', component: PhotosSettings });
});
