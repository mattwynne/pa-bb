# Bounded spreadsheet editing

Discover the tools before using them: source files and passing builds do not
establish which plugin generation a BB installation is running. Applying an
update is separate from permission to change a real spreadsheet.

This surface changes entered values in one existing native Sheets rectangle.
It has no formula input, imports, structural changes, arbitrary formatting commands,
sharing, notifications or arbitrary Google batch requests. Strings beginning
with `=`, `+`, `-` or `@` remain literal strings. Numbers and booleans stay typed;
null and empty text clear values. Existing date/currency formats remain, so use
the underlying numeric serial/amount only when the user intends that value.
Explicit `{date: "YYYY-MM-DD"}` civil dates (1900–2100) and `{cad: number}` are also accepted. By default they write the date serial or numeric amount while preserving the existing format. Set `formatTypedValues: true` only when explicitly requested: the review shows each typed cell’s existing number format and the fixed DATE or CAD format to apply. Primitive and null cells never receive a format change.

## Protocol

1. `gsheets_inspect_for_edit`: explicit connected account, spreadsheet ID,
   numeric tab ID, zero-based startRow/startColumn and rowCount/columnCount.
   Returns raw entered values, formatting/notes, tab metadata and a fingerprint.
2. `gsheets_update_range`: same target, inspected expectedFingerprint, fresh
   lowercase UUID v4 operationId, rectangular values and preview=true (default).
   The exact before/after matrix is returned without a write or approval.
3. Apply the same arguments/key with preview=false, only for an explicitly
   user-requested edit. The owner reviews the exact values in BB. Approval is
   mandatory and unaffected by the Docs replacement approval setting. An edit
   cannot apply without its saved preview. Proposals expire after ten minutes.
4. Only `outcome: verified` means an acknowledged provider response followed by
   exact bounded value, format and note readback. It does not certify the rest of the spreadsheet or
   exclude a concurrent overwrite. Return the spreadsheet link.

Limits: 100 cells, 20 columns, 100 rows, rectangular input, 2000 UTF-16 units per
string and 20000 total input string units. Inspection and approval data are
bounded to 60000 serialized characters, with the existing 1 MiB HTTP limit.
Trailing blank cells/rows omitted by Google normalize to empty cells. Selected
formulas/calculated output, rich text, chips, data validation and pivot/data
source anchors are rejected. Merges, protected ranges and tables anywhere on the
selected tab are conservatively rejected. Other cells/tabs may contain formulas.
Their dependent results can recalculate after a value change.

## Concurrency and preservation

Google's [batchUpdate contract](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)
applies a valid batch atomically, but warns that collaborators can change its
result. Its request schema has no Docs-style revision/write control. A local
fingerprint is **not native revision/CAS**. Fresh inspection after owner approval
detects earlier differences, but an external writer can still race between the
last comparison and submission. The card explicitly warns that a concurrent edit
may be overwritten and asks for a quiet editing window. No false race-free
promise, rollback or automatic retry is made.

The adapter constructs exactly one typed `updateCells` request, using a start
coordinate, a complete matrix and the field mask `userEnteredValue`, followed in the same batch by number-format-only updates for explicitly requested typed cells. No caller
can supply Google request objects or field masks. [Google's cell contract](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells)
says changing a value erases text/chip runs, so inspection rejects them. The
request leaves notes, unrelated formatting, cells/tabs and metadata outside its
write masks. Readback compares target entered values and retained cell
formatting/notes plus tab metadata; it does not read every unrelated cell or
prove that Google/collaborators changed nothing elsewhere.

## Authorization, receipts and uncertainty

The implementation uses the existing verified identity and adapter-private HTTP
transport, existing owner-authorized Drive write scopes (`drive` or `drive.file`),
bounded decoding, timeouts and fixed diagnostic categories. It does not expand
OAuth or change settings. Read-only grants fail before requesting approval. API
enablement and any separately necessary owner consent stay in Settings.

Durable SQLite receipts hold request/content hashes, dimensions, IDs and state,
not workbook contents. Each key is single-use. Conditional claims serialize this
plugin's edit operations across accounts on the same spreadsheet; they cannot
serialize external collaborators or other clients. Repeat applications return a
historical receipt and never repeat a provider write.

`gsheets_edit_status({account, operationId})` only reads. It does not update
receipts, replay, repair, roll back or release locks. Known 400/401/403/404
rejections are distinct from transient errors/lost/malformed/oversized responses.
An acknowledged write with unavailable/mismatching readback is `unverified`.
A lost response is `uncertain`, even if the values already look correct. Status
may report `observed_matching` while retaining the unresolved lock: equal values
cannot prove this request applied or finished. A request may remain in flight.
`reviewing`, `writing` and `uncertain` locks remain held across reloads. This
first surface intentionally offers no force-unlock or resubmission. An owner
must reconcile unresolved operations; do not bypass them with a new key.

A successful historical receipt can later drift. Status reports current matching
or nonmatching bounded state without silently replaying the old request. Logs
contain only fixed operation/stage/error categories and validated HTTP status,
never account/file content, arguments, credentials or raw provider errors.

## Integration and verification

The Sheets receipt schema is appended to the existing BB migration history;
existing Docs, creation, sharing and account tables remain intact. The Google
adapter constructs the narrow Sheets port inside its existing verified identity
closure. Native tool configuration and the `sheets-edit-approval` renderer are
registered together, without exposing a general HTTP/request proxy or token
function. No approval setting is added or changed.

Testing uses synthetic accounts/responses and disposable SQLite/BB fixtures,
including registration, existing-receipt migration/reload, identity/scope checks,
uncertain writes and failure diagnostics. Isolated rendered review exercises
only the Sheets card, not other plugin workflows. Passing these checks does not
establish applied code, provider-side writes or every installation's UI. No real
Google file write is authorized by implementation or test delivery.
