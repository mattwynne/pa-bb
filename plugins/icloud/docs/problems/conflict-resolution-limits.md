# Limits of automatic conflict resolution

Status: open, acceptable for now. The code lives in the Obsidian plugin; the conflicts come from iCloud sync.

## Problem

The [conflict sweeper](../../../obsidian/README.md) settles sync conflict copies right after each scan and every five minutes. It leaves these cases unresolved:

- **Ambiguous sets.** A note with more than one conflict copy from the same side isn't merged. Only a one-to-one pair is.
- **Large notes.** A note pair over 60,000 characters in total isn't sent to the merge agent.
- **Rejected merges.** A model merge that drops a line both copies share is rejected.
- **No off switch.** Automatic resolution can't be turned off. Adding a setting needs a settings-page change and the rendered-UI review that comes with it.

Unresolved conflicts stay as copies and are retried after an hour. Nothing is lost, but nobody is told.

A related workaround: BB's own headless Obsidian is stopped from saving `.obsidian/workspace.json`, which used to conflict with other devices on almost every scan. The fix replaces undocumented Obsidian functions (`saveLayout` and `requestSaveLayout`) at startup. If a future Obsidian release renames them, those conflict copies come back, though the sweeper still clears them.

## Current evidence

- 2026-11-28: two real two-sided conflicts were merged correctly by the hidden agent, keeping all four edits. The first took 3.5 minutes after the copies appeared, waiting on the five-minute schedule. The second took 5 s, with the sweep triggered by the scan.
- [`plugins/obsidian/test/desktop-layout.test.ts`](../../../obsidian/test/desktop-layout.test.ts) runs real Obsidian. It fails if the layout patch stops working.

## Desired outcome

Ambiguous sets and very large notes are settled too, or reported somewhere visible, rather than retried silently. After each Obsidian upgrade, run the desktop layout test.
