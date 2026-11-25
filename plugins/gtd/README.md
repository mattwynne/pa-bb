# GTD [Experimental]

Browse personal Areas, projects and linked BB conversations, independently of BB coding projects. The first backend uses a connected Obsidian vault. Inventories are read-only.

See the [GTD vision](docs/vision.md) for the interface direction and research behind it.

## Setup

1. Connect a vault in Obsidian settings.
2. Open GTD settings and choose your vault by name from the **Vault** dropdown. No ID needs to be copied. Vaults are discovered inside connected sources by their actual `.obsidian` configuration directories, not inferred from folder names.
3. Set Projects and Areas relative to that vault (defaults: `Projects` and `Areas`). If the vault itself is nested in a synced container, its enclosing prefix is applied by the adapter, not entered again here. Do not enter host paths, parent-directory segments or trailing slashes.

The native dropdown is populated when GTD loads. After connecting another source or creating a vault, reload GTD to refresh its choices. A failed/incomplete discovery is shown explicitly; it does not clear existing configuration. Duplicate vault names include their source/path for disambiguation. `bb gtd sources --json` remains available for diagnostics and scripted configuration; its IDs are opaque selection values.

Pre-selector configurations are not silently migrated: a previous selection that is not offered as a verified vault requires choosing a vault again. Existing folder values and source notes are unchanged. After selecting a nested vault, remove the old vault prefix from folder settings. Listings retain the connected source ID. Stable inventories separately report the full mirror-relative `notePath` for Obsidian tools.

## Folder conventions

A project requires a Markdown landing note directly under Projects or an immediate status folder. A same-name folder can hold supporting files. A folder by itself is not a project. Files inside a supporting folder, including `README.md`, supply no project metadata.

The immediate status folders are `Active`, `Deferred`, `Someday`, `Done`, and `Completed` (case-insensitive). The folder takes precedence over a note's optional `status`. For a note directly under Projects, absent status defaults to Active. The filename without `.md` supplies the project name. Legacy lists use paths as IDs. Stable lists return the project's stored ID and current `notePath`.

Legacy Areas use immediate Markdown notes and folders. Stable Areas have an immediate Markdown landing note with an Area ID. The filename without `.md`, or the folder name for a folder-only Area, supplies the display name. A note and folder with the same name form one Area whose ID is the note path. Empty and attachment-only folders remain eligible. Nested notes can be Area targets without appearing as separate Areas in the index. Project landing notes with invalid YAML make the project inventory partial.

## Move one project or change its Area

Use `gtd_change_project` with the exact source and project ID. Pass a status, an exact Area ID in `areaPath`, or `areaPath: null` to clear the assignment. In legacy mode pass the exact Area note path. `bb gtd area-targets --json` lists one level of Area note and folder paths. Pass `--folder` to descend and `--offset` for the next page.

