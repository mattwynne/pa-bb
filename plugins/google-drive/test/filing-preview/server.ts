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
      const payload = { kind: state === 'folder' ? 'folder' : 'move', account: 'owner@example.invalid', title: 'Synthetic partnership draft — existing document with a long title',
        operationId: '11111111-1111-4111-8111-111111111111', fileId: 'synthetic-doc', destinationId: 'synthetic-destination',
        from: state === 'folder' ? 'New folder' : 'My Drive / Old organization', to: 'My Drive / New organization / Partnership',
        sourceAudience: state === 'folder' ? 'New folder — no existing audience.' : 'Only the owner principal appeared in the current listing.',
        destinationAudience: 'group: team@example.invalid — writer\nAnyone with the link — reader',
        audience: 'group: team@example.invalid — writer\nAnyone with the link — reader',
        impact: 'Google re-evaluates inherited access. Destination audiences may gain access; source-only inherited audiences may lose it. Group membership and other access routes are not exhaustively visible.',
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
