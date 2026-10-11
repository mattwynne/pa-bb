Drafted by Matt's robot

# 006 — Obsidian vault reading

Status: planned; implementation and live gates not started.

## User outcome

Install Obsidian support in BB, choose an already synced vault by name, and ask:

- “Find my notes about this project.”
- “What did we decide last time? Show me the source.”
- “Read this note and follow its links.”
- “What unfinished tasks are recorded here?”

BB searches and reads only the permitted notes, understands the first set of
Obsidian idioms, cites its sources, and says when its local copy may be stale.
No Obsidian desktop app, Mac relay, PA core, or plugin inside Obsidian is required.

The first iteration is **one selected vault, read-only**. The user authorizes
note access separately from enabling iCloud sync. Syncing a folder is not
permission for Obsidian tools to read it.

## Boundaries and prerequisites

- **iCloud** owns Apple authentication, folder selection, two-way sync, conflicts,
  backups and recovery. This iteration consumes it; it does not duplicate it.
- **Obsidian** owns vault selection, permitted note scope, parsing, search, link
  resolution, task discovery, source attribution and its read-only tools.
- **Abilities** own meeting preparation and other tasks that combine sources.
  Do not build a Calendar dependency or a meeting-preparation workflow into the
  Obsidian integration.

Use the [vision](../vision.md), [UX standards](../ux-standards.md),
[observability standards](../o11y-standards.md),
[iCloud plan](004-icloud-sync.md), and
[pinned Obsidian references](../../plugins/obsidian/docs/reference/README.md).
This remains a trusted plugin for a single-user BB installation, not a sandbox
that prevents other trusted plugins or unrestricted filesystem tools reading
host files.

The planning assumption is that iCloud can supply the vault. Its actual live
Apple and disposable-vault gates remain recorded in iteration 004; this plan does
not mark them passed. Obsidian can be installed before iCloud, but usable note
access requires an explicitly selected mirror with a successful initial sync.
Installing iCloud or connecting Apple alone is not sufficient. Dependency checks
and guided onboarding are part of this iteration, not a documentation fallback.

## First slice

### Select and authorize a vault

Treat one initialized iCloud mirror as the vault root. The owner chooses it from
an inventory by name; do not accept a pasted host path or silently select the
first folder. Markdown files are sufficient: do not require a `.obsidian` folder,
which may have a custom name or be absent from the mirror.

The settings flow explains that BB will read Markdown notes in the selected
vault. Allow scope narrowing with literal vault-relative included folders and
excluded folders. Selecting the entire vault is explicit; no content is scanned
before the selection and scope are saved. Persist the mirror ID and scope, not a
host path, Apple credentials or account identity.

Exclude hidden files/directories, including `.obsidian`, `.git` and `.trash`;
reject symlinks rather than following them. Read regular `.md` files only. Custom
configuration folders can be excluded explicitly. Images, PDFs, plugin code,
Canvas and Bases content are not readable note content in this slice.

Changing scope invalidates cached results immediately. Forgetting the vault
revokes plugin access and clears its cached content without deleting notes,
pausing iCloud, disconnecting Apple or changing any other plugin.

### Search, read and cite

Search permitted note paths/titles, aliases and body text, with an optional tag
filter. Use literal text queries, not arbitrary regular expressions or a promise
to support Obsidian's full Search language. Return bounded snippets and stable,
vault-relative source paths with line spans.

Read a whole note in bounded pages, or a resolved heading/block. Preserve original
Markdown and expose parsed properties, tags and outgoing links separately. Do not
render or execute note HTML, queries, templates or scripts. Return structured
warnings for malformed properties and unsupported constructs; a malformed YAML
header must not make every other note disappear or turn a partial index into a
successful empty search.

Every content result includes selected vault identity, source path, line span,
local read time, observed mirror phase, and last successful iCloud sync. A
vault-relative citation is required. An `obsidian://` open link is optional only
if its client vault name has been configured and verified; do not invent one
from an opaque local mirror directory.

