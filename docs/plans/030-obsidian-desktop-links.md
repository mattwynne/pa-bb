# 030 — Use Obsidian Desktop for link operations

Use the official CLI to answer “which notes link here?” if it lets us delete custom work. Try single-note renames second. Keep GTD Projects on its current batched inventory.

Desktop used about 330 MiB idle. Launch it for a link request and quit when the request ends, including on failure. A disposable-vault test confirmed the CLI reconnects after restart. [Official CLI](https://obsidian.md/help/cli)

## 1. Backlinks

1. On an opted-in Linux host, use the operator-provided binaries, a private profile and CLI socket, and the normal desktop sandbox. Target the authorized direct vault by ID and the note by exact path. iCloud handles sync.
2. Inside `obsidian_get_note_metadata(backlinks=true)`, call `backlinks` once. It returns referring files. Reuse BB’s parser on those files for the individual occurrences, source spans and hashes callers receive today. Recheck vault access before returning. [Metadata implementation](../../plugins/obsidian/core/service.ts)
3. Compare both results on a disposable vault with repeated links, duplicate names and a hidden source. Check incomplete coverage explicitly. Open and quit with community plugins disabled and inspect the vault diff, including `.obsidian/`, for incidental writes.

**Ship only if the native lookup removes a scan or fixes a demonstrated error.** Discard it if matching today’s coverage still requires the full scan or if a lookup changes synced settings. Legacy mirrors keep their existing route.

## 2. One ordinary rename

Try a same-folder Markdown rename with automatic link updates enabled. Verify the rewritten backlink on disk. Check that an edit to the source or a newly occupied destination after preview blocks the write. Test the known case where a broken link would acquire a target. Interrupt a valid rename after dispatch and inspect its BB operation ID without replaying the write. [Move contract](../../plugins/obsidian/README.md#bounded-path-move-and-rename) · [Known native differences](../../plugins/obsidian/docs/desktop-link-evidence.md)

**Ship only if native rename replaces custom rewrite code while preserving write-time checks and recovery.** If that needs a second planner, stop. Folder and GTD project moves keep their existing writer.

## Protect the Projects screen

With Desktop stopped, open, reopen and refresh Projects. Verify Desktop stays stopped, grouping matches, and click-to-usable timing holds against a before-run on the same inventory. The recorded warm median was 202 ms. Leave the inventory, cache and UI alone. [Sidebar benchmark](028-obsidian-gtd-indexed-link-plan.md#sidebar-performance-follow-up)

## Evaluation results

Keep BB’s existing backlink and move implementations. Neither Obsidian 1.15.1 CLI experiment met its ship gate. Desktop remains an optional disposable comparison, so the plugin and Docker image need no new dependencies.

- **Backlinks.** The official CLI found three repeated links in a visible source and omitted a fourth in a hidden note. It also picked a winner for a basename tie that BB reports as ambiguous. The CLI returned identical results after an oversized note made BB report incomplete coverage. BB could reuse its parser for the returned sources, but it would still need its own index or scan to find omitted sources and report coverage. The first open and quit changed four files under `.obsidian/` with community plugins disabled. Later cycles kept their bytes and updated their modification times. The CLI reconnected after a fresh launch.
- **Same-folder rename.** The official CLI rewrote a backlink on disk and refused an occupied destination once Desktop saw the new file. It accepted a source changed after observation and let a previously broken link acquire a target. Interrupting the CLI after dispatch left the rename applied, with no native operation ID. BB’s disposable tests refused stale sources and occupied destinations at the write boundary and blocked the broken-link case. After a simulated lost adapter reply, a fresh test host inspected the captured BB operation ID without replaying the move. That check depended on having the ID available. Matching those guarantees would still require BB’s planner, write-time checks and recovery records. [Desktop comparison evidence](../../plugins/obsidian/docs/desktop-link-evidence.md)
- **Projects.** The same live build returned identical records for 135 projects and 13 Areas across runs. The rendered Active view kept the same grouping for 45 projects and their linked threads. The count in the collapsed Unassigned threads section changed. The initial live run took 1,726 ms to open, 200 ms to reopen, and 937 ms to refresh. The initial open and Refresh measurement windows overlapped disposable Desktop activity. In the Desktop-stopped repeat, three fresh-tab opens took 490–528 ms (513 ms median), three warm reopens took 177–230 ms (192 ms median), and three Refresh runs took 974–1,561 ms. A separate stopped confirmation took 645 ms, 219 ms, and 1,089 ms respectively. Host sampling detected both disposable launches earlier and observed no Obsidian process during the 77-second repeat and confirmation window. The largest observed sampling gap was 112 ms. The repeat missed Plan 028’s fresh-client and warm median targets and met its warm maximum and Refresh targets. Every stopped Refresh sample took longer than the single initial Refresh sample. The overlap and small sample leave the cause of the timing differences unresolved. The historical 202 ms warm median used a different inventory. [Sidebar benchmark](028-obsidian-gtd-indexed-link-plan.md#sidebar-performance-follow-up)
