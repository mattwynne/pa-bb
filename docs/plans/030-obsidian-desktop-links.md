# 030 — Use Obsidian Desktop for link operations

Use Desktop for backlinks and ordinary same-folder renames on a deliberately opted-in Linux vault. Choose a vault you control that contains ordinary files and folders. Desktop follows filesystem links, so the selected vault must have no symlinks, hard links to outside files, or mounts that expose outside directories.

Desktop used about 330 MiB idle. Launch it for a link request and quit when the request ends, including on failure. A disposable-vault test confirmed the CLI reconnects after restart. [Official CLI](https://obsidian.md/help/cli)

## 1. Backlinks

1. On an opted-in Linux host, use the operator-provided binaries, a private profile and CLI socket, and the normal desktop sandbox. Target the authorized direct vault by ID and the note by exact path. iCloud handles sync.
2. Inside `obsidian_get_note_metadata(backlinks=true)`, call `backlinks` once and report the referring files. Preserve the filenames if BB lacks fresh evidence to identify individual occurrences. Recheck vault access before returning. [Metadata implementation](../../plugins/obsidian/core/service.ts)
3. Compare both results on a disposable vault with repeated links, duplicate names and a hidden source. Check incomplete coverage explicitly. Open and quit with community plugins disabled and inspect the vault diff, including `.obsidian/`, for incidental writes.

**Use Desktop’s result as the backlink source on opted-in direct vaults.** Accept Desktop’s hidden-note handling and writes under `.obsidian/`. Keep BB’s file-level result useful even if occurrence spans are unavailable. A failed lookup must be distinguishable from an empty result. Legacy mirrors keep their existing route.

## 2. One ordinary rename

Use Desktop’s same-folder Markdown rename with automatic link updates enabled. Check the resulting file and backlink in a disposable vault. The command acts on the latest source and can give an existing broken link a target. Keep the exact connected vault and path checks. Return an uncertain result if Desktop may have received the rename and its outcome is unknown. Do not repeat an uncertain rename. [Move contract](../../plugins/obsidian/README.md#bounded-path-move-and-rename) · [Known native differences](../../plugins/obsidian/docs/desktop-link-evidence.md)

**Use Desktop’s writer directly for this case.** BB’s preview, expected-version check, rewrite planner and durable operation receipt are outside the native rename contract. Folder moves, cross-folder note moves, legacy mirrors and GTD project moves keep their existing writer.

## Protect the Projects screen

With Desktop stopped, open, reopen and refresh Projects. Verify Desktop stays stopped, grouping matches, and click-to-usable timing holds against a before-run on the same inventory. The recorded warm median was 202 ms. Leave the inventory, cache and UI alone. [Sidebar benchmark](028-obsidian-gtd-indexed-link-plan.md#sidebar-performance-follow-up)

## Follow-up evaluation

The disposable runner opened Obsidian 1.15.1 with a private profile and restricted mode. It found backlinks and rewrote a link after a same-folder rename. Starting Desktop took 0.97–2.12 seconds and shutting it down took 122–137 ms on the initial fixture. The CLI commands themselves took 6–13 ms.

Independent review found that Desktop indexed a directory symlink and a hard-linked Markdown file inside a vault. In separate fixtures, renaming a note rewrote the linked Markdown file outside the authorized vault. Checking the requested note and its parent directories does not constrain the rest of the files Desktop can index or rewrite. Obsidian supports symlinks to external folders. [Obsidian symlink documentation](https://obsidian.md/help/symlinks)

In an isolated Linux fixture, `nosymfollow` blocked the symlink traversal. A writable bind mount still let a write through the hard link affect the outside file. A separate filesystem prevented creating that hard link. A vault on its own filesystem could use that property, but it would require moving existing iCloud mirrors to new storage and enforcing access throughout each Desktop session.

These tests established the condition for opt-in. The operator chooses a trusted vault without filesystem links or outside mounts. BB does not scan the whole vault to enforce that condition. Desktop’s hidden-note handling, settings writes, and direct rename behavior are accepted on that route.

The final disposable check ran both registered BB tools against Obsidian 1.15.1. The file-level backlink lookup took 1.23 seconds. The rename took 1.14 seconds, moved the latest source and rewrote the backlink. Docker declares GTK 3 explicitly. Test the operator-provided bundle under the target machine’s security settings before enabling it. [Setup and tool behavior](../../plugins/obsidian/README.md#optional-obsidian-desktop-backend) · [Docker setup](../../docker/README.md#optional-obsidian-desktop-cli)

After reloading BB with the build, the Projects benchmark returned identical records for 135 projects and 13 Areas. The rendered Active grouping matched, apart from the count of collapsed Unassigned threads. Desktop stayed stopped. Across three trials per build, the median first open went from 531 to 506 ms, reopen from 223 to 184 ms, and Refresh from 1,032 to 957 ms. Median host CPU was 42.5% before and 30.8% after, so the timings do not isolate the effect of the build.

## Initial evaluation results

The first evaluation compared Obsidian 1.15.1 against the existing BB contract. The differences below led to the simpler acceptance criteria above.

- **Backlinks.** The official CLI found three repeated links in a visible source and omitted a fourth in a hidden note. It also picked a winner for a basename tie that BB reports as ambiguous. The CLI returned identical results after an oversized note made BB report incomplete coverage. BB could reuse its parser for the returned sources, but it would still need its own index or scan to find omitted sources and report coverage. The first open and quit changed four files under `.obsidian/` with community plugins disabled. Later cycles kept their bytes and updated their modification times. The CLI reconnected after a fresh launch.
- **Same-folder rename.** The official CLI rewrote a backlink on disk and refused an occupied destination once Desktop saw the new file. It accepted a source changed after observation and let a previously broken link acquire a target. Interrupting the CLI after dispatch left the rename applied, with no native operation ID. BB’s disposable tests refused stale sources and occupied destinations at the write boundary and blocked the broken-link case. After a simulated lost adapter reply, a fresh test host inspected the captured BB operation ID without replaying the move. That check depended on having the ID available. Matching those guarantees would still require BB’s planner, write-time checks and recovery records. [Desktop comparison evidence](../../plugins/obsidian/docs/desktop-link-evidence.md)
- **Projects.** The same live build returned identical records for 135 projects and 13 Areas across runs. The rendered Active view kept the same grouping for 45 projects and their linked threads. The count in the collapsed Unassigned threads section changed. The initial live run took 1,726 ms to open, 200 ms to reopen, and 937 ms to refresh. The initial open and Refresh measurement windows overlapped disposable Desktop activity. In the Desktop-stopped repeat, three fresh-tab opens took 490–528 ms (513 ms median), three warm reopens took 177–230 ms (192 ms median), and three Refresh runs took 974–1,561 ms. A separate stopped confirmation took 645 ms, 219 ms, and 1,089 ms respectively. Host sampling detected both disposable launches earlier and observed no Obsidian process during the 77-second repeat and confirmation window. The largest observed sampling gap was 112 ms. The repeat missed Plan 028’s fresh-client and warm median targets and met its warm maximum and Refresh targets. Every stopped Refresh sample took longer than the single initial Refresh sample. The overlap and small sample leave the cause of the timing differences unresolved. The historical 202 ms warm median used a different inventory. [Sidebar benchmark](028-obsidian-gtd-indexed-link-plan.md#sidebar-performance-follow-up)
