---
name: google-docs-editing
description: Create Google Docs, insert public PNG logos or apply bounded revision-guarded text/formatting changes, and recover uncertain operations without replaying writes.
---

Use only explicit user-requested document mutations and connected account emails.
For general reading, follow every `gdocs_read` nextCursor with the same account and document in the same thread until complete. Pages are a short-lived snapshot of a lossy text projection; restart if a cursor expires. The provider JSON response is limited to 8 MiB. Do not use this output as edit proof.

## New documents

Use `gdocs_create_document({account, operationId, folderId, title, text})` for a
user-requested new native Doc, not copying or repeated replacements. Generate a
fresh lowercase UUID v4 once; retain it across interruptions. Choose `root`
unless the user explicitly selected another supported My Drive folder. Shared destinations require complete access assessment and per-operation owner review; unknown authority and shared drives are rejected. `text` is literal plain text (up to 40,000 UTF-16 units),
with LF paragraph breaks and blank answer spaces; no Markdown/HTML conversion.
Creation requires an existing owner-authorized Drive write grant. It follows
the user request and, for shared destinations, exact owner review of content and partial exposure; the Docs-edit approval setting is separate. Do not change settings, request new credentials, share or invite.

Only `outcome: verified` confirms exact title/destination/body readback. Return
the Docs link. After any partial, reserved or uncertain outcome, call
`gdocs_creation_status({account, operationId})` with the SAME key. Repeated
create calls with that key return a receipt and never write again; status is
read-only and cannot resume population. A blank or populated Doc may exist even
when lookup finds nothing. Never generate a new key, replay population or make
a second Doc merely to compensate. Reconcile with the user first.

Read the [creation guide](../../docs/creation.md) for limits, destination policy,
receipt semantics and recovery. Implementing/testing this capability does not
authorize a live document or respondent contact.

## Insert an inline PNG/logo without a browser

Only explicit user-requested insertions. Read the [image guide](../../docs/images.md)
for asset/network bounds and honest verification limits. No SVG conversion or
hosting: use an already-public faithful PNG from the asset owner; never recreate
the artwork, change sharing or send private assets to a converter.

1. `gdocs_inspect_images({account, document})`: require complete inspection; copy
   revision, explicit tab ID and a listed paragraph-start UTF-16 `index`. It
   supports bounded simple body paragraphs plus inline images in all child tabs,
   not tables/lists/named ranges/headers/footers/suggestions/positioned objects.
2. `gdocs_insert_image({account, document, operationId, expectedRevisionId, tabId,
   index, uri, widthPt, preview:true})`: generate one lowercase UUID v4. Width
   18–432 pt; aspect ratio is preserved, height must be 1–648 pt. Centimetres ×
   72 / 2.54 gives points (6.1 cm ≈172.91 pt). Pick a width fitting the usable page.
   One image is added before existing paragraph content: **no text is deleted**.
   Use an existing empty paragraph for an image-only line; the tool cannot create
   it. Removing/replacing a temporary text wordmark is a separate request, never
   an implicit side effect.
3. Apply identical arguments/key with `preview:false`. This follows the same
   owner-controlled **Require approval for Google Docs edits** setting; default
   exact-change owner review, no argument bypass. Do not change settings/grants.
   Preview is not completion. The document/account/asset, expiry, durable claim
   and policy are rechecked before one required-revision insertion POST.
4. Only `outcome:verified` establishes acknowledged API object/location/source URI/
   size readback and preserved original text/styles. It does **not** verify
   embedded bytes, visual rendering, layout suitability or alt text. Google's
   separate public-URL fetch can observe changed bytes. After uncertainty use
   `gdocs_image_status({account, operationId})` with SAME account/key. Never replay,
   replace keys, roll back or force-unlock. Lost-response matches retain claims
   and remain observations, not completed writes.

PNG only: already-public canonical HTTPS/443 URL≤2000 characters, no query,
fragment/credentials, redirects, private/reserved IPs or IPv6-only hosts. PNG must
be 8-bit RGB/RGBA, non-animated/non-interlaced, no compressed metadata, ≤2 MiB,
4MP and 8192px per side. No JPEG/GIF, SVG, conversion, temporary hosting, private
asset publication, replacement/removal, arbitrary index or alt-text writes.
Google's current request API does not expose an embedded-object alt-text setter;
do not claim it was applied. Ask for a supported export when validation rejects
an asset; do not broaden permissions or invent an unsafe workaround.

`gdocs_review_image_example({})` opens a fixed synthetic no-op approval: no account,
Google or image URL is accessed. Every choice returns exampleOnly:true and
writeAttempted:false. Engineering tests never authorize a live Doc mutation.

General `gdocs_read` is lossy text with U+FFFC image placeholders, never edit proof.
Image inspection is not replacement/paragraph-format proof; those strict tools
continue rejecting image-containing documents. Page-only formatting still uses
its separate structured-document inspector. No headers/footers or wordmark
replacement is implied by inserting a body image.

## Formatting existing documents without a browser

Use `gdocs_inspect_formatting({account, document})` for paragraph ranges or
`gdocs_inspect_formatting({account, document, mode: "page"})` for page-only changes
on structured documents; require complete inspection and copy its tab IDs and
revision. Paragraph ranges also require the exact whole-paragraph UTF-16 indices.
`gdocs_format_document({account, document, operationId, expectedRevisionId,
ranges, page?, preview?})` previews by default. Generate one lowercase UUID and
retain it. Set preview=false with otherwise identical arguments to request
owner approval by default. Formatting follows the same global **Require approval
for Google Docs edits** setting as replacements; the owner can turn it off in
Google Drive Settings. Do not change that setting yourself or override policy
in tool arguments. Only user-requested formatting is authorized.

