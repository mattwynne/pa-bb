// Date-only arithmetic is UTC arithmetic on calendar dates, never a timezone
// conversion. Date.parse alone would silently normalize dates like February 31.
export function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
export function nextDate(value) {
  const ms = dateOnly(value);
  if (ms === null) throw new Error('Invalid all-day start date');
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

// Whole seconds and an explicit offset disambiguate a fall fold. Unknown
// offsets (-00:00), local datetimes, leap seconds and normalized bad dates fail.
export function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || value.endsWith('-00:00')) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && dateOnly(value.slice(0, 10)) !== null && /^\d{4}-/.test(new Date(ms).toISOString()) ? ms : null;
}
export function wallTime(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const part = name => parts.find(p => p.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
