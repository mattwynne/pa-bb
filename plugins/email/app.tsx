import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import type { accountView, ProviderId, rpcContract } from './contract.ts';
import {
  ConnectionAccount, ConnectionAccounts, ConnectionAlert, ConnectionButton, ConnectionDisclosure,
  ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionHeading, ConnectionSetup,
} from './connection-ui.tsx';
import './connection-ui.css';
import './app.css';

const guide = 'https://github.com/mattwynne/pa-bb/tree/main/plugins/email#setup';
const name: Record<ProviderId, string> = { 'google-workspace': 'Google Workspace', fastmail: 'Fastmail' };
const statusCaption = {
  off: 'Available', paused: 'Paused', queued: 'Queued', indexing: 'Indexing',
  searchable: 'Searchable', error: 'Needs attention',
};
type Status = z.infer<(typeof rpcContract)['status']['output']>;
type Account = z.infer<typeof accountView>;

function caption(account: Account) {
  const parts = [name[account.provider]];
  if (account.indexed) parts.push(account.indexed.toLocaleString() + ' indexed');
  if (account.omitted) parts.push(account.omitted.toLocaleString() + ' over 32 MiB');
  if (account.completedAt) parts.push('Scan finished ' + new Date(account.completedAt).toLocaleString());
  if (!account.connected) parts.push('Connection unavailable');
  if (account.error === 'storage') parts.push('Check BB server storage');
  if (account.error === 'msgvault') parts.push('Check MsgVault on the BB server');
  if (account.error === 'provider' && account.connected) parts.push('Check the provider connection');
  return parts.join(' · ');
}

function EmailSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(false);
  async function load(quiet = false, refresh = false) {
    const request = ++latest.current;
    try {
      const value = await rpc.call('status', refresh ? { refresh: true } : null);
      if (mounted.current && request === latest.current) setStatus(value);
    } catch {
      if (mounted.current && request === latest.current && !quiet) setError('Could not load accounts. Try refreshing.');
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 5000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  async function change(account: Account, action: 'select' | 'refresh') {
    setBusy(account.key);
    setError('');
    try {
      if (action === 'refresh') await rpc.call('refreshAccount', { key: account.key });
      else await rpc.call('selectAccount', { key: account.key, selected: !account.selected });
      await load();
    } catch { setError('Could not update this account. Check the provider connection and MsgVault, then try again.'); }
    finally { setBusy(null); }
  }
  const hasAccounts = Boolean(status?.accounts.length);
  const workspace = status?.providers.find(provider => provider.id === 'google-workspace');
  const fastmail = status?.providers.find(provider => provider.id === 'fastmail');
  const runtimeReady = status?.runtime === 'ready';
  return <section className="pa-email" aria-label="Email indexing">
    <ConnectionHeading title="Accounts to index"
      description="Indexing copies email to the BB server. Pausing an account hides its archive from search and keeps the local copies."
      action={<ConnectionButton tone="secondary" onClick={() => { setError(''); void load(false, true); }}>Refresh accounts</ConnectionButton>} />
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {status && !runtimeReady && <ConnectionAlert>{
      status.runtime === 'missing' ? 'MsgVault was not found on the BB server’s PATH.'
        : status.runtime === 'unsupported' ? 'Install a supported MsgVault 0.26 release on the BB server.'
          : 'MsgVault could not start. Check the BB server installation.'
    }</ConnectionAlert>}
    {!status && !error && <ConnectionEmpty><span role="status">Finding accounts…</span></ConnectionEmpty>}
    {hasAccounts && <ConnectionAccounts>{status!.accounts.map(account => {
      const label = account.selected ? 'Pause' : account.phase === 'paused' ? 'Resume' : 'Index account';
      return <ConnectionAccount key={account.key} initial={account.email[0]?.toUpperCase() || 'E'} label={account.email}
        caption={caption(account)} status={statusCaption[account.phase]} warning={account.phase === 'error' || !account.connected}
        action={<div className="pa-email__actions">
          {account.selected && account.connected && account.phase !== 'indexing' && <ConnectionButton
            disabled={busy !== null || !runtimeReady} aria-label={`Scan mail for ${account.email}`} onClick={() => void change(account, 'refresh')}>Scan now</ConnectionButton>}
          <ConnectionButton tone={account.selected ? 'quiet' : 'primary'}
            disabled={busy !== null || (!account.selected && (!account.connected || !runtimeReady))}
            aria-label={`${label} ${account.email}`} onClick={() => void change(account, 'select')}>
            {busy === account.key ? 'Working…' : label}
          </ConnectionButton>
        </div>} />;
    })}</ConnectionAccounts>}
    {status && (workspace?.status !== 'ready' || fastmail?.status !== 'ready' || !runtimeReady) &&
      <ConnectionDisclosure summary="Connect accounts and set up MsgVault" open={!hasAccounts || !runtimeReady}>
        <ConnectionSetup title="Set up indexing">
          <ol>
            {!runtimeReady && <li>Install MsgVault 0.26 on the BB server and make <code>msgvault</code> available on the BB service’s PATH.</li>}
            {workspace?.status !== 'ready' && <li>Connect a Gmail account in <a href="/plugins/google-workspace?configure=google-workspace">Google Workspace settings</a>.</li>}
            {fastmail?.status !== 'ready' && <li>Configure a mail-enabled JMAP API token in <a href="/plugins/fastmail?configure=fastmail">Fastmail settings</a>.</li>}
            <li>Refresh accounts, then select <strong>Index account</strong> for each account to copy.</li>
          </ol>
          {(workspace?.status === 'unavailable' || fastmail?.status === 'unavailable') && <p>An unavailable account source may need a plugin update or a connection check.</p>}
        </ConnectionSetup>
      </ConnectionDisclosure>}
    <ConnectionFooter><ConnectionGuide href={guide} /></ConnectionFooter>
  </section>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'indexed-email-accounts', component: EmailSettings });
});
