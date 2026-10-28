# Bounded Google Docs editing

`gdocs_read` is unchanged and remains the general, possibly truncated text reader.
Its output **does not authorize edits**. Use the separate complete inspection.

## Tools

1. `gdrive_auth_status` identifies connected accounts (not their write grants).
2. Inspect using an explicit account and document URL/ID:

   ```json
   {"account":"writer@example.com","document":"DOCUMENT_ID"}
   ```

   Call **`gdocs_inspect_for_edit`**. A successful response has `complete: true`,
   `documentId`, opaque `revisionId` and every tab's `tabId`, `title` and exact
   `text`. No pagination, clipping or implicit first-tab fallback is allowed.
3. Call **`gdocs_replace_text`** to preview one literal replacement:

   ```json
   {"account":"writer@example.com","document":"DOCUMENT_ID","tabId":"TAB_ID","expectedRevisionId":"REVISION_FROM_INSPECTION","oldText":"Exact existing paragraph text","newText":"Replacement paragraph text","preview":true}
   ```

   Preview is the default, performs no write and does **not** establish write
   authorization. It returns the exact target and before/after proposal.
4. Repeat the same inputs with `preview: false` only for a user-requested edit.
   The plugin checks write scope, then pauses for BB owner approval of the exact
   document/account/tab/revision/before/after. Decline, cancellation and malformed
   approval values cannot write. `preview: false` is not an approval bypass.
   The service re-inspects after approval. A changed revision is rejected before
   submission; the single provider request also closes the remaining race.
5. Only `outcome: "verified"` confirms the provider's single replacement count
   **and** exact readback of all tab body text at the returned revision. The
   response does not repeat the document contents. It does not independently
   verify formatting or promise that collaborators will not edit it later.

There is no editing CLI, arbitrary Google request proxy, insertion-at-index,
full-document replacement or multi-change batch. For several paragraphs, inspect
and approve each replacement with its current revision. Do not reuse a revision
from another account/document or a previous successful write.

## Supported documents and text

- At most 50,000 UTF-16 code units across at most 16 tabs (including nested tabs),
  within a 1 MiB complete provider response. Oversized reads fail, never truncate.
- Every tab must contain ordinary text paragraphs with contiguous UTF-16 indices.
  Suggestions, tables, tables of contents, headers, footers, footnotes, inline or
  positioned objects, chips, equations and unknown paragraph elements are rejected.
  Missing/malformed tab bodies, missing revision IDs and projected suggestion
  views are rejected. Documents with these features remain readable using
  `gdocs_read` but are not editable through this initial capability.
- Exact, case-sensitive, non-regex `oldText` must occur once in the selected tab
  (overlapping occurrences count as ambiguous) and fit within one text run.
  Matching text in other tabs is not changed. Matching across differently styled
  runs is rejected. Inspection text alone does not expose run boundaries; choose
  a smaller match when necessary.
- Each text is at most 2,000 UTF-16 units; old text cannot be empty. Empty new text
  deletes the match. Newlines, controls, private-use characters, invalid Unicode
  and no-op replacements are rejected. Preserve the paragraph-ending newline by
  **not** including it in the match. No new paragraph structure is generated.
- Google handles formatting inheritance for `replaceAllText`. Existing paragraph
  boundaries and unrelated content are retained; exact replacement styling is
  not guaranteed. Review styling in Docs if it matters.

## Safe rendered review (no Google document)

Run `bb google-drive review-edit-example --thread THREAD_ID` to open the actual
BB approval renderer with fixed synthetic data. Every choice, including Approve,
is a no-op; the command has no Docs service/adapter reference and calls no Google
API. It is clearly labelled **Example only**, has no live document link and
returns `writeAttempted: false`. Use `--state deletion` or `--state incomplete`
to review deletion and fail-closed missing-data states. Decline and **Cancel
review** exercise both termination paths. This is not a live authorization or
provider-write test. It exists so rendered review needs neither real document
content nor creation of a scratch document.

## Google API and concurrency

