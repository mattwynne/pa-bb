import { useState } from 'react';
import { ConnectionAlert, ConnectionButton, ConnectionDisclosure } from './connection-ui.js';
import { allDayRange, attendeeChanges, deletionScope } from './approval-model.mjs';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';

export function notificationConsequence(value: unknown) {
  switch (value ?? 'none') {
    case 'all': return 'All attendees will be notified.';
    case 'externalOnly': return 'Only attendees who do not use Google Calendar will be notified.';
    case 'none': return 'Attendee notifications are not requested. Google may still send some emails; changes may not sync to external calendars.';
    default: return 'Notification setting is unknown. Check Technical details before approving.';
  }
}

// Never format in the reviewer's browser timezone. Without a verified IANA
// zone, keep the supplied datetime and UTC offset intact.
export function formatEventTime(value: unknown, zone?: unknown) {
  const raw = text(value);
  if (!raw) return 'Not available';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} (all day)`;
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? `${raw} (${text(zone) || 'timezone not supplied'})` : raw;
  }
  const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(Date.parse(raw)) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.slice(0, 10)) return raw;
  if (text(zone)) {
    try {
      return `${new Intl.DateTimeFormat('en', { timeZone: text(zone), year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(raw))} (${text(zone)})`;
    } catch { /* Preserve the exact value if the zone is not usable. */ }
  }
  return `${raw}${text(zone) ? ` (timezone: ${text(zone)}; could not format)` : ' (supplied timezone/offset)'}`;
}

function TimeRange({ start, end, zone }: { start: unknown; end: unknown; zone?: unknown }) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(text(start));
  return <dl className="pa-calendar__time-range">
    <div><dt>Start</dt><dd>{formatEventTime(start, zone)}</dd></div>
    <div><dt>{allDay ? 'End (exclusive)' : 'End'}</dt><dd>{formatEventTime(end, zone)}</dd></div>
  </dl>;
}

function calendarDate(value: string, month: 'short' | 'long' = 'short') {
  return new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...(month === 'short' ? { weekday: 'short', year: 'numeric' } as const : {}), month, day: 'numeric' }).format(new Date(`${value}T00:00:00Z`));
}

function EventWhen({ start, end, zone }: { start: unknown; end: unknown; zone?: unknown }) {
  const days = allDayRange(start, end);
  if (days) return <p className="pa-calendar__event-when">{calendarDate(days.start)}{days.days > 1 ? ` – ${calendarDate(days.last)}` : ''} · All day</p>;
  // Compact only when both instants and the timezone can be verified. Otherwise
  // TimeRange preserves the supplied offsets rather than using the browser zone.
  const first = text(start), last = text(end), timeZone = text(zone);
  const validInstant = (raw: string) => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(raw) && Number.isFinite(Date.parse(raw)) && new Date(`${raw.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === raw.slice(0, 10);
  if (timeZone && validInstant(first) && validInstant(last)) {
    try {
      const date = new Intl.DateTimeFormat('en', { timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
      const time = new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      const from = new Date(first), to = new Date(last), sameDay = date.format(from) === date.format(to);
      return <p className="pa-calendar__event-when">{date.format(from)} · {time.format(from)} – {sameDay ? '' : `${date.format(to)} · `}{time.format(to)}<br />{timeZone}</p>;
    } catch { /* Keep unformatted dates if the zone is unusable. */ }
  }
  return <div className="pa-calendar__event-when"><TimeRange start={start} end={end} zone={zone} /></div>;
}

type Guest = { email: string; displayName?: string };
function AttendeeRow({ guest, change }: { guest: Guest; change: 'add' | 'remove' | 'keep' }) {
  const identity = <>{guest.displayName && <span className="pa-calendar__guest-name">{guest.displayName}</span>}<span className={guest.displayName ? 'pa-calendar__guest-email' : 'pa-calendar__guest-name'}>{guest.email}</span></>;
  return <li className={`pa-calendar__guest pa-calendar__guest--${change}`} data-change={change}>
    <span className="pa-calendar__guest-icon" aria-hidden="true">{{ add: '+', remove: '−', keep: '✓' }[change]}</span>
    {change === 'remove' ? <s className="pa-calendar__guest-identity">{identity}</s> : <span className="pa-calendar__guest-identity">{identity}</span>}
    <span className="pa-calendar__guest-change">{{ add: 'Add', remove: 'Remove', keep: 'Keep' }[change]}</span>
  </li>;
}

export function Approval({ interaction, submit }: {
  interaction: { payload: unknown };
  submit(value: { approved: boolean }): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const p = object(interaction.payload);
  let proposed = object(p.proposed);
  // Pending interactions persisted before this renderer update only have JSON.
  if (!Object.keys(proposed).length && typeof p.details === 'string') {
    try { proposed = object(JSON.parse(p.details)); } catch { /* Raw proposal remains available below. */ }
  }
  const context = object(p.context);
  const current = object(context.currentEvent);
  const currentStart = object(current.start);
  const currentEnd = object(current.end);
  const updating = p.operation === 'update';
  const creating = p.operation === 'create';
  const deleting = p.operation === 'delete';
  const title = text(current.summary) || (creating ? text(proposed.summary) || text(p.summary) : '');
  const rescheduling = proposed.start !== undefined || proposed.end !== undefined;
  const scope = deletionScope(current);
  const guests = attendeeChanges(current, proposed.attendees);
  const reviewingGuests = updating && Array.isArray(proposed.attendees);
  const days = creating ? allDayRange(proposed.start, proposed.end) : null;
  const hasCurrentTime = Boolean(currentStart.dateTime || currentStart.date || currentEnd.dateTime || currentEnd.date);
  const primaryLabel = deleting ? { occurrence: 'Delete occurrence', series: 'Delete series', event: 'Delete event', unknown: 'Delete event' }[scope]
    : creating ? 'Create event' : reviewingGuests && !rescheduling && !proposed.moveToCalendarId && !['summary', 'location', 'description'].some(field => proposed[field] !== undefined) ? 'Update attendees' : 'Approve change';
  const currentZone = currentStart.timeZone || currentEnd.timeZone;
  // A patch without a zone leaves the event's existing zone in place.
  const proposedZone = proposed.timeZone || currentZone;
  const fields = ['summary', 'location', 'description'] as const;

  async function decide(approved: boolean) {
    setBusy(true); setError('');
    try { await submit({ approved }); }
    catch { setError('Could not submit your choice. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="pa-calendar pa-calendar__approval" role="group" aria-label="Review Google Calendar change" aria-busy={busy}>
    <p className="pa-calendar__event-title">{title || 'Event title unavailable'}</p>
    {!creating && !Object.keys(current).length && <p className="pa-calendar__context-note">Current event information is unavailable. Only proposed values are shown; check the event in Google Calendar if needed.</p>}
    {(deleting || (reviewingGuests && !rescheduling)) && hasCurrentTime && <EventWhen start={currentStart.dateTime || currentStart.date} end={currentEnd.dateTime || currentEnd.date} zone={currentZone} />}
    {creating && rescheduling && <EventWhen start={proposed.start} end={proposed.end} zone={proposedZone} />}
    {days && <div className="pa-calendar__effect"><p className="pa-calendar__effect-title">{days.days === 1 ? 'Create a one-day event' : 'Create an all-day event'}</p>
      <p>{days.days === 1 ? `This event covers ${calendarDate(days.start, 'long')} only.` : 'The dates above include every day this event covers.'}</p></div>}
    {!creating && rescheduling && <div className="pa-calendar__change">
      {updating && Boolean(currentStart.dateTime || currentStart.date || currentEnd.dateTime || currentEnd.date) && <div className="pa-calendar__change-value pa-calendar__change-value--current"><h4>Current time</h4><TimeRange start={currentStart.dateTime || currentStart.date} end={currentEnd.dateTime || currentEnd.date} zone={currentZone} /></div>}
      <div className="pa-calendar__change-value pa-calendar__change-value--proposed"><h4>Proposed time</h4><TimeRange start={proposed.start} end={proposed.end} zone={proposedZone} /></div>
    </div>}
    {fields.filter(field => proposed[field] !== undefined && (updating || field !== 'summary')).map(field => <div className="pa-calendar__change" key={field}>
      <div className="pa-calendar__change-value"><h4>{field === 'summary' ? 'Title' : field === 'location' ? 'Location' : 'Description'}</h4>
        {typeof current[field] === 'string' && <p><span className="pa-calendar__value-label">Current: </span>{text(current[field]) || '(empty)'}</p>}
        <p><span className="pa-calendar__value-label">Proposed: </span>{text(proposed[field]) || '(empty)'}</p>
      </div>
    </div>)}
    {proposed.moveToCalendarId !== undefined && <p className="pa-calendar__move">Move to calendar: <strong>{text(context.destinationCalendarName) || 'Name unavailable — see Destination calendar ID in Technical details'}</strong></p>}
    {deleting && <div className="pa-calendar__effect">
      <p className="pa-calendar__effect-title">{{ occurrence: 'Delete only this occurrence', series: 'Delete the entire series', event: 'This will delete the event.', unknown: 'Deletion scope could not be verified' }[scope]}</p>
      {scope === 'occurrence' && <p>The rest of this recurring event will stay unchanged.</p>}
      {scope === 'series' && <p>This deletes the entire recurring series, not just the occurrence shown above.</p>}
      {scope === 'unknown' && <p>Check the event in Google Calendar before approving. The event ID is in Technical details.</p>}
    </div>}
    {reviewingGuests && (guests.known ? <>
      <ul className="pa-calendar__guests" aria-label="Attendee changes">
        {guests.added.map(guest => <AttendeeRow key={`add:${guest.email}`} guest={guest} change="add" />)}
        {guests.removed.map(guest => <AttendeeRow key={`remove:${guest.email}`} guest={guest} change="remove" />)}
        {guests.kept.map(guest => <AttendeeRow key={`keep:${guest.email}`} guest={guest} change="keep" />)}
      </ul>
      <p className="pa-calendar__guest-note">{guests.proposed.length ? 'This replaces the current attendee list.' : 'No attendees will remain.'}{!rescheduling ? ' The event time stays unchanged.' : ''}</p>
    </> : <>
      <p className="pa-calendar__guest-note">Current attendee list is unavailable or incomplete. This replaces the current attendee list; check the event in Google Calendar before approving.</p>
      <p className="pa-calendar__guest-note">Proposed attendees: {guests.proposed.map(guest => guest.email).join(', ') || 'None'}</p>
    </>)}
    {!Object.keys(proposed).length && <p>Proposed values could not be displayed. Review Technical details before approving.</p>}
    <dl className="pa-calendar__approval-summary">
      <div><dt>Account</dt><dd>{text(p.account) || 'Unavailable'}</dd></div>
      <div><dt>Calendar</dt><dd>{text(context.calendarName) || 'Name unavailable — see Calendar ID in Technical details'}</dd></div>
      {creating && <div><dt>Attendees</dt><dd>{Array.isArray(proposed.attendees) ? proposed.attendees.filter(a => typeof a === 'string').join(', ') || 'None' : 'None'}</dd></div>}
    </dl>
    <p className="pa-calendar__notifications">{creating && (!Array.isArray(proposed.attendees) || !proposed.attendees.length) && (proposed.sendUpdates ?? p.sendUpdates ?? 'none') === 'none' ? 'No attendee notifications are requested.' : notificationConsequence(proposed.sendUpdates ?? p.sendUpdates)}</p>
    <ConnectionDisclosure summary="Technical details">
      <dl className="pa-calendar__approval-summary">
        <div><dt>Calendar ID</dt><dd>{text(p.calendarId) || text(proposed.calendarId) || 'Unavailable'}</dd></div>
        {text(p.eventId || proposed.eventId) && <div><dt>Event ID</dt><dd>{text(p.eventId || proposed.eventId)}</dd></div>}
        {text(proposed.moveToCalendarId) && <div><dt>Destination calendar ID</dt><dd>{text(proposed.moveToCalendarId)}</dd></div>}
      </dl>
      <pre className="pa-calendar__proposal">{typeof p.details === 'string' ? p.details : JSON.stringify(proposed, null, 2)}</pre>
    </ConnectionDisclosure>
    {error && <ConnectionAlert>{error}</ConnectionAlert>}
    <div className="pa-calendar__approval-actions">
      <ConnectionButton tone="primary" className={deleting ? 'pa-calendar__delete-button' : ''} disabled={busy} onClick={() => void decide(true)}>{primaryLabel}</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline change</ConnectionButton>
    </div>
    {/* Host cancellation and a submitted refusal both resume this plugin's tool
        without approval. One explicit refusal avoids two redundant choices. */}
    <p className="pa-calendar__context-note">{creating ? 'Declining creates nothing.' : 'Declining leaves the event unchanged.'}</p>
    {!creating && Object.keys(current).length > 0 && <p className="pa-calendar__context-note">Event details were read from Google Calendar for this review; they may change before approval.</p>}
  </div>;
}
