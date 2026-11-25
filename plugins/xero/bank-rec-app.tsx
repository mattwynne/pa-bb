import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import type { CaptureSummary } from './bank-rec.ts';
import { ConnectionAlert, ConnectionButton, ConnectionDisclosure, ConnectionEmpty, ConnectionGuide } from './connection-ui.tsx';

export function BankRecSettings({ organisations }: { organisations: { tenantId: string; tenantName: string }[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [tenantId, setTenant] = useState(''), [captures, setCaptures] = useState<CaptureSummary[]>([]), [page, setPage] = useState(1), [nextPage, setNextPage] = useState<number | null>(null);
  const [total, setTotal] = useState(0), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const current = useRef(tenantId), request = useRef(0); current.current = tenantId;
  const ids = organisations.map(org => org.tenantId).join(',');
  useEffect(() => { if (tenantId && !organisations.some(org => org.tenantId === tenantId)) setTenant(''); }, [ids]);
  async function load(tenant: string, targetPage = 1) {
    const ticket = ++request.current;
    try {
      const result = await rpc.call('bankRecList', { tenantId: tenant, page: targetPage });
      if (current.current !== tenant || request.current !== ticket) return;
      if (!result.ok) { setError(result.error); return; }
      setLoaded(true); setCaptures(result.captures); setTotal(result.total); setNextPage(result.nextPage); setPage(targetPage);
    } catch { if (current.current === tenant && request.current === ticket) setError('Could not load imported snapshots. Previous captures are retained; try Refresh snapshots.'); }
  }
  useEffect(() => { setCaptures([]); setLoaded(false); setTotal(0); setNextPage(null); setPage(1); setError(''); setNotice(''); if (tenantId) void load(tenantId); }, [tenantId]);
  async function installer() {
    const tenant = tenantId; setBusy('Preparing private installer…'); setError(''); setNotice('');
    try {
      const result = await rpc.call('bankRecInstaller', { tenantId: tenant });
      if (current.current !== tenant) return;
      if (!result.ok) { setError(result.error); return; }
      const url = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setNotice('Installer downloaded. Open it in your browser and follow its bookmark instructions. It contains private bank account names and IDs, not credentials.');
    } catch { setError('Could not prepare the installer. Check the selected organisation’s bank-account read access and try again.'); }
    finally { setBusy(''); }
  }
  async function importFile(file: File) {
    const tenant = tenantId; setBusy('Verifying and importing capture…'); setError(''); setNotice('');
    try {
      if (file.size > 1_000_000) { setError('Capture exceeds 1 MB. Export a smaller visible page.'); return; }
      const json = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const result = await rpc.call('bankRecImport', { tenantId: tenant, json });
      if (current.current !== tenant) return;
      if (!result.ok) { setError(result.error); return; }
      setNotice(`${result.outcome === 'already_imported' ? 'Already imported' : 'Imported'}: ${result.capture.lineCount} visible lines for ${result.capture.accountName} (${result.capture.currency}), captured ${new Date(result.capture.capturedAt).toLocaleString()}. No Xero records were changed.`);
      await load(tenant);
    } catch { setError('Could not import this file. Choose the complete bookmarklet JSON download, not CSV or an installer. Existing captures are retained.'); }
    finally { setBusy(''); }
  }
  async function remove(capture: CaptureSummary) {
    if (!window.confirm('Remove this imported snapshot from BB? This does not change or reconcile any Xero record, or delete the original file downloaded by your browser. Other captures are retained.')) return;
    const tenant = tenantId; setBusy('Removing local snapshot…'); setError(''); setNotice('');
    try { const result = await rpc.call('bankRecRemove', { tenantId: tenant, captureId: capture.id }); if (!result.ok) setError(result.error); else { setNotice('Local snapshot removed. Xero and other captures are unchanged.'); await load(tenant); } }
    catch { setError('Removal was not confirmed. Refresh snapshots before retrying.'); }
    finally { setBusy(''); }
  }
  return <section className="pa-xero-bank-rec" aria-label="Bank reconciliation snapshots" aria-busy={Boolean(busy)}>
    <h3>Bank reconciliation snapshots</h3>
    <p>Capture visible statement lines in your normally signed-in browser, then import the JSON here. No automated login or reconciliation clicks.</p>
    <label className="pa-xero-bank-rec__label">Organisation<select value={tenantId} disabled={Boolean(busy)} onChange={event => { current.current = event.target.value; request.current++; setCaptures([]); setLoaded(false); setTenant(event.target.value); }}>
      <option value="">Choose organisation</option>{organisations.map(org => <option key={org.tenantId} value={org.tenantId}>{org.tenantName}</option>)}
    </select></label>
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-xero-bank-rec__actions">
      <ConnectionButton tone="secondary" disabled={!tenantId || Boolean(busy)} onClick={() => void installer()}>Download bookmarklet installer</ConnectionButton>
      <label className="pa-xero-bank-rec__label">Import capture JSON<input type="file" accept=".json,application/json" disabled={!tenantId || Boolean(busy)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file && tenantId && !busy) void importFile(file); }} /></label>
    </div>
    <p role="status" aria-live="polite">{busy || notice}</p>
    <ConnectionDisclosure summary="How to capture and import">
      <ol><li>Select the organisation above and download its private installer. Open the downloaded HTML file and drag its link to your bookmarks bar. A manual-copy option is included.</li>
        <li>In your usual browser, sign into Xero yourself, open an account’s Reconcile tab and click the bookmark. Save the JSON it downloads.</li>
        <li>Choose that JSON with Import capture JSON above. Repeat for each account or page you need. Old version-1 bookmarklet downloads are supported too.</li></ol>
      <p>Captures are editable historical evidence, not a live or complete bank feed. Identical distinct rows are kept. Overlapping snapshots must not be added together; empty or unrecognised pages fail rather than proving reconciliation is complete.</p>
      <ConnectionGuide href="https://github.com/mattwynne/pa-bb/blob/main/plugins/xero/references/bank-rec.md">Full capture guide ↗</ConnectionGuide>
    </ConnectionDisclosure>
    {tenantId && <>
      <h4>Imported snapshots</h4><p>Each row is one separate capture. Ask the assistant to read it by account and capture time; import a fresh capture when you need an updated queue.</p>
      {!loaded ? <ConnectionEmpty>{error ? 'Snapshot list unavailable. Try Refresh snapshots.' : 'Loading imported snapshots…'}</ConnectionEmpty> : !total ? <ConnectionEmpty>No snapshots imported for this organisation. Import the bookmarklet’s JSON to get started.</ConnectionEmpty>
        : <ul className="pa-xero-bank-rec__captures">{captures.map(capture => <li key={capture.id}><div><strong>{capture.accountName} · {capture.currency}</strong>
          <span>{capture.lineCount} visible lines · Captured {new Date(capture.capturedAt).toLocaleString()}</span><span>Imported {new Date(capture.importedAt).toLocaleString()} · Partial coverage</span></div>
          <ConnectionButton disabled={Boolean(busy)} aria-label={`Remove capture for ${capture.accountName} captured ${capture.capturedAt}`} onClick={() => void remove(capture)}>Remove</ConnectionButton></li>)}</ul>}
      <div className="pa-xero-bank-rec__actions"><ConnectionButton disabled={Boolean(busy)} onClick={() => void load(tenantId, page)}>Refresh snapshots</ConnectionButton>
        {page > 1 && <ConnectionButton disabled={Boolean(busy)} onClick={() => void load(tenantId, page - 1)}>Newer snapshots</ConnectionButton>}
        {nextPage && <ConnectionButton disabled={Boolean(busy)} onClick={() => void load(tenantId, nextPage)}>Older snapshots</ConnectionButton>}</div>
    </>}
  </section>;
}