Pagination and size limits must be visible. Use `nextCursor`, `truncated` and
`incomplete`/bounded issue categories as applicable; never claim “no matches” or
“no tasks” when unreadable or skipped notes could change that answer. A cursor is
bound to the selected vault, scope and index revision; reject it after those
change rather than continuing against a different dataset.

### Understand a defined set of idioms

- YAML properties at the beginning of a note, including `aliases` and `tags`;
  preserve ordinary values without guessing property types from private app
  configuration. Disable custom YAML execution and bound alias expansion/depth.
- Inline and property tags, including documented case-insensitive and nested-tag
  matching. Do not mistake numeric-only strings, headings or code for tags.
- Wikilinks and Markdown internal links, including optional `.md`, display text,
  embeds, URL-encoded paths, same-note headings and `#^block` references.
- Heading and block locations, including identifiers on their own line after
  structured blocks. Preserve source offsets for LF and CRLF files.
- Task checkboxes, nested tasks and their exact source location. Per the pinned
  basic-formatting docs, a blank marker is incomplete and a nonblank marker is
  complete; preserve the marker rather than inventing community-plugin status,
  due-date or recurrence semantics.

Exclude code fences, inline code, `%%` comments and HTML regions from ordinary
body-link/tag/task extraction. Handle supported links in properties separately.
Callout content can contain real links and tasks, but examples in fenced blocks
cannot. Embeds are references, not instructions to recursively load everything;
follow-up reads always pass through the same scope checks.

Resolve explicit paths first. A bare name or alias may resolve only to a unique
permitted candidate under the tested rules. Return ambiguity instead of choosing
an arbitrary file. A missing or excluded target must not leak excluded candidate
names or excerpts. External URLs are references, not fetched resources.

The API's `getFirstLinkpathDest` description does not specify all tie-breaking
rules. Record tested compatibility cases; do not claim to reproduce Obsidian's
complete resolver. Community-plugin semantics are deliberately unsupported.

## BB/iCloud handoff and freshness

The existing integration boundary is:

- BB's `bb.sdk.plugins.list()`: verified installation, enabled state and host
  runtime status; filter to iCloud server-side and discard host paths/details.
- `plugins/icloud/server.ts`: the read-only `status` and `inventory` RPCs.
- `plugins/icloud/contract.ts`: `status` includes prerequisite availability,
  connection/challenge state and all selected mirrors; `inventory` supplies
  initialized mirror IDs, names, `localFolder`, phase and `lastSuccess`.
- `plugins/icloud/core/service.ts`: uninitialized mirrors are absent from
  inventory, including an active first sync. Rebuilt mirrors receive new IDs
  while previous copies become `retained`.

Use `bb.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status' | 'inventory',
... })` with local validated output schemas. The installed SDK supports this
pattern; Calendar/Drive already use cross-plugin RPC. Prove actual loaded-plugin
calls and shared filesystem access in a small host spike before building the UI.
An empty inventory is not proof that no folders are selected: inspect `status`
to distinguish an unselected folder, sync not yet enabled, an active initial sync
and failed preparation. A failed RPC is not proof that iCloud is uninstalled or
Apple disconnected. If responses disagree across a transition, recheck within a
bounded budget or report that status is temporarily unavailable.

Map those observations to a single dependency/onboarding state in the core;
settings and agent tools use that same state, not independent guesses. Retain
only the fields needed for this decision. Do not import iCloud's database, derive
its private storage paths or call its agent tool through a language model. Keep
`localFolder` in the server adapter; never expose it in Obsidian tools, browser
responses, citations or diagnostics. Never pass through arbitrary host
`statusDetail`, provider errors or iCloud failure text as a safe explanation.

Policy for the selected, previously initialized mirror:

