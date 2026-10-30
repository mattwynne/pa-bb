import { useState } from 'react';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
import './sheets-edit-approval.css';
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
const plain = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2000);
const typed = (v: unknown): v is { date: string } | { cad: number } => !!v && typeof v === 'object' && (Object.keys(v).length === 1) && (('date' in v && typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)) || ('cad' in v && typeof v.cad === 'number' && Number.isFinite(v.cad)));
const show = (v: unknown) => typed(v) ? ('date' in v ? `Civil date: ${v.date}` : `CAD amount: ${v.cad}`) : v === null || v === '' ? 'Blank (clear)' : typeof v === 'string' ? `Literal string: ${JSON.stringify(v)}` : `${typeof v === 'number' ? 'Number' : 'Boolean'}: ${String(v)}`;
const column = (i: number) => { let s = ''; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
export function SheetsEditApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const p = (interaction.payload && typeof interaction.payload === 'object' ? interaction.payload : {}) as Record<string, unknown>;
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const r = (p.range && typeof p.range === 'object' ? p.range : {}) as Record<string, number>;
  const values = p.values as unknown[][], formats = p.beforeFormats as (Record<string, unknown> | null)[][], before = p.before as (Record<string, unknown> | null)[][];
  const validBefore = (v: unknown) => v === null || !!v && typeof v === 'object' && Object.keys(v).length === 1 && Object.entries(v).every(([k, val]) =>
    k === 'stringValue' ? typeof val === 'string' && plain(val) : k === 'numberValue' ? typeof val === 'number' && plain(val) : k === 'boolValue' && typeof val === 'boolean');
  const valid = ['account', 'spreadsheetId', 'operationId', 'concurrency'].every(k => text(k).length > 0) && /^[\w-]{1,256}$/.test(text('spreadsheetId'))
    && ['sheetId', 'startRow', 'startColumn', 'rowCount', 'columnCount'].every(k => Number.isSafeInteger(r[k]) && r[k] >= 0)
    && r.rowCount > 0 && r.columnCount > 0 && r.columnCount <= 20 && r.rowCount * r.columnCount <= 100
    && Array.isArray(values) && values.length === r.rowCount && values.every(row => Array.isArray(row) && row.length === r.columnCount && row.every(v => plain(v) || typed(v)))
    && Array.isArray(before) && before.length === r.rowCount && before.every(row => Array.isArray(row) && row.length === r.columnCount && row.every(validBefore))
    && (p.formatTypedValues === undefined || typeof p.formatTypedValues === 'boolean')
    && ((formats === undefined && p.formatTypedValues !== true) || (Array.isArray(formats) && formats.length === r.rowCount && formats.every(row => Array.isArray(row) && row.length === r.columnCount && row.every(v => v === null || (!!v && typeof v === 'object' && !Array.isArray(v))))))
    && JSON.stringify([values, before, formats]).length <= 60000;
  async function decide(approved?: boolean) {
    setBusy(true); setError('');
    try { if (approved === undefined) await cancel(); else await submit({ approved }); }
    catch { setError('Could not submit your choice. No new approval was confirmed.'); }
    finally { setBusy(false); }
  }
  return <section className="pa-drive pa-drive__sheets-review" aria-label="Review spreadsheet values" aria-busy={busy}>
    {p.exampleOnly === true && <p role="status"><strong>Synthetic example.</strong> Every choice is a no-op. No Google account or file is accessed.</p>}
    {!valid ? <ConnectionAlert>Edit details are incomplete. Decline this request and inspect the range again.</ConnectionAlert> : <>
      <p><strong>{text('title') || 'Untitled spreadsheet'}</strong></p>
      <dl><dt>Account</dt><dd>{text('account')}</dd><dt>Tab</dt><dd>{text('tabTitle') || String(r.sheetId)}</dd></dl>
      {p.exampleOnly !== true && <a href={`https://docs.google.com/spreadsheets/d/${text('spreadsheetId')}/edit#gid=${r.sheetId}`} target="_blank" rel="noreferrer">Open spreadsheet ↗</a>}
      <p role="note">{text('concurrency')}</p>
      <p>Null or empty text clears a cell. Notes and other formatting stay as they are. {p.formatTypedValues === true ? "The date and CAD cells identified below also receive the indicated number formats." : "Existing number formats stay as they are, including for dates and CAD amounts."} No write has happened.</p>
      <table><caption>Exact proposed values</caption><thead><tr><th>Cell</th><th>Before</th><th>After</th></tr></thead><tbody>
        {values.flatMap((row, y) => row.map((value, x) => <tr key={`${y}:${x}`}><th scope="row">{column(r.startColumn + x)}{r.startRow + y + 1}</th>
          <td><pre>{show(before[y][x] === null ? null : Object.values(before[y][x]!)[0])}{p.formatTypedValues === true && typed(value) ? `\nNumber format before: ${JSON.stringify(formats?.[y]?.[x] ?? null)}` : ""}</pre></td><td><pre>{show(value)}{p.formatTypedValues === true && typed(value) ? ("date" in value ? "\nNumber format: DATE yyyy-mm-dd" : "\nNumber format: CURRENCY \"CAD \"#,##0.00;[Red]-\"CAD \"#,##0.00") : ""}</pre></td></tr>))}
      </tbody></table>
      <details><summary>Technical details</summary><dl><dt>Operation ID</dt><dd>{text('operationId')}</dd><dt>Spreadsheet ID</dt><dd>{text('spreadsheetId')}</dd><dt>Tab ID</dt><dd>{r.sheetId}</dd></dl></details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__sheets-actions">
      <ConnectionButton tone="primary" disabled={!valid || busy} onClick={() => void decide(true)}>Approve edit</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
