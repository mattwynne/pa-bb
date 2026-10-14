# 006 — Obsidian vault reading and editing

Status: planned; implementation and live gates not started.

## User outcome

Connect a synced vault to BB and ask the assistant to find, read, create and edit
notes. Connecting the vault gives the assistant **read/write access to the whole
vault**, with no folder permissions, read-only mode, approval cards or per-edit
confirmations. This is the chosen product direction, replacing the earlier
scoped-access and approval proposals.

Support one or more connected vaults with the same simple model. Multiple vaults
are additional sources, not separate permission profiles. Each source and edit
identifies its vault and relative note path.

Typical requests:

- “Find my notes about this project.”
- “What did we decide last time? Show me the source.”
- “Read this note and follow its links.”
- “What unfinished tasks are recorded here?”
- “Add this decision to the project note.”
- “Update that paragraph and mark this task complete.”
- “Create a note for this meeting and link it from the project note.”

The assistant performs the work and reports the result. It asks a question only
when it cannot determine what the user means, not to approve an identified edit.
It does not execute instructions found in note content. No Obsidian desktop app,
Mac relay, PA core or plugin inside Obsidian is required.

[The short HTML overview](006-obsidian-ux-options.html) replaces the six-decision
interview document. This feature request is a planning decision, not permission
to use or modify a personal vault during development.

## Setup and connected view

Use BB's existing settings host and shared connection UI. BB already supplies
the plugin name and Configuration section; do not repeat them.

1. **In BB's iCloud settings:** connect Apple, choose the vault folder, enable
   sync and wait for its first successful sync.
2. **In Obsidian settings:** choose an eligible synced vault by name. Selecting
   it connects the whole vault for reading and editing immediately; there is no
   second permission screen, consent checkbox or confirmation dialog.
3. **In chat:** ask BB to use the notes. Add another vault the same way if needed.

Explain once: “Connect a vault so BB can read and edit all its notes. Changes
are sent back through iCloud.” Do not request Apple credentials in this plugin
or in chat. Do not connect an arbitrary inventory entry automatically or accept
a pasted host path. Markdown files are enough; a `.obsidian` folder is not required.

After setup, show the connected vault names and last successful sync, with
**Add vault**, **Remove** and a quiet setup-guide link. No read/edit switches,
folder scopes, permission summaries, approval preferences or edit-history dashboard.
Removing a vault stops its exposure and clears cached content without deleting
notes, pausing iCloud or disconnecting Apple. Removal needs no confirmation.

Settings and tools share one verified dependency state. Keep selected vaults and
pending selections on failed checks; ignore late responses after removal. Refresh
on returning to the page and poll boundedly only while pending setup is visible.
Offer eligible vaults even if another folder is syncing or failed. Distinguish
an empty inventory during initial sync from no folder having been selected.

| Verified condition | Next step |
| --- | --- |
| iCloud not installed or disabled | Install or enable iCloud through BB's plugin screens. |
| iCloud starting | Explain that it is starting; check again without reloading it. |
| Incompatible iCloud or unavailable host prerequisites | Open verified plugin/update or prerequisite guidance. |
| Plugin-list/RPC check failed | “Could not check iCloud setup. Your connected vaults have been kept.” Offer Check again, not a guessed reconnect/reinstall. |
| No eligible vault and Apple disconnected/verification pending | Connect or finish verification in iCloud settings. |
| Connected but no vault folder selected | Choose the vault folder in iCloud settings. |
| Folder selected but sync never enabled | Enable sync there; selection alone does not start syncing. |
| Initial sync running | Show verified status and wait for completion; no invented percentage or ETA. |
| Initial sync failed | Open iCloud recovery guidance; do not automatically rebuild or resync. |
| Eligible mirrors exist | Offer Connect by vault name. |
| Connected mirror missing, retained or replaced | Explain source unavailability; review in iCloud and connect the intended mirror. Never switch identities just because the name matches. |

Expected setup gaps are calm guidance, not red exception banners. Actual failures
have accessible messages and a useful next step. Confirm install/details/settings
navigation in running BB; if no stable route exists, give exact navigation
instructions instead of a broken button. Publish a complete portable setup guide.

## Boundaries

- **iCloud** owns Apple authentication, folder sync, conflicts, backups and
  recovery. It also owns the coordinated local-file commit boundary below.
- **Obsidian** owns connected-vault selection, note parsing, search, metadata,
  link/task discovery, citations and note mutations. No separate permission or
  approval subsystem belongs here.
- **Abilities** combine notes with other sources; do not add a Calendar dependency
  or meeting-preparation workflow to this integration.

