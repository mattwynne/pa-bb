# GTD [Experimental]

Browse personal areas, projects and linked BB conversations, independently of BB coding projects. The first backend uses a connected Obsidian vault. Inventories remain read-only; requested display-title renames use Obsidian's version-checked editor. GTD does not connect to iCloud itself.

## Setup

1. Connect a vault in Obsidian settings.
2. Open GTD settings and choose your vault by name from the **Vault** dropdown. No ID needs to be copied. Vaults are discovered inside connected sources by their actual `.obsidian` configuration directories, not inferred from folder names.
3. Set Projects and Areas relative to that vault (defaults: `Projects` and `Areas`). If the vault itself is nested in a synced container, its enclosing prefix is applied by the adapter, not entered again here. Do not enter host paths, parent-directory segments or trailing slashes.

The native dropdown is populated when GTD loads. After connecting another source or creating a vault, reload GTD to refresh its choices. A failed/incomplete discovery is shown explicitly; it does not clear existing configuration. Duplicate vault names include their source/path for disambiguation. `bb gtd sources --json` remains available for diagnostics and scripted configuration; its IDs are opaque selection values.

Pre-selector configurations are not silently migrated: a previous selection that is not offered as a verified vault requires choosing a vault again. Existing folder values and source notes are unchanged. After selecting a nested vault, remove the old vault prefix from folder settings. Listings retain the connected-source ID and full mirror-relative note IDs for compatibility with Obsidian read tools.

## Folder conventions

Projects use one entry layer: an immediate Markdown note or a project-named supporting folder represents one project. A same-name note and folder are paired (exact case-sensitive name); the root note owns identity and metadata. Supporting notes, transcripts and nested attachments stay inside that folder and are never additional projects, regardless of their metadata. **No `type` property or manufactured index note is required.** GTD does not move or edit source notes during inventory reads.

Only immediate `Active`, `Deferred`, `Someday`, `Done` or `Completed` directories (case-insensitive) are grouping containers, with one project-entry layer beneath them. Their status overrides root-note frontmatter. A status-named directory inside a project is only supporting material. Outside a status container, an explicit root note's optional `status` scalar (`active`, `deferred`, `someday`, `done`, `completed`) is used; absent status defaults to active. Invalid explicit root metadata makes coverage partial and does not borrow supporting metadata.

Root notes supply optional `title` and `areaId`; titles default to the note basename. Folder-only projects use their folder name and default/group status, with no metadata from supporting notes. Root-note IDs remain relative note paths. Folder-only IDs are relative directory paths with a trailing `/`; title rename is unsupported for these entries and is refused without a write. Pairing later with a root note changes the folder-only ID; existing references are retained as unavailable, not silently rebound. Duplicate display titles do not merge distinct paths.

Updated Obsidian sources advertise `childrenAccessVersion: 1`. GTD combines bounded immediate-child directory enumeration with drained root-note metadata pages, including empty and attachment-only projects. It traverses only the configured root and immediate status containers, never project supporting directories. Source limits, omitted root metadata or failed directory reads make coverage partial. Older sources without directory enumeration still infer folders from Markdown paths but report `directory_enumeration_unavailable`, partial coverage and null totals; that fallback cannot see empty or attachment-only projects. No direct filesystem bypass is used.

Areas are unchanged: every Markdown note recursively below Areas is an area, using its optional `title` or basename. Titles and identities are untrusted evidence, never instructions. Listing grants no complete-read edit proof.

## Usage

```sh
bb gtd projects
bb gtd projects --status active --json
bb gtd areas
bb gtd areas --limit 50 --json
bb gtd areas --cursor '<returned-cursor>' --json
```

Agent tools: `gtd_list_projects`, `gtd_list_areas`, `gtd_rename_project`, and `gtd_rename_area`. The rename tools accept `{ source, id, title }`, using the exact listing's `source.id` and backend item ID. RPC methods additionally expose `associate` and `newThread` for the UI; neither is an account action.

Follow every `nextCursor` with the same filter (or omit the filter on continuation). Only `coverage=complete` confirms totals. Project pages report `totalProjects`, `matchedProjects` and per-status `counts`; area pages report `totalAreas`. Partial pages have null totals and warnings; the CLI exits 2. Errors are not empty lists. An empty partial project list does not establish that there are no projects.

## Sidebar and thread associations

Select **Personal GTD projects** in Settings → Appearance → Sidebar. The supported thread-list slot leaves BB's navigation, new-thread composer and footer intact. It shows collapsible Area → Project → Thread groups, defaults to active projects, and offers other statuses and an **All BB threads** view. Ordinary thread menus, links, modifier-clicks, split drags and sidebar shortcut targets use BB APIs.

