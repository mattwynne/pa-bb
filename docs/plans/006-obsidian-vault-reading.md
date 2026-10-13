Drafted by Matt's robot

# 006 — Obsidian vault reading and editing

Status: planned; implementation and live gates not started.

## User outcome

Install Obsidian support in BB, choose an already synced vault by name, and ask:

- “Find my notes about this project.”
- “What did we decide last time? Show me the source.”
- “Read this note and follow its links.”
- “What unfinished tasks are recorded here?”
- “Add this decision to the project note.”
- “Update that paragraph and mark this task complete.”
- “Create a note for this meeting and link it from the project note.”

BB searches, reads and edits only permitted notes, understands the first set of
Obsidian idioms, cites its sources, and says when its local copy may be stale.
It distinguishes a proposed change, a locally saved change and cloud delivery.
No Obsidian desktop app, Mac relay, PA core, or plugin inside Obsidian is required.

The first iteration is **one selected vault, with reading and editing**. The
owner chooses read-only or read-and-edit access and may narrow writable folders
within readable scope. Read-only remains a supported mode, not the release's
capability ceiling. Enabling iCloud sync grants neither note access nor edit
permission. This feature request changes the plan; it is not permission to edit
a personal vault during development.

## Boundaries and prerequisites

- **iCloud** owns Apple authentication, folder selection, two-way sync, conflicts,
  backups and recovery. This iteration consumes it; it does not duplicate it.
- **Obsidian** owns vault selection, permitted note scope, parsing, search, link
  resolution, task discovery, source attribution, edit proposals and its note
  tools. iCloud provides the coordinated local-file commit boundary described
  below; it does not interpret Markdown or decide which edits the owner wants.
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

The settings flow explains what BB may read and change, and that local edits
will be sent to iCloud by the existing two-way sync. Offer read-only or
read-and-edit access, with literal vault-relative included/excluded folders and
writable folders restricted to readable scope. Selecting the entire vault is
explicit; no content is scanned before selection and scope are saved. Persist
the mirror ID, access mode and scopes, not a host path or Apple credentials.

Exclude hidden files/directories, including `.obsidian`, `.git` and `.trash`;
reject symlinks rather than following them. Read regular `.md` files only. Custom
configuration folders can be excluded explicitly. Images, PDFs, plugin code,
Canvas and Bases content are not readable note content in this slice.

Changing scope invalidates cached results and pending edit proposals immediately.
Switching to read-only revokes writes without losing read access. Forgetting the
vault revokes plugin access and clears cached content without deleting notes,
pausing iCloud, disconnecting Apple or changing any other plugin. Recheck current
access at commit time; an old proposal or approval never restores revoked access.

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

### Make targeted changes

Include creation of a Markdown note in an existing permitted folder, append-only
additions, bounded exact-text edits, task-checkbox changes and structured property
updates. Preserve untouched YAML, comments, spacing, links, block identifiers and
LF/CRLF line endings instead of reserializing a whole note. A task change targets
its verified source location and original marker/text, not the first matching
checkbox in the vault. Dedicated daily-note path/template automation is later;
an explicitly identified daily note can be read and edited like any other note.

Read the complete current note within the file-size budget before preparing an
edit; content-read results include a version hash suitable for this check. Bind the proposed change to its content hash, selected mirror ID, relative
path, scope revision and a server-generated operation ID. Require every exact
replacement to match uniquely and reject overlapping edits. Never base a whole
note replacement on a truncated read, and never silently discard constructs the
parser does not understand. If a target is ambiguous, ask which note/task the
owner means rather than making a guess.

Produce a server-computed before/after diff and plain-language summary of the
actual change. Follow the repository consent policy: edit permission determines
capability; an explicit user request supplies intent. Do not add an unconditional
second approval popup merely because editing is enabled. Where the exact change
has not already been authorized, or BB requires approval, use an enforceable BB
interaction bound to that proposal. Calendar's `bb.ui.requestInput` is an existing
mechanism to investigate, not proof of Obsidian approval behaviour in every
provider. A model-supplied `approved=true` or note content is never authorization.
Record and test how prior consent is verified; if BB cannot establish it, present
the exact proposal for owner approval before committing rather than trusting a
prompt. Missing UI, cancellation, expiry or decline saves nothing.

