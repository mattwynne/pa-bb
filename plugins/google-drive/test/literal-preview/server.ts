import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['replacement', 'delete', 'invalid', 'error', 'section', 'section-error']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const payload = state === 'invalid' ? { exampleOnly: true } : { exampleOnly: true, reviewState: state,
        account: 'writer@example.test', documentId: 'doc-rich', title: 'Rich synthetic document', tabId: 'main', tabTitle: 'Main', expectedRevisionId: 'r1', oldText: state.startsWith('section') ? 'Old background paragraph.\nOld conclusion.' : 'old', newText: state.startsWith('section') ? 'A clearer introduction.\nNew supporting prose.\nA short conclusion.' : state === 'delete' ? '' : 'newer',
        ...(state.startsWith('section') ? {kind:'section',heading:'Project background',startIndex:42,endIndex:83,formatting:'Retain the heading and last body newline. Replace all body prose; paragraph count may change. New paragraphs retain the uniform original text and normal paragraph styles.'} : {}) };
      void bb.ui.requestInput({ threadId, rendererId: 'docs-edit-approval', title: 'Review Google Docs replacement (synthetic)', payload,
        describeSubmission: () => ({ title: 'Synthetic choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
