import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import { PasteBack } from './paste-back.js';
import type { rpcContract } from './contract.js';
import './app.css';

type ConnectionStatus = { connected: boolean; pending: boolean; tools: number };
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/fastmail/docs/setup.md';

function FastmailSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function reload() {
    try { setStatus(await rpc.call('status', null)); setError(''); }
    catch { setError('Could not check the connection. Check BB and try again.'); }
  }
  useEffect(() => { void reload(); }, []);

  async function start() {
    // Open during the user gesture; browsers often block popups opened after an RPC.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(true); setError('');
    try {
      if (!tab) throw new Error('Popup blocked');
      const { url } = await rpc.call('begin', null);
      await reload();
      tab.location.replace(url);
    } catch { tab?.close(); setError('Could not open Fastmail sign-in. Allow popups for BB, then try again.'); }
    finally { setBusy(false); }
  }
  async function finish(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const value = callback; setCallback('');
    try { await rpc.call('finish', { callbackUrl: value }); await reload(); }
    catch {
      setError('That sign-in link was rejected or expired. Start a new connection in BB and repeat Fastmail sign-in.');
      // A failed exchange consumes its one-use state; don't leave a stale form visible.
      try { setStatus(await rpc.call('status', null)); } catch { /* Keep the recovery message. */ }
    }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect Fastmail from this BB installation? Its tools will stop working here. To revoke Fastmail’s grant too, use Fastmail’s account security settings.')) return;
    setBusy(true); setError(''); setCallback('');
    try { await rpc.call('disconnect', null); await reload(); }
    catch { setError('Could not disconnect Fastmail. Check the connection and try again.'); }
    finally { setBusy(false); }
  }

  return <section className="pa-fastmail" aria-label="Fastmail connection">
    {error && <p className="pa-fastmail__alert" role="alert">{error}</p>}
    {!status ? <div className="pa-fastmail__empty">
      <p>{error ? 'Connection status unavailable.' : 'Checking connection…'}</p>
      {error && <button type="button" className="pa-fastmail__button pa-fastmail__button--secondary" onClick={() => void reload()}>Try again</button>}
    </div> : status.connected ? <>
      <div className="pa-fastmail__heading">
        <h3>Connection</h3>
        <span className="pa-fastmail__badge">Connected</span>
      </div>
      <p className="pa-fastmail__account">Account address unavailable from this connection.</p>
      <p className="pa-fastmail__detail">{status.tools} tools ready for new agent sessions.</p>
      <div className="pa-fastmail__actions">
        <button type="button" className="pa-fastmail__button pa-fastmail__button--quiet" onClick={() => void reload()} disabled={busy}>Refresh status</button>
        <button type="button" className="pa-fastmail__button pa-fastmail__button--secondary" onClick={() => void disconnect()} disabled={busy}>Disconnect</button>
      </div>
      <details className="pa-fastmail__more"><summary>Change access</summary><p>Disconnect, then connect again and choose a new grant in Fastmail. Check your account address in Fastmail before approving.</p></details>
    </> : <>
      <h3>{status.pending ? 'Finish connecting' : 'Connect your account'}</h3>
      {status.pending ? <>
        <p className="pa-fastmail__detail">Choose your access in Fastmail. If its return page cannot open localhost, finish here instead.</p>
        <PasteBack callback={callback} busy={busy} onChange={setCallback} onSubmit={finish} />
        <button type="button" className="pa-fastmail__button pa-fastmail__button--quiet" disabled={busy} onClick={() => void start()}>Start sign-in again</button>
      </> : <>
        <ol className="pa-fastmail__steps">
          <li>Open Fastmail sign-in from BB.</li>
          <li>Choose the access you want in Fastmail, including write or send access if needed.</li>
          <li>If localhost does not load afterward, return here to finish the connection.</li>
        </ol>
        <div className="pa-fastmail__actions">
          <button type="button" className="pa-fastmail__button pa-fastmail__button--primary" disabled={busy} onClick={() => void start()}>Connect account</button>
          <a className="pa-fastmail__guide" href={GUIDE} target="_blank" rel="noopener noreferrer">Setup guide ↗</a>
        </div>
      </>}
    </>}
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'fastmail-connection', component: FastmailSettings }); });
