import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { rpcContract } from './contract.js';
import { createBbStore } from './adapters/bb-store.mjs';
import { createGoogleAdapter } from './adapters/google.mjs';
import { createDriveService } from './core/service.mjs';
import { failureCategory } from './diagnostic.mjs';

const required = z.string().min(1);
const account = required.describe('Email of the connected Google Drive account.');
const schemas = {
  gdrive_auth_status: z.object({}),
  gdrive_search_files: z.object({ query: z.string().optional().describe('Name or indexed-content search term; omit to browse accessible files by page.'),
    accounts: z.array(account).min(1).optional(), folderId: required.optional(), foldersOnly: z.boolean().optional(),
    pageSize: z.number().int().min(1).max(100).optional(), pageToken: required.optional() }),
  gdrive_list_folder: z.object({ account, folderId: required.describe('Folder ID or root'), pageSize: z.number().int().min(1).max(100).optional(), pageToken: required.optional() }),
  gdrive_get_file: z.object({ account, fileId: required }),
  gdocs_read: z.object({ account, document: required.describe('Google Doc URL or document ID; other file types are not supported.') }),
};
const descriptions = {
  gdrive_auth_status: 'Show connected Google Drive accounts and reauthorization status.',
  gdrive_search_files: 'Search Google Drive files and folders by name or indexed text across connected accounts. Results are paged per account; check incompleteSearch and nextPageToken.',
  gdrive_list_folder: 'List a folder in one Google Drive account. Use folderId root for My Drive.',
  gdrive_get_file: 'Get Google Drive file metadata and a source link in one explicit account.',
  gdocs_read: 'Read the plain text of every tab in a Google Doc, by URL or ID, in one explicit account. May truncate long documents.',
};
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const localErrors = [
    'Unknown Google Drive account. Check connected accounts in BB settings.',
    'Select exactly one account to continue a search page', 'Search query is too long',
    'Use a Google Docs URL or document ID',
    'This file is not a Google Doc; reading other formats is not supported yet',
    'account is required', 'folderId is required', 'fileId is required', 'document is required',
  ];
  if (localErrors.includes(message)) return message;
  if (['reauthentication_required', 'invalid_grant'].includes((error as { code?: string })?.code || '') || (error as { status?: number })?.status === 401)
    return 'Google authorization expired. Reconnect the Drive account in BB settings.';
  return 'Google Drive read failed. Check the connected account and try again.';
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function oauthCategory(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Google authorization was cancelled')) return 'callback_incomplete';
  if (message.startsWith('Google authorization has expired')) return 'state_invalid_or_expired';
  if (message.startsWith('Google did not provide a refresh token')) return 'missing_refresh_token';
  if (message.startsWith('Google did not grant')) return 'missing_required_scopes';
  if (message.startsWith('Google account is already connected')) return 'duplicate_account';
  if ((error as { code?: string })?.code === 'invalid_grant') return 'token_exchange_rejected';
  if (message.startsWith('Google authorization is temporarily unavailable')) return 'token_endpoint_unreachable';
  if (message.startsWith('Google authorization failed')) return `token_endpoint_rejected ${failureCategory(error)}`;
  if (message.startsWith('Google identity failed')) return `identity_endpoint_rejected ${failureCategory(error)}`;
  if (message.startsWith('Google account identity is unverified') || message.startsWith('Google did not verify the account identity')) return 'identity_unverified';
  return 'connection_failed';
}
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    clientId: { type: 'string', label: 'Web OAuth client ID', description: 'First time? Follow the setup guide below.', default: '' },
    clientSecret: { type: 'string', label: 'Client secret', secret: true },
  });
  const store = createBbStore(bb.storage.database(), (db: Parameters<typeof bb.storage.migrate>[0], statements: Parameters<typeof bb.storage.migrate>[1]) => bb.storage.migrate(db, statements));
  const getClient = async () => settings.get();
  const adapter = createGoogleAdapter({ store, getClient });
  const callbackUrl = () => {
    const origin = bb.server.experimental_appUrl;
    if (!origin || !origin.startsWith('https://')) throw new Error('Configure HTTPS BB_APP_URL before connecting Google');
    return new URL(`/api/v1/plugins/${bb.pluginId}/http/callback`, origin).toString();
  };
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${failureCategory(error)}`);
  const service = () => createDriveService({ store, oauth: adapter.oauth, drive: adapter.drive, diagnose });
  bb.rpc.register(rpcContract, {
    async status() {
      const { clientId, clientSecret } = await getClient();
      let redirectUri: string | null = null;
      try { redirectUri = callbackUrl(); } catch { /* Offer setup instructions without a public URL. */ }
      return { configured: Boolean(clientId && clientSecret && redirectUri), redirectUri,
        accounts: (await service().execute('gdrive_auth_status')).accounts };
    },
    async beginConnect() {
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Configure the Google Web OAuth client in plugin settings');
      return service().beginConnect({ clientId, redirectUri: callbackUrl() });
    },
    async removeAccount({ subject }) { return { removed: await service().removeAccount(subject) }; },
    async importCalendarOAuthClient() {
      if ((await store.accounts()).length) throw new Error('Disconnect Drive accounts before changing their OAuth client');
      // BB verifies the plugin caller for this RPC. Credentials stay on the
      // server and are copied into Drive's own secret settings once, not linked.
      const client = await bb.sdk.plugins.callRpc({ pluginId: 'google-calendar', method: 'exportOAuthClientForDrive', input: null,
        outputSchema: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }) });
      await settings.experimental_set(client);
      return { imported: true };
    },
    async exportOAuthClientForCalendar(_input, context) {
      if (context.experimental_caller.kind !== 'plugin' || context.experimental_caller.pluginId !== 'google-calendar')
        throw new Error('OAuth client export is restricted to the Google Calendar plugin');
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Drive OAuth client is not configured');
      return { clientId, clientSecret };
    },
  });
  // Public callback accepts only an expiring, owner-initiated, one-use PKCE grant.
  bb.http.route('GET', '/callback', async ctx => {
    let heading = 'Google Drive account connected';
    let status = 200;
    try {
      const { clientId, clientSecret } = await getClient();
      if (!clientId || !clientSecret) throw new Error('Missing OAuth settings');
      await service().finishConnect({ state: ctx.req.query('state') || '', code: ctx.req.query('code') || '',
        error: ctx.req.query('error') || '', clientId, clientSecret, redirectUri: callbackUrl() });
    } catch (error) {
      bb.log.warn(`Google Drive OAuth callback failed: ${oauthCategory(error)}`);
      heading = 'Google Drive connection failed. Return to BB and try again.';
      status = 400;
    }
    return ctx.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Google Drive</title><body><h1>${escapeHtml(heading)}</h1><p><a href="${escapeHtml(bb.server.experimental_appUrl || '/')}">Return to BB</a></p></body></html>`, status as 200 | 400);
  }, { auth: 'none' });
  for (const [name, parameters] of Object.entries(schemas)) {
    bb.agents.registerTool({ name, description: descriptions[name as keyof typeof descriptions], parameters,
      async execute(args) {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await service().execute(name, args as Record<string, unknown>)) }] }; }
        catch (error) {
          diagnose(`agent_tool ${name}`, error);
          return { content: [{ type: 'text' as const, text: safeError(error) }], isError: true };
        }
      },
    });
  }
  bb.agents.configure(() => ({ tools: Object.keys(schemas), skills: [] }));
}
