import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';

function CalendarSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ configured: boolean; redirectUri: string | null; accounts: { subject: string; email: string; status: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    try { setState(await rpc.call('status', null)); setError(''); }
    catch { setError('Could not load Google Calendar connection status.'); }
  }
  useEffect(() => { void refresh(); }, []);
  async function connect() {
    setBusy(true); setError('');
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
  return <section aria-label="Google Calendar connections">
    <p>Connect Google accounts to search calendars, check availability, and manage events. Each account can access multiple calendars.</p>
    <p>Set the Web OAuth client ID and secret in this plugin’s BB settings. Enable the Google Calendar API and add this exact authorized redirect URI to the Google Web OAuth client:</p>
    <p><code>{state?.redirectUri || 'Set an HTTPS BB_APP_URL first.'}</code></p>
    <p>Request the Calendar list, events and free/busy scopes shown in the plugin README. Your existing Pi Desktop OAuth grant is separate.</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy || !state?.configured} onClick={() => void connect()}>Connect Google account</button>
    {!state?.configured && <p>Configure the Web OAuth client ID, client secret, and HTTPS BB_APP_URL to enable Connect.</p>}
    <h3>Connected accounts</h3>
    {!state?.accounts.length ? <p>No accounts connected.</p> : <ul>{state.accounts.map(account => <li key={account.subject}>
      {account.email} — {account.status} <button type="button" disabled={busy} onClick={() => void remove(account.subject, account.email)}>Remove</button>
    </li>)}</ul>}
    <p>To reauthorize an account, remove it here and connect it again. Removing it deletes only the local grant.</p>
    <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh status</button>
  </section>;
}

function Approval({ interaction, submit, cancel }: {
  interaction: { payload: unknown };
  submit(value: { approved: boolean }): Promise<void>;
  cancel(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const p = interaction.payload && typeof interaction.payload === 'object' && !Array.isArray(interaction.payload) ? interaction.payload as Record<string, unknown> : {};
  async function decide(approved: boolean) { setBusy(true); try { await submit({ approved }); } finally { setBusy(false); } }
  return <div role="group" aria-label="Approve Google Calendar change">
    <h3>Approve Calendar {String(p.operation || 'change')}?</h3>
    <p>Account: {String(p.account || '')} · Calendar: {String(p.calendarId || '')}</p>
    {typeof p.summary === 'string' && <p>Title: {p.summary}</p>}
    {typeof p.eventId === 'string' && <p>Event: {p.eventId}</p>}
    <p>Attendee notifications: {String(p.sendUpdates || 'none')}</p>
    <p>Review the complete proposed change before approving:</p>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(p.details || '')}</pre>
    <button type="button" disabled={busy} onClick={() => void decide(true)}>Approve this change</button>
    <button type="button" disabled={busy} onClick={() => void decide(false)}>Decline</button>
    <button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'calendar-accounts', title: 'Google Calendar accounts', description: 'Connect or remove Google accounts.', component: CalendarSettings });
  app.slots.pendingInteraction({ id: 'calendar-approval', component: Approval });
});