| Observed state | Read behaviour |
| --- | --- |
| `ready`, successful sync recorded | Read local notes; include the last successful sync, not a claim of current cloud state. |
| `paused`, successful sync recorded | Allow local reads with a prominent stale-copy warning. |
| `running` | Return a bounded busy response; do not scan while sync is known to be modifying the mirror. |
| `failed` or `retained` | Refuse normal content reads and direct the owner to iCloud recovery/selection. |
| Missing inventory, removed/disabled iCloud, missing mirror/root, unknown phase or no successful baseline | Fail closed; never serve a cached copy as though the source were available. |

Check inventory before and after each bounded content operation. If sync state
or last success changes during it, discard the result and return a retryable
source-changed/busy outcome. Check file identity and metadata around reads;
changed or replaced notes are not silently accepted as a stable index entry.

**These checks are not an atomic whole-vault snapshot or a lock on rclone.**
Answers can span notes read at different times. Exercise the start-during-read
race with the real sync adapter. If the tested host behaviour cannot provide
stable individual reads under this policy, stop and design a narrow coordinated
read boundary with iCloud before releasing; do not claim status polling solves
that race. Do not modify sync scheduling or invent a lease protocol without
recording and testing that decision.

A recovery-created mirror must be selected and authorized explicitly. Never
switch to a new ID merely because it has the same display name.

## Implementation shape

Use a TypeScript hexagonal core, cucumber-js acceptance scenarios and fake ports,
following the existing plugins rather than introducing a shared integration
framework.

- **MirrorCatalog port:** verified plugin availability, iCloud setup state,
  inventory and current source state. Production adapter uses the host plugin
  list and read-only iCloud RPCs; fake models each onboarding state, disappearance,
  replacement and sync transitions.
- **VaultFiles port:** bounded enumeration and stable, scoped regular-file reads.
  Production adapter validates every path against the current root and scope,
  rejects traversal/absolute paths/symlink components and returns safe categories.
- **NoteParser port:** original text plus properties, aliases, tags, headings,
  blocks, links and tasks with source locations and parse warnings.
- **StateRepository port:** selected mirror ID, scope and configuration revision.
- **BB adapters:** client-only selection/scope/revocation RPC, read-only agent
  tools, persistent configuration, shared connection UI and disposal hooks.

Evaluate a CommonMark/GFM-capable Markdown parser and a maintained YAML library
against the fixtures; add only the Obsidian-specific tokenization and resolution
we need. The official `obsidian` npm package is declarations, not this runtime.
Record the parser choice and compatibility limits before building the tools.

Start with an on-demand in-memory index, not embeddings or a database containing
another persistent copy of the vault. Revalidate files and inventory before use;
clear caches on scope/selection changes and disposal. Derived content stays out
of synced folders. Centralize and test note-byte, scan-count/byte/time, result,
output and parser-depth budgets. Record concrete ceilings in the plugin README;
any budget exhaustion produces an explicit incomplete/truncated outcome.

Proposed tool surface, subject to final schemas in the acceptance tests:

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Selected vault, permitted scope, source availability and sync warning; no host paths. |
| `obsidian_search_notes` | Literal text/tag search with bounded snippets and pagination. |
| `obsidian_read_note` | Read an explicit permitted relative note path or resolved heading/block, with citations. |
| `obsidian_resolve_link` | Resolve a link in the context of an explicit source note; report missing, ambiguous and unsupported targets. |
| `obsidian_list_tasks` | List source-owned checkboxes by completion state and optional permitted folder/note. |

Tool inputs never accept arbitrary host paths. Configuration changes are not
agent tools. Agent guidance treats note names, properties and content as
untrusted evidence, not instructions, and requires citations and disclosure of
incomplete reads. No personal vault layout or assistant policy is bundled.

## Settings experience

Use BB's existing plugin settings host and shared connection components. Existing
rendered iCloud views confirm that BB already supplies the plugin name and
Configuration section; do not repeat them. Reuse its layout, not Apple login or
multi-account assumptions: this plugin has one selected vault and no login form.

