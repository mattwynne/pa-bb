import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Status } from './contract.ts';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.tsx';
import './connection-ui.css';
import './app.css';

const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/xero/README.md';
export function XeroSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [copied, setCopied] = useState(false);
  async function load() {
    try { setStatus(await rpc.call('status', null)); }
    catch { setError('Could not load Xero settings. Try again.'); }
  }
  useEffect(() => { void load(); }, []);
  async function action(label: string, run: () => Promise<unknown>) {
    setBusy(label); setError('');
    try { await run(); await load(); }
    catch { setError('The Xero action did not complete. Check the connection and try again.'); await load(); }
    finally { setBusy(''); }
  }
  async function connect() {
    setBusy('Opening Xero sign-in…'); setError('');
    try { const { url } = await rpc.call('beginConnect', null); window.location.assign(url); }
    catch { setError('Could not start Xero sign-in. Check the Web OAuth client, registered callback and BB address in the setup guide.'); setBusy(''); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect this Xero login and all its organisations from this BB plugin? This removes the locally stored connection only. Xero records, source documents and other integrations remain unchanged. To revoke app access, also remove it in Xero’s Connected apps.')) return;
    await action('Disconnecting…', () => rpc.call('disconnect', null));
  }
  async function copy() {
    try { if (status?.redirectUri) { await navigator.clipboard.writeText(status.redirectUri); setCopied(true); } }
    catch { setError('Could not copy. Select and copy the callback address instead.'); }
  }
  const callback = <div className="pa-xero__callback"><code>{status?.redirectUri ?? 'Configure an HTTPS BB_APP_URL, or use BB on localhost.'}</code>
    {status?.redirectUri && <ConnectionButton onClick={() => void copy()} aria-label="Copy Xero callback URL">{copied ? 'Copied' : 'Copy'}</ConnectionButton>}</div>;
  return <section className="pa-xero" aria-label="Xero connection" aria-busy={Boolean(busy)}>
    <ConnectionHeading title={status?.connected ? 'Connected organisations' : 'Get started'}
      description={status?.connected ? undefined : 'Look up accounting records and prepare requested invoices and bills.'}
      action={status && <ConnectionButton tone="primary" disabled={Boolean(busy) || !status.configured} onClick={() => void connect()}>{status.connected ? 'Reconnect' : 'Connect Xero'}</ConnectionButton>} />
    {(status?.error || error) && <ConnectionAlert>{status?.error || error}</ConnectionAlert>}
    {!status ? <ConnectionEmpty>{error ? <ConnectionButton onClick={() => void load()}>Try again</ConnectionButton> : 'Loading connection…'}</ConnectionEmpty>
      : status.connected ? <>
        {status.organisations.length ? <ConnectionAccounts>{status.organisations.map(org => <ConnectionAccount key={org.tenantId} initial={org.tenantName[0]?.toUpperCase() || 'X'} label={org.tenantName}
          status={org.checkedAt ? 'Read verified' : 'Connected'} caption={org.checkedAt ? `Accounting read verified ${new Date(org.checkedAt).toLocaleString()}` : 'Connected in Xero; Accounting API access not yet checked.'}
          action={<ConnectionButton disabled={Boolean(busy)} aria-label={`Check access to ${org.tenantName}`} onClick={() => void action('Checking access…', () => rpc.call('check', { tenantId: org.tenantId }))}>Check access</ConnectionButton>} />)}</ConnectionAccounts>
          : <ConnectionEmpty>No organisations were returned. Choose Refresh organisations, or Reconnect and select an organisation in Xero.</ConnectionEmpty>}
        <p className="pa-xero__note">Requested record changes can run through the assistant. Final bank reconciliation stays in Xero; this plugin cannot read unreconciled bank-feed lines.</p>
      </> : <ConnectionSetup title="Use your own Xero app">
        <ol>
          <li>In <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener noreferrer">Xero Developer</a>, create or open a <strong>Web app</strong> using the authorization-code flow, not a Custom Connection.</li>
          <li>In the Xero app, register this exact redirect URI:{callback}</li>
          <li>In BB’s Configuration above, save the client ID and client secret from that app. Never paste secrets or callback responses into chat.</li>
          <li>Choose <strong>Connect Xero</strong>, sign in, select your organisation and approve the requested accounting permissions. Then choose <strong>Check access</strong> for a harmless accounting read.</li>
        </ol>
        <p>One Xero login can connect several organisations. This plugin stores its own connection; it does not import credentials from other tools.</p>
        <ConnectionGuide href={GUIDE}>Complete setup and permissions guide ↗</ConnectionGuide>
      </ConnectionSetup>}
    <p role="status" aria-live="polite" className="pa-xero__status">{busy}</p>
    <ConnectionFooter>
      {status?.connected && <><ConnectionButton disabled={Boolean(busy)} onClick={() => void action('Refreshing organisations…', () => rpc.call('refresh', null))}>Refresh organisations</ConnectionButton>
        <ConnectionButton disabled={Boolean(busy)} onClick={() => void disconnect()}>Disconnect</ConnectionButton></>}
      {status?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'xero-connection', component: XeroSettings }); });
