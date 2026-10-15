import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { z } from 'zod';
import type { rpcContract, settingsSchema } from './contract.js';
import { ConnectionHeading, ConnectionButton, ConnectionAccounts, ConnectionAccount, ConnectionAlert, ConnectionEmpty, ConnectionFooter, ConnectionGuide, ConnectionSetup } from './connection-ui.js';
import './connection-ui.css';
import './app.css';
type Status = z.infer<typeof settingsSchema>;
type Source = Status['eligible'][number];
const GUIDE = 'https://github.com/mattwynne/pa-bb/blob/main/plugins/obsidian/docs/setup.md';
const ICLOUD = '/plugins/icloud?configure=icloud';
function sourceStatus(source: Source | null, setup: string) {
  if (setup === 'incompatible') return 'Note access incompatible · update both plugins';
  if (setup === 'check_failed') return 'Local access unverified · check again';
  if (!source) return 'Local access unverified · check iCloud settings';
  if (!source.local.available) return `Local notes unavailable · ${source.local.reason?.replaceAll('_', ' ') ?? 'check iCloud'}`;
  if (source.phase === 'retained') return 'Previous mirror · connect its replacement explicitly';
  if (setup === 'apple_disconnected') return 'Local notes available · Apple disconnected; cloud delivery stopped';
  if (source.phase === 'running') return 'Local notes available · iCloud syncing';
  if (!source.enabled || source.phase === 'paused') return 'Local notes available · cloud paused';
  if (source.failure || source.phase === 'failed') return 'Local notes available · cloud retry needed';
  return 'Local notes available · cloud sync scheduled';
}
function ObsidianSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [adding, setAdding] = useState(false);
  const generation = useRef(0); const revision = useRef(-1); const pending = useRef(false);
  function accept(next: Status, request: number) {
    if (request !== generation.current || next.revision < revision.current) return;
    revision.current = next.revision;
    setState(next);
  }
  async function refresh() {
    if (pending.current) return; pending.current = true; const request = ++generation.current;
    try { const next = await rpc.call('status', null); accept(next, request); if (request === generation.current) setError(''); }
    catch { if (request === generation.current) setError('Could not check vaults. Your connections are kept. Check BB and choose Check again.'); }
    finally { pending.current = false; }
  }
  const waiting = !state || state.setup !== 'ready' || !state.vaults.length || state.vaults.some(v => v.source?.phase === 'running');
  useEffect(() => { void refresh(); const returned = () => { if (document.visibilityState === 'visible') void refresh(); }; window.addEventListener('focus', returned); document.addEventListener('visibilitychange', returned); return () => { generation.current++; window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); }; }, []);
  useEffect(() => { if (!waiting) return; const timer = window.setInterval(() => void refresh(), 10000); return () => window.clearInterval(timer); }, [waiting]);
  async function change(method: 'connect' | 'remove', vaultId: string) {
    const request = ++generation.current; setBusy(true); pending.current = true; setError(''); setNotice('');
    try { accept(await rpc.call(method, { vaultId }), request); setAdding(false); setNotice(method === 'connect' ? 'Vault connected.' : 'Vault removed. Notes and iCloud sync are unchanged.'); }
    catch { setError(method === 'connect' ? 'Connection was not confirmed. Check again before trying to connect.' : 'Removal was not confirmed. Check again after the current note operation finishes.'); }
    finally { pending.current = false; setBusy(false); }
  }
  const duplicate = (name: string) => state && [...state.eligible.map(s => ({ id: s.id, name: s.name })), ...state.vaults.map(v => ({ id: v.vaultId, name: v.source?.name ?? v.name }))].filter((s, i, all) => all.findIndex(other => other.id === s.id) === i && s.name === name).length > 1;
  const label = (id: string, name: string) => duplicate(name) ? `${name} · ${id}` : name;
  return <section className="pa-obsidian" aria-label="Connected vaults and source status" aria-busy={busy}>
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    {notice && <p role="status">{notice}</p>}
    {!state ? <ConnectionEmpty>{error ? 'Vault status unavailable.' : 'Checking vaults…'}</ConnectionEmpty> : <>
      <ConnectionHeading title={state.vaults.length ? 'Connected vaults' : 'Get started'} count={state.vaults.length > 1 ? state.vaults.length : undefined}
        action={<ConnectionButton tone="primary" disabled={busy} onClick={() => setAdding(true)}>Add vault</ConnectionButton>} />
      {!state.vaults.length && <ConnectionSetup title="Connect your first vault">
        <p>Connect a vault so BB can read and edit all its notes. Changes are sent back through iCloud.</p>
        <ol><li>In BB’s <a className="pa-connection__guide" href={ICLOUD}>iCloud settings</a>, install or enable iCloud and connect Apple.</li><li>Choose the vault folder, enable sync and wait for its first successful sync.</li><li>Return here, choose <strong>Add vault</strong>, then connect a vault by name. Nothing is selected automatically.</li></ol>
        <ConnectionGuide href={GUIDE}>Step-by-step setup guide ↗</ConnectionGuide>
      </ConnectionSetup>}
      {state.configurationUnconfirmed && <ConnectionAlert>A connection change has not been confirmed by iCloud. Check again before relying on removal or adding another vault.</ConnectionAlert>}
      {!!state.uncertainOperations.length && <ConnectionAlert>{state.uncertainOperations.length} local operation{state.uncertainOperations.length === 1 ? '' : 's'} need exact receipt inspection with obsidian_status before retrying. No edit is replayed automatically.</ConnectionAlert>}
      {!!state.receiptFailures.length && <ConnectionAlert>Local receipt inspection is unavailable. Check iCloud and try again; an uncertain change must not be repeated.</ConnectionAlert>}
      {state.nextAction && <div className="pa-obsidian__source-help" role="status"><p>{state.nextAction}</p>{state.setup !== 'check_failed' && <a className="pa-connection__guide" href={ICLOUD}>Open iCloud settings</a>}</div>}
      {!!state.vaults.length && <ConnectionAccounts>{state.vaults.map(vault => {
        const name = vault.source?.name ?? vault.name ?? vault.vaultId;
        const caption = [duplicate(name) ? `Source ID: ${vault.vaultId}` : null, `Last successful sync: ${vault.source?.lastSuccess ? new Date(vault.source.lastSuccess).toLocaleString() : 'Not available'}`].filter(Boolean).join(' · ');
        return <ConnectionAccount key={vault.vaultId} initial={name[0]?.toUpperCase() ?? 'V'} label={name} caption={caption} status={sourceStatus(vault.source, state.setup)} warning={!vault.source?.local.available || state.setup === 'incompatible' || state.setup === 'check_failed'}
          action={<ConnectionButton disabled={busy} aria-label={`Remove ${label(vault.vaultId, name)}`} onClick={() => void change('remove', vault.vaultId)}>Remove</ConnectionButton>} />;
      })}</ConnectionAccounts>}
      {adding && <div className="pa-obsidian__picker" aria-label="Available vaults">
        <ConnectionHeading title="Choose a vault" action={<ConnectionButton disabled={busy} onClick={() => setAdding(false)}>Close</ConnectionButton>} />
        <p>Connecting gives BB read/write access to every Markdown note, including nested and hidden folders.</p>
        {!state.eligible.length ? <ConnectionEmpty>{state.setup === 'check_failed' || state.setup === 'incompatible' ? 'Available vaults could not be verified. Update both plugins if incompatible, then choose Check again.' : 'No additional locally available initialized vaults. Check the source in iCloud settings.'}</ConnectionEmpty> : <ul>{state.eligible.map(source => <li key={source.id}><span><strong>{source.name}</strong>{duplicate(source.name) && <small>Source ID: {source.id}</small>}</span><ConnectionButton tone="secondary" disabled={busy} aria-label={`Connect ${label(source.id, source.name)}`} onClick={() => void change('connect', source.id)}>Connect</ConnectionButton></li>)}</ul>}
      </div>}
    </>}
    <ConnectionFooter><ConnectionButton tone="secondary" disabled={busy} onClick={() => void refresh()}>Check again</ConnectionButton>{!!state?.vaults.length && <ConnectionGuide href={GUIDE} />}</ConnectionFooter>
  </section>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'obsidian-vaults', component: ObsidianSettings }); });
