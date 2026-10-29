import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
import { createSharingService, sharingChangeParameters, sharingStatusSchema, sharingCategory, sharingMessage } from './core/sharing.mjs';
import { failureCategory } from './diagnostic.mjs';
export const SHARING_TOOLS = ['gdrive_change_sharing', 'gdrive_sharing_status'];
export function registerSharingTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${sharingCategory(error)} ${failureCategory(error)}`);
  const service = createSharingService({ store, sharing: adapter.sharing, diagnose });
  for (const name of SHARING_TOOLS) bb.agents.registerTool({ name,
    parameters: name === 'gdrive_change_sharing' ? sharingChangeParameters : sharingStatusSchema,
    description: name === 'gdrive_change_sharing'
      ? 'Preview (default) or request mandatory owner approval for one grant/change/revoke on an exact owned My Drive file or folder. Named users/groups: reader/commenter/writer. Anyone-with-link: reader/writer only, never discoverable. Requires complete live permissions and inspectable ancestry; blocks shared drives and inherited targets. Existing write grant only. Fresh single-use operationId required; apply with the SAME arguments and preview=false. Notifications are opt-in for named grants; no notification switch exists for changes/revocations. Folder effects may extend to inheriting items; no recursive rewrites.'
      : 'Read-only recovery of a saved sharing operation with the same explicit account and operationId. Inspects exact permission differences; never replays mutations, invitations or rollback. Unresolved writes block further sharing changes on the item.',
    instructions: 'Only user-requested sharing changes. Never test on real files or send invitations without authorization. Preview is not completion; approval is mandatory and cannot be disabled. Only outcome verified confirms exact permission readback, not recipient access or exhaustive privacy. After interruption/uncertainty call gdrive_sharing_status with the SAME account and operationId; never blindly retry or replace the key.',
    async execute(args, ctx) {
      try {
        const approve = (payload: Record<string, string>, signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId,
          rendererId: 'drive-sharing-approval', title: 'Review sharing change', payload,
          describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true
            ? 'Sharing change approved — not yet verified' : 'Sharing change not approved' }),
        }, { signal });
        const result = name === 'gdrive_change_sharing' ? await service.change(args, ctx.signal, approve) : await service.status(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        diagnose('sharing_agent_tool', error);
        return { content: [{ type: 'text' as const, text: sharingMessage(error) }], isError: true };
      }
    },
  });
}
