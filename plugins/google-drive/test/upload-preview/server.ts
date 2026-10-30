import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['binary', 'conversion', 'invalid', 'error']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const payload = state === 'invalid' ? {} : { reviewState: state, account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', destinationId: 'synthetic-folder', path: 'My Drive / Shared partnership / Team', owners: 'My Drive — owner: owner@example.invalid\nTeam — owner: partner@example.invalid', audience: 'Group team@example.invalid — Can edit', title: 'Synthetic financial model.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mode: state === 'conversion' ? 'xlsx_to_sheet' : 'binary', sourceHost: 'BB server (not your browser/device)', sourcePath: '/synthetic/thread-storage/thr_example/artifacts/model.xlsx', sourceName: 'model.xlsx', size: '204800', sha256: 'a'.repeat(64), conversion: state === 'conversion' ? '{"tabs":["Budget","Forecast"],"sourceFormulaCount":42}' : 'No conversion — exact bytes.' };
      void bb.ui.requestInput({ threadId, rendererId: 'drive-upload-approval', title: 'Review local file upload (synthetic)', payload, describeSubmission: () => ({ title: 'Synthetic choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
