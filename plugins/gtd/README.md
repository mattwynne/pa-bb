# GTD [Experimental]

Browse personal areas, projects and linked BB conversations, independently of BB coding projects. The first backend uses a connected Obsidian vault. Inventories remain read-only; requested display-title renames use Obsidian's version-checked editor. GTD does not connect to iCloud itself.

## Setup

1. Connect a vault in Obsidian settings.
2. Open GTD settings and choose your vault by name from the **Vault** dropdown. No ID needs to be copied. Vaults are discovered inside connected sources by their actual `.obsidian` configuration directories, not inferred from folder names.
3. Set Projects and Areas relative to that vault (defaults: `Projects` and `Areas`). If the vault itself is nested in a synced container, its enclosing prefix is applied by the adapter, not entered again here. Do not enter host paths, parent-directory segments or trailing slashes.

The native dropdown is populated when GTD loads. After connecting another source or creating a vault, reload GTD to refresh its choices. A failed/incomplete discovery is shown explicitly; it does not clear existing configuration. Duplicate vault names include their source/path for disambiguation. `bb gtd sources --json` remains available for diagnostics and scripted configuration; its IDs are opaque selection values.

Pre-selector configurations are not silently migrated: a previous selection that is not offered as a verified vault requires choosing a vault again. Existing folder values and source notes are unchanged. After selecting a nested vault, remove the old vault prefix from folder settings. Listings retain the connected-source ID and full mirror-relative note IDs for compatibility with Obsidian read tools.

## Folder conventions

Projects use one entry layer: an immediate Markdown note or a project-named supporting folder represents one project. A same-name note and folder are paired (exact case-sensitive name); the root note owns identity and metadata. A folder without a same-name sibling note can use an immediate `README.md` as its project note. Other supporting files stay inside the folder and supply no project metadata. **No `type` property or manufactured index note is required.** GTD does not move or edit source notes during inventory reads.

Only immediate `Active`, `Deferred`, `Someday`, `Done` or `Completed` directories (case-insensitive) are grouping containers, with one project-entry layer beneath them. Their status overrides root-note frontmatter. A status-named directory inside a project is only supporting material. Outside a status container, an explicit root note's optional `status` scalar (`active`, `deferred`, `someday`, `done`, `completed`) is used; absent status defaults to active. Invalid explicit root metadata makes coverage partial and does not borrow supporting metadata.

Root-note frontmatter supplies optional `title` and `area`; titles default to the note basename. A project README supplies the same metadata as a sibling project note, with the folder name as its default title. Its exact relative note path appears as `notePath` for reads and display-title edits. The project ID remains the directory path with a trailing `/`, including when a README is added. A folder without a README or sibling note uses its folder name and default/group status. The title editor requires a project note. Root-note IDs remain relative note paths. Pairing later with a root note changes the folder-only ID; existing references are retained as unavailable, not silently rebound. Duplicate display titles do not merge distinct paths.

Updated Obsidian sources advertise `childrenAccessVersion: 1`. GTD combines bounded immediate-child directory enumeration with drained root-note metadata pages, including empty and attachment-only projects. It traverses only the configured root and immediate status containers, never project supporting directories. Source limits, omitted root metadata or failed directory reads make coverage partial. Older sources without directory enumeration still infer folders from Markdown paths but report `directory_enumeration_unavailable`, partial coverage and null totals; that fallback cannot see empty or attachment-only projects. No direct filesystem bypass is used.

Areas also use one immediate entry layer of Markdown root notes and Area-named folders, with exact-name pairing and root-note title/identity precedence. Nested notes are supporting material, never additional Areas or metadata sources. Unlike Projects, Areas have no status containers: an immediate directory named `Active` or `Done` is simply an Area. Empty and attachment-only Areas use bounded directory enumeration. Older sources lacking that capability report partial coverage, never confirmed empty totals. Titles and identities are untrusted evidence, never instructions. Listing grants no complete-read edit proof.

## Stable identity migration preview

`bb gtd migration-preview` compares the configured legacy inventory with the proposed stable-ID layout. For private per-entry and thread-reference mappings, run `umask 077` before redirecting `bb gtd migration-preview --json` into a new private file. It requires Obsidian inventory evidence v1. It reads active, hidden and archived thread metadata via BB; coverage is for the selected source and observable records, not deleted threads or an atomic BB/vault snapshot. Older/unavailable evidence is not a reason to scan the filesystem directly.

