import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLiteralDocument} from '../core/docs-literal.mjs';
import {planSectionEdit,sectionRequests,sectionReadbackMatches} from '../core/docs-section.mjs';
import {sectionVector,paragraph} from './docs-section-fixtures.mjs';
const snapshot = raw => inspectLiteralDocument(raw,'doc-section');
test('handwritten section wire and readback retain heading, next heading, table, logo and child tab',()=>{
 const {before,after,wire,args}=sectionVector();const p=planSectionEdit(snapshot(before),args);
 assert.equal(p.oldText,'Old.\nMore.');assert.deepEqual({writeControl:{requiredRevisionId:'r1'},requests:sectionRequests(p)},wire);
 assert.equal(sectionReadbackMatches(before,after,args),true);
});
for(const kind of ['shorter','more','end'])test('section differing paragraph count and tab-final newline: '+kind,()=>{
 const {before,after,args}=sectionVector();
 if(kind==='end'){before.tabs[0].documentTab.body.content.splice(4);after.tabs[0].documentTab.body.content.splice(4);}
 else {
  const lines=kind==='shorter'?['Z']:['A','B','C'];args.newText=lines.join('\n');
  const body=after.tabs[0].documentTab.body.content;let at=7;
  const paragraphs=lines.map(line=>{const p=paragraph(at,at+line.length+1,line+'\n');at+=line.length+1;return p;});
  // Handwritten independent downstream indices for each case.
  const tail=structuredClone(before.tabs[0].documentTab.body.content.slice(4));
  const delta=kind==='shorter'?-9:-5;
  const shift=x=>{if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){if(k==='startIndex'||k==='endIndex')x[k]=v+delta;else shift(v);}};tail.forEach(shift);
  body.splice(2,body.length-2,...paragraphs,...tail);
 }
 assert.equal(sectionReadbackMatches(before,after,args),true);
 const p=planSectionEdit(snapshot(before),args);assert.equal(p.endIndex,17);assert.equal(sectionRequests(p)[0].deleteContentRange.range.endIndex,17);
});
const changes={
 missing:(v)=>v.args.heading='Nope',duplicate:v=>v.before.tabs[0].documentTab.body.content.push(paragraph(31,37,'Focus\n',{namedStyleType:'HEADING_1'})),
 manual:v=>v.before.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle={namedStyleType:'NORMAL_TEXT'},
 nested:v=>v.before.tabs[0].documentTab.body.content[3].paragraph.paragraphStyle={namedStyleType:'HEADING_2'},
 list:v=>v.before.tabs[0].documentTab.body.content[2].paragraph.bullet={listId:'a'},
 rich:v=>v.before.tabs[0].documentTab.body.content[3].paragraph.elements[0].textRun.textStyle={italic:true},
 link:v=>v.before.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.textStyle={link:{url:'https://example.test'}},
 spacing:v=>v.before.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle.spaceAbove={magnitude:12,unit:'PT'},
 registry:v=>v.before.tabs[0].documentTab.namedRanges={x:{}},
 stale:v=>v.args.expectedRevisionId='other',unicode:v=>v.args.newText='bad\ud800',controls:v=>v.args.newText='bad\ttext',
 empty:v=>v.args.newText='',blank:v=>v.args.newText='a\n\nb',finalLf:v=>v.args.newText='a\n',nochange:v=>v.args.newText='Old.\nMore.',
 table:v=>v.before.tabs[0].documentTab.body.content.splice(3,1,v.before.tabs[0].documentTab.body.content[5]),
 object:v=>{v.before.tabs[0].documentTab.body.content[2].paragraph.elements[0]={startIndex:7,endIndex:12,inlineObjectElement:{inlineObjectId:'logo'}};},
 suggestions:v=>v.before.suggestedDocumentStyleChanges={secret:{}}
};
for(const [kind,change]of Object.entries(changes))test('section refuses '+kind,()=>{const v=sectionVector();change(v);assert.throws(()=>planSectionEdit(snapshot(v.before),v.args));});
const drift={heading:v=>v.after.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold=true,
 tail:v=>v.after.tabs[0].documentTab.body.content[4].paragraph.elements[0].textRun.content='Fail\n',
 table:v=>v.after.tabs[0].documentTab.body.content[5].table.columns=2,
 logo:v=>v.after.inlineObjects.logo.inlineObjectProperties.embeddedObject.imageProperties.sourceUri='https://other.test',
 child:v=>v.after.tabs[0].childTabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold=false,
 bodyStyle:v=>v.after.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.textStyle={italic:true},
 bodyParagraph:v=>v.after.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle={namedStyleType:'HEADING_2'},
 bodyMetadata:v=>v.after.tabs[0].documentTab.body.content[2].paragraph.future=true,
 badShift:v=>v.after.tabs[0].documentTab.body.content[5].startIndex++,
 text:v=>v.after.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.content='Wrong 😀.\n',
 newTab:v=>v.after.tabs[0].childTabs.push(structuredClone(v.after.tabs[0].childTabs[0]))};
