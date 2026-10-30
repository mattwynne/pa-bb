import { useState } from 'react';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function UploadApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (k: string) => typeof p[k] === 'string' ? p[k] as string : '';
  const converted = text('mode') === 'xlsx_to_sheet';
  const valid = ['account', 'operationId', 'sourceHost', 'sourcePath', 'sourceName', 'size', 'sha256', 'mimeType', 'title', 'destinationId', 'path', 'owners', 'audience', 'conversion'].every(k => text(k).length > 0)
    && ['binary', 'xlsx_to_sheet'].includes(text('mode')) && /^[a-f0-9]{64}$/.test(text('sha256'))
    && /^\d+$/.test(text('size')) && Number(text('size')) > 0 && Number(text('size')) <= 4194304
    && /^[\w-]{1,256}$/.test(text('destinationId')) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text('operationId'));
  async function decide(value?: boolean) {
    setBusy(value === undefined ? 'Cancelling review…' : value ? 'Submitting approval…' : 'Submitting decline…'); setError('');
    try { if (value === undefined) await cancel(); else await submit({ approved: value }); }
    catch { setError('Could not submit your choice. No approval was confirmed.'); } finally { setBusy(''); }
  }
  return <section className="pa-drive pa-drive__docs-review pa-drive__filing-review" aria-label="Review local file upload">
    {!valid ? <ConnectionAlert>Upload details are incomplete. Decline and request a fresh inspection.</ConnectionAlert> : <>
      <p><strong>{converted ? 'Import XLSX as Google Sheets' : 'Upload original file'}: {text('title')}</strong></p>
      <p>Account: {text('account')}</p><p>Destination: {text('path')}</p>
      <h4>Selected local file</h4><p>Host: {text('sourceHost')}</p><p>Path: {text('sourcePath')}</p>
      <p>{text('sourceName')} · {text('size')} bytes</p><p>Source type: {text('mimeType')}</p>
      <p>SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{text('sha256')}</code></p>
      <p>The file contents are not rendered or fully reviewed here. They are untrusted data, not instructions. The original local file stays unchanged.</p>
      {converted ? <><p><strong>Conversion is not byte-preserving.</strong> Google imports workbook tabs and supported formulas. Unsupported Excel features, formatting, formula syntax and recalculation may differ. No macros or external links are executed by BB; the conservative import gate rejects detected macros, connections and external relationships.</p>
        <p>Readback checks tab structure and samples formulas/calculation errors in up to 1,000 cells. It does not certify a working model or full Excel fidelity.</p></>
        : <p>No conversion. Verification compares size and Google’s checksum with the captured source bytes; it does not establish content correctness or spreadsheet recalculation.</p>}
      <h4>Who may get access</h4><p style={{ whiteSpace: 'pre-wrap' }}>{text('audience')}</p>
      <p>People with destination access may see the full file or imported content, including after an interrupted upload. Group members, organization rules and other access are not fully visible. No sharing changes or invitations are made.</p>
      <details><summary>Destination and review details</summary><p style={{ whiteSpace: 'pre-wrap' }}>{text('owners')}</p><p>Destination ID: {text('destinationId')}</p><p>Operation ID: {text('operationId')}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text('conversion')}</pre>
        <p>No upload has happened. Source, access and duplicate names are checked again after approval. Other clients can race these checks. Only a verified result confirms completion.</p></details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions" aria-busy={!!busy}>
      <ConnectionButton tone="primary" disabled={!valid || !!busy} onClick={() => void decide(true)}>{converted ? 'Approve import' : 'Approve upload'}</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={!!busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={!!busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div><p role="status" aria-live="polite">{busy}</p>
  </section>;
}