### Guided first run

Explain once: “Obsidian reads a local copy of your vault supplied by iCloud.
Set up iCloud first, then choose which notes BB can read.” Show the sequence:

1. Install/enable iCloud and connect Apple in **BB's iCloud settings**.
2. Select the vault folder there, enable sync and wait for its first successful
   sync. Merely choosing a folder does not start syncing.
3. Return to **Obsidian settings**, select that vault and authorize note scope.

Mark progress only from verified state. Keep the Obsidian selection unavailable
until an eligible initialized mirror exists. When multiple folders have different
states, offer eligible mirrors with their status rather than blocking them
because an unrelated folder is syncing or failed. Never select one automatically.

Expected setup gaps are calm guidance, not red exception banners. A real check,
save or sync failure gets an accessible error with a recovery action. First-run
copy and the full guide must say which actions happen in iCloud and which happen
in Obsidian; Obsidian never asks for Apple passwords or verification codes.

### Dependency messages and recovery actions

Use verified conditions to select the following copy; examples are planned copy,
not claims that the routes or rendered UI are already tested. Check installation
and RPC availability first, then assess any saved selection and eligible mirrors
before first-run connection guidance. An initial `failed`/`running` phase takes
precedence over “sync not enabled”; `enabled=false` alone proves neither. Provider
prerequisite/connection warnings do not revoke a previously authorized local copy
that the freshness policy still permits reading.

| Verified condition | Explanation | Primary next action |
| --- | --- | --- |
| Plugin list confirms iCloud is not installed | “Set up iCloud first so BB can access your Obsidian vault.” | Find/install iCloud through BB's marketplace. |
| iCloud is installed but disabled | “iCloud is turned off. Enable it in BB to continue.” | Open its BB plugin details; do not enable it automatically. |
| Host reports iCloud starting | “iCloud is starting. We'll check again shortly.” | Bounded status refresh; never reload it to hurry setup. |
| Host reports incompatible iCloud | “This iCloud version cannot run with the current BB installation.” | Open its plugin details for the host's update guidance. |
| Plugin-list/RPC check failed or host reports an unavailable/error state | “Could not check iCloud setup. Your Obsidian settings have been kept.” | Check again; offer iCloud details as a secondary action, not a guessed reinstall/reconnect. |
| iCloud reports unavailable host prerequisites | “iCloud needs host setup before it can sync your vault.” | Open iCloud's prerequisite guidance; ask the host operator to complete it. |
| No eligible mirror and Apple verification is pending | “Finish Apple verification in iCloud settings.” | Open iCloud settings; never request the code here or in chat. |
| No eligible mirror and Apple is disconnected | “Connect your Apple account in iCloud settings to sync a vault.” | Open iCloud settings. |
| Connected, no vault folder selected | “Choose your Obsidian vault folder in iCloud settings.” | Open the iCloud folder selection. |
| Folder selected, never initialized, paused and not enabled | “Enable sync for your vault in iCloud settings. Obsidian needs its first successful sync.” | Open iCloud settings; no automatic Enable sync call. |
| Initial sync is running | “Your vault's first sync is still running. Obsidian will be available after it finishes.” | Show verified folder status and refresh while this page is open; no invented percentage, ETA or success. |
| Initial sync failed | “The first sync did not finish. Review recovery in iCloud before continuing.” | Open iCloud recovery guidance; do not retry/resync/rebuild automatically. |
| Eligible mirror exists, no Obsidian selection | “Choose the synced vault BB may read.” | Select vault and scope, then explicitly save authorization. |
| Saved mirror ID is absent or retained/replaced | “The selected vault is no longer available for normal reads. Review it in iCloud, then choose a vault again.” | Open iCloud; preserve the previous selection without silently granting access to a replacement. |

