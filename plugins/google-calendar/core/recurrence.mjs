import { z } from 'zod';
import { dateOnly, nextDate, instant, wallTime } from './event-time.mjs';

// One authoritative structure for tool discovery and service-boundary validation.
// Google expands the series; this module only validates and encodes a proposal.
export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export class RecurrenceValidationError extends Error {
  constructor(message) { super(message); this.name = 'RecurrenceValidationError'; }
}
const invalid = message => { throw new RecurrenceValidationError(message); };
export const recurrenceSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  byDay: z.array(z.enum(WEEKDAYS)).min(1).max(7)
    .refine(days => new Set(days).size === days.length, 'Use unique weekdays.')
    .optional().describe('Required only for weekly repeats. Unique local weekdays including the first start date’s weekday. Omit for other frequencies.'),
  interval: z.number().int().min(1).max(52).optional().describe('Every N days/weeks/months/years; default 1. Weeks start Monday.'),
  count: z.number().int().min(1).max(1000).optional().describe('Total occurrences including the first, not elapsed periods. Mutually exclusive with until.'),
  until: z.string().min(1).max(35).refine(value => dateOnly(value) !== null || instant(value) !== null, 'Use a valid date or offset datetime.')
    .optional().describe('Inclusive occurrence-start cutoff. Timed: RFC3339 with seconds and offset. All-day: YYYY-MM-DD. Mutually exclusive with count.'),
}).refine(r => r.count === undefined || r.until === undefined, 'Choose count or until, not both.')
  .refine(r => r.frequency === 'weekly' ? r.byDay !== undefined : r.byDay === undefined, 'Only weekly repeats use byDay; weekly requires it.');

function normalizeRecurrence(value) {
  const parsed = recurrenceSchema.safeParse(value);
  // Never expose Zod's input/issue details through diagnostics or tool errors.
  if (!parsed.success) invalid('Use a daily, weekly, monthly or yearly recurrence. Only weekly uses unique byDay weekdays. Interval 1–52; choose count 1–1000 or a valid until. No extra fields.');
  const r = parsed.data;
  return { frequency: r.frequency, interval: r.interval ?? 1,
    ...(r.byDay ? { byDay: WEEKDAYS.filter(d => r.byDay.includes(d)) } : {}),
    ...(r.count !== undefined ? { count: r.count } : {}),
    ...(r.until !== undefined ? { until: dateOnly(r.until) !== null ? r.until : new Date(instant(r.until)).toISOString().replace('.000Z', 'Z') } : {}) };
}

/** Validate independently of BB schemas. Undefined preserves one-off semantics.
 * Returned rule and normalized proposal describe exactly the same schedule. */
export function prepareRecurrence(args) {
  if (args.recurrence === undefined) return null;
  const normalized = normalizeRecurrence(args.recurrence);
  let start;
  if (args.allDay) {
    start = dateOnly(args.start);
    if (start === null) invalid('Recurring all-day start must be a valid date (YYYY-MM-DD).');
    const end = dateOnly(args.end ?? nextDate(args.start));
    if (end === null || end <= start) invalid('Recurring all-day end must be a valid exclusive date after start.');
    if (normalized.until !== undefined && dateOnly(normalized.until) === null) invalid('All-day recurrence until must be a date (YYYY-MM-DD).');
  } else {
    const timeZone = args.timeZone;
    if (typeof timeZone !== 'string' || timeZone.length > 100 || !(timeZone === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timeZone))) invalid('Recurring timed events require an explicit IANA timeZone, such as America/Vancouver.');
    try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
    catch { invalid('Recurring timed events require a valid IANA timeZone.'); }
    start = instant(args.start);
    const end = instant(args.end);
    if (start === null || end === null) invalid('Recurring start and end require valid RFC3339 datetimes with seconds and explicit UTC offsets.');
    if (end <= start) invalid('Recurring end must be after start.');
    if (wallTime(start, timeZone) !== args.start.slice(0, 19) || wallTime(end, timeZone) !== args.end.slice(0, 19)) invalid('Recurring start/end offsets must match the IANA timezone at those local times.');
    if (normalized.until !== undefined && instant(normalized.until) === null) invalid('Timed recurrence until requires a datetime with seconds and an explicit offset.');
  }
  const anchor = args.start.slice(0, 10);
  const [, month, day] = anchor.split('-').map(Number);
  const parts = [`FREQ=${normalized.frequency.toUpperCase()}`, `INTERVAL=${normalized.interval}`];
  if (normalized.frequency === 'weekly') {
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${anchor}T00:00:00Z`).getUTCDay()];
    if (!normalized.byDay.includes(weekday)) invalid('Recurrence byDay must include the start date’s local weekday.');
    parts.push('WKST=MO', `BYDAY=${normalized.byDay.join(',')}`);
  }
  if (normalized.frequency === 'yearly') parts.push(`BYMONTH=${month}`);
  if (['monthly', 'yearly'].includes(normalized.frequency)) parts.push(`BYMONTHDAY=${day}`);
  if (normalized.count !== undefined) parts.push(`COUNT=${normalized.count}`);
  if (normalized.until !== undefined) {
    const cutoff = args.allDay ? dateOnly(normalized.until) : instant(normalized.until);
    if (cutoff < start) invalid('Recurrence until must be at or after the first start (inclusive occurrence-start cutoff).');
    parts.push(`UNTIL=${normalized.until.replace(/[-:]/g, '')}`);
  }
  return { normalized, rule: `RRULE:${parts.join(';')}` };
}

/** View data for an already validated proposal, not a browser-side validator. */
export function recurrencePreview(r, args) {
  const names = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [, month, day] = args.start.slice(0, 10).split('-').map(Number);
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.frequency];
  let when = '', exception;
  if (r.frequency === 'weekly') when = ` on ${r.byDay.map(d => names[d]).join(', ')}`;
  if (r.frequency === 'monthly') {
    when = ` on day ${day}`;
    if (day >= 29) exception = `Months without day ${day} are skipped, not moved to another date.`;
  }
  if (r.frequency === 'yearly') {
    when = ` on ${months[month - 1]} ${day}`;
    if (month === 2 && day === 29) exception = 'Years without February 29 are skipped, not moved to another date.';
  }
  let ending = 'No end date — repeats indefinitely.';
  if (r.count !== undefined) ending = `Ends after ${r.count} occurrence${r.count === 1 ? '' : 's'} (including the first).`;
  else if (r.until) ending = args.allDay ? `Last allowed occurrence-start date: ${r.until} (inclusive).` : `Ends at ${r.until} (UTC) — inclusive cutoff for occurrence starts.`;
  return { pattern: `Every ${r.interval === 1 ? unit : `${r.interval} ${unit}s`}${when}`, ending, ...(exception ? { exception } : {}) };
}