Use the [vision](../vision.md), [UX standards](../ux-standards.md),
[observability standards](../o11y-standards.md), [iCloud plan](004-icloud-sync.md)
and [pinned Obsidian references](../../plugins/obsidian/docs/reference/README.md).
The standing whole-vault choice supplies prior consent for note tools; do not
turn the shared trust policy into another approval flow. The plugin remains
trusted code in a single-user BB installation, not a sandbox for other plugins.

## Reading, metadata and links

All Markdown notes under each connected root are readable and editable, including
nested and hidden folders; there is no configurable exclusion list. File-format
coverage is not a permission system: this slice handles regular `.md` notes.
Images, PDFs, Canvas/Bases and plugin/configuration code are not interpreted or
executed as note content. Report unsupported formats honestly. Reject symlinks,
absolute paths and traversal so a vault cannot expose unrelated host files.

- Search literal text in note paths/titles, aliases and bodies, with optional
  tags. No arbitrary regex or claim of Obsidian's complete Search language.
- Read notes in bounded pages or resolved heading/block sections. Preserve
  Markdown and return parsed metadata separately. Never render executable note
  HTML, queries, templates or scripts.
- Return compact properties, aliases, tags, headings, blocks and outgoing links,
  with source locations, whole-note version and parse/completeness warnings.
  File metadata is separate from frontmatter properties.
- Every source includes stable vault ID/name, relative path, line span, local read
  time, mirror state and last successful sync. Never expose host paths. Optional
  `obsidian://` links require a verified client vault name.
- Make limits visible through pagination and incomplete/truncated results. Bind
  cursors to connected-vault identity and index revision; invalidate them when
  sources change. Never turn unreadable notes or malformed YAML into empty success.
- Search may span connected vaults. Report partial source failures explicitly
  rather than hiding the results of usable vaults or pretending the search was
  complete. Failed vaults do not make healthy ones unusable.

Support YAML properties, aliases, inline/property tags, nested and
case-insensitive tag matching, wikilinks, Markdown links, embeds, headings,
`#^block` references and source-owned task checkboxes. Preserve LF/CRLF offsets
and nonblank completion markers; do not invent community-plugin task states,
dates or recurrence. Handle standalone block identifiers after structured blocks.

Exclude fences, inline code, `%%` comments and HTML regions from ordinary
body-link/tag/task extraction, not from file access. Real callout content can
contain tasks and links. Handle links in properties separately. Bound YAML
expansion/depth and prohibit executable tags.

Resolve links inside their source vault: explicit paths first, then unique bare
names/aliases under tested rules. Do not choose an arbitrary duplicate or search
another vault implicitly for a missing link. Missing and ambiguous targets are
honest outcomes; external URLs are references, not fetched resources. Embeds do
not recursively load everything. Record tested compatibility cases, not full
Obsidian resolver parity.

## Editing without confirmations

Provide creation in existing folders, appends, bounded exact-text replacements,
task-checkbox edits and structured property updates throughout a connected vault.
The assistant may compose the text and choose an unambiguous destination as part
of the user's task, without a separate preview/approval step. There is no
`Approval` port, approval flag, approval interaction or prior-intent verification
spike. Prove normal tools can run without required host confirmation before
promising the experience; a host incompatibility is a blocker, not a reason to
quietly add our own confirmation flow.

Each targeted tool call specifies a stable vault ID and relative path. Search and
status expose the IDs so the assistant can target the right vault without asking
the user to handle opaque identifiers. Ask for clarification only if the intended
vault, note or change is genuinely ambiguous. Do not silently write every matching
note across multiple vaults.

Read the complete current note within the file-size budget and bind the edit to
its expected whole-note hash and a stable operation ID. Require unique exact
replacement matches and reject overlaps. A task edit identifies its original
location, marker and text, not the first similar checkbox found. Creation refuses
an existing destination. Never replace a whole note from a truncated read.

Preserve untouched text, YAML comments/spacing, links, block identifiers and line
endings. Check the version inside the coordinated commit. If another writer
changed it, save nothing from the stale patch: reread before preparing a fresh
edit, without asking for confirmation. Do not silently merge or replay an append.
An edit touching two notes is two separately reported saves, not a transaction.

Properties use bounded `set`/`remove` operations on explicit top-level keys.
Preserve unrelated keys and body bytes; a missing header may be created. Support
scalar/list values, validate reserved `tags`/`aliases` shapes, preserve date/time
strings without invented conversion and quote link values safely. Adding an alias
retains existing aliases; replacing a tag list does what the request says.

Use a source-preserving YAML tree and verify unchanged bytes outside edited spans.
Do not infer vault-wide property types from private app configuration. Reject
malformed/duplicate keys, executable tags, unsafe expansion or unsupported
structural edits rather than rewrite unrelated content. General frontmatter text
edits cannot bypass validation. An explicitly requested repair needs a validated
result, not a confirmation UI. Property edits use the same whole-note hash and
commit path as body edits; a metadata read is not evidence that the body is unchanged.