After any approval delay, recheck permission, source availability and the whole
note hash inside the coordinated commit. If the note changed, refuse to overwrite
it: reread, show the new proposal and obtain any required renewed authorization.
Do not silently merge, retry an append or reuse approval for changed bytes.
Creation must refuse an existing destination rather than replace it.

Before replacing an existing note, retain a durable recovery copy outside the
synced vault. Define protected storage and explicit retention/capacity bounds
before implementing commits; fail before modifying the note if safe recovery
cannot be retained. Recovery copies are private content, not logs or tool output.
Document how to recover a previous version without overwriting newer edits;
restoration must obey the same compare-and-save and consent rules. Do not rely
only on the next scheduled iCloud backup to preserve a pre-edit version.

Return an operation receipt containing the source path, old/new content hashes,
local save time and a summary of the actual change. A locally committed edit is
reported as **saved locally, pending iCloud sync**, not delivered to the phone.
A later successful run is evidence that sync ran, not alone proof that these
exact bytes reached the phone. Claim delivery only with verified content-specific
cloud evidence; otherwise keep that limit visible. Remote edits can still
conflict, and iCloud's conflict preservation remains the recovery mechanism.

Use durable operation receipts to inspect duplicate requests and uncertain
outcomes. Expose the operation ID before committing where the host interaction
allows it, and bind retries to the persisted proposal/tool invocation rather
than generating a new ID for every transport retry. Provide a bounded recent
receipt lookup under current note scope so a lost response can be inspected.
Repeating an operation ID must not append twice or create twice. If a
crash/disconnect occurs around commit, report an uncertain outcome and inspect
recorded hashes/state; do not blindly retry. Invalidate the note index and old
cursors after a confirmed save. A request spanning two notes is two separately
reported edits, not an atomic whole-vault transaction.

### Treat properties as structured data

Add `obsidian_get_note_metadata` for a compact view of properties, aliases, tags,
headings, blocks and outgoing links without returning the entire body. Include
source locations, note version and parse/completeness warnings; do not substitute
an empty property object for malformed YAML. File metadata and parsed frontmatter
are separate fields, not invented properties written into the header.

Add `obsidian_update_properties` with bounded `set` and `remove` operations on
explicit top-level property names. Examples: set `status` to `active`, replace the
`tags` list, add an alias, or remove a specific property. A missing frontmatter
header may be created without changing the body. Preserve unrelated keys and
comments; never interpret a set operation as replacing the whole property map.

Support documented scalar/list values; preserve date/date-time strings rather
than inventing timezone conversions. Validate reserved `tags`/`aliases` shapes
and quote link-valued strings safely. Do not infer vault-wide property types from
private `.obsidian` configuration. Reject duplicate/ambiguous YAML keys, custom
executable tags, unsupported structural mutations and unsafe expansion limits.
Malformed headers cannot be silently replaced with an empty one. General text
edits touching frontmatter must not bypass these validation/safety checks; a
requested repair needs an explicit preview and validated result.

Use a source-preserving YAML document/tree approach and verify unchanged bytes
outside the edited property spans. If the chosen library cannot preserve a
particular construct safely, return an unsupported-edit explanation rather than
normalizing the entire note. These are stronger formatting requirements than
Obsidian's object-based API promises; prove them with adapter fixtures.

Property updates use the same complete-note version check, proposal/diff,
consent, scope, recovery, coordinated commit and operation receipt as body edits.
A metadata read followed by a property update is not permission to overwrite a
body edit that happened in between.

### Align with Obsidian's SDK concepts, not its runtime

Use official APIs as a semantic guide, not a one-to-one tool catalogue. BB inputs
are bounded data, never arbitrary functions, and the official npm declarations
still provide no runtime implementations outside Obsidian.