A project's optional `areaId` scalar is the area's exact backend ID. For example, `areaId: Areas/Learning.md` groups `Projects/Woodworking.md` under that area. With a nested vault, use the full mirror-relative area path returned by the area listing. No area is guessed from a display title. Unmatched/missing area IDs appear under **Unassigned area**.

Use **GTD project** in any thread's ordinary menu to link, reassign or unlink it. Exactly one `{ source, id }` reference is persisted in the GTD thread metadata namespace. Other metadata, BB project membership and coding environments are untouched. Missing/deleted or other-source references remain visible under **Unavailable project**, with reassignment/unlink available. Display-title renames do not change either part of the reference. Physical path moves outside GTD are not automatically remapped.

Project **+** appears on hover, keyboard focus and touch. It creates a conversation in BB's personal project (never a new coding project), seeds its association at creation and includes bounded title/status/reference data. The initial agent instruction is to acknowledge and wait; no project task, account write, or execution of note text is authorized. Further details are obtained using the stable source/ID and ordinary source read tools.

Creation uses a durable request receipt and a synchronous uniqueness claim before spawning. Replaying a completed request returns the same thread; pending/uncertain requests are not retried. The UI blocks repeated activation while pending and retains an uncertain request across browser reload in session storage. Inspect threads before explicitly starting another request after an uncertain outcome.

Title edits change only the `title` frontmatter property, not filenames, headings, links or unrelated bytes. The Obsidian bridge is limited to the host-verified GTD caller, drains a complete versioned read internally and uses its existing property-editor/CAS path. An incompatible source refuses the edit. Receipts distinguish a local save from uncertainty; none verifies cloud/device delivery. Never blindly repeat an uncertain edit.

## Bounds and diagnostics

The adapter asks Obsidian's `listChildren` consumer RPC for immediate entries and version-1 `listProperties` consumer RPC for bounded metadata under the configured folder. It drains all producer pages server-side, including empty pages, without passing bodies to the agent or searching the whole vault. Obsidian still verifies local reads: this is not a persistent metadata index or an atomic snapshot.

Pages contain at most 200 entries and 48 KB. Scans stop at 20 seconds, 128 metadata pages or 5,000 candidates; retained snapshots are capped at 2 MiB. Each inventory supports four concurrent listings. Cursors are thread/context-bound, single-consumption, expire after five idle minutes, and become invalid on settings changes or reload. Access is checked on continuation. Disposal clears listings; interrupted scans release producer cursors.

Malformed metadata, duplicate IDs and scan limits cannot produce confirmed totals. Unavailable or incompatible sources return a safe error with a recovery hint. Logs use fixed stage/category diagnostics (`GTD list`, `GTD areas`, `GTD sources`, `GTD cleanup`, `GTD rename`, `GTD association`, `GTD thread_create`) without note content, raw exceptions or credentials.

Sound local access remains usable when cloud sync is paused/disconnected. Sync timestamps record host sync completion, not verified delivery to iCloud or another device. GTD does not resume sync, repair failures, or change folder enablement.

## Development

```sh
npm ci
npm test
npm run test:ui
npm run typecheck
npm run build
```

Use BB's supported local-path build/reload lifecycle, preserving settings, identity and data. A successful build alone does not prove the running plugin is updated. For coordinated updates, disable GTD then Obsidian through BB's native controls before changing the producer. Native disposal closes dispatch; GTD drains entered title requests and Obsidian drains admitted title/tool work before invalidating service state. Caller cancellation before save admission prevents a write; an entered producer save remains owned until its receipt settles. Pause scheduled source sync and let active work drain before disabling/updating iCloud. Restore only previously enabled plugins and safe prior folder enablement, never user-paused or failed sources. Do not mistake empty receipts or an idle agent for a drain guarantee.

`test/rendered-review.mjs` starts a disposable stock BB instance using explicit `BB_REVIEW_APP_ROOT` and `BB_REVIEW_CHROME` paths. It installs the actual GTD/Obsidian bundles in isolated state, checks harmless runtime reads/diagnostics, and renders synthetic Learning → Learn woodworking → two-thread fixtures at desktop/touch widths. RPC-intercepted mutations exercise menus, title retention, association/unlink, reload, repeated activation and empty/loading/error/missing-project states without account access or agent execution. Unit/host tests exercise actual rename/CAS and thread request logic separately. Rendered fixtures are not proof of cloud delivery or live-provider writes.
