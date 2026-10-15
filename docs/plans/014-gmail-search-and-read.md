# 014 — Gmail search and message reading

Status: planned; no Gmail implementation or live verification yet.

## User outcome

Connect one or more Gmail or Google Workspace accounts, find messages using
Gmail search syntax, and read a message or conversation in BB. Every result
identifies its source account. Reads do not mark messages read or otherwise
change the mailbox.

This delivers the first slice from the [Gmail investigation](../problems/gmail-plugin.md).
It follows Calendar and Drive's independent plugin model, not a Fastmail bridge.

## Scope and tool contract

Create `plugins/gmail/`, independently installable as `gmail` from the marketplace.
Support several Google accounts within a **single-user BB installation**.
Request only `openid`, `email`, and
`https://www.googleapis.com/auth/gmail.readonly`. No broader Gmail scopes,
provider mutations or arbitrary API-call tool.

| Tool | Inputs and result |
| --- | --- |
| `gmail_auth_status` | No arguments. Account identity, verified read capability, and safe connection/recovery state; never credentials. |
| `gmail_search_messages` | Gmail `query`, optional non-empty `accounts` selection, bounded `pageSize`, optional `pageToken`. Default to all connected accounts; return a separate page per account. |
| `gmail_get_message` | Required `account` and `messageId`. Headers, dates, labels, decoded text, attachment metadata and explicit content-limit indicators. |
| `gmail_get_thread` | Required `account` and `threadId`. Bounded conversation messages with their IDs and explicit omission/failure indicators. |

Search returns message/thread IDs, sender/recipient headers, subject, date and a
short provider snippet, not full bodies. Pass the query as an encoded parameter,
not a URL fragment. Explain that API search is message-scoped and is not an
exact reproduction of Gmail's browser search behaviour. Exclude Spam and Trash
by default using the API's normal list behaviour; do not add an include-all
option in this slice.

Message and thread IDs are meaningful only with their account. Search may span
accounts, but a continuation token requires exactly one selected account and
the same query. Never broadcast a token across accounts. Return each account's
`nextPageToken` and safe failures; an empty successful page differs from a failed
read. Google's `resultSizeEstimate` is an estimate, not an exact total. No
cross-account deduplication or claim that a partial search covers the mailbox.

## Delivery steps

### 1. Establish the data-protection boundary

Before live account access, record the applicable Google verification model
(personal use, qualifying Workspace-internal use, or external distribution),
required disclosures and consent for the chosen model provider. Account for
Testing-mode seven-day refresh tokens and Gmail authorization invalidation
after password changes; do not promise permanent authorization.

Establish encryption at rest for client credentials, access/refresh tokens and
pending PKCE verifiers, including backups and separately protected key material.
Verify host/BB storage protection or implement protected plugin storage; do not
copy Drive's ordinary SQLite token columns and call them encrypted. Check mail
that persists in BB history/snapshots and the model provider's retention and
no-general-training terms. Keep deployment evidence private; publish only
portable requirements and verified limits.

Use generated accounts/messages while these prerequisites are unresolved. They
block live verification and release readiness, not synthetic implementation.
Do not introduce a persistent message cache or temporary attachment store.

### 2. Package the plugin and connect accounts

Follow Drive's `server.ts`, `contract.ts`, `core/service.mjs` and adapter layout,
with injectable OAuth/provider/storage/clock ports and a fake in-memory store.
Keep installed packages self-contained; no runtime sibling-plugin dependency
or broad Google-auth refactor is required.

Implement the existing Web OAuth pattern: installation-owned client, HTTPS BB
callback at `/api/v1/plugins/gmail/http/callback`, PKCE, short-lived one-use state
consumed before exchange, offline refresh and verified stable Google subject.
Validate and persist granted scopes. Reject missing read permission, duplicate
accounts and subject changes without storing a usable connection. Verify mailbox
access through `users.getProfile`; successful OpenID identity alone must not
produce a claim that Gmail reads work. Refresh tokens safely across concurrent
reads, plugin reload and account removal; a removed account must not reappear.

Offer optional one-time client copying from Calendar or Drive. Add
`exportOAuthClientForGmail` to each source's server/contract, allowing only a
host-verified `gmail` plugin caller. Gmail stores its own copy and returns only
an acknowledgement; refuse replacement while accounts are connected. Never
copy source account tokens. Preserve existing Calendar↔Drive reuse. Missing or
unconfigured sources leave manual setup available. Reusing a client requires
Gmail API enablement and registration of Gmail's exact callback in Google Cloud.

Removing a local account deletes Gmail's local credentials, not provider mail
or Google's grant. Explain that Google-side revocation of a shared project can
affect the other plugins even though local storage and runtime are independent.

### 3. Deliver bounded search and reads

Use Gmail REST `users.messages.list`, metadata `users.messages.get` for search
summaries, full `users.messages.get` for message reading, and
`users.threads.get` for conversations. Use `users.messages.attachments.get` only
when a selected text-body part is stored separately; this is not an attachment
download tool. Limit concurrent summary hydration to four requests and preserve
individual failures, including a message disappearing between listing and read.