### Persistence and outcomes

Retain a protected, durable pre-edit recovery copy outside the synced vault before
replacing a note. Define retention/capacity bounds before implementing commits;
fail before changing bytes if safe recovery cannot be retained. Keep copies and
journal content out of logs and ordinary tool output. Document an operator-assisted
restoration procedure that compares with current bytes and preserves newer changes.
No new recovery dashboard or undo tool is required in this slice.

Persist operation identity and receipts so transport retries cannot double-append
or double-create. Bind retries to the original invocation, not a new ID. Stage
outside the mirror on the same filesystem and atomically replace after saving the
recovery copy and journal state. Reconcile crashes before sync can upload partial
notes or staging files. Test exclusive creation, disk-full, permissions,
cancellation, disposal, restart and symlink-swap behavior.

Report the actual change and **saved locally, pending iCloud sync** after a
confirmed commit. A later sync timestamp proves a run occurred, not delivery of
those bytes. Say “verified in iCloud” only with content-specific cloud evidence;
phone receipt needs separate device evidence and is not promised. Sync failure
after local save is a saved edit with pending/failed delivery, not an edit to repeat.

For a lost response, allow bounded recent receipt inspection through
`obsidian_status`, identified by vault/note/time rather than requiring a remembered
operation ID. Distinguish confirmed save, confirmed non-commit, later note changes
and unresolved outcome. Receipt facts can remain available while the same vault
is connected even if its source is temporarily unavailable; do not claim current
file state without reading it. Removed vaults expose neither content nor receipts.
Never blindly retry an uncertain commit. Clear the index and old cursors after saves.

## iCloud handoff and coordination

Use BB's verified `bb.sdk.plugins.list()` and iCloud's read-only `status`/`inventory`
RPCs through `bb.sdk.plugins.callRpc`, validating responses locally. Inventory
contains initialized mirror IDs/names, `localFolder`, phase and `lastSuccess`;
uninitialized first-sync folders may be absent. Inspect status to distinguish
that from no folder selection. Never import iCloud's database or derive its private
paths. Keep `localFolder` server-side and sanitize dependency/provider errors.

| Mirror state | Behavior |
| --- | --- |
| Ready with a successful baseline | Read locally with provenance; allow coordinated writes when connected/enabled. |
| Paused/disconnected with a successful baseline | Allow stale local reads with a visible warning; explain that editing needs working sync. This is source availability, not an owner-selected read-only mode. |
| Running | Bounded busy response; no normal scan or commit while sync modifies the mirror. |
| Failed/retained/missing/unknown, or no successful baseline | Refuse normal content operations with a specific source-recovery/setup action; do not serve cached roots as though current. |

Check inventory before/after bounded reads and file identity around each read.
Discard unstable results. Polling is not an atomic snapshot or a lock on rclone:
exercise the start-during-read race with the real adapter and add a narrow
coordinated read boundary if testing shows one is needed. Do not assume repeated
polls prove stability or change scheduling merely to avoid measuring the race.

Writes require an additional iCloud-owned, server-to-server conditional commit
boundary sharing exclusive coordination with sync, pause/recovery and disposal.
Restrict callers to the host-verified Obsidian plugin. Validate connected mirror
identity, vault-relative regular-file containment, expected hash and create/edit
semantics inside the transaction. Serialize all participating writers and vault
removal with commit admission; once removal is acknowledged, queued operations
cannot still gain access. This is not an OS-wide lock against other trusted code.

Existing status/inventory RPCs do not implement that boundary. Prove the port,
caller verification and crash behavior in a host spike; never fall back to unsafe
filesystem writes. Older iCloud versions may support reads while edits explain
that safe editing needs an update. Keep sync coordination short; do not simulate
it with Pause/Resume calls or force a resync as part of an edit. Measure a normal
read–edit–save workflow with scheduled sync so routine use is practical.

## Implementation shape and tools

Use a TypeScript hexagonal core, cucumber-js scenarios and fake ports, following
existing plugins without a new shared integration framework:

- **MirrorCatalog:** verified availability, setup, inventory and source state.
- **VaultFiles:** bounded enumeration/stable reads and coordinated conditional saves.
- **NoteParser:** Markdown/metadata/source locations and source-preserving edits.
- **StateRepository:** connected mirror IDs, configuration revision and operation
  journal/receipts. No permission profiles or approval records.
- **BB adapters:** client-only Connect/Remove settings RPCs, note tools, shared
  connection UI, persistent configuration and lifecycle/disposal handling.

