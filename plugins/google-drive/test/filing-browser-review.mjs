// Run only against test/run-filing-preview's credential-free disposable BB.
const p = await browser.getPage('main');
const location = new URL(p.url()), base = location.origin;
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback BB required');
const width = Number(location.searchParams.get('reviewWidth') || 1280);
if (![1280, 390].includes(width)) throw Error('Unexpected review width');
await p.setViewport({ width, height: width === 390 ? 844 : 900 });
const rpc = (method, input) => p.evaluate(async ({ method, input }) => {
  const r = await fetch(`/api/v1/plugins/drive-filing-review/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw Error('Synthetic fixture RPC failed'); return (await r.json()).result;
}, { method, input });
const threads = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t => ({ id: t.id, state: t.title.replace('Synthetic filing review: ', ''), status: t.status })));
if (threads.length !== 6 || threads.some(t => t.status !== 'pending')) throw Error('Expected six inert review threads');
let reviewed = 0;
for (const { id: threadId, state } of threads) {
  const count = await p.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}/interactions`)).json()).length, threadId);
  if (!count) await rpc('stage', { threadId, state });
  await p.goto(`${base}/threads/${threadId}`); await p.waitForSelector('.pa-drive__docs-review');
  const el = '.pa-drive__docs-review';
  const evidence = await p.evaluate(() => {
    const e = document.querySelector('.pa-drive__docs-review'), impact = e.querySelector('.pa-drive__filing-impact');
    let scroll = e; while (scroll && !(scroll.scrollHeight > scroll.clientHeight + 10 && ['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
    if (scroll) scroll.scrollTop = 0;
    return { text: e.innerText, overflow: e.scrollWidth > e.clientWidth, disabled: e.querySelector('button').disabled, detailsOpen: e.querySelector('details')?.open, links: e.querySelectorAll('a').length,
      impactVisible: !impact || impact.getBoundingClientRect().bottom <= (scroll?.getBoundingClientRect().bottom ?? innerHeight) };
  });
  if (evidence.overflow || evidence.links) throw Error(`Unexpected overflow/live link: ${state}`);
  if (state === 'invalid') {
    if (!evidence.disabled || !evidence.text.includes('incomplete')) throw Error('Invalid filing is approvable');
    await p.focus(`${el} button:nth-child(2)`);
  } else {
    if (evidence.disabled || evidence.detailsOpen || !evidence.impactVisible) throw Error(`Summary hidden or invalid defaults: ${state}`);
    const pathText = state === 'folder' ? 'My Drive / New organization / Partnership / Synthetic course folder' : 'My Drive / Shared administration / New organization / Partnership';
    for (const text of ['owner@example.invalid', pathText, 'Who may gain or lose access', 'No write has happened', ...(state === 'folder' ? ['People with access'] : ['partner@example.invalid', 'old-team@example.invalid', 'belongs to', 'editing access', 'viewing access'])]) if (!evidence.text.includes(text)) throw Error(`Missing ${text}: ${state}`);
    if (/application\/|Current path owners|Destination path owners/.test(evidence.text)) throw Error('Technical inventory is not collapsed');
    if (state === 'folder' && /partner@example.invalid|old-team@example.invalid|belongs to another person/.test(evidence.text)) throw Error('Folder fixture widened ancestry policy');
    if (state === 'move' || state === 'folder') await p.shot({ type: 'jpeg', maxEdge: 1280, quality: 70 });
    await p.focus(`${el} summary`); await p.keyboard.press('Enter');
    const expanded = await p.evaluate(() => { const e = document.querySelector('.pa-drive__docs-review'); return { open: e.querySelector('details').open, text: e.innerText }; });
    const mime = state === 'folder' ? 'application/vnd.google-apps.folder' : state === 'move' ? 'application/vnd.google-apps.spreadsheet' : 'application/pdf';
    for (const text of [mime, 'Destination path owners', 'Only a verified tool result', 'no automatic rollback', 'Example only']) if (!expanded.open || !expanded.text.includes(text)) throw Error(`Incomplete keyboard disclosure: ${text}`);
    if (state === 'move' && !expanded.text.includes('Google Sheet')) throw Error('Missing plain file label');
    await p.keyboard.press('Enter'); await p.keyboard.press('Tab');
    if (state === 'folder') await p.keyboard.press('Tab');
    if (state === 'cancel') { await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); }
  }
  const expected = state === 'cancel' ? 'Cancel review' : ['invalid', 'folder'].includes(state) ? 'Decline' : 'Approve filing';
  const focused = await p.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  if (focused.text !== expected || focused.outline === 'none') throw Error(`Focus failed ${state}: ${JSON.stringify(focused)}`);
  await p.keyboard.press('Enter');
  if (state === 'busy') {
    await p.waitForFunction(() => document.querySelector('.pa-drive__docs-actions')?.getAttribute('aria-busy') === 'true');
    if (!(await p.evaluate(() => [...document.querySelectorAll('.pa-drive__docs-review button')].every(b => b.disabled)
      && document.querySelector('.pa-drive__filing-status[role=status]').textContent === 'Submitting approval…'
      && !document.querySelector('.pa-drive__filing-status').closest('[aria-busy=true]')
      && document.querySelector('.pa-drive__docs-review button').textContent === 'Submitting approval…'))) throw Error('Busy feedback/guards missing');
    await p.focus('[data-release-synthetic]'); await p.keyboard.press('Enter');
  }
  if (state === 'error') {
    await p.waitForSelector(`${el} [role=alert]`); if (await rpc('result', { threadId })) throw Error('Failed submission was recorded');
    await p.focus(`${el} button`); await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => !document.querySelector('.pa-drive__docs-review'));
  const r = await rpc('result', { threadId });
  if (state === 'cancel' ? r?.outcome !== 'cancelled' : r?.outcome !== 'submitted' || r.value.approved !== !['invalid', 'folder'].includes(state)) throw Error(`Native receipt failed: ${state}`);
  reviewed++;
}
const inert = await p.evaluate(async () => {
  for (const t of await (await fetch('/api/v1/threads?projectId=proj_personal')).json()) {
    const timeline = await (await fetch(`/api/v1/threads/${t.id}/timeline`)).json();
    if (t.status !== 'pending' || t.environmentId !== null || timeline.rows.some(r => r.turnId !== null || r.workKind !== 'form')) return false;
  } return true;
});
if (!inert) throw Error('Synthetic review dispatched provider work');
console.log(JSON.stringify({ reviewed, width, summaryInitiallyVisible: true, keyboardReceipts: true, nativePlacement: true, googleWrites: 0, providerTurns: 0 }));
