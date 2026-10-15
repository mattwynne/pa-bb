# Gmail support for BB

Status: open capability gap; read-only search and message/thread reading planned in
[iteration 014](../plans/014-gmail-search-and-read.md). No Gmail plugin delivered yet.

## Problem

BB has no Gmail plugin. People using Gmail cannot ask BB to work with their
mail through this marketplace. Fastmail support does not provide Gmail access,
and the Google Calendar and Drive plugins do not provide mail access.

The [roadmap](../roadmap.md) allows for Gmail as a separate provider plugin.

## Desired outcome

Connect a Gmail account so BB can help with email without switching to a
browser or copying messages into chat. Keep account selection explicit and
credentials out of agent context and logs.

Reading mail, preparing drafts, and sending mail are separate capabilities.
Connecting an account must not imply permission to send messages.

## Investigation: use the Calendar and Drive model

**Yes.** Build an independent `plugins/gmail/` package using Google's Gmail REST
API, not a bridge through Calendar, Drive, or Fastmail. The existing plugins
supply a suitable structure:

| Existing pattern | Gmail application |
| --- | --- |
| [Drive server](../../plugins/google-drive/server.ts) and [contract](../../plugins/google-drive/contract.ts) | BB settings, account RPCs, public OAuth callback, validated agent tools and safe errors |
| [Drive service](../../plugins/google-drive/core/service.mjs) | Injectable storage, OAuth and provider ports; explicit account selection; per-account paging and partial failures |
| [Google adapter](../../plugins/google-drive/adapters/google.mjs) | Web authorization-code flow with PKCE, offline refresh, verified Google subject and bounded provider errors |
| [Shared connection UI](../../shared/connection-ui/README.md) | Account setup/status/recovery pattern, without a separate mail-reading interface |
| [Calendar server](../../plugins/google-calendar/server.ts) | BB owner interaction before an approved write; never automatically retry an uncertain mutation |

Keep the existing single-user-installation boundary, while supporting several
connected Google accounts. Persist Gmail's own account records and pending
OAuth states. Do not import Calendar/Drive access or refresh tokens. A verified
Google identity alone does not prove Gmail works: verify Gmail access with a
small provider read, such as `users.getProfile`, and distinguish identity,
mailbox availability, missing scopes and expired authorization.

### Reusing the Web OAuth client

The installation can reuse its Calendar or Drive **Web client ID and secret**.
Enable Gmail API in that Google Cloud project and register an additional exact
callback, `/api/v1/plugins/gmail/http/callback`, using the installation's HTTPS
BB app URL. Gmail still needs its own Google consent flow and refresh token.

The existing copy mechanism is deliberately restricted to Calendar and Drive.
It will not accept Gmail unchanged. To offer one-click reuse:

- Add a caller-checked `exportOAuthClientForGmail` RPC to the source plugin's
  `server.ts` and `contract.ts`; permit only the installed `gmail` plugin.
- Gmail copies the client once through a backend RPC and saves its own settings.
  Return only an acknowledgement to the browser. Refuse client replacement
  while Gmail has connected accounts.
- Extend the [cross-plugin acceptance tests](../../plugins/google-drive/features/oauth-client-reuse.feature)
  to prove caller restrictions, no token copying, no secret exposure, and
  independence after the source plugin is removed. Manual client setup remains
  available when neither plugin is installed.

Retain `include_granted_scopes=false`, check and persist the returned scopes,
and expose only verified capabilities. Separate local records do **not**
provide independent Google-side revocation: revoking
project authorization can invalidate other grants in that project. Local
account removal should remain local, with this distinction explained. Separate
Cloud projects are the option when independent provider revocation is required.

Reuse the tested boundaries, not necessarily every implementation detail.
Plugin packages must remain self-contained when installed from a subdirectory;
an unbundled import from a sibling plugin will not work. A shared OAuth helper
could follow the shared-source packaging approach later, but a broad auth
refactor need not block Gmail.

### Choose scopes by capability

All rows below also need the existing `openid` and `email` identity scopes.
Scope names abbreviate `https://www.googleapis.com/auth/`.

| Capability | Gmail scope | Google's classification |
| --- | --- | --- |
| Search and read messages/threads | `gmail.readonly` | Restricted |
| Send only, without reading mail or managing drafts | `gmail.send` | Sensitive |
| Create/manage drafts and send | `gmail.compose` | Restricted |
| Archive, mark read, or change message labels | `gmail.modify` | Restricted; defer unless needed |

