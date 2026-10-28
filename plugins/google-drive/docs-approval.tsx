import { useState } from 'react';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';

type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function DocsApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = interaction.payload && typeof interaction.payload === 'object' ? interaction.payload as Record<string, unknown> : {};
  const text = (key: string) => typeof p[key] === 'string' ? p[key] as string : '';
  const valid = ['account', 'documentId', 'tabId', 'expectedRevisionId', 'oldText'].every(key => text(key).length > 0)
    && typeof p.newText === 'string' && text('oldText').length <= 2000 && text('newText').length <= 2000 && /^[\w-]+$/.test(text('documentId'));
  async function decide(approved?: boolean) {
    setBusy(true); setError('');
    try { if (approved === undefined) await cancel(); else await submit({ approved }); }
    catch { setError('Could not submit your choice. No new approval was confirmed.'); }
    finally { setBusy(false); }
  }
  return <section className="pa-drive pa-drive__docs-review" aria-label="Review Google Docs replacement" aria-busy={busy}>
    {p.exampleOnly === true && <p role="status"><strong>Example only.</strong> These controls close a synthetic preview. No Google account or document is accessed, even if you approve.</p>}
    {!valid ? <ConnectionAlert>Replacement details are incomplete. Decline this request and inspect the document again.</ConnectionAlert> : <>
      <p><strong>{text('title') || 'Untitled document'}</strong></p>
      <dl>
        <dt>Account</dt><dd>{text('account')}</dd>
        <dt>Tab</dt><dd>{text('tabTitle') || text('tabId')}</dd>
      </dl>
      {p.exampleOnly !== true && <a href={`https://docs.google.com/document/d/${encodeURIComponent(text('documentId'))}/edit`} target="_blank" rel="noreferrer">Open document ↗</a>}
      <h4>Replace exactly this text</h4><pre>{text('oldText')}</pre>
      <h4>With</h4><pre>{text('newText') || '(delete the matched text)'}</pre>
      <p>One match in this tab only. No write has happened. If anyone edits the document before this is applied, the replacement is rejected. Google controls formatting inheritance; paragraph boundaries stay unchanged.</p>
      <details><summary>Technical details</summary><dl>
        <dt>Document ID</dt><dd>{text('documentId')}</dd>
        <dt>Tab ID</dt><dd>{text('tabId')}</dd>
        <dt>Required revision</dt><dd>{text('expectedRevisionId')}</dd>
      </dl></details>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions">
      <ConnectionButton tone="primary" disabled={!valid || busy} onClick={() => void decide(true)}>Approve replacement</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
