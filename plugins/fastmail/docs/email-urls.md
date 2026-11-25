# Exact email web links

Use `fastmail_resolve_email_url({ emailId })` after an ordinary Fastmail
`search_email`, `read_email` or `read_thread` call returned that email. Use the
returned `url` unchanged. Do not assemble folder/email-ID URLs. If the tool
refuses, report that the link is unavailable rather than making up a fallback.
This applies to the direct provider tools and `fastmail_call_tool` alike.

## Evidence and accounts

The resolver uses the existing optional JMAP API token, with its existing mail
access. It does not use MCP OAuth credentials for JMAP, request submission access,
or infer login identity from sending aliases. No setup or grant is changed.

A successful provider read leaves a bounded, memory-only metadata receipt:
email ID, thread ID, RFC Message-ID values and received time. Receipts expire
after ten minutes, on connection revision changes, settings changes or reload.
No subjects, bodies, addresses, folder names or credentials are retained in this
cache. Search receipts avoid fetching a body merely to make a link.

Resolution reads the authenticated JMAP session and calls `Email/get` with only
`id`, `threadId`, `messageId` and `receivedAt`. The selected account must be the
session's primary **personal** mail account; the exact email and all receipt
metadata must match. Method, call tag, account ID, missing results and duplicate
results are checked. Shared-account resolution is intentionally unsupported.
A copied Message-ID alone is not account or exact-message proof.

The resolver obtains the account from the standard session
`primaryAccounts["urn:ietf:params:jmap:mail"]` and verifies its `accounts` entry
is personal and mail-capable. Fastmail's canonical personal account ID is `u`
followed by eight lowercase hexadecimal digits. Its web selector is the
hexadecimal part. This is an explicitly bounded **Fastmail-specific mapping**,
not a general rule for standard JMAP IDs, which are opaque.

No top-level session `userId` is required, and no extra setting is needed.
An unsupported account-ID format fails with `unsupported_account_format` rather
than stripping an arbitrary prefix. If a session also returns `userId`, it must
agree with the mapped account; it cannot override it. The session `username`
and MCP sending aliases never participate in this mapping. An unknown/shared
account or missing message evidence still produces no URL.

## Provider mechanism and limits

Research sources:

- [Fastmail API documentation](https://www.fastmail.com/dev/): authenticated
  session discovery and supported JMAP mail access.
- [RFC 8620 session resource](https://www.rfc-editor.org/rfc/rfc8620.html#section-2)
  and [RFC 8621 Email](https://www.rfc-editor.org/rfc/rfc8621.html#section-4):
  primary-account selection, account ownership/capabilities and account-scoped
  email/thread identifiers. Neither defines an email `webUrl`.
- [JMAP crash course](https://jmap.io/crash-course/index.html), linked by
  Fastmail's developer site: the Authentication section includes a Fastmail
  session example with the canonical `u` + eight-hex personal mail account ID.
- [Fastmail's JavaScript top-ten example](https://github.com/fastmail/JMAP-Samples/blob/main/javascript/top-ten.js)
  and [Python client example](https://github.com/fastmail/JMAP-Samples/blob/main/python3/tiny_jmap_library.py)
  select the mail account through `primaryAccounts`, not sending identities.
- Fastmail's public web-client assets, inspected at version
  `45add8716a-43a3c342f97f8fea`: the
  [bootstrap](https://app.fastmail.com/static/jmapui/45add8716a-43a3c342f97f8fea/bootstrap/bootstrap.js)
  reads `u` as web `userId`; desktop
  [main.mod.js](https://app.fastmail.com/static/jmapui/45add8716a-43a3c342f97f8fea/app/module/desktop/main.mod.js)
  has the `actAsUserId` conversion from a user account ID (remove leading `u`)
  and validates user-account selection against the primary mail account.
  [NewEvent.mod.js](https://app.fastmail.com/static/jmapui/45add8716a-43a3c342f97f8fea/app/module/desktop/NewEvent.mod.js)
  uses `getUrlForMessage` / `encode` to compose `threadId.emailId` after a
  mailbox context. That context is mandatory before the message component.
  These assets are provider implementation evidence, **not a documented stable
  API or a JMAP-standard account-prefix rule**. No app code is copied into
  this plugin.

The MCP catalog examined supplies email/thread metadata but advertises neither
an authoritative message web-URL field nor a URL-resolution method. The adapter
does not invent such a field on JMAP objects or extract links from message bodies.
If Fastmail introduces a documented authoritative URL mechanism, prefer that
rather than extending speculative route construction.

The owner-selected fixed `Archive` context avoids deriving localized or custom
folder paths. The URL uses the verified thread and email IDs plus the authenticated account's mapped
web selector. The same context is used for Inbox, archived, custom-labelled and
Trash messages. Tests cover these source placements; they do not prove live
navigation in every folder. The plugin emits only the fixed trusted
`https://app.fastmail.com` origin. Identifiers use the web client's restricted
route alphabet, are encoded as components, and delimiters, percent escapes,
control characters and unsupported selector punctuation are rejected.

The result names its evidence honestly:

- `urlSource: "fastmail-web-client-route"` — provider-specific route, not an
  authoritative URL returned by a documented API.
- `verification: "metadata-verified-not-browser-verified"` — source binding
  succeeded; this does **not** assert successful rendered navigation.

A signed-in browser with the corresponding web account is still needed.
Opening a message can mark it read in the Fastmail web client; do not use live
navigation of unread mail merely as a test when live account writes are prohibited.
A login screen, HTTP 200 shell, or synthetic test is not proof that the exact
message opened. Web routing can change independently of JMAP; re-check the
provider mechanism and rendered target if reported links stop working.

## Unread status for saved GTD links

GTD accepts saved mail links with one context segment and a canonical web
account selector. Fastmail's route decoder interprets the single component
as an Email ID. A dotted component supplies both the Thread ID and Email ID.
The decoder passes a lone Email ID to `goMessage`, which can open the
conversation with that message selected. [Fastmail web client](https://app.fastmail.com/static/jmapui/517d4d6522-bde4a3017c53ae58/app/module/desktop/NewEvent.mod.js)

The lookup verifies the web selector against the authenticated primary personal
JMAP mail account. It submits the Email ID unchanged to `Email/get`, checks
any supplied Thread ID against the returned one, and verifies through
`Thread/get` that the exact message is in the conversation. It reads message
and mailbox metadata for unread status. It excludes drafts and messages held
only in Trash or Junk. The check is read-only and uses the existing JMAP
configuration. [JMAP threads and emails](https://www.rfc-editor.org/rfc/rfc8621.html#section-3)

Fastmail links that resolve to the same account and thread share an opaque
grouping key. GTD uses the first saved title and URL for the conversation.
Without a verified account and thread, the saved link remains openable and GTD
reports the lookup outcome.

## Operator checks and diagnostics

The read-only `resolveEmailUrl` RPC uses the exact same handler and input schema
as the agent tool. It accepts only an email ID already observed in a provider
receipt, never caller-supplied source metadata, URLs or account selectors.
It exists for supported smoke checks without exposing credentials or requiring
an agent-session refresh. New tools/instructions require a fresh provider session.

Failures return an explicit error and no URL. Logs identify a fixed boundary
(`email_url_source`, `email_url_session`, `email_url_metadata`, etc.) and a
bounded category. They contain no IDs, URLs, account addresses, response bodies
or raw exceptions. Tests exercise provider errors containing synthetic private
sentinels. Successful metadata reads are not logged.