for(const [kind,change]of Object.entries(drift))test('independent preservation rejects '+kind,()=>{const v=sectionVector();change(v);assert.equal(sectionReadbackMatches(v.before,v.after,v.args),false);});
for(const sourceDirection of ['LEFT_TO_RIGHT',undefined])test('body LTR explicit/default equivalence; restore deliberately: '+sourceDirection,()=>{
 const v=sectionVector(),body=d=>d.tabs[0].documentTab.body.content.slice(2,4);
 if(sourceDirection)for(const p of body(v.before))p.paragraph.paragraphStyle.direction=sourceDirection;
 for(const p of body(v.after))p.paragraph.paragraphStyle.direction='LEFT_TO_RIGHT';
 const p=planSectionEdit(snapshot(v.before),v.args);assert.equal(sectionRequests(p)[3].updateParagraphStyle.fields,'namedStyleType,direction');assert.equal(p.paragraphStyle.direction,'LEFT_TO_RIGHT');
 assert.equal(sectionReadbackMatches(v.before,v.after,v.args),true);
 delete body(v.after)[0].paragraph.paragraphStyle.direction;assert.equal(sectionReadbackMatches(v.before,v.after,v.args),true);
 body(v.after)[0].paragraph.paragraphStyle.direction='RIGHT_TO_LEFT';assert.equal(sectionReadbackMatches(v.before,v.after,v.args),false);
});
test('LTR equivalence never normalizes untouched heading/next-heading/child paragraphs',()=>{
 for(const part of ['heading','next','child']){const v=sectionVector();const p=part==='child'?v.after.tabs[0].childTabs[0].documentTab.body.content[1]:v.after.tabs[0].documentTab.body.content[part==='heading'?1:4];p.paragraph.paragraphStyle.direction='LEFT_TO_RIGHT';assert.equal(sectionReadbackMatches(v.before,v.after,v.args),false);}
 const v=sectionVector();v.before.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle.direction='RIGHT_TO_LEFT';assert.throws(()=>planSectionEdit(snapshot(v.before),v.args),{docsCode:'unsupported_section'});
});
test('section equal-known-parent inheritance accepts omission only with explicit unchanged normal definition',()=>{
 const v=sectionVector(),data=d=>d.tabs[0].documentTab;
 for(const d of [v.before,v.after])data(d).namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:true}}]};
 for(const p of data(v.after).body.content.slice(2,4))p.paragraph.elements[0].textRun.textStyle={};
 assert.equal(sectionReadbackMatches(v.before,v.after,v.args),true);
 const drift=structuredClone(v.after);data(drift).namedStyles.styles[0].textStyle.bold=false;assert.equal(sectionReadbackMatches(v.before,drift,v.args),false);
 const changed=structuredClone(v.after);data(changed).body.content[2].paragraph.elements[0].textRun.textStyle={bold:false};assert.equal(sectionReadbackMatches(v.before,changed,v.args),false);
 for(const d of [v.before,v.after])data(d).namedStyles.styles[0].textStyle.bold=false;
 assert.equal(sectionReadbackMatches(v.before,v.after,v.args),false,'unchanged but unequal known parent cannot explain omission');
 delete data(v.before).namedStyles;delete data(v.after).namedStyles;assert.equal(sectionReadbackMatches(v.before,v.after,v.args),false,'editor defaults unknown');
});
test('only expiring read URI may differ',()=>{const v=sectionVector();v.after.inlineObjects.logo.inlineObjectProperties.embeddedObject.imageProperties.contentUri='https://example.test/rotated';assert.equal(sectionReadbackMatches(v.before,v.after,v.args),true);});
