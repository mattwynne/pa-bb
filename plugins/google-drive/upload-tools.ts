import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
import { createUploadService, uploadParameters, uploadStatusParameters, uploadMessage, uploadCategory } from './core/upload.mjs';
import { createUploadSource } from './adapters/upload-source.mjs';
import { failureCategory } from './diagnostic.mjs';
export const UPLOAD_TOOLS = ['gdrive_upload_file', 'gdrive_upload_status'];
export function registerUploadTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${uploadCategory(error)} ${failureCategory(error)}`);
  bb.rpc.register({ uploadCapabilities: { input: z.null(), output: z.object({ contract: z.literal('local-upload-v1'), source: z.literal('linux-bb-server-thread-storage'), maxBytes: z.literal(4194304), modes: z.array(z.enum(['binary', 'xlsx_to_sheet', 'docx_to_doc', 'pptx_to_slides'])), approval: z.literal('mandatory'), recovery: z.literal('read-only') }) } }, {
    async uploadCapabilities() { return { contract: 'local-upload-v1' as const, source: 'linux-bb-server-thread-storage' as const, maxBytes: 4194304 as const, modes: ['binary' as const, 'xlsx_to_sheet' as const, 'docx_to_doc' as const, 'pptx_to_slides' as const], approval: 'mandatory' as const, recovery: 'read-only' as const }; },
  });
  const source = createUploadSource({ async location(threadId: string) {
    const [config, location] = await Promise.all([bb.sdk.system.config(), bb.sdk.threads.storageLocation({ threadId })]);
    if (!config.primaryHostId || location.hostId !== config.primaryHostId) throw new Error('Unsupported source host');
    return location.storageRootPath;
  } });
  const service = createUploadService({ store, source, upload: adapter.upload, assessment: adapter.filing, diagnose });
  for (const name of UPLOAD_TOOLS) bb.agents.registerTool({ name,
    parameters: name === 'gdrive_upload_file' ? uploadParameters : uploadStatusParameters,
    description: name === 'gdrive_upload_file'
      ? 'Preview then upload one explicitly requested regular local BB-server thread-storage file (1 byte–4 MiB) to an explicit My Drive folder. Default binary preserves bytes/MIME; explicit xlsx_to_sheet, docx_to_doc or pptx_to_slides imports conservative modern Office files as native Sheets, Docs or Slides, not fidelity-guaranteed. Exact source SHA-256, single-use UUID and mandatory owner review. No remote/client paths, overwrite, directory, sharing or invitations.'
      : 'Read-only recovery of a local-file upload/import with the SAME account and operationId. Matching observations after lost replies do not establish completion. Never retries, repairs, deletes or unlocks uncertain submissions.',
    instructions: 'Only specifically user-requested files/uploads. Preview then apply with exactly the same arguments/key and preview=false. bb-server paths are server thread storage, not the user device. Never scan unrelated files or credentials. Binary is default; conversion must be explicitly requested. Do not change grants/settings/share/invite. Owner must approve exact source/digest/mode/result type/destination/access; contents are not fully rendered. Only verified means acknowledged bounded native structure/text readback, never Office visual fidelity or model correctness. Only modern XLSX/DOCX/PPTX conversions are supported; legacy DOC/PPT, OCR and other conversion formats are unsupported. Fonts/layout, tables/objects, animations and media may differ. Missing API/grant is an owner Settings/setup issue, never permission to broaden scopes. Keep the key after uncertainty and use gdrive_upload_status, never retry or generate a replacement key.',
    async execute(args, ctx) {
      try {
        const approve = (payload: Record<string, string>, signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId,
          rendererId: 'drive-upload-approval', title: 'Review local file upload', payload,
          describeSubmission: value => ({ title: value && typeof value === 'object' && 'approved' in value && value.approved === true ? 'Upload approved — not yet verified' : 'Upload not approved' }),
        }, { signal });
        const result = name === 'gdrive_upload_file' ? await service.submit(args, ctx.signal, approve) : await service.status(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (e) { diagnose('upload_agent_tool', e); return { content: [{ type: 'text' as const, text: uploadMessage(e) }], isError: true }; }
    },
  });
}
