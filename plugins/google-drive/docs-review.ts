import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from '@get-bb/plugin-sdk';

// The review-edit-example handler is disconnected from the Docs adapter: even
// an approval cannot write, request a token, or access a real document. The
// separate editing-access handler only calls the injected scope inspector.
export function registerDocsReview(bb: BbPluginApi, inspectAuthorization: (account: string) => Promise<unknown>) {
  bb.cli.register(defineCli({ name: 'google-drive', summary: 'Google Drive diagnostics and safe Docs review example', commands: {
    'editing-access': cliCommand({
      summary: 'Check one connected account’s Docs write scope and installed Settings consent capability; no document is accessed or changed.',
      options: { account: { type: 'string', required: true, description: 'Exact connected account email (at most 320 characters).' } },
      async run(input) {
        if (!input.options.account?.trim() || input.options.account.length > 320) throw new PluginCliError('Use one bounded connected account email.', { code: 'invalid_account' });
        return { exitCode: 0, stdout: JSON.stringify(await inspectAuthorization(input.options.account)) };
      },
    }),
    'review-edit-example': cliCommand({
      summary: 'Open a synthetic Docs approval preview; every choice is a no-op and no Google API is called.',
      options: { thread: { type: 'string', description: 'Thread to show the example in; defaults to the invoking thread.' },
        state: { type: 'enum', values: ['replacement', 'deletion', 'incomplete'], default: 'replacement', description: 'Synthetic review state.' } },
      async run(input, ctx) {
        const threadId = input.options.thread || ctx.threadId;
        if (!threadId) throw new PluginCliError('A thread is required for this review.', { code: 'thread_required', hint: 'Pass --thread with the thread ID where the example should appear.' });
        const payload = { exampleOnly: true, account: 'writer@example.invalid', documentId: 'example-no-document', title: 'Example only — no Google document',
          tabId: 'example-tab', tabTitle: 'Example introduction', expectedRevisionId: 'example-revision',
          ...(input.options.state === 'incomplete' ? {} : { oldText: 'We help teams solve difficult problems.', newText: input.options.state === 'deletion' ? '' : 'We help teams collaborate on difficult problems.' }) };
        const result = await bb.ui.requestInput({ threadId, rendererId: 'docs-edit-approval', title: 'Docs review example — no document access', payload,
          describeSubmission: () => ({ title: 'Docs review example finished — no write' }),
        }, { signal: ctx.signal });
        const approved = result.outcome === 'submitted' && Boolean(result.value && typeof result.value === 'object' && 'approved' in result.value && result.value.approved === true);
        return { exitCode: 0, stdout: JSON.stringify({ exampleOnly: true, outcome: result.outcome === 'cancelled' ? 'cancelled' : approved ? 'approved_example' : 'declined_example', writeAttempted: false }) };
      },
    }),
  } }));
}
