/** @typedef {{ email: string, displayName?: string }} Attendee */
/** @param {unknown} value @returns {Record<string, unknown>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Scope comes from Google's event metadata, not guesses based on IDs.
 * @param {unknown} value @returns {'occurrence' | 'series' | 'event' | 'unknown'} */
export function deletionScope(value) {
  const event = object(value);
  if (typeof event.id !== 'string' || !event.id) return 'unknown';
  if (typeof event.recurringEventId === 'string' && event.recurringEventId) return 'occurrence';
  if (event.recurringEventId !== undefined) return 'unknown';
  if (Array.isArray(event.recurrence) && event.recurrence.length && event.recurrence.every(r => typeof r === 'string')) return 'series';
  if (event.originalStartTime !== undefined || (event.recurrence !== undefined && !Array.isArray(event.recurrence))) return 'unknown';
  return 'event';
}

/** @param {unknown} value @returns {Attendee | null} */
function attendee(value) {
  const data = object(value);
  if (typeof data.email !== 'string' || !data.email.trim()) return null;
  return { email: data.email, ...(typeof data.displayName === 'string' && data.displayName.trim() ? { displayName: data.displayName } : {}) };
}
/** @param {Attendee[]} values */
function unique(values) {
  const entries = new Map();
  for (const value of values) {
    const key = value.email.trim().toLowerCase();
    if (!entries.has(key)) entries.set(key, value);
  }
  return entries;
}

/** Never interpret an unavailable/truncated guest list as an empty list.
 * @param {unknown} value @param {unknown} proposed
 * @returns {{ known: boolean, added: Attendee[], removed: Attendee[], kept: Attendee[], proposed: Attendee[] }} */
export function attendeeChanges(value, proposed) {
  const current = object(value);
  const next = unique(Array.isArray(proposed) ? proposed.filter(p => typeof p === 'string' && p.trim()).map(email => ({ email })) : []);
  const unavailable = { known: false, added: [], removed: [], kept: [], proposed: [...next.values()] };
  if (!Array.isArray(proposed) || proposed.some(p => typeof p !== 'string' || !p.trim()) || !Array.isArray(current.attendees) || current.attendeesOmitted === true) return unavailable;
  const guests = current.attendees.map(attendee);
  if (guests.some(g => !g)) return unavailable;
  const before = unique(/** @type {Attendee[]} */ (guests));
  return {
    known: true,
    added: [...next].filter(([key]) => !before.has(key)).map(([, value]) => value),
    removed: [...before].filter(([key]) => !next.has(key)).map(([, value]) => value),
    kept: [...before].filter(([key]) => next.has(key)).map(([, value]) => value),
    proposed: [...next.values()],
  };
}

/** @param {unknown} value */
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
/** Convert Google's exclusive end to days people actually see, using UTC only
 * for arithmetic on date-only values (never a browser timezone).
 * @param {unknown} start @param {unknown} end */
export function allDayRange(start, end) {
  const first = dateOnly(start), exclusive = dateOnly(end);
  if (first === null || exclusive === null || exclusive <= first) return null;
  return { start: /** @type {string} */ (start), last: new Date(exclusive - 86_400_000).toISOString().slice(0, 10), days: (exclusive - first) / 86_400_000 };
}

/** Explicit consent only. Older submissions have no checkbox and default off.
 * @param {unknown} value */
export function approvalChoice(value) {
  const data = object(value);
  const approved = data.approved === true;
  return { approved, notifyAttendees: approved && data.notifyAttendees === true };
}
