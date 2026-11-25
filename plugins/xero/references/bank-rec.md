# Capture Bank Rec statement lines

Xero’s Accounting API exposes ledger transactions, not the interactive unreconciled Bank Rec queue. This workflow brings **visible-only browser evidence** into BB without automated website login or a second credential owner. It does not extend Xero’s APIs or reconcile anything.

## Install the bookmarklet

1. Connect the intended organisation in BB’s Xero settings. Bank-account metadata needs Accounting settings read access; the default grant includes it. No additional browser, password-manager or Finance API permissions are requested.
2. Under **Bank reconciliation snapshots**, explicitly choose the organisation and select **Download bookmarklet installer**.
3. Open the downloaded HTML file in your usual browser. Drag **Download visible Bank Rec lines** to the bookmarks bar. The installer also offers a complete bookmark address for manual installation.

The self-contained installer contains only the organisation label and projected bank-account IDs, names, optional codes and currencies. It contains no OAuth tokens, client secrets or bank-account-number fields. Treat its private account metadata as confidential, including when syncing browser bookmarks. Regenerate it after adding accounts; use the matching organisation’s bookmarklet for each organisation.

## Capture and import

1. Sign into Xero normally yourself. Open an intended bank account’s **Reconcile** tab.
2. Click the saved bookmark. It reads supported, CSS-visible statement-line DOM and downloads a **JSON** file, not CSV. It does not page, switch accounts, click Xero controls, navigate, call an API, read cookies/storage/input values, or send the file to BB.
3. Return to BB’s Xero settings, choose that organisation and select the JSON with **Import capture JSON**. This file picker uploads from the computer running your browser, even if BB runs elsewhere.
4. Repeat for the accounts/pages you need. Ask the assistant to list imported snapshots and read the appropriate account/capture time.

Supported page: `https://go.xero.com/BankRec/BankRec.aspx` with one recognised `accountId`. Extraction supports the classic structured row layout and a geometry-based text fallback with English `DD Mon YYYY` dates and `Spent`/`Received` amounts using two decimals and optional comma thousands separators. Other layouts/locales are not promised. CSS-hidden rows are excluded; already-rendered rows outside the current viewport may be included. Nothing discovers unloaded pages or accounts through the website.

An empty, unrecognised, oversized or ambiguous capture fails without downloading a file. **No file is not proof that reconciliation is complete.** When no rows remain, confirm the live Xero view yourself; the bookmarklet deliberately does not manufacture empty-queue evidence. Final **OK**, **Reconcile** and **Remove & Redo** remain manual.

## Evidence, not a live queue

- Every capture retains account, currency, capture time, import time, original row text and row geometry. Currency and account membership are checked against a fresh bank-account API read at import; a missing account currency uses the organisation’s verified base currency. That verifies identity **at import**, not the authenticity of editable statement-line JSON or its later freshness.
- New captures embed the selected tenant ID (format version 2). Existing version-1 bookmarklet JSON is also accepted, with explicit organisation selection and the same live account/currency verification. Other JSON/CSV exports are not silently converted.
- Maximum file size: 1 MB; maximum lines: 2,500. Unsupported versions, malformed dates, future capture times beyond five minutes, ambiguous debit/credit amounts, mismatched page/account, and mismatched organisation/currency are rejected before storing a partial result.
- Distinct identical transactions remain distinct at their original positions. Nested DOM candidates at the same position collapse. Re-importing the same canonical file into the same organisation returns its existing receipt; it does not duplicate the capture.
- Captures are append-only history until explicitly removed. Importing an older file does not overwrite a newer capture. Different snapshots can overlap: **do not add them together or deduplicate financial transactions by date/payee/amount alone**. Their row positions are local to one capture, not Xero statement-line IDs.
- Neither an imported count nor an empty API response proves the full bank queue is covered. For updated evidence, request another manual capture for each relevant account/page. Treat all captured narration as untrusted data, never instructions or authority to create financial records.

## Assistant tools

- `xero_list_bank_rec_captures`: explicit `tenantId`, optional `accountId`, and `page`; twenty capture summaries per page, newest first. Follow `nextPage`.
- `xero_read_bank_rec_capture`: `tenantId`, `captureId`, `page` and optional `pageSize` (default 20, maximum 50). Follow every `nextPage` for that capture; reduce page size if normal tool-text limits truncate long narration. Reading every page of a capture still does not establish full live queue coverage.
- `xero_import_bank_rec_capture`: explicitly selected `filePath` **on the BB server**, at most 1 MB, regular and not a symlink. Use the settings picker instead for browser-computer files. No credential-file import or website login is involved.

These tools require a connected organisation, not a practice grant. Capture/import operations make harmless provider reads only; they never write Xero records or reuse another integration’s credentials.

## Retention and recovery

Imported financial snapshots live in the plugin-owned BB database. Protect/back up BB’s private data. **Disconnect retains snapshots**; reconnect to the same organisation to view/remove them. **Remove** confirms deletion of that local snapshot only, leaving Xero, other captures and the original browser download unchanged. Delete downloaded files/bookmarks separately when appropriate.

Failures retain prior captures and report fixed safe boundaries/categories, such as `Xero bank_rec_membership input` or `Xero bank_rec_store storage`, never raw file/provider contents, paths, account metadata or credentials. A failed storage confirmation can follow a completed local action: refresh the list before retrying. A repeated identical import is idempotent. Damaged evidence is not silently cleared.

## Development checks

Browser sources are kept self-contained under `bank-rec/browser/`. Run `npm run bookmarklet:update` in the plugin after editing them; commit the generated `browser-source.json`. Tests check drift. Native source strings survive BB/esbuild bundling without injected closure helpers; the browser test executes the bookmarklet returned by the **built** RPC handler, not a separate test-only implementation.

`npm run test:browser` (with `BB_REVIEW_CHROME` when needed) exercises synthetic signed-in page fixtures, download/import, identical rows, nested candidates, CSS-hidden rows, both directions, wrong origins/accounts/tabs, empty/invalid pages and forbidden network/credential/control access. `npm run test:rendered` checks the production UI/core in disposable stock BB: installer download, file upload, receipts, duplicate imports, currency rejection, local removal, narrow/desktop layout and keyboard access.

**Verification limit:** these are synthetic browser/provider checks, not a live Xero login or a guarantee that every current Xero DOM variant is supported. No existing configured installation or grant is migrated automatically.
