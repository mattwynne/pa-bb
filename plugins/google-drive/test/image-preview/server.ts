import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['image', 'long', 'invalid', 'error', 'busy']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const payload = state === 'invalid' ? {} : { reviewState: state, exampleOnly: true, account: 'writer@example.test', operationId: '11111111-1111-4111-8111-111111111111',
        documentId: 'synthetic-only', title: 'Synthetic image review — no Google access', expectedRevisionId: 'synthetic-revision', tabId: 'main', index: 1,
        paragraphText: state === 'long' ? 'Existing wordmark stays. '.repeat(20) : 'Existing wordmark stays here\n',
        uri: state === 'long' ? `https://example.test/${'long-public-artwork-name-'.repeat(30)}.png` : 'https://example.test/logo.png', widthPt: 172.8, heightPt: 25.84,
        asset: { mimeType: 'image/png', bytes: 4096, width: 1600, height: 239, sha256: 'a'.repeat(64) },
        limits: 'One additive inline PNG. No wordmark deletion, alt-text write or hosting. API readback is not proof of embedded bytes or rendering.' };
      void bb.ui.requestInput({ threadId, rendererId: 'docs-image-approval', title: 'Review inline image (synthetic)', payload,
        describeSubmission: () => ({ title: 'Synthetic image choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
