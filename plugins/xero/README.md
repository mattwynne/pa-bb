# Xero for BB

Use Xero's APIs through the assistant, with the access you grant. Discover operations and provider schemas, then read or change records, send requested invoices, manage contacts/settings, record cross-currency payments, or transfer source files. Focused invoice/payment helpers remain available for common work with extra financial checks.

The plugin catalogs **485 operations across 14 official OpenAPI families**. Raw routes also cover documented eInvoicing, Practice Manager 3.1 and other paths on Xero's API host. It does not promise access to every Xero screen: scopes, user roles, subscriptions, country rules and partner approval still apply. See the [coverage matrix and integration research](references/coverage.md).

## Install and connect

Requires a private, single-user **BB 0.50.1 or later**, Node.js 22 or later, and your own Xero **Web OAuth app**. No extra MCP server, CLI, browser profile or password-manager dependency is required.

```sh
bb marketplace refresh pa-for-bb
bb plugin install xero@pa-for-bb
```

For development, install `plugins/xero` from a permanent local checkout through BB's supported local-path mode. Follow [Contributing](../../CONTRIBUTING.md).

1. In [Xero Developer apps](https://developer.xero.com/app/manage), create or open a **Web app** using the authorization-code flow—not a Custom Connection or native/desktop PKCE app.
2. Open the Xero plugin in BB. Copy its exact **redirect URI** into the Xero app's OAuth redirect URIs. Configure an HTTPS `BB_APP_URL` for remote access; HTTP is accepted only on localhost. BB derives the address; tools cannot override it.
3. In BB's **Configuration**, save the app's client ID and client secret. These are app credentials, not your Xero password. Never paste credentials, OAuth codes or callback responses into chat or logs.
4. Choose the permissions below, then **Connect Xero**. Sign in at Xero, select the intended organisation or practice, and approve the requested access.
5. For an organisation, choose **Check access** for a harmless `/Organisation` read. For a practice, request a documented practice API read instead; an Accounting check would not establish practice access. A discovered connection alone does not prove API access. Start a fresh BB conversation to discover the tools and bundled skill.

One login can connect several organisations or practices, depending on its scopes. This plugin owns its connection and does not import another tool's credentials or refresh tokens.

## Permissions

**Existing grants are not broadened by upgrading.** The original default scopes remain: offline access; invoice, payment and attachment work; read-only contacts/settings/bank transactions; and Bank Summary, Trial Balance, Profit and Loss and Balance Sheet reports.

To request more access, save space-separated **Additional Xero OAuth scopes** in Configuration, then choose **Reconnect** and approve them in Xero. Saving a setting alone does not request a token or upgrade the existing grant. The connected screen shows actual granted scopes behind **Access and permissions**, and warns when requested permissions are missing.

For broader Accounting work, the relevant additional scopes include:

```text
accounting.contacts accounting.settings accounting.banktransactions accounting.manualjournals accounting.budgets.read accounting.journals.read accounting.reports.aged.read accounting.reports.budgetsummary.read accounting.reports.executivesummary.read accounting.reports.tenninetynine.read accounting.reports.taxreports.read paymentservices
```

Choose only the access needed for your work. Journal/report availability may require additional provider eligibility. Read/write versions replace redundant read-only requests; discovery scope hints are guidance, not proof of eligibility or a grant.

Other services use their own scopes, such as `files`, `assets`, `projects` and the regional `payroll.*` scopes. Finance, Account Data, Bank Feeds and eInvoicing require specific grants and Xero eligibility; selecting a scope does not bypass certification, app-tier or commercial requirements. Consult [Xero's current scope table](https://developer.xero.com/documentation/guides/oauth2/scopes/) rather than guessing a permission from a tool name.

### Practice and other specialized grants

**Exact OAuth scope override (advanced)** replaces both the default and additional scope lists. Use it for a practice-only grant or another approved combination. It must include `offline_access` for a refreshable BB connection. Xero does not permit organisation and practice scope families in the same authorization flow: choose the intended connection type and use the exact scopes from its documentation. Reconnect applies the choice; existing tokens are not silently changed.

The plugin preserves verified `ORGANISATION` and `PRACTICE` tenant types and never defaults to the first tenant. Practice Manager 3.1 supports raw JSON/XML requests using its documented paths. Practice/HQ/Tax access still depends on Xero approval and documentation available to that app; no private endpoint is invented or promised.

### App Store partner billing

App Store APIs use **client credentials**, not the user login grant. For an approved partner app, explicitly enable **App Store partner billing** in Configuration. Only a requested App Store call obtains a separate `marketplace.billing` token, cached in memory. Enabling the setting alone performs no grant request. Do not put `marketplace.billing` into login scopes.

Disconnect removes the local login and clears the cached application token. If partner billing remains enabled, a later explicitly requested App Store call can obtain another application token; turn off that setting to prevent this. Provider revocation is separate.

## Using the tools

1. `xero_list_tenants` refreshes organisations/practices; choose the intended tenant explicitly.
2. `xero_list_operations` searches/pages the official operation catalog and lists API families and access caveats. Discovery works without a login.
3. `xero_describe_operation` returns method, wire path, parameters, body/response schema references and scope hints.
4. `xero_read_schema` resolves a schema name or JSON-pointer fragment, retaining Xero field casing.
5. `xero_request` calls that operation or an explicit raw relative path. See the [request reference and examples](references/api.md).

The general caller supports all HTTP methods, full JSON fields, XML/text bodies, query arrays and conditional headers, binary uploads, multipart Files uploads, PDF/attachment downloads and optional JSON downloads. Hosts, bearer tokens and client secrets are not tool arguments. API requests stay on the fixed Xero API host, redirects are refused, and identity tools do not expose OAuth/token operations.

Uploads use explicitly requested regular files on the BB server, not the browser computer. Downloads are saved byte-for-byte into current-thread storage on the BB server with new private filenames and SHA-256 receipts, without returning binary/base64 content to the model. Request/transfer size is bounded to 20 MiB; provider limits can be smaller. Normal tool text is bounded to 48,000 characters; use filtering, paging, schema fragments or `downloadName` rather than treating truncated output as complete.

## Financial safeguards

Connecting grants provider permissions, **not blanket consent to change records**. Use writes only for the user's explicit request. There is no extra plugin approval screen for an already-requested write.

The focused helpers provide additional checks:

- Create invoices/bills as DRAFT with an existing contact, explicit date/currency and source-backed lines.
- Read before updating, preserve CurrencyRate unless deliberately changed, keep currency changes DRAFT and read back the result. Reference-only edits check currency, rate, dates, totals and payment state.
- Record verified same-currency payments with invoice/account/balance checks and a narrow duplicate check. This records an existing payment; it does not send bank money.
- Read back correction history and verify focused attachment uploads by name and byte length. That is not a cryptographic verification of provider-stored contents.

**Those helper defaults are not limits on the general API.** It can send invoices, create/update contacts, enable payment accounts, use other supported invoice statuses, and record cross-currency payments with full provider fields. It sends the requested payload unchanged and does **not** inherit the helpers' automatic exchange-rate, duplicate or financial read-back checks. Read the bundled [Xero skill](skills/xero/SKILL.md), verify the source and current record, preserve untouched financial fields, and read back consequential changes. For cross-currency payments, distinguish bill-currency `Amount` from bank-currency `BankAmount`; use the [manual handoff](references/cross-currency-payments.md) when recording is not authorized or the provider behavior is unclear.

HTTP 200/207 error and partial-failure results are not reported as successful changes. They return a bounded receipt of observed IDs and the idempotency key without exposing raw provider error messages; an observed ID does not establish success. Transport, cancellation, response or verification failures can follow an applied write. Inspect the record before trying again. Writes are never retried automatically. The general caller returns a supplied or generated idempotency key, but not every endpoint declares support and Xero's supported key cache is temporary—not permanent duplicate prevention.

Accounting `/BankTransactions` is the ledger, not the interactive unreconciled bank-feed queue. Approved Finance APIs offer separate statement/reconciliation-related data; Bank Feeds APIs manage eligible feed connections and imports. Neither establishes a complete interactive queue. Final browser OK, Reconcile and Remove & Redo remain manual.

## Recovery and private state

- **Sign-in cancelled/expired:** reconnect. State expires after five minutes and is consumed once. If exchange succeeded but connection discovery failed, refresh connections rather than replaying the callback.
- **Access rejected:** check granted scopes, app eligibility, country/subscription and Xero user role. Request additional permissions through Configuration and Reconnect only when intended.
- **Client changed:** restore that client's settings or reconnect. Configuration changes invalidate pending sign-in and in-flight authorization, not silently migrate an existing grant.
- **Disconnect:** confirms removal of locally stored login tokens/connections and pending sign-in. It leaves Xero records, documents and other integrations unchanged. Remove the app in Xero's Connected apps to revoke provider access too. See the separate billing caveat above.

Client secrets use BB's protected settings. Login tokens and hashed short-lived OAuth state live in the plugin-owned BB database; protect and back up BB's private data directory. Refresh rotation is serialized, and stale callbacks/reads cannot resurrect a disconnected connection. Other tools' token files and browser profiles are untouched.

`bb plugin logs xero -n 15` records fixed boundaries/categories such as `Xero api_read authorization http_403` or `Xero api_result provider_result`, not URLs, arguments, record IDs, account content, provider bodies or credentials. A diagnostic identifies a failing boundary, not whether an uncertain mutation reached Xero.

## Development and verification

```sh
npm ci --prefix plugins/xero
npm --prefix plugins/xero test
npm --prefix plugins/xero run typecheck
npm --prefix plugins/xero run test:host
BB_REVIEW_CHROME=/path/to/chrome npm --prefix plugins/xero run test:rendered
node scripts/sync-connection-ui.mjs --check
```

Generated-data tests exercise routing for all 485 catalog operations, uploads/downloads, full-field writes, XML/raw routes, grant changes, tenant selection, partial results and safe diagnostics. Host tests run built handlers through the public SDK. Rendered tests use disposable stock BB and a test-only fake provider at desktop/narrow widths with keyboard checks. Optional `BB_REVIEW_REFERENCE_PLUGIN` points to a Fastmail checkout for rendered comparison; `BB_REVIEW_ARTIFACTS` saves private local screenshots. Catalog generation is a separate reviewed development task documented in [coverage notes](references/coverage.md); installation/runtime needs neither Python nor an upstream checkout.

**Verification limit:** no live Xero OAuth grant, provider read, report, upload, financial write, payroll, practice or partner operation has been verified for this plugin. Synthetic routing proves neither provider acceptance nor business outcomes. Connect the intended account and verify a harmless read before relying on it. Never perform a financial write merely to smoke-test deployment.
