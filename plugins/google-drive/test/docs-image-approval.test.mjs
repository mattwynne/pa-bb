// SSR is supplementary; native desktop/narrow/keyboard review is a delivery gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile,unlink } from 'node:fs/promises';
import ts from 'typescript';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const c=new URL('./image-approval.generated.mjs',import.meta.url),u=new URL('./image-connection.generated.mjs',import.meta.url);
const compile=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext}}).outputText;
await writeFile(u,compile(await readFile(new URL('../connection-ui.tsx',import.meta.url),'utf8')));
await writeFile(c,compile((await readFile(new URL('../docs-image-approval.tsx',import.meta.url),'utf8')).replace('./connection-ui.js','./image-connection.generated.mjs')));
const {DocsImageApproval}=await import('./image-approval.generated.mjs');test.after(async()=>{await unlink(c);await unlink(u);});
const p={account:'writer@example.test',operationId:'11111111-1111-4111-8111-111111111111',documentId:'doc-a',title:'Title <script>PRIVATE</script>',expectedRevisionId:'rev-a',tabId:'main',index:1,paragraphText:'Wordmark stays <script>x</script>\n',uri:'https://example.test/logo.png',widthPt:172.8,heightPt:25.84,asset:{mimeType:'image/png',width:1600,height:239,bytes:4096,sha256:'a'.repeat(64)},limits:'No hosting or byte/rendering proof.'};
const render=payload=>renderToStaticMarkup(createElement(DocsImageApproval,{interaction:{id:'synthetic',payload},submit:async()=>{},cancel:async()=>{}}));
test('image card identifies account/tab/index/source/digest/cm dimensions and additive limits; no remote pixels load',()=>{
 const html=render(p);for(const s of ['writer@example.test','rev-a','main','UTF-16','6.10 × 0.91 cm','1600 × 239 pixels','4096 bytes',p.uri,p.asset.sha256,'Existing text stays','No write has happened','alt text','Approve image insertion','Decline','Cancel review'])assert.ok(html.includes(s),s);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img|<iframe|<svg/);assert.match(html,/href="https:\/\/docs.google.com\/document\/d\/doc-a\/edit"/);
});
test('missing/malformed/unsafe approval data fail closed; synthetic example never links to a document',()=>{
 for(const value of [null,{}, {...p,uri:'javascript:alert(1)'},{...p,uri:'https://user:pass@example.test/logo.png'},{...p,asset:{...p.asset,mimeType:'image/svg+xml'}},{...p,documentId:'javascript:bad'},{...p,widthPt:0}]){const html=render(value);assert.match(html,/details are incomplete/);assert.match(html,/disabled=""[^>]*>Approve image insertion/);assert.doesNotMatch(html,/href=/);}
 const html=render({...p,exampleOnly:true});assert.match(html,/Every choice is a no-op/);assert.doesNotMatch(html,/href=|<img/);
});
