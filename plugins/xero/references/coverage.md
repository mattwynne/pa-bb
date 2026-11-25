# Xero capability coverage

## Integration choice

Use Xero's API directly, with operation discovery generated from its official [OpenAPI definitions](https://github.com/XeroAPI/Xero-OpenAPI). This gives broader reach than a hand-picked MCP tool list without duplicating a bespoke tool for every operation.

Research compared:

- [Official Remote MCP](https://developer.xero.com/documentation/guides/remote-mcp/overview): curated accounting tools, not the whole API. It has separate OAuth/plan eligibility, and does not independently confirm writes for the user. This plugin does not open a second Remote MCP connection.
- [Official open-source MCP](https://github.com/XeroAPI/xero-mcp-server), reviewed at `fb4a4bb88e7095e99830314a517adae6bc58ffc2`: selected accounting and payroll tools built on `xero-node`. It also defaults to the first tenant and has diagnostics that need adaptation for this project's privacy rules. We do not run it as an extra authentication/token owner.
- [Official xero-node SDK](https://github.com/XeroAPI/xero-node): broad API coverage, generated from the official definitions. The plugin uses those definitions directly so discovery retains provider field casing and the existing BB-owned OAuth connection, bounded transport and diagnostics.
- [Community MCP example](https://github.com/derekclair/xero-mcp): a useful permission-oriented wrapper, but not an API superset. No reviewed wrapper established access to private UI-only operations that the underlying provider does not expose.

MCP and SDK wrappers are alternatives, not evidence that every Xero screen is programmable. Add a wrapper only if it supplies a demonstrated capability beyond this API path; do not create another credential owner for equivalent endpoints.

## Catalog snapshot

Pinned source: [`XeroAPI/Xero-OpenAPI@cad38324682120cf646043331583cd1e146e7d63`](https://github.com/XeroAPI/Xero-OpenAPI/tree/cad38324682120cf646043331583cd1e146e7d63), provider version `20.1.0`.

| API family | Catalog operations | Access caveat |
| --- | ---: | --- |
| Accounting | 235 | Accounting scopes and Xero user role; includes contacts, accounts/settings, invoices/email/PDF, quotes, purchase orders, credit notes, journals, payments, transfers, attachments and reports. |
| Assets | 6 | Asset permissions/features. |
| Files | 18 | File permissions; binary downloads and multipart uploads. |
| Projects | 16 | Projects permissions/subscription. |
| Payroll AU | 32 | Country, payroll permissions and subscription. |
| Payroll AU v2 | 9 | Country-specific v2 timesheets. |
| Payroll NZ | 71 | Country, payroll permissions and subscription. |
| Payroll UK | 69 | Country, payroll permissions and subscription. |
| Bank Feeds | 7 | Xero-approved financial institution/app eligibility; not general bank-feed scraping. |
| Bank Feeds v2 | 5 | Separate approved `bankfeedsv2` access. Statement imports still use the documented v1 service. |
| Finance | 8 | Additional Xero certification/agreements; includes statement/reconciliation-related data. |
| Account Data | 3 | Provider eligibility and specific account-data grants; availability must be checked with Xero. |
| App Store | 4 | Partner billing eligibility and separate client-credentials grant. |
| Identity | 2 | Connection management; OAuth/token operations remain private. |
| **Total** | **485** | Catalog presence is not an access grant or live verification. |

The pinned repository does not cover every separately documented Xero service. Three additional raw routes avoid turning that omission into a plugin restriction:

- `einvoicing` uses the documented eInvoicing 1.0 registration service, subject to approved app access.
- `practice-manager` uses Practice Manager 3.1, including JSON/XML request bodies. It requires a practice-only grant and verified practice tenant, not an organisation grant.
- `platform` accepts another documented relative path on `https://api.xero.com`, including eligible practice/HQ/Tax APIs. It is not an arbitrary-host proxy or a claim to know private endpoints. Approved provider documentation and the appropriate authentication/permissions remain necessary.

These raw routes add no generated operation counts to the **485** above. [Request examples](api.md) explain how to use them. Xero's organisation and practice scope families cannot be combined in one login grant; the owner can choose an exact scope override including offline access, then reconnect. One configured client/login is supported at a time, not simultaneous independent organisation and practice logins.

`xero_list_operations` searches/pages the generated catalog; descriptions and schemas cover every catalog entry. `xero_request` can route every entry, including inherited headers, array query serialization, PDF wire-path aliases, JSON, binary and multipart bodies, and empty/conditional responses. Explicit raw paths within known Xero API bases support provider additions not yet in the snapshot. Hosts and bearer tokens are never tool inputs.

## What remains outside this claim

- No live provider operation has been verified for this expanded surface. Generated-data tests prove routing and encoding, not account eligibility, successful business changes, XML business semantics beyond known error-status detection, or every provider contract.
- OAuth scopes, user roles, subscription/country rules, app tier, partner certification, commercial agreements, provider deprecation and rate limits still apply. Enabling a local capability does not override them.
- Upstream Accounting scope declarations still contain legacy bundled scopes. Discovery includes documented granular equivalents for common resources/reports, but labels these as hints and lets Xero enforce access. Consult [current scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/), not an inferred tool count.
- The Accounting API does not expose the interactive unreconciled Bank Rec queue. Approved Finance statement data is a distinct capability and does not prove queue completeness. Bank Feeds is not a general read API for all bank-feed lines. The separate [bookmarklet capture/import flow](bank-rec.md) brings user-downloaded visible-only JSON into BB; it does not change API coverage, verify a live queue or prove completeness. Final browser reconciliation remains manual.
- `xero-webhooks.yaml` describes inbound event payloads, not outbound callable operations. This change does not host webhook subscriptions, verify incoming signatures or implement an event-driven workflow.
- The general caller reports provider responses and safe partial-failure receipts. It does not promise the focused invoice/payment helpers' automatic financial checks. Read back consequential changes and inspect uncertain outcomes instead of retrying.

## Refreshing the catalog

The checked-in generated JSON and MIT license make installation/build/runtime independent of the upstream repository or Python. Source hashes are stored per specification.

To update intentionally, review an upstream Git revision and run:

```sh
# Development generation only: Python with PyYAML is required.
PYTHON=/path/to/python npm --prefix plugins/xero run catalog:update -- /path/to/Xero-OpenAPI
npm --prefix plugins/xero test
npm --prefix plugins/xero run typecheck
npm --prefix plugins/xero run test:host
```

Review changed operations, servers, schemas, scope hints and license before committing. No automatic network update runs at plugin startup. PyYAML is used because this upstream Bank Feeds v2 revision contains unindented closing quotes rejected by the JavaScript YAML parsers tried; the source is not silently patched or dropped.
