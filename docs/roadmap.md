# PA for BB roadmap

PA for BB should be a useful assistant assembled from independently installed service connections and task-focused abilities. **A service is a plugin; a task that spans services is an ability.** Installing the marketplace installs neither. Users choose which accounts and capabilities to connect.

This is a proposed order of work, not a promise to port every PA package. The [vision](vision.md) describes the intended experience and trust boundaries. The existing [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) supply behavior and tests to adapt, not a package list to copy wholesale.

## Where we are

**Google Calendar, Fastmail, and a read-only Google Drive first slice are built** as independently installable BB plugins. Calendar and Drive connect Google accounts using separate OAuth callbacks and plugin-owned grants; Fastmail uses its official MCP service. See each plugin README for setup and verification limits. Drive's live consent and provider reads are not yet verified.

## Priorities

### 1. Fastmail: one connection, several capabilities

The [connection spike](plans/002-fastmail-mcp-findings.md#follow-up-isolated-live-proof) proved read-only MCP access through an Agent Plugins bridge. Fastmail accepted a localhost redirect pasted back into BB, but its dynamic registration rejected the tested public HTTPS callbacks. A standalone Fastmail plugin is now listed alongside Google Calendar and connected on production PA; the bridge pilot was removed. The standalone plugin has not yet passed live tool calls in a fresh provider session or live write verification.

Build **one Fastmail plugin** that connects an account and makes the official Fastmail MCP service's mail, calendar, and contacts capabilities available in BB. A user should not have to install separate Fastmail Mail and Fastmail Calendar plugins. Own connection setup, status, and account choice at the Fastmail boundary; keep task workflows elsewhere.

BB should discover and offer the tools Fastmail exposes under the user's MCP login grant, **including mutation tools when the user selects those permissions**. Do not impose a Fastmail-specific read-only allowlist or an extra plugin approval step. The standalone connection uses whichever grant the user selected in Fastmail; do not infer its scopes from a tool count. If BB needs an adapter, keep it thin: do not copy provider tool schemas or rebuild the calendar protocol. PA [chose the official MCP service](https://github.com/mattwynne/pa/blob/main/docs/adrs/0006-use-official-fastmail-mcp-for-calendar-access.md) and removed its native CalDAV path because recurrence, timezones, and lossless edits were too risky to maintain locally. Test how write calls, provider interactions, precise targeting, and uncertain outcomes behave without requiring a live mutation merely to release the connection. PA's recorded live validation covered calendar reads, not mutations.

### 2. PA core: compose without assuming a provider

Keep the core small. It should explain installed capabilities and missing connections, attribute facts to their sources, distinguish a proposed action from a completed one, and apply shared approval and untrusted-content rules. It should work with no connected service and should not own provider credentials or absorb every workflow.

The first cross-provider use case is **calendar awareness**: answer a question across connected Google and Fastmail calendars, preserve each event's provider/account/calendar identity, and report partial failures instead of silently treating one provider as complete. Calendar interpretation and availability reasoning belong above the providers. Do not invent a shared calendar write API merely to support a combined read.

### 3. Google Drive and Docs

The independently installable [Google Drive/Docs read-only first slice](plans/003-google-drive-discovery.md) uses the Pi extension as a behavioral starting point. Verify its live consent and reads, then add approved creation, editing, sharing, and filing. The Pi extension has extensive Docs operations but its folder-finding tools do not amount to general file search, so design this around actual document-finding tasks rather than copying its tool list. Add Sheets and Slides when demonstrated workflows need them, not as a prerequisite to useful Drive access.

### 4. Personal knowledge and Obsidian

Make access to projects, people, and source-owned actions optional. Start read-only and settle how the BB host gets a current, authorized view of a user's vault before offering edits. PA currently relies on Matt's local iCloud/Obsidian filesystem and git workflow; that path and Matt's private knowledge or policies must not be bundled into a public plugin. If vault access is the gating dependency for the next useful ability, move this item ahead of Drive/Docs.

### 5. Outcome abilities

Once sources are connected, package the work people ask PA to do. Begin with **meeting preparation / Get Perspective** across available calendars and context; follow with a daily briefing, saved email drafting, inbox triage, and weekly planning where their dependencies are ready. Adapt PA's existing abilities rather than copying Pi-specific commands, subagents, private policies, or filesystem assumptions verbatim. Each ability should remain useful with a subset of integrations and be explicit about what it could not inspect.

### 6. Fill gaps in provider support

Add Fastmail-specific operations inside the Fastmail plugin when the official MCP service cannot support a proven PA workflow safely—for example, PA's guarded editable saved drafts or precise mailbox changes. Conservative contact-group membership changes and Msgvault's local historical email archive are further candidates. Keep those additions narrow; do not make them prerequisites for the initial Fastmail connection or conflate archive evidence with live mailbox state.

### 7. Specialist integrations

Consider Xero, meeting capture and transcripts, Discord, DNSimple, and other PA integrations one at a time when there is a clear BB task to serve. Keep Red Donkey accounting policy, local recorder dependencies, and other personal deployment state outside general-purpose plugins. Gmail can be a separate provider plugin if demand justifies it; Fastmail's mail access should not imply that every mail provider is supported.

## First milestone after Google Calendar

Install **Fastmail and PA core alongside Google Calendar**, then ask: “What's on across all my calendars tomorrow, and what do I need to prepare?” A successful answer identifies which provider and account supplied each event, uses only connected services, and says when one source could not be read. It does not require Drive, Obsidian, or email to be installed, though those connections can improve the preparation advice later.

## Gates that apply throughout

- **Consent determines capability; user intent determines action.** Offer the tools allowed by each service grant, including writes, without an extra Fastmail-specific gate. Do not treat connected services or untrusted provider content as instructions to mutate data. Honor BB and provider interaction/permission flows, describe consequential changes clearly, and inspect uncertain write outcomes instead of retrying blindly.
- **Do not promise multi-user privacy without an enforceable boundary.** The current Google Calendar plugin is explicitly single-user because BB agent tools and plugin routes do not supply a user identity. Keep new connections scoped to single-user installations until BB can enforce per-user account and data isolation. BB plugins run as trusted server code, not as security-isolated providers.
- **Validate in BB, not just in Pi.** Prove installation, connection, tool visibility, and approval behavior in the target BB provider sessions. A Pi extension or an MCP tool working elsewhere does not establish that it works through BB.
- **Keep integrations independent.** Removing Fastmail must not break Google Calendar; removing an ability must not delete a user's account or provider data. Avoid a mandatory shared plugin framework before real composition requires one.
