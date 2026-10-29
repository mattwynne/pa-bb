import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';

const appointment = { account: 'person@example.test', calendarId: 'team', summary: 'Synthetic appointment', start: '2026-10-29T14:30:00-07:00', end: '2026-10-29T17:00:00-07:00', timeZone: 'America/Vancouver', recurrence: { frequency: 'weekly', byDay: ['TH'] }, sendUpdates: 'all' };
async function setup(run, { failInsert = false } = {}) {
  const original = globalThis.fetch, writes = [];
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-calendar' });
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith('/userinfo')) return Response.json({ sub: 'person', email: 'person@example.test', email_verified: true });
    if (options?.method === 'POST') {
      writes.push({ url, body: JSON.parse(options.body) });
      if (failInsert) throw Object.assign(new Error('private-token private-appointment'), { cause: { content: 'private-account' } });
      return Response.json({ id: 'synthetic-series', ...JSON.parse(options.body) });
    }
    return Response.json({ items: [{ id: 'team', summary: 'Synthetic calendar' }] });
  };
  try {
    await plugin(bb);
    await createBbStore(bb.storage.database(), () => {}).addAccount({ subject: 'person', email: 'person@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
    await run(harness, writes);
  } finally { globalThis.fetch = original; await harness.lifecycle.dispose(); }
}
for (const outcome of ['approved', 'notified', 'declined', 'cancelled']) for (const ending of ['forever', 'count', 'until']) {
  test(`recurring native creation: ${ending}, ${outcome}`, () => setup(async (harness, writes) => {
    const args = { ...appointment, recurrence: { ...appointment.recurrence, ...(ending === 'count' ? { count: 5 } : ending === 'until' ? { until: '2026-12-03T14:30:00-07:00' } : {}) } };
    const pending = harness.behavior.callAgentTool('gcal_create_event', args);
    await new Promise(resolve => setImmediate(resolve));
    const form = harness.inspection.pendingInteractions[0];
    assert.ok(form, 'Must pause at native owner approval');
    assert.equal(writes.length, 0);
    assert.deepEqual(form.payload.proposed.recurrence, { ...args.recurrence, interval: 1, ...(ending === 'until' ? { until: '2026-12-03T21:30:00Z' } : {}) });
    assert.equal(form.payload.proposed.timeZone, 'America/Vancouver');
    assert.deepEqual(form.payload.recurrencePreview, { pattern: 'Every week on Thursday', ending: ending === 'count' ? 'Ends after 5 occurrences (including the first).' : ending === 'until' ? 'Ends at 2026-12-03T21:30:00Z (UTC) — inclusive cutoff for occurrence starts.' : 'No end date — repeats indefinitely.' });
    assert.equal(form.payload.context.calendarName, 'Synthetic calendar');
    if (outcome === 'cancelled') harness.behavior.cancelInteraction(form.id);
    else harness.behavior.submitInteraction(form.id, { approved: ['approved', 'notified'].includes(outcome), notifyAttendees: outcome === 'notified' });
    const result = await pending;
    if (['declined', 'cancelled'].includes(outcome)) {
      assert.equal(result.isError, true); assert.equal(writes.length, 0);
      assert.match(result.content[0].text, /not approved/);
    } else {
      assert.equal(result.isError, undefined); assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body, { summary: appointment.summary, start: { dateTime: appointment.start, timeZone: appointment.timeZone }, end: { dateTime: appointment.end, timeZone: appointment.timeZone }, recurrence: [`RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH${ending === 'count' ? ';COUNT=5' : ending === 'until' ? ';UNTIL=20261203T213000Z' : ''}`] });
      assert.equal(new URL(writes[0].url).searchParams.get('sendUpdates'), outcome === 'notified' ? 'all' : 'none');
    }
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-|person@example|Synthetic appointment/);
  }));
}

test('native schema rejects raw rules, unknown fields and unsupported frequency before execution', () => setup(async (harness, writes) => {
  for (const recurrence of ['RRULE:FREQ=DAILY', { frequency: 'daily', byDay: ['TH'] }, { ...appointment.recurrence, interval: 53 }, { ...appointment.recurrence, count: 1001 }, { ...appointment.recurrence, raw: 'RRULE:FREQ=DAILY' }, { ...appointment.recurrence, byDay: ['TH', 'TH'] }, { ...appointment.recurrence, count: 2, until: appointment.start }, { ...appointment.recurrence, until: '2026-02-31T12:00:00Z' }]) {
    await assert.rejects(harness.behavior.callAgentTool('gcal_create_event', { ...appointment, recurrence }));
  }
  assert.equal(harness.inspection.pendingInteractions.length, 0);
  assert.equal(writes.length, 0);
}));

