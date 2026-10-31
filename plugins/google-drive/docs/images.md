# Inline images in Google Docs

Use native tools, not browser editing or raw `batchUpdate`. This capability adds
one inline image before an existing body paragraph's content. It never deletes
text, replaces an existing logo, creates a header, shares a file or hosts an asset.
Only explicitly user-requested insertions are authorized. Engineering examples
and tests use fixed synthetic documents/ports, never connected account content.

## API contract and intentionally narrow scope

Google's [InsertInlineImageRequest](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request#InsertInlineImageRequest)
accepts publicly accessible PNG, JPEG or GIF URIs (not SVG), up to 2 kB; Google
fetches the image once and stores a copy. Location indices are UTF-16 units and
must lie within a paragraph. An inline object occupies one UTF-16 unit. Sending
only width preserves aspect ratio. Explicit `location.tabId` avoids the API's
first-tab default. Mutations use `writeControl.requiredRevisionId`.

Our initial supported slice is **PNG only**, 8-bit RGB/RGBA, non-interlaced and
non-animated, at most 2 MiB, 4 million pixels and 8192 pixels per side. Compressed
metadata (`iCCP`, `zTXt`, all `iTXt`), unknown chunks and malformed signature/CRC,
IDAT or scanline structure are rejected. Inflation is bounded to the expected
pixel scanlines (at most about 16 MiB). This is bounded structural validation,
not an exhaustive image decoder or a guarantee of Google's eventual rendering.
There is no SVG conversion, third-party converter, temporary hosting or asset
publication. Ask the asset owner for a faithful supported public PNG when needed;
do not recreate artwork or change Drive sharing to manufacture a public URI.

Asset fetches are credential-free HTTPS GETs on port 443, with no query,
fragment, credentials or redirects; the canonical URL is at most 2000 characters.
The server resolves IPv4 only, rejects all returned private/reserved addresses,
and pins a public address for TLS while retaining hostname certificate checks.
There is one request per inspection, bounded bytes and a ten-second DNS/network
budget, with caller abort. IPv6-only hosts are unsupported. The owner card never
loads remote pixels. Source metadata/digest is captured without persisting image
bytes, and rechecked after approval. No temporary asset storage is created.

Google fetches the public URL independently: it can change or resolve differently
between our check and Google's fetch. **No exact embedded-byte claim is made.**
The URI is saved by Google. Never put a private/signed URL, token or secret in it.

The API exposes embedded-object title/description as alt text in reads, but its
current native request surface has no supported setter for these fields. This
tool therefore does not accept or promise alt text. Do not imply accessibility
metadata was applied. JPEG/GIF, SVG, image replacement/removal, arbitrary index
insertion, tables, headers/footers and floating/positioned images are unsupported.

## Inspect → preview → apply

1. `gdocs_inspect_images({account, document})` requires a connected explicit
   account and Docs URL/ID. Require `complete:true`; retain revision, tab ID and a
   listed paragraph-start `index`. The complete snapshot must have simple body
   paragraphs (optional inline images) in every tab, no suggestions, lists,
   named ranges, comments/other indexed structures, tables, headers/footers or
   positioned objects. Limits: 16 tabs, 50,000 UTF-16 body units including image
   placeholders, 100 images per tab, 1 MiB provider JSON. Child tabs are included.
2. `gdocs_insert_image({account, document, operationId, expectedRevisionId,
   tabId, index, uri, widthPt, preview:true})` previews and saves a request-bound
   proposal. Generate one lowercase UUID v4 and keep it. Width is 18–432 pt;
   height follows the source aspect ratio and must be 1–648 pt. 72 pt = 1 inch;
   centimetres × 72 / 2.54 gives points (6.1 cm ≈ 172.91 pt). Choose a width that
   fits the document's usable page area. It adds an image, not a new paragraph.
   Use an existing empty paragraph for a logo-only line; this tool cannot create
   one. Insertion planning reserves one UTF-16 unit, one inline-object slot and
   32 KiB serialized metadata headroom before submission.
3. Apply **identical arguments/key** with `preview:false`. The owner-controlled
   **Require approval for Google Docs edits** setting applies just as for text
   replacements/formatting. Default is an exact BB owner card. Agents must not
   change the setting. There is no argument bypass or OAuth expansion. A missing
   existing write grant is an owner Settings/setup matter, not permission to
   handle credentials. Preview never establishes mutation authorization.
