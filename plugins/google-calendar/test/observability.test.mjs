import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createCalendarService } from '../core/service.mjs';

test('a partial search reports failed accounts and logs the suppressed provider boundary', async () => {
  const store = createMemoryStore();
  await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'private-refresh' });
  const diagnostics = [];
  const calendar = {
    identity: async () => { throw Object.assign(new Error('private provider body'), { status: 503 }); },
    listCalendars: async () => ({ items: [{ id: 'team', primary: true, summary: 'Team' }] }),
    listEvents: async () => { throw Object.assign(new Error('private provider body'), { status: 503 }); },
  };
  const service = createCalendarService({ store, oauth: {}, calendar, diagnose: (stage, error) => diagnostics.push([stage, error.status]) });
  assert.equal((await service.execute('gcal_auth_status')).accounts[0].status, 'Connection unavailable');
  const result = await service.execute('gcal_search_events', { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z' });
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.failures.map(({ code }) => code), ['event_list_failed']);
  assert.deepEqual(diagnostics, [['identity_lookup', 503], ['search_events', 503]]);
});
