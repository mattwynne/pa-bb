# GTD [Experimental]

Browse personal Areas, projects and linked BB conversations, independently of BB coding projects. The first backend uses a connected Obsidian vault. Inventories are read-only.

See the [GTD vision](docs/vision.md) for the interface direction and research behind it.

## Setup

1. Connect a vault in Obsidian settings.
2. Open GTD settings and choose your vault by name from the **Vault** dropdown. No ID needs to be copied. Vaults are discovered inside connected sources by their actual `.obsidian` configuration directories, not inferred from folder names.
3. Set Projects and Areas relative to that vault (defaults: `Projects` and `Areas`). If the vault itself is nested in a synced container, its enclosing prefix is applied by the adapter, not entered again here. Do not enter host paths, parent-directory segments or trailing slashes.

The native dropdown is populated when GTD loads. After connecting another source or creating a vault, reload GTD to refresh its choices. A failed/incomplete discovery is shown explicitly; it does not clear existing configuration. Duplicate vault names include their source/path for disambiguation. `bb gtd sources --json` remains available for diagnostics and scripted configuration; its IDs are opaque selection values.

Pre-selector configurations are not silently migrated: a previous selection that is not offered as a verified vault requires choosing a vault again. Existing folder values and source notes are unchanged. After selecting a nested vault, remove the old vault prefix from folder settings. Listings retain the connected source ID. IDs use full mirror-relative paths for Obsidian tools.

## Folder conventions

A project requires a Markdown landing note directly under Projects or an immediate status folder. A same-name folder can hold supporting files. A folder by itself is not a project. Files inside a supporting folder, including `README.md`, supply no project metadata.

The immediate status folders are `Active`, `Deferred`, `Someday`, `Done`, and `Completed` (case-insensitive). The folder takes precedence over a note's optional `status`. For a note directly under Projects, absent status defaults to Active. The filename without `.md` supplies the project name. The project ID is its exact note path.

Areas use immediate Markdown notes and folders. The filename without `.md`, or the folder name for a folder-only Area, supplies the display name. A note and folder with the same name form one Area whose ID is the note path. Empty and attachment-only folders remain eligible. Nested notes can be Area targets without appearing as separate Areas in the index. Project landing notes with invalid YAML make the project inventory partial.

## Move one project or change its Area

Use `gtd_change_project` with the exact source and project ID. Pass a status, an exact Area note path in `areaPath`, or `areaPath: null` to clear the assignment. `bb gtd area-targets --json` lists one level of Area note and folder paths. Pass `--folder` to descend and `--offset` for the next page.