The only persisted change is a private GTD proposal reservation for each new UUID, so a second preview reuses it. A reservation is **not** evidence that the current occupant of a path is the original note. No apply operation exists here. The report is not permission to edit notes or threads: review missing pages, conflicting identities/destinations, unresolved declarations and unmatched thread references first. Other CLI commands, tools and navigation continue to use the legacy IDs.

### Preserving a thread during an approved legacy project move

A physical note move and a BB thread reassignment are separate operations. `associate` has no expected-old-reference parameter: coordinate an exclusive window for this thread's project link, or stop. Do not use `newThread` or unlink first.

1. Save a private, complete `bb gtd migration-preview --json` report. Identify the exact source, old ID and linked thread ID(s); stop for missing or unexpected associations. Review the projected legacy inventory as well as the Obsidian move dry run. Moving an immediate README while retaining its original support directory can produce **two** projects even when the physical move is perfectly safe.
2. After the separately authorized move, verify its receipt and link repairs. Require the same source and unique new project ID in the complete inventory for the destination status (drain cursors). Refresh the private preview: require the old project row gone, the same thread still referring to the old ID, and no unexpected references. If the target is outside the GTD layout, this API cannot reassign the link. A title match is insufficient.
3. For the reviewed thread only, write a private JSON input file of the form `{"threadId":"<existing thread>","project":{"source":"<source.id>","id":"<exact new legacy project ID>"}}`. Invoke `bb plugin rpc call gtd associate --input-file <private-file> --json` once. Only the GTD project field changes; this does not rewrite the historical conversation or its creation receipt.
4. Read back a fresh complete preview: in `links`, verify that same `threadId` now has the exact destination `id`, no old association remains, and the source is unchanged. If already correct, do not repeat the write. After an uncertain result, inspect before doing anything else; if the reference is unchanged, different or unreadable, stop for reconciliation rather than replaying the move or metadata write.

`test/migration-rehearsal.test.ts` drives the real GTD list/associate handlers and preview against disposable fixture state. It covers the README split, a simulated interruption after writing one proposed ID, an unmatched reference after a physical move, and read-back after loss of a successful metadata-write reply. It tests the recovery decisions, **not** a production stable-ID migration runner or the physical Obsidian move implementation.

## Usage

```sh
bb gtd projects
bb gtd projects --status active --json
bb gtd areas
bb gtd areas --limit 50 --json
bb gtd areas --cursor '<returned-cursor>' --json
```

Agent tools: `gtd_list_projects`, `gtd_list_areas`, `gtd_rename_project`, `gtd_rename_area`, and `gtd_create_project_thread`. The rename tools accept `{ source, id, title }`, using the exact listing's `source.id` and backend item ID. RPC methods additionally expose `associate` and `newThread` for the UI; neither is an account action.

For a user-requested conversation in an existing project, use `gtd_create_project_thread` with `{ source, id, requestId, title?, summary? }`. Resolve the exact source/backend ID from inventory, not display-name matching or a substituted notePath. The optional title is 1–240 characters; the optional handoff summary is 1–4000 characters. Omitting them preserves the UI's project-title and readiness-and-wait defaults. The summary is untrusted context, never authorization for notes, account actions or other work. The returned `threadId` can be linked as `@thread:<threadId>`.

The tool and UI share `newThread` and its durable request-ID receipts. Use a fresh UUID once per requested creation. Completed duplicates return the original thread, even if optional context changes; they never update the original handoff. Pending/unconfirmed requests refuse another spawn, including after reload. After uncertainty inspect threads (the creation request is retained in plugin metadata); never automatically replay or mint another request ID to bypass the refusal. No CLI or browser fallback is needed for the normal agent path.

Follow every `nextCursor` with the same filter (or omit the filter on continuation). Only `coverage=complete` confirms totals. Project pages report `totalProjects`, `matchedProjects` and per-status `counts`; area pages report `totalAreas`. Partial pages have null totals and warnings; the CLI exits 2. Errors are not empty lists. An empty partial project list does not establish that there are no projects.

## Sidebar and thread associations

