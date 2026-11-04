# Bounded Google Docs editing

`gdocs_read` remains the general text projection reader, separate from edit inspection. Follow its single-use `nextCursor` pages in the same thread to consume a bounded snapshot; it never supplies edit proof. Its separate 8 MiB provider JSON limit still applies.
Its output **does not authorize edits**. Use the separate complete inspection.

## Tools

1. `gdrive_auth_status` identifies connected accounts (not their write grants).
2. Inspect using an explicit account and document URL/ID:

   ```json
   {"account":"writer@example.com","document":"DOCUMENT_ID"}
   ```

   Call **`gdocs_inspect_for_edit`**. A successful response has `complete: true`,
   `documentId`, opaque `revisionId` and every tab's `tabId`, `title` and body
   `text`. Rich results identify `profile: "body-literal/1"` and explicitly
   describe the projection: table body text is included; non-text inline objects
   use U+FFFC placeholders. Only ordinary top-level body paragraphs are eligible
   edit targets. No pagination, clipping or implicit first-tab fallback is allowed.
3. Call **`gdocs_replace_text`** to preview one literal replacement:

   ```json
   {"account":"writer@example.com","document":"DOCUMENT_ID","tabId":"TAB_ID","expectedRevisionId":"REVISION_FROM_INSPECTION","oldText":"Exact existing paragraph text","newText":"Replacement paragraph text","preview":true}
   ```

   Preview is the default, performs no write and does **not** establish write
   authorization. It returns the exact target and before/after proposal.
4. Repeat the same inputs with `preview: false` only for a user-requested edit.
   The plugin checks write scope and the current global approval setting. By
   default it pauses for BB owner approval of the exact document/account/tab/
   revision/before/after. Decline, cancellation and malformed approval values
   cannot write. Only the owner can opt out of per-edit cards in plugin Settings;
   tool arguments cannot override that policy. The service re-inspects in both
   modes. A changed revision is rejected before submission; the single provider
   request also closes the remaining race.
5. Only `outcome: "verified"` confirms the applicable readback contract at the
   acknowledged revision. Legacy plain-document replacements retain their
   single replacement-count + all-tab body-text contract (formatting is not
   independently verified). Rich body-literal edits verify requested text,
   selected stored styles, UTF-16 coordinate changes and preservation of the
   remaining raw document, including tables and logos, with the narrow documented
   normalization rules below. Neither verifies image bytes, visual rendering,
   attribution or later collaborator changes. The response
   does not repeat the document contents.

There is no editing CLI, arbitrary Google request proxy, insertion-at-index,
full-document replacement or multi-change batch. For unrelated literal matches,
inspect and approve each with its current revision. One compatible prose section
can instead use the bounded heading operation below. Do not reuse a revision
from another account/document or a previous successful write.

## Replace prose under a heading

`gdocs_inspect_for_edit` also returns top-level native `headings: [{text, level}]` in each
tab. For a user-requested rewrite, preview:

```json
{"account":"writer@example.com","document":"DOCUMENT_ID","tabId":"TAB_ID","expectedRevisionId":"REVISION_FROM_INSPECTION","heading":"Background","newText":"A clearer introduction.\nA short conclusion.","preview":true}
```

Call **`gdocs_replace_section`** with the identical inputs and `preview:false`
to apply under the existing owner-controlled Docs approval setting. A heading
must match exactly once in the explicit tab and use native HEADING_1–HEADING_6;
manually bold text is not a heading. Retain the heading; replace its body up to
the next same-or-higher heading or tab end. Nested headings in that range refuse.

Initial `heading-prose/1` profile:
- Nonempty ordinary prose only, no blank existing/new paragraphs. Old/new prose
  at most 2000 UTF-16 units; heading at most 256. New prose uses LF between
  paragraphs, no final LF, controls, private-use characters or malformed Unicode.
- All affected text runs have identical supported direct text styles (the
  literal style profile above), including newline runs. All paragraph styles
  are identical modulo absent/explicit `direction: LEFT_TO_RIGHT`, with
  inherited or `namedStyleType: NORMAL_TEXT` only. Direction is not inherited;
  its documented omitted default is LTR, which the batch explicitly restores.
  RTL and other paragraph-style properties refuse. Custom spacing, indents/alignment, mixed rich styles, lists, links, tables,
  objects and unknown paragraph metadata in the range refuse before POST.
- Supported tables/logos/other tabs outside the section stay intact. Existing
  suggestion/header/footnote/registry inspection restrictions still apply.
- The last original body newline is retained, even at tab end. Deletion excludes
  it, insertion has no final LF, and supported stored text and normal paragraph
  styles are restored in the same required-revision batch. Differing paragraph
  counts are supported without merging or restyling the next heading. Empty or
  no-body sections and empty replacement are refused; no multi-stage workaround.
- Preview and approval identify the heading, complete before/after prose,
  internal end-exclusive UTF-16 range and formatting consequences. No public
  raw-index input exists. Literal approval keeps its original boundary promise;
  section approval explicitly says paragraph count may change.
