# Accounting API reference

Use `xero_list_tenants` to discover verified organisation names and IDs. Every accounting tool requires tenantId; there is no first-tenant default. Connection discovery is not proof of Accounting API access; use **Check access** in settings for a harmless `/Organisation` read.

`xero_request` is GET-only. Supported paths:

- `/Invoices`, `/Invoices/{InvoiceID}`, and its `/History` and `/Attachments` collections
- `/Contacts`, `/Accounts`, `/Payments`, `/BankTransactions` and their individual IDs
- `/Organisation`, `/TaxRates`, `/Currencies`, `/TrackingCategories`, `/Items`
- `/Reports/BankSummary`, `/Reports/TrialBalance`, `/Reports/ProfitAndLoss`, `/Reports/BalanceSheet`

Use the query object for Xero parameters, not a URL or query string in path. For example:

```json
{"tenantId":"<connected-organisation-id>","path":"/Accounts","query":{"where":"Type==\"BANK\""}}
```

Use report-specific dates and filters from [Xero's Accounting API documentation](https://developer.xero.com/documentation/api/accounting/overview). An endpoint may require extra provider permissions or subscription features; a connected login does not prove every report will work. Responses are bounded to 2 MB and rendered tool text to 48,000 characters. A truncated response or one page is not a complete inventory.

Writes use focused invoice, history, same-currency payment and source-attachment tools. There is no arbitrary mutation endpoint, contact/settings mutation, send-invoice tool, online bank payment, Bank Rec scraper or reconciliation control in this version. Xero errors and validation-error results are reported safely without copying response bodies into diagnostics. Inspect the actual record when a write outcome is uncertain.

Provider references: [OAuth authorization-code flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/), [scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/), [idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/).
