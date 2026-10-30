// Synthetic native-BB fixture: no adapter, account, credentials, agent tools or Google calls.
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { filingApprovalSetting } from '../../filing-policy.js';
const states = ['task', 'move', 'folder', 'invalid', 'error', 'busy', 'cancel'] as const;
export default function plugin(bb: BbPluginApi) {
  bb.settings.define({ filingApproval: filingApprovalSetting });
  const results = new Map<string, unknown>();
  bb.rpc.register({
    stage: { input: z.object({ threadId: z.string(), state: z.enum(states) }), output: z.object({ staged: z.boolean() }) },
    result: { input: z.object({ threadId: z.string() }), output: z.any() },
  }, {
    async stage({ threadId, state }) {
      results.delete(threadId);
      const payload = { kind: state === 'folder' ? 'folder' : 'move', account: 'owner@example.invalid', title: state === 'folder' ? 'Synthetic - exact folder' : 'Synthetic marketing workbook or uploaded PDF — existing file with a long title',
        mimeType: state === 'folder' ? 'application/vnd.google-apps.folder' : state === 'move' ? 'application/vnd.google-apps.spreadsheet' : 'application/pdf',
        operationId: '11111111-1111-4111-8111-111111111111', fileId: 'synthetic-doc', destinationId: 'synthetic-destination',
        from: state === 'folder' ? 'New folder' : 'My Drive / Old organization', to: state === 'folder' ? 'My Drive / Shared administration / Partnership / Synthetic - exact folder' : 'My Drive / Shared administration / New organization / Partnership',
        sharedAncestors: true,
        sourceOwners: state === 'folder' ? 'New folder — no existing path.' : 'My Drive — owner: owner@example.invalid\nOld organization — owner: owner@example.invalid',
        destinationOwners: state === 'folder' ? 'My Drive — owner: owner@example.invalid\nShared administration — owner: partner@example.invalid\nPartnership — owner: partner@example.invalid' : 'My Drive — owner: owner@example.invalid\nShared administration — owner: partner@example.invalid\nNew organization — owner: owner@example.invalid\nPartnership — owner: owner@example.invalid',
        sharedAncestorSummary: state === 'folder' ? '“Shared administration” belongs to partner@example.invalid.\n“Partnership” belongs to partner@example.invalid.' : '“Shared administration” belongs to partner@example.invalid.',
        accessChanges: state === 'folder' ? 'partner@example.invalid — may get access through the destination folder (parent access: Owner).\nGroup team@example.invalid — may get access through the destination folder (parent access: Can edit).' : 'partner@example.invalid — may gain editing access.\nGroup old-team@example.invalid — may lose some or all viewing access from folders.',
        reviewReason: 'Review changes to who may gain or lose access from folders. Parent ownership alone does not require approval.',
        sourceAudience: state === 'folder' ? 'New folder — no existing audience.' : 'Group old-team@example.invalid — Can view',
        destinationAudience: state === 'folder' ? 'owner@example.invalid — Can edit\nGroup team@example.invalid — Can edit' : 'partner@example.invalid — Can edit',
        audience: state === 'folder' ? 'partner@example.invalid — Owner\nowner@example.invalid — Can edit\nGroup team@example.invalid — Can edit' : 'partner@example.invalid — Can edit\nGroup old-team@example.invalid — Can view',
        impact: state === 'folder' ? 'The new folder may get the destination’s access. There is no existing source file or access to remove. Group members, organization rules and other ways of accessing the folder are not fully visible.' : 'Moving may give people access through the destination folder or remove access they had through the old folder. Existing direct shares stay unchanged. Group members, organization rules and other ways of accessing the file are not fully visible.',
        reviewState: state, exampleOnly: true };
      void bb.ui.requestInput({ threadId, rendererId: 'drive-filing-approval', title: 'Review filing and inherited access (synthetic)',
        payload: state === 'invalid' ? { reviewState: state } : state === 'task' ? { kind: 'task', account: payload.account, operationId: payload.operationId,
          items: ['Business plan', 'Marketing workbook', 'Résumé', 'Market evidence', 'Finance sheet', 'Requested folder'].map((title, n) => ({ ...payload,
            kind: n === 5 ? 'folder' : 'move', title, operationId: `${n + 2}1111111-1111-4111-8111-111111111111`, requiresApproval: n > 1,
            accessChanges: n < 2 ? 'No access change was found in the visible lists.' : 'partner@example.invalid — may gain editing access.' })) } : payload,
        describeSubmission: () => ({ title: 'Synthetic filing choice recorded — no Google write' }),
      }).then(result => results.set(threadId, result), () => results.set(threadId, { outcome: 'interrupted' }));
      return { staged: true };
    },
    async result({ threadId }) { return results.get(threadId) ?? null; },
  });
}