Ranges support textStyle fontFamily/sizePt/bold/foregroundColor and paragraphStyle
spaceAbovePt/spaceBelowPt/lineSpacing/alignment. lineSpacing=120 means 1.2 lines.
Optional page requires explicit tabId and at least one property: opaque hex
backgroundColor, size=LETTER, or individual margin*Pt values. For colour only use
`page: {tabId: "TAB_ID", backgroundColor: "#F4F1E8"}` and omit size/margins to
preserve them. No alpha, transparency, named colour or paragraph shading. 61.2 pt
is .85 inch. At most 16 nonoverlapping whole-paragraph ranges and 8000
selected UTF-16 units. No raw API requests, partial runs, text insertions,
semantic heading/named-style-definition updates, table/list edits, real headers or
footers, page numbers or inline coloured-dot composition. Report unsupported
layout features rather than claiming the brand design is fully applied.

Only outcome=verified confirms exact expected API style/text readback at the
successful response revision, **not** actual font rendering or menu availability.
Do not silently substitute fonts. For uncertainty/interruption use
`gdocs_formatting_status({account, operationId})` with the SAME key; never replay
or generate a new key to bypass recovery. Lost-response matches may return
observed_matching with an unresolved lock, not verified. Abandoned reviews and
unknown writes remain blocked pending owner reconciliation; there is no force
unlock. See the [formatting guide](../../docs/formatting.md) before use.

`gdocs_review_format_example({})` opens a fixed synthetic no-op card without
Google access; optional `state: "background"` selects its colour-only example.
`bb google-drive review-format-example --thread THREAD_ID --state background` opens
the same card for manual review; keep the CLI connected until the choice. Its
receipt is not proof of the native deferred-tool lifecycle. A waiting notice is not proof it rendered. End the originating
turn if waiting and let the owner review in ordinary BB. Do not use a live Doc
for engineering tests. This does not waive a no-browser instruction or establish
desktop/narrow/keyboard review by itself.

## Existing document replacements

Use explicit Google Docs URLs/IDs.

1. Call `gdocs_inspect_for_edit({account, document})`. Require `complete: true`;
   keep the exact `revisionId`, tab ID and existing text.
2. Call `gdocs_replace_text({account, document, tabId, expectedRevisionId,
   oldText, newText, preview: true})`. Preview is the default and is not a write
   or evidence of write authorization.
3. With the same proposal, `preview: false` applies the requested edit under the
   current global policy. By default it requests the BB owner's exact-change
   approval. The owner can disable per-edit cards for all documents/accounts in
   Google Drive Settings → Configuration → Require approval for Google Docs edits.
   Do not change that setting yourself. Tool arguments cannot override it.
   Missing/unreadable policy fails closed. Disabling it does not approve a card
   already open; re-enabling it can stop a preparing no-card write.
4. Only `outcome: "verified"` confirms exact text readback at the returned
   revision. `approval: "disabled_in_settings"` is standing consent, not evidence
   of a saved change. Preview never writes in either mode. After `uncertain` or `verification_unavailable`, inspect and
   reconcile; never replay blindly. Inspect afresh for every later replacement.

This initial capability supports one unique literal match within one text run
in a selected tab, at most 2,000 UTF-16 units per text. No newlines/controls;
empty replacement deletes the match without deleting the paragraph boundary.
Documents must be complete, bounded and contain only simple text paragraphs in
all tabs. Tables, suggestions, headers/footers, objects and mixed-run matches are
not supported. Google controls formatting inheritance; styling isn't verified.

Check scope without reading any document or exposing tokens:
`bb google-drive editing-access --account ACCOUNT_EMAIL`. It distinguishes a
missing grant from unavailable verification and reports whether installed
Settings can request write access. It does not establish document edit permission.

Existing read-only grants cannot edit. Additional scopes need supported Settings
reauthorization and explicit account-owner consent; reconnecting to a read-only
flow is insufficient. Do not broaden access or handle credentials manually.

To review the actual approval UI without touching Google, run
`bb google-drive review-edit-example --thread THREAD_ID`; optional
`--state deletion` or `--state incomplete` selects another fixed synthetic case.
Every choice is a no-op and returns `writeAttempted: false`. This does not test
live write authorization or native-tool detachment. To test the actual native
tool lifecycle, call `gdocs_review_edit_example({})`, end the originating turn on
BB's waiting notice, and have the owner confirm the card in that same thread in
ordinary BB chat (including the actual mobile client if relevant). Its later
result must have `exampleOnly: true` and `writeAttempted: false`.

A `cancelled` result with `reason: "timeout"` is expiry, not an owner rejection;
it does not prove the card was shown. `declined` / `owner_declined` requires an
explicit false choice. Other host cancellation reasons and `approval_unavailable`
are distinct and never authorize a write. Do not automatically replay a review.
The interactions list contains pending requests only; use the saved interaction
ID with `bb thread interactions show INTERACTION_ID THREAD_ID --json` to inspect
its terminal status/reason, avoiding document payloads in diagnostic output.

Full tool inputs, concurrency semantics and recovery: [editing guide](../../docs/editing.md).