Inspection uses `documents.get` with `includeTabsContent=true` and
`suggestionsViewMode=SUGGESTIONS_INLINE`, without a field mask. It checks Drive
metadata for the native Google Doc type and verifies token identity against the
explicit connected account. Revision IDs are only provided to document editors.

The only mutation is `documents.batchUpdate` with:

```json
{"writeControl":{"requiredRevisionId":"REVISION_FROM_INSPECTION"},"requests":[{"replaceAllText":{"containsText":{"text":"OLD","matchCase":true,"searchByRegex":false},"replaceText":"NEW","tabsCriteria":{"tabIds":["TAB_ID"]}}}]}
```

Never use `targetRevisionId`: that permits collaborator-change reconciliation.
`requiredRevisionId` rejects a non-current revision. Numeric indices are validated
using JavaScript string lengths (UTF-16, not Unicode code-point counts), but are
**not** submitted for editing. Literal matching avoids offset conversion errors
around emoji. All tabs must be inspected because native replacements otherwise
can have broader scope; this request always supplies one explicit tab ID.

Google may reject stale or otherwise invalid requests with HTTP 400. The plugin
reports a definitive rejection without assuming every 400 proves a revision
conflict. It never retries a mutation (including 401, 429, 5xx, timeout, malformed
success responses or transport loss). A transport/server error can mean the
write happened: `uncertain` is not failure. A successful provider response with
failed/concurrent readback returns `verification_unavailable`, not `verified`.
Both set `retrySafe: false`. Inspect the document and reconcile the observed text
before proposing a new change; never blindly replay or roll back.

## Authorization and deployment

This feature **does not change OAuth scopes or upgrade existing grants**. It
accepts an existing owner-authorized `drive.file`, `documents` or `drive` write
grant, as required by Google's Docs API. `drive.file` also requires the file to
have been explicitly granted to the app. Read-only grants cannot mutate Docs.
A connected account or successful preview proves neither write scope nor file
edit authorization. Scope and identity are checked before approval and again
immediately before the mutation.

Run `bb google-drive editing-access --account ACCOUNT_EMAIL` for a document-free
check of `writeGrant` (`present`, `missing`, `unknown_account` or `unavailable`)
and `settingsCanRequestWrite`. It uses the plugin's verified authorization port;
no token values are returned, no document is read or changed, and document edit
permission remains `not_checked`. `unavailable` is not proof of a missing grant.
When the grant is missing and `settingsCanRequestWrite` is false, reconnecting
cannot fix it: a separately approved write-consent implementation must first be
delivered. When Settings can request write access, the owner removes/reconnects
the account in Google Drive Settings and explicitly approves the offered grant
at Google. Removing the local connection does not revoke Google's grant.

Any additional grant must be explicitly approved by the account owner through
supported BB Settings and Google's consent screen. Reconnecting to a read-only
flow cannot grant write access. Do not manually handle tokens, share credentials
in chat, change sharing, extract cookies or broaden scopes as a workaround.
OAuth-consent changes are a separate delivery decision; installing these tools
alone does not make a read-only account ready to write.

Build/typecheck/tests are not evidence of running code. Use the repository's
supported deployment lifecycle, preserving plugin identity, settings and data.
Verify the installed source and perform a harmless read before declaring it
applied. Review the approval renderer in BB at desktop/narrow widths and with
keyboard navigation before claiming that UX gate complete. Mock/SSR tests do not
replace rendered review. No live write or new document is required for testing.

## Diagnostics

Failures are logged once at the handling tool boundary, or as the handled
`docs_write_uncertain` / `docs_write_verification` outcome. Logs contain fixed
stage/category names and validated HTTP status where available, never arguments,
account addresses, document IDs/text, tokens, exception messages, provider bodies
or stacks. `scope_required`, `stale_revision`, `write_rejected`,
`unsupported_document` and authorization failures are distinct from connection
availability. Diagnostics establish which boundary failed, not whether an
uncertain write reached Google. There is no automatic recovery/replay service.

References: [Docs get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get),
[batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate),
[WriteControl](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#WriteControl),
[replaceAllText](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#ReplaceAllTextRequest).