| BB operation | Closest official Obsidian API | Deliberate difference |
| --- | --- | --- |
| Read a note | `Vault.read` / `Vault.cachedRead` | Always enforce selected scope, local version and mirror provenance; do not blindly trust cached content. |
| Read metadata | `MetadataCache.getFileCache` and `CachedMetadata` | Parse our permitted local copy, not Obsidian's app cache; document the supported fields/subset. |
| Resolve a link or section | `parseLinktext`, `MetadataCache.getFirstLinkpathDest`, `resolveSubpath` | Return ambiguous or excluded targets safely; do not claim full app tie-breaking parity. |
| Create a note | `Vault.create` | Refuse overwrite and require authorized scope plus coordinated sync-safe persistence. |
| Targeted body/task edit | `Vault.process` | Bounded patch against an expected content hash, not an agent-supplied callback; explicit recovery and operation receipts. |
| Set/remove properties | `FileManager.processFrontMatter` | Structured operations instead of a JS callback, with source-preserving YAML edits and whole-note conflict checks. |
| Search notes / list tasks | Metadata extraction plus search over vault files | Useful BB-level queries, not a claim that the SDK has identical standalone methods. |

The relevant [properties mutation contract](../../plugins/obsidian/docs/reference/developer/en/Reference/TypeScript%20API/FileManager/processFrontMatter.md)
explicitly describes atomic frontmatter read/modify/save and YAML parse failure.
The [metadata contract](../../plugins/obsidian/docs/reference/developer/en/Reference/TypeScript%20API/CachedMetadata.md)
separates frontmatter, frontmatter links, headings, blocks, links, embeds, tags
and list items. Keep similar distinctions in our parser and result shapes.
`FileManager.generateMarkdownLink` is a useful reference when generating links,
but reproducing all app link preferences and `renameFile` cross-note rewrites
remains outside this iteration.

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

### Coordinate writes with syncing

Status polling is not sufficient for writes. Add a narrow, verified
server-to-server conditional file-commit boundary owned by iCloud, using the same
exclusive coordination as its scheduled runs, pause/recovery and disposal.
Obsidian computes and authorizes the patch; iCloud resolves the mirror root and
commits bounded file bytes without learning Markdown semantics. Never acquire a
long-lived sync lock while waiting for human approval, or simulate one with
separate Pause/Resume calls that might alter the owner's chosen sync state.

The spike must establish the exact port/RPC and crash behaviour before tools are
enabled. Restrict commit callers to the host-verified Obsidian plugin; direct
browser/CLI/agent and unrelated-plugin calls are denied. Obsidian rechecks its
write scope and proposal authorization, and the commit boundary independently
validates mirror identity, relative path, regular-file/no-symlink containment,
expected content hash and create-versus-edit semantics. Serialization must cover
all Obsidian commits and iCloud filesystem modification, not just each plugin's
own mutex. Also serialize Obsidian scope/access revocation with commit admission:
when revocation is acknowledged, no previously queued proposal may still gain
permission to write. Recheck authorization within this bounded transaction, not
only before an asynchronous cross-plugin call. Do not hold either guard while
waiting for human input. This coordinates these participating writers; it is not an OS-wide
lock against unrelated trusted code bypassing the boundary.

First-release writes require a connected, available, initialized, enabled mirror
in `ready` state. Paused/disconnected copies remain readable under the policy
above but are not editable; busy/failed/retained/missing mirrors refuse commits
with a specific next step. A busy result before commit can be retried only after
revalidation; an uncertain result after commit requires inspection, not replay.
No forced resync or provider-recovery action is part of an edit.

Stage replacements outside the synced mirror on the same filesystem, persist
the recovery copy and operation state, then use an atomic replacement with
verified permissions. Define crash reconciliation before the next sync so partial
notes and staging files are never uploaded. Preserve the owner-visible note name
and original line endings. Prove exclusive creation without overwriting an
existing destination and safe behaviour on disk-full, permission errors,
cancellation, plugin disposal and restart. A successful local commit followed by
sync failure is still a saved edit with failed/pending delivery, not a failed edit
to repeat. The existing read-only `inventory`/`status` RPCs do not already provide
this safety boundary; it is explicit additional work in this iteration. Verify
its installed compatibility/capability explicitly. An older iCloud plugin may
support reading while editing reports “Safe editing needs an iCloud plugin
update. Open iCloud's plugin details in BB.” Never fall back to uncoordinated
filesystem writes when that boundary is missing.

## Implementation shape

