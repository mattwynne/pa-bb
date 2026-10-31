# Upload a local file or import modern Office files

`gdrive_upload_file` creates one new file; it is not a generic HTTP, sync, directory,
overwrite or editing API. Existing OAuth, identity verification and Drive write
grants are reused. Installing it does not broaden scopes or change settings.

## Native tool contract

```json
{
  "account": "writer@example.com",
  "operationId": "fe638131-e722-4d66-9712-05dd34650283",
  "source": {"host":"bb-server", "threadId":"thr_example", "path":"artifacts/model.xlsx"},
  "expectedSha256": "<64 lowercase hexadecimal characters for the selected source>",
  "folderId": "<explicit destination ID or root>",
  "name": "Working model.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "mode": "binary",
  "preview": true
}
```

Use a fresh lowercase UUID v4 for each genuinely new requested upload, never the
example key or a replacement key to bypass uncertainty. Account (1–320), name
(1–255 UTF-16 units), ordinary lowercase MIME (3–255), source relative path
(1–1024), explicit folder and source SHA-256 are required. Unknown fields fail.
`mode` defaults to `binary`; `preview` defaults to `true`. Apply with identical
arguments/key and `preview:false`, then approve the exact native owner card.
A fresh-key apply without its saved preview is refused before source capture,
provider preflight, receipt reservation or owner review. That refusal does not
consume the key: preview the exact request with the same key first. Historical
consumed-key calls remain receipt-only; this rule never permits replaying an
uncertain operation.
All modes require approval even for apparently private My Drive destinations.
No approval setting opts out. Binary contents are **not rendered or fully
reviewed** in the card. Explicit software-delivery permission is not permission
to upload actual business files as a test.

### Source boundary

The first version supports **Linux BB-server thread-storage files only**.
`source.threadId` selects a public `threads.storageLocation` SDK root;
`source.path` selects exactly one relative file beneath it. Its host must match
BB's verified primary/server host. A browser/client path, checkout-relative path,
remote host, URL, directory, archive member or arbitrary root is not accepted.
Use a separate supported, owner-directed transfer to thread storage for files
elsewhere. The tool does not enumerate unrelated files or inspect private BB
state. It reads only the selected file; there is no archive extraction.

Files must be 1 byte–**4 MiB**, regular and single-link. Hidden segments,
traversal, credential-like names, private-key extensions, symlinks (including
ancestors), hardlinks, devices and FIFOs fail closed. The trusted storage root
is resolved through BB, not a caller-selected home or credential directory.
Linux pinned directory descriptors and `O_NOFOLLOW` constrain traversal; an
internal `/proc/self/fd` descriptor path is not a user-readable proc-file API.
No shell command is run on file contents. These conservative filename checks
are not a general content-secret scanner: the user must select what to disclose.

The plugin captures bounded bytes, source size/SHA-256/MD5 and a filesystem
version. Preview, apply, post-approval and last pre-submission capture must agree.
An edit/replacement/timestamp-version change fails, even with identical content.
Submission sends immutable captured bytes; later local changes do not change the
already submitted file. Source bytes are not returned to the model, persisted
in receipts or printed as base64. The original local file stays untouched.

### Destination and audience

Root or an eligible writable My Drive folder is supported, not shared drives.
The existing bounded ancestry/access assessor allows readable foreign-owned
ancestors and visible user owner/writer authority with `canAddChildren`; it does
not require all ancestry to be owned. Incomplete evidence is refused. The card
shows destination path, owners and visible audience, alongside source
path/name/size/digest/MIME and explicit mode. People with destination access may
see the full uploaded/imported content, including after interruption. Groups,
organization rules and other access may not be fully visible. No permissions,
notifications, ownership changes, native-file copies or invitation requests are
sent. Approval never upgrades Google capabilities or access.

Fresh identity/grant, source/version, access and exact-name duplicate checks run
after approval and again at the submission boundary. A same-name file of **any**
MIME is refused, even if only one exists; choose a different name only by a new
explicit request after reconciling any uncertain operation. Local same-name
upload claims, keyed by destination/name across connected accounts, prevent
competing plugin uploads while reviewing or unresolved.
These claims cannot lock Google: other clients can race checks, create duplicates
or change access. Native Drive creation offers no atomic unique-name constraint.

## Intentional modes

### `binary` (default)

One bounded `multipart/related` Drive create request sends the exact bytes and
ordinary source MIME. There is no Docs/Sheets conversion, content parsing,
formula flattening, macro execution or link fetching. XLSX, PDF, ZIP, images and
ordinary text/binary files are opaque. The multipart envelope stays below
Google's small-upload boundary; no resumable/transfer service is introduced.

`verified` requires an acknowledged create ID, exact name/MIME/parent/private
marker and inspected access, matching size and Google MD5 against captured
bytes. If Google also supplies SHA-256 it must match too. Returned evidence
includes provider-supported checksums, size, name, MIME, destination and an
openable Drive URL. This is byte-equality evidence, not content correctness,
spreadsheet recalculation or privacy certification. MD5 is the baseline provider
checksum, not a new cryptographic-authenticity guarantee.

