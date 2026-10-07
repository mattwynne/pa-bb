import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';
import { ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup } from './connection-ui.js';
import { Approval } from './approval.js';
import './connection-ui.css';
import './app.css';

type Account = { subject: string; email: string; status: string };
type ConnectionState = { configured: boolean; redirectUri: string | null; accounts: Account[] };
const SETUP_GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/google-calendar/docs/google-oauth-setup.md';

function CalendarSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try { setState(await rpc.call('status', null)); setError(''); }
    catch { setError('Could not load Google Calendar connection status.'); }
  }
  useEffect(() => { void refresh(); }, []);

  async function importDriveClient() {
    setBusy(true); setError(''); setNotice('');
    try {
      await rpc.call('importDriveOAuthClient', null);
      await refresh();
      setNotice('Drive’s OAuth client copied to Calendar. Add an account to authorize Calendar access.');
    } catch { setError('Could not copy Drive’s OAuth client. Check that Drive is installed and configured, or enter the client details in Configuration.'); }
    finally { setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError(''); setNotice('');
    try { const { url } = await rpc.call('beginConnect', null); window.location.assign(url); }
    catch { setError('Could not start Google authorization. Check the OAuth client settings.'); setBusy(false); }
  }
  async function remove(subject: string, email: string) {
    if (!window.confirm(`Remove ${email} from Google Calendar in BB? This does not revoke access at Google.`)) return;
    setBusy(true); setError('');
    try { await rpc.call('removeAccount', { subject }); await refresh(); }
    catch { setError('Could not remove this Google account.'); }
    finally { setBusy(false); }
  }
  async function copyRedirect() {
    if (!state?.redirectUri) return;
    try { await navigator.clipboard.writeText(state.redirectUri); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError('Could not copy the redirect URI. Select and copy it instead.'); }
  }

  return <section className="pa-calendar" aria-label="Google Calendar connections">
    <ConnectionHeading title={!state || !state.configured || !state.accounts.length ? 'Get started' : 'Connected accounts'}
      count={state?.configured && state.accounts.length ? state.accounts.length : undefined}
      description={state?.accounts.length ? 'Search events and check availability across every calendar you can access.' : undefined}
      action={<ConnectionButton tone="primary" disabled={busy || !state?.configured} onClick={() => void connect()}>+ Add account</ConnectionButton>} />

    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {notice && <p className="pa-calendar__notice" role="status">{notice}</p>}
    {!state ? <ConnectionEmpty>Loading connections…</ConnectionEmpty> : <>
      {!state.configured && <ConnectionSetup title={state.accounts.length ? 'Restore OAuth setup' : 'Connect your first account'}>
        <ol>
          <li>Choose a Google Cloud project, enable the Calendar API, and configure its consent screen.</li>
          <li>Add this redirect URI to your Drive Web client, or create a Web client with it:
            <div className="pa-calendar__redirect"><code>{state.redirectUri || 'Set an HTTPS BB_APP_URL first.'}</code>
              {state.redirectUri && <ConnectionButton tone="secondary" onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</ConnectionButton>}
            </div>
          </li>
          <li>If Drive is configured in BB, copy its client settings to Calendar. The plugins keep separate grants.
            <div className="pa-calendar__import"><ConnectionButton tone="secondary" disabled={busy} onClick={() => void importDriveClient()}>Use Drive’s OAuth client</ConnectionButton></div>
          </li>
          <li>Otherwise save a Web client ID and secret in Configuration above. Then choose <strong>Add account</strong>.</li>
        </ol>
        <ConnectionGuide href={SETUP_GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>}
      {state.accounts.length === 0 ? (state.configured && <ConnectionSetup title="Connect your first account">
        <p>Confirm that this Calendar redirect URI is registered on your Google Web OAuth client:</p>
        <div className="pa-calendar__redirect"><code>{state.redirectUri}</code>
          {state.redirectUri && <ConnectionButton tone="secondary" onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</ConnectionButton>}
        </div>
        <p>Then choose <strong>Add account</strong> to authorize Calendar access.</p>
        <ConnectionGuide href={SETUP_GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>)
      : <ConnectionAccounts>{state.accounts.map(account => <ConnectionAccount key={account.subject} initial={account.email[0]?.toUpperCase() ?? 'G'} label={account.email} status={account.status}
        warning={account.status !== 'Connected'} action={<ConnectionButton disabled={busy} aria-label={`Remove ${account.email}`} onClick={() => void remove(account.subject, account.email)}>Remove</ConnectionButton>} />)}</ConnectionAccounts>}
    </>}

    <ConnectionFooter>
      <ConnectionButton onClick={() => void refresh()} disabled={busy}>Refresh status</ConnectionButton>
      {Boolean(state?.accounts.length) && <ConnectionGuide href={SETUP_GUIDE} />}
    </ConnectionFooter>
  </section>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'calendar-accounts', component: CalendarSettings });
  app.slots.pendingInteraction({ id: 'calendar-approval', component: Approval });
});