Use a TypeScript hexagonal core, cucumber-js acceptance scenarios and fake ports,
following the existing plugins rather than introducing a shared integration
framework.

- **MirrorCatalog port:** verified plugin availability, iCloud setup state,
  inventory and current source state. Production adapter uses the host plugin
  list and read-only iCloud RPCs; fake models each onboarding state, disappearance,
  replacement and sync transitions.
- **VaultFiles port:** bounded enumeration, stable scoped regular-file reads and
  conditional create/edit operations through the coordinated iCloud boundary.
  Validate root/scope and reject traversal, absolute paths and symlink components.
  Fake ports model conflicts, capacity failures and uncertain saves; real adapter
  tests prove coordination, atomic persistence and recovery.
- **NoteParser port:** original text plus properties, aliases, tags, headings,
  blocks, links and tasks with source locations and parse warnings; construct
  source-preserving property edits without executing arbitrary callbacks.
- **StateRepository port:** selected mirror ID, readable/writable scope, access
  mode, configuration revision and private edit proposals/operation receipts.
- **Approval port:** exact server-owned proposal authorization using verified
  prior consent or BB interaction; fake covers approval, decline and expiry.
- **BB adapters:** client-only access/scope/revocation RPC, note tools, approval
  interaction, persistent configuration, shared connection UI and disposal hooks.

Evaluate a CommonMark/GFM-capable Markdown parser and a maintained YAML library
against the fixtures; add only the Obsidian-specific tokenization and resolution
we need. The official `obsidian` npm package is declarations, not this runtime.
Record the parser choice and compatibility limits before building the tools.

Start with an on-demand in-memory index, not embeddings or a database containing
another persistent copy of the vault. Bounded per-edit recovery copies and private
proposal/operation state are separate safety records, not a search database.
Revalidate files and inventory before use; clear caches on scope/selection changes
and disposal. Derived content stays out
of synced folders. Centralize and test note-byte, scan-count/byte/time, result,
output and parser-depth budgets. Record concrete ceilings in the plugin README;
any budget exhaustion produces an explicit incomplete/truncated outcome.

Proposed tool surface, subject to final schemas in the acceptance tests:

| Tool | Purpose |
| --- | --- |
| `obsidian_status` | Selected vault, read/edit scopes, source state and warnings; optionally inspect a known operation or bounded recent note receipts under current authorization. No host paths. |
| `obsidian_search_notes` | Literal text/tag search with bounded snippets and pagination. |
| `obsidian_read_note` | Read an explicit permitted relative note path or resolved heading/block, with citations and a whole-note version hash. |
| `obsidian_get_note_metadata` | Read compact properties and supported structural metadata, with source locations, version and parse warnings, without returning the entire body. |
| `obsidian_resolve_link` | Resolve a link in the context of an explicit source note; report missing, ambiguous and unsupported targets. |
| `obsidian_list_tasks` | List source-owned checkboxes by completion state and optional permitted folder/note. |
| `obsidian_create_note` | Create a new permitted Markdown note without replacing an existing file, with authorized content and an operation receipt. |
| `obsidian_edit_note` | Append or apply bounded exact-text/task-marker changes against a complete note version, using the shared consent and coordinated commit path. |
| `obsidian_update_properties` | Set/remove named top-level properties without replacing unrelated metadata or body text; use the same authorized conditional commit path. |

Tool inputs never accept arbitrary host paths. Configuration changes are not
agent tools. Agent guidance treats note names, properties and content as
untrusted evidence, not instructions, and requires citations, disclosure of
incomplete reads and truthful saved-versus-proposed/delivered status. Write tools
are offered only within authorized edit capability; changing to read-only removes
that capability while retaining read tools. No personal layout or policy is
bundled. Operation inspection also obeys current scope, without leaking receipts
for forgotten/excluded notes.

## Settings experience

Use BB's existing plugin settings host and shared connection components. Existing
rendered iCloud views confirm that BB already supplies the plugin name and
Configuration section; do not repeat them. Reuse its layout, not Apple login or
multi-account assumptions: this plugin has one selected vault and no login form.

### Guided first run

Explain once: “Obsidian uses a local copy of your vault supplied by iCloud.
Set up iCloud first, then choose which notes BB can read and edit. Saved edits
will be sent back through iCloud.” Show the sequence:

