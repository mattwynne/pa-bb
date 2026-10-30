// Run only against run-upload-preview's credential-free, inert native BB.
const p = await browser.getPage('main'), base = new URL(p.url()).origin;
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback BB required');
const width = Number(new URL(p.url()).searchParams.get('reviewWidth') || 1280);
if (![1280, 390].includes(width)) throw Error('Unexpected viewport');
await p.setViewport({ width, height: width === 390 ? 844 : 900 });
const threads = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t => ({ id: t.id, state: t.title.replace('Synthetic filing review: ', '') })));
if (threads.length !== 6) throw Error('Expected six inert upload fixtures');
let reviewed = 0;
for (const { id, state } of threads) {
  if (width === 390) await p.evaluate(async ({ id, state }) => {
    const r = await fetch('/api/v1/plugins/drive-upload-review/rpc/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: id, state }) }); if (!r.ok) throw Error('Fixture stage failed');
  }, { id, state });
  await p.goto(`${base}/threads/${id}`); await p.waitForSelector('.pa-drive__docs-review');
  const evidence = await p.evaluate(() => { const e = document.querySelector('.pa-drive__docs-review'); return { text: e.innerText, overflow: e.scrollWidth > e.clientWidth, disabled: e.querySelector('button').disabled }; });
  if (evidence.overflow) throw Error(`Horizontal overflow: ${state}/${width}`);
  if (state === 'invalid') { if (!evidence.disabled || !evidence.text.includes('incomplete')) throw Error('Invalid source is approvable'); await p.focus('.pa-drive__docs-review button:nth-child(2)'); }
  else {
    const converted = ['conversion', 'docx', 'pptx'].includes(state), extension = state === 'docx' ? 'docx' : state === 'pptx' ? 'pptx' : 'xlsx';
    for (const text of ['owner@example.invalid', 'BB server (not your browser/device)', `/synthetic/thread-storage/thr_example/artifacts/model.${extension}`, '204800 bytes', 'a'.repeat(64), 'not rendered', 'team@example.invalid', 'My Drive / Shared partnership / Team', converted ? 'not byte-preserving' : 'No conversion', 'Result type:', '4 MiB']) if (!evidence.text.includes(text)) throw Error(`Missing ${text}`);
    if (evidence.disabled) throw Error('Valid source not approvable');
    if (state === 'binary') await p.shot({ type: 'jpeg', maxEdge: 1280, quality: 65 });
    await p.focus('.pa-drive__docs-review summary'); await p.keyboard.press('Enter');
    const details = await p.evaluate(() => ({ open: document.querySelector('.pa-drive__docs-review details').open, text: document.querySelector('.pa-drive__docs-review').innerText }));
    if (!details.open || !details.text.includes('partner@example.invalid') || !details.text.includes('No upload has happened')) throw Error('Keyboard details missing');
    await p.keyboard.press('Enter'); await p.keyboard.press('Tab');
    if (state === 'docx' || state === 'pptx') await p.shot({ type: 'jpeg', maxEdge: 1280, quality: 65 });
  }
  const focus = await p.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  const expected = state === 'invalid' ? 'Decline' : ['conversion', 'docx', 'pptx'].includes(state) ? 'Approve import' : 'Approve upload';
  if (focus.text !== expected || focus.outline === 'none') throw Error(`Keyboard focus failed: ${JSON.stringify(focus)}`);
  await p.keyboard.press('Enter');
  if (state === 'error') {
    await p.waitForSelector('.pa-drive__docs-review [role=alert]');
    const error = await p.evaluate(() => document.querySelector('.pa-drive__docs-review [role=alert]').textContent);
    if (!error.includes('No approval was confirmed')) throw Error('Failed choice looks complete');
    await p.shot({ type: 'jpeg', maxEdge: 1280, quality: 65 });
    await p.focus('.pa-drive__docs-review button:nth-child(3)'); await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => !document.querySelector('.pa-drive__docs-review'));
  reviewed++;
}
const inert = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).every(t => t.status === 'pending'));
if (!inert) throw Error('Fixture started provider work');
console.log(JSON.stringify({ reviewed, width, horizontalOverflow: false, keyboardFocus: true, invalidDisabled: true, errorRecovery: true, googleWrites: 0, providerTurns: 0 }));
