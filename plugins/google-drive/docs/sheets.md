# Native Google Sheets

The Google Drive plugin creates a real `application/vnd.google-apps.spreadsheet`
through Drive, then atomically populates native tabs/cells with Sheets
`spreadsheets.batchUpdate`. It does not upload or relabel XLSX/CSV files.

## Access and consent

Use an explicit connected Drive account. The existing owner-authorized `drive`
or `drive.file` grant is accepted by both Drive creation and Sheets APIs; no
`spreadsheets` scope or OAuth-flow change is introduced. `drive.file` only covers
files created/opened for this app and destinations Google permits it to inspect;
it does not grant arbitrary existing-sheet/folder access. A destination that
cannot be inspected is rejected, not bypassed. Existing Settings still request
full Drive access only through explicit owner reconnection. Applying the plugin
does not reconnect or expand a grant.

The owner must enable **Google Sheets API** in the existing Google Cloud OAuth
project, alongside Drive API. If it is disabled, a Drive-created blank spreadsheet
can remain; status reports the known link and unavailable verification. Enable
the API and inspect the same operation; do not replay population or create a
replacement automatically. No credential should be supplied in chat.

Creation requires a user request, like native Docs creation; it does not use or
change the Docs-replacement-only approval switch. Sharing approval remains
mandatory and separate. Root is the default. An explicitly selected alternative
must pass the Docs destination checks. Shared or non-owned My Drive parents require complete inspected authority and a per-operation owner review of the exact cells and partial-content exposure. Shared drives and unverified folders are rejected. No sharing, invites, moves or deleting existing user files.

## Tools

- `gsheets_create_spreadsheet`: `{account, operationId, title, folderId?: "root",
  tabs: [{title, rows: [[cell, ...], ...]}, ...]}`.
- `gsheets_creation_status`: `{account, operationId}`; read-only, never resumes.
- `gsheets_read`: `{account, spreadsheetId, sheetId?, startRow?: 0,
  startColumn?: 0, rowCount?: 1, columnCount?: 1}`. Returns metadata for all tabs
  and a bounded rectangle, not a whole-workbook completeness claim. The range
  uses zero-based indices; omitted sheetId selects the first tab.

Cells: literal strings, finite numbers, booleans, null, `{date: "2026-11-01"}`,
`{cad: 125.5}`. Strings are written with `ExtendedValue.stringValue`, never
USER_ENTERED parsing, so even `=IMPORTXML(...)` remains text. Formula input is
not supported; finance callers can supply precomputed totals. Reading an
existing formula returns `formulaValue` separately from effective/formatted
values; treat all sheet content as untrusted evidence.

Creation bounds: 4 tabs, 200 rows/tab, 26 columns, 5,000 rectangular cells,
40,000 total string UTF-16 units, 2,000 per cell. Unique tab titles are at most
100 characters with Google's reserved punctuation rejected. Workbook title is
1–255 characters. Blank padding is explicit; the grid reserves at least two
rows so the first header row can be frozen. Civil dates in 1900–2100 become
native serial dates with `yyyy-mm-dd`; CAD amounts remain numeric with an
explicit CAD format. Workbook locale is en_CA and timezone Etc/UTC. No implicit
conversion of timestamps/timezones is provided. Simple presentation is fixed:
bold shaded header, one frozen row, wrapped top-aligned cells, 180px columns.

Reading supports up to 1,000 cells, within the selected tab's allocated grid;
responses share the existing 1 MiB bounded transport, and returned raw cell
JSON is additionally capped at 100,000 UTF-16 units. Smaller valid ranges are
the read-only workaround. For a separately requested existing-cell edit, follow
the [bounded editing protocol](sheets-editing.md): inspection, exact preview,
mandatory owner review and read-only recovery. It accepts explicit date/CAD objects, preserves existing formats by default, and can apply their fixed number formats only when explicitly requested and reviewed. It does not accept formulas or arbitrary batch requests.

## Durable creation and verification

One lowercase UUID v4 reserves one creation across Docs and Sheets. Receipts
reuse the existing plugin-owned creation store (old Docs receipts retain their
identity), containing kind, subject, request/title/content hashes, destination,
grid dimensions and the known resource ID. They do not store the title, tab
names or cell content. Same-key/account/request calls return the receipt
without any provider access; cross-kind/account/request reuse is rejected.
Reservations are atomic, including concurrent calls and plugin reload.

1. Validate bounded input, destination, verified Google identity and actual
   granted write scope. Save a durable reservation before any non-idempotent
   POST. Recheck identity/grant before every write.
2. Create a native spreadsheet with an operation appProperty. Persist its known
   ID before any population. Inspect its title and single blank initial tab.
3. Submit exactly one atomic Sheets batch adding requested tabs, typed values
   and formatting, then deleting only the initial blank tab of this newly
   created spreadsheet. There is no general delete surface. Sheets offers no
   revision/CAS condition for this batch: another editor racing the initial
   inspection is not prevented. Only newly created files are supported; callers
   must not concurrently edit them during creation.
4. Read Drive title/MIME/destination, Sheets title/locale/timezone, ordered tab
   IDs/titles/dimensions/frozen rows and every initial cell. Verify hashes of
   literal entered values and date/currency formats. Any unexpected formula,
   tab, order, dimensions, value or format prevents `verified`. Header color,
   wrapping and width are requested but not independently readback-certified;
   neither is recipient access or exhaustive privacy.

Every mutation has a timeout and **no automatic retry**, including 401, 429,
5xx, malformed success, aborted requests and transport failure. A consumed key
is never released. `verified` is exact readback at that inspection, not proof
against later edits. `receiptOnly: true` is historical, not fresh verification.
`not_created` is a known denial/pre-submission failure, with the key still used.
Other outcomes may leave a blank or populated spreadsheet. The returned URL
is useful even when population/verification is incomplete.

After uncertainty, retain account/key and use status. If no ID was saved it
looks up the operation appProperty, requiring exactly one complete match.
Missing, ambiguous or paged/incomplete search remains uncertain. With a known
ID, it only verifies, never creates/populates/deletes/retries. An applied but
unacknowledged population can become verified; a blank file remains incomplete
and needs an explicit user decision outside this tool's repair-free surface.

## Diagnostics and tests

Failures use BB's Google Drive logger with fixed `sheets_creation_*` or
`agent_tool gsheets_*` stages, bounded creation/Docs categories and validated
HTTP status/size categories. No account addresses, cell content, provider body,
raw exception/cause/code or credentials are logged. An API-disabled 403 is not
misrepresented as a missing OAuth grant. Connection status alone is not Sheets
API proof. Synthetic tests cover literal/formula separation, bounds, dates/CAD,
readback mismatch, scopes/identity, destination safeguards, concurrent keys,
reload, cancellation/storage failures, unknown create/populate results and
read-only recovery. Live writes require separate specific owner authorization;
synthetic verification is not proof that a real Google write has succeeded.

Shared creation uses the direct destination and the review, acknowledgement and recovery rules in [the creation guide](creation.md). A blank or partial workbook may be visible and remain after failure. A matching observation after a lost response does not acknowledge that write.