1. Install/enable iCloud and connect Apple in **BB's iCloud settings**.
2. Select the vault folder there, enable sync and wait for its first successful
   sync. Merely choosing a folder does not start syncing.
3. Return to **Obsidian settings**, select that vault and choose read-only or
   read-and-edit access with permitted folders.

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
| Eligible mirror exists, no Obsidian selection | “Choose the synced vault BB may read and, if you allow it, edit.” | Select vault, access mode and scopes, then explicitly save authorization. |
| Saved mirror ID is absent or retained/replaced | “The selected vault is no longer available for normal reads. Review it in iCloud, then choose a vault again.” | Open iCloud; preserve the previous selection without silently granting access to a replacement. |

For previously authorized mirrors, retain the freshness policy above: paused or
Apple-disconnected copies with a successful baseline can be read with a visible
stale-copy warning; running sync produces a busy response; failed/retained copies
require recovery. Do not force an otherwise permitted stale read through first-run
onboarding merely because Apple is disconnected. Conversely, a folder with no
successful baseline must never be presented as a stale-but-readable vault.

An edit refused because access is read-only says “Editing is not enabled for this
note. Review its writable scope in Obsidian settings.” A paused/disconnected
source says “This local copy can be read, but editing needs working, enabled
iCloud sync. Open iCloud settings to resume or reconnect.” A busy source says
“iCloud is syncing this vault. No edit has been saved; try again after it finishes”
only when refusal happened before commit. Conflicts say “This note changed since
it was read. No edit was saved; reread it before proposing a new change.” Unknown
post-commit outcomes instead say to inspect the operation; never claim no save
when it may already have happened. These distinctions apply in chat and settings.

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
After setup, lead with the vault, read/edit scope and last successful sync; keep
the setup checklist behind a quiet guide. Distinguish an empty permitted vault
from an incomplete or failed scan. Make switching to read-only and revoking
access straightforward without changing iCloud's sync state.

### Agent-facing errors

`obsidian_status` exposes the same bounded setup code and useful next step.
Blocked note tools return an error result with that code and explanation,
never `[]`, “vault empty”, a raw RPC exception or a generic “read failed”. For
example: “Obsidian is not ready: the vault's first iCloud sync is still running.
Wait for it to finish in iCloud settings, then choose the vault in Obsidian.”
Keep installation/verification/sync actions in settings, not agent tools. The
assistant must not ask for credentials, recommend a reset for a transient check
failure, or imply it searched notes when setup prevented the search.

Write a complete portable setup guide. Inspect the running host again before
finalizing controls, then review every dependency state above plus configured,
empty, save-error and revoked states at desktop and narrow widths with keyboard
navigation and accessible announcements. Exercise read-only/read-and-edit setup,
exact edit previews, approval where required, decline/cancel/expiry, conflict,
revocation, local-save/pending-sync and uncertain-save states in running BB.
Escape note text in previews; never render it as executable HTML. Tests must
establish that authorization is tied to the shown proposal, not a chat assertion.

## Delivery steps and gates

1. **Prove the handoff.** In an isolated running BB, install iCloud and a minimal
   Obsidian package; prove server-to-server inventory, filesystem readability,
   plugin-list/status/inventory classification, dependency navigation and
   name-based selection using synthetic mirrors. Include empty inventory during
   an active initial sync and a previously successful disconnected copy. Record
   the supported host/SDK versions and race limitations. Do not proceed on the
   strength of SDK types alone. Prove the shared sync/write exclusion, conditional
   commit, permission-revocation race and disposal/restart semantics with synthetic
   notes before enabling mutations; this step may require a narrow iCloud change.
2. **Specify behaviour.** Write Gherkin features for the outcomes below; define
   ports and fixtures before implementation. Compare uncertain syntax/resolution
   cases with a disposable vault in Obsidian. Choose parser libraries and record
   supported cases, unsupported cases and resource budgets. Record the consent
   verification mechanism, per-edit recovery retention/capacity, operation journal
   and crash reconciliation decisions.
