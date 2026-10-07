import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';

// Exercise real schemas, BB payloads, provider adapters and consent without a browser.
for (const operation of ['create', 'update', 'delete']) for (const failure of [false, true]) for (const outcome of ['approved', 'declined', 'cancelled']) {
  test(`BB ${operation} approval carries ${failure ? 'unavailable' : 'verified'} context and ${outcome} preserves consent`, async () => {
    const originalFetch = globalThis.fetch, requests = [];
    let approved = false;
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname, method = options?.method || 'GET';
      requests.push({ path, method, sendUpdates: new URL(url).searchParams.get('sendUpdates'), body: options?.body });
      if (method !== 'GET') {
        assert.equal(approved, true, 'No provider mutation before explicit consent');
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return Response.json({ id: 'event', ...JSON.parse(options.body) });
      }
      if (path.endsWith('/userinfo')) return Response.json({ sub: 'person', email: 'person@example.test', email_verified: true });
      if (failure) return Response.json({ body: 'private-event private-token private-account' }, { status: 503 });
      if (path.endsWith('/calendarList')) return Response.json({ items: [{ id: 'team', summary: 'Team' }] });
      if (path.endsWith('/events/event')) return Response.json({ id: 'event', summary: 'Verified title', start: { dateTime: '2026-10-07T09:00:00-07:00' }, end: { dateTime: '2026-10-07T09:30:00-07:00' }, recurringEventId: 'series', attendees: [{ email: 'old@example.test', displayName: 'Old guest', comment: 'private-comment' }], credential: 'private-token' });
      assert.fail('Unexpected provider read');
    };
    const { bb, harness } = createFakePluginHost({ pluginId: 'google-calendar', appUrl: 'https://bb.example', settings: { clientId: 'synthetic-client', clientSecret: 'private-secret' } });
    try {
      await plugin(bb);
      const store = createBbStore(bb.storage.database(), () => {});
      await store.addAccount({ subject: 'person', email: 'person@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
      const args = { account: 'person@example.test', calendarId: 'team', sendUpdates: 'externalOnly', ...(operation === 'create' ? { summary: 'Away', start: '2026-10-07', allDay: true } : { eventId: 'event' }), ...(operation === 'update' ? { attendees: ['new@example.test'] } : {}) };
      const pending = harness.behavior.callAgentTool(`gcal_${operation}_event`, args);
      await new Promise(resolve => setImmediate(resolve));
      const form = harness.inspection.pendingInteractions[0];
      assert.ok(form);
      assert.deepEqual(form.payload.proposed, { ...args, ...(operation === 'create' ? { end: '2026-10-08' } : {}) });
      assert.equal(form.payload.context.calendarName, failure ? null : 'Team');
      assert.equal(form.payload.context.currentEvent?.summary || null, failure || operation === 'create' ? null : 'Verified title');
      if (!failure && operation === 'delete') assert.equal(form.payload.context.currentEvent.recurringEventId, 'series');
      if (!failure && operation === 'update') assert.deepEqual(form.payload.context.currentEvent.attendees, [{ email: 'old@example.test', displayName: 'Old guest' }]);
      assert.ok(requests.every(r => r.method === 'GET'));
      if (outcome === 'cancelled') harness.behavior.cancelInteraction(form.id);
      else { approved = outcome === 'approved'; harness.behavior.submitInteraction(form.id, { approved, ...(!approved ? { notifyAttendees: true } : {}) }); }
      const result = await pending;
      const writes = requests.filter(r => r.method !== 'GET');
      if (approved) {
        assert.equal(result.isError, undefined);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].sendUpdates, 'none', 'Older submissions without the checkbox must default to off');
        assert.equal(JSON.parse(result.content[0].text).sendUpdates, 'none');
        assert.equal(writes[0].method, { create: 'POST', update: 'PATCH', delete: 'DELETE' }[operation]);
        if (operation === 'create') assert.equal(JSON.parse(writes[0].body).end.date, form.payload.proposed.end);
        if (operation === 'update') assert.deepEqual(JSON.parse(writes[0].body).attendees, [{ email: 'new@example.test' }]);
      } else {
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /not approved/);
        assert.equal(writes.length, 0);
      }
      const logs = JSON.stringify(harness.inspection.logEntries);
      if (failure) {
        if (operation !== 'create') assert.match(logs, /approval_event_read http_status=503/);
        assert.match(logs, /approval_calendar_read http_status=503/);
      }
      assert.doesNotMatch(logs, /private-|person@example|Verified title|old@example|new@example/);
      assert.doesNotMatch(JSON.stringify(form.payload), /private-/);
    } finally { globalThis.fetch = originalFetch; await harness.lifecycle.dispose(); }
  });
}
