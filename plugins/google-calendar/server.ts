import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract } from './contract.js';
import { createBbStore } from './adapters/bb-store.mjs';
import { createGoogleAdapter } from './adapters/google.mjs';
import { createCalendarService, SCOPES } from './core/service.mjs';
import { failureCategory } from './diagnostic.mjs';
import { approvalChoice } from './approval-model.mjs';

const text = z.string().min(1);
const account = text.describe('Connected Google account email (choose explicitly).');
const target = z.object({ account, calendarId: text });
const sendUpdates = z.enum(['none', 'all', 'externalOnly']).optional().describe('Requested notification mode. The owner checkbox starts off and overrides this request: unchecked sends none, checked notifies all attendees.');
const forCalendar = { account, calendarId: text };
const eventId = { ...forCalendar, eventId: text };
const schemas = {
  gcal_auth_status: z.object({}),
  gcal_list_calendars: z.object({}),
  gcal_list_events: z.object({ ...forCalendar, timeMin: text.optional(), timeMax: text.optional(), maxResults: z.number().optional(), q: text.optional(), timeZone: text.optional(), singleEvents: z.boolean().optional() }),
  gcal_search_events: z.object({ timeMin: text, timeMax: text, calendarSelection: z.enum(['selected','primary','all']).optional(), accounts: z.array(account).min(1).optional(), targets: z.array(target).min(1).optional(), q: text.optional(), timeZone: text.optional(), maxResults: z.number().optional() }),
  gcal_get_event: z.object(eventId),
  gcal_create_event: z.object({ ...forCalendar, summary: text, start: text, end: text.optional(), description: z.string().optional(), location: z.string().optional(), timeZone: text.optional(), allDay: z.boolean().optional(), attendees: z.array(text).optional(), sendUpdates }),
  gcal_update_event: z.object({ ...eventId, summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(), attendees: z.array(text).optional().describe('Complete replacement attendee email list; omitted leaves attendees unchanged, [] removes all attendees.'), start: text.optional(), end: text.optional(), timeZone: text.optional(), moveToCalendarId: text.optional(), sendUpdates }),
  gcal_delete_event: z.object({ ...eventId, sendUpdates }),
  gcal_free_busy: z.object({ account, timeMin: text, timeMax: text, calendarIds: z.array(text).min(1) }),
};
const descriptions = {
  gcal_auth_status: 'Report connected Google Calendar accounts and which require reauthorization.',
  gcal_list_calendars: 'Discover calendars across all connected Google accounts, including partial failures.',
  gcal_list_events: 'List events from one explicit account and calendar; defaults to the next 30 days.',
  gcal_search_events: 'Search a time range across selected and primary calendars on connected accounts. Prefer this for an agenda spanning calendars.',
  gcal_get_event: 'Read one event by ID from an explicit account and calendar.',
  gcal_create_event: 'Create an event in an explicit account/calendar after the owner approves it. Attendee notifications default to none.',
  gcal_update_event: 'Update or move an event after the owner approves it. Attendee notifications default to none.',
  gcal_delete_event: 'Delete an event after the owner approves it. Attendee notifications default to none.',
  gcal_free_busy: 'Query busy periods for explicit calendars in one Google account.',
};
const WRITE_NAMES = new Set(['gcal_create_event','gcal_update_event','gcal_delete_event']);
const safeError = (error: unknown, write = false) => {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Unknown Google account:')) return 'Unknown Google account. Check connected accounts in BB settings.';
  const localErrors = [
    'Calendar change was not approved', 'An end datetime is required for non-all-day events',
    'Rescheduling requires both start and end', 'No event changes requested',
    'Google account was removed; reconnect it', 'Google account changed during refresh; try again',
  ];
  if (localErrors.includes(message)) return message;
  if (message.startsWith('Configure the Google Web OAuth client')) return 'Configure the Google Web OAuth client in BB plugin settings.';
  if (message.includes('failed (401)') || ['reauthentication_required', 'invalid_grant'].includes((error as { code?: string })?.code || '')) return 'Google authorization expired. Reconnect the account in BB plugin settings.';
  return write ? 'Google Calendar change could not be confirmed. It may have completed; check the calendar before retrying.'
    : 'Google Calendar operation failed. Check the connected account and try again.';
};
type ApprovalProposal = { operation: string; account: string; calendarId: string; details: Record<string, unknown>; context?: { currentEvent: Record<string, unknown> | null; calendarName: string | null; destinationCalendarName: string | null } };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// OAuth responses can contain codes, tokens, and provider diagnostics. Only log
// a fixed failure category; never log the exception or its raw message.
function oauthFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'invalid_grant') return 'token_exchange_rejected';
  if (message.startsWith('Google authorization was cancelled or incomplete')) return 'callback_incomplete';
  if (message.startsWith('Google authorization has expired or is invalid')) return 'state_invalid_or_expired';
  if (message.startsWith('Google authorization is temporarily unavailable')) return 'token_endpoint_unreachable';
  if (message.startsWith('Google authorization failed')) return 'token_endpoint_rejected';
  if (message.startsWith('Google did not provide a refresh token')) return 'missing_refresh_token';
  if (message.startsWith('Google did not grant all required Calendar scopes')) return 'missing_required_scopes';
  if (message.startsWith('Google identity failed')) return 'identity_endpoint_rejected';
  if (message.startsWith('Google account identity is unverified') || message.startsWith('Google did not verify the account identity')) return 'identity_unverified';
  if (message.startsWith('Google account is already connected')) return 'duplicate_account';
  if (message.startsWith('Missing OAuth settings')) return 'client_not_configured';
  return 'unexpected';
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clientId: { type: 'string', label: 'Web OAuth client ID', description: 'First time? Follow the setup guide below.', default: '' },
    clientSecret: { type: 'string', label: 'Client secret', secret: true },
  });
  const store = createBbStore(bb.storage.database(), (db: Parameters<typeof bb.storage.migrate>[0], statements: Parameters<typeof bb.storage.migrate>[1]) => bb.storage.migrate(db, statements));
  const getClient = async () => settings.get();
  const adapter = createGoogleAdapter({ store, getClient });
  const publicCallback = () => {
    const origin = bb.server.experimental_appUrl;
    if (!origin || !origin.startsWith('https://')) throw new Error('Configure an HTTPS BB_APP_URL before connecting Google');
    return new URL(`/api/v1/plugins/${bb.pluginId}/http/callback`, origin).toString();
  };
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Calendar ${stage} ${failureCategory(error)}`);
  const service = (approve?: (proposal: ApprovalProposal) => Promise<ReturnType<typeof approvalChoice>>) =>
    createCalendarService({ store, oauth: adapter.oauth, calendar: adapter.calendar, diagnose, ...(approve ? { approve } : {}) });

  bb.rpc.register(rpcContract, {
    async status() {
      const { clientId, clientSecret } = await getClient();
      let redirectUri: string | null = null;
      try { redirectUri = publicCallback(); } catch { /* setup still incomplete */ }
      return { configured: Boolean(clientId && clientSecret && redirectUri), redirectUri, accounts: (await service().execute('gcal_auth_status')).accounts };
    },
    async beginConnect() {
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Configure the Google Web OAuth client in plugin settings');
      const { url } = await service().beginConnect({ clientId, redirectUri: publicCallback() });
      return { url };
    },
    async removeAccount({ subject }) { return { removed: await service().removeAccount(subject) }; },
    async exportOAuthClientForDrive(_input, context) {
      if (context.experimental_caller.kind !== 'plugin' || context.experimental_caller.pluginId !== 'google-drive')
        throw new Error('OAuth client export is restricted to the Google Drive plugin');
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Calendar OAuth client is not configured');
      return { clientId, clientSecret };
    },
    async importDriveOAuthClient() {
      if ((await store.accounts()).length) throw new Error('Disconnect Calendar accounts before changing their OAuth client');
      const client = await bb.sdk.plugins.callRpc({ pluginId: 'google-drive', method: 'exportOAuthClientForCalendar', input: null,
        outputSchema: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }) });
      await settings.experimental_set(client);
      return { imported: true };
    },
  });

  // Google arrives without a BB browser Origin header. Only a one-use, expiring,
  // owner-initiated state/PKCE grant may complete this deliberately public route.
  bb.http.route('GET', '/callback', async ctx => {
    const state = ctx.req.query('state') || '';
    const code = ctx.req.query('code') || '';
    const error = ctx.req.query('error') || '';
    let heading = 'Google Calendar account connected';
    let status = 200;
    try {
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Missing OAuth settings');
      await service().finishConnect({ state, code, error, clientId, clientSecret, redirectUri: publicCallback() });
    } catch (failure) {
      const category = oauthFailureCategory(failure);
      const declared = failure && typeof failure === 'object' && 'missingScopes' in failure && Array.isArray(failure.missingScopes)
        ? failure.missingScopes.filter((scope): scope is string => typeof scope === 'string' && SCOPES.includes(scope)) : [];
      bb.log.warn(`Google Calendar OAuth callback failed: ${category}${category === 'missing_required_scopes' && declared.length ? ` (${declared.join(', ')})` : ''}`);
      heading = 'Google Calendar connection failed. Return to BB and try again.';
      status = 400;
    }
    const appUrl = bb.server.experimental_appUrl || '/';
    return ctx.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Google Calendar</title><body><h1>${escapeHtml(heading)}</h1><p><a href="${escapeHtml(appUrl)}">Return to BB</a></p></body></html>`, status as 200 | 400);
  }, { auth: 'none' });

  for (const [name, parameters] of Object.entries(schemas)) {
    bb.agents.registerTool({
      name, description: descriptions[name as keyof typeof descriptions], parameters,
      instructions: WRITE_NAMES.has(name) ? 'This tool pauses for the BB owner to approve the exact change. Never interpret an unapproved change as completed.' : undefined,
      async execute(args, ctx) {
        const approve = async (proposal: ApprovalProposal) => {
          const response = await bb.ui.requestInput({
            threadId: ctx.threadId, rendererId: 'calendar-approval', title: `Approve Calendar ${proposal.operation}`,
            payload: { operation: proposal.operation, account: proposal.account, calendarId: proposal.calendarId,
              summary: typeof proposal.details.summary === 'string' ? proposal.details.summary : null,
              eventId: typeof proposal.details.eventId === 'string' ? proposal.details.eventId : null,
              sendUpdates: typeof proposal.details.sendUpdates === 'string' ? proposal.details.sendUpdates : 'none',
              proposed: JSON.parse(JSON.stringify(proposal.details)),
              context: proposal.context ? JSON.parse(JSON.stringify(proposal.context)) : null,
              details: JSON.stringify(proposal.details) },
            describeSubmission: value => {
              const choice = approvalChoice(value);
              return { title: !choice.approved ? 'Calendar change declined' : choice.notifyAttendees ? 'Calendar change approved · notify attendees' : 'Calendar change approved · notifications off' };
            },
          }, { signal: ctx.signal });
          return approvalChoice(response.outcome === 'submitted' ? response.value : null);
        };
        try {
          const result = await service(approve).execute(name, args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          diagnose(`agent_tool ${name}`, error);
          return { content: [{ type: 'text' as const, text: safeError(error, WRITE_NAMES.has(name)) }], isError: true };
        }
      },
    });
  }
  bb.agents.configure(() => ({ tools: Object.keys(schemas), skills: [] }));
}