For previously authorized mirrors, retain the freshness policy above: paused or
Apple-disconnected copies with a successful baseline can be read with a visible
stale-copy warning; running sync produces a busy response; failed/retained copies
require recovery. Do not force an otherwise permitted stale read through first-run
onboarding merely because Apple is disconnected. Conversely, a folder with no
successful baseline must never be presented as a stale-but-readable vault.

Use one primary action appropriate to the current state, plus a quiet full-guide
link. Confirm BB's actual catalog/details/settings navigation in running BB. The
existing `/plugins/icloud?configure=icloud` review route is a candidate for an
installed plugin, not a proven install/catalog deep link. If the host offers no
stable route for a step, give exact BB navigation instructions rather than a
broken button or an automatic install command.

Refresh on returning to Obsidian and use bounded polling only while its setup
page is visible for pending states. Completing initial sync makes the selection
available without reinstalling Obsidian or starting a new chat. Preserve unsaved
scope choices on failed saves; ignore late responses after scope change/forget.
After setup, lead with the vault, read-only scope and last successful sync; keep
the setup checklist behind a quiet guide. Distinguish an empty permitted vault
from an incomplete or failed scan.

### Agent-facing errors

`obsidian_status` exposes the same bounded setup code and useful next step.
Blocked content tools return an error result with that code and explanation,
never `[]`, “vault empty”, a raw RPC exception or a generic “read failed”. For
example: “Obsidian is not ready: the vault's first iCloud sync is still running.
Wait for it to finish in iCloud settings, then choose the vault in Obsidian.”
Keep installation/verification/sync actions in settings, not agent tools. The
assistant must not ask for credentials, recommend a reset for a transient check
failure, or imply it searched notes when setup prevented the search.

Write a complete portable setup guide. Inspect the running host again before
finalizing controls, then review every dependency state above plus configured,
empty, save-error and revoked states at desktop and narrow widths with keyboard
navigation and accessible announcements. No write-approval UI is applicable to
this read-only slice; authorization to read is still explicit.

## Delivery steps and gates

1. **Prove the handoff.** In an isolated running BB, install iCloud and a minimal
   Obsidian package; prove server-to-server inventory, filesystem readability,
   plugin-list/status/inventory classification, dependency navigation and
   name-based selection using synthetic mirrors. Include empty inventory during
   an active initial sync and a previously successful disconnected copy. Record
   the supported host/SDK versions and race limitations. Do not proceed on the
   strength of SDK types alone.
2. **Specify behaviour.** Write Gherkin features for the outcomes below; define
   ports and fixtures before implementation. Compare uncertain syntax/resolution
   cases with a disposable vault in Obsidian. Choose parser libraries and record
   supported cases, unsupported cases and resource budgets.
3. **Build the read core and adapters.** Implement scope enforcement, parser,
   index invalidation, citations, tools, safe diagnostics and state persistence.
   Test real temporary filesystem trees as well as fake ports.
4. **Wire settings and package.** Add `plugins/obsidian/` package files, contract,
   server, app, setup guide, README and marketplace entry. Add `obsidian` to
   `scripts/sync-connection-ui.mjs`; keep generated copies self-contained. Include
   fake-BB tool/lifecycle tests and rendered review automation.
5. **Verify before shipping.** Run Obsidian build/typecheck/Cucumber/adapter/host
   tests, shared UI drift and marketplace checks, and iCloud regression tests;
   run other affected suites if shared code changes. Exercise safe synthetic
   failure diagnostics and review rendered BB, not just screenshots in isolation.
6. **Ship and observe.** Follow `bb-ship-feedback`: commit/push, install the new
   plugin explicitly from the marketplace (an update cannot install it), verify
   running version/commit and fresh provider-session tool visibility. Update
   iCloud only if this iteration actually changed it. Use a narrowly scoped
   read-only call against an explicitly authorized disposable vault. Record live
   evidence and unresolved gates, then seek feedback in running BB.

