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
  for (const recurrence of ['RRULE:FREQ=DAILY', { frequency: 'daily', byDay: ['TH'] }, { ...appointment.recurrence, interval: 53 }, { ...appointment.recurrence, count: 1001 }, { ...appointment.recurrence, raw: 'RRULE:FREQ=DAILY' }]) {
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
