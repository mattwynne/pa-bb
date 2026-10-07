import { createHash, randomBytes } from 'node:crypto';

export const SCOPES = Object.freeze([
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
]);
const MAX_RESULTS = 2500;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 5 * 60 * 1000;
const safeCode = (error, fallback) =>
  error?.code === 'invalid_grant' || error?.status === 401 || error?.code === 'reauthentication_required'
    ? 'reauthentication_required' : fallback;
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
};
const limit = (value, fallback = 100) => value === undefined ? fallback : Math.max(1, Math.min(MAX_RESULTS, Math.trunc(Number(value)) || 1));
const utc = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value || '';
};
const occurrence = (event) => event.originalStartTime?.dateTime || event.originalStartTime?.date || event.start?.dateTime || event.start?.date || '';
const keyFor = (event, calendarId) => {
  const start = utc(occurrence(event));
  return event.iCalUID ? `uid:${event.iCalUID}:${start}` : `event:${calendarId}:${event.id}:${start}`;
};
const source = (account, calendarId, summary, eventId) => ({ account, calendarId, calendarSummary: summary || calendarId, eventId });
const nextDate = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid all-day start date');
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
};

// Ports: store (accounts/pending grants), oauth (Web authorization), calendar (provider calls),
// approve (a real BB user interaction), and clock. No BB or Google SDK types enter this core.
export function createCalendarService({ store, oauth, calendar, approve = async (_proposal) => false, diagnose = /** @type {(stage: string, error: unknown) => void} */ (() => {}), clock = () => Date.now() }) {
  async function account(email) {
    const record = await store.byEmail(required(email, 'account'));
    if (!record) throw new Error(`Unknown Google account: ${email}`);
    return record;
  }
  async function accounts() {
    return (await store.accounts()).map(({ subject, email }) => ({ subject, email }));
  }
  async function beginConnect({ clientId, redirectUri }) {
    required(clientId, 'OAuth client ID');
    required(redirectUri, 'OAuth redirect URI');
    if (!redirectUri.startsWith('https://')) throw new Error('OAuth redirect URI must use HTTPS');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await store.savePending({ stateHash: createHash('sha256').update(state).digest('hex'), verifier, redirectUri, clientId, expiresAt: clock() + STATE_MS });
    return { url: oauth.authorizeUrl({ clientId, redirectUri, state, challenge, scopes: SCOPES }), expiresAt: clock() + STATE_MS };
  }
  async function finishConnect({ state, code, error, clientId, clientSecret, redirectUri }) {
    if (!state || !code || error) throw new Error('Google authorization was cancelled or incomplete');
    // Consume before exchanging, so an error or concurrent callback cannot replay the grant.
    const pending = await store.consumePending(createHash('sha256').update(state).digest('hex'));
    if (!pending || pending.expiresAt <= clock() || pending.redirectUri !== redirectUri || pending.clientId !== clientId) throw new Error('Google authorization has expired or is invalid');
    const tokens = await oauth.exchange({ code, verifier: pending.verifier, clientId, clientSecret, redirectUri });
    if (!tokens?.refresh_token) throw new Error('Google did not provide a refresh token; reconnect with consent');
    const granted = new Set((tokens.scope || '').split(/\s+/));
    // Google may normalize `email` to its userinfo.email scope (or omit the
    // literal alias). Verify email and subject via the userinfo response below;
    // never relax the three Calendar permissions or openid.
    const missing = SCOPES.filter(scope => scope !== 'email' && !granted.has(scope));
    if (missing.length) {
      const failure = new Error('Google did not grant all required Calendar scopes');
      failure.missingScopes = missing; // only our fixed, public scope names; never the provider response
      throw failure;
    }
    const identity = await oauth.identity(tokens.access_token);
    if (!identity?.sub || identity.email_verified !== true || !identity.email) throw new Error('Google did not verify the account identity');
    await store.addAccount({ subject: identity.sub, email: identity.email, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000 });
    return { subject: identity.sub, email: identity.email };
  }
  async function removeAccount(subject) {
    return store.removeAccount(required(subject, 'subject'));
  }
  async function authStatus() {
    const result = [];
    for (const record of await store.accounts()) {
      let status = 'Connected';
      try {
        const verified = await calendar.identity(record);
        if (verified?.sub !== record.subject) throw Object.assign(new Error('Mismatched identity'), { code: 'reauthentication_required' });
        if (verified?.email && verified.email !== record.email) await store.updateEmail(record.subject, verified.email);
      } catch (e) {
        status = safeCode(e, 'transient') === 'reauthentication_required' ? 'Re-authentication required' : 'Connection unavailable';
        diagnose('identity_lookup', e);
      }
      result.push({ subject: record.subject, email: (await store.bySubject(record.subject))?.email || record.email, status });
    }
    return { accounts: result };
  }
  async function discover(record) {
    const calendars = [];
    const seen = new Set();
    let pageToken;
    do {
      const page = await calendar.listCalendars(record, { pageToken });
      calendars.push(...(page.items || []));
      pageToken = page.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('Repeated calendar page token');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return calendars;
  }
  async function listCalendars() {
    const results = await Promise.all((await store.accounts()).map(async record => {
      try { return { account: record.email, calendars: await discover(record) }; }
      catch (error) {
        diagnose('calendar_discovery', error);
        return { account: record.email, calendars: [], error: { code: safeCode(error, 'calendar_list_failed') } };
      }
    }));
    return { accounts: results };
  }
  async function pages(record, calendarId, options, max = Infinity) {
    const events = [];
    const seen = new Set();
    let pageToken;
    do {
      const page = await calendar.listEvents(record, calendarId, { ...options, pageToken, maxResults: Math.min(MAX_RESULTS, Math.max(1, max - events.length)) });
      events.push(...(page.items || []));
      pageToken = page.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new Error('Repeated event page token');
      if (pageToken) seen.add(pageToken);
    } while (pageToken && events.length < max);
    return events.slice(0, max);
  }
  async function listEvents(args) {
    const record = await account(args.account);
    const calendarId = required(args.calendarId, 'calendarId');
    const timeMin = args.timeMin || new Date(clock()).toISOString();
    const timeMax = args.timeMax || new Date(clock() + MONTH_MS).toISOString();
    const singleEvents = args.singleEvents !== false;
    const events = await pages(record, calendarId, { timeMin, timeMax, singleEvents, ...(singleEvents ? { orderBy: 'startTime' } : {}), q: args.q, timeZone: args.timeZone }, limit(args.maxResults));
    return { account: record.email, calendarId, count: events.length, events };
  }
  async function getEvent(args) {
    const record = await account(args.account);
    const calendarId = required(args.calendarId, 'calendarId');
    return { account: record.email, calendarId, event: await calendar.getEvent(record, calendarId, required(args.eventId, 'eventId')) };
  }
  async function freeBusy(args) {
    const record = await account(args.account);
    if (!Array.isArray(args.calendarIds) || !args.calendarIds.length) throw new Error('calendarIds is required');
    return { account: record.email, calendars: await calendar.freeBusy(record, { timeMin: required(args.timeMin, 'timeMin'), timeMax: required(args.timeMax, 'timeMax'), calendarIds: args.calendarIds, timeZone: args.timeZone }) };
  }
  async function searchEvents(args) {
    required(args.timeMin, 'timeMin'); required(args.timeMax, 'timeMax');
    const selectedAccounts = args.targets?.length ? [] : args.accounts?.length ? await Promise.all(args.accounts.map(account)) : await store.accounts();
    const failures = [];
    const targets = [];
    if (args.targets?.length) {
      for (const target of args.targets) targets.push({ record: await account(target.account), id: required(target.calendarId, 'calendarId'), summary: target.calendarId });
    } else {
      for (const record of selectedAccounts) {
        try {
          for (const c of await discover(record)) {
            if (args.calendarSelection === 'all' || (args.calendarSelection === 'primary' ? c.primary : c.primary || c.selected)) targets.push({ record, id: c.id, summary: c.summary });
          }
        } catch (e) {
          diagnose('search_discovery', e);
          failures.push({ account: record.email, code: safeCode(e, 'calendar_list_failed') });
        }
      }
    }
    // Shared calendar IDs are queried once, with another account as fallback on failure.
    const groups = new Map();
    for (const target of targets) {
      if (!groups.has(target.id)) groups.set(target.id, []);
      if (!groups.get(target.id).some(x => x.record.subject === target.record.subject)) groups.get(target.id).push(target);
    }
    const work = [...groups.values()];
    const collected = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, work.length) }, async () => {
      while (cursor < work.length) {
        const group = work[cursor++];
        let found = false;
        for (const target of group) {
          try {
            const events = await pages(target.record, target.id, { timeMin: args.timeMin, timeMax: args.timeMax, singleEvents: true, orderBy: 'startTime', q: args.q, timeZone: args.timeZone });
            for (const event of events) collected.push({ event, calendarId: target.id, sources: group.map(t => source(t.record.email, t.id, t.summary, event.id)) });
            found = true;
            break;
          } catch (e) {
            diagnose('search_events', e);
            if (target === group.at(-1)) failures.push({ account: target.record.email, calendarId: target.id, code: safeCode(e, 'event_list_failed') });
          }
        }
        if (!found) continue;
      }
    }));
    const merged = new Map();
    for (const item of collected) {
      const key = keyFor(item.event, item.calendarId);
      if (!merged.has(key)) merged.set(key, { ...item.event, sources: [] });
      const sources = merged.get(key).sources;
      for (const entry of item.sources) if (!sources.some(s => s.account === entry.account && s.calendarId === entry.calendarId)) sources.push(entry);
    }
    const sorted = [...merged.values()].sort((a, b) => utc(occurrence(a)).localeCompare(utc(occurrence(b))) || String(a.id).localeCompare(String(b.id)));
    const max = limit(args.maxResults);
    return { events: sorted.slice(0, max), count: Math.min(sorted.length, max), truncated: sorted.length > max, failures };
  }
  async function approval(operation, args, record) {
    // Context is a read-only snapshot, not a precondition or a second consent gate.
    // Missing context must never suppress the proposal or imply an old value.
    let context;
    if (operation === 'update') {
      context = { currentEvent: null, calendarName: null, destinationCalendarName: null };
      try {
        const event = await calendar.getEvent(record, args.calendarId, args.eventId);
        if (event && typeof event === 'object') {
          context.currentEvent = {};
          for (const field of ['summary', 'start', 'end', 'location', 'description']) {
            if (event[field] !== undefined) context.currentEvent[field] = event[field];
          }
        }
      } catch (error) { diagnose('approval_event_read', error); }
      try {
        const calendars = await discover(record);
        const name = id => {
          const entry = calendars.find(c => c.id === id || (id === 'primary' && c.primary));
          return typeof entry?.summaryOverride === 'string' && entry.summaryOverride.trim() ? entry.summaryOverride
            : typeof entry?.summary === 'string' && entry.summary.trim() ? entry.summary : null;
        };
        context.calendarName = name(args.calendarId);
        if (args.moveToCalendarId) context.destinationCalendarName = name(args.moveToCalendarId);
      } catch (error) { diagnose('approval_calendar_read', error); }
    }
    const allowed = await approve({ operation, account: record?.email || args.account, calendarId: args.calendarId, details: args, ...(context ? { context } : {}) });
    if (allowed !== true) throw new Error('Calendar change was not approved');
  }
  async function createEvent(args) {
    const record = await account(args.account);
    const calendarId = required(args.calendarId, 'calendarId');
    const summary = required(args.summary, 'summary');
    const start = required(args.start, 'start');
    if (!args.allDay && !args.end) throw new Error('An end datetime is required for non-all-day events');
    const event = { summary, ...(args.description !== undefined ? { description: args.description } : {}), ...(args.location !== undefined ? { location: args.location } : {}),
      start: args.allDay ? { date: start } : { dateTime: start, ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
      end: args.allDay ? { date: args.end || nextDate(start) } : { dateTime: args.end, ...(args.timeZone ? { timeZone: args.timeZone } : {}) },
      ...(args.attendees ? { attendees: args.attendees.map(email => ({ email })) } : {}) };
    await approval('create', args);
    return { account: record.email, calendarId, event: await calendar.insertEvent(record, calendarId, event, args.sendUpdates || 'none') };
  }
  async function updateEvent(args) {
    const record = await account(args.account);
    const calendarId = required(args.calendarId, 'calendarId');
    let eventId = required(args.eventId, 'eventId');
    if ((args.start === undefined) !== (args.end === undefined)) throw new Error('Rescheduling requires both start and end');
    const patch = {};
    for (const field of ['summary', 'description', 'location', 'attendees']) {
      if (args[field] !== undefined) patch[field] = field === 'attendees' ? args[field].map(email => ({ email })) : args[field];
    }
    if (args.start !== undefined) {
      const allDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start) && /^\d{4}-\d{2}-\d{2}$/.test(args.end);
      patch.start = allDay ? { date: args.start } : { dateTime: args.start, ...(args.timeZone ? { timeZone: args.timeZone } : {}) };
      patch.end = allDay ? { date: args.end } : { dateTime: args.end, ...(args.timeZone ? { timeZone: args.timeZone } : {}) };
    }
    if (!Object.keys(patch).length && !args.moveToCalendarId) throw new Error('No event changes requested');
    await approval('update', args, record);
    const notify = args.sendUpdates || 'none';
    let destination = calendarId;
    let event;
    if (args.moveToCalendarId) {
      destination = args.moveToCalendarId;
      event = await calendar.moveEvent(record, calendarId, eventId, destination, Object.keys(patch).length ? 'none' : notify);
      eventId = event.id || eventId;
    }
    if (Object.keys(patch).length) event = await calendar.patchEvent(record, destination, eventId, patch, notify);
    return { account: record.email, calendarId: destination, event };
  }
  async function deleteEvent(args) {
    const record = await account(args.account);
    const calendarId = required(args.calendarId, 'calendarId');
    const eventId = required(args.eventId, 'eventId');
    await approval('delete', args);
    await calendar.deleteEvent(record, calendarId, eventId, args.sendUpdates || 'none');
    return { account: record.email, calendarId, eventId, deleted: true };
  }
  const tools = { gcal_auth_status: authStatus, gcal_list_calendars: listCalendars, gcal_list_events: listEvents,
    gcal_search_events: searchEvents, gcal_get_event: getEvent, gcal_create_event: createEvent,
    gcal_update_event: updateEvent, gcal_delete_event: deleteEvent, gcal_free_busy: freeBusy };
  async function execute(name, args = {}) {
    if (!Object.hasOwn(tools, name)) throw new Error('Unknown Calendar tool');
    return tools[name](args);
  }
  return { accounts, beginConnect, finishConnect, removeAccount, execute, ...tools };
}