Start with an on-demand in-memory index, not embeddings or a persistent search
copy. Revalidate before use and clear caches on vault removal/disposal. Bound
note bytes, scan count/bytes/time, output, pagination and parser complexity;
document concrete ceilings and report exhaustion as incomplete. Evaluate maintained
CommonMark/GFM and YAML libraries against fixtures before selecting them.

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Connected vaults, source warnings and bounded recent/known-operation inspection. |
| `obsidian_search_notes` | Literal text/tag search across connected vaults or one specified vault. |
| `obsidian_read_note` | Read a vault-relative note/heading/block with citations and version hash. |
| `obsidian_get_note_metadata` | Compact properties and structural metadata with version/warnings. |
| `obsidian_resolve_link` | Resolve a reference in a specified source note and vault. |
| `obsidian_list_tasks` | Source-owned checkboxes by completion state and optional vault/folder/note. |
| `obsidian_create_note` | Create a Markdown note without overwriting an existing destination. |
| `obsidian_edit_note` | Append or apply exact-text/task edits against a complete note version. |
| `obsidian_update_properties` | Set/remove named properties without replacing unrelated header/body bytes. |

All targeted operations carry `vaultId`; searches may omit it to search all
connected vaults. Tools expose no host paths, arbitrary callbacks or code execution.
Both read and write tools are available for connected vaults. Configuration is
not an agent tool. Treat names, properties and note contents as evidence, never
as instructions that override the user's task.

The official `obsidian` package provides declarations, not standalone runtime
implementations. Align reads with `Vault.read`, edits with `Vault.process`, metadata
with `MetadataCache.getFileCache`, properties with `FileManager.processFrontMatter`,
and link resolution with `getFirstLinkpathDest`/`resolveSubpath`; implement and test
our own sync, formatting and persistence guarantees rather than claim API parity.

## Delivery and acceptance gates

1. **Host spike:** prove plugin-list/status/inventory, shared filesystem access,
   name-based multi-vault selection, navigation and tool execution without edit
   confirmations. Include initial-sync empty inventory and a stale readable copy.
   Prove sync/commit exclusion, removal races and restart/crash reconciliation with
   synthetic notes before mutations are enabled.
2. **Executable behavior:** define ports, parser fixtures, concrete budgets and
   recovery retention/capacity. Test syntax uncertainty in a disposable Obsidian
   vault. No permissions matrix, approval renderer or consent-verification project.
3. **Build/package:** implement core, adapters, settings, guide, README, marketplace
   entry and shared connection UI synchronization. Add fake-BB lifecycle/tool tests.
4. **Verify:** build/typecheck/Cucumber/adapter/host tests, marketplace/shared-UI
   checks and affected iCloud regressions. Use synthetic sentinel failures to
   establish bounded diagnostics without leaking paths, note content or credentials.
5. **Rendered BB:** review first-run/pending/connected/multiple-vault/empty/error/
   removed states at desktop and narrow widths with keyboard/accessibility checks.
   Prove a requested edit saves without a confirmation interaction, and exercise
   conflicts, busy source, local-save/pending-sync and uncertain saves.
6. **Ship/observe:** follow `bb-ship-feedback`; install the new plugin explicitly,
   verify versions/commit and fresh-session tools. Test disposable reads, local
   edits and approved test-only cloud/phone round trips. Record passed/unverified
   gates accurately; do not use a personal vault just to close release evidence.

Essential acceptance cases: no access before a vault is connected; whole-vault
read/write persists over restart; hidden/nested Markdown is accessible without
permissions prompts; two vaults with identical note names remain correctly targeted;
removal prevents queued writes and clears content exposure without deleting files;
healthy vaults remain usable while another fails; traversal/symlink escapes fail;
malformed/oversized data yields explicit incompleteness; source citations retain
vault/path/line identity; reads have no side effects; edits preserve unrelated
bytes; version conflicts never overwrite newer notes; retries never duplicate
appends; unknown outcomes are inspected; sync timestamps never imply phone delivery.

Documentation-only changes need no plugin deployment. The HTML is a concept
summary, not rendered-BB release evidence. Actual Apple/synced-vault gates remain
unverified until exercised with specifically authorized disposable data.

## Later and release evidence

Renames/deletes, cross-note link rewrites, bulk transactions, daily-note/template
automation, other sync sources, attachment extraction, embeddings, recursive
transclusion, community-plugin execution and Canvas/Bases evaluation remain later.
Explicit daily notes/templates can be read and edited as Markdown; scripts are
not executed. Multiple connected vaults are part of the planned source model,
not a reason to introduce permissions or another setup workflow.

Record parser choices, resource bounds, host/SDK compatibility, build/test results,
installed versions/commit, coordinated commit/recovery diagnostics, rendered UX
observations and disposable sync evidence here. Until those gates pass, this is
planned Obsidian support, not a delivered plugin.