### `xlsx_to_sheet` (explicit user request only)

The source must be `.xlsx` with ordinary XLSX MIME. The same unchanged bytes are
sent through Google's supported Drive upload/import mechanism with the **result**
MIME `application/vnd.google-apps.spreadsheet`. Google creates a native Sheet
with its supported workbook structure and formulas. There is no conversion
through static literal review cells and no separate general formula-writing API.
Legacy `.xls`, macro-enabled `.xlsm` and arbitrary other imports are unsupported.

A conservative, non-evaluating ZIP/XML gate reads only bounded in-memory XLSX
structure. The narrow ZIP32 reader accepts stored/deflated entries with matching
local/central names, flags, CRCs, offsets and sizes; ZIP64, encryption, data
descriptors, overlapping/hidden records and ambiguous layouts are refused.
Archive part names are ASCII; tab names inside XML may be Unicode. Only NTFS/
extended-timestamp extra fields are accepted; filename aliases and other extras
are rejected rather than trusting another reader's filename interpretation.
Actual inflation is independently bounded by Node zlib, and actual lengths/CRC
must match headers. Noncanonical worksheet relationship/content-type paths are
refused; formula elements in every XML part are checked as defense in depth.
Limits: at most 512 archive entries, 4 MiB per entry, 16 MiB expanded total,
100 tabs, 100,000 source cells and 8,192 characters per formula. Nothing is
extracted to disk or executed. DTDs, malformed XML, archive path anomalies,
macros/VBA, external relationships (even hyperlinks), external connections,
embeddings/ActiveX, query tables, most named expressions, shared/array formulas
and functions outside a fixed ordinary network-free list are rejected. Defined
print-area/title names are the only named-expression exception. The initial
function list is in `adapters/xlsx-import.mjs` (ordinary arithmetic/financial,
logical, text, lookup and date functions including SUM, IF, NPV, PMT, XIRR,
INDEX/MATCH and VLOOKUP). Unknown/custom/future functions fail closed. Embedded package/OLE relationships and object declarations are rejected regardless
of target filename, including renamed or unreferenced embedded Office files.
Non-XML payloads are restricted to declared PNG/JPEG/GIF under `xl/media/` with
matching signatures and manifest types; opaque packages, printer-setting binaries,
legacy vectors and other unsupported binary parts are refused, not skipped or
recursively opened. Passive-media signature checks are shared with DOCX/PPTX and
are not image-decoding or malware certification. The gate
is not an Excel compatibility or malicious-file certification; it intentionally
accepts less than Google's general importer. A rejected conversion can still be
uploaded opaquely only as a separate, explicitly requested binary operation.

Verification checks acknowledged creation, exact name/type/parent/marker/access,
and complete bounded tab names/order. Native readback inspects the first 10 rows
× 10 columns of the first 10 tabs (at most **1,000 cells**), reporting observed
formula counts, calculation error types/locations and inspected ranges. It does
not return raw formula content or provider error messages in diagnostics.
Errors are evidence, **not** a reason to retry, rollback or delete the import.
`verified` means provider import/structure readback, while `fidelityVerified` is
always `false`. Formula syntax, unsupported Excel features, formatting, cached
results and recalculation can differ. Unsampled formulas/cells and visual
fidelity remain unverified. Never call this a fully verified working financial
model or silently substitute it for the original XLSX. Use bounded native
`gsheets_read` for subsequent user-requested investigation.

### `docx_to_doc` and `pptx_to_slides` (explicit requests only)

| Mode | Required source extension and MIME | Native result MIME |
|---|---|---|
| `docx_to_doc` | `.docx` · `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `application/vnd.google-apps.document` |
| `pptx_to_slides` | `.pptx` · `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `application/vnd.google-apps.presentation` |

Use the same tool/schema above with the exact mode, source MIME/path/digest and
requested output name. Nothing infers conversion from a filename. The source
remains unchanged. Google's supported multipart upload/import creates the native
MIME directly in one submission: supported document/slide structure and editable
content are retained by Google, not rebuilt as screenshots or static literal
text. There is no separate metadata/population write or retry.

These modes share **the same ZIP32 reader and all of its existing safety
invariants** with XLSX. A separate bounded, namespace-aware non-evaluating XML
inspector admits a narrow passive OOXML subset: Word main body, styles,
numbering, settings, headers/footers/notes/comments; PowerPoint presentations,
slides/layouts/masters/notes, styles/themes, and embedded PNG/JPEG/GIF raster
images with matching types/signatures. Only canonical known part names and
content types and a fixed internal-relationship list are accepted. Every XML
part is inspected, even if unreferenced; unknown parts/namespaces, DTDs,
processing instructions, external schema references, macros, executable/embedded objects, ActiveX, timed animations/commands, fields
(including DDE), controls, linked templates/assets, external relationships
(including hyperlinks), connections, extension content and unsupported active
content fail closed. No source ZIP is extracted or executed; no remote assets,
links or media are fetched. This is deliberately less permissive than general
Word/PowerPoint support, not a malicious-file certification.

