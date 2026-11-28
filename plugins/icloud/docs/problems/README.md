# Known iCloud sync problems

Open problems in iCloud sync since the return to stock rclone with direct pushes (`b782bae`, 2026-11-27). Most significant first:

1. [An overwrite briefly removes the note from other devices](overwrite-replaces-document.md): stock rclone replaces the iCloud document, so an edited note disappears from other devices for about 2.5 s.
2. [Vault scans take about four minutes](slow-vault-scans.md): this slows changes from other devices and conflict detection.
3. [Limits of automatic conflict resolution](conflict-resolution-limits.md): ambiguous or very large conflicts are left as copies, and the layout fix depends on Obsidian internals.
4. [Direct push edge cases](push-edge-cases.md): accepted races, plus one untested folder-move case.
5. [A direct push takes 7–8 seconds](push-latency.md): the total from save to another device is about 8 s.
6. [Recurring "history_retention capacity" warning](history-retention-warning.md).
