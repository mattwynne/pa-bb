import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createDocsImageService, imageInspectSchema, imageSchema, imageStatusSchema, imageCategory, imageMessage } from './core/docs-image.mjs';
import { createImageAssets } from './adapters/image-asset.mjs';
import { docsFailureCategory } from './core/docs-edit.mjs';
import { docsApprovalDecision, diagnoseDocsApproval } from './core/docs-approval.mjs';
import { failureCategory } from './diagnostic.mjs';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
export const IMAGE_TOOLS = ['gdocs_inspect_images', 'gdocs_insert_image', 'gdocs_image_status', 'gdocs_review_image_example'];
export const imageExample = { exampleOnly: true, account: 'writer@example.test', operationId: '11111111-1111-4111-8111-111111111111',
  documentId: 'synthetic-only', title: 'Synthetic logo insertion — no Google access', expectedRevisionId: 'synthetic-revision',
  tabId: 'main', index: 1, paragraphText: 'Existing wordmark stays here\n', uri: 'https://example.test/logo.png', widthPt: 172.8, heightPt: 25.84,
  asset: { mimeType: 'image/png', bytes: 4096, width: 1600, height: 239, sha256: 'a'.repeat(64) },
  limits: 'Add one inline PNG; delete nothing. No alt-text write or hosting. API readback is not proof of bytes or rendering.' };
export async function reviewImageExample(bb: BbPluginApi, threadId: string, signal?: AbortSignal) {
  let decision;
  try { decision = docsApprovalDecision(await bb.ui.requestInput({ threadId, rendererId: 'docs-image-approval', title: 'Image example — no Google access', payload: imageExample,
    describeSubmission: () => ({ title: 'Image example finished — no write' }) }, { signal })); }
  catch { decision = { outcome: 'approval_unavailable', reason: 'request_failed' }; }
  diagnoseDocsApproval((stage: string) => bb.log.warn(`Google Drive ${stage}`), decision);
  return { ...decision, exampleOnly: true, writeAttempted: false };
}
export function registerDocsImageTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>, approvalRequired = async () => true, assets = createImageAssets()) {
  bb.rpc.register({ docsImageCapabilities: { input: z.null(), output: z.object({ contract: z.literal('docs-inline-png-v1'), format: z.literal('png'), placement: z.literal('paragraph-start'), maxBytes: z.literal(2097152), maxPixels: z.literal(4000000), altTextWrite: z.literal(false), recovery: z.literal('read-only'), approval: z.enum(['required', 'disabled_in_settings']) }) } }, {
    async docsImageCapabilities() { return { contract: 'docs-inline-png-v1' as const, format: 'png' as const, placement: 'paragraph-start' as const, maxBytes: 2097152 as const, maxPixels: 4000000 as const, altTextWrite: false as const, recovery: 'read-only' as const, approval: await approvalRequired() !== false ? 'required' as const : 'disabled_in_settings' as const }; },
  });
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${imageCategory(error)} ${docsFailureCategory(error)} ${failureCategory(error)}`);
  const service = createDocsImageService({ store, drive: adapter.drive, docs: adapter.docs, assets, diagnose, approvalRequired });
  const definitions: Array<{ name: string; parameters: z.ZodType<Record<string, unknown>>; description: string }> = [
    { name: IMAGE_TOOLS[0], parameters: imageInspectSchema, description: 'Inspect complete bounded simple Docs bodies, including inline image placeholders/object IDs, revision and paragraph-start UTF-16 insertion indices. No write. Reject tables, suggestions, headers/footers and other indexed structures; not paragraph-edit proof.' },
    { name: IMAGE_TOOLS[1], parameters: imageSchema, description: 'Preview (default) then insert ONE inline public HTTPS PNG at an inspected explicit-tab paragraph start, preserving existing text/styles. Width18–432pt; aspect preserved. Current required revision, single-use UUIDv4, Docs owner approval policy, no-replay recovery. PNG8-bit RGB/RGBA≤2MiB/4MP, no redirects/private networks/SVG/animation/interlace. No hosting/sharing/replacement/alt-text write. Readback verifies object/sourceURI/size, not bytes/rendering.' },
    { name: IMAGE_TOOLS[2], parameters: imageStatusSchema, description: 'Read-only image-insertion receipt/recovery with SAME account/operationId. Never inserts/retries/rolls back/unlocks. Lost-response matches are observations, not completed writes; unresolved document claims persist.' },
    { name: IMAGE_TOOLS[3], parameters: z.object({}).strict(), description: 'Open fixed synthetic no-op Docs image approval. No Google, URL fetch or document access. Every choice returns exampleOnly and writeAttempted=false.' },
  ];
  for (const definition of definitions) bb.agents.registerTool({ ...definition,
    instructions: definition.name === IMAGE_TOOLS[1] ? 'Only explicit user-requested image insertion. Inspect, preview, apply SAME args/key with preview=false. Existing text is never deleted. Use an already-public PNG; never change sharing, host/convert assets, broaden grants or approval settings. Owner-controlled Docs approval policy cannot be bypassed by arguments. Only verified confirms acknowledged API object/location/source URI/dimensions and preserved original content, NOT image bytes/rendering/alt text. After uncertainty use gdocs_image_status with SAME account/key; never retry, replace key or unlock. Engineering tests never authorize live documents.' : undefined,
    async execute(args, ctx) {
      try {
        let result;
        if (definition.name === IMAGE_TOOLS[3]) result = await reviewImageExample(bb, ctx.threadId, ctx.signal);
        else if (definition.name === IMAGE_TOOLS[0]) result = await service.inspect(args);
        else if (definition.name === IMAGE_TOOLS[2]) result = await service.status(args);
        else result = await service.insert(args, ctx.signal, (payload: Parameters<BbPluginApi['ui']['requestInput']>[0]['payload'], signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'docs-image-approval', title: 'Review Google Docs image insertion', payload,
          describeSubmission: value => ({ title: docsApprovalDecision({ outcome: 'submitted', value }).outcome === 'approved' ? 'Image insertion approved (not yet verified)' : 'Image insertion not approved — no write' }) }, { signal }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) { diagnose(`agent_tool ${definition.name}`, error); return { content: [{ type: 'text' as const, text: imageMessage(error) }], isError: true }; }
    },
  });
}
