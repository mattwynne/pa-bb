# Xero for BB

Look up Xero records and reports, prepare requested draft invoices and supplier bills, update invoices, record same-currency payments, and attach original source documents. Each call selects an organisation explicitly.

Financial changes require the user's explicit request. The plugin does not send invoices, transfer money, read unreconciled bank-feed lines, or click Reconcile. Foreign-currency bank payments use a [manual handoff with two clearly labelled amounts](references/cross-currency-payments.md).

## Install

Requires a private, single-user **BB 0.50.1 or later**, Node.js 22 or later, a Xero organisation, and your own Xero **Web OAuth app**. No extra CLI, MCP server, browser profile or password-manager dependency is required.

From the PA marketplace:

```sh
bb marketplace refresh pa-for-bb
bb plugin install xero@pa-for-bb
```

For development, install `plugins/xero` from a permanent local checkout using BB's supported local-path mode. Follow [Contributing](../../CONTRIBUTING.md); builds and reloads are separate from Git publication.

## Setup

1. Open [Xero Developer apps](https://developer.xero.com/app/manage). Create or open a **Web app** using the authorization-code flow. Use your own application/company URL where requested. Do not choose a paid Custom Connection or a native/desktop PKCE app for this plugin.
2. Open the plugin in BB. Copy its exact **redirect URI** into the Xero app's OAuth redirect URIs. For remote BB access, configure an HTTPS `BB_APP_URL` first; HTTP is accepted only on localhost. The address is always derived from BB, not supplied through tool arguments.
3. In BB's **Configuration**, save the app's client ID and client secret. These are app credentials, not your Xero account password. Never paste credentials, OAuth codes or callback responses into chat or logs.
4. Choose **Connect Xero**, sign in at Xero, select the intended organisation(s), and approve the requested permissions. Xero returns directly to BB. This plugin owns one login connection that can expose several organisations; it does not import another tool's credentials or rotate its refresh tokens.
5. Choose **Check access** beside an organisation. This performs a harmless Accounting API `/Organisation` read. A discovered organisation alone does not prove that accounting reads work. Start a fresh BB conversation to discover the tools and bundled Xero skill.

For example: “Find supplier bill ABC-123 in my Xero organisation and check whether it already has a payment.” The assistant first lists organisations and uses the selected tenant ID.

### Permissions

The plugin requests granular scopes:

- `offline_access` for a refreshable connection.
- `accounting.invoices`, `accounting.payments`, `accounting.attachments` for requested invoice/bill work, payment recording and source documents.
- `accounting.contacts.read`, `accounting.settings.read`, `accounting.banktransactions.read` for existing contacts, accounts, settings and ledger transactions.
- `accounting.reports.banksummary.read`, `accounting.reports.trialbalance.read`, `accounting.reports.profitandloss.read`, `accounting.reports.balancesheet.read` for those four reports.

Connecting grants these provider permissions; it is not blanket consent to change records. There is no extra plugin approval screen for each explicitly requested write. Missing grants fail closed and require reconnecting. There is no arbitrary write endpoint, contact/settings mutation or automatic account-enablement tool.

See [Xero's scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/) and the [API reference](references/api.md). Provider subscriptions and user roles can still limit operations.

## Safeguards and limits

- **Exchange rates:** an update reads the current invoice, preserves its rate unless deliberately changed, and reads back the result. Reference-only edits check currency, rate, dates, totals and payment state. Currency changes stay DRAFT and omit the old rate.
- **Drafts first:** new invoices/bills require an existing contact ID, date, currency and line items. Review original evidence, tax and totals before requesting approval. Replacing LineItems requires every retained line and its ID.
- **Payment recording is not sending money:** the tool checks invoice state, balance, account and currency. Matching existing payment dates/amounts stop a second recording. Cross-currency payments are refused; use the [manual template](references/cross-currency-payments.md). An account whose currency cannot be verified also needs a manual handoff.
- **Correction notes:** void/delete operations may ignore Reference; use a separate history note. The plugin reads history back to verify the requested note.
- **Original documents:** attach regular PDF, PNG or JPEG files on the BB server, at most 3 MB. Symlinks and mismatched file signatures are rejected. The tool does not publish attachments online and verifies the saved name and byte length. This is not a cryptographic verification of the saved contents.
- **Honest outcomes:** validation errors inside HTTP 200 responses are errors. Transport, response or verification failures may follow an applied write; inspect the record before trying again. Writes are never retried automatically. Retain the same UUID idempotency key only for an identical, reviewed retry; [Xero's key cache](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/) lasts about six minutes, not forever.
- **Coverage:** listings return one page; response and text limits are explicit. Empty/truncated results are not a complete audit. `/BankTransactions` is the ledger, not the Reconcile tab. Final OK, Reconcile and Remove & Redo remain manual.

The bundled [Xero skill](skills/xero/SKILL.md) carries lessons from earlier invoice, receipt, duplicate, FX and reconciliation work without embedding anyone's accounting policy, vendor treatment or infrastructure.

## Recovery and private state

- **Sign-in cancelled or expired:** choose Reconnect. OAuth state expires after five minutes and is consumed once. If token exchange succeeded but organisation discovery failed, choose Refresh organisations rather than replaying the callback.
- **Access rejected:** check the saved client, provider permissions and Xero user role; reconnect. Client changes invalidate pending sign-in and require restoring that client or reconnecting.
- **Read failed:** settings and logs distinguish a provider/network failure from an empty organisation list. Check access again; a prior successful check is not continuing proof that every tool works.
- **Disconnect:** confirms removal of this plugin's local tokens, organisation list and pending sign-in. It leaves Xero records, source documents and other integrations unchanged. To revoke provider access too, remove the app under Xero's Connected apps. One login's disconnect affects all its organisations.

Client secrets use BB's protected settings. Access/refresh tokens and short-lived hashed OAuth state live in the plugin-owned BB database. Protect and back up BB's private data directory; do not publish it. Refresh rotation is serialized, and disconnect/configuration changes invalidate in-flight authorization. The plugin never reads or modifies other tools' token files or browser profiles.

`bb plugin logs xero -n 15` shows bounded entries such as `Xero accounting_read authorization http_403` or `Xero token_refresh transport`. Logs name the failed boundary and fixed category, not provider bodies, record IDs, tool arguments, account content or credentials. A log establishes which boundary failed, not whether an uncertain write reached Xero.

## Development and verification

```sh
npm ci --prefix plugins/xero
npm --prefix plugins/xero test
npm --prefix plugins/xero run typecheck
npm --prefix plugins/xero run test:host
BB_REVIEW_CHROME=/path/to/chrome npm --prefix plugins/xero run test:rendered
node scripts/sync-connection-ui.mjs --check
```

Tests use generated records, fake secrets and synthetic provider responses. Host tests exercise built handlers through the public BB SDK. Rendered tests launch disposable stock BB with the production UI/core and a test-only fake provider, exercise first-run, pending consent, connected/read-verified, empty, failure/recovery and disconnect confirmation at desktop/narrow widths, and check keyboard activation and safe diagnostics. Optional `BB_REVIEW_REFERENCE_PLUGIN` points to an existing Fastmail checkout for side-by-side rendered comparison; `BB_REVIEW_ARTIFACTS` saves private local screenshots.

**Verification limit:** no live Xero OAuth grant, accounting read, report, attachment upload or financial write has been performed for this plugin. Synthetic tests and rendered review do not prove provider behavior. Connect the intended Xero account and perform a harmless read before relying on it. Real financial writes need the user's specific request, not a deployment smoke test.
