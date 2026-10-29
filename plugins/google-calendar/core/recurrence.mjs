// Deliberately small structured interface, never arbitrary RRULE text.
export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export class RecurrenceValidationError extends Error {
  constructor(message) { super(message); this.name = 'RecurrenceValidationError'; }
}
const invalid = message => { throw new RecurrenceValidationError(message); };

// Require whole seconds and an explicit offset. Date.parse alone normalizes bad
// dates (e.g. February 31), and accepts ambiguous local/browser datetimes.
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || value.endsWith('-00:00')) return null;
  const ms = Date.parse(value), date = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) && Number.isFinite(date) && /^\d{4}-/.test(new Date(ms).toISOString()) && new Date(date).toISOString().slice(0, 10) === value.slice(0, 10) ? ms : null;
}
function wallTime(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const part = name => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** Pure rule validation is also safe to use in the browser: do not revalidate
 * server-approved offsets against a possibly different browser tzdata version. */
export function normalizeWeeklyRecurrence(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['frequency', 'byDay', 'interval', 'count', 'until'].includes(k))) invalid('Use a structured weekly recurrence; raw rules and extra fields are not supported.');
  if (r.frequency !== 'weekly') invalid('Only weekly recurrence is supported.');
  if (!Array.isArray(r.byDay) || !r.byDay.length || r.byDay.length > 7 || r.byDay.some(d => !WEEKDAYS.includes(d)) || new Set(r.byDay).size !== r.byDay.length) invalid('Recurrence byDay must contain 1–7 unique weekdays (MO through SU).');
  const interval = r.interval === undefined ? 1 : r.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) invalid('Recurrence interval must be a whole number from 1 to 52 weeks.');
  if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1 || r.count > 1000)) invalid('Recurrence count must be a whole number from 1 to 1000 occurrences.');
  if (r.count !== undefined && r.until !== undefined) invalid('Choose recurrence count or until, not both.');
  const until = r.until === undefined ? undefined : instant(r.until);
  if (until === null) invalid('Recurrence until must be a valid offset datetime at or after the first start (inclusive occurrence-start cutoff).');
  return { frequency: 'weekly', byDay: WEEKDAYS.filter(d => r.byDay.includes(d)), interval,
    ...(r.count !== undefined ? { count: r.count } : {}),
    ...(until !== undefined ? { until: new Date(until).toISOString().replace('.000Z', 'Z') } : {}) };
}

/** Validate independently of BB schemas. Undefined preserves one-off semantics.
 * Returned rule and normalized proposal describe exactly the same schedule. */
export function prepareRecurrence(args) {
  if (args.recurrence === undefined) return null;
  const normalized = normalizeWeeklyRecurrence(args.recurrence);
  if (args.allDay) invalid('Recurring creation currently supports timed events only.');
  const timeZone = args.timeZone;
  // Reject fixed-offset pseudo-zones and abbreviations like PST. UTC is explicit.
  if (typeof timeZone !== 'string' || timeZone.length > 100 || !(timeZone === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(timeZone))) invalid('Recurring events require an explicit IANA timeZone, such as America/Vancouver.');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
  catch { invalid('Recurring events require a valid IANA timeZone.'); }
  const start = instant(args.start), end = instant(args.end);
  if (start === null || end === null) invalid('Recurring start and end require valid RFC3339 datetimes with seconds and explicit UTC offsets.');
  if (end <= start) invalid('Recurring end must be after start.');
  if (wallTime(start, timeZone) !== args.start.slice(0, 19) || wallTime(end, timeZone) !== args.end.slice(0, 19)) invalid('Recurring start/end offsets must match the IANA timezone at those local times.');
  // DTSTART must belong to the rule, otherwise providers disagree about count.
  const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${args.start.slice(0, 10)}T00:00:00Z`).getUTCDay()];
  if (!normalized.byDay.includes(weekday)) invalid('Recurrence byDay must include the start date’s local weekday.');
  if (normalized.until !== undefined && Date.parse(normalized.until) < start) invalid('Recurrence until must be a valid offset datetime at or after the first start (inclusive occurrence-start cutoff).');
  const rule = `RRULE:FREQ=WEEKLY;INTERVAL=${normalized.interval};WKST=MO;BYDAY=${normalized.byDay.join(',')}${normalized.count !== undefined ? `;COUNT=${normalized.count}` : normalized.until !== undefined ? `;UNTIL=${normalized.until.replace(/[-:]/g, '')}` : ''}`;
  return { normalized, rule };
}
