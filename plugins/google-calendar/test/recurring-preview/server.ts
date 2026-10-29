import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { prepareRecurrence, recurrencePreview } from '../../core/recurrence.mjs';

// Test-only plugin: no Google adapter, credentials, tools or provider writes.
// Install ONLY in the controller's fresh isolated BB, never in a live profile.
const states = ['forever', 'count', 'until', 'oneoff', 'legacy', 'update-series', 'update-occurrence', 'delete-series', 'daily', 'monthly', 'yearly', 'all-day-daily', 'all-day-weekly', 'all-day-monthly', 'all-day-yearly', 'error', 'busy'] as const;
export default function plugin(bb: BbPluginApi) {
  const results = new Map<string, unknown>();
  bb.rpc.register({
    stage: { input: z.object({ threadId: z.string(), state: z.enum(states) }), output: z.object({ staged: z.boolean() }) },
    result: { input: z.object({ threadId: z.string() }), output: z.any() },
  }, {
    async stage({ threadId, state }) {
      // November start/cutoff are the SAME instant. Phoenix supplies stable -07
      // validation even on hosts with older Vancouver tzdata, then the fixture
      // labels the synthetic server-approved proposal Vancouver for browser review.
      const variants: Record<string, object> = {
        daily: { recurrence: { frequency: 'daily', interval: 2, count: 3 } },
        monthly: { start: '2026-01-31T10:00:00Z', end: '2026-01-31T11:00:00Z', timeZone: 'UTC', recurrence: { frequency: 'monthly' } },
        yearly: { start: '2024-02-29T10:00:00Z', end: '2024-02-29T11:00:00Z', timeZone: 'UTC', recurrence: { frequency: 'yearly', until: '2032-02-29T10:00:00Z' } },
        'all-day-daily': { start: '2026-12-31', end: '2027-01-01', allDay: true, recurrence: { frequency: 'daily', until: '2027-01-03' } },
        'all-day-weekly': { start: '2026-10-29', end: '2026-11-01', allDay: true, recurrence: { frequency: 'weekly', byDay: ['TH'], count: 3 } },
        'all-day-monthly': { start: '2026-01-31', end: '2026-02-02', allDay: true, recurrence: { frequency: 'monthly' } },
        'all-day-yearly': { start: '2024-02-29', end: '2024-03-01', allDay: true, recurrence: { frequency: 'yearly', until: '2032-02-29' } },
      };
      const proposed = { summary: 'Synthetic recurring appointment', start: '2026-11-05T14:30:00-07:00', end: '2026-11-05T17:00:00-07:00', timeZone: 'America/Phoenix',
        recurrence: { frequency: 'weekly', byDay: ['TH'], ...(state === 'count' ? { interval: 2, byDay: ['MO', 'TH'], count: 5 } : state === 'until' ? { until: '2026-11-05T21:30:00Z' } : {}) }, ...variants[state] };
      const prepared = prepareRecurrence(proposed)!;
      if (proposed.timeZone === 'America/Phoenix') proposed.timeZone = 'America/Vancouver';
      const operation = state.startsWith('update-') ? 'update' : state === 'delete-series' ? 'delete' : 'create';
      const currentEvent = { id: 'synthetic-series', summary: proposed.summary, start: { dateTime: proposed.start, timeZone: proposed.timeZone }, end: { dateTime: proposed.end, timeZone: proposed.timeZone },
        ...(state === 'update-occurrence' ? { recurringEventId: 'synthetic-parent' } : { recurrence: [prepared.rule] }) };
      const { recurrence: _recurrence, ...oneoff } = proposed;
      results.delete(threadId);
      void bb.ui.requestInput({ threadId, rendererId: 'calendar-approval', title: `Approve Calendar ${operation} (synthetic)`,
        payload: { operation, reviewState: state, account: 'person@example.test', calendarId: 'synthetic-calendar',
          proposed: operation !== 'create' ? { eventId: currentEvent.id, ...(operation === 'update' ? { summary: 'Synthetic new title' } : {}) } : state === 'oneoff' ? oneoff : { ...proposed, recurrence: prepared.normalized },
          recurrencePreview: state === 'legacy' || state === 'oneoff' || operation !== 'create' ? null : recurrencePreview(prepared.normalized, proposed),
          context: { calendarName: 'Synthetic calendar', ...(operation !== 'create' ? { currentEvent } : {}) } },
        describeSubmission: () => ({ title: 'Synthetic choice recorded — no Google write' }),
      }).then(result => results.set(threadId, result), () => results.set(threadId, { outcome: 'interrupted' }));
      return { staged: true };
    },
    async result({ threadId }) { return results.get(threadId) ?? null; },
  });
}
