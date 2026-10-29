// Run with bb browser-automation run --script-file (not node --test).
// Navigate its main page to the disposable preview first. Never target production.
const p = await browser.getPage('main');
const base = new URL(p.url()).origin;
if (!base.startsWith('http://127.0.0.1:')) throw Error('Disposable loopback preview required');
let reviewed = 0;
for (const width of [1280, 390]) for (const state of ['forever', 'count', 'until', 'oneoff', 'invalid', 'error', 'pending', 'decline', 'update-series', 'update-occurrence', 'delete-series']) {
  await p.setViewport({ width, height: 1100 });
  await p.goto(`${base}/settings/plugins/google-calendar?reviewState=${state}`);
  await p.waitForSelector('.pa-calendar__approval');
  const evidence = await p.evaluate(() => {
    const el = document.querySelector('.pa-calendar__approval');
    const checkbox = el.querySelector('input[type=checkbox]');
    const primary = el.querySelector('button');
    primary.focus();
    return { text: el.textContent, overflow: el.scrollWidth > el.clientWidth, checked: checkbox.checked, disabled: primary.disabled, detailsOpen: el.querySelector('details').open, focused: document.activeElement === primary, focusStyle: getComputedStyle(primary).outlineStyle };
  });
  if (evidence.overflow || evidence.checked || evidence.detailsOpen) throw Error('Layout or notification default failed');
  if (state === 'invalid') {
    if (!evidence.disabled || !evidence.text.includes('Recurrence could not be verified')) throw Error('Invalid proposal not blocked');
  } else {
    if (evidence.disabled || !evidence.focused || evidence.focusStyle === 'none') throw Error('Primary keyboard focus failed');
    if (['forever', 'decline', 'error', 'pending'].includes(state) && !evidence.text.includes('No end date — repeats indefinitely')) throw Error('Missing indefinite schedule');
    if (state === 'count' && !evidence.text.includes('Every 2 weeks on Monday, Thursday')) throw Error('Missing interval/weekdays');
    if (state === 'count' && !evidence.text.includes('5 occurrences (including the first)')) throw Error('Missing count');
    if (state === 'until' && !evidence.text.includes('inclusive cutoff for occurrence starts')) throw Error('Missing cutoff');
    if (state === 'oneoff' && evidence.text.includes('repeats indefinitely')) throw Error('One-off changed');
    if (state === 'update-series' && !evidence.text.includes('Update the entire series')) throw Error('Missing update series scope');
    if (state === 'update-occurrence' && !evidence.text.includes('Update only this occurrence')) throw Error('Missing update occurrence scope');
    if (state === 'delete-series' && !evidence.text.includes('Delete the entire series')) throw Error('Missing delete series scope');
    if (state === 'decline') {
      await p.evaluate(() => document.querySelector('.pa-calendar__approval-actions button:last-child').focus());
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.querySelector('output').textContent.includes('"approved":false'));
    } else if (state === 'error') {
      await p.keyboard.press('Enter');
      await p.waitForSelector('.pa-calendar__approval [role=alert]');
    } else if (state === 'pending') {
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.querySelector('.pa-calendar__approval').getAttribute('aria-busy') === 'true');
      if (!(await p.evaluate(() => [...document.querySelectorAll('.pa-calendar__approval button')].every(b => b.disabled)))) throw Error('Busy actions not disabled');
    } else {
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.querySelector('output').textContent.includes('"approved":true'));
    }
  }
  if (['forever', 'until'].includes(state)) {
    await p.evaluate(() => document.querySelector('.pa-calendar__approval').scrollIntoView({ block: 'start' }));
    await p.shot({ type: 'jpeg', maxEdge: 1100, quality: 65 });
  }
  reviewed++;
}
console.log(JSON.stringify({ reviewed, widths: [1280, 390], fixtureOnly: true, nativeThreadPlacement: 'not exercised', googleWrites: 0 }));
