import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
import { createFilingService, folderParameters, moveParameters, filingStatusParameters, filingCategory, filingMessage } from './core/filing.mjs';
import { failureCategory } from './diagnostic.mjs';
export const FILING_TOOLS = ['gdrive_create_folder', 'gdrive_move_file', 'gdrive_filing_status'];
export function registerFilingTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${filingCategory(error)} ${failureCategory(error)}`);
  const service = createFilingService({ store, operations: store.filing, filing: adapter.filing, diagnose });
  for (const name of FILING_TOOLS) bb.agents.registerTool({ name,
    parameters: name === 'gdrive_create_folder' ? folderParameters : name === 'gdrive_move_file' ? moveParameters : filingStatusParameters,
    description: name === 'gdrive_create_folder'
      ? 'Preview or create one user-requested owned My Drive folder under an explicit account and parent. Exact-name duplicates are blocked. Existing Drive write grant only. Shared audiences require exact owner approval. Single-use operationId and read-only recovery; no permission changes or invitations.'
      : name === 'gdrive_move_file'
        ? 'Preview or move one existing owned native Google Doc to an explicit My Drive folder, preserving its ID/URL and sending no content or permission edits. Requires exact current parent, existing write grant and inspected access. Shared audiences require owner approval. No copies, folder trees or shared-drive transfers.'
        : 'Read-only recovery of a folder creation or document move with the same account and operationId. Never replays writes. Lost-response matching move state retains an unresolved lock; an empty folder search does not prove no creation.',
    instructions: 'Only user-requested filing. Discover sensible destinations with supported search/list/sharing reads; resolve genuine parent/account/audience ambiguity without asking for IDs. Preview is not completion. Never change OAuth, permissions, invitation or approval settings. Preserve existing document IDs; do not copy/recreate to file. Keep the operationId and recover uncertainty with gdrive_filing_status, never replay or replace a key. Shared-audience review must be approved by the owner, not the agent.',
    async execute(args, ctx) {
      try {
        const approve = (payload: Record<string, string>, signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId,
          rendererId: 'drive-filing-approval', title: 'Review filing and inherited access', payload,
          describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true
            ? 'Filing approved — not yet verified' : 'Filing not approved' }),
        }, { signal });
        const result = name === 'gdrive_create_folder' ? await service.createFolder(args, ctx.signal, approve)
          : name === 'gdrive_move_file' ? await service.move(args, ctx.signal, approve) : await service.status(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        diagnose('filing_agent_tool', error);
        return { content: [{ type: 'text' as const, text: filingMessage(error) }], isError: true };
      }
    },
  });
}
