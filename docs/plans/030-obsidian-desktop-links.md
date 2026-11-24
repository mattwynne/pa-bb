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
