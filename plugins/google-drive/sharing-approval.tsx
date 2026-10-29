import { useState } from 'react';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function SharingApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const valid = ['account', 'fileId', 'title', 'audience', 'action', 'from', 'to', 'notification', 'impact', 'risk', 'concurrency', 'operationId'].every(k => text(k).length > 0)
    && /^[\w-]{1,256}$/.test(text('fileId')) && ['file', 'folder'].includes(text('kind')) && ['grant', 'change', 'revoke'].includes(text('action'));
  async function decide(approved?: boolean) {
    setBusy(true); setError('');
    try { if (approved === undefined) await cancel(); else await submit({ approved }); }
    catch { setError('Could not submit your choice. No new approval was confirmed.'); }
    finally { setBusy(false); }
  }
  return <section className="pa-drive pa-drive__docs-review pa-drive__sharing-review" aria-label="Review sharing change" aria-busy={busy}>
    {!valid ? <ConnectionAlert>Sharing details are incomplete. Decline and request a fresh inspection.</ConnectionAlert> : <>
      <p><strong>{text('title')}</strong> · {text('kind')}</p>
      <dl><dt>Account</dt><dd>{text('account')}</dd><dt>Audience</dt><dd>{text('audience')}</dd>
        <dt>Current</dt><dd>{text('from')}</dd><dt>Proposed</dt><dd>{text('to')}</dd></dl>
      <a href={`https://drive.google.com/${text('kind') === 'folder' ? 'drive/folders/' : 'file/d/'}${encodeURIComponent(text('fileId'))}`} target="_blank" rel="noreferrer">Open {text('kind')} ↗</a>
      <p><strong>Notifications:</strong> {text('notification')}</p>
      <p>{text('impact')}</p><p>{text('risk')}</p>
      <p>Other permissions and owners are preserved. Google-visible sharing is not an exhaustive audience or a privacy guarantee. Removing a permission does not revoke copies already made.</p>
      <p>No write has happened. Approval expires 10 minutes after the preview was created. State is rechecked after approval; changed or expired previews are not applied.</p>
      <details><summary>Concurrency and recovery</summary><p>{text('concurrency')}</p>
        <dl><dt>Item ID</dt><dd>{text('fileId')}</dd><dt>Operation ID</dt><dd>{text('operationId')}</dd></dl>
        <p>Only a verified tool result confirms readback. After interruption, inspect this operation; do not repeat the change or send another invitation.</p></details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions">
      <ConnectionButton tone="primary" disabled={!valid || busy} onClick={() => void decide(true)}>Approve sharing change</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
