import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Status } from './contract.ts';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionDisclosure, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.tsx';
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
    if (!window.confirm('Disconnect this Xero login and all its organisations or practices from this BB plugin? This removes the locally stored login connection only. Xero records, source documents and other integrations remain unchanged. To revoke app access, also remove it in Xero’s Connected apps.' + (status?.appStoreEnabled ? ' App Store partner billing remains separately enabled; turn off that Configuration setting to stop new application-token requests.' : ''))) return;
    await action('Disconnecting…', () => rpc.call('disconnect', null));
  }
  async function copy() {
    try { if (status?.redirectUri) { await navigator.clipboard.writeText(status.redirectUri); setCopied(true); } }
    catch { setError('Could not copy. Select and copy the callback address instead.'); }
  }
  const callback = <div className="pa-xero__callback"><code>{status?.redirectUri ?? 'Configure an HTTPS BB_APP_URL, or use BB on localhost.'}</code>
    {status?.redirectUri && <ConnectionButton onClick={() => void copy()} aria-label="Copy Xero callback URL">{copied ? 'Copied' : 'Copy'}</ConnectionButton>}</div>;
  const hasPractice = status?.organisations.some(org => org.tenantType === 'PRACTICE') ?? false;
  const connectedTitle = hasPractice ? status?.organisations.every(org => org.tenantType === 'PRACTICE') ? 'Connected practices' : 'Connected organisations and practices' : 'Connected organisations';
  return <section className="pa-xero" aria-label="Xero connection" aria-busy={Boolean(busy)}>
    <ConnectionHeading title={status?.connected ? connectedTitle : 'Get started'}
      description={status?.connected ? undefined : 'Use Xero’s APIs through the assistant, with the access you grant.'}
      action={status && <ConnectionButton tone="primary" disabled={Boolean(busy) || !status.configured} onClick={() => void connect()}>{status.connected ? 'Reconnect' : 'Connect Xero'}</ConnectionButton>} />
    {(status?.error || error) && <ConnectionAlert>{status?.error || error}</ConnectionAlert>}
    {Boolean(status?.missingScopes.length) && <ConnectionAlert>Requested access is not granted yet. Choose Reconnect to approve it in Xero. Your existing connection has not been broadened.</ConnectionAlert>}
    {!status ? <ConnectionEmpty>{error ? <ConnectionButton onClick={() => void load()}>Try again</ConnectionButton> : 'Loading connection…'}</ConnectionEmpty>
      : status.connected ? <>
        {status.organisations.length ? <ConnectionAccounts>{status.organisations.map(org => <ConnectionAccount key={org.tenantId} initial={org.tenantName[0]?.toUpperCase() || 'X'} label={org.tenantName}
          status={org.checkedAt ? 'Read verified' : 'Connected'} caption={org.tenantType === 'PRACTICE' ? 'Practice connection; verify access with a requested practice API read.' : org.checkedAt ? `Accounting read verified ${new Date(org.checkedAt).toLocaleString()}` : 'Connected in Xero; Accounting API access not yet checked.'}
          action={org.tenantType === 'PRACTICE' ? undefined : <ConnectionButton disabled={Boolean(busy)} aria-label={`Check access to ${org.tenantName}`} onClick={() => void action('Checking access…', () => rpc.call('check', { tenantId: org.tenantId }))}>Check access</ConnectionButton>} />)}</ConnectionAccounts>
          : <ConnectionEmpty>No organisations or practices were returned. Refresh connections, or Reconnect and select one in Xero.</ConnectionEmpty>}
        <p className="pa-xero__note">Reads and requested changes follow your Xero permissions. Final browser reconciliation stays in Xero.</p>
        <ConnectionDisclosure summary="Access and permissions">
          <p>Granted at Xero sign-in. Permissions do not prove provider eligibility or that every operation works. To request more access, set Additional Xero OAuth scopes in Configuration and choose Reconnect.</p>
          <ul className="pa-xero__scopes">{status.scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul>
          {status.appStoreEnabled && <p>App Store partner billing is enabled separately. Its application token is requested only when you call that API; Xero approval is still required.</p>}
        </ConnectionDisclosure>
      </> : <ConnectionSetup title="Use your own Xero app">
        <ol>
          <li>In <a href="https://developer.xero.com/app/manage" target="_blank" rel="noopener noreferrer">Xero Developer</a>, create or open a <strong>Web app</strong> using the authorization-code flow, not a Custom Connection.</li>
          <li>In the Xero app, register this exact redirect URI:{callback}</li>
          <li>In BB’s Configuration above, save the client ID and client secret from that app. Never paste secrets or callback responses into chat.</li>
          <li>Choose <strong>Connect Xero</strong>, sign in, select your organisation or practice and approve the requested permissions. For an organisation, choose <strong>Check access</strong> for a harmless accounting read.</li>
        </ol>
        <p>For broader access, set Additional Xero OAuth scopes using the permissions guide before connecting. Partner-only APIs still require Xero approval.</p>
        <p>A login can connect several organisations or practices, depending on its scopes. This plugin stores its own connection; it does not import credentials from other tools.</p>
        <ConnectionGuide href={GUIDE}>Complete setup and permissions guide ↗</ConnectionGuide>
      </ConnectionSetup>}
    <p role="status" aria-live="polite" className="pa-xero__status">{busy}</p>
    <ConnectionFooter>
      {status?.connected && <><ConnectionButton disabled={Boolean(busy)} onClick={() => void action('Refreshing connections…', () => rpc.call('refresh', null))}>{hasPractice ? 'Refresh connections' : 'Refresh organisations'}</ConnectionButton>
        <ConnectionButton disabled={Boolean(busy)} onClick={() => void disconnect()}>Disconnect</ConnectionButton></>}
      {status?.connected && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'xero-connection', component: XeroSettings }); });
