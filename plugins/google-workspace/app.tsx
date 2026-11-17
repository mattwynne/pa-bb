import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.js';
import './connection-ui.css';
import './app.css';

type Status = { configured: boolean; redirectUri: string | null; ready: boolean; error: string | null; accounts: { subject: string; email: string }[] };
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/google-workspace/README.md';
export function WorkspaceSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  async function load() {
    try { setStatus(await rpc.call('status', null)); setError(''); }
    catch { setError('Could not load Google Workspace settings. Try again.'); }
  }
  useEffect(() => { void load(); }, []);
  async function connect(subject?: string) {
    setBusy(true); setError('');
    try {
      const { url } = subject ? await rpc.call('beginReconnect', { subject }) : await rpc.call('beginConnect', null);
      window.location.assign(url);
    } catch { setError('Could not start Google sign-in. Check the OAuth client and registered callback in the setup guide.'); setBusy(false); }
  }
  async function remove(subject: string, email: string) {
    if (!window.confirm(`Remove ${email} from Workspace? This leaves your Google files, mail and other plugins unchanged.`)) return;
    setBusy(true); setError('');
    try { await rpc.call('removeAccount', { subject }); await load(); }
    catch { setError('Could not remove this Workspace account. Refresh and try again.'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError('');
    try { await rpc.call('refresh', null); await load(); }
    catch { setError('Could not refresh Workspace. Check the connection and backend setup.'); }
    finally { setBusy(false); }
  }
  async function copyCallback() {
    try { if (status?.redirectUri) { await navigator.clipboard.writeText(status.redirectUri); setCopied(true); } }
    catch { setError('Could not copy. Select and copy the callback URL instead.'); }
  }
  const callback = <div className="pa-workspace__callback"><code>{status?.redirectUri || 'Configure an HTTPS BB_APP_URL first.'}</code>
    {status?.redirectUri && <ConnectionButton onClick={() => void copyCallback()}>{copied ? 'Copied' : 'Copy'}</ConnectionButton>}</div>;
  return <section className="pa-workspace" aria-label="Google Workspace connections" aria-busy={busy}>
    <ConnectionHeading title={status?.accounts.length ? 'Connected accounts' : 'Get started'}
      description={!status?.accounts.length ? 'Drive, Docs, Sheets, Calendar and Gmail through one Google connection.' : undefined}
      action={status && <ConnectionButton tone="primary" disabled={busy || !status.configured} onClick={() => void connect()}>{status.accounts.length ? '+ Add account' : 'Connect account'}</ConnectionButton>} />
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {status?.error && <ConnectionAlert>{status.error}</ConnectionAlert>}
    {!status ? <ConnectionEmpty>{error ? <ConnectionButton onClick={() => void load()}>Try again</ConnectionButton> : 'Loading connections…'}</ConnectionEmpty>
      : !status.configured ? <ConnectionSetup title="Use your existing Google Cloud app">
        <ol>
          <li>Enable the Drive, Docs, Sheets, Calendar and Gmail APIs in your Google Cloud project.</li>
          <li>Add this authorized redirect URI to your existing Web OAuth client:{callback}</li>
          <li>Save your Web OAuth client ID and secret in Configuration above.</li>
          <li>Install <code>uv</code> on the BB server with <code>uvx</code> on the service’s PATH. Workspace starts its pinned backend automatically.</li>
        </ol>
        <p>Then connect an account and approve the requested permissions, including Gmail. No separate MCP login or per-action approval prompts.</p>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>
      : status.accounts.length ? <>
        <ConnectionAccounts>{status.accounts.map(account => <ConnectionAccount key={account.subject} initial={account.email[0]?.toUpperCase() || 'G'} label={account.email}
          status="Connected" caption="Drive, Docs, Sheets, Calendar and Gmail" action={<>
            <ConnectionButton disabled={busy} aria-label={`Reconnect ${account.email}`} onClick={() => void connect(account.subject)}>Reconnect</ConnectionButton>
            <ConnectionButton disabled={busy} aria-label={`Remove ${account.email}`} onClick={() => void remove(account.subject, account.email)}>Remove</ConnectionButton>
          </>} />)}</ConnectionAccounts>
        <p className="pa-workspace__status" role="status">{busy ? 'Working…' : status.ready ? 'Workspace tools available.' : 'Choose Refresh to start the Workspace backend.'}</p>
      </> : <ConnectionSetup title="Connect your first account"><p>Confirm this callback is registered on your Web OAuth client, then choose Connect account:</p>{callback}
        <p>Google will ask for access to all five services, including Gmail.</p></ConnectionSetup>}
    <ConnectionFooter>
      {status?.accounts.length ? <ConnectionButton disabled={busy} onClick={() => void refresh()}>{busy ? 'Refreshing…' : 'Refresh'}</ConnectionButton> : null}
      <ConnectionGuide href={GUIDE} />
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'workspace-connections', component: WorkspaceSettings }); });
