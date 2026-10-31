// Only the disposable Sheets fixture. No Google access or provider turns.
const p = await browser.getPage('main'), u = new URL(p.url()), base = u.origin;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Disposable loopback BB required');
const width = Number(u.searchParams.get('reviewWidth') || 1280);
if (![390,1280].includes(width)) throw Error('Unexpected width');
await p.setViewport({ width, height: width === 390 ? 844 : 900 });
const rpc = (method, input) => p.evaluate(async ({ method, input }) => {
  const r = await fetch(`/api/v1/plugins/sheets-edit-review/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw Error('Synthetic fixture RPC failed'); return (await r.json()).result;
}, { method, input });
const threads = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t => ({ id: t.id, state: t.title.replace('Synthetic Sheets review: ', ''), status: t.status })));
if (threads.length !== 9 || threads.some(t => t.status !== 'pending')) throw Error('Expected nine inert fixture threads');
let reviewed = 0;
for (const { id: threadId, state } of threads) {
  if (!await p.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}/interactions`)).json()).length, threadId)) await rpc('stage', { threadId, state });
  await p.goto(`${base}/threads/${threadId}`); await p.waitForSelector('.pa-drive__sheets-review');
  const sel = '.pa-drive__sheets-review';
  const evidence = await p.evaluate(() => {
    const el = document.querySelector('.pa-drive__sheets-review');
    return { text: el.innerText, overflow: el.scrollWidth > el.clientWidth, disabled: el.querySelector('button').disabled, link: !!el.querySelector('a'), detailsOpen: el.querySelector('details')?.open,
      tableWidth: el.querySelector('table')?.getBoundingClientRect().width, width: el.getBoundingClientRect().width };
  });
  if (evidence.overflow || evidence.link) throw Error(`Overflow or real Google link: ${state}`);
  if (state === 'invalid' || state === 'invalid-merge') { if (!evidence.disabled || !evidence.text.includes('incomplete')) throw Error('Invalid card approvable'); }
  else {
    if (evidence.disabled || evidence.detailsOpen || !evidence.text.includes('owner@example.test') || !evidence.text.includes('cannot prevent') || !evidence.text.includes('Notes and other formatting stay')) throw Error(`Missing target/limits: ${state}`);
    if (state === 'formulas' || state === 'error') for (const text of ['Formulas mode', 'Formula: =SUM(A1:A2)', 'Literal string: "=SUM(A1:A2)"', 'Formula: =1/0', 'separate from calculation success', 'neither triggers retry']) if (!evidence.text.includes(text)) throw Error(`Missing formula disclosure ${text}`);
    if (state === 'merged') for (const text of ['Merged text: B3:P3', 'updating only B3', 'top-left cell', 'complete merged area', 'no other cell values are submitted', 'Exact merged-cell text change']) if (!evidence.text.includes(text)) throw Error(`Missing merged disclosure ${text}`);
    if (state === 'clear' && !evidence.text.includes('Blank (clear)')) throw Error('Clear not shown');
    if (state === 'values' && (!evidence.text.includes('Literal string: "=SUM(A1:A2)"') || !evidence.text.includes('Boolean: true') || !evidence.text.includes('DATE yyyy-mm-dd') || !evidence.text.includes('CURRENCY'))) throw Error('Typed values missing');
    if (state === 'long' && !evidence.text.includes('<script>synthetic & safe</script>')) throw Error('Escaped long value missing');
    await p.focus(`${sel} summary`); await p.keyboard.press('Enter');
    if (!await p.evaluate(() => document.querySelector('.pa-drive__sheets-review details').open)) throw Error('Keyboard disclosure failed');
    await p.keyboard.press('Enter');
  }
  if (state === 'values' || state === 'formulas' || state === 'merged') await p.shot({ type: 'jpeg', maxEdge: 1100, quality: 65 });
  const cancel = state === 'clear', decline = state === 'invalid' || state === 'invalid-merge' || state === 'long';
  await p.focus(`${sel} button:nth-child(${cancel ? 3 : decline ? 2 : 1})`);
  const focus = await p.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  if (focus.outline === 'none' || focus.text !== (cancel ? 'Cancel review' : decline ? 'Decline' : 'Approve edit')) throw Error(`Keyboard focus missing: ${state}`);
  await p.keyboard.press('Enter');
  if (state === 'busy') {
    await p.waitForFunction(() => document.querySelector('.pa-drive__sheets-review')?.getAttribute('aria-busy') === 'true');
    if (!await p.evaluate(() => [...document.querySelectorAll('.pa-drive__sheets-review button')].every(b => b.disabled))) throw Error('Busy controls active');
    await p.focus('[data-release-synthetic]'); await p.keyboard.press('Enter');
  }
  if (state === 'error') {
    await p.waitForSelector(`${sel} [role=alert]`);
    if (await rpc('result', { threadId })) throw Error('Failed submission recorded');
    await p.focus(`${sel} button`); await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => !document.querySelector('.pa-drive__sheets-review'));
  const result = await rpc('result', { threadId });
  if (cancel ? result?.outcome !== 'cancelled' : result?.outcome !== 'submitted' || result.value.approved !== !decline) throw Error(`Bad native receipt: ${state}`);
  reviewed++;
}
const inert = await p.evaluate(async () => {
  for (const t of await (await fetch('/api/v1/threads?projectId=proj_personal')).json()) {
    const timeline = await (await fetch(`/api/v1/threads/${t.id}/timeline`)).json();
    if (t.status !== 'pending' || timeline.rows.some(r => r.turnId !== null || r.workKind !== 'form')) return false;
  } return true;
});
if (!inert) throw Error('Unexpected provider work');
console.log(JSON.stringify({ reviewed, width, keyboardReceipts: true, googleWrites: 0, providerTurns: 0 }));