Documentation-only planning requires no plugin deployment. Implementation must
not access a personal vault merely to close a test gate. If live Apple/iCloud
access is unavailable, synthetic host/UX checks can proceed, but the actual
synced-vault end-to-end gate remains unverified.

## Acceptance coverage

| Area | Executable examples |
| --- | --- |
| Authorization | No content before explicit selection/scope; selection persists over restart; changing scope/forget revokes cached paths, results and cursors. |
| Dependency | Plugin-list/status/inventory failures are not guessed to mean missing iCloud, disconnected Apple or an empty vault; no cached-root fallback. |
| Onboarding | Installed-before-iCloud, disabled/starting/incompatible plugin, missing host prerequisites, Apple verification/disconnection, no folder, sync not enabled, active/failed initial sync and ready-to-select states have distinct verified messages/actions. |
| Onboarding transitions | Empty inventory during first sync never says “no folders selected”; completion unlocks selection without reinstall/new chat; eligible folders remain offered while unrelated folders are pending/failed; late responses cannot restore revoked access. |
| Recovery/navigation | Every advertised install/details/settings action reaches the correct BB screen; returning refreshes status; no automatic install, enable, sync, reconnect or destructive recovery; saved selection/scope survives unavailable checks. |
| Agent errors | Blocked reads/search/tasks return the same actionable setup code as settings, not empty success; no credentials requested and no claim that notes were searched. |
| Identity | Duplicate display names remain distinguishable; replacement/retained mirror never silently inherits authorization. |
| Filesystem | Include/exclude scope applies to search, read, tasks and followed links; absolute paths, traversal, encoded traversal, symlink escape and symlink-swap attempts fail safely. |
| Syntax | Properties, aliases, nested/case-insensitive tags, links/embeds, heading/block references, nested tasks and nonblank completion markers; Unicode, spaces, LF and CRLF fixtures. |
| False positives | No links/tags/tasks extracted from fences, inline code, comments or HTML; property parsing is handled separately. |
| Resolution | Unique relative/root paths, aliases and same-note references; missing/ambiguous targets and external URLs; excluded targets reveal no excluded candidates. |
| Partial results | Malformed YAML, unreadable notes, unsupported/oversized inputs, parser limits, deadlines and scan/result budgets produce explicit warnings/incompleteness. |
| Freshness | Ready/paused/running/failed/retained policies; inventory change during reads, note replacement and a real sync/read race do not produce a falsely stable result. |
| Source attribution | Every snippet, read and task has the permitted note path/line span and observed sync provenance; no local host paths. |
| Read-only | Reads create no files inside the vault, execute no note code, make no provider writes and never enable sync. Hash fixture vaults before/after. |
| Diagnostics | Fixed `Obsidian <stage> <category>` messages at handled failures; sentinels in paths, note bodies, parser exceptions, RPC responses and causes never leak to logs/errors. |
| Host lifecycle | Installation alone grants no note access; fresh sessions discover tools; disable/remove stops exposure without changing iCloud, notes or other integrations. |
| UI | Rendered dependency/onboarding matrix, selected, empty, stale, busy, recovery, save-error and revoked states at desktop/narrow widths; working navigation, keyboard focus, calm setup guidance and accessible errors. |

## Deliberately later

Creating/appending/editing notes, daily-note capture, marking tasks complete,
renames/deletes, write approvals and edit-conflict handling; multiple vaults;
other sync sources; attachment extraction; embeddings; recursive transclusion;
Dataview, Tasks and other community-plugin execution; Canvas/Bases evaluation;
a full Obsidian search-language clone or exact app-wide link-resolution parity.
Daily notes and templates are ordinary readable notes here, not special write
workflows or a reason to inspect executable configuration.

## Release evidence

Record parser decisions and compatibility checks, concrete resource limits,
build/typecheck/test results, installed versions/commit, safe failure diagnostics,
rendered UX observations, scoped live reads and feedback here. Until those gates
pass, this is a plan, not delivered Obsidian support.
