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
        accessChanges: state === 'folder' ? 'Destination visible audiences may inherit access to the new folder.' : 'user: partner@example.invalid — may gain/increase to writer\ngroup: old-team@example.invalid — may lose/reduce inherited reader access',
        reviewReason: state === 'folder' ? 'Review the visible inherited-access impact.' : 'An inspected ancestor belongs to another person. Exact owner approval is required even if visible audiences appear equivalent.',
        sourceAudience: state === 'folder' ? 'New folder — no existing audience.' : 'Only the owner principal appeared in the current listing.',
        destinationAudience: 'group: team@example.invalid — writer\nAnyone with the link — reader',
        audience: 'group: team@example.invalid — writer\nAnyone with the link — reader',
        impact: state === 'folder' ? 'The new folder may inherit destination access. There is no existing source audience to lose access. Group membership and other access routes are not exhaustively visible.' : 'Google re-evaluates inherited access. Destination audiences may gain access; source-only inherited audiences may lose it. Group membership and other access routes are not exhaustively visible.',
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
