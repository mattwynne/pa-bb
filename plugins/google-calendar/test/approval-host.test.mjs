import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';

for (const failure of [false, true]) for (const outcome of ['declined', 'cancelled']) {
  test(`BB update approval carries ${failure ? 'unavailable' : 'verified'} context and ${outcome} makes no mutation`, async () => {
    const originalFetch = globalThis.fetch, requests = [];
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: options?.method || 'GET' });
      assert.equal(options?.method || 'GET', 'GET');
      if (path.endsWith('/userinfo')) return Response.json({ sub: 'person', email: 'person@example.test', email_verified: true });
      if (failure) return Response.json({ body: 'private-event private-token private-account' }, { status: 503 });
      if (path.endsWith('/calendarList')) return Response.json({ items: [{ id: 'team', summary: 'Team' }] });
      if (path.endsWith('/events/event')) return Response.json({ id: 'event', summary: 'Verified title', start: { dateTime: '2026-10-07T09:00:00-07:00' }, end: { dateTime: '2026-10-07T09:30:00-07:00' } });
      assert.fail('Unexpected provider read');
    };
    const { bb, harness } = createFakePluginHost({ pluginId: 'google-calendar', appUrl: 'https://bb.example', settings: { clientId: 'synthetic-client', clientSecret: 'private-secret' } });
    try {
      await plugin(bb);
      const store = createBbStore(bb.storage.database(), () => {});
      await store.addAccount({ subject: 'person', email: 'person@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
      const args = { account: 'person@example.test', calendarId: 'team', eventId: 'event', start: '2026-10-07T08:00:00-07:00', end: '2026-10-07T08:30:00-07:00', timeZone: 'America/Vancouver', sendUpdates: 'externalOnly' };
      const pending = harness.behavior.callAgentTool('gcal_update_event', args);
      await new Promise(resolve => setImmediate(resolve));
      const form = harness.inspection.pendingInteractions[0];
      assert.ok(form);
      assert.deepEqual(form.payload.proposed, args);
      assert.equal(form.payload.context.calendarName, failure ? null : 'Team');
      assert.equal(form.payload.context.currentEvent?.summary || null, failure ? null : 'Verified title');
      if (outcome === 'declined') harness.behavior.submitInteraction(form.id, { approved: false });
      else harness.behavior.cancelInteraction(form.id);
      const result = await pending;
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /not approved/);
      assert.ok(requests.every(r => r.method === 'GET'));
      const logs = JSON.stringify(harness.inspection.logEntries);
      if (failure) {
        assert.match(logs, /approval_event_read http_status=503/);
        assert.match(logs, /approval_calendar_read http_status=503/);
      }
      assert.doesNotMatch(logs, /private-|person@example|Verified title/);
    } finally { globalThis.fetch = originalFetch; await harness.lifecycle.dispose(); }
  });
}