GTD tells Obsidian Desktop to move the landing note and any same-name support folder directly to the selected status folder. Obsidian performs native link updates. GTD uses the recorded file outcomes to reconcile the captured conversation links. Keep the returned plan ID. `gtd_check_project_change` checks an interrupted request and can finish unstarted companion and conversation updates after verifying the note move. See the [GTD skill](skills/gtd-projects/SKILL.md#change-one-projects-area-or-status).

## Dated project reactivation

Use `gtd_defer_project` to move a project to Deferred and set its landing note's top-level `defer-until` date in `YYYY-MM-DD` form. Use the current Deferred project ID to reschedule it.

**Automatically reactivate deferred projects** is off by default in GTD settings. When enabled, GTD checks on the first scheduler tick at or after midnight in America/Vancouver and catches up on startup. A due project moves from Deferred to Active with its same-name support folder. GTD clears the date after Obsidian verifies the move and GTD verifies the linked conversations. Both status folders must exist under Projects.

Missing, invalid, and future dates stay in place. For blockers, read `bb plugin logs gtd -n 30` and `bb plugin logs obsidian -n 30`. A blocked check can retry after fifteen minutes. Interrupted work resumes from recorded operations and current evidence. If a move or repair remains uncertain, inspect the Obsidian receipt and reconcile the affected project before making another change.

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

On an Area page, choose **Add project**, enter a name, and choose **Create project**. GTD saves an active Markdown note directly in the configured Projects folder with the selected Area path in its `area` property. The name becomes the filename. If a save is unconfirmed, check the project list and the Obsidian receipt using the operation ID shown in the dialog.

In the BB composer, type `@` and part of a name to find **GTD projects** and **GTD Areas**, including folder-only Areas. A mention gives the agent the item's exact reference as context. Ask BB to open the mentioned item in GTD to get a one-click link. The read-only `gtd_resolve_detail_link` tool verifies the kind, source and ID against the configured inventory and returns the canonical same-app detail link.

### Actions

Keep project and Area actions as Markdown checkboxes under `## TODO` in the Obsidian landing note. On the Area page, use **Add action** to create a task and its checkbox to complete or reopen it.

`bb gtd actions list --kind area --source <source> --id <note-path>` lists the actions with their line numbers and note version. Use `--kind project` for project notes. The `add` command takes `--text`. The `edit` and `delete` commands need `--line` and `--version` from a fresh listing. Edit accepts `--text`, `--status open|complete`, or both. All four commands accept `--json`.

The equivalent agent tools are `gtd_list_actions`, `gtd_add_action`, `gtd_edit_action`, and `gtd_delete_action`.

Opening a detail page directly from a native mention pill requires BB core support. The smallest extension would let a mention provider supply a structured, plugin-owned panel destination with the result, let BB validate it against that plugin's registered panels and retain it with the mention, and have BB use it for click and keyboard activation.

Open a project to see its linked threads. The **Filter** menu starts with **Active** checked. Select **Archived** to include archived threads, and clear **Active** if you want to see only archived threads. Use **Show more archived threads** when there are more pages. The breadcrumb returns to the project’s Area. Thread links support BB’s ordinary menus, modifier-clicks and split drags.

Area and project links use the source ID and the exact inventory record ID. Renaming or moving a note can change its ID and invalidate an older bookmark. The former `/plugins/gtd/projects` address still opens the Areas index.

BB’s **Automatic** thread-list setting uses its bundled list when no other replacement is installed. If you previously selected GTD explicitly as the thread-list provider, choose **Thread list (built-in)** under **Settings → Appearance → Sidebar** to restore it. BB keeps that saved provider choice until you change it.

Project-to-Area relationships come **only from the `area` YAML key on the selected project root note**. Use a local path/wikilink string or a flat list of up to eight strings (quote wikilinks in YAML). Every declared target must resolve to the same path. Null, blank scalar and empty list values are absent evidence. The old YAML key `areaId`, body headings (including `## Area`), prose, tags and supporting notes never assign an Area. Multiple distinct, ambiguous, missing or unsupported targets remain unassigned without dropping the project.

GTD resolves vault-relative paths, paths relative to the project note, and unique local basenames using the Desktop vault inventory. References can include a Markdown extension or a wikilink display alias. An incomplete source does not confirm assignments. For a status move, if Desktop leaves an existing relative Area reference pointing elsewhere, GTD can save the original Area's exact path after checking the moved note and target. Other reads leave frontmatter untouched.

For example, `area: Areas/Learning.md` in `Projects/Woodworking.md` can resolve to `areaId: Areas/Learning.md` in the returned project. The optional `areaId` output is the resolved area's backend path, not a YAML key. With a nested vault, the exact Area ID from the area listing is the full mirror-relative path. No area is guessed from a display title. For display only, an exact returned Area ID wins; otherwise a nested path below an Area's entry folder rolls up to that enclosing top-level Area (for example `Areas/Community/Committee/Meeting.md` displays beneath `Areas/Community.md` or `Areas/Community/`). This uses exact path segments, not display titles, and never rewrites note frontmatter or thread references. Unmatched/missing area IDs appear under **Unassigned area**.

Use **GTD project** in any thread's ordinary menu to link, reassign or unlink it. Exactly one `{ source, id }` reference is persisted in the GTD thread metadata namespace. Other metadata, BB project membership and coding environments are untouched. Open **Thread associations** on the Areas index to find active unassigned threads and threads whose linked Area or project is unavailable. Physical path moves outside GTD are not automatically remapped.

Each project row shows a **New thread** button. It creates a conversation in BB's personal project (never a new coding project), seeds its association at creation and includes bounded title/status/reference data. The initial agent instruction is to acknowledge and wait; no project task, account write, or execution of note text is authorized. Further details are obtained using the source and path ID and ordinary source read tools.

Creation uses a durable request receipt and a synchronous uniqueness claim before spawning. Replaying a completed request returns the same thread; pending/uncertain requests are not retried. The UI blocks repeated activation while pending and retains an uncertain request across browser reload in session storage. Inspect threads before explicitly starting another request after an uncertain outcome.

### Rename a path-based Area

For an explicitly requested rename, pass the exact source and top-level Markdown Area ID from `gtd_list_areas` to `gtd_rename_area`, with the new filename including `.md`. For example, `{ "source": "vault-id", "id": "Areas/Club.md", "newFilename": "Community Club.md" }` renames the note in place. Use the full returned path ID when the selected vault has a root prefix. The tool refuses folder-only Areas, path changes, and occupied destinations.

GTD uses Obsidian's Desktop move and receipt APIs for the note and its exact same-stem support folder. Obsidian handles its supported note links. GTD checks the existing project `area` declarations, keeps links already repaired by Desktop, and saves unresolved path declarations against the observed note version. Assignments to nested targets follow the supporting tree. GTD also relinks the captured active and archived direct Area conversations. `renamed` confirms the move receipts, captured assignments and direct thread references at verification time. The new path is the current Area ID. Other saved URLs or bookmarks may still use the previous path. Local verification gives no cloud or device delivery guarantee.

- `refused` means the note move did not proceed. Check the reported stage and any returned receipt before making a fresh request.
- `unconfirmed` means the note move was entered and GTD lacks confirmation. Inspect the original Obsidian receipt. Repeat the exact original arguments to check progress.
- `partial` means GTD confirmed the note move and still needs to verify or finish a later step. Check the reported stage, move operation IDs and current references. A pending assignment includes its project path and save operation ID. Repeat the exact original arguments, including the old path. GTD checks attempted moves by receipt and can start an unentered step. A definitively refused folder move or property save can receive a fresh operation after new checks.

Repeating a completed request reports its recorded outcome. `historical` means the completed rename no longer describes the current paths. If the user explicitly asks for another rename using the same pair, supply a fresh UUID as `requestId` and keep it on every retry. A different UUID cannot bypass an unfinished rename.

After a lost reply, a move requires its original receipt. Assignment and thread updates can be confirmed by reading the intended reference back. Independent edits can require manual reconciliation. BB thread metadata has no conditional update API. GTD serializes its own writes to the affected thread during the metadata check and update, and verifies the resulting reference. Other clients do not share that lock.

For project filename changes, use Obsidian and verify path-based references after the move.

## Bounds and diagnostics

Each inventory request fetches a bounded set of visible note paths, folders and requested properties from Obsidian Desktop. It does not read note bodies into the agent or retain a second vault index. Inventory results are local observations.

The open GTD sidebar checks for indexed changes to the configured Projects and Areas. It keeps the displayed rows during a background read and reconciles again when BB regains focus or reconnects. If an inventory read or change check fails, use **Retry** beside the message.

Pages contain at most 200 entries and 48 KB. Each inventory supports four concurrent listings. Cursors are thread-bound, are consumed once, expire after five idle minutes, and are invalid when settings change or after a reload. Access is checked on continuation.

Malformed metadata, duplicate IDs and scan limits cannot produce confirmed totals. Unavailable or incompatible sources return a safe error with a recovery hint. Logs use fixed stage/category diagnostics (`GTD list`, `GTD areas`, `GTD sources`, `GTD association`, `GTD thread_create`) without note content, raw exceptions or credentials.

Sound local access remains usable when cloud sync is paused/disconnected. Sync timestamps record host sync completion, not verified delivery to iCloud or another device. GTD does not resume sync, repair failures, or change folder enablement.

## Email correspondence

Add `## Active conversations` and `## Archived conversations` to the project landing note, with one Markdown bullet per email conversation. Use the thread subject as the link text. Move a bullet between sections in Obsidian when its project relevance changes. Archived conversations stay accessible in a collapsed list on the project page.

BB also reads older `## Correspondence` sections as active. BB preserves the note order for Active and Archived and shows each exact URL once. Entries under Snoozed, Active, and Archived take precedence over legacy entries, in that order.

Agents can attach a verified Fastmail or Gmail link with `gtd_add_correspondence`. Supply the exact project reference, email subject, URL and a fresh operation UUID. New links go under Active conversations by default. Pass `status: archived` to file a link for reference. Adding an exact URL already in the project returns its existing status.

Use `gtd_list_correspondence` to list saved links and `gtd_open_correspondence` to return an exact saved URL. On request, `gtd_archive_correspondence` moves a saved link to the archived section in one Obsidian save. Attachment and archive use Obsidian's `addSectionLink` and `moveSectionLink` RPCs. If a save is uncertain, inspect the Obsidian receipt using the operation ID before attempting another edit.

For Gmail, use an account-qualified conversation URL. The Workspace tool `gworkspace_resolve_gmail_thread_url` verifies a thread in the selected account and returns the URL and subject. The Gmail account address is part of the link destination. Only save the URL where that address may be stored.

Fastmail links with a web account selector and an exact message anchor can use the Fastmail plugin's optional JMAP mail token. BB verifies the linked message and reads its whole conversation. When several active links resolve to the same Fastmail thread, BB shows the first saved title and URL once. Links whose threads cannot be verified stay visible with their own status. [Fastmail link verification](../fastmail/docs/email-urls.md)

BB reads mailbox metadata for active conversations to show unread counts and the latest sender and date. It refreshes when the project opens, BB regains focus, or the visible page is due for a refresh. **Refresh email** runs the same operation as `gtd_refresh_correspondence`.

Choose **Snooze** on an active conversation and enter a future date. GTD checks for zero unread messages before saving. Find deferred links and their return dates under **Snoozed conversations**, where you can change the date or choose **Unsnooze**. Agents use `gtd_snooze_correspondence` and `gtd_unsnooze_correspondence`. Listing with `status: snoozed` reads the saved links and dates without refreshing mail.

Snoozed links live in the note's `## Snoozed conversations` section. A bullet uses the same subject and URL, with the return date as its Markdown link title, for example `- [Supplier quote](<https://example.invalid/conversation> "2026-12-04")`. GTD uses the Vancouver calendar. On project refresh it saves due links and links with confirmed unread mail back to Active. A reply that has already been read by then leaves the snooze in place until its date. Snoozed links stay out of project unread indicators. Mailbox read state and placement are independent.

Area project lists check active conversations for the selected Area and status. Each refresh reads up to 12 project notes, three at a time, and checks up to 16 distinct supported mailbox links. **Unread email** means a mailbox confirmed at least one unread message. **Mail status incomplete** means some evidence was unavailable or skipped and no unread mail was confirmed. An empty list or a complete zero count needs no badge.

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

Run `node test/mention-rendered-review.mjs` with the same BB and Chrome paths after building GTD. It uses a disposable BB server and host daemon, synthetic inventory and a local test agent to exercise native composer selection, send-time context, the real detail-link tool, and link activation at desktop and narrow widths.

Run the same script with `BB_REVIEW_MODE=native-refresh`, `PA_OBSIDIAN_TEST_DESKTOP` and `PA_OBSIDIAN_TEST_CLI` to verify external edits, creates, moves and deletes through native Obsidian Desktop and both BB plugins. A fixture supplies local directory grants for a disposable vault.
