import { useState } from 'react';
import { fileLink } from './core/file-link.mjs';
import { filingTypeLabel } from './core/filing-presentation.mjs';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function FilingApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [submission, setSubmission] = useState(''), [error, setError] = useState('');
  const busy = submission !== '';
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const taskItems = p.kind === 'task' && Array.isArray(p.items) ? p.items as Record<string, unknown>[] : null;
  const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
  const id = (v: unknown) => typeof v === 'string' && /^[\w-]{1,256}$/.test(v);
  const validTask = !!text('account') && uuid(p.operationId) && taskItems !== null && taskItems.length > 0 && taskItems.length <= 20
    && taskItems.every(i => ['folder', 'move'].includes(String(i.kind)) && uuid(i.operationId) && id(i.destinationId)
      && (i.kind !== 'move' || id(i.fileId)) && ['title', 'from', 'to', 'accessChanges', 'sourceAudience', 'destinationAudience'].every(k => typeof i[k] === 'string' && i[k]));
  const valid = validTask || ['account', 'title', 'from', 'to', 'destinationId', 'sourceAudience', 'destinationAudience', 'audience', 'impact', 'operationId'].every(k => text(k).length > 0)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text('operationId'))
    && /^[\w-]{1,256}$/.test(text('destinationId')) && ['folder', 'move'].includes(text('kind'))
    && (text('kind') !== 'move' || /^[\w-]{1,256}$/.test(text('fileId')))
    && (p.sharedAncestors !== true || ['sourceOwners', 'destinationOwners', 'accessChanges', 'reviewReason'].every(k => text(k).length > 0));
  async function decide(approved?: boolean) {
    setSubmission(approved === undefined ? 'Cancelling review…' : approved ? 'Submitting approval…' : 'Submitting decline…'); setError('');
    try { if (approved === undefined) await cancel(); else await submit({ approved }); }
    catch { setError('Could not submit your choice. No approval was confirmed.'); }
    finally { setSubmission(''); }
  }
  return <section className="pa-drive pa-drive__docs-review pa-drive__filing-review" aria-label="Review filing and inherited access">
    {!valid ? <ConnectionAlert>Filing details are incomplete. Decline and request a fresh inspection.</ConnectionAlert> : <>
      {taskItems ? <>
        <p><strong>File {taskItems.length} requested items</strong></p><p>Account: {text('account')}</p>
        <p>Destination{new Set(taskItems.map(i => i.destinationId)).size === 1 ? '' : 's'}: {[...new Set(taskItems.map(i => String(i.to)))].join(' · ')}</p>
        <ul className="pa-drive__filing-task-list">{taskItems.map((i, n) => <li key={n}><strong>{i.kind === 'folder' ? 'Create folder: ' : 'Move: '}{String(i.title)}</strong>
          <p style={{ whiteSpace: 'pre-wrap' }}>{i.requiresApproval ? String(i.accessChanges) : 'No access change found in inspected lists.'}</p>
          <details><summary>Location and access details</summary><p>From: {String(i.from)}</p><p>To: {String(i.to)}</p>
            <dl><dt>Current visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{String(i.sourceAudience)}</dd>
              <dt>Destination visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{String(i.destinationAudience)}</dd>
              <dt>Path owners</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{String(i.destinationOwners)}</dd></dl>
            <p>{String(i.impact)}</p><p>Destination ID: {String(i.destinationId)} · File ID: {String(i.fileId || 'New folder')} · Operation: {String(i.operationId)}</p></details>
        </li>)}</ul>
        <p>One approval covers only these items and destinations. Direct shares stay unchanged. No invitations are sent. No write has happened.</p>
        <p>Each item is rechecked before writing; changes stop the task. Earlier items may complete before a later failure. Inspect individual receipts after interruption; never repeat the task. Approval expires ten minutes after preview.</p>
      </> : <>
      <p className="pa-drive__filing-title"><strong>{text('kind') === 'folder' ? 'Create folder: ' : 'Move existing file: '}{text('title')}</strong></p>
      <p className="pa-drive__filing-account">{text('kind') === 'folder' ? 'Creator and new folder owner: ' : 'Account: '}{text('account')}</p>
      <section className="pa-drive__filing-impact" aria-label="Access changes">
        <h4>Who may gain or lose access</h4>
        {p.sharedAncestors === true && <p style={{ whiteSpace: 'pre-wrap' }}>{text('sharedAncestorSummary') || text('reviewReason')}</p>}
        <p style={{ whiteSpace: 'pre-wrap' }}>{text('accessChanges') || text('impact')}</p>
      </section>
      <dl><dt>From</dt><dd>{text('from')}</dd><dt>To</dt><dd>{text('to')}</dd></dl>
      <p>{text('kind') === 'folder' ? 'The new folder belongs to the creator above; parent ownership stays unchanged. People may get access through the destination folder. No invitations are sent by this tool.' : 'Existing direct shares stay unchanged. Access through folders may change. Ownership, contents, file ID and link stay the same. No invitations are sent by this tool.'}</p>
      <p>No write has happened. Location and access are rechecked before submission.</p>
      <details><summary>Full access and folder details</summary>
        <dl><dt>File type</dt><dd>{filingTypeLabel(text('mimeType'))}</dd>
          {text('mimeType') && <><dt>Technical file type</dt><dd>{text('mimeType')}</dd></>}
          <dt>Current visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('sourceAudience')}</dd>
          <dt>Destination visible access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('destinationAudience')}</dd>
          {text('sourceOwners') && <><dt>Current path owners</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('sourceOwners')}</dd></>}
          {text('destinationOwners') && <><dt>Destination path owners</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{text('destinationOwners')}</dd></>}
        </dl>
        {text('reviewReason') && <p>{text('reviewReason')}</p>}
        <p>{text('impact')}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>Other parent folders may also provide access: {text('audience')}</p>
        {p.exampleOnly === true ? <p>Example only — all choices are no-ops, with no Google access.</p> : <>
          <a href={`https://drive.google.com/drive/folders/${encodeURIComponent(text('destinationId'))}`} target="_blank" rel="noreferrer">Open destination ↗</a>
          {text('kind') === 'move' && <p><a href={fileLink(text('fileId'), text('mimeType') || 'application/vnd.google-apps.document')} target="_blank" rel="noreferrer">Open existing file ↗</a></p>}
        </>}
        <p>Approval expires ten minutes after preview. If location, owners or access change, a fresh review is needed.</p>
        <p>Another person can change access after the final check. Readback detects differences; no automatic rollback occurs. After interruption, inspect this operation rather than repeating it. Only a verified tool result confirms completion.</p>
        <dl><dt>Destination ID</dt><dd>{text('destinationId')}</dd>{text('kind') === 'move' && <><dt>File ID</dt><dd>{text('fileId')}</dd></>}<dt>Operation ID</dt><dd>{text('operationId')}</dd></dl>
      </details>
      </>}
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions" aria-busy={busy}>
      <ConnectionButton tone="primary" disabled={!valid || busy} onClick={() => void decide(true)}>{submission === 'Submitting approval…' ? submission : 'Approve filing'}</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
    <p className="pa-drive__filing-status" role="status" aria-live="polite">{submission}</p>
  </section>;
}
