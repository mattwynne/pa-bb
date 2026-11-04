import {useEffect,useState} from 'react';
import {compositionReviewSchema} from './docs-composition-review-schema.mjs';
import {ConnectionAlert,ConnectionButton} from './connection-ui.js';
type Props={interaction:{id:string;payload:unknown};submit(value:{approved:boolean}):Promise<void>;cancel():Promise<void>};
export function DocsCompositionApproval(props:Props){return <Review key={props.interaction.id} {...props}/>;}
function Review({interaction,submit,cancel}:Props){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[expired,setExpired]=useState(false),parsed=compositionReviewSchema.safeParse(interaction.payload),p=parsed.success?parsed.data:null,deadline=p?Date.parse(p.cardExpiry):0;
 useEffect(()=>{setExpired(deadline<=Date.now());if(!deadline)return;const timer=setTimeout(()=>setExpired(true),Math.max(0,deadline-Date.now()));return()=>clearTimeout(timer);},[deadline]);
 async function decide(approved?:boolean){setBusy(true);setError('');try{if(approved===undefined)await cancel();else if(!approved||p&&deadline>Date.now())await submit({approved});else setError('This review expired. Inspect the same operation; it cannot be resumed here.');}catch{setError('Could not submit this choice. No new approval was confirmed.');}finally{setBusy(false);}}
 const pre={whiteSpace:'pre-wrap' as const,overflowWrap:'anywhere' as const};
 return <section className="pa-drive pa-drive__docs-review" aria-label="Review complete Google Docs paragraph program" aria-busy={busy}>
 {!p?<ConnectionAlert>Program details are incomplete. Decline and inspect the same operation.</ConnectionAlert>:<>
 <p><strong>{p.title||'Untitled document'}</strong></p><dl><dt>Account</dt><dd>{p.account}</dd><dt>Document</dt><dd><a href={`https://docs.google.com/document/d/${encodeURIComponent(p.documentId)}/edit`} target="_blank" rel="noreferrer">Open document ↗</a></dd><dt>Required revision</dt><dd>{p.expectedRevisionId}</dd><dt>Immutable program head (SHA-256)</dt><dd style={pre}>{p.headHash}</dd><dt>Seal expiry (UTC)</dt><dd>{p.sealExpiry}</dd><dt>Effective review expiry (UTC)</dt><dd>{p.cardExpiry}</dd></dl>
 <p>Approve all {p.commands.length} commands together, in this intention order. One atomic batch; original paragraph identities remain fixed even when earlier replacements change text length.</p>
 <ol>{p.commands.map(c=><li key={c.ordinal}><section aria-label={`Command ${c.ordinal}: ${c.kind==='bold'?'paragraph bold':'literal replacement'}`}>
 <h4>{c.kind==='bold'?`Set paragraph bold to ${c.bold?'on':'off'}`:'Replace one exact literal'}</h4><p>Original node: <code style={pre}>{c.node}</code>. Tab {c.range.tabId}; original UTF-16 range {c.range.startIndex}–{c.range.endIndex}.</p>
 <details><summary>Original identity and ordered source provenance</summary><pre style={pre}>{JSON.stringify({path:c.path,provenance:c.provenance},null,2)}</pre></details>
 <h5>Complete paragraph before</h5><pre style={pre}>{c.beforeParagraph}</pre><h5>Complete paragraph after</h5><pre style={pre}>{c.afterParagraph}</pre>
 {c.kind==='bold'?<><h5>Bold property changes — every original run</h5>{c.runs.map((r,i)=><div key={i}><p>UTF-16 {r.startIndex}–{r.endIndex}: {String(r.effectiveBefore.value)} → {String(c.bold)}; {r.effectiveBefore.provenance}{r.effectiveBefore.source?` (${r.effectiveBefore.source})`:''}.</p><pre style={pre}>{r.text}</pre><details><summary>Complete stored style before; only bold changes</summary><pre style={pre}>{JSON.stringify(r.beforeStyle,null,2)}</pre></details></div>)}</>:<>
 <h5>Literal old text</h5><pre style={pre}>{c.oldText}</pre><h5>Literal new text</h5>{c.newText?<pre style={pre}>{c.newText}</pre>:<p>Empty replacement: delete this exact literal.</p>}
 <p>Minimal deletion: {c.changedRange.startIndex}–{c.changedRange.endIndex}. Insertion/style: {c.insertedRange.startIndex}–{c.insertedRange.endIndex}. Downstream shift: {c.delta} UTF-16 units.</p>
 <h5>All seven inserted style properties</h5><pre style={pre}>{JSON.stringify(c.insertedStyle,null,2)}</pre><details><summary>Observed explicit/named style sources</summary><pre style={pre}>{JSON.stringify(c.beforeStyleSources,null,2)}</pre></details>{c.weightEvidence&&<details><summary>Documented weight 400 provenance — not rendering proof</summary><pre style={pre}>{JSON.stringify(c.weightEvidence,null,2)}</pre></details>}</>}
 </section></li>)}</ol><h4>Preservation and execution boundary</h4><ul>{[...p.preservation,...p.limits].map((s,i)=><li key={i}>{s}</li>)}</ul><p>Approval covers this whole exact program, not individual commands or an edited future revision. Only independent complete readback can confirm the edit.</p>
 </>}
 {(expired||p&&deadline<=Date.now())&&<ConnectionAlert>This review expired. It cannot authorize another attempt.</ConnectionAlert>}{error&&<ConnectionAlert>{error}</ConnectionAlert>}
 <div className="pa-drive__docs-actions"><ConnectionButton tone="primary" disabled={!p||busy||expired||deadline<=Date.now()} onClick={()=>void decide(true)}>Approve entire program</ConnectionButton><ConnectionButton tone="secondary" disabled={busy} onClick={()=>void decide(false)}>Decline</ConnectionButton><ConnectionButton disabled={busy} onClick={()=>void decide()}>Cancel review</ConnectionButton></div>
 </section>;
}
