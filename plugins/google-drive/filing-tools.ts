import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
import { createFilingService, folderParameters, moveParameters, filingStatusParameters, filingTaskParameters, filingCategory, filingMessage } from './core/filing.mjs';
import { failureCategory } from './diagnostic.mjs';
export const FILING_TOOLS = ['gdrive_create_folder', 'gdrive_move_file', 'gdrive_filing_task', 'gdrive_filing_status'];
export function registerFilingTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>, requireApproval = async () => true) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${filingCategory(error)} ${failureCategory(error)}`);
  bb.rpc.register({ filingCapabilities: { input: z.null(), output: z.object({ contract: z.literal('filing-task-v1'),
    approval: z.enum(['access_changes', 'never']), emptyFolderApproval: z.literal('none'), maxItems: z.literal(20), destinations: z.literal('existing'), recovery: z.literal('individual-no-replay') }) } }, {
    async filingCapabilities() { return { contract: 'filing-task-v1' as const, approval: await requireApproval() ? 'access_changes' as const : 'never' as const,
      emptyFolderApproval: 'none' as const, maxItems: 20 as const, destinations: 'existing' as const, recovery: 'individual-no-replay' as const }; },
  });
  const service = createFilingService({ store, operations: store.filing, filing: adapter.filing, diagnose, requireApproval });
  for (const name of FILING_TOOLS) bb.agents.registerTool({ name,
    parameters: name === 'gdrive_create_folder' ? folderParameters : name === 'gdrive_move_file' ? moveParameters : name === 'gdrive_filing_task' ? filingTaskParameters : filingStatusParameters,
    description: name === 'gdrive_create_folder'
      ? 'Preview or create one user-requested owned My Drive folder under an explicit account and parent. Exact-name duplicates are blocked. Existing Drive write grant only. Empty-folder inheritance in an explicitly selected shared destination requires no filing approval; no existing document is disclosed. Single-use operationId and read-only recovery; no permission changes or invitations.'
      : name === 'gdrive_move_file'
        ? 'Preview or move one existing owned Google Drive file (native Docs/Sheets/Slides or uploaded files of any ordinary MIME type) to an explicit My Drive folder, preserving its ID/URL and sending no content or permission edits. Requires Google move capability, exact current parent, existing write grant and inspected access. Meaningful access changes require review under the filing setting, not shared ancestry alone. No copies, shortcuts, folder trees or shared-drive transfers. No file-body reads.'
        : name === 'gdrive_filing_task' ? 'Preview then execute one explicit requested filing task: up to 20 exact moves and folder creations under existing destinations, one owner review for meaningful access changes to moved files under the filing setting. Empty-folder inheritance alone needs no approval. Supply a task operationId and separate single-use operationIds for each item. Apply identical arguments with preview=false. Not atomic: stops on first non-verified result; individual durable receipts retain no-replay recovery. Destinations must already exist; create then inspect a new destination before proposing moves into it.'
        : 'Read-only recovery of a folder creation or file move with the same account and operationId. Never replays writes. Lost-response matching move state retains an unresolved lock; an empty folder search does not prove no creation.',
    instructions: 'Only user-requested filing. Discover sensible destinations with supported search/list/sharing reads; resolve genuine parent/account/audience ambiguity without asking for IDs. Preview is not completion. Never change OAuth, permissions, invitation or approval settings. Preserve existing file IDs; do not copy/recreate to file. Keep the operationId and recover uncertainty with gdrive_filing_status, never replay or replace a key. Use gdrive_filing_task for a requested batch, not repeated per-file cards. Empty-folder creation in an explicitly user-selected shared destination needs no filing approval merely for inherited audience/roles or another person owning an ancestor; do not ask again just because it is shared. This applies to standalone and task folder items, never authorizes later file exposure, and does not change sharing, upload or Docs policies. Create/verify/inspect a new destination before proposing moves into it: this existing-destination limitation is separate from approval policy. Evaluate each existing-file move independently. Only meaningful access changes to moved files trigger review by default; the owner alone controls Never for filing I request in Settings. Agents cannot override policy. Report access changes and partial completion. Task consent applies only to exact inspected items and destinations and expires on changes; never reuse it for later work.',
    async execute(args, ctx) {
      try {
        const approve = (payload: Record<string, unknown>, signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId,
          rendererId: 'drive-filing-approval', title: 'Review filing and inherited access', payload: JSON.parse(JSON.stringify(payload)),
          describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true
            ? 'Filing approved — not yet verified' : 'Filing not approved' }),
        }, { signal });
        const result = name === 'gdrive_create_folder' ? await service.createFolder(args, ctx.signal, approve)
          : name === 'gdrive_move_file' ? await service.move(args, ctx.signal, approve) : name === 'gdrive_filing_task' ? await service.task(args, ctx.signal, approve) : await service.status(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        diagnose('filing_agent_tool', error);
        return { content: [{ type: 'text' as const, text: filingMessage(error) }], isError: true };
      }
    },
  });
}
