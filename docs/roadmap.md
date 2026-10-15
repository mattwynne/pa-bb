# PA for BB roadmap

PA for BB should be a useful assistant assembled from independently installed service connections and task-focused abilities. **A service is a plugin; a task that spans services is an ability.** Installing the marketplace installs neither. Users choose which accounts and capabilities to connect.

This is a proposed order of work, not a promise to port every PA package. The [vision](vision.md) describes the intended experience and trust boundaries. The existing [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) supply behavior and tests to adapt, not a package list to copy wholesale.

## Where we are

**Five independent plugins are listed in the marketplace: Google Calendar, Fastmail, read-only Google Drive/Docs, iCloud folder sync, and Obsidian.** All five are installed; PA core and Gmail are not delivered. Verification limits differ by plugin.

- **Google Calendar:** managed installation and multiple account connections verified; end-to-end Calendar tool use and live write approval still need verification.
- **Fastmail:** standalone official MCP connection installed, with session recovery and stable tool IDs. A [recorded BB workflow](problems/google-drive-email-attachments.md) includes a completed email-draft call, superseding the earlier blanket “no live writes” status. This is not proof of sending or every mail/calendar/contacts operation. Optional [JMAP Inbox and label updates](../plugins/fastmail/docs/jmap-labels.md) are built and synthetically tested; live JMAP writes remain unverified.
- **Google Drive/Docs:** read-only search, folder browsing, metadata and Docs text tools are built. The same workflow records live account discovery, search and browsing; a complete consent/Docs-read verification record is still missing. Downloads and exports are not implemented.
- **iCloud:** native sync/recovery work is delivered through [iteration 013](plans/013-icloud-bisync-retry-classification.md), including a completed live scheduled sync. Sync no longer takes whole-folder backups. [Iteration 006](plans/006-obsidian-vault-reading.md#release-evidence) adds installed coordinated note access, conditional saves and private per-note recovery. A scheduled sync completed after its controlled update. Phone round trips and real authorization-expiry recovery remain unverified.
- **Obsidian:** independent multi-vault settings and nine assistant tools are installed, with no vault connected automatically. Generated-data tests prove native ownership/crash recovery and practical scheduled access; actual BB/provider local saves and rendered review passed. Connecting grants whole-vault read/write without confirmations. Local receipts are not proof of cloud/device delivery.

See the [iteration ledger](plans/README.md) and plugin READMEs for delivery history and setup. Earlier plans retain their original verification limits; the later evidence linked above qualifies those limits.

## Priorities

### 1. Personal knowledge and Obsidian — immediate focus

Seek feedback on a specifically authorized task using [iteration 006 — Obsidian vault reading and editing](plans/006-obsidian-vault-reading.md#release-evidence). The generated-data boundary, multiple-vault tools, conditional writes, source-preserving parser and connection settings are installed. Local, Linux native, actual host/provider, rendered and read-only production gates passed; a scheduled iCloud run completed after the update.

Live feedback has since exposed [background sync interrupting note access](problems/icloud-continuous-note-access.md): healthy runs take about 40 seconds per minute, hide available vaults and block note operations. Plan continuous reads and prompt durable local saves behind the iCloud service boundary; making writes wait for an entire sync is not sufficient. [Plan 015](plans/015-icloud-continuous-note-access.md) is approved for implementation using owner-authorized downtime: stop both plugins, update while disabled, then start and fix forward if needed. Do not add rollout features or automatic downgrade support. A real ~48-second native publication probe and corrected **isolated Linux BB** five-minute workload/following-run drain have passed: 110 client saves, 24 exact final logical/alias/mirror matches, and picker usability during a genuine >40-second command. Separate full-cap fairness and one authorized generated-data provider conversation over a client-only installed bridge passed; that bridge does not establish BB's normal host agent selector or device delivery. A **disposable** actual BB 0.45.0 managed update of both plugins while both stayed disabled passed, preserving generated legacy receipts/archive, baselines, source IDs and a sentinel; exact prior enablement and a normal scheduled run followed. A short updated-installation sample separated whole commit, explicit file/directory fsync and real maintenance/client overlaps; its fresh receipts had no expiry work. Controlled production delivery remains unverified. The user accepted GPT-only design review coverage after model selections did not take effect; this was not a completed multi-family ensemble. This remains an open problem in the installed production versions, not a shipped fix.

Keep the whole-vault connection model: no folder permissions, read-only switches or per-edit confirmations. Report **saved locally, pending iCloud sync**, not verified cloud/phone delivery. Personal-vault access and device mutation checks need separate authorization; production installation must not connect a vault automatically.

No Obsidian desktop app, Mac relay or PA core is required. Note browser/editor and graph UI remain parked; renames/deletes, bulk editing and automatic daily-note/template workflows are outside this release.

### 2. Close verification gaps in existing connections

Verify the installed plugins in fresh target-provider sessions, recording each operation separately rather than calling a connection wholly verified. Cover Google Calendar reads and source attribution; Fastmail mail/calendar/contacts reads, session rotation and stale-tool handling; and Drive consent, search and Docs reads. Carry forward the recorded live draft/search evidence without treating it as proof of every capability. Check real Apple expiry recovery and phone-to-BB delivery only through separately authorized tests; neither blocks synthetic Obsidian boundary work.

Keep **one Fastmail plugin** for the official MCP service's mail, calendar and contacts capabilities. Discover provider schemas at runtime and offer tools allowed by the selected grant, including mutations, without an extra MCP-specific approval gate. Do not infer scopes from tool count, rebuild CalDAV, or copy the provider catalog. Preserve the [official-MCP decision](https://github.com/mattwynne/pa/blob/main/docs/adrs/0006-use-official-fastmail-mcp-for-calendar-access.md). Test provider interactions, precise targeting and uncertain outcomes synthetically; do not require a live mutation merely to release a connection.

### 3. PA core: compose without assuming a provider

Keep the core small. It should explain installed capabilities and missing connections, attribute facts to their sources, distinguish a proposed action from a completed one, and apply shared approval and untrusted-content rules. It should work with no connected service and should not own provider credentials or absorb every workflow.

The first cross-provider use case remains **calendar awareness**: answer across connected Google and Fastmail calendars, preserve each event's provider/account/calendar identity, and report partial failures instead of silently treating one provider as complete. Calendar interpretation and availability reasoning belong above the providers. Do not invent a shared calendar write API merely to support a combined read.

### 4. Google Drive and Docs: finish useful file workflows

Extend the [read-only first slice](plans/003-google-drive-discovery.md) around demonstrated tasks, not the Pi extension's tool list. The [Drive-to-email attachment gap](problems/google-drive-email-attachments.md) is concrete: the assistant can find files but cannot retrieve their bytes, so it substitutes links or asks for manual uploads. Add bounded downloads and explicit Google-native export formats, with safe backend transfer to the mail provider and temporary-file cleanup. Keep binary content and credentials out of agent context. Preparing attachments must not imply permission to send.

Add approved document creation, editing, sharing and filing with an explicit scope-upgrade path when needed. Add Sheets and Slides for demonstrated workflows, not as prerequisites to useful Drive access.

### 5. Outcome abilities

Once sources are connected, package the work people ask PA to do. Begin with **meeting preparation / Get Perspective** across available calendars and context; follow with a daily briefing, saved email drafting, inbox triage, and weekly planning where their dependencies are ready. Adapt PA's existing abilities rather than copying Pi-specific commands, subagents, private policies, or filesystem assumptions verbatim. Each ability should remain useful with a subset of integrations and be explicit about what it could not inspect.

### 6. Gmail — read-only iteration planned

The [Gmail investigation](problems/gmail-plugin.md) recommends an independent provider plugin using the Gmail REST API and existing Calendar/Drive OAuth patterns. Start with multi-account search, message and thread reads; add drafts next and approved sending only as a separately agreed capability. Reuse an installation's Web OAuth client through caller-checked backend copying, never its account tokens. Gmail still needs its own consent and verified scopes; shared Google projects do not guarantee independent provider-side revocation.

[Iteration 014 — Gmail search and message reading](plans/014-gmail-search-and-read.md) defines the first release: read-only multi-account search and message/thread text, with no drafts or sending. Before live access, establish the applicable Google verification/deployment model, encrypted storage and BB-to-model data handling. Gmail reading and drafting use restricted scopes; Google's draft scope also permits sending, so a future draft-only release must expose no send path. No Gmail plugin or live Gmail access has been delivered. Mailbox mutations, attachments and background synchronization stay deferred until needed.

### 7. Fill remaining provider gaps

The optional Fastmail JMAP tool already supplies precise Inbox/user-label changes with preview, conditional writes and read-back verification. It is not a replacement for the official MCP connection, and its separate token is not proof of the same account or successful live access. Verify and extend that narrow path only for demonstrated needs.

Other candidates include PA's guarded editable saved drafts, conservative contact-group membership changes and Msgvault's local historical email archive. Keep additions narrow and distinguish archive evidence from live mailbox state.

### 8. Specialist integrations

Consider Xero, meeting capture and transcripts, Discord, DNSimple, and other PA integrations one at a time when there is a clear BB task to serve. Keep Red Donkey accounting policy, local recorder dependencies, and other personal deployment state outside general-purpose plugins.

## Next milestones

1. **Obsidian feedback:** after an owner explicitly connects a vault, try a real note task and report usefulness or ambiguity. Generated two-vault reads/writes, stale edits, lost-response inspection and removal are already verified. Any disposable cloud/device round trip needs specific authorization; local receipts and sync timestamps remain separate evidence.
2. **First composed assistant task:** install PA core alongside Google Calendar and Fastmail, then ask: “What's on across all my calendars tomorrow, and what do I need to prepare?” Identify each event's provider/account/calendar, use only connected services, and report partial failures. Drive, Obsidian and email may improve the answer but must not be required.

## Gates that apply throughout

- **Consent determines capability; user intent determines action.** Offer the tools allowed by each service grant, including writes, without an extra Fastmail-specific gate. Do not treat connected services or untrusted provider content as instructions to mutate data. Honor BB and provider interaction/permission flows, describe consequential changes clearly, and inspect uncertain write outcomes instead of retrying blindly.
- **Do not promise multi-user privacy without an enforceable boundary.** The current Google Calendar plugin is explicitly single-user because BB agent tools and plugin routes do not supply a user identity. Keep new connections scoped to single-user installations until BB can enforce per-user account and data isolation. BB plugins run as trusted server code, not as security-isolated providers.
- **Validate in BB, not just in Pi.** Prove installation, connection, tool visibility, and the intended approval behavior in target BB provider sessions. Review changed UI in rendered BB at desktop/narrow widths with keyboard navigation. Record installed versions/commits and distinguish synthetic tests, host checks, provider calls and device delivery; none substitutes for the others.
- **Make failures diagnosable without exposing content.** Follow the [observability standards](o11y-standards.md) and test handled failures with synthetic private sentinels. Keep credentials, note/mail bodies, account details, host paths and raw provider errors out of diagnostics.
- **Keep integrations independent.** Removing Fastmail must not break Google Calendar; removing an ability must not delete a user's account or provider data. Avoid a mandatory shared plugin framework before real composition requires one.
