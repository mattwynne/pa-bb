import assert from 'node:assert/strict';
import { Before, Given, When, Then } from '@cucumber/cucumber';
import { createCalendarService, SCOPES } from '../../core/service.mjs';
import { createMemoryStore } from '../../core/memory-store.mjs';

const split = text => text.split(',').map(s => s.trim());
Before(function () {
  this.now = Date.parse('2026-01-01T00:00:00Z');
  this.store = createMemoryStore();
  this.calls = [];
  this.calendars = new Map();
  this.eventPages = new Map();
  this.discoverErrors = new Map();
  this.eventErrors = new Map();
  this.deny = false;
  this.revocations = 0;
  this.oauth = {
    authorizeUrl: ({ clientId, redirectUri, state, challenge, scopes }) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: scopes.join(' ') })) url.searchParams.set(k, v);
      return url.toString();
    },
    exchange: async () => this.exchangeResponse || { access_token: 'test-access', refresh_token: 'test-refresh', scope: SCOPES.join(' '), expires_in: 3600 },
    identity: async () => this.identityResponse || { sub: 'subject-a', email: 'alice@example.com', email_verified: true },
  };
  this.google = {
    identity: async record => ({ sub: record.subject, email: record.email }),
    listCalendars: async (record, opts) => {
      this.calls.push({ kind: 'listCalendars', account: record.email, opts });
      if (this.discoverErrors.has(record.email)) throw this.discoverErrors.get(record.email);
      return { items: this.calendars.get(record.email) || [] };
    },
    listEvents: async (record, calendarId, opts) => {
      this.calls.push({ kind: 'listEvents', account: record.email, calendarId, opts });
      const key = `${record.email}/${calendarId}`;
      if (this.eventErrors.has(key)) throw this.eventErrors.get(key);
      const pages = this.eventPages.get(key) || [[]];
      const index = Number(opts.pageToken || 0);
      return { items: pages[index] || [], nextPageToken: pages[index + 1] ? String(index + 1) : undefined };
    },
    getEvent: async (record, calendarId, eventId) => { this.calls.push({ kind: 'get', account: record.email, calendarId, eventId }); return { id: eventId }; },
    freeBusy: async (record, args) => { this.calls.push({ kind: 'freeBusy', account: record.email, ...args }); return Object.fromEntries(args.calendarIds.map(id => [id, { busy: [] }])); },
    insertEvent: async (record, calendarId, body, sendUpdates) => { this.calls.push({ kind: 'insert', account: record.email, calendarId, body, sendUpdates }); return { ...body, id: 'new-event' }; },
    patchEvent: async (record, calendarId, eventId, body, sendUpdates) => { this.calls.push({ kind: 'patch', account: record.email, calendarId, eventId, body, sendUpdates }); return { ...body, id: eventId }; },
    moveEvent: async (record, calendarId, eventId, destination, sendUpdates) => { this.calls.push({ kind: 'move', account: record.email, calendarId, eventId, destination, sendUpdates }); return { id: eventId }; },
    deleteEvent: async (record, calendarId, eventId, sendUpdates) => { this.calls.push({ kind: 'delete', account: record.email, calendarId, eventId, sendUpdates }); },
  };
  this.service = createCalendarService({ store: this.store, oauth: this.oauth, calendar: this.google,
    approve: async proposal => { this.calls.push({ kind: 'approval', proposal }); return !this.deny; }, clock: () => this.now });
});

