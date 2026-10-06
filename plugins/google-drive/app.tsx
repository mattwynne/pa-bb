import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.js';
import './connection-ui.css';
import './app.css';

type Account = { subject: string; email: string; status: string };
type ConnectionState = { configured: boolean; redirectUri: string | null; accounts: Account[] };
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/google-drive/docs/setup.md';

function DriveSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  async function refresh() {
    try { setState(await rpc.call('status', null)); setError(''); }
    catch { setError('Could not load Google Drive connection status. Check BB and try again.'); }
  }
  useEffect(() => { void refresh(); }, []);
  async function importCalendarClient() {
    setBusy(true); setError(''); setNotice('');
    try {
      await rpc.call('importCalendarOAuthClient', null);
      await refresh();
      setNotice('Calendar’s OAuth client copied to Drive. Connect an account to authorize Drive access.');
    } catch { setError('Could not copy Calendar’s OAuth client. Check that Calendar is installed and configured, or enter the client details in Configuration.'); }
    finally { setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError(''); setNotice('');
    try { const { url } = await rpc.call('beginConnect', null); window.location.assign(url); }
    catch { setError('Could not start Google authorization. Check the OAuth client settings.'); setBusy(false); }
  }
  async function remove(subject: string, email: string) {
    if (!window.confirm(`Remove ${email} from Google Drive in BB? This does not revoke access at Google.`)) return;
    setBusy(true); setError('');
    try { await rpc.call('removeAccount', { subject }); await refresh(); }
    catch { setError('Could not remove this Google account. Check BB and try again.'); }
    finally { setBusy(false); }
  }
  async function copyRedirect() {
    if (!state?.redirectUri) return;
    try { await navigator.clipboard.writeText(state.redirectUri); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError('Could not copy the redirect URI. Select and copy it instead.'); }
  }
  return <section className="pa-drive" aria-label="Google Drive connections">
    <ConnectionHeading title={!state ? 'Connections' : !state.configured || !state.accounts.length ? 'Get started' : 'Connected accounts'}
      count={state?.configured && state.accounts.length ? state.accounts.length : undefined}
      action={state && <ConnectionButton tone="primary" disabled={busy || !state.configured} onClick={() => void connect()}>{state.accounts.length ? '+ Add account' : 'Connect account'}</ConnectionButton>} />
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {notice && <p className="pa-drive__notice" role="status">{notice}</p>}
    {!state ? <ConnectionEmpty>{error ? 'Connection status unavailable.' : 'Loading connections…'}
      {error && <ConnectionButton tone="secondary" onClick={() => void refresh()}>Try again</ConnectionButton>}</ConnectionEmpty> : <>
      {!state.configured && <ConnectionSetup title={state.accounts.length ? 'Restore OAuth setup' : 'Connect your first account'}>
        <ol>
          <li>In Google Cloud, enable the Drive and Docs APIs and configure the OAuth consent screen.</li>
          <li>Add this redirect URI to your Calendar Web client, or create a Web client with it:
            <div className="pa-drive__redirect"><code>{state.redirectUri || 'Set an HTTPS BB_APP_URL first.'}</code>
              {state.redirectUri && <ConnectionButton tone="secondary" onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</ConnectionButton>}
            </div>
          </li>
          <li>If Calendar is configured in BB, copy its client settings to Drive. The plugins keep separate grants.
            <div className="pa-drive__import"><ConnectionButton tone="secondary" disabled={busy} onClick={() => void importCalendarClient()}>Use Calendar’s OAuth client</ConnectionButton></div>
          </li>
          <li>Otherwise save a Web client ID and secret in Configuration above. Then choose <strong>Connect account</strong>.</li>
        </ol>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>}
      {state.accounts.length ? <ConnectionAccounts>{state.accounts.map(account => <ConnectionAccount key={account.subject}
        initial={account.email[0]?.toUpperCase() ?? 'G'} label={account.email} status={account.status}
        caption={account.status === 'Re-authentication required' ? 'Remove and reconnect this account.' : account.status === 'Connection unavailable' ? 'Refresh status and try again later.' : undefined}
        warning={account.status !== 'Connected'} action={<ConnectionButton disabled={busy}
          aria-label={`Remove ${account.email}`} onClick={() => void remove(account.subject, account.email)}>Remove</ConnectionButton>} />)}</ConnectionAccounts>
      : state.configured && <ConnectionSetup title="Connect your first account">
        <p>Confirm that this Drive redirect URI is registered on your Google Web OAuth client:</p>
        <div className="pa-drive__redirect"><code>{state.redirectUri}</code>
          {state.redirectUri && <ConnectionButton tone="secondary" onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</ConnectionButton>}
        </div>
        <p>Then choose <strong>Connect account</strong> to authorize Drive access.</p>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>}
    </>}
    <ConnectionFooter>
      <ConnectionButton disabled={busy} onClick={() => void refresh()}>Refresh status</ConnectionButton>
      {Boolean(state?.accounts.length) && <ConnectionGuide href={GUIDE} />}
    </ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'drive-accounts', component: DriveSettings }); });
