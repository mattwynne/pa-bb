import { useState } from 'react';
import { z } from 'zod';
import { ConnectionAlert, ConnectionButton } from './connection-ui.js';
const record = z.record(z.string(), z.unknown());
const selection = z.object({ tabId: z.string().min(1), startIndex: z.number().int(), endIndex: z.number().int(),
  textStyle: record.optional(), paragraphStyle: record.optional(), paragraphs: z.array(z.object({ text: z.string(), paragraphStyle: record,
    runs: z.array(z.object({ startIndex: z.number(), endIndex: z.number(), textStyle: record })) })).min(1) });
const payloadSchema = z.object({ account: z.string().min(1), documentId: z.string().regex(/^[\w-]{1,256}$/),
  operationId: z.string().uuid(), title: z.string(), expectedRevisionId: z.string().min(1), exampleOnly: z.boolean().optional(),
  selections: z.array(selection).max(16), page: z.object({ before: record, after: record }).nullable(), limits: z.string(),
}).refine(p => p.selections.length || p.page);
type Props = { interaction: { id: string; payload: unknown }; submit(value: { approved: boolean }): Promise<void>; cancel(): Promise<void> };
export function DocsFormatApproval(props: Props) { return <Review key={props.interaction.id} {...props} />; }
function Review({ interaction, submit, cancel }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const parsed = payloadSchema.safeParse(interaction.payload), p = parsed.success ? parsed.data : null;
  async function decide(value?: boolean) {
    setBusy(true); setError('');
    try { if (value === undefined) await cancel(); else await submit({ approved: value }); }
    catch { setError('Could not submit your choice. No new approval was confirmed.'); }
    finally { setBusy(false); }
  }
  const settings = (v: Record<string, unknown>) => Object.entries(v).map(([k, value]) => `${k}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('\n');
  return <section className="pa-drive pa-drive__docs-review" aria-label="Review Google Docs formatting" aria-busy={busy}>
    {!p ? <ConnectionAlert>Formatting details are incomplete. Decline and inspect again.</ConnectionAlert> : <>
      {p.exampleOnly && <p role="status"><strong>Example only.</strong> All choices are no-ops. No Google account or document is accessed.</p>}
      <p><strong>{p.title || 'Untitled document'}</strong></p>
      <dl><dt>Account</dt><dd>{p.account}</dd><dt>Required revision</dt><dd>{p.expectedRevisionId}</dd></dl>
      {!p.exampleOnly && <a href={`https://docs.google.com/document/d/${encodeURIComponent(p.documentId)}/edit`} target="_blank" rel="noreferrer">Open document ↗</a>}
      {p.selections.map((s, i) => <section key={i} aria-label={`Paragraph selection ${i + 1}`}>
        <h4>Tab {s.tabId} · UTF-16 range {s.startIndex}–{s.endIndex}</h4>
        <pre>{s.paragraphs.map(p => p.text).join('')}</pre>
        <h4>Apply only these properties</h4>
        {s.textStyle && <pre>{settings(s.textStyle)}</pre>}
        {s.paragraphStyle && <pre>{settings(s.paragraphStyle)}</pre>}
        <p>Sizes and paragraph spacing are points (pt). Line spacing is a percentage: 120 means 1.2 lines. START/END follow text direction.</p>
        <details><summary>Before: explicit paragraph and text-run styles</summary><pre>{JSON.stringify(s.paragraphs.map(({ paragraphStyle, runs }) => ({ paragraphStyle, runs })), null, 2)}</pre><p>Missing properties inherit named or editor defaults; they are not known zero values.</p></details>
      </section>)}
      {p.page && <section aria-label="Page changes"><h4>Page layout</h4><p>Letter portrait: 612 × 792 pt. Margins below are in points (72 pt = 1 inch). Other tabs stay unchanged.</p>
        <pre>{settings(p.page.after)}</pre><details><summary>Before: page style</summary><pre>{JSON.stringify(p.page.before, null, 2)}</pre></details></section>}
      <p>{p.limits}</p>
      <p>No write has happened. Approval submits one revision-guarded batch; changed revisions are rejected. This does not create tables, headers, footers or semantic headings. Only verified readback confirms completion, never actual font rendering.</p>
    </>}
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-drive__docs-actions">
      <ConnectionButton tone="primary" disabled={!p || busy} onClick={() => void decide(true)}>Approve formatting</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline</ConnectionButton>
      <ConnectionButton disabled={busy} onClick={() => void decide()}>Cancel review</ConnectionButton>
    </div>
  </section>;
}