Legacy `.doc`/`.ppt`, `.docm`/`.pptm`, PDF/image OCR, HTML/RTF/ODT, arbitrary
conversion formats, charts/embedded packages, SVG/WMF/EMF, audio/video and
unsupported OOXML extensions are **not supported**. Rejection never silently
changes the mode to binary. A separate explicit binary request can preserve
opaque bytes without conversion. The source cap remains **4 MiB**, 512 archive
entries, 4 MiB per expanded entry and 16 MiB total; primary text is limited to
40,000 UTF-16 characters and PPTX to 100 slides. Office XML depth is at most 64
and 100,000 elements per part.

Owner review shows the exact source host/path/name/size/SHA-256/MIME, mode,
native result type, destination owners/visible audience and bounds. Contents are
not fully rendered. Approval is mandatory, including private destinations,
independent of filing and Docs-edit preferences. Fonts/layout, tables/objects,
animations, media and unsupported features can change or be omitted. Never
promise full Word/PowerPoint compatibility or visual fidelity.

After an acknowledged create, Docs readback checks native tabs/body/document
structure and compares normalized main-body text evidence. Slides readback
checks presentation identity, slide count/order and normalized editable
shape/table/group text per slide. Order uses per-index text hashes; text-identical
or empty slides cannot distinguish ordering. The returned evidence contains hashes/counts,
not source text. It does **not** compare headers/footers, comments, speaker notes,
masters/layouts or all objects. Native readback is capped at 1 MiB JSON, 10,000
structural/text nodes and 80,000 text characters (Docs at 20 tabs/depth 32;
Slides at 100 slides/group depth 16). Oversize, missing API, omission/text
mismatch or incomplete readback leaves the acknowledged creation unresolved;
never repair/delete/recreate it automatically. Whitespace-normalized text is
not exact styling or exhaustive content evidence. `verified` confirms bounded
native creation/structure/text readback only; `fidelityVerified` is always
`false`. Native Docs/Slides edit links are returned when an ID is known.

The existing authorized `drive`/`drive.file` grant is accepted by the narrow
Docs/Slides read adapter. No scopes, settings or credentials are changed.
Enable the relevant Google Docs/Google Slides API in the provider project as an
owner setup action if necessary; a missing API/write grant is not permission
to inspect tokens, broaden OAuth or retry an uncertain import.

## Receipts, uncertainty and recovery

The existing plugin-owned creation table retains `kind:"upload"` receipts;
legacy Docs/Sheets/copy/filing/sharing receipts and settings remain unchanged.
Receipts bind account subject, exact request/mode, source digest/version,
size/checksums, destination access evidence and name hash. They contain neither
source bytes nor credentials; conversion receipts retain bounded tab metadata or primary text hashes/counts and slide-order evidence, not plain source text.
The private `paLocalUpload` app-property marker supports read-only lookup.

A durable key is reserved before review/write. Calls with a consumed key never
write again; altered account/request/source version is refused. A proposed
preview can proceed only with the same file/version/access evidence. Review
expires after ten minutes. Decline/cancellation or confirmed pre-submission
failure consumes the key without a provider write. A definitive HTTP rejection
may have `writeAttempted:true` but `outcome:"not_created"`; never automatically
replace the key. There is exactly one multipart submission and no automatic
retry for 401, timeout, 429, 5xx or an unreadable response.

After interruption, use **`gdrive_upload_status`**:

```json
{"account":"writer@example.com","operationId":"fe638131-e722-4d66-9712-05dd34650283"}
```

It only reads Google and updates the local receipt. Known acknowledged IDs can
be verified by fresh readback. A lost create response followed by matching
marker/checksum/structure returns `observed_matching`, **not completion**;
acknowledgement is never invented. Its access/name claim remains unresolved,
including a discovered file ID. Empty/incomplete/ambiguous lookup is uncertainty,
not proof no upload happened. Repeated submit returns a historical receipt;
`receiptOnly:true` is not a fresh provider read. Status never resubmits media,
repairs, unlocks an uncertain write, shares, rolls back or deletes anything.
Keep the original account/key and reconcile with the owner.

## Testing and diagnostics

Synthetic fixtures and fake Google transport test byte preservation, deliberate
conversion, formula/error evidence, source boundaries, approval binding,
staleness, duplicate/lock handling, identity/grants, persistence/reload and lost
responses. No real business upload/import is an engineering test. Native inert
BB review covers desktop, narrow and keyboard/error/invalid card states.

Logs use fixed `upload_approval`, `upload_revalidate`, `upload_submission`,
`upload_verify`, `upload_receipt`, `upload_status`, `upload_status_lookup_uncertain`,
`upload_status_mismatch` and `upload_agent_tool` stages with bounded categories
and validated status numbers only. No account, source path, name, bytes, content,
formula, raw exception, provider body or credential is logged. A diagnostic does
not prove provider completion or Excel compatibility.
