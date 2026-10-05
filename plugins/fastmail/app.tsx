import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import { PasteBack } from './paste-back.js';
import type { rpcContract } from './contract.js';

function FastmailSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<{ connected: boolean; pending: boolean; tools: number } | null>(null);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reload() { try { setStatus(await rpc.call('status', null)); } catch { setError('Could not load Fastmail status.'); } }
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
    } catch { tab?.close(); setError('Could not start Fastmail authorization. Allow popups and try again.'); }
    finally { setBusy(false); }
  }
  async function finish(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const value = callback; setCallback('');
    try { await rpc.call('finish', { callbackUrl: value }); await reload(); }
    catch { setError('Callback rejected or expired. Start a new connection and try again.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm('Remove Fastmail access from this BB installation? Revoke the grant separately at Fastmail.')) return;
    setBusy(true); setError(''); setCallback('');
    try { await rpc.call('disconnect', null); await reload(); } catch { setError('Could not disconnect Fastmail.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Fastmail connection">
    <h3>Fastmail</h3>
    <p>{status?.connected ? `Connected — ${status.tools} provider tools available in new sessions.` : 'Connect one Fastmail account. Fastmail chooses which tools your grant exposes, including writes if you grant them.'}</p>
    {error && <p role="alert">{error}</p>}
    {status?.connected ? <button disabled={busy} onClick={() => void disconnect()}>Disconnect</button> : <>
      <button disabled={busy} onClick={() => void start()}>Connect Fastmail</button>
      {status?.pending && <PasteBack callback={callback} busy={busy} onChange={setCallback} onSubmit={finish} />}
    </>}
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'fastmail-connection', component: FastmailSettings }); });
