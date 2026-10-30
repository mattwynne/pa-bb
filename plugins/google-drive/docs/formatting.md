# Bounded Google Docs formatting

These tools change appearance without a browser or raw Google API passthrough.
They do **not** finish an arbitrary branded layout. Content and commercial terms
remain the caller's responsibility. Use only explicitly user-requested changes.

## Workflow

1. Call `gdocs_inspect_formatting({account, document})` for an explicit connected
   account and Docs ID/URL. Require `complete: true`. Keep its `revisionId` and
   exact paragraph `tabId`, `startIndex` and `endIndex` values. The general reader
   and replacement inspector are not substitutes for this style inspection.
2. Generate one lowercase UUID and call `gdocs_format_document` with
   `operationId`, `expectedRevisionId`, `ranges` and/or `page`. For page colour
   only, use `page: {"tabId":"TAB_ID","backgroundColor":"#F4F1E8"}` and omit
   size/margins to preserve them. Preview defaults
   to true. It saves an exact bounded proposal, not a write or write grant.
3. Repeat the **same** arguments and key with `preview: false` within ten minutes
   to apply under the owner's current Google Docs approval setting. By default
   BB asks for approval, showing the account, document, revision, paragraph text,
   explicit prior styles and exact new settings. Missing prior properties inherit
   named/editor defaults, not zero/false values. Sizes/paragraph spacing are
   points; line spacing is a percentage. In Google Drive Settings → Configuration,
   the owner can turn **Require approval for Google Docs edits** off for both
   replacements and formatting, across all documents/accounts. Agents must not
   change that setting. No new setting, OAuth scope or invitation is introduced.
4. The service checks scope/identity and policy, re-inspects the exact document
   in both approval modes, persists a write reservation and submits one atomic
   `documents.batchUpdate` with **requiredRevisionId**, never targetRevisionId.
   A changed revision, unsupported structure, expiration, decline, cancellation
   or invalid approval prevents submission. Missing/invalid policy requires
   approval; policy lookup failure prevents submission. Turning the setting off
   cannot approve an already-open card. Re-enabling it during a no-card call
   stops that call before submission with `approval_required`. Receipts distinguish
   `owner_approved` from `disabled_in_settings`; neither proves completion.
   Transport failures are never retried.
5. Only `outcome: verified` establishes exact expected API style/text readback at
   the successful response's revision. It is not evidence of actual font
   rendering, font-menu availability, pagination or delivery to another device.

Example (replace indices/revision with the inspected values, not guesses):

```json
{
  "account": "writer@example.com",
  "document": "DOCUMENT_ID",
  "operationId": "11111111-1111-4111-8111-111111111111",
  "expectedRevisionId": "REVISION",
  "ranges": [{
    "tabId": "TAB_ID", "startIndex": 1, "endIndex": 20,
    "textStyle": {"fontFamily": "Inter", "sizePt": 30, "bold": true, "foregroundColor": "#17221C"},
    "paragraphStyle": {"spaceAbovePt": 18, "spaceBelowPt": 6, "lineSpacing": 120, "alignment": "START"}
  }],
  "page": {"tabId": "TAB_ID", "size": "LETTER", "marginTopPt": 61.2, "marginBottomPt": 61.2, "marginLeftPt": 61.2, "marginRightPt": 61.2},
  "preview": true
}
```

## Supported and deliberately unsupported

- Whole ordinary body paragraphs, including their ending newline. Ranges may
  group adjacent complete paragraphs in one explicit tab. JS/Docs UTF-16 indices
  count surrogate pairs as two; no partial paragraphs or surrogate cuts, text
  insertion/deletion, or index-shifting requests are accepted.
- Up to 16 disjoint ranges, 8,000 selected UTF-16 units and a 48 KB proposal.
  All tabs must pass complete inspection: at most 16 tabs, 50,000 body UTF-16
  units and 1 MiB provider JSON, with no clipping. Nested tabs are explicit.
- Text: font family (bounded ASCII API name), 6–72 pt size, bold and hex RGB
  foreground. Paragraphs: 0–72 pt before/after, 100–200% line spacing in 0.01 increments and
  START/CENTER/END/JUSTIFIED alignment. START/END follow paragraph direction;
  they are not necessarily physical left/right alignment.
- Page: **one explicit tab**, existing PAGES mode. `backgroundColor` is an
  opaque six-digit `#RRGGBB` page colour, not paragraph/text shading. No named
  colours, alpha, transparency or reset-to-inherited requests. Colour-only
  requests preserve page size, orientation, all margins, text/styles and other
  tabs. Optional `size: LETTER` selects portrait 612 × 792 pt (an existing flipped
  orientation is rejected for that size change). Each optional margin is 18–144
  pt; 61.2 pt is 0.85 inch. Omitted properties are never added to the update mask.
  At least one page property besides tabId is required. Unknown existing
  background fields fail closed when replacing the background.