- Only `verified` establishes acknowledged exact prose/styles plus complete
  untouched raw structure with justified UTF-16 shifts and the same narrow
  image-read-URI/direct-font normalization as rich literal editing, plus
  absent/explicit default LTR only on replaced body paragraphs. The known-parent
  text inheritance rule below applies to the styled section body, including
  its last newline; headings and other content remain exact. It does not
  certify rendering or later collaborator state. Fresh revision/source, account,
  scope, owner policy and durable writer exclusion reuse the existing flow.
  Unknown responses or ACK plus drift remain held. Matching content cannot
  create acknowledgement or authorize retry, rollback or forced unlock.

This is section prose replacement, not general document restructuring. Live
Google section-write correctness has not been tested; synthetic independent
wire/readback fixtures and disposable BB approvals are separate evidence.

## Global per-edit approval setting

In **Settings → Plugins → Google Drive → Configuration**, the owner can turn
**Require approval for Google Docs edits** off. It defaults to **on**, including
for existing installations. Off authorizes agents to apply edits the user
requests without another card, across **all documents and connected accounts**.
This does not authorize unsolicited edits, add Google access, bypass scope/file
permission checks, or change approval for copying or other plugins.

The bounded [formatting tools](formatting.md) follow this same setting for
user-requested appearance changes. Turning it off skips only the approval card;
formatting retains its revision guard, durable operation key and exact readback.

The plugin reads this setting for each write; changes need no reload or new
agent session. Missing/invalid values require approval, and a failed settings
read prevents the write. Disabling it does not auto-approve an already open
card: finish or cancel that review. If approval is re-enabled by the policy
recheck after inspection, that no-card call stops with `approval_required` before
entering provider submission. Changing the setting does not cancel an already
in-flight provider operation or undo a submitted write. Settings changes never
replay a write.

Preview still performs no write. Unique-match validation, required revision,
post-change verification and the no-retry rule remain mandatory. Write receipts
report `approval: "owner_approved"` or `"disabled_in_settings"`; neither alone
proves completion—require `outcome: "verified"`. Agents must not change this
setting on the owner's behalf unless separately explicitly requested.

## Supported documents and text

- At most 50,000 UTF-16 code units across at most 16 tabs (including nested tabs),
  within a 1 MiB complete provider response. Oversized reads fail, never truncate.
- Plain documents keep the original text-only profile. The rich body-literal
  profile permits tables and logos elsewhere, including after a length-changing
  edit. The target must be in one ordinary top-level body paragraph with valid
  scalar/UTF-16 coordinates; it cannot be inside a table, chip or object.
- Suggestions, headers, footers, footnotes, malformed/incomplete tabs and
  projected suggestion views are refused. Index-bearing named ranges,
  bookmarks/comment anchors and unknown tab/body structures affecting the chosen
  tab are unsupported. No table or object is authored by this operation.
- Exact, case-sensitive, non-regex `oldText` must occur once in the selected tab
  (overlapping occurrences count as ambiguous) and fit within one text run.
  Matching text in other tabs is not changed. Matching across differently styled
  runs is rejected. Inspection text alone does not expose run boundaries; choose
  a smaller match when necessary.
- Each text is at most 2,000 UTF-16 units; old text cannot be empty. Empty new text
  deletes the match. Newlines, controls, private-use characters, invalid Unicode
  and no-op replacements are rejected. Preserve the paragraph-ending newline by
  **not** including it in the match. No new paragraph structure is generated.
- The affected paragraph's text runs must use supported stored styles (including
  neighboring runs that can supply insertion inheritance); links or unknown
  style fields there are refused before dispatch. Partial styles are allowed:
  booleans, RGB
  foreground/background colour, positive PT font size, font family with optional
  documented weight, and baseline offset. Affected links and unknown/invalid
  style fields are refused. Explicit empty OptionalColor objects stay transparent;
  missing properties are reset to inheritance, not filled with guesses. In the
  affected paragraph only, an explicitly named direct font's omitted weight is
  equivalent to Google's documented 400. Missing whole font properties are not
  invented. Untouched paragraphs/tabs, named definitions and opaque metadata
  remain exact. For supported text fields except non-inheriting links, an
  explicit direct value and an inherited omission may compare equal only when
  unchanged, unambiguous same-tab NORMAL_TEXT/named-style definitions explicitly
  prove that parent value. An absent property with an unknown editor default
  remains unknown. This additional rule applies only inside newly inserted
  literal text, never its untouched prefix, suffix or newline. Missing named
  style type/definitions, malformed/ambiguous parent definitions and changed
  effective values do not acquire a guessed equivalence. Parent definitions
  themselves remain exact. Provider run coalescing with equivalent stored styles is allowed;
  unexplained style materialization/drift fails verification.
- Image `contentUri` is a requester-tagged read URL with a documented default
  lifetime of 30 minutes, not image identity. It may differ between observations
  only at the same known inline/positioned image-object slot when both values
  are present. Object IDs, source URI, geometry, other properties and opaque
  fields remain checked. Missing image fields, content/source changes or a
  different revision are not normalized. No embedded image-byte claim is made.
- Legacy `replaceAllText` still uses Google's formatting inheritance and keeps
  its text-only guarantee. Rich edits explicitly restore selected stored style
  properties in the same revision-guarded batch. Neither changes paragraph
  boundaries or certifies font rendering.

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

