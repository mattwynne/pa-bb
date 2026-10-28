import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createDocsEditService, docsErrorMessage, docsFailureCategory, EDIT_LIMIT } from './core/docs-edit.mjs';
import { createGoogleAdapter } from './adapters/google.mjs';
import { createBbStore } from './adapters/bb-store.mjs';
import { failureCategory } from './diagnostic.mjs';
import { SCOPES } from './core/service.mjs';
import { DOCS_WRITE_SCOPES } from './adapters/docs.mjs';

const target = { account: z.string().min(1).max(320).describe('Explicit connected account email.'),
  document: z.string().min(1).max(1024).describe('Google Docs URL or document ID.') };
const schemas = {
  gdocs_inspect_for_edit: z.object(target).strict(),
  gdocs_replace_text: z.object({ ...target, tabId: z.string().min(1).max(256),
    expectedRevisionId: z.string().min(1).max(2048).describe('Opaque revision from a complete gdocs_inspect_for_edit result for this account.'),
    oldText: z.string().min(1).max(EDIT_LIMIT), newText: z.string().max(EDIT_LIMIT),
    preview: z.boolean().optional().describe('Defaults to true (no write). False requests owner approval; not an approval bypass.') }).strict(),
};
type Proposal = { account: string; documentId: string; title: string; tabId: string; tabTitle: string; expectedRevisionId: string; oldText: string; newText: string };
export const DOCS_TOOL_NAMES = Object.keys(schemas);
export function docsAuthorizationInspector(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  return async (account: string) => {
    const settingsCanRequestWrite = SCOPES.some(scope => DOCS_WRITE_SCOPES.includes(scope));
    try {
      const record = await store.byEmail(account);
      if (!record) return { account, writeGrant: 'unknown_account', documentAccess: 'not_checked', settingsCanRequestWrite };
      try { await adapter.docs.prepareWrite(record); }
      catch (error) {
        if ((error as { docsCode?: string })?.docsCode !== 'scope_required') throw error;
        return { account: record.email, writeGrant: 'missing', documentAccess: 'not_checked', settingsCanRequestWrite,
          guidance: settingsCanRequestWrite ? 'The owner must reconnect this account in Google Drive Settings and explicitly approve the offered write access.'
            : 'This installed Settings flow requests only read access. Reconnecting cannot enable editing. A separately approved write-consent flow must first be delivered; do not change tokens or scopes manually.' };
      }
      return { account: record.email, writeGrant: 'present', documentAccess: 'not_checked', settingsCanRequestWrite,
        guidance: 'Write scope is present, but document edit permission and supported structure still require fresh inspection. No reauthorization is indicated by this scope check.' };
    } catch (error) {
      bb.log.warn(`Google Drive docs_authorization ${docsFailureCategory(error)} ${failureCategory(error)}`);
      return { account, writeGrant: 'unavailable', documentAccess: 'not_checked', settingsCanRequestWrite, guidance: docsErrorMessage(error) };
    }
  };
}
export function registerDocsTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  for (const [name, parameters] of Object.entries(schemas)) {
    bb.agents.registerTool({ name, parameters,
      description: name === 'gdocs_inspect_for_edit'
        ? 'Read complete bounded Google Docs text and revision for safe editing. Rejects suggestions, tables, objects, headers/footers and incomplete tabs. Does not replace gdocs_read for general reading.'
        : 'Preview (default) or request owner approval of one revision-guarded, unique literal replacement within one text run in a selected tab. No line breaks; max 2000 UTF-16 units per text. Never retry uncertain writes. Requires a separately owner-authorized write grant; existing read-only connections cannot edit.',
      instructions: name === 'gdocs_replace_text' ? 'Only for user-requested edits. Preview is not completion. A write pauses for the BB owner to approve the exact replacement. Never interpret an unapproved or unverified change as completed. After uncertain outcomes inspect again; do not replay.' : undefined,
      async execute(args, ctx) {
        const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${docsFailureCategory(error)} ${failureCategory(error)}`);
        const approve = async (proposal: Proposal) => {
          const response = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'docs-edit-approval', title: 'Review Google Docs replacement',
            payload: { ...proposal }, describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true ? 'Docs replacement approved (not yet verified)' : 'Docs replacement declined' }),
          }, { signal: ctx.signal });
          return response.outcome === 'submitted' && Boolean(response.value && typeof response.value === 'object' && 'approved' in response.value && response.value.approved === true);
        };
        const service = createDocsEditService({ store, drive: adapter.drive, docs: adapter.docs, diagnose, approve });
        try {
          const result = name === 'gdocs_inspect_for_edit' ? await service.inspect(args) : await service.replace(args, ctx.signal);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          diagnose(`agent_tool ${name}`, error);
          return { content: [{ type: 'text' as const, text: docsErrorMessage(error) }], isError: true };
        }
      },
    });
  }
}
