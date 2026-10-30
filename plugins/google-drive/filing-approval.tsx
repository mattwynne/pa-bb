import { useState } from 'react';
import { fileLink } from './core/file-link.mjs';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function FilingApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const valid = ['account', 'title', 'from', 'to', 'destinationId', 'sourceAudience', 'destinationAudience', 'audience', 'impact', 'operationId'].every(k => text(k).length > 0)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text('operationId'))
    && /^[\w-]{1,256}$/.test(text('destinationId')) && ['folder', 'move'].includes(text('kind'))
    && (text('kind') !== 'move' || /^[\w-]{1,256}$/.test(text('fileId')))
    && (p.sharedAncestors !== true || ['sourceOwners', 'destinationOwners', 'accessChanges', 'reviewReason'].every(k => text(k).length > 0));
  async function decide(approved?: boolean) {
    setBusy(true); setError('');
    try { if (approved === undefined) await cancel(); else await submit({ approved }); }
    catch { setError('Could not submit your choice. No approval was confirmed.'); }
    finally { setBusy(false); }
  }
  return <section className="pa-drive pa-drive__docs-review" aria-label="Review filing and inherited access" aria-busy={busy}>
    {!valid ? <ConnectionAlert>Filing details are incomplete. Decline and request a fresh inspection.</ConnectionAlert> : <>
      <p><strong>{text('kind') === 'folder' ? 'Create folder: ' : 'Move existing file: '}{text('title')}</strong></p>
      <dl><dt>Account</dt><dd>{text('account')}</dd><dt>From</dt><dd>{text('from')}</dd><dt>To</dt><dd>{text('to')}</dd>
        {text('mimeType') && <><dt>File type</dt><dd>{text('mimeType')}</dd></>}
        <dt>Current visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('sourceAudience')}</dd>
        <dt>Destination visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('destinationAudience')}</dd>
        {text('sourceOwners') && <><dt>Current path owners</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('sourceOwners')}</dd></>}
        {text('destinationOwners') && <><dt>Destination path owners</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('destinationOwners')}</dd></>}
        {text('accessChanges') && <><dt>Potential inherited-access changes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('accessChanges')}</dd></>}
      </dl>
      {text('reviewReason') && <p>{text('reviewReason')}</p>}
      {p.exampleOnly === true ? <p>Example only — all choices are no-ops, with no Google access.</p> : <>
        <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(text('destinationId'))}`} target="_blank" rel="noreferrer">Open destination ↗</a>
        {text('kind') === 'move' && <p><a href={fileLink(text('fileId'), text('mimeType') || 'application/vnd.google-apps.document')} target="_blank" rel="noreferrer">Open existing file ↗</a></p>}
      </>}
      <p>{text('impact')}</p>
      <p>No permissions, ownership, content or invitations are changed explicitly. A move keeps the file’s ID and URL. Filing can still change inherited access.</p>
      <p>No write has happened. Approval expires ten minutes after preview. Live location, authority and visible access are rechecked before submission.</p>
      <details><summary>Concurrency and recovery</summary>
        <p style={{ whiteSpace: 'pre-wrap' }}>Other inspected ancestry may also carry access: {text('audience')}</p>
        <p>Another actor can race the final inspection. Readback detects differences; no automatic rollback occurs. After interruption, inspect this operation rather than repeating it.</p>
        <dl><dt>Destination ID</dt><dd>{text('destinationId')}</dd>{text('kind') === 'move' && <><dt>File ID</dt><dd>{text('fileId')}</dd></>}<dt>Operation ID</dt><dd>{text('operationId')}</dd></dl>
      </details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions">
      <ConnectionButton tone="primary" disabled={!valid || busy} onClick={() => void decide(true)}>Approve filing</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
