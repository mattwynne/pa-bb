// Run with browser-automation in the disposable review only. Native slot,
// keyboard choices + BB form receipts; no provider turns or Google writes.
const p = await browser.getPage('main');
const location = new URL(p.url()), base = location.origin;
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback BB required');
const width = Number(location.searchParams.get('reviewWidth') || 1280);
if (![1280, 390].includes(width)) throw Error('Unexpected review width');
await p.setViewport({ width, height: 1100 });
const rpc = (method, input) => p.evaluate(async ({ method, input }) => {
  const response = await fetch(`/api/v1/plugins/drive-sharing-review/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw Error('Synthetic fixture RPC failed'); return (await response.json()).result;
}, { method, input });
const threads = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t => ({ id: t.id, state: t.title.replace('Synthetic sharing review: ', ''), status: t.status })));
if (threads.length !== 9 || threads.some(t => t.status !== 'pending')) throw Error('Expected nine inert review threads');
let reviewed = 0;
for (const { id: threadId, state } of threads) {
  const pending = await p.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}/interactions`)).json()).length, threadId);
  if (!pending) await rpc('stage', { threadId, state });
  await p.goto(`${base}/threads/${threadId}`); await p.waitForSelector('.pa-drive__docs-review');
  const el = '.pa-drive__docs-review';
  const evidence = await p.evaluate(() => {
    const el = document.querySelector('.pa-drive__docs-review');
    return { text: el.innerText, overflow: el.scrollWidth > el.clientWidth, disabled: el.querySelector('button').disabled,
      detailsOpen: el.querySelector('details')?.open, native: el.parentElement.closest('section[aria-label], [role=region]')?.getAttribute('aria-label') };
  });
  if (evidence.overflow) throw Error(`Horizontal overflow: ${state}`);
  if (state === 'invalid') { if (!evidence.disabled || !evidence.text.includes('incomplete')) throw Error('Invalid proposal is approvable'); }
  else {
    if (evidence.disabled || evidence.detailsOpen) throw Error('Invalid defaults');
    if (!evidence.text.includes('owner@example.test') || !evidence.text.includes('Other permissions and owners are preserved')) throw Error('Target/preservation missing');
    if (['link', 'folder', 'change', 'discoverable'].includes(state) && !evidence.text.includes('not searchable/discoverable')) throw Error('Public discovery ambiguity');
    if (state === 'folder' && !evidence.text.includes('including future items')) throw Error('Missing folder propagation');
    if (state === 'discoverable' && !evidence.text.includes('publicly discoverable')) throw Error('Missing discoverability reduction');
    if (state === 'remove' && !evidence.text.includes('Remove this direct permission')) throw Error('Missing revoke scope');
    if (state === 'user' && !evidence.text.includes('opted in')) throw Error('Missing requested email warning');
    await p.focus(`${el} a`); await p.keyboard.press('Tab'); await p.keyboard.press('Enter');
    if (!(await p.evaluate(() => document.querySelector('.pa-drive__docs-review details').open))) throw Error('Keyboard disclosure failed');
    await p.keyboard.press('Enter'); await p.keyboard.press('Tab');
  }
  if (state === 'user' || state === 'folder') {
    await p.evaluate(() => { let el = document.querySelector('.pa-drive__docs-review'); while (el) { if (el.scrollHeight > el.clientHeight) el.scrollTop = 0; el = el.parentElement; } });
    await p.shot({ type: 'jpeg', maxEdge: 1100, quality: 65 });
  }
  const decline = ['invalid', 'change'].includes(state), cancel = state === 'remove';
  if (state === 'invalid') await p.focus(`${el} button:nth-child(2)`);
  else if (decline) await p.keyboard.press('Tab');
  else if (cancel) { await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); }
  const focused = await p.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  if (focused.text !== (cancel ? 'Cancel review' : decline ? 'Decline' : 'Approve sharing change') || focused.outline === 'none') throw Error(`Action focus failed ${state}: ${JSON.stringify(focused)}`);
  if (state === 'folder' || state === 'discoverable') await p.shot({ type: 'jpeg', maxEdge: 1100, quality: 65 });
  await p.keyboard.press('Enter');
  if (state === 'busy') {
    await p.waitForFunction(() => document.querySelector('.pa-drive__docs-review')?.getAttribute('aria-busy') === 'true');
    if (!(await p.evaluate(() => [...document.querySelectorAll('.pa-drive__docs-review button')].every(b => b.disabled)))) throw Error('Busy buttons enabled');
    await p.focus('[data-release-synthetic]'); await p.keyboard.press('Enter');
  }
  if (state === 'error') {
    await p.waitForSelector(`${el} [role=alert]`);
    if (await rpc('result', { threadId })) throw Error('Failed submission recorded as complete');
    await p.focus(`${el} button`); await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => !document.querySelector('.pa-drive__docs-review'));
  const result = await rpc('result', { threadId });
  if (cancel ? result?.outcome !== 'cancelled' : result?.outcome !== 'submitted' || result.value.approved !== !decline) throw Error(`Native receipt failed: ${state}`);
  reviewed++;
}
const inert = await p.evaluate(async () => {
  for (const thread of await (await fetch('/api/v1/threads?projectId=proj_personal')).json()) {
    const timeline = await (await fetch(`/api/v1/threads/${thread.id}/timeline`)).json();
    if (thread.status !== 'pending' || thread.environmentId !== null || timeline.rows.some(row => row.turnId !== null || row.workKind !== 'form')) return false;
  } return true;
});
if (!inert) throw Error('Review unexpectedly dispatched provider work');
console.log(JSON.stringify({ reviewed, width, keyboardReceipts: true, nativePlacement: true, googleWrites: 0, providerTurns: 0 }));
