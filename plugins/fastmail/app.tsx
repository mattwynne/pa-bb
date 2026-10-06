import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import { PasteBack } from './paste-back.js';
import type { rpcContract } from './contract.js';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionDisclosure, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.js';
import './connection-ui.css';
import './app.css';

type ConnectionStatus = { connected: boolean; pending: boolean; defaultSendingAddress: string | null };
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
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {!status ? <ConnectionEmpty>
      <span>{error ? 'Connection status unavailable.' : 'Checking connection…'}</span>
      {error && <ConnectionButton tone="secondary" onClick={() => void reload()}>Try again</ConnectionButton>}
    </ConnectionEmpty> : status.connected ? <>
      <ConnectionHeading title="Connected account" />
      <ConnectionAccounts><ConnectionAccount initial={status.defaultSendingAddress?.[0]?.toUpperCase() ?? 'F'}
        label={status.defaultSendingAddress ?? 'Default sending address unavailable'} unavailable={!status.defaultSendingAddress}
        caption={status.defaultSendingAddress ? 'Default sending address · login may differ' : undefined} status="Connected"
        action={<ConnectionButton disabled={busy} aria-label="Disconnect Fastmail account" onClick={() => void disconnect()}>Disconnect</ConnectionButton>} /></ConnectionAccounts>
      <ConnectionDisclosure summary="Change access"><p>Disconnect, then reconnect with a different Fastmail grant. Verify your account in Fastmail before approving.</p></ConnectionDisclosure>
    </> : status.pending ? <>
      <ConnectionHeading title="Finish connecting" />
      <ConnectionSetup title="Return from Fastmail">
        <p>If the localhost page did not open, paste its address below.</p>
        <PasteBack callback={callback} busy={busy} onChange={setCallback} onSubmit={finish} />
        <ConnectionButton disabled={busy} onClick={() => void start()}>Start sign-in again</ConnectionButton>
      </ConnectionSetup>
    </> : <>
      <ConnectionHeading title="Get started" action={<ConnectionButton tone="primary" disabled={busy} onClick={() => void start()}>Connect account</ConnectionButton>} />
      <ConnectionSetup title="Connect your account">
        <ol>
          <li>In BB, choose <strong>Connect account</strong> to open Fastmail.</li>
          <li>Choose the access you want in Fastmail, including write or send access if needed.</li>
          <li>If localhost does not load afterward, return to BB to finish the connection.</li>
        </ol>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>
    </>}
    <ConnectionFooter>
      <ConnectionButton onClick={() => void reload()} disabled={busy}>Refresh status</ConnectionButton>
      {status?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'fastmail-connection', component: FastmailSettings }); });
