// Historical D/E regression isolation ONLY. Never change the checkout or add
// candidate credit to the current normal run. Retained D fixtures remain inert.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../',import.meta.url));
const load=(root,path)=>JSON.parse(readFileSync(join(root,path)));
const save=(root,path,x)=>writeFileSync(join(root,path),JSON.stringify(x,null,2)+'\n');
function owned(root){assert.notEqual(realpathSync(root),realpathSync(source),'isolation cannot edit workspace');}
export function restoreHistoricalDCandidates(root){
 owned(root);omitNormalizationIntegration(root);restoreHistoricalLiteralCandidate(root);const file='features/docs/coverage/bridge-cases.json',index=load(root,file);
 for(const caseId of [...['success','counterexample'].map(o=>`C009.wrongThread__local.${o}`),...['success','invalid','wrongSubject'].map(o=>`C005.text__read.${o}`)]){
  const path=`features/docs/coverage/fixtures/bridge/${caseId}.json`,bytes=readFileSync(join(root,path)),f=JSON.parse(bytes);
  index[caseId]={caseId,path,sha256:createHash('sha256').update(bytes).digest('hex'),provenance:f.provenance};
 }
 save(root,file,index);
 const path=join(root,'features/docs/semantic-bridge-d.feature');let text=readFileSync(path,'utf8');
 if(!text.includes('C009.wrongThread__local.success'))text+=`\n  @F_READ @S_COVERAGE
  Scenario Outline: Historical owner invariant isolation [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C009.wrongThread__local.success |
      | C009.wrongThread__local.counterexample |
`;
 if(!text.includes('C005.text__read.success')){
  const marker='  @F_SELECT @S_LITERAL';assert.equal(text.split(marker).length,2);
  text=text.replace(marker,`  @F_READ @S_PROJECTIONS
  Scenario Outline: Historical text invariant isolation [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C005.text__read.success |
      | C005.text__read.invalid |
      | C005.text__read.wrongSubject |

`+marker);
 }
 writeFileSync(path,text);
 // Original D means the original route availability too. Restore it ONLY in
 // this disposable profile: structured was absent and text had three outcomes.
 const adapter=join(root,'features/docs/coverage/execution-adapters.mjs');let code=readFileSync(adapter,'utf8');
 const added=code.split('\n').filter(line=>line.includes("['structured','styleAnnotations','reviewAnnotations','omitImages','continuation'].map")||line.includes("['styles','objects','ranges','suggestions'].map")||line.includes("['adjacentRuns','inlineObject','nestedTable','paragraphNewlines'].map")||line.includes("['autoText','drawing','equation','toc','unknown'].map")||line.includes("['body','header','footer','footnote'].map")||line.includes("['inline','acceptedPreview','rejectedPreview','projectionNotEditProof'].map")||line.includes("['deniedComments','missingReviewCoverage','tabsAndInline'].map"));
 assert.ok(added.length<=7);for(const line of added)code=code.replace(line+'\n','');
 const route="action:'read',outcomes:['success','invalid','preservation','bounds','wrongSubject']",historical="action:'read',outcomes:['success','invalid','wrongSubject']";
 if(code.includes(route)){assert.equal(code.split(route).length,2);code=code.replace(route,historical);}else assert.ok(code.includes(historical));
 writeFileSync(adapter,code);
}
// Preserve the independently accepted 48-key scope for historical C005 review
// controls. This is never a way to modify current normal accounting.
export function omitStructureIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.structure'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C006/docs_read.structure/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!/^C006\.(styles|objects|ranges|suggestions)__read\./.test(key))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['styles','objects','ranges','suggestions'].map")).join('\n'));
}
// Preserve the accepted 68-key C006 scope only in owned historical copies.
export function omitRichCellIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.richCell'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C007/docs_read.richCell/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C007.'))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['adjacentRuns','inlineObject','nestedTable','paragraphNewlines'].map")).join('\n'));
}
// Preserve the accepted 88-key C007 scope only in owned historical copies.
export function omitOpaqueIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.opaque'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C008/docs_read.opaque/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C008.'))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['autoText','drawing','equation','toc','unknown'].map")).join('\n'));
}
// Preserve accepted113-key C008 only inside owned historical profiles.
export function omitSegmentIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.segment'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C003/docs_read.segment/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C003.'))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['body','header','footer','footnote'].map")).join('\n'));
}
// Preserve accepted133-key C003 only inside owned historical profiles.
export function omitViewIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.view'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C010/docs_read.view/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!/^C010\.(inline|acceptedPreview|rejectedPreview|projectionNotEditProof)__read\./.test(key))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['inline','acceptedPreview','rejectedPreview','projectionNotEditProof'].map")).join('\n'));
}
// Preserve accepted153-key C010 only inside owned historical profiles.
export function omitReviewViewIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_read.reviewView'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C011/docs_read.reviewView/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C011.'))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['deniedComments','missingReviewCoverage','tabsAndInline'].map")).join('\n'));
}
// Restore the one archived D literal candidate, never the current normal run.
function restoreHistoricalLiteralCandidate(root){
 owned(root);const caseId='C012.crossRun__read.success',file='features/docs/coverage/bridge-cases.json',index=load(root,file),path=`features/docs/coverage/fixtures/bridge/${caseId}.json`,bytes=readFileSync(join(root,path)),sha256=createHash('sha256').update(bytes).digest('hex');
 assert.equal(sha256,'22f0fa756ef86eb4dbb994c22b363b99cacf2f5cb35c415373bcb3b2442b5daa');index[caseId]={caseId,path,sha256,provenance:JSON.parse(bytes).provenance};save(root,file,index);
 const fp=join(root,'features/docs/semantic-bridge-d.feature');let feature=readFileSync(fp,'utf8');if(!feature.includes(caseId)){const marker='  @F_SELECT @S_CARDINALITY';assert.equal(feature.split(marker).length,2);feature=feature.replace(marker,`  @F_SELECT @S_LITERAL
  Scenario Outline: Historical literal candidate [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId |
      | C012.crossRun__read.success |

`+marker);writeFileSync(fp,feature);}
 const ap=join(root,'features/docs/coverage/execution-adapters.mjs');let code=readFileSync(ap,'utf8');const lines=code.split('\n').filter(line=>line.includes("['crossRun','paragraphBoundary','chipBoundary','boundedContext'].map")),old="  'docs_find.literal/crossRun__read':{driver:'docs_find',schema:'find.matcher',mode:'read',native:'docs_find',action:'find',outcomes:['success']},";
 assert.ok(lines.length<=1);if(lines.length)code=code.replace(lines[0],old);else assert.ok(code.includes(old));writeFileSync(ap,code);
}
// Preserve independently accepted168 only inside owned historical profiles.
export function omitLiteralIntegration(root){
 owned(root);omitNormalizationIntegration(root);restoreHistoricalLiteralCandidate(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_find.literal'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C012/docs_find.literal/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C012.'))));
}
// C013 has no historical candidate. Remove only its new normal integration
// in owned profiles, leaving the reviewed production fold prerequisite intact.
export function omitNormalizationIntegration(root){
 owned(root);omitCardinalityIntegration(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['docs_find.normalization'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C013/docs_find.normalization/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C013.'))));
 const p=join(root,'features/docs/coverage/execution-adapters.mjs'),text=readFileSync(p,'utf8');writeFileSync(p,text.split('\n').filter(line=>!line.includes("['exact','typographic','nfc','caseFold','inverseMap','emoji','combining','rtl'].map")).join('\n'));
 rmSync(join(root,'features/docs/semantic-c013-e.feature'),{force:true});
}
// Restore exactly the two archived cardinality candidates in fresh owned
// historical profiles. No duplicate normal credit and no production changes.
export function omitCardinalityIntegration(root){
 owned(root);
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);delete registry.operations['selector.cardinality'];save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([key])=>!key.startsWith('C015/selector.cardinality/')));save(root,mp,m);
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,Object.fromEntries(Object.entries(index).filter(([key])=>!key.startsWith('C015.'))));
 const bp='features/docs/coverage/bridge-cases.json',bridge=load(root,bp);
 for(const [outcome,expected]of[['success','6581921df76e7f23e918511d224fef5616833450f7eb9339ff1c683cef46ade8'],['counterexample','db7bfde327c96a3f8d19afaccb88cc71acd661b655d4bc7e65eb4d6cc82ce699']]){const caseId=`C015.exactlyOne__local.${outcome}`,path=`features/docs/coverage/fixtures/bridge/${caseId}.json`,bytes=readFileSync(join(root,path)),sha256=createHash('sha256').update(bytes).digest('hex');assert.equal(sha256,expected);bridge[caseId]={caseId,path,sha256,provenance:JSON.parse(bytes).provenance};}save(root,bp,bridge);
 const fp=join(root,'features/docs/semantic-bridge-d.feature');let feature=readFileSync(fp,'utf8');if(!feature.includes('C015.exactlyOne__local.success')){const marker='  @F_SELECT @S_PROOF';assert.equal(feature.split(marker).length,2);feature=feature.replace(marker,`  @F_SELECT @S_CARDINALITY
  Scenario Outline: Actual selector invariant [<caseId>]
    When the offline production bridge executes "<caseId>"
    Examples:
      | caseId                                  |
      | C015.exactlyOne__local.success           |
      | C015.exactlyOne__local.counterexample    |

`+marker);writeFileSync(fp,feature);}
 const ap=join(root,'features/docs/coverage/execution-adapters.mjs');let code=readFileSync(ap,'utf8');const lines=code.split('\n').filter(line=>line.includes("['exactlyOne','explicitOccurrenceZero','allExpectedCount','ambiguous','missing'].map")),old="  'selector.cardinality/exactlyOne__local':{driver:'selector-resolver',schema:'selector.closed-union',mode:'local',native:'docs_find',action:'selector',outcomes:['success','counterexample']},";assert.ok(lines.length<=1);if(lines.length)code=code.replace(lines[0],old);else assert.ok(code.includes(old));writeFileSync(ap,code);
 rmSync(join(root,'features/docs/semantic-c015-e.feature'),{force:true});
}
export function retainRawMaskOnly(root){
 owned(root);const rp='features/docs/coverage/registry.json',registry=load(root,rp);
 registry.operations=Object.fromEntries(Object.entries(registry.operations).filter(([k])=>k==='policy.publicRawMask'));save(root,rp,registry);
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);
 m.expansion.deliveryOverrides=Object.fromEntries(Object.entries(m.expansion.deliveryOverrides).filter(([k])=>k.startsWith('C006/policy.publicRawMask/')));save(root,mp,m);
}
