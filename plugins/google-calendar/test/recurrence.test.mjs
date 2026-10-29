import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRecurrence, RecurrenceValidationError } from '../core/recurrence.mjs';
import { createCalendarService } from '../core/service.mjs';
import { failureCategory } from '../diagnostic.mjs';
import rrule from 'rrule';

export const appointment = { account: 'person@example.test', calendarId: 'team', summary: 'Synthetic appointment', start: '2026-10-29T14:30:00-07:00', end: '2026-10-29T17:00:00-07:00', timeZone: 'America/Vancouver', recurrence: { frequency: 'weekly', byDay: ['TH'] } };
const prepare = changes => prepareRecurrence({ ...appointment, ...changes });
// rrule's JS Date output is documented as host-local pseudo-UTC. Isolate that
// test-only library quirk; production validation below still runs in the host TZ.
function expandRule(value, max = Infinity) {
  const previous = process.env.TZ;
  process.env.TZ = 'UTC';
  try { return rrule.rrulestr(value).all((_date, index) => index < max); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test('bounded weekly rules are deterministic, with explicit Monday week start and optional end', () => {
  assert.deepEqual(prepare(), { normalized: { frequency: 'weekly', byDay: ['TH'], interval: 1 }, rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH' });
  assert.equal(prepare({ recurrence: { frequency: 'weekly', byDay: ['TH', 'MO'], interval: 2, count: 4 } }).rule, 'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,TH;COUNT=4');
  const ended = prepare({ recurrence: { frequency: 'weekly', byDay: ['TH'], until: '2026-12-03T14:30:00-07:00' } });
  assert.equal(ended.rule, 'RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH;UNTIL=20261203T213000Z');
  assert.equal(ended.normalized.until, '2026-12-03T21:30:00Z');
  assert.match(prepare({ recurrence: { frequency: 'weekly', byDay: ['TH'], count: 1000, interval: 52 } }).rule, /INTERVAL=52.*COUNT=1000/);
  assert.match(prepare({ recurrence: { frequency: 'weekly', byDay: ['TH'], until: appointment.start } }).rule, /UNTIL=20261029T213000Z$/);
  assert.equal(prepare({ recurrence: undefined }), null);
});

const invalid = [
  { recurrence: null }, { recurrence: 'RRULE:FREQ=DAILY' }, { recurrence: [] },
  ...['daily', 'monthly', 'yearly', 'WEEKLY'].map(frequency => ({ recurrence: { frequency, byDay: ['TH'] } })),
  ...[[], ['TH', 'TH'], ['th'], ['XX'], ['TH\nCOUNT=99'], ['MO']].map(byDay => ({ recurrence: { frequency: 'weekly', byDay } })),
  ...[0, 53, -1, 1.1, '2', null].map(interval => ({ recurrence: { ...appointment.recurrence, interval } })),
  ...[0, 1001, -1, 1.5, '4', null].map(count => ({ recurrence: { ...appointment.recurrence, count } })),
  { recurrence: { ...appointment.recurrence, count: 4, until: appointment.start } },
  { recurrence: { ...appointment.recurrence, rrule: 'FREQ=DAILY' } },
  ...['', '2026-10-28T14:30:00-07:00', '2026-02-31T00:00:00Z', '2026-12-01', '2026-12-01T14:30:00', '2026-12-01T14:30:00-00:00', '2026-12-01T14:30:00Z\nRRULE:FREQ=DAILY'].map(until => ({ recurrence: { ...appointment.recurrence, until } })),
  { allDay: true },
  ...[undefined, '', 'PST', '-07:00', '+07:00', 'invalid/zone'].map(timeZone => ({ timeZone })),
  ...['2026-02-31T14:30:00-07:00', '2026-10-29T14:30:00', '2026-10-29', '2026-10-29T24:30:00-07:00', '2026-10-29T14:30:00-08:00'].map(start => ({ start })),
  { end: undefined }, { end: appointment.start }, { end: '2026-10-29T13:00:00-07:00' },
  { end: '2026-10-29T17:00:00-08:00' },
  // A spring gap cannot be made valid by inventing either adjacent offset.
  ...['-08:00', '-07:00'].map(offset => ({ start: `2025-03-09T02:30:00${offset}`, end: '2025-03-09T04:00:00-07:00', recurrence: { frequency: 'weekly', byDay: ['SU'] } })),
];
for (const [i, changes] of invalid.entries()) test(`invalid recurring proposal ${i} is rejected before reads, approval or writes`, async () => {
  assert.throws(() => prepare(changes), RecurrenceValidationError);
  const fail = () => assert.fail('Invalid recurrence crossed a port');
  const service = createCalendarService({ store: { byEmail: fail }, calendar: { insertEvent: fail }, approve: fail });
  await assert.rejects(service.execute('gcal_create_event', { ...appointment, ...changes }), RecurrenceValidationError);
});

test('IANA timezone validation follows tzdata, including folds and historical Vancouver DST', () => {
  for (const offset of ['-07:00', '-08:00']) assert.ok(prepare({ start: `2025-11-02T01:30:00${offset}`, end: '2025-11-02T03:00:00-08:00', recurrence: { frequency: 'weekly', byDay: ['SU'] } }));
  // Two independent weekly starts, either side of Vancouver's historical fall-back.
  for (const [date, offset] of [['2025-10-30', '-07:00'], ['2025-11-06', '-08:00']]) {
    assert.ok(prepare({ start: `${date}T14:30:00${offset}`, end: `${date}T17:00:00${offset}` }));
  }
  for (const [date, offset] of [['2026-10-29', '-07:00'], ['2026-11-05', '-08:00']]) {
    assert.ok(prepare({ timeZone: 'America/Los_Angeles', start: `${date}T14:30:00${offset}`, end: `${date}T17:00:00${offset}` }));
  }
  // Vancouver no longer falls back in 2026 under tzdata 2026c. Do not encode
  // a predicted transition into recurrence payloads: Google's tzdata expands them.
  const november = new Intl.DateTimeFormat('en', { timeZone: 'America/Vancouver', hour: '2-digit', hourCycle: 'h23' }).format(new Date('2026-11-05T21:30:00Z'));
  const offset = november === '14' ? '-07:00' : '-08:00';
  assert.ok(prepare({ start: `2026-11-05T14:30:00${offset}`, end: `2026-11-05T17:00:00${offset}` }));
});

test('independent RFC5545 expansion retains 14:30–17:00 across DST, rather than adding fixed UTC weeks', () => {
  for (const [zone, first, expected] of [
    ['America/Vancouver', '20251030', ['2025-10-30T21:30:00.000Z', '2025-11-06T22:30:00.000Z']],
    ['America/Los_Angeles', '20261029', ['2026-10-29T21:30:00.000Z', '2026-11-05T22:30:00.000Z']],
    ['America/Vancouver', '20250306', ['2025-03-06T22:30:00.000Z', '2025-03-13T21:30:00.000Z']],
  ]) {
    const rule = prepare().rule;
    const expand = time => expandRule(`DTSTART;TZID=${zone}:${first}T${time}\n${rule}`, 2);
    assert.deepEqual(expand('143000').map(d => d.toISOString()), expected);
    const format = new Intl.DateTimeFormat('en', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    assert.deepEqual(expand('143000').map(d => format.format(d)), ['14:30', '14:30']);
    assert.deepEqual(expand('170000').map(d => format.format(d)), ['17:00', '17:00']);
  }
  const rule = prepare().rule;
  const dates = expandRule(`DTSTART;TZID=America/Vancouver:20261029T143000\n${rule}`, 3);
  const format = new Intl.DateTimeFormat('en', { timeZone: 'America/Vancouver', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const date of dates) assert.equal(format.format(date), 'Thursday 14:30');
});

test('independent expansion honours Monday-anchored intervals, count and inclusive UTC cutoff', () => {
  const counted = prepare({ recurrence: { frequency: 'weekly', byDay: ['TH', 'MO'], interval: 2, count: 4 } }).rule;
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dates = expandRule(`DTSTART;TZID=America/Vancouver:20261029T143000\n${counted}`);
  assert.deepEqual(dates.map(d => localDate.format(d)), ['2026-10-29', '2026-11-09', '2026-11-12', '2026-11-23']);
  const ended = prepare({ start: '2025-10-30T14:30:00-07:00', end: '2025-10-30T17:00:00-07:00', recurrence: { ...appointment.recurrence, until: '2025-11-13T14:30:00-08:00' } }).rule;
  assert.deepEqual(expandRule(`DTSTART;TZID=America/Vancouver:20251030T143000\n${ended}`).map(d => d.toISOString()), ['2025-10-30T21:30:00.000Z', '2025-11-06T22:30:00.000Z', '2025-11-13T22:30:00.000Z']);
});

test('recurrence diagnostics use a local fixed category, not messages or provider codes', () => {
  assert.equal(failureCategory(new RecurrenceValidationError('private-token private-event')), 'recurrence_invalid');
  assert.equal(failureCategory({ code: 'recurrence_invalid', message: 'private-token', cause: 'private-event' }), 'unknown');
});
