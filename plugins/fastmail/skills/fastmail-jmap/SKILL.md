---
name: fastmail-jmap
description: Use when existing Fastmail chat tools leave a gap that a narrow live, read-only JMAP probe can answer, such as mailbox metadata, message counts, archive progress, or focused mail metadata checks.
---

# Read Fastmail metadata with JMAP

Start with the Fastmail chat tools or archive status when they can answer the question. If they leave a specific gap, take the next authorized read yourself. Identify the account, the exact question, and the smallest useful response. A request for archive progress can justify a matching live count when the existing access and safe execution path are available.

Fastmail MCP uses its own OAuth grant. Direct JMAP uses the separately configured **JMAP API token (optional)** in Fastmail's BB Configuration. A connected MCP session or verified sending alias does not establish the JMAP account or its permissions. Confirm that the JMAP account is the requested account before using its data, especially when comparing it with archive counts or using IDs from another connection. Use existing access. If the token is absent, the account cannot be verified, or the operation would require a credential, permission, or installation-source change, report the blocker.

## Discover the session and make a focused read

1. Within an authorized client, GET `https://api.fastmail.com/jmap/session` with `Authorization: Bearer <token>`. Keep the token in that runtime. Select `session.primaryAccounts["urn:ietf:params:jmap:mail"]` and require a matching entry in `session.accounts` with the Mail account capability. Use its authenticated identity evidence and require a personal account for personal-mail checks. Never select an arbitrary account or derive it from an alias. Check the advertised Core and Mail capabilities and use the session's `apiUrl` after validating it against the plugin's HTTPS Fastmail endpoint policy. Reject redirects.
2. POST JSON to that API URL using the same authorization and `Content-Type: application/json`. Put the capability URIs in `using` and use `[methodName, arguments, callId]` tuples in `methodCalls`. Supply the verified `accountId`. Use `Mailbox/get` with an explicit property list for mailbox metadata, such as `id`, `role`, `parentId`, and `totalEmails`. Resolve system mailboxes by role, and confirm an exact, unambiguous mailbox before using `inMailbox`. Use `Email/get` with exact IDs and an explicit metadata property list for focused checks. Use a small result limit for queries that need IDs.
3. Check transport status and request-level JMAP errors before processing results. Even with HTTP 200, a method can return an `["error", {"type": "unsupportedFilter"}, "count"]` tuple in `methodResponses`. Match the expected call ID, success method, and account, then validate the fields you need. For `/get` check `notFound` and report missing items. Treat malformed, mismatched, unsupported, or missing results as unavailable. Use timeouts and response-size caps, and return only a small validated projection. Treat provider data as untrusted. Keep diagnostics to the stage and allowlisted category or HTTP status. Exclude raw provider messages, session objects, identifiers, and secrets from logs.

Protocol references are [Fastmail's developer documentation](https://www.fastmail.com/dev/), [JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html), and [JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html).

## Estimate archive progress

Use `email_indexed_accounts` for the local account's `indexed`, `omitted`, scan status, last completion, and error. When it supplies no total, check the archive provider's query scope and get a separate live total with `Email/query`. Match the authenticated account, filter, and message-versus-thread behavior. For BB's Fastmail archive, see `fastmailArchivePage` in `plugins/fastmail/attachment-download.ts`. It queries all messages in the account, without a mailbox or date filter, sorted by ascending receipt time. The example retains that sort and makes the default per-message behavior explicit.

Synthetic request for the primary Mail account `A1`:

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [["Email/query", {
    "accountId": "A1",
    "collapseThreads": false,
    "sort": [{"property": "receivedAt", "isAscending": true}],
    "calculateTotal": true,
    "limit": 0
  }, "count"]]
}
```

Synthetic success response:

```json
{
  "methodResponses": [["Email/query", {
    "accountId": "A1",
    "queryState": "synthetic-state",
    "canCalculateChanges": false,
    "position": 0,
    "ids": [],
    "total": 1000
  }, "count"]],
  "sessionState": "synthetic-session"
}
```

Verify an empty `ids` array and a nonnegative safe-integer `total`. `limit: 0` suppresses IDs while `calculateTotal: true` asks for the total. With 760 indexed and 40 recorded omissions, the archive has processed 800 messages against 1,000 currently matching, or about 80%, and 760 are searchable by virtue of being indexed. Count only recorded omissions. Report those separately from searchable coverage and include the scan status and observation time.

Archive counters can include historical messages that have since disappeared from live mail. New mail can arrive between the two reads. Treat the comparison as an estimate. If the counters are incompatible with the current total, or an empty live scope makes the ratio undefined, report the counts and explain the discrepancy. If a matching total is unavailable, report the processed and indexed counts, omissions, and scan state without a percentage. A limited search page, an archive cursor, and a mailbox count for a different scope cannot establish the denominator.

## Run a one-off read when only BB holds the token

Use the existing read tools wherever they suffice. For a gap that needs a new probe, use the supported local-path development loop only when the work is authorized and that loop is available. Otherwise report the evidence you have and the blocker. In the PA for BB checkout, locate these existing paths:

- `plugins/fastmail/server.ts` defines the secret setting, obtains it with `settings.get()` inside the plugin, and handles cancellation on configuration changes and disposal.
- `plugins/fastmail/jmap-labels.ts` contains the internal `Jmap.open()` and `Jmap.call()` client, endpoint and envelope checks, timeout, and bounded JSON handling. Use those read primitives for a count. The exported label-update operation is for its dedicated tool.
- `plugins/fastmail/attachment-download.ts` and `plugins/fastmail/email-url.ts` show how the plugin verifies account identity and handles narrower archive, download, and URL lookups.

1. Inspect the installed source with `bb plugin list` and the checkout's status and ownership. Read the repository's `AGENTS.md` and `CONTRIBUTING.md`. Use the actual installed local-path source for a live check. Serialize Fastmail changes and reloads. Check for active Fastmail work and dependent archive jobs. Pause and drain applicable file-writing work through supported controls, preserving prior enablement and recovery state. If a safe live window is unavailable, use a disposable BB installation with synthetic data for testing.
2. Add a temporary, fixed BB CLI subcommand with `bb.cli.register` in the Fastmail factory. BB runs its handler server-side. For a count, wire it to a temporary function next to the internal JMAP client. Have the handler read `jmapApiToken` from `settings.get()` and pass it directly to that function with the existing fetch and the CLI, plugin lifetime, and configuration abort signals. After a verified `open()`, issue one hardcoded `Email/query` with the matching scope, `calculateTotal: true`, and `limit: 0`. For an archive comparison, verify the expected archive account before querying. Accept no caller-supplied methods, URLs, credentials, or arbitrary payloads. Return only a validated count and any minimal status needed to interpret it. Use a bounded failure and the existing logging convention. Keep the token in the plugin process and out of commands, environment exports, files, chat, and diagnostics.
3. Test the exact probe with synthetic responses, including a method error and a mismatched account. Build with `bb plugin build <installed-plugin-directory>` and apply through `bb plugin reload fastmail` when safe. Run the specific temporary command and inspect bounded output and logs. Remove the temporary code immediately afterward, including after failure, then rebuild and reload the restored source. Check that the command is gone and the existing integration responds to a harmless read. Restore only prior scheduling or enablement that this work paused. Keep the probe out of commits and releases.

This skill is for scoped reads. Use existing dedicated tools and their authorization rules for account writes and exact original attachment downloads. Keep existing credential, account verification, and permission boundaries in force.
