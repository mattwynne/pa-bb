import { useEffect, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.js';
import './app.css';

type Account = { subject: string; email: string; status: string };
type ConnectionState = { configured: boolean; redirectUri: string | null; accounts: Account[] };

function CalendarSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

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
  async function copyRedirect() {
    if (!state?.redirectUri) return;
    try { await navigator.clipboard.writeText(state.redirectUri); setCopied(true); window.setTimeout(() => setCopied(false), 2000); }
    catch { setError('Could not copy the redirect URI. Select and copy it instead.'); }
  }

  return <section className="pa-calendar" aria-label="Google Calendar connections">
    <div className="pa-calendar__heading">
      <div>
        <p className="pa-calendar__eyebrow">GOOGLE CALENDAR</p>
        <h3 className="pa-calendar__title">Connected accounts <span className="pa-calendar__count">{state?.accounts.length ?? '–'}</span></h3>
        <p className="pa-calendar__description">Search events and check availability across every calendar you can access.</p>
      </div>
      <button className="pa-calendar__button pa-calendar__button--primary" type="button" disabled={busy || !state?.configured} onClick={() => void connect()}>+ Add account</button>
    </div>

    {error && <p className="pa-calendar__alert" role="alert">{error}</p>}
    {state && !state.configured && <p className="pa-calendar__notice">Enter the Web OAuth client ID and secret in Configuration above to enable account connection.</p>}
    {!state ? <p className="pa-calendar__empty">Loading connections…</p>
      : state.accounts.length === 0 ? <div className="pa-calendar__empty"><strong>No accounts connected</strong><span>Add a Google account to make its calendars available to BB.</span></div>
      : <ul className="pa-calendar__accounts">{state.accounts.map(account => <li className="pa-calendar__account" key={account.subject}>
        <span className="pa-calendar__avatar" aria-hidden="true">{account.email[0]?.toUpperCase() ?? 'G'}</span>
        <span className="pa-calendar__account-name">{account.email}</span>
        <span className={`pa-calendar__badge${account.status === 'Connected' ? '' : ' pa-calendar__badge--warning'}`}>{account.status}</span>
        <button className="pa-calendar__button pa-calendar__button--quiet" type="button" disabled={busy} aria-label={`Remove ${account.email}`} onClick={() => void remove(account.subject, account.email)}>Remove</button>
      </li>)}</ul>}

    <div className="pa-calendar__footer">
      <button className="pa-calendar__button pa-calendar__button--quiet" type="button" onClick={() => void refresh()} disabled={busy}>Refresh status</button>
      <span>Removing an account deletes its local grant; it does not revoke access at Google.</span>
    </div>

    <details className="pa-calendar__setup" open={state && !state.configured ? true : undefined}>
      <summary>OAuth setup &amp; troubleshooting</summary>
      <div className="pa-calendar__setup-content">
        <p>Create a Google <strong>Web application</strong> OAuth client and add this exact authorized redirect URI:</p>
        <div className="pa-calendar__redirect"><code>{state?.redirectUri || 'Set an HTTPS BB_APP_URL first.'}</code>
          {state?.redirectUri && <button type="button" className="pa-calendar__button pa-calendar__button--quiet" onClick={() => void copyRedirect()}>{copied ? 'Copied' : 'Copy'}</button>}
        </div>
        <p>Enable the Calendar API, then enter the client ID and secret in Configuration above. Existing Pi Desktop OAuth grants are separate. To reauthorize an account, remove it and connect it again.</p>
      </div>
    </details>
  </section>;
}

function Approval({ interaction, submit, cancel }: {
  interaction: { payload: unknown };
  submit(value: { approved: boolean }): Promise<void>;
  cancel(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' && !Array.isArray(interaction.payload) ? interaction.payload as Record<string, unknown> : {};
  async function decide(approved: boolean) {
    setBusy(true); setError('');
    try { await submit({ approved }); }
    catch { setError('Could not submit your choice. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="pa-calendar pa-calendar__approval" role="group" aria-label="Approve Google Calendar change">
    <p className="pa-calendar__eyebrow">CONFIRM CALENDAR CHANGE</p>
    <h3 className="pa-calendar__title">{String(p.operation || 'Change')} event?</h3>
    <div className="pa-calendar__approval-summary">
      <div><span>Account</span><strong>{String(p.account || '')}</strong></div>
      <div><span>Calendar</span><strong>{String(p.calendarId || '')}</strong></div>
      {typeof p.summary === 'string' && <div><span>Title</span><strong>{p.summary}</strong></div>}
      {typeof p.eventId === 'string' && <div><span>Event ID</span><strong>{p.eventId}</strong></div>}
      <div><span>Notify attendees</span><strong>{String(p.sendUpdates || 'none')}</strong></div>
    </div>
    <details className="pa-calendar__setup" open><summary>Full proposed change</summary><pre className="pa-calendar__proposal">{String(p.details || '')}</pre></details>
    {error && <p className="pa-calendar__alert" role="alert">{error}</p>}
    <div className="pa-calendar__approval-actions">
      <button className="pa-calendar__button pa-calendar__button--primary" type="button" disabled={busy} onClick={() => void decide(true)}>Approve change</button>
      <button className="pa-calendar__button pa-calendar__button--secondary" type="button" disabled={busy} onClick={() => void decide(false)}>Decline</button>
      <button className="pa-calendar__button pa-calendar__button--quiet" type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'calendar-accounts', title: 'Google Calendar accounts', description: 'Connect or remove Google accounts.', component: CalendarSettings });
  app.slots.pendingInteraction({ id: 'calendar-approval', component: Approval });
});
