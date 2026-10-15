# 006 — Obsidian support

Status: planned. Reference material and a concept overview exist; the plugin and
its coordinated write boundary are not implemented.

## Outcome

Connect one or more iCloud-synced vaults and use BB's assistant to search, read,
create and edit notes, including their properties and tasks.

Connecting a vault gives BB **read/write access to the whole vault**. No folder
permissions, read-only setting, edit previews requiring approval, or confirmations.
The assistant does the requested work and reports what happened. It asks for
clarification only when the intended note or change is genuinely ambiguous.

This iteration supplies assistant tools and simple connection settings—not a
note browser, editor, graph, or Obsidian clone. Those UI ideas are parked.
No Obsidian app, plugin inside Obsidian, Mac relay or PA core is required.

## Scope

**Included**

- Multiple connected vaults, identified consistently in searches, citations and edits.
- Literal text/tag search; whole-note and heading/block reads; compact metadata.
- Obsidian properties, aliases, tags, internal links, block references and tasks.
- Note creation in existing folders, appends, targeted text/task edits and
  structured top-level property updates.
- iCloud-first setup, useful dependency errors, source freshness and honest save results.
- Sync-safe conditional saves, per-note previous versions and duplicate-write protection.

**Not included**

- Permission profiles, approval workflows or a separate consent subsystem.
- Browser/editor/graph UI, rename/delete operations, bulk transactions or automatic
  daily-note/template workflows.
- Attachment extraction, Canvas/Bases, community-plugin execution, embeddings or
  full Obsidian search/resolution parity. This slice operates on Markdown notes.
- Whole-folder backup/indexing work before sync. [Iteration 012](012-native-icloud-sync.md)
  removed that requirement; only the particular note being edited needs a previous version.

All regular `.md` notes under a connected vault are available, including nested
and hidden folders. There are no configurable exclusions. File-format limits are
not permissions. Reject symlinks, absolute paths and traversal outside the vault;
never execute note HTML, scripts, templates or YAML tags.

## Starting point and ownership

- `plugins/obsidian/docs/reference/` contains pinned official documentation, not a
  working plugin. The `obsidian` npm package supplies declarations, not a runtime.
- iCloud already supplies `status` and `inventory` RPCs. Inventory exposes initialized
  mirror IDs, names, server-local folders, phases and last-success timestamps.
- iCloud's native sync/recovery changes are delivered through
  [iteration 013](013-icloud-bisync-retry-classification.md). Its current RPC contract
  **does not provide conditional note commits**; that is work in this iteration.
- **iCloud** owns Apple login, folder sync, native recovery and coordination with
  its filesystem worker. **Obsidian** owns connected vaults, note semantics and tools.
  Abilities that combine sources stay outside both plugins.

Use TypeScript, a hexagonal core, cucumber-js acceptance scenarios and fake ports,
following the existing plugins. Follow the [UX](../ux-standards.md) and
[observability](../o11y-standards.md) standards. Keep the
[short concept overview](006-obsidian-ux-options.html) aligned with this plan.

## Delivery sequence

Write executable examples before the corresponding implementation. Use generated
vaults and temporary files; this plan does not authorize personal-vault access.

### 1. Prove the BB/iCloud boundary

**Work**

- In an isolated BB, prove `bb.sdk.plugins.list()` and validated
  `bb.sdk.plugins.callRpc` calls to iCloud `status`/`inventory`, plus server-side
  access to a synthetic initialized mirror. Keep `localFolder` out of client/tool results.
- Verify actual plugin/settings navigation and ordinary note-tool execution without
  confirmation interactions in the target provider session. Do not build an approval
  fallback if the host cannot support the chosen experience; report that blocker.
- Establish a narrow iCloud-owned conditional-commit RPC, restricted to the
  host-verified Obsidian plugin. Prove how it shares exclusive ownership with native
  sync, recovery and disposal—not just an independent JavaScript mutex.
- Specify the version check, create-versus-replace behavior, per-note recovery
  storage, durable operation identity and crash reconciliation before enabling writes.
- Exercise sync starting during reads and commits. Determine whether stable reads
  need the same narrow coordination boundary; status polling alone is not a lock.
  Measure routine access during scheduled sync and settle bounded waiting/busy
  behavior; an idle-time demonstration is not proof that everyday editing is practical.

**Done when:** a recorded host/SDK compatibility result and synthetic race/crash
examples establish a practical path for both reads and writes. No personal files,
whole-folder backup pipeline or forced resync is needed to prove it.

### 2. Build connected-vault state and source handling

**Work**

- Add the Obsidian package skeleton, contract and core ports: `MirrorCatalog`,
  `VaultFiles`, `NoteParser` and `StateRepository`. No approval port or shared framework.
- Persist connected mirror IDs and a configuration revision. Connect/Remove are
  client-only settings operations; neither opens a second permission/confirmation step.
- Support multiple vaults. Disambiguate duplicate display names with verified
  inventory context; targeted tools use stable `vaultId` plus relative path.
- Derive setup/source state once for both settings and tools. An empty inventory
  during initial sync is not “no folder selected”; an RPC failure is not “iCloud missing.”