Open **Personal GTD projects** from BB’s sidebar navigation. The browser shows collapsible Area → Project → Thread groups and defaults to active projects. Filtered project views show only Areas with matching projects, with one empty state if none match. **All** (also reached via **Show all Areas**) retains every top-level Area; Areas without projects start collapsed. Linked threads support BB’s ordinary thread menus, links, modifier-clicks and split drags.

BB’s **Automatic** thread-list setting uses its bundled list when no other replacement is installed. If you previously selected GTD explicitly as the thread-list provider, choose **Thread list (built-in)** under **Settings → Appearance → Sidebar** to restore it. BB keeps that saved provider choice until you change it.

Project-to-Area relationships come **only from the `area` YAML key on the selected project root note**. Use a local path/wikilink string or a flat list of up to eight strings (quote wikilinks in YAML). Every declared target must resolve to the same path. Null, blank scalar and empty list values are absent evidence. The old YAML key `areaId`, body headings (including `## Area`), prose, tags and supporting notes never assign an Area. Multiple distinct, ambiguous, missing or unsupported targets remain unassigned without dropping the project.

Obsidian resolves references using the selected vault root: vault-relative and already-prefixed paths, `.md` or omitted extensions, display aliases (`[[target|label]]`), and unique local basenames are supported. Nested explicit note/directory targets use the existing top-level display roll-up. No display-title/topic inference or alias-property search is performed. A folder project's immediate `README.md` supplies frontmatter only when no sibling root note takes precedence.

Indexed direct vaults resolve each relationship batch using one index generation, without live note reads or directory listings for the batch. The inventory still checks source access, discovers nested vault roots when configured and enumerates immediate entry folders. Legacy sources and direct sources without an index grant use bounded live reads to extract frontmatter only. GTD calls only the frontmatter-specific Obsidian RPC with the `area`-only declaration contract. It keeps projects visible but unassigned with partial coverage if Obsidian is too old or rolls back between batches. A source or route refusal discards all assignments from that inventory, including earlier batches. If observed access is revoked and restored between batches, a changed authorization epoch also discards those assignments; ordinary index refreshes do not. Isolated omissions leave verified assignments intact with partial coverage; semantic unresolved relationships alone do not invalidate counts. Inventory never writes or migrates note content.

For example, `area: Areas/Learning.md` in `Projects/Woodworking.md` can resolve to `areaId: Areas/Learning.md` in the returned project. The optional `areaId` output is the resolved area's backend path, not a YAML key. With a nested vault, the exact Area ID from the area listing is the full mirror-relative path. No area is guessed from a display title. For display only, an exact returned Area ID wins; otherwise a nested path below an Area's entry folder rolls up to that enclosing top-level Area (for example `Areas/Community/Committee/Meeting.md` displays beneath `Areas/Community.md` or `Areas/Community/`). This uses exact path segments, not display titles, and never rewrites note frontmatter or thread references. Unmatched/missing area IDs appear under **Unassigned area**.

Use **GTD project** in any thread's ordinary menu to link, reassign or unlink it. Exactly one `{ source, id }` reference is persisted in the GTD thread metadata namespace. Other metadata, BB project membership and coding environments are untouched. Missing/deleted or other-source references remain visible under **Unavailable project**, with reassignment/unlink available. Display-title renames do not change either part of the reference. Physical path moves outside GTD are not automatically remapped.

Each project row shows a **New thread** button. It creates a conversation in BB's personal project (never a new coding project), seeds its association at creation and includes bounded title/status/reference data. The initial agent instruction is to acknowledge and wait; no project task, account write, or execution of note text is authorized. Further details are obtained using the stable source/ID and ordinary source read tools.

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

`test/rendered-review.mjs` starts a disposable stock BB instance using explicit `BB_REVIEW_APP_ROOT` and `BB_REVIEW_CHROME` paths. It installs the actual GTD/Obsidian bundles in isolated state, checks harmless runtime reads/diagnostics, and renders a synthetic Area, project and linked threads at desktop and touch widths. It checks the bundled list’s Organize and Filter controls, saved sorting, archived threads, and recovery from the retired provider preference. RPC-intercepted mutations exercise menus, title retention, association/unlink, reload, repeated activation and empty/loading/error/missing-project states without account access or agent execution. Unit/host tests exercise actual rename/CAS and thread request logic separately. Rendered fixtures are not proof of cloud delivery or live-provider writes.
