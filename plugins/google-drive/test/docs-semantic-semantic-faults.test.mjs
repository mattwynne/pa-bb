// Bounded mutation probes execute real leaf algorithms in-process. No package
// copy, subprocess, semantic answer substitution or weakened production limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { materialize } from '../core/docs-semantic/model.mjs';
const url=new URL('../core/docs-semantic/selectors.mjs',import.meta.url),source=readFileSync(url,'utf8');
const mutations={
  exact:["normalizeMapped(text,normalization='exact'","normalizeMapped(text,normalization='typographic'"],
  typographic:['if(prior?.space){prior.end=pos;continue;}','if(false){prior.end=pos;continue;}'],
  nfc:["const normalized=s.segment.normalize('NFC');",'const normalized=s.segment;'],
  caseFold:["  if(c==='\\u1fd3')return '\\u0390';\n",''],
  inverseMap:['const a=mapped.boundaries.get(index),b=mapped.boundaries.get(end);','const a=index,b=end;'],
  emoji:['lo=Math.max(0,a-40),hi=Math.min(text.length,b+40)','lo=Math.max(0,a-39),hi=Math.min(text.length,b+39)'],
  combining:['text:text.slice(a,b),context:text.slice(lo,hi),runs','text:mapped.text.slice(index,end),context:text.slice(lo,hi),runs'],
  rtl:['text:text.slice(a,b),context:text.slice(lo,hi),runs',"text:Array.from(text.slice(a,b)).reverse().join(''),context:text.slice(lo,hi),runs"],
};
const fixtures=Object.fromEntries(Object.keys(mutations).map(variant=>[variant,JSON.parse(readFileSync(new URL(`../features/docs/coverage/fixtures/c013/C013.${variant}__read.success.json`,import.meta.url)))]));
for(const [variant,[from,to]]of Object.entries(mutations))test(`independent fixture detects actual ${variant} algorithm fault`,async()=>{
  assert.equal(source.split(from).length,2,'mutation target unique');
  const changed=source.replace(from,to).replaceAll("'./common.mjs'",JSON.stringify(new URL('./common.mjs',url).href)).replaceAll("'./model.mjs'",JSON.stringify(new URL('./model.mjs',url).href));
  const moduleUrl='data:text/javascript;base64,'+Buffer.from(changed).toString('base64');
  const hook=registerHooks({resolve(specifier,context,next){return next(specifier==='./offline-selector-mutant.mjs'&&context.parentURL===import.meta.url?moduleUrl:specifier,context);}});
  let mutant;try{mutant=await import('./offline-selector-mutant.mjs');}finally{hook.deregister();}
  const f=fixtures[variant];
  const snapshot=materialize({document:f.provider.document,metadata:f.provider.metadata,binding:{snapshotId:'snap-d',subject:'subject-d',account:'reader@example.test',threadId:'thread-d',documentId:'doc-d',view:'inline',retrievedAt:0},reviewIncluded:true});
  let caught=false;
  for(const q of f.queries){try{assert.deepEqual({...mutant.findLiteral(snapshot,q.args.scope,q.args.query),snapshotId:'snap-d',thisCall:{providerMutationCount:0}},q.expected);}catch(error){if(error.code==='ERR_ASSERTION'||error.semanticCode){caught=true;break;}throw error;}}
  assert.ok(caught,'independent original result must kill the mutant');
});