- Explicit fields use narrow masks, never `*`. Text-run splits are normalized;
  known named-style inheritance is resolved for comparison, without guessing
  unknown editor defaults. All tab text, paragraph indices, unrequested styles,
  named definitions and other inspected metadata must match the expected state.
  General numeric/RGB serialization is normalized at 1e-6 precision. Only a
  **selected, explicitly requested line-spacing** property accepts the adjacent
  float32 readback bin (for example, 120 returning as 120.00001). This reflects
  the API's float field and decimal serialization, not a global style tolerance.
  Unrequested line spacing, named styles, font sizes, margins, text and other
  properties remain strict. Older high-precision requests do not gain this
  accommodation. Unknown normalization or side effects yield uncertainty.
- Existing semantic headings can receive appearance changes, but **changing
  namedStyleType or named-style definitions is unsupported**: those can reset
  other styles/heading IDs. A paragraph that looks like a heading is not thereby
  a semantic heading or an updated reusable heading preset.
- No pricing tables, table rules/cell fills, lists, real headers/footers,
  automatic page numbers, inline orange-dot/wordmark composition, text-run
  subranges, objects, suggestions, pageless layout,
  section margin/column/orientation overrides or arbitrary API requests.
  Documents containing unsupported structures in any tab are rejected, not
  silently projected into a partial edit. Existing links and other ordinary
  text styles are preserved; the tool does not modify link destinations.
- Font-family readback verifies only the API name. It never proves Inter (or
  another font) is available in the Docs menu or actually rendered. No silent
  font substitution or browser fallback is authorized.

## Durable recovery

`gdocs_formatting_status({account, operationId})` is read-only at Google. Always
keep the SAME key after uncertainty; neither a second apply nor a new key is a
retry strategy. Keys bind the subject, document, revision and exact request.
Repeated calls return receipts, never repeat provider writes or open a second
review. Preview receipts are historical; they are not a fresh live inspection.

Receipts expose `providerAcknowledged` and `appliedRevisionId`; status also
exposes `observedRevisionId` and `responseRevisionMatchesReadback`. A null outward
`revisionId` on an apply mismatch does not mean the HTTP response was lost: the
validated successful response revision may already be saved durably. These
fields are evidence, not independent proof of success.

A successful provider response whose immediate readback failed can be verified
later only if the complete expected state (with the narrow precision rule above)
**and** saved response revision match.
A lost/malformed response cannot establish causality or completion. Even exact
current styles then yield `observed_matching`, not `verified`: its unresolved
lock remains because the original request could still be in flight. A mismatch
stays `uncertain`; unavailable reads report `verification_unavailable`. Historical
verified operations that later differ return `changed_since_verification`.

A per-document durable lock (across connected accounts) blocks another formatting
apply while an operation is reviewing/writing/uncertain. Busy errors name the
blocking key; use that operation's original account. Status never clears an
abandoned review or unknown in-flight write, replays, rolls back or silently
creates a new key. Unresolved cases require owner reconciliation; there is no
force-unlock/retry tool in this slice. Other independently authorized tools or
collaborators can still edit; revision checks and full readback remain required.
No polling/retry/recovery background service runs.

## Review and delivery evidence

`gdocs_review_format_example({})` opens the real approval renderer with fixed
synthetic data. Every choice is a no-op, with `exampleOnly: true` and
`writeAttempted: false`; no account, token or Google document is accessed. The
same fixed card is available as `bb google-drive review-format-example --thread
THREAD_ID` for owner-led manual review. Use native `state: "background"` or CLI
`--state background` for the fixed colour-only example; every choice is still a
no-op. The summary shows the exact colour/tab without inventing Letter or margin
changes. The CLI must remain connected until the
choice; it is a rendering probe, not proof of native deferred-tool delivery. A
waiting notice proves only host acceptance, not that a client displayed it.
The native lifecycle must be observed separately from provider writes.

Synthetic tests cover the typed request/mask contract, whole-paragraph UTF-16
ranges, inherited styles, all-tab preservation, approval/abort/expiry, durable
SQLite reservations/reload, mismatches, malformed/lost responses and read-only
recovery. SSR verifies escaped text, exact displayed properties and fail-closed
incomplete cards. Neither unit tests, SSR nor builds replace rendered BB review.
Desktop/narrow layouts, keyboard focus/actions, long-selection scrolling and
submission-error feedback still need rendered review when that is permitted.
No live Google Doc writes are required or used for engineering tests.

Failures log fixed `docs_format_<stage>` categories, known Docs failure categories
and validated transport status, never account/document content, arguments, raw
errors, tokens or provider bodies. Synthetic secret sentinels exercise failure
redaction. Safe live read/log checks establish deployment only, not provider
write correctness or actual font rendering.

Page colour uses `updateDocumentStyle` with an explicit `tabId`,
`documentStyle: {background: {color: {color: {rgbColor: {red, green, blue}}}}}`
and mask `background`. The extra color level is required: Background.color is
OptionalColor, whose color is the RGB Color. This preserves existing unrelated
DocumentStyle properties; it does not use a wildcard, omit the tab, or change
paragraph shading. Colour readback uses the existing bounded RGB numeric
normalization; unknown provider normalization remains uncertain and never causes
a retry. Actual Docs colour application is not part of engineering tests and is
complete only after a separately requested native operation returns verified.

API contracts: [requests](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request),
[tab-scoped document style](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents#DocumentTab),
[style inheritance](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents#TextStyle).
