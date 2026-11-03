import {useState} from 'react';
import {replacementReviewSchema} from './docs-replacement-review-schema.mjs';
import {ConnectionAlert,ConnectionButton} from './connection-ui.js';
type Props={interaction:{id:string;payload:unknown};submit(value:{approved:boolean}):Promise<void>;cancel():Promise<void>};
export function DocsReplacementApproval(props:Props){return <Review key={props.interaction.id} {...props}/>;}
function Review({interaction,submit,cancel}:Props){const [busy,setBusy]=useState(false),[error,setError]=useState(''),parsed=replacementReviewSchema.safeParse(interaction.payload),p=parsed.success?parsed.data:null;
 async function decide(choice?:boolean){setBusy(true);setError('');try{if(choice===undefined)await cancel();else await submit({approved:choice});}catch{setError('Could not submit this choice. No new approval was confirmed.');}finally{setBusy(false);}}
 return <section className="pa-drive pa-drive__docs-review" aria-label="Review Google Docs text replacement" aria-busy={busy}>
 {!p?<ConnectionAlert>Replacement details are incomplete. Decline and inspect again.</ConnectionAlert>:<>
 <p><strong>{p.title||'Untitled document'}</strong></p><dl><dt>Account</dt><dd>{p.account}</dd><dt>Required revision</dt><dd>{p.expectedRevisionId}</dd><dt>Immutable plan head (SHA-256)</dt><dd style={{overflowWrap:'anywhere'}}>{p.headHash}</dd><dt>Seal expiry (UTC)</dt><dd>{p.sealExpiry}</dd><dt>Effective card/consent expiry (UTC)</dt><dd>{p.cardExpiry}</dd></dl>
 <a href={`https://docs.google.com/document/d/${encodeURIComponent(p.documentId)}/edit`} target="_blank" rel="noreferrer">Open document ↗</a>
 <p>Exactly {p.count} match in the selected paragraph. Tab {p.range.tabId}; selected literal UTF-16 range {p.range.startIndex}–{p.range.endIndex}. Index shift: {p.delta}.</p>
 <p>{p.changedRange.endIndex>p.changedRange.startIndex?`Actual deletion range: ${p.changedRange.startIndex}–${p.changedRange.endIndex}.`:'No deletion (insertion-only minimal difference).'} {p.insertedRange.endIndex>p.insertedRange.startIndex?`Actual insertion/style range: ${p.insertedRange.startIndex}–${p.insertedRange.endIndex}.`:'No insertion or style patch.'}</p>
 <h4>Literal old text</h4><pre>{p.oldText}</pre><h4>Literal new text</h4>{p.newText?<pre>{p.newText}</pre>:<p>Delete this literal text (empty replacement).</p>}
 <h4>Full paragraph before</h4><pre>{p.beforeParagraph}</pre><h4>Full paragraph after</h4><pre>{p.afterParagraph}</pre>
 <h4>Inserted style — preserve unchanged, inherit original start</h4><pre>{JSON.stringify(p.insertedStyle,null,2)}</pre><details><summary>Observed explicit/named style provenance</summary><pre>{JSON.stringify(p.beforeStyleSources,null,2)}</pre></details>
 {p.weightEvidence&&<section aria-label="Documented font weight provenance"><h4>Font weight: observed versus documented default</h4>{p.weightEvidence.runs.map((r:any,i:number)=><p key={i}>{r.fontFamily}: weight {r.weight} — {r.provenance==='documentedDefault'?'documented default (not observed)':'observed'}. Source: {r.source}. {r.reference}</p>)}<p>Raw source presence is preserved. Weight 400 is not a claim about bold appearance, rendered weight or font fidelity.</p></section>}
 <p>{p.limits}</p><p>No write has happened. Approval permits only this exact revision-bound replacement; only independent readback can confirm its effect.</p></>}
 {error&&<ConnectionAlert>{error}</ConnectionAlert>}<div className="pa-drive__docs-actions"><ConnectionButton tone="primary" disabled={!p||busy} onClick={()=>void decide(true)}>Approve replacement</ConnectionButton><ConnectionButton tone="secondary" disabled={busy} onClick={()=>void decide(false)}>Decline</ConnectionButton><ConnectionButton disabled={busy} onClick={()=>void decide()}>Cancel review</ConnectionButton></div></section>;
}