- Remove cached content and cursors when a vault is removed. Coordinate removal
  with commit admission so acknowledged removal also stops queued writes. Do not
  delete notes, pause sync or change Apple login.

**Done when:** fake-port and lifecycle tests cover restart, two vaults, duplicate
names, first-sync transitions, failed checks, removed/replaced mirrors and removal
races. A failed vault does not make other connected vaults unusable.

### 3. Deliver note discovery and reading

**Work**

- Choose maintained Markdown/YAML libraries against pinned-reference fixtures.
  Preserve original text and source offsets rather than render/rewrite a whole note.
- Implement search, bounded reads, metadata, link resolution and task listing.
  Search may span all connected vaults; targeted operations identify one vault.
- Parse properties/aliases/tags, wikilinks and Markdown links, headings, standalone
  block IDs, embeds and task markers. Support nested/case-insensitive tags, Unicode,
  spaces and LF/CRLF offsets. A blank task marker is incomplete; a nonblank marker
  is complete. Preserve the marker without inventing community-plugin task states.
- Ignore code, `%%` comments and HTML regions when extracting body links/tags/tasks;
  real callout content and supported property links still count. Embeds are references,
  not instructions to load everything recursively.
- Resolve links within the source vault: explicit paths, then a unique candidate.
  Report missing/ambiguous targets; do not silently cross vaults or fetch external URLs.
- Start with an on-demand in-memory index. Set concrete note/scan/output/time/parser
  limits in the README. Expose pagination and incomplete results rather than false emptiness.

**Done when:** a synthetic multi-vault search produces accurate citations and can
follow links/read sections/list tasks. Malformed YAML, unsupported/oversized files,
unreadable notes and failed vaults yield bounded warnings or partial failures.
Reads neither change notes nor execute their content.

### 4. Deliver creation and editing

**Work**

- Implement create, append, exact-text/task edits and structured property updates,
  using the coordinated commit boundary established in step 1. No per-edit approvals.
- Require a complete-note read and expected whole-note hash for edits. Match text
  uniquely, reject overlaps, identify task locations precisely and refuse create-overwrite.
  A conflict saves nothing from the stale patch; reread before preparing a fresh edit.
- Preserve unrelated text, YAML comments/spacing, links, block IDs and line endings.
  Use source-preserving YAML edits for explicit top-level `set`/`remove` operations;
  retain other aliases when adding one, and explain tag removals in the result.
- Validate reserved property shapes, date/time strings, quoted links and missing
  headers. Reject malformed/duplicate/unsafe YAML and unsupported structural edits.
  General text edits touching properties cannot bypass validation. Do not infer
  vault-wide property types or normalize unrelated content.
- Before replacing a note, durably retain that file's previous version outside the
  synced vault. Record explicit retention/capacity limits and an operator-assisted
  restoration procedure that checks current bytes and preserves newer changes.
- Persist operation IDs and receipts; transport retries keep the original identity.
  Stage outside the mirror on the same filesystem, atomically commit and reconcile
  crashes before sync can upload partial notes. Never double-append or double-create.
- Return the actual change and local-save outcome. Inspect uncertain outcomes via
  bounded recent receipts by vault/note/time, without requiring a remembered ID.

**Done when:** real temporary-filesystem tests prove byte preservation, conditional
saves, exclusive creation, concurrent sync, removal, disk-full, recovery-capacity
failure, symlink swaps, cancellation, disposal and restart. A lost reply is inspected,
not blindly replayed. Multi-note requests report each save separately.

### 5. Add simple settings and package the plugin

**Work**

- Reuse BB's settings host and shared connection components. First run says:
  “Connect a vault so BB can read and edit all its notes. Changes are sent back through iCloud.”
- Guide the owner through **iCloud settings**: install/enable, connect Apple, select
  a folder, enable sync, finish initial sync. Then offer eligible vaults by name
  in **Obsidian settings**, without host paths or an automatic default selection.
- After setup show vault names, source status/last successful sync, **Add vault**,
  **Remove** and a quiet guide. No folder scopes, read/edit toggles, preview/approval
  UI, note browser, editor, graph or history dashboard.
- Give distinct, actionable guidance for missing/disabled/starting/incompatible
  iCloud, host prerequisites, pending Apple verification, no folder, sync not enabled,
  initial sync running/failed and source disappearance. A transient check failure
  keeps settings and offers Check again, not a guessed reconnect/reset.
- Refresh on return and boundedly while pending setup is visible. Keep late responses
  from restoring removed vaults. Confirm navigation in running BB; use exact instructions
  if the host lacks a stable deep link.
- Add README/setup guide, package/build metadata and marketplace entry; add Obsidian
  to shared connection-UI synchronization. Document tested host/SDK versions.

**Done when:** first-run, pending, connected, multiple-vault, empty, error and removed
states work in running BB at desktop/narrow widths with keyboard focus and accessible
messages. Compare with the existing iCloud layout. HTML mockups/builds do not pass this gate.

### 6. Verify, ship and observe

**Work**