Given('an empty single-user Calendar installation', function () {});
Given('a Web OAuth client is configured', function () { this.client = { clientId: 'web-client-id', clientSecret: 'private-client-secret', redirectUri: 'https://bb.example/api/v1/plugins/google-calendar/http/callback' }; });
Given('I connected subject {string} as {string} with refresh token {string}', async function (subject, email, refreshToken) { await this.store.addAccount({ subject, email, refreshToken, accessToken: 'access', expiresAt: this.now + 3600000 }); });
async function begin(world) { world.authorization = await world.service.beginConnect(world.client); world.state = new URL(world.authorization.url).searchParams.get('state'); }
When('I begin connecting an account', async function () { await begin(this); });
async function connect(world, subject, email, refreshToken = 'test-refresh') {
  await begin(world);
  world.identityResponse = { sub: subject, email, email_verified: true };
  world.exchangeResponse = { access_token: 'access', refresh_token: refreshToken, scope: SCOPES.join(' '), expires_in: 3600 };
  await world.service.finishConnect({ ...world.client, state: world.state, code: 'test-code' });
}
When('I connect subject {string} as {string}', async function (subject, email) { await connect(this, subject, email); });
When('the callback has {string}', async function (problem) {
  let state = this.state, code = 'test-code', error;
  this.identityResponse = { sub: 'subject-a', email: 'alice@example.com', email_verified: true };
  this.exchangeResponse = { access_token: 'access', refresh_token: 'refresh', scope: SCOPES.join(' ') };
  if (problem === 'missing state') state = '';
  if (problem === 'mismatched state') state = 'wrong';
  if (problem === 'expired state') this.now += 301000;
  if (problem === 'missing code') code = '';
  if (problem === 'Google cancellation') error = 'access_denied';
  if (problem === 'missing refresh token') delete this.exchangeResponse.refresh_token;
  if (problem === 'unverified email') this.identityResponse.email_verified = false;
  if (problem === 'missing subject') delete this.identityResponse.sub;
  if (problem === 'missing required scopes') this.exchangeResponse.scope = 'openid email';
  try { await this.service.finishConnect({ ...this.client, state, code, error }); } catch (e) { this.failure = e; }
});
When('the callback succeeds for subject {string} as {string}', async function (subject, email) {
  this.identityResponse = { sub: subject, email, email_verified: true };
  this.exchangeResponse = { access_token: 'access', refresh_token: 'test-refresh', scope: SCOPES.join(' ') };
  try { this.result = await this.service.finishConnect({ ...this.client, state: this.state, code: 'test-code' }); } catch (e) { this.failure = e; }
});
When('the callback succeeds for subject {string} as {string} with refresh token {string}', async function (subject, email, token) {
  this.identityResponse = { sub: subject, email, email_verified: true };
  this.exchangeResponse = { access_token: 'access', refresh_token: token, scope: SCOPES.join(' ') };
  try { this.result = await this.service.finishConnect({ ...this.client, state: this.state, code: 'test-code' }); } catch (e) { this.failure = e; }
});
When('the same callback is replayed', async function () {
  try { await this.service.finishConnect({ ...this.client, state: this.state, code: 'test-code' }); } catch (e) { this.failure = e; }
});
When('I remove the account with subject {string}', async function (subject) { await this.service.removeAccount(subject); });
When('a refresh based on token {string} finishes for subject {string}', async function (token, subject) { this.merged = await this.store.mergeToken(subject, token, { accessToken: 'late-access' }); });
Then('the authorization URL contains the five required Calendar identity and API scopes', function () { assert.deepEqual(split(new URL(this.authorization.url).searchParams.get('scope').replaceAll(' ', ',')), [...SCOPES]); });
Then('the authorization has a PKCE S256 challenge and one-use state', function () { const u = new URL(this.authorization.url); assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('code_challenge')); assert.ok(u.searchParams.get('state')); });
Then('the authorization does not expose the client secret', function () { assert.ok(!this.authorization.url.includes(this.client.clientSecret)); });
Then('the connected accounts are {string}', async function (list) { assert.deepEqual((await this.service.accounts()).map(x => x.email).sort(), split(list).sort()); });
Then('no account was saved', async function () { assert.equal((await this.service.accounts()).length, 0); });
Then('the callback fails safely', function () { assert.ok(this.failure); assert.ok(!this.failure.message.includes('test-refresh')); });
Then('the replay fails safely', function () { assert.ok(this.failure); });
Then('subject {string} still has refresh token {string}', async function (subject, token) { assert.equal((await this.store.bySubject(subject)).refreshToken, token); });
Then('Google received no revocation request', function () { assert.equal(this.revocations, 0); });