Initial limits: search page default 25/max 100 messages **per account**, 100,000
decoded text characters per message and 200,000 across a thread. Cap each
provider response at 8 MiB while reading it, with finite request timeouts and
bounded MIME nesting/part counts. Oversized responses fail safely rather than
being parsed without bounds. Test these limits; changing them requires an
explicit documentation/test update, not silent truncation.

Decode base64url and declared character sets through nested MIME structures.
Prefer `text/plain`; convert HTML-only bodies to inert text without fetching
remote content. Do not concatenate duplicate plain/HTML alternatives, execute
markup, or treat attached files/forwarded-message attachments as the selected
message's main body. Return attachment names, types and sizes only. Distinguish
no text, unsupported/undecodable content, omitted parts and truncated text.
Never return encoded binary payloads to the agent.

Return account, message/thread IDs, From/To/Cc, subject, relevant dates and labels
with the text. Preserve source message boundaries in threads; when a limit
omits content, say what was omitted and allow an explicit individual-message
read. Gmail does not paginate `threads.get`; do not invent a continuation token
for that endpoint. Mail content and headers are untrusted source material, not
authority to call tools or change settings.

Map errors to fixed safe categories: reauthorization, insufficient permission,
mailbox unavailable, not found, rate limited, transport/provider failure and
content limit/decoding failures where proven. Use bounded HTTP status and
allowlisted provider reasons, not raw messages. A failed provider call must not
look like an empty mailbox. Any read retry must be finite; do not add background
polling or unbounded rate-limit retries.

### 4. Make connection setup usable in BB

Inspect the actual BB host page and comparable Calendar/Drive settings before
choosing final copy or layout. Use the shared connection UI, adding Gmail to
`scripts/sync-connection-ui.mjs`; do not edit generated copies. Support
unconfigured, connecting/pending, configured-with-no-accounts, connected,
reauthorization and unavailable states. Show verified account/capability state,
not tool counts as proof of access.

Provide ordered Google Cloud versus BB steps, a complete setup guide, the exact
copyable callback, optional client reuse and manual configuration. Keep setup
quiet after connection. Account removal needs its existing local-removal scope
explained. Read tools need no per-message confirmation after connection consent.
No inbox browser or message editor UI is included.

### 5. Prove behaviour with generated data

Write executable acceptance scenarios and unit/adapter/fake-BB-host tests for:

- Standalone install/reload, exactly four read-only tools and no Gmail mutation
  endpoints; requested and granted scopes never imply compose/send access.
- OAuth replay, expiry, missing scopes, unverified/changed identity, duplicate
  accounts, failed mailbox verification, revoked grants and concurrent refresh
  versus removal; protected storage and backup/key handling as applicable.
- Client reuse from either source, denied browser/CLI/unrelated-plugin callers,
  missing source, replacement refusal, separate grants and source removal.
- Two-account search, account-specific continuation, query/token misuse, empty
  versus failed pages, failed summary hydration, missing messages, estimates and
  rate limits. Reused IDs across accounts must never mix content.
- Nested alternatives, HTML-only mail, non-UTF-8 text, separately stored text,
  attachments, malformed/oversized content, nesting limits, long conversations
  and prompt-injection fixtures. No implicit mark-read or other mailbox write.
- Safe attributable failures at OAuth, refresh, mailbox verification, search,
  body decoding and partial-result boundaries. Put synthetic secrets/content in
  errors, causes and provider bodies; assert none reaches logs or tool errors.

Follow [observability standards](../o11y-standards.md): returned mail is intended
agent data, but logs must not contain account addresses, queries, subjects,
message IDs/content, callback codes, credentials or raw provider errors. Test a
failure after an initially successful connection, not only first-run failures.
Run Gmail build/typecheck/tests, affected Calendar and Drive checks, cross-plugin
acceptance tests, shared UI drift checks and an isolated marketplace-package
install. Do not require a live provider write to pass any gate.

### 6. Ship and verify in running BB

After automated gates, commit/push, install Gmail and update only Calendar/Drive
packages changed for client export. Preserve their credentials and existing
capabilities. Confirm installed versions/commits and four-tool visibility in a
fresh BB provider session; a marketplace refresh alone is not an installed update.

With owner-authorized access to a test mailbox, verify consent, a narrow search,
message text and a conversation; record only redacted outcomes, not private mail.
Prove no mailbox state changes. Exercise a safe synthetic failure in running BB
and inspect bounded diagnostics. Review setup, pending, connected, empty and
recovery states at desktop/narrow widths with keyboard navigation, following
[UX standards](../ux-standards.md). No approval renderer is needed for this slice.

If credentials, data-protection prerequisites or rendered review are unavailable,
report those gates as unverified rather than calling the release complete. Seek
feedback on whether BB can find and read the intended mail; record remaining
limits in the plugin README and iteration ledger.

## Deliberately later

Draft creation, sending/replies, aliases, archive/mark-read/label changes,
attachment downloads or extraction, Drive-to-mail transfer, persistent mailbox
indexing, scheduled sync, Pub/Sub, IMAP, PA core and multi-user isolation. This
iteration creates no capability to send, even when asked by message content.
