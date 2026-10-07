import { useState } from 'react';
import { ConnectionAlert, ConnectionButton, ConnectionDisclosure } from './connection-ui.js';

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
  const title = text(current.summary) || (!updating ? text(proposed.summary) || text(p.summary) : '');
  const rescheduling = proposed.start !== undefined || proposed.end !== undefined;
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
    {updating && <p className="pa-calendar__context-note">{Object.keys(current).length ? 'Current values were read from Google Calendar for this review; they may change before approval.' : 'Current event information is unavailable. Only proposed values are shown; check the event in Google Calendar if needed.'}</p>}
    {rescheduling && <div className="pa-calendar__change">
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
    {p.operation === 'delete' && <p>This will delete the event.</p>}
    {Array.isArray(proposed.attendees) && <p>Attendees: {proposed.attendees.filter(a => typeof a === 'string').join(', ') || 'None'}</p>}
    {!Object.keys(proposed).length && <p>Proposed values could not be displayed. Review Technical details before approving.</p>}
    <dl className="pa-calendar__approval-summary">
      <div><dt>Account</dt><dd>{text(p.account) || 'Unavailable'}</dd></div>
      <div><dt>Calendar</dt><dd>{text(context.calendarName) || 'Name unavailable — see Calendar ID in Technical details'}</dd></div>
    </dl>
    <p className="pa-calendar__notifications">{notificationConsequence(proposed.sendUpdates ?? p.sendUpdates)}</p>
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
      <ConnectionButton tone="primary" disabled={busy} onClick={() => void decide(true)}>Approve change</ConnectionButton>
      <ConnectionButton tone="secondary" disabled={busy} onClick={() => void decide(false)}>Decline change</ConnectionButton>
    </div>
    {/* Host cancellation and a submitted refusal both resume this plugin's tool
        without approval. One explicit refusal avoids two redundant choices. */}
    <p className="pa-calendar__context-note">Declining leaves the event unchanged.</p>
  </div>;
}
