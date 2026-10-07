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

test('create approval contains the same effective dates and verified calendar as the eventual insert', async () => {
  const store = createMemoryStore();
  await store.addAccount({ subject: 'person', email: args.account, refreshToken: 'private-refresh' });
  for (const input of [
    { start: '2026-10-07', allDay: true },
    { start: '2026-12-31', end: '2027-01-03', allDay: true },
    { start: args.start, end: args.end, timeZone: args.timeZone },
  ]) {
    let proposal, inserted;
    const service = createCalendarService({ store, oauth: {}, calendar: {
      getEvent: async () => assert.fail('Creation must not read an unrelated event'),
      listCalendars: async () => ({ items: [{ id: 'team', summary: 'Team' }] }),
      insertEvent: async (_record, _id, event) => { inserted = event; return { ...event, id: 'created' }; },
    }, approve: async p => { proposal = p; assert.equal(inserted, undefined); return true; } });
    await service.execute('gcal_create_event', { account: args.account, calendarId: 'team', summary: 'Away', ...input });
    assert.equal(proposal.context.calendarName, 'Team');
    assert.equal(proposal.details.start, inserted.start.date || inserted.start.dateTime);
    assert.equal(proposal.details.end, inserted.end.date || inserted.end.dateTime);
    assert.equal(proposal.details.end, input.end || '2026-10-08');
  }
});

test('deletion context retains provider recurrence metadata but no unrelated private fields', async () => {
  for (const scope of [{ recurringEventId: 'series', originalStartTime: { date: '2026-10-07' } }, { recurrence: ['RRULE:FREQ=WEEKLY'] }, {}]) {
    const { service, proposals } = await setup({
      getEvent: async () => ({ id: 'event', summary: 'Verified title', start: { date: '2026-10-07' }, end: { date: '2026-10-08' }, ...scope, attendees: [{ email: 'private-guest' }], credential: 'private-token' }),
      listCalendars: async () => ({ items: [{ id: 'team', summary: 'Team' }] }),
      deleteEvent: async () => assert.fail('No mutation may precede approval'),
    });
    await assert.rejects(service.execute('gcal_delete_event', { account: args.account, calendarId: 'team', eventId: 'event' }), /not approved/);
    assert.equal(proposals[0].context.calendarName, 'Team');
    assert.equal(proposals[0].context.currentEvent.summary, 'Verified title');
    for (const [key, value] of Object.entries(scope)) assert.deepEqual(proposals[0].context.currentEvent[key], value);
    assert.doesNotMatch(JSON.stringify(proposals), /private-guest|private-token|private-refresh/);
  }
});

test('attendee review retains only verified guest identity and incompleteness, not provider comments', async () => {
  const { service, proposals } = await setup({
    getEvent: async () => ({ id: 'event', summary: 'Verified title', attendees: [{ email: 'jay@example.test', displayName: 'Jay', comment: 'private-comment', responseStatus: 'accepted' }], attendeesOmitted: true }),
    listCalendars: async () => ({ items: [{ id: 'team', summary: 'Team' }] }),
  });
  await assert.rejects(service.execute('gcal_update_event', { account: args.account, calendarId: 'team', eventId: 'event', attendees: ['alex@example.test'] }), /not approved/);
  assert.deepEqual(proposals[0].context.currentEvent.attendees, [{ email: 'jay@example.test', displayName: 'Jay' }]);
  assert.equal(proposals[0].context.currentEvent.attendeesOmitted, true);
  assert.doesNotMatch(JSON.stringify(proposals), /private-comment|accepted|private-refresh/);
});

test('a mismatched provider event cannot supply identity or scope for the target being approved', async () => {
  const { service, proposals, logs } = await setup({
    getEvent: async () => ({ id: 'wrong-event', summary: 'Wrong private title', recurrence: ['RRULE:FREQ=WEEKLY'] }),
    listCalendars: async () => ({ items: [{ id: 'team', summary: 'Team' }] }),
  });
  await assert.rejects(service.execute('gcal_delete_event', { account: args.account, calendarId: 'team', eventId: 'event' }), /not approved/);
  assert.equal(proposals[0].context.currentEvent, null);
  assert.equal(proposals[0].context.calendarName, 'Team');
  assert.deepEqual(logs, ['approval_event_read unknown']);
  assert.doesNotMatch(JSON.stringify(logs), /wrong-event|Wrong private title/);
});

test('create and delete failed context reads still show an honest proposal with safe diagnostics', async () => {
  for (const operation of ['create', 'delete']) {
    const { service, proposals, logs } = await setup({
      getEvent: async () => { throw Object.assign(new Error('private-event'), { status: 503 }); },
      listCalendars: async () => { throw Object.assign(new Error('private-calendar'), { status: 401 }); },
    });
    const input = operation === 'create' ? { account: args.account, calendarId: 'team', summary: 'Away', start: '2026-10-07', allDay: true } : { account: args.account, calendarId: 'team', eventId: 'event' };
    await assert.rejects(service.execute(`gcal_${operation}_event`, input), /not approved/);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].context.currentEvent, null);
    assert.equal(proposals[0].context.calendarName, null);
    assert.deepEqual(logs, [...(operation === 'delete' ? ['approval_event_read http_status=503'] : []), 'approval_calendar_read http_status=401']);
    assert.doesNotMatch(JSON.stringify(logs), /private|person@example/);
  }
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