The CLI is only a rendering/routing probe: its form is cancelled if its HTTP
caller disconnects. It does **not** test a native agent tool's deferred lifecycle.
For that test, call **`gdocs_review_edit_example`** with `{}` (or `state` set to
`deletion` / `incomplete`). This tool uses only the same fixed synthetic payload;
there is no account/store/Google adapter path. Keep the test in its originating
thread. When BB returns its waiting notice, end the originating turn, then have
the owner open that thread in ordinary BB chat and confirm card visibility on
the actual desktop/mobile client before making a synthetic choice. Verify the
separate result has `exampleOnly: true` and `writeAttempted: false`. Test timeout
and stop/reload separately; never use a live document to exercise these paths.
A narrow browser viewport is not proof of delivery to a phone.

Native tool forms are independent of turn completion. The current SDK detaches
the tool's request cancellation once the form opens; thread stop/delete or plugin
disposal still interrupts it. The default review timeout is ten minutes. A waiting
notice means the host accepted a pending request, **not** that a client rendered
it. `bb thread interactions list THREAD_ID --json` lists current pending requests,
not historical decisions. After a request disappears, use its ID with
`bb thread interactions show INTERACTION_ID THREAD_ID --json` or inspect the
thread's `system/interaction/lifecycle` events. Inspect only lifecycle fields
when diagnosing: payloads can contain private document text.

`gdocs_replace_text` returns `declined` / `owner_declined` only for an explicit
false approval, `cancelled` with the host reason for a cancelled review, and
`approval_unavailable` for malformed responses or request setup failure. A
`timeout` is **not** owner rejection and does not establish UI visibility.
`plugin-disposed`, `thread-stopped`, `thread-deleted`, `server-restarted` and
`request-aborted` remain distinct; `caller_aborted` means only that the caller
signal stopped before write submission. Every such receipt has
`writeAttempted: false`. No review is retried automatically. Check card delivery
with the no-op native tool before asking for a fresh live proposal.

## Google API and concurrency

Inspection uses `documents.get` with `includeTabsContent=true` and
`suggestionsViewMode=SUGGESTIONS_INLINE`, without a field mask. It checks Drive
metadata for the native Google Doc type and verifies token identity against the
explicit connected account. Revision IDs are only provided to document editors.

Both profiles use one `documents.batchUpdate`. Legacy plain documents retain:

```json
{"writeControl":{"requiredRevisionId":"REVISION_FROM_INSPECTION"},"requests":[{"replaceAllText":{"containsText":{"text":"OLD","matchCase":true,"searchByRegex":false},"replaceText":"NEW","tabsCriteria":{"tabIds":["TAB_ID"]}}}]}
```

Never use `targetRevisionId`: that permits collaborator-change reconciliation.
`requiredRevisionId` rejects a non-current revision. Legacy plain requests do not submit numeric indices. Rich requests use the
inspected literal's exact UTF-16 range for delete + insert + supported stored-style
restoration (deletion alone needs only delete). These are private compiled
requests, never tool arguments or an arbitrary-request proxy. Whole-document
readback independently checks scalar boundaries, paragraph/run coordinates and
known table/object element coordinate shifts. The same explicit tab and required
revision bind every request. All tabs/raw structures are read for preservation.

Google may reject stale or otherwise invalid requests with HTTP 400. The plugin
reports a definitive rejection without assuming every 400 proves a revision
conflict. It never retries a mutation (including 401, 429, 5xx, timeout, malformed
success responses or transport loss). A transport/server error can mean the
write happened: `uncertain` is not failure. A successful provider response with
failed/concurrent readback returns `verification_unavailable`, not `verified`.
Both set `retrySafe: false`. Inspect the document and reconcile the observed text
before proposing a new change; never blindly replay or roll back. Existing
writer exclusion retains unresolved claims. A matching observation alone does
not release a claim or authorize a second POST. Historical text-only receipts
and private recovery remain text-only; the new rich verifier does not upgrade
old receipt interpretation.

## Authorization and deployment

This feature **does not change OAuth scopes or upgrade existing grants**. It
accepts an existing owner-authorized `drive.file`, `documents` or `drive` write
grant, as required by Google's Docs API. `drive.file` also requires the file to
have been explicitly granted to the app. Read-only grants cannot mutate Docs.
A connected account or successful preview proves neither write scope nor file
edit authorization. Scope and identity are checked before the approval-policy decision and again
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
or stacks. Approval interruptions use fixed `docs_approval_<reason>` stages;
ordinary owner decline/cancellation is not logged as a failure. These diagnostics
cannot establish whether a card was displayed, and never infer owner intent from
an expiry. `scope_required`, `stale_revision`, `write_rejected`,
`unsupported_document`, `approval_policy_unavailable` and authorization failures are distinct from connection
availability. Diagnostics establish which boundary failed, not whether an
uncertain write reached Google. There is no automatic recovery/replay service.

References: [Docs get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get),
[batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate),
[WriteControl](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#WriteControl),
[replaceAllText](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#ReplaceAllTextRequest).