`gmail.metadata` is not a useful shortcut for ordinary mail assistance: it
cannot read bodies and does not permit the `q` search parameter. For reading
and drafting, use `gmail.readonly` plus `gmail.compose`; adding `gmail.send`
would be redundant. Importantly, **Google offers no draft-only scope here**:
`gmail.compose` also permits sending. A draft-only product therefore needs an
application boundary: do not register a send tool or expose arbitrary API calls.

The restricted classification is not entirely new: Drive already requests the
restricted `drive.readonly` scope. Google's verification rules still need an
explicit deployment decision:

- Personal-use and qualifying Workspace-internal apps have verification
  exceptions; this does not waive data-use and security requirements.
- External apps in Testing issue seven-day refresh tokens for these scopes.
  That is not a durable unattended setup. Gmail-scoped refresh tokens can also
  stop working after a Google password change.
- A broadly distributed external OAuth app using restricted scopes normally
  needs restricted-scope verification and, when restricted data passes through
  servers, a security assessment. Installation-owned clients do not make these
  obligations disappear; check the applicable exception and data flow.

### Gmail-specific implementation work

1. **Search and read.** Propose `gmail_auth_status`, `gmail_search_messages`,
   `gmail_get_message` and `gmail_get_thread`. Gmail's `messages.list` returns
   IDs, not full summaries; hydrate bounded results with `messages.get` and
   limit concurrency. Use Gmail search syntax, account-bound page tokens and
   explicit partial/truncated results. Never merge message IDs across accounts.
2. **Decode mail safely.** Handle nested MIME parts, base64url, character sets,
   plain-text preference and HTML-only messages. Some text parts require a
   separate attachment-body fetch. Bound decoded content, report truncation,
   list attachment metadata, and never load remote images or execute HTML.
   Treat message content as untrusted data, not instructions.
3. **Drafts.** Add draft creation after reads are proven. Build RFC-compliant
   MIME server-side with a maintained library, including safe address/header
   handling. Correct replies need the Gmail `threadId`, matching subject, and
   RFC `In-Reply-To`/`References` headers; `threadId` alone is insufficient.
   Keep attachment transfer separate from agent text, using opaque backend
   handles and bounded storage rather than base64 in chat. This intersects the
   [Drive attachment gap](google-drive-email-attachments.md).
4. **Sending.** Add only as a separately agreed capability. Reuse Calendar's
   real BB approval interaction, but review sender, To/Cc/Bcc, subject, body
   and attachments. Bind approval to the exact outgoing content. Do not send
   an externally editable draft by ID after reviewing an older snapshot.
   A read-then-compare check alone leaves a race; prefer sending the immutable
   approved MIME unless reliable draft-version preconditions are available.
   Never automatically retry an uncertain send.

### Security and release gates

Do not clone storage blindly. The current [Drive store](../../plugins/google-drive/adapters/bb-store.mjs)
places tokens in ordinary SQLite columns; it does not implement encryption.
Google's Workspace policy requires encryption at rest for restricted user data
and OAuth tokens. Confirm host/BB protection or implement protected storage,
including backups. Mail returned to BB may persist in chat history, snapshots
and model-provider systems even if the plugin keeps no message cache. Review
that complete path before live account access.

Google explicitly allows productivity uses such as generative-AI summaries,
but transfers to an AI provider need appropriate disclosure and consent. Do
not permit Gmail-derived content to train a shared/general-purpose model;
verify the chosen model provider's data terms and retention settings.

Apply the repository's [observability](../o11y-standards.md) and
[UX](../ux-standards.md) standards. Test revoked/expired grants, missing scopes,
unavailable mailboxes, rate limits, partial reads, MIME edge cases, prompt
injection and synthetic secret leakage. Extend the shared UI sync script for
Gmail and review actual rendered BB states before release. Tests and a valid
identity are not substitutes for a live, harmless Gmail read.

## Recommended sequence and remaining decisions

Start with a read-only plugin and several connected accounts, following Drive's
structure. Prove OAuth reuse, search, individual messages and threads. Add
plain-text drafts next, then approved sending if wanted. Defer mailbox
mutations, attachments and background mailbox synchronization until a concrete
workflow needs them; ordinary on-demand reads need neither IMAP nor Pub/Sub.

[Iteration 014](../plans/014-gmail-search-and-read.md) defines the first release:
search and message/thread reads only, without drafts or sending. Before live
access, establish the applicable deployment/verification model, encrypted
storage and the BB-to-model data path. Drafts and sending remain later decisions.

This investigation inspected repository code and Google's documentation. No
Gmail implementation, live account access or rendered Gmail UI review was done.

## Google references

- [Gmail scopes and classifications](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [List messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Send MIME messages](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Message resource and reply threading](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Web OAuth and incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Project-wide token revocation](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow#tokenrevoke)
- [Refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Restricted-scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Workspace user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
