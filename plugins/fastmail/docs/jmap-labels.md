# Move messages to Inbox with JMAP

Fastmail's MCP `update_email` tool excludes system labels, including Inbox, and currently offers no move-to-Inbox tool. This plugin adds `fastmail_update_email_labels`, adapted to TypeScript from PA's direct-JMAP email integration. MCP sign-in and permissions remain unchanged.

## Configure the optional token

1. **In Fastmail**, sign in to the same account connected through MCP. Open **Settings → Privacy & Security → Manage API tokens** and create a token with **mail access**, including writes. Use a name that identifies this BB installation.
2. **In BB**, open the Fastmail plugin's **Configuration**. Paste the token into **JMAP API token (optional)** and save. Never put it in chat, logs, command arguments, or a support ticket.
3. Start a **new agent session** to pick up the label-update tool. Ask for a preview of a change to an exact email before applying it.

The token is stored by BB as a secret setting in a restricted file, not in the plugin's OAuth database or agent instructions. Mail permission is broader than this one tool; protect the BB data directory and backups. Token presence is not proof that it is valid, grants writes, or belongs to the MCP account. The tool uses the token's primary mail account; the plugin cannot verify that it matches the MCP login. Confirm the account in Fastmail before copying the token or applying changes using MCP email IDs.

Changing or clearing the setting takes effect at the next invocation. New sessions omit the tool when no token is configured; an existing session's stale tool invocation also checks the current setting. **Disconnect** affects only MCP. To stop JMAP access, clear this setting and revoke the token in Fastmail. Disabling the plugin stops both paths but preserves credentials; removing it deletes its BB credentials. Other plugins are unaffected.

## Use the tool

Supply `emailIds` (1–50 exact email IDs), `addLabels` and/or `removeLabels`, and optional `apply`:

```json
{
  "emailIds": ["EXACT_EMAIL_ID"],
  "addLabels": ["Inbox"],
  "removeLabels": ["Screener"]
}
```

Omitting `apply`, or setting it to `false`, previews the before/after memberships without writing. Set `apply: true` only for a user-requested change. `Inbox` resolves by its system role, even when its display name is localized. User labels resolve by an exact full path or an unambiguous leaf name, not fuzzy matching. No labels are created. Other system mailboxes are rejected; keep using MCP's archive/trash operations for their dedicated semantics.

The update uses per-membership JMAP PatchObjects, preserving every unspecified membership and all keywords. It rejects ambiguous/missing labels, add/remove overlap, missing rights, malformed snapshots, and changes leaving no mailbox. It reads metadata only, never message bodies. A batch is atomic **per email**, not across emails.

Writes use `ifInState` and reread memberships, keywords, and message identity. An explicit `stateMismatch` permits one fresh plan and conditional retry, because that rejection establishes that the write was not applied. A transport failure, invalid response, or other uncertain write outcome triggers one read-back, **never an automatic resend**. Inspect `status` and per-email `verification`; partial, diverged, or failed verification is not success. Cancelled verification may leave the outcome unknown: inspect Fastmail before retrying.

## Diagnostics and verification

BB plugin logs record only the JMAP boundary and fixed categories or HTTP status. They exclude tokens, account IDs, email IDs, labels, arguments, provider bodies, and raw exception messages. `jmap_session` distinguishes credential/transport setup from mailbox discovery, snapshots, planning, writes, and verification.

Synthetic TypeScript and BB-host tests cover preview/apply, exact Inbox patches, rights and ambiguity checks, secret configuration lifecycle, partial and uncertain outcomes, and safe diagnostics. No live mutation is required for installation or deployment verification. A saved token alone is not evidence of a successful JMAP read or write.
