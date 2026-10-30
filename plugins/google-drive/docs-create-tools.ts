import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createDocsCreationService, creationErrorMessage, creationFailureCategory, CREATE_TEXT_LIMIT } from './core/docs-create.mjs';
import { docsFailureCategory } from './core/docs-edit.mjs';
import { failureCategory } from './diagnostic.mjs';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
const target = { account: z.string().min(1).max(320).describe('Explicit connected Google Drive account email.'),
  operationId: z.string().uuid().describe('Fresh lowercase UUID v4 for this user-requested creation. Keep the SAME key after interruptions. Never use a new key just to retry.') };
const schemas = {
  gdocs_create_document: z.object({ ...target, title: z.string().min(1).max(255),
    folderId: z.string().min(1).max(256).describe('Explicit destination: root or an explicitly selected supported writable My Drive folder. Shared destinations require owner review.'),
    text: z.string().min(1).max(CREATE_TEXT_LIMIT).describe('Initial plain text with LF paragraph breaks and blank lines. Preserved literally, not Markdown/HTML. Maximum 40000 UTF-16 units.') }).strict(),
  gdocs_creation_status: z.object(target).strict(),
};
export const DOCS_CREATION_TOOLS = Object.keys(schemas);
export function registerDocsCreationTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${creationFailureCategory(error)} ${docsFailureCategory(error)} ${failureCategory(error)}`);
  const service = createDocsCreationService({ store, drive: adapter.drive, docs: adapter.docs, creation: adapter.creation, assessment: adapter.filing, diagnose });
  for (const [name, parameters] of Object.entries(schemas)) {
    bb.agents.registerTool({ name, parameters,
      description: name === 'gdocs_create_document'
        ? 'Create and populate one native Google Doc for a user-requested creation, using an existing owner-authorized Drive write grant. Explicit account, title, destination, multi-paragraph text and single-use operationId. Read-only accounts cannot create. Returns a Docs link and exact text/title/destination readback outcome. Shared destinations require owner review of access, content and partial-content exposure. No sharing or invitations. Does not use the replacement-only approval setting.'
        : 'Read-only recovery for a saved Google Docs creation operation. Looks up an uncertain creation and verifies title, destination and complete body text without replaying create or populate. A missing search result does not establish that no document was created.',
      instructions: name === 'gdocs_create_document'
        ? 'Only for user-requested new documents. Do not broaden OAuth, share, invite, or change approval settings. Use root unless the user selected a supported folder. Keep the operationId: repeat calls with that key return a receipt and never write again. Only outcome verified is completion. After any uncertain/partial outcome call gdocs_creation_status with the SAME account and operationId; never blindly retry with a fresh key or populate a partial document.' : undefined,
      async execute(args, ctx) {
        try {
          const approve = (payload: Record<string, string>, signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId,
            rendererId: 'drive-creation-approval', title: 'Review shared creation', payload,
            describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true ? 'Creation approved — not yet verified' : 'Creation not approved' }),
          }, { signal });
          const result = name === 'gdocs_create_document' ? await service.create(args, ctx.signal, approve) : await service.inspect(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (error) {
          diagnose(`agent_tool ${name}`, error);
          return { content: [{ type: 'text' as const, text: creationErrorMessage(error) }], isError: true };
        }
      },
    });
  }
}