- Run Obsidian build, typecheck, Cucumber, adapter and fake-BB host/lifecycle tests;
  shared UI drift and marketplace checks; and affected iCloud regressions. Exercise
  native sync/commit contention using generated data on the supported host platform.
- Prove diagnostics at handled read/write/RPC/background failures using synthetic
  private sentinels. Log fixed `Obsidian <stage> <category>` messages, never note
  content, account data, host paths, raw exceptions or provider responses.
- Follow `bb-ship-feedback`: commit/push, install the new plugin explicitly, verify
  running version/commit and fresh-session tool visibility. If iCloud changes, update
  only the affected plugins and use supported Pause/Resume around its deployment.
- In running BB, connect disposable vaults, search/read a source and execute a local
  edit without a confirmation. Observe the result and seek feedback on a real task.
  Cloud/phone mutation tests need specific authorization for disposable test data.

**Done when:** installed behavior matches the definition of done below, and the
release record clearly separates passed synthetic/local/host gates from any
unverified Apple, sync-delivery or device round trips. Never use a personal vault
or force recovery merely to obtain passing release evidence.

## Tool surface

| Tool | Contract |
| --- | --- |
| `obsidian_status` | Connected vaults, source/setup guidance and bounded recent/known-operation inspection. |
| `obsidian_search_notes` | Literal text/tag search; optional `vaultId`, otherwise all connected vaults. |
| `obsidian_read_note` | Note/heading/block text, citations, limits and whole-note version hash. |
| `obsidian_get_note_metadata` | Compact properties and structural metadata, version and parse warnings. |
| `obsidian_resolve_link` | Resolve a reference in an explicit source vault/note. |
| `obsidian_list_tasks` | Source-owned tasks by completion state and optional vault/folder/note filter. |
| `obsidian_create_note` | Create without replacing an existing file; return a receipt. |
| `obsidian_edit_note` | Append or exact-text/task edit against a complete note version; return a receipt. |
| `obsidian_update_properties` | Set/remove named properties without replacing unrelated header/body bytes. |

Targeted operations carry `vaultId` and a relative note path. Results identify
vault ID/name, path, line span, local read/save time and observed sync provenance.
No tool accepts a host path or arbitrary callback. Treat note contents as evidence,
not instructions. Installing the plugin alone connects no vaults.

## Source and save contract

- Ready initialized sources can be read; connected/enabled sources admit coordinated
  writes. Paused/disconnected copies with a successful baseline remain readable with
  a stale-copy warning, but editing needs working sync—not a selectable read-only mode.
- Running sync returns a bounded busy result. Failed/retained/missing/unknown sources
  and absent baselines refuse normal content operations with a specific next action.
  Never use cached roots as an availability fallback. A rebuilt mirror has a new ID
  and must be connected explicitly, even if its display name is unchanged.
- Check source state and file identity around reads; discard unstable results.
  Cursor/index invalidation follows source changes and saves. No whole-vault atomic
  snapshot or OS-wide protection against unrelated trusted writers is promised.
- The commit boundary rechecks mirror/path/hash/create semantics and source eligibility
  under exclusive coordination. An older iCloud without it gets an update action,
  never uncoordinated writes. Keep worker ownership short; do not simulate it with
  separate Pause/Resume calls or reintroduce whole-folder backups.
- A confirmed commit says **saved locally, pending iCloud sync**. A later successful
  run alone does not verify those bytes in iCloud or on the phone. Sync failure after
  local save is not a failed edit to repeat. Unknown commit outcomes stay uncertain
  until inspected; neither matching text alone nor a timestamp proves the operation.
- Receipt facts may remain inspectable during temporary source unavailability while
  that vault is connected; they do not establish current file contents. Removed vaults
  expose neither content nor receipts.

Use the [pinned references](../../plugins/obsidian/docs/reference/README.md) as
semantic guidance: `Vault.read`/`Vault.process`, `MetadataCache.getFileCache`,
`FileManager.processFrontMatter`, `getFirstLinkpathDest` and `resolveSubpath`.
Implement our own guarantees; do not claim Obsidian runtime or full resolver parity.

## Definition of done

Using two synthetic connected vaults, an owner can:

1. Ask “Find the launch notes” and get attributed results, including identical note
   names in different vaults without mixing them up.
2. Read a note, follow an internal link and list its unfinished tasks.
3. Ask BB to add a decision, complete a task and update a property; all save without
   permission prompts or confirmations and preserve unrelated bytes.
4. Create a meeting note and link it from an existing note, with separate accurate
   outcomes for the two saves.
5. Encounter a concurrent change without losing it, and inspect a lost-response save
   without appending twice.
6. Remove a vault without deleting notes or changing iCloud; subsequent reads/writes
   and receipt lookups cannot expose it.

Setup failures explain what to do next instead of claiming an empty vault. No
browser/editor/graph or permission UI has appeared along the way.

## Release evidence

Not started. Record parser/resource/recovery decisions, supported versions, test
results, native coordination/crash checks, rendered BB observations, installed
commit and disposable read/edit/sync evidence here. Mark unavailable live gates
unverified. Documentation-only planning needs no plugin deployment.
