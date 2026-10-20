# Optional contact-group management

Message labels and contact groups are different. Moving an existing message to a Feed label does not put its sender in the Feed contact group used by a future-mail rule. This tool changes contact-group membership, not rules or message labels. Verified membership does not prove downstream routing.

## Set up

1. **In Fastmail**, verify the login account you intend to use. CardDAV needs a plan supporting third-party access; Basic plans do not support it. Create a dedicated app password with Contacts access under **Settings → Privacy & Security → Connected apps & API tokens**. Choose the narrowest available access. See [Fastmail's app-password guide](https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords).
2. **In BB → Settings → Plugins → Fastmail → Configuration**, save **CardDAV username (optional)** and **CardDAV app password (optional)**. Use the login username, not a sending alias. Both values are server-side secret settings. Never paste an account password, app password, token or OAuth callback into chat or logs.
3. Start a new agent session and ask it to list Fastmail contact groups. Merely saving settings enables tool selection; it does not verify credentials, account identity or access. The first provider read establishes readable access only.
4. If also using the official MCP contact tools, confirm you authorized the same account. MCP's default sending address may be an alias, not the login username; the plugin cannot prove account equivalence from it.

CardDAV uses HTTPS at `https://carddav.fastmail.com` with Basic authentication and an app password. It does not use the MCP OAuth grant or the optional JMAP mail API token. No credentials or data are read from a Pi installation or environment variables.

**Disconnect** is MCP-only: it does not clear CardDAV credentials. Clear both CardDAV settings in BB and revoke the dedicated app password in Fastmail to end this access. Disabling the plugin unloads tools but preserves settings. Removing the plugin removes local plugin data; revoke provider credentials separately. Protect BB's data directory and backups.

## Tool

`fastmail_contact_groups` accepts:

- `action: "list"`: list discovered groups (first 50, with `total` and `truncated`).
- `action: "get"`, `group`: summarize a group selected by exact name or unique CardDAV UID. Add `email` and/or `contactUid` to inspect one existing contact, all its email addresses, the selected membership and its current groups. This is not a full group-member browser.
- `action: "add" | "remove"`, `group`, `email` and/or `contactUid`: preview one membership change. Set **`apply: true` only for a user-requested mutation**. A no-op is verified against a fresh group read without writing.

Tool arguments never contain credentials. Group names use Unicode-aware exact case-insensitive matching; UIDs are exact. Email matches are exact and case-insensitive: plus addressing is preserved, and domains or names are not treated as sender matches. Duplicate contacts or group names fail closed; use a unique UID when possible. Duplicate UIDs or cross-address-book memberships still fail closed rather than guessing. MCP contact IDs are not CardDAV UIDs.

Membership affects **the whole contact**, including all addresses on it. Clarify any scope wider than the address requested. Other groups, other members, contact fields and unknown group properties are preserved. The tool makes a fresh group GET, requires a strong ETag, uses `If-Match` for PUT, and reads back to verify the requested membership and preservation of unrelated data. There is no automatic write retry.

### Finding or creating a sender contact

Use the official MCP contact search first, checking for exact-address duplicates. If none exists and contact creation was requested, create a minimal contact using the official MCP tool. Then resolve it again through CardDAV by exact email before membership changes. Do not translate its MCP ID to a CardDAV UID, reuse a contact solely by display name, or assume synchronization is immediate. If creation has an uncertain outcome, search/inspect before considering another create. Stop if account identity or synchronization is uncertain.

This increment intentionally does not create contacts or groups through CardDAV, merge contacts, modify mail rules, or batch/move contacts automatically.

### Moving between groups

Adding Feed does not imply removing other memberships. If the user explicitly requests a move, add and verify the destination first, then separately remove only the named source groups. These writes are **not atomic**; report partial completion honestly and do not automatically roll back or remove every other group.

## Recovery and limits

- **Conflict (412):** another client changed the group. Inspect current membership, then consider a new preview. The failed conditional write is not retried.
- **Access denied:** check username, plan and dedicated app-password access in Fastmail and BB. No raw provider response is returned or logged.
- **Uncertain write:** the server may have committed before the connection failed. Use read-only `get` with the same exact contact/group, or inspect Fastmail itself, before any new change. Do not blindly repeat `apply`.
- **Written but verification failed:** the PUT succeeded but read-back was unavailable or unrelated properties/members differed. Inspect the actual group in Fastmail; do not claim success or automatically restore old data.

There are no durable operation receipts, idempotency keys or automatic cross-session reconciliation in this copied-service increment. Recovery is explicit live inspection. Do not use it for unattended multi-step migrations. Groups are listed up to 50; a known exact name/UID can still be inspected directly. Tool output is capped at 32 KB; oversized results return an explicit truncation notice and retain mutation outcome flags. HTTP bodies are capped at 16 MiB per response with 30-second request timeouts. Incomplete/unreadable discovery is rejected, not interpreted as an empty address book. Unknown contact formats/UIDs fail closed.

Diagnostics use `carddav_tool` and fixed failure categories, never contact content, group names, request arguments or credentials. Cancellation after PUT can also leave an uncertain result; inspect before retrying.

## Provenance and verification

The service and its transport/vCard tests were copied from [mattwynne/pi-extensions](https://github.com/mattwynne/pi-extensions/tree/1bbb7ccb48a11462197457b890cab8ef71178082/extensions/fastmail-contact-groups) at `1bbb7ccb48a11462197457b890cab8ef71178082`, under MIT; see `../LICENSE.contact-groups`. It is a maintained local copy, not a runtime Pi dependency or a shared package. Local service adaptations replace environment-based credentials with explicit BB settings and add fixed diagnostic categories. The BB adapter supplies Zod validation, conditional exposure, bounded output and sanitized error handling.

Synthetic tests cover original byte-preserving vCard and conditional-write safeguards, unsafe XML/URLs, ambiguity, cross-book rejection, no-op/preview behavior, verification and uncertain-write recovery, plus BB settings/tool lifecycle and privacy boundaries. They do not prove live CardDAV compatibility or successful mail routing. No live contacts were changed to implement this feature.
