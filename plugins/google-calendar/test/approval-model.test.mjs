import test from 'node:test';
import assert from 'node:assert/strict';
import { deletionScope, attendeeChanges, allDayRange, approvalChoice } from '../approval-model.mjs';

test('notifications require an explicit checked boolean and an explicit approval', () => {
  assert.deepEqual(approvalChoice({ approved: true, notifyAttendees: true }), { approved: true, notifyAttendees: true });
  for (const notifyAttendees of [undefined, false, 'true', 1, null, [], {}]) {
    assert.deepEqual(approvalChoice({ approved: true, notifyAttendees }), { approved: true, notifyAttendees: false });
  }
  for (const value of [null, [], true, { approved: false, notifyAttendees: true }, { approved: 'true', notifyAttendees: true }]) {
    assert.deepEqual(approvalChoice(value), { approved: false, notifyAttendees: false });
  }
});

test('deletion scope uses verified provider metadata, never an event ID pattern', () => {
  assert.equal(deletionScope({ id: 'event', recurringEventId: 'series' }), 'occurrence');
  assert.equal(deletionScope({ id: 'event', recurrence: ['RRULE:FREQ=WEEKLY'] }), 'series');
  assert.equal(deletionScope({ id: 'event' }), 'event');
  for (const event of [null, {}, { id: 'looks_like_an_instance_20261007T150000Z', originalStartTime: { date: '2026-10-07' } }, { id: 'event', recurrence: 'malformed' }, { id: 'event', recurringEventId: '' }]) assert.equal(deletionScope(event), 'unknown');
});

test('attendee diff is case-insensitive, deduplicated, and preserves verified names', () => {
  const current = { attendees: [{ email: 'Jay@example.test', displayName: 'Jay' }, { email: 'PAT@example.test', displayName: 'Pat' }, { email: 'pat@example.test' }] };
  const diff = attendeeChanges(current, ['alex@example.test', 'pat@example.test', 'PAT@example.test']);
  assert.equal(diff.known, true);
  assert.deepEqual(diff.added, [{ email: 'alex@example.test' }]);
  assert.deepEqual(diff.removed, [{ email: 'Jay@example.test', displayName: 'Jay' }]);
  assert.deepEqual(diff.kept, [{ email: 'PAT@example.test', displayName: 'Pat' }]);
});

test('empty current/proposed attendees are meaningful; incomplete lists do not fabricate a diff', () => {
  assert.equal(attendeeChanges({ attendees: [] }, []).known, true);
  assert.deepEqual(attendeeChanges({ attendees: [{ email: 'jay@example.test' }] }, []).removed, [{ email: 'jay@example.test' }]);
  for (const current of [null, {}, { attendees: [{ email: 'jay@example.test' }], attendeesOmitted: true }, { attendees: [{ displayName: 'Missing email' }] }]) {
    const diff = attendeeChanges(current, ['alex@example.test']);
    assert.equal(diff.known, false);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.kept, []);
    assert.deepEqual(diff.proposed, [{ email: 'alex@example.test' }]);
  }
});

test('all-day dates convert only valid exclusive ends, including leap years and year boundaries', () => {
  assert.deepEqual(allDayRange('2026-10-07', '2026-10-08'), { start: '2026-10-07', last: '2026-10-07', days: 1 });
  assert.deepEqual(allDayRange('2026-12-31', '2027-01-03'), { start: '2026-12-31', last: '2027-01-02', days: 3 });
  assert.deepEqual(allDayRange('2028-02-28', '2028-03-01'), { start: '2028-02-28', last: '2028-02-29', days: 2 });
  for (const dates of [['2026-02-29', '2026-03-02'], ['2026-10-07', undefined], ['2026-10-07', '2026-10-07'], ['2026-10-08', '2026-10-07'], ['invalid', '2026-10-08']]) assert.equal(allDayRange(...dates), null);
});
