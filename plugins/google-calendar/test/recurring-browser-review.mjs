// Run with bb browser-automation run --script-file, after opening the controller's
// disposable URL and using the host's Skip setup button if first-run is shown.
const p = await browser.getPage('main');
const location = new URL(p.url());
const base = location.origin;
const width = Number(location.searchParams.get('reviewWidth') || 1280);
if (![1280, 390].includes(width)) throw Error('Use reviewWidth=1280 or reviewWidth=390');
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback preview required');
const rpc = (method, input) => p.evaluate(async ({ method, input }) => {
  const response = await fetch(`/api/v1/plugins/calendar-approval-review/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw Error(`Fixture RPC ${response.status}`);
  return (await response.json()).result;
}, { method, input });
const threads = await p.evaluate(async () => (await (await fetch('/api/v1/threads?projectId=proj_personal')).json()).map(t => ({ id: t.id, state: t.title.replace('Synthetic Calendar review: ', ''), status: t.status })));
if (threads.length !== 17 || threads.some(t => t.status !== 'pending')) throw Error('Expected seventeen inert synthetic threads');
let reviewed = 0;
await p.setViewport({ width, height: 1100 });
for (const { id: threadId, state } of threads) {
  // Inspect the real host state so re-runs also work after fixture reloads.
  const pending = await p.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}/interactions`)).json()).length, threadId);
  if (!pending) await rpc('stage', { threadId, state });
  await p.goto(`${base}/threads/${threadId}`);
  await p.waitForSelector('.pa-calendar__approval');
  const evidence = await p.evaluate(() => {
    const el = document.querySelector('.pa-calendar__approval');
    const checkbox = el.querySelector('input[type=checkbox]');
    checkbox.focus();
    return { text: el.innerText, overflow: el.scrollWidth > el.clientWidth, checked: checkbox.checked, disabled: el.querySelector('button').disabled, detailsOpen: el.querySelector('details').open,
      native: el.closest('section[aria-label], [role=region]')?.getAttribute('aria-label'), focusStyle: getComputedStyle(checkbox).outlineStyle };
  });
  if (!evidence.native?.startsWith('Approve Calendar') || evidence.overflow || evidence.checked || evidence.detailsOpen || evidence.focusStyle === 'none') throw Error(`Native layout/default/focus failed: ${state}`);
  if (state === 'legacy') {
    if (!evidence.disabled || !evidence.text.includes('Recurrence could not be verified')) throw Error('Legacy proposal must require a new review');
  } else {
    if (evidence.disabled) throw Error('Valid proposal blocked');
    if (state === 'forever' && !evidence.text.includes('No end date — repeats indefinitely')) throw Error('Missing indefinite schedule');
    if (state === 'count' && !evidence.text.includes('Every 2 weeks on Monday, Thursday')) throw Error('Missing interval/weekdays');
    if (state === 'count' && !evidence.text.includes('5 occurrences (including the first)')) throw Error('Missing count');
    if (state === 'until' && (!evidence.text.includes('2:30 PM (UTC-07:00)') || !evidence.text.includes('2026-11-05T21:30:00Z (UTC) — inclusive cutoff'))) throw Error('First start/cutoff misrepresented');
    if (state === 'oneoff' && evidence.text.includes('repeats indefinitely')) throw Error('One-off changed');
    if (state === 'update-series' && !evidence.text.includes('Update the entire series')) throw Error('Missing update series scope');
    if (state === 'update-occurrence' && !evidence.text.includes('Update only this occurrence')) throw Error('Missing occurrence scope');
    if (state === 'delete-series' && !evidence.text.includes('Delete the entire series')) throw Error('Missing deletion scope');
    if (state === 'daily' && !evidence.text.includes('Every 2 days')) throw Error('Missing daily interval');
    if (state.includes('monthly') && (!evidence.text.includes('Every month on day 31') || !evidence.text.includes('Months without day 31 are skipped'))) throw Error('Missing month-end policy');
    if (state.includes('yearly') && (!evidence.text.includes('Every year on February 29') || !evidence.text.includes('Years without February 29 are skipped'))) throw Error('Missing leap-day policy');
    if (state.startsWith('all-day-') && !evidence.text.includes('All-day dates do not shift with timezones')) throw Error('All-day proposal acquired timed semantics');
    if (state === 'all-day-daily' && !evidence.text.includes('Last allowed occurrence-start date: 2027-01-03 (inclusive)')) throw Error('Missing all-day cutoff');
  }
  if (state === 'count') await p.keyboard.press('Space');
  await p.keyboard.press('Tab'); // Technical details disclosure
  await p.keyboard.press('Enter');
  if (!(await p.evaluate(() => document.querySelector('.pa-calendar__approval details').open))) throw Error('Keyboard disclosure failed');
  await p.keyboard.press('Enter'); // Collapse again
  await p.keyboard.press('Tab'); // Primary, or decline when primary is disabled
  const decline = state === 'legacy' || state === 'until';
  if (state === 'until') await p.keyboard.press('Tab');
  const focused = await p.evaluate(() => ({ text: document.activeElement.textContent, outline: getComputedStyle(document.activeElement).outlineStyle }));
  if ((decline && focused.text !== 'Decline change') || focused.outline === 'none') throw Error(`Keyboard action focus failed: ${state}`);
  if (state === 'until' || state === 'all-day-monthly') await p.shot({ type: 'jpeg', maxEdge: 1100, quality: 65 });
  await p.keyboard.press('Enter');
  if (state === 'busy') {
    await p.waitForFunction(() => document.querySelector('.pa-calendar__approval')?.getAttribute('aria-busy') === 'true');
    if (!(await p.evaluate(() => [...document.querySelectorAll('.pa-calendar__approval button')].every(b => b.disabled)))) throw Error('Busy actions were not disabled');
    await p.focus('[data-release-synthetic]');
    await p.keyboard.press('Enter');
  }
  if (state === 'error') {
    await p.waitForSelector('.pa-calendar__approval [role=alert]');
    if (await rpc('result', { threadId })) throw Error('Failed submission recorded a receipt');
    if (!(await p.evaluate(() => [...document.querySelectorAll('.pa-calendar__approval button')].every(b => !b.disabled)))) throw Error('Failed submission did not recover');
    await p.evaluate(() => document.querySelector('.pa-calendar__approval-actions button').focus());
    await p.keyboard.press('Enter');
  }
  await p.waitForFunction(() => !document.querySelector('.pa-calendar__approval'));
  const result = await rpc('result', { threadId });
  if (result?.outcome !== 'submitted' || result.value.approved !== !decline || result.value.notifyAttendees !== (state === 'count')) throw Error(`Native submission receipt failed: ${state}`);
  reviewed++;
}
const inert = await p.evaluate(async () => {
  const threads = await (await fetch('/api/v1/threads?projectId=proj_personal')).json();
  for (const thread of threads) {
    const timeline = await (await fetch(`/api/v1/threads/${thread.id}/timeline`)).json();
    if (thread.status !== 'pending' || thread.environmentId !== null || !timeline.rows.length || timeline.rows.some(row => row.turnId !== null || row.workKind !== 'form' || row.lifecycle !== 'submitted')) return false;
  }
  return true;
});
if (!inert) throw Error('Expected only native form receipts, with no provider turns or environments');
console.log(JSON.stringify({ reviewed, widths: [width], nativeThreadPlacement: true, keyboardSubmissionReceipts: true, googleWrites: 0, providerTurns: 0 }));
