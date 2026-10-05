const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';

function safeFailure(response, operation) {
  const error = new Error(`${operation} failed (${response.status})`);
  error.status = response.status;
  if (response.status === 401) error.code = 'reauthentication_required';
  return error;
}
function putParams(url, values) {
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  return url;
}
const segment = value => encodeURIComponent(value);

export function createGoogleAdapter({ store, getClient, fetchImpl = fetch, clock = () => Date.now() }) {
  async function token(fields) {
    let response;
    try { response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); }
    catch { throw new Error('Google authorization is temporarily unavailable'); }
    if (!response.ok) {
      const error = safeFailure(response, 'Google authorization');
      if (response.status === 400 || response.status === 401) error.code = 'invalid_grant';
      throw error;
    }
    return response.json();
  }
  async function userInfo(accessToken) {
    const response = await fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw safeFailure(response, 'Google identity');
    const info = await response.json();
    if (!info.sub || info.email_verified !== true || !info.email) throw new Error('Google account identity is unverified');
    return info;
  }
  async function access(record, force = false) {
    const current = await store.bySubject(record.subject);
    if (!current) throw Object.assign(new Error('Google account was removed; reconnect it'), { code: 'reauthentication_required' });
    if (!force && current.accessToken && current.expiresAt > clock() + 60_000) return current.accessToken;
    const { clientId, clientSecret } = await getClient();
    if (!clientId || !clientSecret) throw new Error('Configure the Google Web OAuth client first');
    const next = await token({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: clientId, client_secret: clientSecret });
    if (!next.access_token) throw new Error('Google returned no access token');
    const saved = await store.mergeToken(current.subject, current.refreshToken, { accessToken: next.access_token, expiresAt: clock() + (Number(next.expires_in) || 3600) * 1000, refreshToken: next.refresh_token });
    if (!saved) throw Object.assign(new Error('Google account changed during refresh; try again'), { code: 'reauthentication_required' });
    return next.access_token;
  }
  async function verifiedAccess(record, force = false) {
    let accessToken = await access(record, force);
    let info;
    try { info = await userInfo(accessToken); }
    catch (error) {
      if (force || error.status !== 401) throw error;
      accessToken = await access(record, true);
      info = await userInfo(accessToken);
    }
    if (info.sub !== record.subject) throw Object.assign(new Error('Google account identity changed; reconnect it'), { code: 'reauthentication_required' });
    if (info.email !== record.email) await store.updateEmail(record.subject, info.email);
    return accessToken;
  }
  async function request(record, path, { method = 'GET', query = {}, body } = {}) {
    const url = putParams(new URL(`${CALENDAR_URL}${path}`), query);
    const accessToken = await verifiedAccess(record);
    let response;
    try {
      response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${accessToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Google Calendar is temporarily unavailable; check before retrying a write'); }
    // A rejected read may refresh and retry. Never retry an uncertain mutation.
    if (response.status === 401 && method === 'GET') {
      const refreshed = await verifiedAccess(record, true);
      response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${refreshed}` } });
    }
    if (!response.ok) throw safeFailure(response, 'Google Calendar request');
    if (response.status === 204) return {};
    return response.json();
  }
  return {
    oauth: {
      authorizeUrl({ clientId, redirectUri, state, challenge, scopes }) {
        return putParams(new URL(AUTH_URL), {
          client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
          access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
          code_challenge: challenge, code_challenge_method: 'S256',
        }).toString();
      },
      exchange({ code, verifier, clientId, clientSecret, redirectUri }) {
        return token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
      },
      identity: userInfo,
    },
    calendar: {
      async identity(record) {
        let accessToken = await access(record);
        try { return await userInfo(accessToken); }
        catch (error) {
          if (error.status !== 401) throw error;
          accessToken = await access(record, true);
          return userInfo(accessToken);
        }
      },
      async listCalendars(record, { pageToken }) {
        const result = await request(record, '/users/me/calendarList', { query: { maxResults: 250, pageToken } });
        return { items: result.items || [], nextPageToken: result.nextPageToken };
      },
      async listEvents(record, calendarId, opts) {
        const result = await request(record, `/calendars/${segment(calendarId)}/events`, { query: opts });
        return { items: result.items || [], nextPageToken: result.nextPageToken };
      },
      getEvent(record, calendarId, eventId) { return request(record, `/calendars/${segment(calendarId)}/events/${segment(eventId)}`); },
      insertEvent(record, calendarId, body, sendUpdates) { return request(record, `/calendars/${segment(calendarId)}/events`, { method: 'POST', query: { sendUpdates }, body }); },
      patchEvent(record, calendarId, eventId, body, sendUpdates) { return request(record, `/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { method: 'PATCH', query: { sendUpdates }, body }); },
      moveEvent(record, calendarId, eventId, destination, sendUpdates) { return request(record, `/calendars/${segment(calendarId)}/events/${segment(eventId)}/move`, { method: 'POST', query: { destination, sendUpdates } }); },
      deleteEvent(record, calendarId, eventId, sendUpdates) { return request(record, `/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { method: 'DELETE', query: { sendUpdates } }); },
      async freeBusy(record, { timeMin, timeMax, calendarIds, timeZone }) {
        const result = await request(record, '/freeBusy', { method: 'POST', body: { timeMin, timeMax, ...(timeZone ? { timeZone } : {}), items: calendarIds.map(id => ({ id })) } });
        return result.calendars || {};
      },
    },
  };
}
