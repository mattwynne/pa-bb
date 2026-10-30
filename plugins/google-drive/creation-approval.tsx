import { useState } from 'react';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
import { filingTypeLabel } from './core/filing-presentation.mjs';

type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function CreationApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const valid = ['account', 'operationId', 'destinationId', 'path', 'owners', 'audience', 'title', 'mimeType', 'content'].every(k => text(k).length > 0)
    && /^[\w-]{1,256}$/.test(text('destinationId'))
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text('operationId'))
    && ['application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet'].includes(text('mimeType'));
  async function decide(value?: boolean) {
    setBusy(value === undefined ? 'Cancelling review…' : value ? 'Submitting approval…' : 'Submitting decline…'); setError('');
    try { if (value === undefined) await cancel(); else await submit({ approved: value }); }
    catch { setError('Could not submit your choice. No approval was confirmed.'); } finally { setBusy(''); }
  }
  return <section className="pa-drive pa-drive__docs-review pa-drive__filing-review" aria-label="Review shared creation">
    {!valid ? <ConnectionAlert>Creation details are incomplete. Decline and request a fresh inspection.</ConnectionAlert> : <>
      <p><strong>Create {filingTypeLabel(text('mimeType'))}: {text('title')}</strong></p>
      <p>Account: {text('account')}</p><p>Destination: {text('path')}</p>
      <h4>Who may get access</h4><p style={{ whiteSpace: 'pre-wrap' }}>{text('audience')}</p>
      <p>A blank file, partial content, or the full content may be visible to people with destination access and may remain if creation fails. Group members, organization rules and other access are not fully visible.</p>
      <details><summary>Complete requested content</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text('content')}</pre></details>
      <details><summary>Destination and review details</summary><p style={{ whiteSpace: 'pre-wrap' }}>{text('owners')}</p><p>Destination ID: {text('destinationId')}</p><p>Operation ID: {text('operationId')}</p>
        <p>No write has happened. Access is checked again before creation and population. Another client can change access after those checks. No sharing changes or invitations are made. Only a verified result confirms completion.</p></details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions" aria-busy={!!busy}>
      <ConnectionButton tone="primary" disabled={!valid || !!busy} onClick={() => void decide(true)}>Approve creation</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={!!busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={!!busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div><p role="status" aria-live="polite">{busy}</p>
  </section>;
}
