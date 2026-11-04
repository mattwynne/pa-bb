import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['replacement', 'delete', 'invalid', 'error']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const payload = state === 'invalid' ? { exampleOnly: true } : { exampleOnly: true, reviewState: state,
        account: 'writer@example.test', documentId: 'doc-rich', title: 'Rich synthetic document', tabId: 'main', tabTitle: 'Main', expectedRevisionId: 'r1', oldText: 'old', newText: state === 'delete' ? '' : 'newer' };
      void bb.ui.requestInput({ threadId, rendererId: 'docs-edit-approval', title: 'Review Google Docs replacement (synthetic)', payload,
        describeSubmission: () => ({ title: 'Synthetic choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
