import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export default function plugin(bb: BbPluginApi) {
  bb.rpc.register({ stage: { input: z.object({ threadId: z.string(), state: z.enum(['binary', 'conversion', 'docx', 'pptx', 'invalid', 'error']) }), output: z.object({ staged: z.boolean() }) } }, {
    async stage({ threadId, state }) {
      const extension = state === 'docx' ? 'docx' : state === 'pptx' ? 'pptx' : 'xlsx';
      const mode = state === 'docx' ? 'docx_to_doc' : state === 'pptx' ? 'pptx_to_slides' : state === 'conversion' ? 'xlsx_to_sheet' : 'binary';
      const mimeType = state === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : state === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const resultMime = state === 'docx' ? 'application/vnd.google-apps.document' : state === 'pptx' ? 'application/vnd.google-apps.presentation' : state === 'conversion' ? 'application/vnd.google-apps.spreadsheet' : mimeType;
      const payload = state === 'invalid' ? {} : { reviewState: state, account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', destinationId: 'synthetic-folder', path: 'My Drive / Shared partnership / Team', owners: 'My Drive — owner: owner@example.invalid\nTeam — owner: partner@example.invalid', audience: 'Group team@example.invalid — Can edit', title: `Synthetic editable file.${extension}`, mimeType, resultMime, mode, sourceHost: 'BB server (not your browser/device)', sourcePath: `/synthetic/thread-storage/thr_example/artifacts/model.${extension}`, sourceName: `model.${extension}`, size: '204800', sha256: 'a'.repeat(64), conversion: mode === 'binary' ? 'No conversion — exact bytes.' : mode === 'xlsx_to_sheet' ? '{"tabs":["Budget","Forecast"],"sourceFormulaCount":42}' : '{"primaryTextCharacters":123,"fidelityVerified":false,"sourceLimitBytes":4194304}' };
      void bb.ui.requestInput({ threadId, rendererId: 'drive-upload-approval', title: 'Review local file upload (synthetic)', payload, describeSubmission: () => ({ title: 'Synthetic choice — no Google write' }) }).catch(() => {});
      return { staged: true };
    },
  });
}
