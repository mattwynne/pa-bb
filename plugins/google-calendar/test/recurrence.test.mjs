import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRecurrence, recurrencePreview, RecurrenceValidationError } from '../core/recurrence.mjs';
import { createCalendarService } from '../core/service.mjs';
import { failureCategory } from '../diagnostic.mjs';


export const appointment = { account: 'person@example.test', calendarId: 'team', summary: 'Synthetic appointment', start: '2026-10-29T14:30:00-07:00', end: '2026-10-29T17:00:00-07:00', timeZone: 'America/Vancouver', recurrence: { frequency: 'weekly', byDay: ['TH'] } };
const prepare = changes => prepareRecurrence({ ...appointment, ...changes });

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

test('UTC cutoff encoding is inclusive, not a guessed local end or series expansion', () => {
  const recurrence = { ...appointment.recurrence, until: appointment.start };
  assert.match(prepare({ recurrence }).rule, /UNTIL=20261029T213000Z$/);
  assert.throws(() => prepare({ recurrence: { ...recurrence, until: '2026-10-29T21:29:59Z' } }), RecurrenceValidationError);
  assert.equal(prepare({ recurrence: { ...recurrence, until: '2026-10-29T21:30:00Z' } }).rule, prepare({ recurrence }).rule);
  const historical = prepare({ start: '2025-10-30T14:30:00-07:00', end: '2025-10-30T17:00:00-07:00', recurrence: { ...appointment.recurrence, until: '2025-11-13T14:30:00-08:00' } });
  assert.match(historical.rule, /UNTIL=20251113T223000Z$/);
});

test('daily, monthly and yearly rules use the first local date as their anchor', () => {
  assert.equal(prepare({ recurrence: { frequency: 'daily', interval: 2, count: 3 } }).rule, 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3');
  const monthly = { ...appointment, start: '2026-01-31T14:30:00-08:00', end: '2026-01-31T17:00:00-08:00', recurrence: { frequency: 'monthly' } };
  const month = prepareRecurrence(monthly);
  assert.equal(month.rule, 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31');
  assert.deepEqual(recurrencePreview(month.normalized, monthly), { pattern: 'Every month on day 31', ending: 'No end date — repeats indefinitely.', exception: 'Months without day 31 are skipped, not moved to another date.' });
  const yearly = { ...appointment, start: '2024-02-29T10:00:00Z', end: '2024-02-29T11:00:00Z', timeZone: 'UTC', recurrence: { frequency: 'yearly', interval: 4, until: '2032-02-29T10:00:00Z' } };
  const year = prepareRecurrence(yearly);
  assert.equal(year.rule, 'RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29;UNTIL=20320229T100000Z');
  assert.equal(recurrencePreview(year.normalized, yearly).pattern, 'Every 4 years on February 29');
  assert.match(recurrencePreview(year.normalized, yearly).exception, /Years without February 29 are skipped/);
});

for (const [frequency, start, ending, rule] of [
  ['daily', '2026-12-31', { until: '2027-01-03' }, 'FREQ=DAILY;INTERVAL=1;UNTIL=20270103'],
  ['weekly', '2026-10-29', { byDay: ['TH'], count: 3 }, 'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH;COUNT=3'],
  ['monthly', '2026-01-31', {}, 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31'],
  ['yearly', '2024-02-29', { until: '2032-02-29' }, 'FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29;UNTIL=20320229'],
]) test(`floating all-day ${frequency} encodes date cutoffs, not UTC instants`, () => {
  const args = { allDay: true, start, recurrence: { frequency, ...ending } };
  const prepared = prepareRecurrence(args);
  assert.equal(prepared.rule, `RRULE:${rule}`);
  if (ending.until) assert.equal(recurrencePreview(prepared.normalized, args).ending, `Last allowed occurrence-start date: ${ending.until} (inclusive).`);
  assert.equal(prepareRecurrence({ ...args, timeZone: 'America/Vancouver' }).rule, prepared.rule, 'A timezone does not shift an all-day date');
});

const invalidModes = [
  ...['daily', 'monthly', 'yearly'].map(frequency => ({ recurrence: { frequency, byDay: ['TH'] } })),
  { recurrence: { frequency: 'weekly' } },
  { recurrence: { frequency: 'hourly' } },
  { recurrence: { frequency: 'monthly', byMonthDay: 31 } },
  { recurrence: { frequency: 'monthly', ordinal: -1, byDay: ['FR'] } },
  { recurrence: { frequency: 'daily', until: '2026-11-01' } },
  ...['2026-02-30', '2026-10-29T00:00:00Z', '', null].map(start => ({ allDay: true, start, recurrence: { frequency: 'daily' } })),
  ...['2026-10-29', '2026-10-28', '2026-02-31', '2026-10-30T00:00:00Z', ''].map(end => ({ allDay: true, start: '2026-10-29', end, recurrence: { frequency: 'daily' } })),
  ...['2026-10-28', '2026-10-30T00:00:00Z', '2027-02-29'].map(until => ({ allDay: true, start: '2026-10-29', end: undefined, recurrence: { frequency: 'daily', until } })),
  { allDay: true, start: '9999-12-31', end: undefined, recurrence: { frequency: 'daily' } },
  { allDay: true, start: '2026-10-29', end: undefined, recurrence: { frequency: 'weekly', byDay: ['FR'] } },
];
for (const [i, changes] of invalidModes.entries()) test(`invalid repeat mode ${i} fails before any port`, async () => {
  const fail = () => assert.fail('Invalid proposal crossed a port');
  const service = createCalendarService({ store: { byEmail: fail }, calendar: { insertEvent: fail }, approve: fail });
  await assert.rejects(service.execute('gcal_create_event', { ...appointment, ...changes }), RecurrenceValidationError);
});

test('all-day cutoffs include the first start, not the exclusive end of the occurrence', () => {
  const args = { start: '2026-12-31', end: '2027-01-03', allDay: true, recurrence: { frequency: 'yearly', until: '2026-12-31' } };
  assert.equal(prepareRecurrence(args).rule, 'RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=12;BYMONTHDAY=31;UNTIL=20261231');
});

test('recurrence diagnostics use a local fixed category, not messages or provider codes', () => {
  assert.equal(failureCategory(new RecurrenceValidationError('private-token private-event')), 'recurrence_invalid');
  assert.equal(failureCategory({ code: 'recurrence_invalid', message: 'private-token', cause: 'private-event' }), 'unknown');
});
