# Direct push edge cases

Status: accepted by design, apart from one untested case.

## Problem

The direct push favours speed and simplicity over handling every race. These cases are known:

- **Overwrite window.** The push checks that the cloud copy matches what BB last saw, then copies. An edit from another device that lands in iCloud between those two steps, about a second, is overwritten. iCloud keeps the old document in Recently Deleted for about 30 days. Every other case where the cloud copy changed is skipped, and the scan keeps both versions as a conflict.
- **A deleted note comes back.** If a note is deleted on another device and then edited through BB before the next scan, both the push and bisync recreate it, because an edit wins over a deletion.
- **Folder rename collisions.** If a folder is renamed both on BB and on another device, you can end up with two folders until someone tidies them.
- **Folder move during a scan (untested).** A scan that listed the cloud before a pushed folder move may try to delete files that have already moved. That scan may fail; the next one should repair it with `--resilient --recover`.

## Current evidence

- The overwrite guard is covered by [`test/direct-push-native.test.ts`](../../test/direct-push-native.test.ts) against stock rclone. It was confirmed live on 2026-11-28: a BB edit made after a cloud edit was skipped and became a conflict, and the [conflict sweeper](../../../obsidian/README.md) merged it.
- Nothing has tested a folder move pushed during a running scan.

## Desired outcome

Keep the push simple. Add the folder-move-during-scan case to the native test, to confirm it costs at most one failed scan. Revisit the other cases only if they happen in real use.