3. **Build the note core and adapters.** Implement scope enforcement, parser,
   index invalidation, citations, conditional create/edit/property updates,
   consent/approval, recovery copies, operation receipts and safe diagnostics. Test real temporary
   filesystem trees and stock-rclone concurrency as well as fake ports.
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
   read-only call against an explicitly authorized disposable vault. Test local
   edits and sync round trips on synthetic/disposable data; any live cloud or
   phone mutation needs specific approval for the test, not this feature request.
   Record exactly which local-save, approval and cloud/phone-delivery gates passed
   or remain unverified, then seek feedback in running BB.

Documentation-only planning requires no plugin deployment. Implementation must
not access a personal vault merely to close a test gate. If live Apple/iCloud
access is unavailable, synthetic host/UX checks can proceed, but the actual
synced-vault end-to-end gate remains unverified.

## Acceptance coverage

| Area | Executable examples |
| --- | --- |
| Authorization | No content before explicit selection/scope; read-only and read-and-edit capability persist over restart; write scope is a subset of read scope; revocation invalidates cached results, cursors and proposals and cannot race a queued commit. |
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
| Read-only | Read-only mode rejects every mutation; reads create no vault files, execute no note code and never enable sync. Hash fixture vaults before/after reads. |
| Targeted edits | Only intended bytes change on create/append/replace/task/property edits; duplicate or overlapping targets fail; YAML comments, unknown idioms, links, block IDs and LF/CRLF are preserved; no edits from truncated reads. |
| Properties/metadata | Compact metadata reads match the documented subset and expose parse failure; named sets/removals preserve untouched header/body bytes; absent headers, lists, quoted links and date strings are handled deliberately; malformed/duplicate/unsupported YAML is never silently rewritten. Body changes since metadata read invalidate the entire property update. |
| Consent | Verified requested edits use the established policy, not a blanket extra gate; where approval is required it is bound to exact server-owned path/version/diff. Decline, cancellation, missing UI, expiry and forged approval save nothing. |
| Version conflicts | A change while proposing/approving refuses the old edit; file creation never replaces an existing note; a changed proposal cannot inherit stale authorization. |
| Write coordination | Busy/paused/disconnected/failed/retained/missing source blocks commits; absent/incompatible commit capability has an update action, not an unsafe fallback. Real rclone/commit races never overwrite newer local bytes or upload staging/partial files. |
| Durable safety | Pre-edit recovery capacity is checked before changes; disk-full, process crash, disposal/restart and symlink swaps have inspected outcomes. Partial multi-note success is reported per note. |
| Idempotency | Repeating one operation ID cannot double-create/append; reconnect/restart can inspect receipts; an unknown commit outcome is never blindly retried. |
| Delivery | Proposed, declined, conflict, saved-local/pending-sync and sync-failed-after-save outcomes are distinct. Sync timestamps alone cannot prove exact edit delivery to the phone. |
| Diagnostics | Fixed `Obsidian <stage> <category>` messages at handled failures; sentinels in paths, note bodies, parser exceptions, RPC responses and causes never leak to logs/errors. |
| Host lifecycle | Installation alone grants no note access; fresh sessions discover tools; disable/remove stops exposure without changing iCloud, notes or other integrations. |
| UI | Rendered dependency/onboarding matrix, read/edit access controls, exact proposals/required approval, conflict, decline/expiry, saved-local/pending-sync and uncertain-save states at desktop/narrow widths; working navigation, focus and safe accessible messages. |

## Deliberately later

Renames/deletes and cross-note link rewrites; dedicated daily-note location,
date/template automation; bulk editing or whole-vault transactions; multiple
vaults; other sync sources; attachment extraction; embeddings; recursive
transclusion; Dataview, Tasks and other community-plugin execution; Canvas/Bases
evaluation; a full Obsidian search-language clone or exact app-wide resolution
parity. Daily notes and templates can be read/edited as explicit Markdown notes,
but their configuration and scripts are not executed.

## Release evidence

Record parser decisions and compatibility checks, concrete resource limits,
build/typecheck/test results, installed versions/commit, consent verification,
coordinated commit/recovery evidence, safe failure diagnostics, rendered UX
observations, scoped live reads, specifically authorized disposable edit tests
and sync-delivery evidence here. Until those gates pass, this is a plan, not
delivered Obsidian support.