test('local validation has safe, useful diagnostics and no approval or provider writes', () => setup(async (harness, writes) => {
  const result = await harness.behavior.callAgentTool('gcal_create_event', { ...appointment, timeZone: 'private-credential/private-event' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /IANA timeZone/);
  assert.match(JSON.stringify(harness.inspection.logEntries), /agent_tool gcal_create_event recurrence_invalid/);
  assert.doesNotMatch(JSON.stringify([result, harness.inspection.logEntries]), /private-|person@example|Synthetic appointment/);
  assert.equal(harness.inspection.pendingInteractions.length, 0);
  assert.equal(writes.length, 0);
}));

// Assert the actual single-event payload, not independent start/end expanders.
// These are first appointments either side of historical DST, NOT evidence of
// Google's future series expansion (which would require provider verification).
for (const [start, end, byDay] of [
  ['2025-03-06T14:30:00-08:00', '2025-03-06T17:00:00-08:00', ['TH']],
  ['2025-03-13T14:30:00-07:00', '2025-03-13T17:00:00-07:00', ['TH']],
  ['2025-10-30T14:30:00-07:00', '2025-10-30T17:00:00-07:00', ['TH']],
  ['2025-11-06T14:30:00-08:00', '2025-11-06T17:00:00-08:00', ['TH']],
  // A single appointment straddling the fall fold has different boundary offsets.
  ['2025-11-02T01:30:00-07:00', '2025-11-02T01:45:00-08:00', ['SU']],
]) test(`paired provider payload preserves first appointment ${start}`, () => setup(async (harness, writes) => {
  const pending = harness.behavior.callAgentTool('gcal_create_event', { ...appointment, start, end, recurrence: { frequency: 'weekly', byDay, count: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  const form = harness.inspection.pendingInteractions[0];
  assert.equal(form.payload.proposed.start, start);
  assert.equal(form.payload.proposed.end, end);
  assert.equal(writes.length, 0);
  harness.behavior.submitInteraction(form.id, { approved: true });
  assert.equal((await pending).isError, undefined);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { summary: appointment.summary,
    start: { dateTime: start, timeZone: appointment.timeZone },
    end: { dateTime: end, timeZone: appointment.timeZone },
    recurrence: [`RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=${byDay.join(',')};COUNT=2`] });
}));

const repeatVariants = [
  { args: { recurrence: { frequency: 'daily', interval: 2, count: 3 } }, rule: 'FREQ=DAILY;INTERVAL=2;COUNT=3' },
  { args: { start: '2026-01-31T14:30:00-08:00', end: '2026-01-31T17:00:00-08:00', recurrence: { frequency: 'monthly' } }, rule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31', exception: /Months without day 31 are skipped/ },
  { args: { start: '2024-02-29T10:00:00Z', end: '2024-02-29T11:00:00Z', timeZone: 'UTC', recurrence: { frequency: 'yearly', until: '2032-02-29T10:00:00Z' } }, rule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29;UNTIL=20320229T100000Z', exception: /Years without February 29 are skipped/ },
  { args: { allDay: true, start: '2026-12-31', end: undefined, recurrence: { frequency: 'daily', until: '2027-01-03' } }, effectiveEnd: '2027-01-01', rule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20270103' },
  { args: { allDay: true, start: '2026-10-29', end: '2026-11-01', recurrence: { frequency: 'weekly', byDay: ['MO', 'TH'], interval: 2, count: 5 } }, rule: 'FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,TH;COUNT=5' },
  { args: { allDay: true, start: '2026-01-31', end: '2026-02-02', recurrence: { frequency: 'monthly' } }, rule: 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31', exception: /Months without day 31 are skipped/ },
  { args: { allDay: true, start: '2024-02-29', end: undefined, recurrence: { frequency: 'yearly', until: '2032-02-29' } }, effectiveEnd: '2024-03-01', rule: 'FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29;UNTIL=20320229', exception: /Years without February 29 are skipped/ },
];
for (const variant of repeatVariants) for (const outcome of ['approved', 'declined', 'cancelled']) {
  test(`${variant.args.allDay ? 'all-day' : 'timed'} ${variant.args.recurrence.frequency} is ${outcome} only through native consent`, () => setup(async (harness, writes) => {
    const args = { ...appointment, ...variant.args };
    const pending = harness.behavior.callAgentTool('gcal_create_event', args);
    await new Promise(resolve => setImmediate(resolve));
    const form = harness.inspection.pendingInteractions[0];
    assert.ok(form);
    assert.equal(writes.length, 0);
    assert.equal(form.payload.proposed.end, variant.effectiveEnd ?? args.end);
    if (variant.exception) assert.match(form.payload.recurrencePreview.exception, variant.exception);
    if (outcome === 'cancelled') harness.behavior.cancelInteraction(form.id);
    else harness.behavior.submitInteraction(form.id, { approved: outcome === 'approved' });
    const result = await pending;
    if (outcome === 'approved') {
      assert.equal(result.isError, undefined);
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body, { summary: appointment.summary,
        start: args.allDay ? { date: args.start } : { dateTime: args.start, timeZone: args.timeZone },
        end: args.allDay ? { date: variant.effectiveEnd ?? args.end } : { dateTime: args.end, timeZone: args.timeZone },
        recurrence: [`RRULE:${variant.rule}`] });
      assert.equal(new URL(writes[0].url).searchParams.get('sendUpdates'), 'none');
    } else {
      assert.equal(result.isError, true);
      assert.equal(writes.length, 0);
    }
  }));
}

for (const variant of repeatVariants) test(`uncertain ${variant.args.allDay ? 'all-day' : 'timed'} ${variant.args.recurrence.frequency} is not replayed`, () => setup(async (harness, writes) => {
  const pending = harness.behavior.callAgentTool('gcal_create_event', { ...appointment, ...variant.args });
  await new Promise(resolve => setImmediate(resolve));
  harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0].id, { approved: true });
  const result = await pending;
  assert.equal(writes.length, 1);
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify([result, harness.inspection.logEntries]), /private-/);
}, { failInsert: true }));

test('uncertain recurring insert is never replayed and leaks no provider body', () => setup(async (harness, writes) => {
  const pending = harness.behavior.callAgentTool('gcal_create_event', appointment);
  await new Promise(resolve => setImmediate(resolve));
  harness.behavior.submitInteraction(harness.inspection.pendingInteractions[0].id, { approved: true });
  const result = await pending;
  assert.equal(writes.length, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /may have completed; check the calendar before retrying/);
  assert.match(JSON.stringify(harness.inspection.logEntries), /agent_tool gcal_create_event unknown/);
  assert.doesNotMatch(JSON.stringify([result, harness.inspection.logEntries]), /private-|person@example|Synthetic appointment/);
}, { failInsert: true }));
