---
name: icloud-maintenance
description: Inspect iCloud maintenance status or run an authorized pause, drain, and restore window for iCloud runtime changes or work requiring exclusive mirror access.
---

# iCloud maintenance

Use `bb icloud maintenance status --json` for a read-only snapshot. It reports
admission, active work, persistence, the current run, and the latest restore
receipt. The JSON contains operation UUIDs and aggregate counts.

Use a maintenance window when reloading iCloud’s file-writing runtime or
when a change requires exclusive mirror access. For routine GTD and Obsidian
reloads that use the existing mirror access and save paths, use those
plugins’ shutdown drains and keep iCloud sync running.

1. For a user-authorized maintenance window, generate and keep a fresh UUID.
   Run `bb icloud maintenance pause --run-id <uuid> --json`. Use the normal
   BB CLI against the BB server that runs iCloud.
2. Poll `bb icloud maintenance status --json`. Proceed when the intended
   `runId` matches, `persistence` is `confirmed`, `admissionPaused` is true,
   and `ready` is true. The hold closes scheduling and new note access through
   iCloud. Wait for admitted syncs, note calls and native note work to finish.
   Coordinate writers that already hold filesystem access separately.
3. Apply the approved change through BB's local-path plugin lifecycle. If
   reload reports that the previous native owner is busy, verify the hold is
   still drained and use the approved stopped-plugin sequence. Disable iCloud,
   finish applying the code, then enable iCloud if it was previously enabled.
   Verify the same hold after startup and complete the read-only checks.
4. Run `bb icloud maintenance restore --run-id <uuid> --json` and verify the
   matching `lastRestore` receipt in status. `leftPaused` counts folders
   from the original enabled set that stayed paused. Existing folder
   diagnostics explain failures that need recovery.

If a command is cancelled or the outcome is uncertain, read status first.
A matching confirmed hold or restore receipt establishes the outcome. A
different active run belongs to its original operator. If persistence is
`unconfirmed`, report it and coordinate recovery with the BB operator.
The running iCloud generation keeps admission fenced until startup can
read the durable state. Keep the run ID and inspect status after recovery.

Use the same run ID throughout a window. The hold survives a reload or
restart and remains active until its matching restore. Keep the new
maintenance-capable code loaded while the hold is active.

## Directory listing benchmark

Run `bb icloud benchmark listing --mirror-id <id> --checkers <2|4|8> --json`
with the exact initialized mirror ID from iCloud inventory. The worker runs
one recursive stock rclone size command against the selected cloud root.
It uses the owned worker's authenticated configuration through a read-only
descriptor. Stock rclone session updates cannot replace the stored config.
The result contains elapsed milliseconds, the count of file objects on
success, and counts of recognized retry, rate limit and invalid log records.
Those record counts are observations from stock rclone output.

Run one trial at a time with maintenance restored. One trial can wait up to
15 minutes for active sync to finish. A busy response means no trial started.
Allow ordinary sync runs between trials. An admitted trial owns the worker
for up to eight minutes and cancellation stops its child. The command uses
the direct note staging exclusion. It measures listing only. Use regular sync diagnostics for
end-to-end host sync times and confirm device delivery separately.
