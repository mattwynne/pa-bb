import { z } from 'zod';
import { category, fail, message } from './diagnostic.mjs';
import { readGmailJson } from './email-archive.js';

const documentId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const docsSuggestionsInput = z.object({ account: z.email().max(320), document_id: documentId }).strict();

const suggestionStatus = z.enum(['OPEN', 'ACCEPTED', 'REJECTED']);
const documentMetadata = z.object({
  documentId,
  suggestions: z.array(z.object({
    suggestionId: z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/),
    status: suggestionStatus.nullish().catch(null),
    headPost: z.object({
      author: z.object({ displayName: z.string().nullish(), anonymous: z.boolean().nullish() }).nullish(),
    }).nullish(),
  })).max(1000).default([]),
});

const fields = 'documentId,suggestions(suggestionId,headPost(author(displayName,anonymous)),status)';

export function docsSuggestionFailureMessage(error: unknown) {
  switch (category(error)) {
    case 'account_missing':
    case 'configuration':
    case 'authorization':
    case 'identity':
      return message(error);
    case 'docs_forbidden':
      return 'Google denied access to suggestion metadata. Check whether the selected account can view comments on this document.';
    case 'docs_not_found':
      return 'Google could not find this document for the selected account. Check the document ID and its sharing settings.';
    case 'docs_rate_limited':
      return 'Google rate-limited the suggestion read. Try again later.';
    default:
      return 'Google Docs suggestion metadata could not be verified. Check the document and try again.';
  }
}

export function docsSuggestions(access: (account: string) => Promise<string>, request: typeof fetch = fetch) {
  return async ({ account, document_id }: z.infer<typeof docsSuggestionsInput>, signal: AbortSignal) => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    const token = await access(account);
    signal.throwIfAborted();
    const query = new URLSearchParams({
      commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
      suggestionsViewMode: 'SUGGESTIONS_INLINE',
      includeTabsContent: 'true',
      fields,
    });
    const response = await request(`https://docs.googleapis.com/v1/documents/${document_id}?${query}`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
    }).catch(() => {
      signal.throwIfAborted();
      return fail('docs_transport');
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      switch (response.status) {
        case 401: return fail('authorization');
        case 403: return fail('docs_forbidden');
        case 404: return fail('docs_not_found');
        case 429: return fail('docs_rate_limited');
        default: return fail('provider_error');
      }
    }
    const payload = await readGmailJson(response, 512 * 1024).catch(() => {
      signal.throwIfAborted();
      return fail('docs_invalid_response');
    });
    signal.throwIfAborted();
    const parsed = documentMetadata.safeParse(payload);
    if (!parsed.success || parsed.data.documentId !== document_id) return fail('docs_invalid_response');
    const { suggestions } = parsed.data;
    if (new Set(suggestions.map(({ suggestionId }) => suggestionId)).size !== suggestions.length)
      return fail('docs_invalid_response');

    return {
      documentId: parsed.data.documentId,
      suggestions: suggestions.map(({ suggestionId, status, headPost }) => {
        const author = headPost?.author;
        const authorDisplayName = author?.anonymous ? null
          : author?.displayName?.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 320) || null;
        return {
          suggestionId, status: status ?? null, authorDisplayName,
          attribution: author?.anonymous ? 'anonymous' : authorDisplayName ? 'available' : 'unavailable',
        };
      }),
    };
  };
}
