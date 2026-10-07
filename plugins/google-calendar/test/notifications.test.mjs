import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createCalendarService } from '../core/service.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';

// Exercise real BB submissions and provider query parameters without a browser.
for (const operation of ['create', 'update', 'delete']) for (const notifyAttendees of [false, true]) {
  test(`${operation}: the owner's checkbox overrides the agent's notification request (${notifyAttendees})`, async () => {
    const originalFetch = globalThis.fetch, writes = [];
    let approved = false;
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname, method = options?.method || 'GET';
      if (method !== 'GET') {
        assert.equal(approved, true);
        writes.push({ method, sendUpdates: new URL(url).searchParams.get('sendUpdates') });
        return method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'event' });
      }
      if (path.endsWith('/userinfo')) return Response.json({ sub: 'person', email: 'person@example.test', email_verified: true });
      if (path.endsWith('/calendarList')) return Response.json({ items: [{ id: 'team', summary: 'Team' }] });
      return Response.json({ id: 'event', summary: 'Current event' });
    };
    const { bb, harness } = createFakePluginHost({ pluginId: 'google-calendar', appUrl: 'https://bb.example', settings: { clientId: 'client', clientSecret: 'private-secret' } });
    try {
      await plugin(bb);
      await createBbStore(bb.storage.database(), () => {}).addAccount({ subject: 'person', email: 'person@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
      const input = { account: 'person@example.test', calendarId: 'team', sendUpdates: notifyAttendees ? 'none' : 'all', ...(operation === 'create' ? { summary: 'Away', start: '2026-10-07', allDay: true } : { eventId: 'event' }), ...(operation === 'update' ? { summary: 'Renamed' } : {}) };
      const pending = harness.behavior.callAgentTool(`gcal_${operation}_event`, input);
      await new Promise(resolve => setImmediate(resolve));
      const form = harness.inspection.pendingInteractions[0];
      assert.ok(form);
      assert.equal(writes.length, 0);
      approved = true;
      harness.behavior.submitInteraction(form.id, { approved, notifyAttendees });
      const result = await pending;
      assert.equal(result.isError, undefined);
      assert.deepEqual(writes, [{ method: { create: 'POST', update: 'PATCH', delete: 'DELETE' }[operation], sendUpdates: notifyAttendees ? 'all' : 'none' }]);
      assert.equal(JSON.parse(result.content[0].text).sendUpdates, notifyAttendees ? 'all' : 'none');
      assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-|person@example|Current event/);
    } finally { globalThis.fetch = originalFetch; await harness.lifecycle.dispose(); }
  });
}

for (const patch of [false, true]) for (const notifyAttendees of [false, true]) {
  test(`move ${patch ? 'and patch' : 'only'} sends updates only at the chosen final operation (${notifyAttendees})`, async () => {
    const store = createMemoryStore();
    await store.addAccount({ subject: 'person', email: 'person@example.test', refreshToken: 'private-refresh' });
    const writes = [];
    const service = createCalendarService({ store, oauth: {}, calendar: {
      getEvent: async () => ({ id: 'event', summary: 'Event' }),
      listCalendars: async () => ({ items: [] }),
      moveEvent: async (_record, _calendar, eventId, _destination, mode) => { writes.push(['move', mode]); return { id: eventId }; },
      patchEvent: async (_record, _calendar, eventId, _body, mode) => { writes.push(['patch', mode]); return { id: eventId }; },
    }, approve: async () => ({ approved: true, notifyAttendees }) });
    const result = await service.execute('gcal_update_event', { account: 'person@example.test', calendarId: 'team', eventId: 'event', moveToCalendarId: 'other', sendUpdates: notifyAttendees ? 'none' : 'all', ...(patch ? { summary: 'Renamed' } : {}) });
    const finalMode = notifyAttendees ? 'all' : 'none';
    assert.deepEqual(writes, patch ? [['move', 'none'], ['patch', finalMode]] : [['move', finalMode]]);
    assert.equal(result.sendUpdates, finalMode);
  });
}