4. After approval, revalidate the exact document/revision, account and asset.
   The ten-minute proposal deadline, current no-card approval policy, abort,
   account and durable writing claim are checked again after final asynchronous
   grant/identity verification, immediately before the single provider POST.

An example (synthetic values, not a runnable business request):

```json
{
  "account": "writer@example.test",
  "document": "synthetic-document",
  "operationId": "11111111-1111-4111-8111-111111111111",
  "expectedRevisionId": "inspected-revision",
  "tabId": "inspected-tab",
  "index": 1,
  "uri": "https://example.test/logo.png",
  "widthPt": 172.8,
  "preview": true
}
```

## Receipts and recovery

`outcome:verified` requires a valid acknowledged response with exact document,
new inline-object ID and response revision, followed by readback at that same
revision. It checks the new object's location, API source URI and dimensions
(with a narrow 0.001 pt tolerance), removes only that new object in a comparison
copy, reverses its single-unit shift, and compares original text/styles/tabs/
objects. Run splits are normalized; only transient `contentUri` retrieval links
are ignored. A missing API source URI cannot be verified. Original image alt
text and other non-transient properties must remain unchanged. Verified means
this bounded API comparison, **not embedded image bytes, pixels, rendering,
font availability, layout suitability or alt-text application**.

Use `gdocs_image_status({account, operationId})` with the **same** account/key
following interruption, uncertainty or failed verification. Never replay, replace
a key, compensate, roll back or force-unlock. Proposals, reviewing/writing states
and receipts persist in plugin-owned storage. Per-document claims serialize image
and formatting operations, including across connected accounts and reloads.
Legacy text replacement refuses active image claims and still uses its required
revision guard. A process abandoned during owner review remains blocked; status
never treats a lost review as permission or clears it.

An acknowledged write with later readback failure remains `uncertain` with its
claim held, including permission/authorization failures during readback. Recovery
may reach verified only with the saved valid response object/revision and exact
readback at that revision. Lost/malformed responses with matching current state
are `observed_matching`, never verified, and retain the unresolved claim. A
previously verified operation with later drift reports `changed_since_verification`.
Status never fetches the public asset or writes to Google. User reconciliation is
required for unresolved claims; no automatic retry or unlock tool is provided.

## Reading and other tools

`gdocs_read` remains a lossy body-text projection, now with U+FFFC inline-image
placeholders and an explicit projection warning. Complete means all projection
pages were returned, not that images/structures were fully read or editing is
safe. `gdocs_inspect_images` includes object IDs and paragraph text/placeholders
but grants no paragraph-formatting or replacement proof. Those strict inspectors
continue to reject image-containing documents. Page-only formatting remains
available under its separate bounded structured-document inspection.

Existing creation, copy, filing, sharing, upload and Sheets receipts are preserved.
Image storage is an append-only plugin migration; no existing operation is
replayed, migrated to another key or unlocked. No settings change is performed.

## Synthetic review and diagnostics

`gdocs_review_image_example({})` opens a fixed no-op native card: no Google,
account, document or image URL access; every choice returns `exampleOnly:true`
and `writeAttempted:false`. For credential-free desktop/narrow/keyboard review,
`node test/run-image-preview.mjs` starts an isolated BB fixture with separate
HOME/data, inert scheduled threads and five approval/error/invalid/busy states.
Its lifecycle is shared with the existing disposable preview runner. Do not point
it at a configured production data directory or use live Docs for UI tests.

`docsImageCapabilities` is a narrow read-only BB RPC (null input) exposing contract
`docs-inline-png-v1`, bounds, placement, alt-text limitation, recovery and current
owner approval policy without any Google account/provider read. A successful
source build or push is not evidence that this contract is registered/running.

Backend failures use BB's attributable Google Drive logger with fixed operation/
stage and bounded image/Docs/provider categories only. No raw errors, bodies,
addresses, URLs, document content, tokens or image bytes are logged. Synthetic
sentinel failures cover preflight, write, post-write readback and recovery. Live
verification uses only capability registration/served-asset checks, never account
content or a real provider write.
