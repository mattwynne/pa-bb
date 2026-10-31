import { useState } from 'react';
import { z } from 'zod';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
const payloadSchema = z.object({ exampleOnly: z.boolean().optional(), account: z.string().min(1).max(320), documentId: z.string().regex(/^[\w-]{1,256}$/),
  operationId: z.string().uuid(), title: z.string().max(500), expectedRevisionId: z.string().min(1).max(2048), tabId: z.string().min(1).max(256),
  index: z.number().int().min(1), paragraphText: z.string().max(500), uri: z.string().url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }),
  widthPt: z.number().min(18).max(432), heightPt: z.number().min(1).max(648),
  asset: z.object({ mimeType: z.literal('image/png'), bytes: z.number().int().min(1).max(2097152), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), sha256: z.string().regex(/^[a-f0-9]{64}$/) }), limits: z.string().max(2000) });
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function DocsImageApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const parsed = payloadSchema.safeParse(interaction.payload), p = parsed.success ? parsed.data : null;
  async function decide(value?: boolean) {
    setBusy(true); setError('');
    try { if (value === undefined) await cancel(); else await submit({ approved: value }); }
    catch { setError('Could not submit your choice. No new approval was confirmed.'); }
    finally { setBusy(false); }
  }
  const cm = (pt: number) => (pt * 2.54 / 72).toFixed(2);
  return <section className="pa-drive pa-drive__docs-review" aria-label="Review Google Docs image insertion" aria-busy={busy}>
    {!p ? <ConnectionAlert>Image details are incomplete. Decline and inspect again.</ConnectionAlert> : <>
      {p.exampleOnly && <p role="status"><strong>Example only.</strong> Every choice is a no-op. No Google account, document or image URL is accessed.</p>}
      <p><strong>{p.title || 'Untitled document'}</strong></p>
      <dl><dt>Account</dt><dd>{p.account}</dd><dt>Required revision</dt><dd>{p.expectedRevisionId}</dd>
        <dt>Insertion</dt><dd>Tab {p.tabId} · paragraph start {p.index} (UTF-16)</dd>
        <dt>Size</dt><dd>{cm(p.widthPt)} × {cm(p.heightPt)} cm ({p.widthPt.toFixed(2)} × {p.heightPt.toFixed(2)} pt), aspect ratio preserved</dd>
        <dt>Public PNG</dt><dd>{p.asset.width} × {p.asset.height} pixels · {p.asset.bytes} bytes</dd></dl>
      {!p.exampleOnly && <p><a href={`https://docs.google.com/document/d/${encodeURIComponent(p.documentId)}/edit`} target="_blank" rel="noreferrer">Open document ↗</a></p>}
      <p className="pa-drive__image-uri">{p.uri}</p>
      <p>The image URL is already public and will be saved by Google. This card does not load it or change its sharing.</p>
      <details><summary>Checked asset SHA-256</summary><pre>{p.asset.sha256}</pre></details>
      <h4>Insert before this existing paragraph</h4><pre>{p.paragraphText}</pre>
      <p><strong>Existing text stays.</strong> This adds one inline image; it does not replace the wordmark, create a header, set alt text or change page styles.</p>
      <p>No write has happened. Approval submits one revision-guarded insertion after rechecking the document and public asset. The URL can still change before Google fetches it. Verified API readback is not proof of embedded image bytes or visual rendering.</p>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions">
      <ConnectionButton tone="primary" disabled={!p || busy} onClick={() => void decide(true)}>Approve image insertion</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
