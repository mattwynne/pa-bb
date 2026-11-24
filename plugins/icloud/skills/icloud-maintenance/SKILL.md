---
name: icloud-maintenance
description: Inspect or, with user authorization, pause and drain iCloud work for a BB local-path plugin rollout and restore eligible prior scheduling.
---

# iCloud maintenance

Use `bb icloud maintenance status --json` for a read-only snapshot. It reports
admission, active work, persistence, the current run, and the latest restore
receipt. The JSON contains operation UUIDs and aggregate counts.

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
