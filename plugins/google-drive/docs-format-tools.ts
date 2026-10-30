import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { createDocsFormatService, formatSchema, formatInspectSchema, formatStatusSchema, formatCategory, formatMessage } from './core/docs-format.mjs';
import { docsFailureCategory } from './core/docs-edit.mjs';
import { docsApprovalDecision, diagnoseDocsApproval } from './core/docs-approval.mjs';
import { failureCategory } from './diagnostic.mjs';
import type { createBbStore } from './adapters/bb-store.mjs';
import type { createGoogleAdapter } from './adapters/google.mjs';
export const FORMAT_TOOLS = ['gdocs_inspect_formatting', 'gdocs_format_document', 'gdocs_formatting_status', 'gdocs_review_format_example'];
export const formatExample = {
  exampleOnly: true, account: 'writer@example.test', operationId: '11111111-1111-4111-8111-111111111111', documentId: 'synthetic-only',
  title: 'Synthetic formatting review — no Google access', expectedRevisionId: 'synthetic-revision',
  selections: [{ tabId: 'main', startIndex: 1, endIndex: 20, textStyle: { fontFamily: 'Inter', sizePt: 18, bold: true, foregroundColor: '#17221C' },
    paragraphStyle: { spaceAbovePt: 18, spaceBelowPt: 6 }, paragraphs: [{ tabId: 'main', startIndex: 1, endIndex: 20, text: 'A synthetic heading\n',
      paragraphStyle: {}, runs: [{ startIndex: 1, endIndex: 20, textStyle: {} }] }] }],
  page: { before: { pageSize: { width: { magnitude: 595, unit: 'PT' }, height: { magnitude: 842, unit: 'PT' } } },
    after: { tabId: 'main', size: 'LETTER', marginTopPt: 61.2, marginBottomPt: 61.2, marginLeftPt: 61.2, marginRightPt: 61.2 } },
  limits: 'Only listed properties change. Fonts are API names, not proof of rendering or availability. No text changes.',
};
export const formatReviewState = z.enum(['formatting', 'background']);
const backgroundExample = { ...formatExample, selections: [], page: { before: formatExample.page.before,
  after: { tabId: 'main', backgroundColor: '#F4F1E8' } } };
// Shared native/CLI probe: no store, adapter, account or provider path.
export async function reviewFormatExample(bb: BbPluginApi, threadId: string, signal?: AbortSignal, state = 'formatting') {
  let decision;
  try {
    decision = docsApprovalDecision(await bb.ui.requestInput({ threadId, rendererId: 'docs-format-approval',
      title: 'Formatting example — no Google access', payload: state === 'background' ? backgroundExample : formatExample,
      describeSubmission: () => ({ title: 'Formatting example finished — no write' }),
    }, { signal }));
  } catch { decision = { outcome: 'approval_unavailable', reason: 'request_failed' }; }
  diagnoseDocsApproval((stage: string) => bb.log.warn(`Google Drive ${stage}`), decision);
  return { ...decision, exampleOnly: true, writeAttempted: false };
}
export function registerDocsFormatTools(bb: BbPluginApi, store: ReturnType<typeof createBbStore>, adapter: ReturnType<typeof createGoogleAdapter>, approvalRequired = async () => true) {
  const diagnose = (stage: string, error: unknown) => bb.log.warn(`Google Drive ${stage} ${formatCategory(error)} ${docsFailureCategory(error)} ${failureCategory(error)}`);
  const service = createDocsFormatService({ store, drive: adapter.drive, docs: adapter.docs, diagnose, approvalRequired });
  const definitions: Array<{ name: string; parameters: z.ZodType<Record<string, unknown>>; description: string }> = [
    { name: FORMAT_TOOLS[0], parameters: formatInspectSchema, description: 'Inspect complete bounded simple Docs paragraphs with UTF-16 ranges, explicit styles, tab page styles, named inheritance and revision. No edit proof from the general reader. Rejects unsupported structures.' },
    { name: FORMAT_TOOLS[1], parameters: formatSchema, description: 'Preview (default) or apply under the owner’s Docs approval setting: bounded whole-paragraph font/size/bold/colour, spacing/alignment and explicit-tab page colour/Letter size/margins. Omitted page properties are preserved. Opaque hex #RRGGBB only. Required revision, exact API readback, single-use key and read-only recovery. No text, named-style definitions, tables, headers or footers.' },
    { name: FORMAT_TOOLS[2], parameters: formatStatusSchema, description: 'Read-only recovery of a saved Docs formatting operation. Same account and operationId; never retries writes. Exact current matches after lost responses are observations, not proof the request finished; unresolved locks remain.' },
    { name: FORMAT_TOOLS[3], parameters: z.object({ state: formatReviewState.optional() }).strict(), description: 'Open a fixed synthetic Docs formatting or page-background approval card. All choices are no-ops; no Google access. Used only for rendered UI review.' },
  ];
  for (const definition of definitions) bb.agents.registerTool({ ...definition,
    instructions: definition.name === FORMAT_TOOLS[1] ? 'Only user-requested formatting. Page backgroundColor is opaque #RRGGBB for an explicit tab; omit size/margins to preserve them. It is not paragraph shading. Owner approval is required by default; the owner can disable it globally in Google Drive Settings. Do not change that setting yourself. Tool arguments cannot override policy. Preview is not completion. Only verified confirms API readback, never actual font rendering. Retain operationId; after uncertainty use gdocs_formatting_status, never replay or replace its key.' : undefined,
    async execute(args, ctx) {
      const approve = (payload: Parameters<BbPluginApi['ui']['requestInput']>[0]['payload'], signal?: AbortSignal) => bb.ui.requestInput({ threadId: ctx.threadId, rendererId: 'docs-format-approval',
        title: 'Review Google Docs formatting', payload, describeSubmission: value => ({ title: docsApprovalDecision({ outcome: 'submitted', value }).outcome === 'approved'
          ? 'Docs formatting approved (not yet verified)' : 'Docs formatting not approved — no write' }) }, { signal });
      try {
        let result;
        if (definition.name === FORMAT_TOOLS[3]) {
          result = await reviewFormatExample(bb, ctx.threadId, ctx.signal, formatReviewState.optional().parse(args.state) || 'formatting');
        } else if (definition.name === FORMAT_TOOLS[0]) result = await service.inspect(args);
        else if (definition.name === FORMAT_TOOLS[2]) result = await service.status(args);
        else {
          // One service instance holds active-operation state across all calls.
          result = await service.format(args, ctx.signal, approve);
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        diagnose(`agent_tool ${definition.name}`, error);
        return { content: [{ type: 'text' as const, text: formatMessage(error) }], isError: true };
      }
    },
  });
}
