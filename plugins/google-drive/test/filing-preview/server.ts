// Synthetic native-BB fixture: no adapter, account, credentials, agent tools or Google calls.
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
const states = ['move', 'folder', 'invalid', 'error', 'busy', 'cancel'] as const;
export default function plugin(bb: BbPluginApi) {
  const results = new Map<string, unknown>();
  bb.rpc.register({
    stage: { input: z.object({ threadId: z.string(), state: z.enum(states) }), output: z.object({ staged: z.boolean() }) },
    result: { input: z.object({ threadId: z.string() }), output: z.any() },
  }, {
    async stage({ threadId, state }) {
      results.delete(threadId);
      const payload = { kind: state === 'folder' ? 'folder' : 'move', account: 'owner@example.invalid', title: state === 'folder' ? 'Synthetic course folder' : 'Synthetic marketing workbook or uploaded PDF — existing file with a long title',
        mimeType: state === 'folder' ? 'application/vnd.google-apps.folder' : state === 'move' ? 'application/vnd.google-apps.spreadsheet' : 'application/pdf',
        operationId: '11111111-1111-4111-8111-111111111111', fileId: 'synthetic-doc', destinationId: 'synthetic-destination',
        from: state === 'folder' ? 'New folder' : 'My Drive / Old organization', to: state === 'folder' ? 'My Drive / New organization / Partnership / Synthetic course folder' : 'My Drive / Shared administration / New organization / Partnership',
        sharedAncestors: state !== 'folder',
        sourceOwners: state === 'folder' ? 'New folder — no existing path.' : 'My Drive — owner: owner@example.invalid\nOld organization — owner: owner@example.invalid',
        destinationOwners: state === 'folder' ? 'My Drive — owner: owner@example.invalid\nNew organization — owner: owner@example.invalid\nPartnership — owner: owner@example.invalid' : 'My Drive — owner: owner@example.invalid\nShared administration — owner: partner@example.invalid\nNew organization — owner: owner@example.invalid\nPartnership — owner: owner@example.invalid',
        sharedAncestorSummary: state === 'folder' ? '' : '“Shared administration” belongs to partner@example.invalid.',
        accessChanges: state === 'folder' ? 'People with access to the destination may also get access to the new folder.' : 'partner@example.invalid — may gain editing access.\nGroup old-team@example.invalid — may lose some or all viewing access from folders.',
        reviewReason: state === 'folder' ? 'Review who may gain access through folders.' : 'A parent folder belongs to another person. Your approval is required even if the visible access lists look the same.',
        sourceAudience: state === 'folder' ? 'New folder — no existing audience.' : 'Group old-team@example.invalid — Can view',
        destinationAudience: state === 'folder' ? 'Group team@example.invalid — Can edit\nAnyone with the link — Can view' : 'partner@example.invalid — Can edit',
        audience: state === 'folder' ? 'Group team@example.invalid — Can edit\nAnyone with the link — Can view' : 'partner@example.invalid — Can edit\nGroup old-team@example.invalid — Can view',
        impact: state === 'folder' ? 'The new folder may get the destination’s access. There is no existing source file or access to remove. Group members, organization rules and other ways of accessing the folder are not fully visible.' : 'Moving may give people access through the destination folder or remove access they had through the old folder. Existing direct shares stay unchanged. Group members, organization rules and other ways of accessing the file are not fully visible.',
        reviewState: state, exampleOnly: true };
      void bb.ui.requestInput({ threadId, rendererId: 'drive-filing-approval', title: 'Review filing and inherited access (synthetic)',
        payload: state === 'invalid' ? { reviewState: state } : payload,
        describeSubmission: () => ({ title: 'Synthetic filing choice recorded — no Google write' }),
      }).then(result => results.set(threadId, result), () => results.set(threadId, { outcome: 'interrupted' }));
      return { staged: true };
    },
    async result({ threadId }) { return results.get(threadId) ?? null; },
  });
}