GTD tells Obsidian Desktop to move the landing note and any same-name support folder directly to the selected status folder. Obsidian performs native link updates. GTD uses the recorded file outcomes to reconcile the captured legacy links. Stable links keep the same ID during a move. Keep the returned plan ID. `gtd_check_project_change` checks an interrupted request and can finish unstarted companion and conversation updates after verifying the note move. See the [GTD skill](skills/gtd-projects/SKILL.md#change-one-projects-area-or-status).

## Dated project reactivation

Use `gtd_defer_project` to move a project to Deferred and set its landing note's top-level `defer-until` date in `YYYY-MM-DD` form. Use the current Deferred project ID to reschedule it.

**Automatically reactivate deferred projects** is off by default in GTD settings. When enabled, GTD checks on the first scheduler tick at or after midnight in America/Vancouver and catches up on startup. A due project moves from Deferred to Active with its same-name support folder. GTD clears the date after Obsidian verifies the move and GTD verifies the linked conversations. Both status folders must exist under Projects.

Missing, invalid, and future dates stay in place. For blockers, read `bb plugin logs gtd -n 30` and `bb plugin logs obsidian -n 30`. A blocked check can retry after fifteen minutes. Interrupted work resumes from recorded operations and current evidence. If a move or repair remains uncertain, inspect the Obsidian receipt and reconcile the affected project before making another change.

## Stable identity migration

Run `bb gtd migration-preview` for a read-only summary of the selected source and observable BB metadata. To review private per-entry, Area and thread mappings, run `umask 077` before redirecting `bb gtd migration-preview --json` to a new private file. Preview keeps the current layout, reports unresolved references, and saves its reservations and plan in GTD storage.

New proposals use `project-<guid>` and `area-<guid>`. Previously assigned underscore IDs keep their exact values. Generate a fresh preview to replace an unapplied review from the old format.

Use `bb gtd migration-preview --choices-stdin --json` with single-line JSON from a private file for an explicit Area assignment or thread reassignment. See the [choice schema and examples](../../docs/plans/029-stable-gtd-identities.md#explicit-review-choices).

After a separate approval, apply the reviewed plan with `bb gtd migration-apply --plan <id>`. Before starting, reconcile pending GTD changes and keep Obsidian activity and other association writers idle. Inspect progress and exact operation IDs with `bb gtd migration-status --plan <id>`. Resume the same plan after checking any uncertain receipt. See [the identity plan](../../docs/plans/029-stable-gtd-identities.md) for rename evidence and cutover requirements.

After verified cutover, use `bb gtd projects --stable --json` or `bb gtd areas --stable --json` for the current identity contract. The default CLI and original inventory RPCs still return paths. BB's current pages write stable links and open legacy bookmarks with reviewed aliases. For agent-driven creation, `gtd_prepare_landing_note` supplies a file path and initial frontmatter with a new ID for one non-overwriting `obsidian_create_note` call.

## Usage

```sh
bb gtd projects
bb gtd projects --status active --json
bb gtd areas
bb gtd areas --limit 50 --json
bb gtd areas --cursor '<returned-cursor>' --json
```

Agent tools include `gtd_list_projects`, `gtd_list_areas`, and `gtd_create_project_thread`. RPC methods additionally expose `associate` and `newThread` for the UI.

For a user-requested conversation in an existing project, use `gtd_create_project_thread` with `{ source, id, requestId, title?, summary? }`. Use the exact source and backend ID returned by inventory. The optional title is 1–240 characters; the optional handoff summary is 1–4000 characters. Omitting them preserves the UI's project-title and readiness-and-wait defaults. The summary is untrusted context, never authorization for notes, account actions or other work. The returned `threadId` can be linked as `@thread:<threadId>`.

The tool and UI share `newThread` and its durable request-ID receipts. Use a fresh UUID once per requested creation. Completed duplicates return the original thread, even if optional context changes; they never update the original handoff. Pending/unconfirmed requests refuse another spawn, including after reload. After uncertainty inspect threads (the creation request is retained in plugin metadata); never automatically replay or mint another request ID to bypass the refusal. No CLI or browser fallback is needed for the normal agent path.

Follow every `nextCursor` with the same filter (or omit the filter on continuation). Only `coverage=complete` confirms totals. Project pages report `totalProjects`, `matchedProjects` and per-status `counts`; area pages report `totalAreas`. Partial pages have null totals and warnings; the CLI exits 2. Errors are not empty lists. An empty partial project list does not establish that there are no projects.

## Sidebar and thread associations

Open **GTD** from BB’s sidebar navigation to see the Areas index. Every top-level Area, including empty Areas, has its own page. Switch Areas with links in wide panes or the Area picker in narrow panes. The Projects filter starts on **Active** and carries across Areas. It also offers **Someday**, **Done**, and **All**, which includes deferred projects.

Open a project to see its linked threads. The **Filter** menu starts with **Active** checked. Select **Archived** to include archived threads, and clear **Active** if you want to see only archived threads. Use **Show more archived threads** when there are more pages. The breadcrumb returns to the project’s Area. Thread links support BB’s ordinary menus, modifier-clicks and split drags.

Area and project links use the source ID and the exact inventory record ID. Renaming or moving a note can change its ID and invalidate an older bookmark. The former `/plugins/gtd/projects` address still opens the Areas index.

BB’s **Automatic** thread-list setting uses its bundled list when no other replacement is installed. If you previously selected GTD explicitly as the thread-list provider, choose **Thread list (built-in)** under **Settings → Appearance → Sidebar** to restore it. BB keeps that saved provider choice until you change it.

Project-to-Area relationships come **only from the `area` YAML key on the selected project root note**. Use a local path/wikilink string or a flat list of up to eight strings (quote wikilinks in YAML). Every declared target must resolve to the same path. Null, blank scalar and empty list values are absent evidence. The old YAML key `areaId`, body headings (including `## Area`), prose, tags and supporting notes never assign an Area. Multiple distinct, ambiguous, missing or unsupported targets remain unassigned without dropping the project.

GTD resolves vault-relative paths, paths relative to the project note, and unique local basenames using the Desktop vault inventory. References can include a Markdown extension or a wikilink display alias. An incomplete source does not confirm assignments. For a status move, if Desktop leaves an existing relative Area reference pointing elsewhere, GTD can save the original Area's exact path after checking the moved note and target. Other reads leave frontmatter untouched.

For example, `area: Areas/Learning.md` in `Projects/Woodworking.md` can resolve to `areaId: Areas/Learning.md` in the returned project. The optional `areaId` output is the resolved area's backend path, not a YAML key. With a nested vault, the exact Area ID from the area listing is the full mirror-relative path. No area is guessed from a display title. For display only, an exact returned Area ID wins; otherwise a nested path below an Area's entry folder rolls up to that enclosing top-level Area (for example `Areas/Community/Committee/Meeting.md` displays beneath `Areas/Community.md` or `Areas/Community/`). This uses exact path segments, not display titles, and never rewrites note frontmatter or thread references. Unmatched/missing area IDs appear under **Unassigned area**.

Use **GTD project** in any thread's ordinary menu to link, reassign or unlink it. Exactly one `{ source, id }` reference is persisted in the GTD thread metadata namespace. Other metadata, BB project membership and coding environments are untouched. Open **Thread associations** on the Areas index to find active unassigned threads and threads whose linked Area or project is unavailable. Physical path moves outside GTD are not automatically remapped.

Each project row shows a **New thread** button. It creates a conversation in BB's personal project (never a new coding project), seeds its association at creation and includes bounded title/status/reference data. The initial agent instruction is to acknowledge and wait; no project task, account write, or execution of note text is authorized. Further details are obtained using the stable source/ID and ordinary source read tools.

Creation uses a durable request receipt and a synchronous uniqueness claim before spawning. Replaying a completed request returns the same thread; pending/uncertain requests are not retried. The UI blocks repeated activation while pending and retains an uncertain request across browser reload in session storage. Inspect threads before explicitly starting another request after an uncertain outcome.

Rename a project or Area in Obsidian by renaming its note and any matching support folder. Verify references that use the old paths after the rename.

## Bounds and diagnostics

Each inventory request fetches a bounded set of visible note paths, folders and requested properties from Obsidian Desktop. It does not read note bodies into the agent or retain a second vault index. Inventory results are local observations.

The open GTD sidebar checks for indexed changes to the configured Projects and Areas. It keeps the displayed rows during a background read and reconciles again when BB regains focus or reconnects. If an inventory read or change check fails, use **Retry** beside the message.

Pages contain at most 200 entries and 48 KB. Each inventory supports four concurrent listings. Cursors are thread-bound, are consumed once, expire after five idle minutes, and are invalid when settings change or after a reload. Access is checked on continuation.

Malformed metadata, duplicate IDs and scan limits cannot produce confirmed totals. Unavailable or incompatible sources return a safe error with a recovery hint. Logs use fixed stage/category diagnostics (`GTD list`, `GTD areas`, `GTD sources`, `GTD association`, `GTD thread_create`) without note content, raw exceptions or credentials.

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

`test/rendered-review.mjs` starts a disposable stock BB instance using explicit `BB_REVIEW_APP_ROOT` and `BB_REVIEW_CHROME` paths. It installs the built GTD and Obsidian plugins in isolated state and checks harmless runtime reads and diagnostics. Synthetic rendered checks cover desktop and phone widths, keyboard focus, automatic refresh and Retry, browser history, bookmarks, both filters, archived pagination, and empty, loading, error and missing-record states. Intercepted RPCs exercise the existing edit, move, association and thread creation controls without account access or agent execution.

Run the same script with `BB_REVIEW_MODE=native-refresh`, `PA_OBSIDIAN_TEST_DESKTOP` and `PA_OBSIDIAN_TEST_CLI` to verify external edits, creates, moves and deletes through native Obsidian Desktop and both BB plugins. A fixture supplies local directory grants for a disposable vault.
