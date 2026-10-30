import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { reviewFormatExample } from './docs-format-tools.js';
import { docsApprovalDecision, docsApprovalReceipt, diagnoseDocsApproval } from './core/docs-approval.mjs';

export const DOCS_REVIEW_TOOL = 'gdocs_review_edit_example';
const reviewState = z.enum(['replacement', 'deletion', 'incomplete']);
// Shared by the CLI rendering probe and the native-tool lifecycle probe. There
// is deliberately no adapter/store/account injection into this function.
async function reviewExample(bb: BbPluginApi, threadId: string, state: string, signal?: AbortSignal) {
  const payload = { exampleOnly: true, account: 'writer@example.invalid', documentId: 'example-no-document', title: 'Example only — no Google document',
    tabId: 'example-tab', tabTitle: 'Example introduction', expectedRevisionId: 'example-revision',
    ...(state === 'incomplete' ? {} : { oldText: 'We help teams solve difficult problems.', newText: state === 'deletion' ? '' : 'We help teams collaborate on difficult problems.' }) };
  let decision;
  try {
    decision = docsApprovalDecision(await bb.ui.requestInput({ threadId, rendererId: 'docs-edit-approval', title: 'Docs review example — no document access', payload,
      describeSubmission: () => ({ title: 'Docs review example finished — no write' }),
    }, { signal }));
  } catch { decision = { outcome: 'approval_unavailable', reason: 'request_failed' }; }
  diagnoseDocsApproval((stage: string) => bb.log.warn(`Google Drive ${stage}`), decision);
  return { exampleOnly: true, ...(decision.outcome === 'approved' ? { outcome: 'approved_example', writeAttempted: false }
    : decision.outcome === 'declined' ? { outcome: 'declined_example', reason: decision.reason, writeAttempted: false }
      : docsApprovalReceipt(decision)) };
}

// The review-edit-example handler is disconnected from the Docs adapter: even
// an approval cannot write, request a token, or access a real document. The
// separate editing-access handler only calls the injected scope inspector.
export function registerDocsReview(bb: BbPluginApi, inspectAuthorization: (account: string) => Promise<unknown>) {
  bb.agents.registerTool({ name: DOCS_REVIEW_TOOL,
    description: 'Open a fixed synthetic Google Docs approval card in this thread. Every choice is a no-op: no Google account, document or API is accessed. Use to check native card delivery and deferred results, including after ending the originating turn.',
    parameters: z.object({ state: reviewState.optional() }).strict(),
    async execute({ state }, ctx) {
      const result = await reviewExample(bb, ctx.threadId, state || 'replacement', ctx.signal);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  });
  bb.cli.register(defineCli({ name: 'google-drive', summary: 'Google Drive diagnostics and safe Docs review example', commands: {
    'editing-access': cliCommand({
      summary: 'Check one connected account’s Docs write scope and installed Settings consent capability; no document is accessed or changed.',
      options: { account: { type: 'string', required: true, description: 'Exact connected account email (at most 320 characters).' } },
      async run(input) {
        if (!input.options.account?.trim() || input.options.account.length > 320) throw new PluginCliError('Use one bounded connected account email.', { code: 'invalid_account' });
        return { exitCode: 0, stdout: JSON.stringify(await inspectAuthorization(input.options.account)) };
      },
    }),
    'review-format-example': cliCommand({
      summary: 'Open the synthetic formatting approval card; all choices are no-ops with no Google access.',
      options: { thread: { type: 'string', description: 'Thread for the example; defaults to the invoking thread.' } },
      async run(input, ctx) {
        const threadId = input.options.thread || ctx.threadId;
        if (!threadId) throw new PluginCliError('A thread is required for this review.', { code: 'thread_required', hint: 'Pass --thread with the thread ID where the example should appear.' });
        return { exitCode: 0, stdout: JSON.stringify(await reviewFormatExample(bb, threadId, ctx.signal)) };
      },
    }),
    'review-edit-example': cliCommand({
      summary: 'Open a synthetic Docs approval preview; every choice is a no-op and no Google API is called.',
      options: { thread: { type: 'string', description: 'Thread to show the example in; defaults to the invoking thread.' },
        state: { type: 'enum', values: ['replacement', 'deletion', 'incomplete'], default: 'replacement', description: 'Synthetic review state.' } },
      async run(input, ctx) {
        const threadId = input.options.thread || ctx.threadId;
        if (!threadId) throw new PluginCliError('A thread is required for this review.', { code: 'thread_required', hint: 'Pass --thread with the thread ID where the example should appear.' });
        return { exitCode: 0, stdout: JSON.stringify(await reviewExample(bb, threadId, input.options.state, ctx.signal)) };
      },
    }),
  } }));
}
