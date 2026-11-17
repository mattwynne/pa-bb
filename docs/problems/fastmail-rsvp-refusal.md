# Fastmail refuses RSVP for existing invitations

Status: investigated; upstream rejection confirmed, underlying permission/implementation cause unresolved. Recorded 2026-11-11. Proposal only; no implementation or deployment.

## Problem and evidence

Two genuine invitations were already present in the recipient's default calendar. Accepting each with Fastmail's `rsvp_event` tool returned:

```text
Error executing rsvp_event: Cannot RSVP to event: not allowed
```

Fresh, narrowly scoped Fastmail calendar searches still show both attendee responses as `needs-action`. Presence in a calendar is not acceptance: Fastmail [documents automatic addition of unanswered invitations](https://www.fastmail.help/hc/en-us/articles/360058752694-Calendar-events-and-invitations).

The originating BB installation retains thread `thr_49t4upt2he`. Its events **244–245** record the two calls with `{id, status: "accepted"}`; events **247–248** contain the refusals. Do not copy the private invitation bodies, addresses, event IDs or meeting links into this repository.

Corresponding safe plugin log entries:

- **2026-11-11T23:00:19.868Z** — `Fastmail direct_call provider_error_result`
- **2026-11-11T23:00:20.402Z** — `Fastmail direct_call provider_error_result`

These establish remote MCP tool-error results, not HTTP authorization status codes. No support trace or more specific machine-readable reason was captured for these calls. Calendar state does not prove that every possible remote side effect was absent; do not replay the writes.

## Which component refused?

The refusal came back from **Fastmail's official MCP service**, not a local RSVP policy:

- [`core.mjs`](../../plugins/fastmail/core.mjs), `FastmailConnection.call`, forwards the provider tool name and arguments to `client.callTool`. There is no local calendar/RSVP implementation or attendee selection.
- [`server.ts`](../../plugins/fastmail/server.ts) logs `provider_error_result` only when that call returns `isError`. A thrown transport/local error follows a different, generic failure path.
- [`result.mjs`](../../plugins/fastmail/result.mjs) preserves text and `isError`; it does not invent this refusal.
- Read-only installation inspection reports an enabled, running direct local-path Fastmail registration. This is registration evidence, not proof that all current source bytes are loaded.

The supplied arguments satisfy the live official schema: `id` is a string; `status` is one of `accepted`, `tentative`, `declined`. There is **no** supported `from`, account, calendar, participant or no-send argument for RSVP. Adding such arguments or substituting `update_event` is not a supported repair. Updating an event can send reschedule notices.

Thus the failing boundary is proven; whether the defect is in Fastmail's MCP implementation, its internal API/permissions, or event/calendar metadata is **not** proven. This is unlike the historical local tool-ID drift in [iteration 002 findings](../plans/002-fastmail-mcp-findings.md): these calls reached a provider result.

## What remains unknown

| Candidate | Evidence and limit |
| --- | --- |
| Write versus send permission | The current catalog exposes RSVP and calendar writes but no `send_email`. RSVP explicitly sends a reply to the organizer. Fastmail [documents separate read, write and send consent](https://www.fastmail.help/hc/en-us/articles/15869557281295-Connecting-AI-tools-via-Fastmail-s-MCP-server), but does not specify RSVP's required combination. A send-permission mismatch is a useful first question for Fastmail, **not a diagnosis or justification to broaden access**. Current discovery also cannot prove the exact grant at the earlier call time. |
| Participant/identity resolution | The invited attendee exactly matches the default sending identity returned by MCP. That weakens a simple missing-sending-alias explanation. Sending identities do not establish the authenticated calendar principal, scheduling addresses or how MCP selects its participant. |
| Calendar rights/source | Both events belong to the calendar MCP currently marks default. `list_calendars` exposes names/IDs/default flags, not ownership, external-source details or RSVP rights. A personal-looking name/default flag does not prove ownership or permission. Fastmail [documents external/shared-calendar restrictions](https://www.fastmail.help/hc/en-us/articles/1500000279841-Troubleshooting-calendar-issues). |
| Upstream RSVP bug | Possible, including incorrect participant resolution or permission handling. The upstream implementation and server-side decision for these requests have not been obtained. No live comparison write was authorized. |

No secrets, stored OAuth grant or independent JMAP credentials were inspected. Nothing here establishes MCP/JMAP account equivalence. The optional mail-access JMAP token is not a calendar-RSVP remedy.

## Recommended repair path

1. **Immediate user workaround:** in Fastmail's own web UI, open each existing invitation or calendar event and select **Going**. This is a real RSVP and emails the organizer; the user should do it deliberately, once, then verify the attendee response. Do not create/import another event. The [official invitation guide](https://www.fastmail.help/hc/en-us/articles/360058752694-Calendar-events-and-invitations) supports this route, but success for these particular events remains untested. If Going is unavailable/refused, inspect calendar ownership/source and use the source account if it is an external calendar; do not move events or change settings speculatively.
2. **Ask Fastmail support to identify the rejection before changing access.** Supply the UTC timestamps, tool name, exact error and the fact that two existing pending invitations were affected. Ask which internal operation returned “not allowed”, which permission RSVP requires, why it is advertised without `send_email`, and which calendar principal/participant was selected. The owner can privately provide exact event IDs/account details if support requires them; never provide tokens, meeting links or full logs. No support message was sent during this investigation.
3. **Small local follow-up, separately authorized:** document RSVP's outgoing-reply effect, preserve the distinction between present/pending/accepted, and add fixed-category RSVP diagnostics (`operation=rsvp`, `provider_error_result`) without arguments, addresses or raw provider error text in logs. Keep dynamic schemas and no-replay behavior. Do not hide RSVP solely because `send_email` is absent, parse arbitrary error prose into a claimed root cause, or implement a raw-JMAP/CalDAV bypass.
4. **Conditional upstream fix:** if Fastmail confirms a grant mismatch, align tool discovery, required consent and clear permission errors for RSVP's outgoing reply. If it confirms participant/rights resolution is wrong, fix that upstream against authenticated calendar scheduling metadata, not inferred login identities. If additional send consent is genuinely required, explain its broader authority and let the owner decide through normal setup; investigation authorization does not authorize reconsent. Prefer the UI workaround if the owner does not want broader access.

## Regression proposal and verification

Local, synthetic tests should cover:

- Exact live RSVP schema/arguments through both direct and generic call routes; preserve upstream refusal and `isError` without claiming acceptance.
- One provider invocation per requested RSVP, including provider error, HTTP failure, cancellation and lost response; no automatic retry, event creation, participant edit or fallback email.
- Catalogs with RSVP but no send tool, and catalogs with both: do not infer permission success/failure or account identity from tool presence/default aliases.
- Post-call read still pending versus accepted; report observed state separately from delivery of the organizer's reply.
- Safe logs include only fixed operation/boundary/category, with synthetic account/event/token/body sentinels excluded.

Fastmail-owned tests should distinguish read/write/send grants, default and non-default attendee identities, owned/shared/external calendars and organizer versus attendee copies. Mocks in this repository cannot prove Fastmail's permission semantics. Any future end-to-end write needs separate explicit authorization and a dedicated test invitation/account; these genuine invitations must not become test fixtures.

Investigation verification: **27 existing synthetic connection, host and protocol tests passed**, using `node --test plugins/fastmail/test/connection.test.mjs plugins/fastmail/test/host.test.mjs plugins/fastmail/test/protocol.test.mjs`. An additional disposable in-memory probe against the existing built plugin, using the exact live RSVP schema and a fake MCP client, confirmed unchanged arguments/error text, bounded direct/fallback diagnostics and no reconnect/retry. It made no network calls. These checks verify the bridge boundary, not the underlying Fastmail cause or successful live RSVP delivery.

## Separate archive observation

The parent observed uncertain label-update outcomes for the same messages, followed by fresh MCP reads showing the preserved custom label and no Inbox membership. That is observed archived state, not justification to replay an uncertain write. A nearby `jmap_update invalid_response` log belongs to the independent label path and does not explain MCP RSVP refusal. Other coaching mail was outside that requested change. This investigation did not read those email bodies again or mutate mail/calendar state.
