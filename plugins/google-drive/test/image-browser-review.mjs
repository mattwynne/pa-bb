// Only run against run-image-preview's disposable, credential-free native BB.
const p = await browser.getPage('main'), base = new URL(p.url()).origin;
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback BB required');
const width = Number(new URL(p.url()).searchParams.get('reviewWidth') || 1280);
if (![1280,390].includes(width)) throw Error('Unexpected viewport');
await p.setViewport({width,height:width===390?844:1000});
const threads = await p.evaluate(async()=> (await(await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t=>({id:t.id,state:t.title.replace('Synthetic filing review: ', '')})));
if(threads.length!==5)throw Error('Expected five inert image fixtures');
let reviewed=0;
for(const {id,state} of threads){
 if(width===390)await p.evaluate(async({id,state})=>{const r=await fetch('/api/v1/plugins/drive-image-review/rpc/stage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:id,state})});if(!r.ok)throw Error('Fixture stage failed');},{id,state});
 await p.goto(`${base}/threads/${id}`);await p.waitForSelector('.pa-drive__docs-review');
 const evidence=await p.evaluate(()=>{const e=document.querySelector('.pa-drive__docs-review');return{text:e.innerText,overflow:e.scrollWidth>e.clientWidth,disabled:e.querySelector('button').disabled,remoteElements:e.querySelectorAll('img,iframe,svg').length};});
 if(evidence.overflow||evidence.remoteElements)throw Error(`Overflow or remote media: ${state}/${width}`);
 if(state==='invalid'){if(!evidence.disabled||!evidence.text.includes('incomplete'))throw Error('Invalid details approvable');await p.focus('.pa-drive__docs-review button:nth-child(2)');}
 else{
  for(const text of ['Example only','writer@example.test','synthetic-revision','paragraph start 1 (UTF-16)','6.10 × 0.91 cm','1600 × 239 pixels','4096 bytes','https://example.test/','Existing text stays','alt text','No write has happened','not proof of embedded image bytes'])if(!evidence.text.includes(text))throw Error(`Missing ${text}`);
  if(evidence.disabled)throw Error('Valid details not approvable');
  await p.focus('.pa-drive__docs-review summary');await p.keyboard.press('Enter');
  const details=await p.evaluate(()=>({open:document.querySelector('.pa-drive__docs-review details').open,text:document.querySelector('.pa-drive__docs-review').innerText}));
  if(!details.open||!details.text.includes('a'.repeat(64)))throw Error('Digest disclosure keyboard failed');
  await p.keyboard.press('Enter');await p.keyboard.press('Tab');
  // Chromium makes overflowed <pre> content keyboard-focusable on narrow views.
  // Traverse that accessible scroll stop too; it must not trap focus.
  for(let stop=0;stop<4;stop++){
    const onApprove=await p.evaluate(()=>document.activeElement.textContent==='Approve image insertion');
    if(onApprove)break;
    await p.keyboard.press('Tab');
  }
 }
 const focus=await p.evaluate(()=>({text:document.activeElement.textContent,outline:getComputedStyle(document.activeElement).outlineStyle}));
 if(focus.text!==(state==='invalid'?'Decline':'Approve image insertion')||focus.outline==='none')throw Error(`Focus failed: ${JSON.stringify(focus)}`);
 if(state==='image')await p.shot({type:'jpeg',maxEdge:1280,quality:70});
 await p.keyboard.press('Enter');
 if(state==='busy'){const disabled=await p.evaluate(()=>Array.from(document.querySelectorAll('.pa-drive__docs-review button')).every(b=>b.disabled));if(!disabled)throw Error('Busy controls are not disabled');}
 if(state==='error'){
  await p.waitForSelector('.pa-drive__docs-review [role=alert]');
  const text=await p.evaluate(()=>document.querySelector('.pa-drive__docs-review [role=alert]').textContent);
  if(!text.includes('No new approval was confirmed'))throw Error('Failed choice appears complete');
  await p.shot({type:'jpeg',maxEdge:1280,quality:70});
  await p.focus('.pa-drive__docs-review button:nth-child(3)');await p.keyboard.press('Enter');
 }
 await p.waitForFunction(()=>!document.querySelector('.pa-drive__docs-review'));reviewed++;
}
const inert=await p.evaluate(async()=>(await(await fetch('/api/v1/threads?projectId=proj_personal')).json()).every(t=>t.status==='pending'));
if(!inert)throw Error('Fixture dispatched provider work');
console.log(JSON.stringify({reviewed,width,horizontalOverflow:false,keyboardFocus:true,invalidDisabled:true,errorRecovery:true,busyDisabled:true,googleWrites:0,providerTurns:0}));