Given('Google lists calendars {string} for {string}', function (ids, email) { this.calendars.set(email, split(ids).map(id => ({ id, summary: id, selected: true, primary: id === 'primary' }))); });
Given('calendar discovery fails for {string} with an authentication error', function (email) { this.discoverErrors.set(email, Object.assign(new Error('secret'), { status: 401 })); });
Given('Google returns event pages {string} for {string} on {string}', function (pages, email, calendarId) { this.eventPages.set(`${email}/${calendarId}`, pages.split('|').map(ids => split(ids).map(id => ({ id, summary: id, start: { dateTime: '2026-01-02T10:00:00Z' } })))); });
Given('Google lists primary {string}, selected {string}, and unselected {string} for {string}', function (primary, selected, hidden, email) { this.calendars.set(email, [ { id: primary, primary: true, selected: false }, { id: selected, selected: true }, { id: hidden, selected: false } ]); });
Given('Google lists primary {string} for {string}', function (id, email) { this.calendars.set(email, [{ id, primary: true }]); });
Given('Google lists primary {string} and selected {string} for {string}', function (primary, selected, email) { this.calendars.set(email, [{ id: primary, primary: true }, { id: selected, selected: true }]); });
Given('both accounts can access the shared calendar {string}', function (id) { for (const email of ['alice@example.com','bob@example.com']) this.calendars.set(email, [{ id, primary: true }]); });
Given('the same occurrence {string} appears in each account\'s {string} calendar', function (uid, id) { for (const email of ['alice@example.com','bob@example.com']) this.eventPages.set(`${email}/${id}`, [[{ id: 'e1', iCalUID: uid, start: { dateTime: '2026-01-02T10:00:00Z' } }]]); });
Given('Google has event {string} on {string} calendar {string}', function (id, email, cal) { this.eventPages.set(`${email}/${cal}`, [[{ id, start: { dateTime: '2026-01-02T10:00:00Z' } }]]); });
Given('event listing fails for {string} calendar {string}', function (email, id) { this.eventErrors.set(`${email}/${id}`, new Error('private failure secret')); });
Given('the owner denies the next Calendar change', function () { this.deny = true; });
When('I call {string} with:', async function (name, docString) { try { this.result = await this.service.execute(name, JSON.parse(docString)); } catch (e) { this.failure = e; } });
Then('calendar discovery includes {string} for {string}', async function (ids, email) { const result = await this.service.execute('gcal_list_calendars'); assert.deepEqual(result.accounts.find(x => x.account === email).calendars.map(x => x.id), split(ids)); });
Then('the result includes calendars {string} for {string}', function (ids, email) { assert.deepEqual(this.result.accounts.find(x => x.account === email).calendars.map(x => x.id), split(ids)); });
Then('the result reports {string} for {string}', function (code, email) { const item = this.result.accounts?.find(x => x.account === email)?.error || this.result.failures?.find(x => x.account === email); assert.equal(item?.code, code); });
Then('the call fails with {string}', function (message) { assert.ok(this.failure?.message.includes(message), `expected ${message}; got ${this.failure?.message}`); });
Then('Google received no Calendar requests', function () { assert.equal(this.calls.filter(c => c.kind !== 'approval').length, 0); });
Then('Google received no Calendar writes', function () { assert.equal(this.calls.filter(c => ['insert','patch','move','delete'].includes(c.kind)).length, 0); });
Then('the result has events {string}', function (ids) { assert.deepEqual(this.result.events.map(e => e.id), split(ids)); });
Then('Google received singleEvents true and orderBy {string}', function (orderBy) { assert.ok(this.calls.filter(c => c.kind === 'listEvents').every(c => c.opts.singleEvents === true && c.opts.orderBy === orderBy)); });
Then('Google searched calendar IDs {string}', function (ids) { assert.deepEqual(this.calls.filter(c => c.kind === 'listEvents').map(c => c.calendarId), split(ids)); });
Then('the result has one event with two sources', function () { assert.equal(this.result.events.length, 1); assert.equal(this.result.events[0].sources.length, 2); });
Then('Google received one free\\/busy query for {string}', function (ids) { const calls = this.calls.filter(c => c.kind === 'freeBusy'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].calendarIds, split(ids)); });
Then('Google inserted an event ending on {string} with sendUpdates {string}', function (date, sendUpdates) { const c = this.calls.find(x => x.kind === 'insert'); assert.equal(c.body.end.date, date); assert.equal(c.sendUpdates, sendUpdates); });
Then('Google moved the event with sendUpdates {string}', function (sendUpdates) { assert.equal(this.calls.find(x => x.kind === 'move').sendUpdates, sendUpdates); });
Then('Google patched it in {string} with sendUpdates {string}', function (calendarId, sendUpdates) { const c = this.calls.find(x => x.kind === 'patch'); assert.equal(c.calendarId, calendarId); assert.equal(c.sendUpdates, sendUpdates); });
Then('Google deleted the event with sendUpdates {string}', function (sendUpdates) { assert.equal(this.calls.find(x => x.kind === 'delete').sendUpdates, sendUpdates); });
