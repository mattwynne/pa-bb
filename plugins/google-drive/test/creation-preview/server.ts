import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['document', 'spreadsheet', 'invalid', 'error']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const payload = state === 'invalid' ? {} : { reviewState: state, account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', destinationId: 'synthetic-folder', path: 'My Drive / Shared partnership / Team', owners: 'My Drive — owner: owner@example.invalid\nTeam — owner: partner@example.invalid', audience: 'Group team@example.invalid — Can edit', title: 'Synthetic project document', mimeType: state !== 'spreadsheet' ? 'application/vnd.google-apps.document' : 'application/vnd.google-apps.spreadsheet', content: state === 'document' ? 'Synthetic opening paragraph.\n\nQuestion one?\nAnswer:' : '[{"title":"Budget","rows":[["Item","Amount"],["Example",{"cad":25}]]}]' };
      void bb.ui.requestInput({ threadId, rendererId: 'drive-creation-approval', title: 'Review shared creation (synthetic)', payload, describeSubmission: () => ({ title: 'Synthetic choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
