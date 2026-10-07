import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarService } from '../core/service.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';
import { failureCategory } from '../diagnostic.mjs';

const args = { account: 'person@example.test', calendarId: 'team', eventId: 'event', start: '2026-10-07T08:00:00-07:00', end: '2026-10-07T08:30:00-07:00', timeZone: 'America/Vancouver', sendUpdates: 'all' };
async function setup(calendar) {
  const store = createMemoryStore();
  await store.addAccount({ subject: 'person', email: args.account, refreshToken: 'private-refresh' });
  const proposals = [], logs = [];
  const service = createCalendarService({ store, oauth: {}, calendar, approve: async p => { proposals.push(p); return false; }, diagnose: (stage, error) => logs.push(`${stage} ${failureCategory(error)}`) });
  return { service, proposals, logs };
}

test('update approval obtains provider context using only the exact event and paginated calendar reads', async () => {
  const reads = [];
  const current = { id: 'event', summary: 'Verified title', start: { dateTime: '2026-10-07T09:00:00-07:00' }, end: { dateTime: '2026-10-07T09:30:00-07:00' }, attendees: [{ email: 'private-guest' }], credential: 'private-token' };
  const { service, proposals } = await setup({
    getEvent: async (record, calendarId, eventId) => { reads.push([record.subject, calendarId, eventId]); return current; },
    listCalendars: async (_record, { pageToken }) => pageToken ? { items: [{ id: 'team', summary: 'Team' }, { id: 'other', summary: 'Other', summaryOverride: 'My other calendar' }] } : { items: [], nextPageToken: 'page2' },
    patchEvent: async () => assert.fail('No mutation may precede approval'),
    moveEvent: async () => assert.fail('No mutation may precede approval'),
  });
  await assert.rejects(service.execute('gcal_update_event', { ...args, moveToCalendarId: 'other' }), /not approved/);
  assert.deepEqual(reads, [['person', 'team', 'event']]);
  assert.equal(proposals[0].context.calendarName, 'Team');
  assert.equal(proposals[0].context.destinationCalendarName, 'My other calendar');
  assert.equal(proposals[0].context.currentEvent.summary, 'Verified title');
  assert.deepEqual(proposals[0].details, { ...args, moveToCalendarId: 'other' });
  assert.doesNotMatch(JSON.stringify(proposals), /private-guest|private-token|private-refresh/);
});

test('each failed read is safely diagnosed and does not suppress the approval', async () => {
  const { service, proposals, logs } = await setup({
    getEvent: async () => { throw Object.assign(new Error('private-event private-token'), { status: 503, cause: 'private-cause' }); },
    listCalendars: async () => { throw Object.assign(new Error('private-account'), { status: 401, code: 'private-code' }); },
    patchEvent: async () => assert.fail('No provider write'),
  });
  await assert.rejects(service.execute('gcal_update_event', args), /not approved/);
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].context, { currentEvent: null, calendarName: null, destinationCalendarName: null });
  assert.deepEqual(logs, ['approval_event_read http_status=503', 'approval_calendar_read http_status=401']);
  assert.doesNotMatch(JSON.stringify(logs), /private|person@example/);
});

test('event success with calendar failure preserves before values; calendar success with empty event does not invent them', async () => {
  for (const hasEvent of [true, false]) {
    const { service, proposals } = await setup({
      getEvent: async () => hasEvent ? { summary: 'Verified title' } : null,
      listCalendars: async () => { if (hasEvent) throw new Error('private'); return { items: [{ id: 'real-primary', primary: true, summary: 'My calendar' }] }; },
    });
    await assert.rejects(service.execute('gcal_update_event', { ...args, calendarId: 'primary' }), /not approved/);
    assert.equal(proposals[0].context.currentEvent?.summary ?? null, hasEvent ? 'Verified title' : null);
    assert.equal(proposals[0].context.calendarName, hasEvent ? null : 'My calendar');
  }
});
