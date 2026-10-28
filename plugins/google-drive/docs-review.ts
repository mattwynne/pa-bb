import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from '@get-bb/plugin-sdk';

// Deliberately disconnected from the Docs service/adapter: even an approval
// cannot write, request a token, or access a real document. This lets owners
// review the actual host renderer safely without creating a scratch Doc.
export function registerDocsReview(bb: BbPluginApi) {
  bb.cli.register(defineCli({ name: 'google-drive', summary: 'Google Drive diagnostics and safe Docs review example', commands: {
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
