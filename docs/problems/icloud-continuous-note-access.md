# Background iCloud sync interrupts note access

Status: open problem, recorded 2026-10-15 after live feedback on Obsidian 0.1.0 and iCloud 0.1.12. No correction has shipped. [Plan 015](../plans/015-icloud-continuous-note-access.md) is approved for implementation, with release gates pending; its [review record](../plans/015-icloud-continuous-note-access-review.md) records the user's acceptance of GPT-only coverage, not a completed multi-family ensemble. This problem note does not select an architecture.

## Problem

Routine background sync makes an initialized vault disappear from Obsidian's **Add vault** list. The same integration rejects note operations while sync runs. Live runs take about 40 seconds on a one-minute schedule, so this is not a brief exceptional condition: normal use can be blocked for roughly two-thirds of each minute.

The required service contract is different: **once a vault is initialized, consumers should be able to read and write without knowing whether iCloud is syncing.** Cloud synchronization belongs behind the iCloud service boundary, not in each consuming plugin's request logic.

A write taking 40 seconds is not an acceptable substitute for a busy error. Saving locally must be prompt; propagation to iCloud can happen later.

## User-visible symptoms

During the first attempt to connect a vault:

- The first **Add vault** attempt showed no available vaults.
- A later attempt showed the vault, then it disappeared again.
- Opening iCloud settings and returning appeared to make the vault available.

There should be no need to visit iCloud settings before every Obsidian action. That apparent workaround is consistent with time passing during sync and settings refreshing; the investigation did not establish that opening iCloud settings causes the source to become available.

A connected vault and an available vault are different things. The observed empty list concerned discovery before connection; it is not evidence that a configured vault was removed or its files deleted.

## Live evidence

The investigation used bounded status, inventory, sync-history and log inspection. It did not read personal note contents, connect a vault, change sync settings, or perform a cloud mutation.

At `2026-10-15T05:55:12Z`, status immediately before and after the Obsidian check showed:

| Boundary | Observation |
| --- | --- |
| iCloud account/service | Connected and available |
| Mirror | Initialized, enabled, phase `running` |
| Previous successful sync | `2026-10-15T05:54:46.614Z` |
| Current mirror failure / retry pending | None / false |
| Obsidian setup | `ready` |
| Connected Obsidian vaults | 0 |
| Eligible vaults | 0 |
| Obsidian receipt lookup | `busy` failure category |
| Uncertain Obsidian operations | 0 |

A second inspection at `2026-10-15T05:56:11.780Z` again found a running mirror and zero eligible vaults. The sync history contained eight consecutive successful runs, starting once a minute between `05:48:07Z` and `05:55:07Z`, with durations of **38.830–40.906 seconds**. The next run had started at `05:56:07.785Z`.

Bounded log inspection found `Obsidian rpc busy` and `iCloud note_configure busy`. It also found iCloud `interrupted` and `sync_failed` categories, but the inspected log summary did not retain timestamp correlation; those entries cannot be assigned to the reported clicks. All eight inspected recent runs succeeded, and the current mirror had no failure.

The initialized/running mirror, empty eligible list and code path below establish the discovery defect. The exact first-click request was not correlated with a browser trace. Connected-vault reads and writes were not exercised against personal notes in this investigation.

**No 40-second write was measured.** The current code rejects access as busy; waiting for the active run to finish was a proposed remedy. The live run durations show why that remedy alone would produce unacceptable write latency.

## Current implementation and responsibility

The affected installed implementation came from commit `092bb6ce8d8a2a5ad93f9bc17788107118ca4b08`. Relevant boundaries are:

- [Obsidian service](../../plugins/obsidian/core/service.ts): `status()` includes only `ready` or `paused` sources in `eligible`. `connect()` has the same phase restriction. `source()` rejects a running source as `busy`, before reads or writes reach iCloud. Write admission also requires the source to be enabled and ready. Search/task scans can therefore return incomplete results with source failures. Pagination fingerprints include the source catalog, so sync-state changes can also expire a cursor.
- [Obsidian settings](../../plugins/obsidian/app.tsx): the picker renders the returned eligible list; an empty list tells the user to finish iCloud setup even when initial sync has already succeeded. Settings refresh on mount, focus/visibility return and, in waiting states, a ten-second timer. **Add vault** itself only opens the existing list. Connected-source copy explicitly tells users to try tools after a sync run.
- [iCloud service](../../plugins/icloud/core/service.ts): `exclusive()` returns `busy` while another operation owns the service. `tick()` holds that exclusion while iterating eligible mirrors. `configureNotes()`, `accessNote()` and receipt inspection use the same exclusion. Note access independently requires a ready/paused source, with stricter ready/enabled admission for writes. This is broader than a per-file commit lock and can affect consumers of other mirrors too.
- [Native worker](../../plugins/icloud/adapters/rclone-process.ts): `withFiles()` refuses access while a native command is active. This is deliberate coordination with the actual native owner, not merely a UI status check.
- [Cloud provider](../../plugins/icloud/adapters/rclone-cloud-provider.ts): each selected folder is one recursive `rclone bisync` pair with its own baseline. Sync ownership includes checking/listing, transferring and verification, not only the instant a note changes.
- [Scheduler](../../plugins/icloud/server.ts): selected-folder sync is scheduled every minute.

The main service correction belongs in **iCloud's coordinated note-access API**. Obsidian must stop imposing its own sync-phase availability rules and presenting temporary activity as missing setup. Fixing only the picker would leave the underlying access problem intact; fixing only the service would leave Obsidian rejecting requests before they reach it.

The current exclusion must not simply be removed. A native download could otherwise overwrite a newly saved local edit, and reads could race file replacement. Any replacement must preserve the safety properties of conditional saves, recovery and native ownership.

## Required consumer experience

These are requirements for the future plan, not claims about the installed release:

1. **Stable discovery:** initialized vaults remain discoverable and connected during ordinary background runs. Empty-success output must not stand in for an access failure. No visit to iCloud settings is needed to refresh availability.
2. **Continuous reads:** consumers obtain a stable local version during sync. Routine worker activity does not produce `busy`, false empty search results or a requirement to poll sync phase. A file changing underneath a read needs safe internal handling. Do not imply that a whole-vault search is an atomic snapshot unless that is actually provided.
3. **Prompt, durable local saves:** a write can be made during sync without waiting for the entire cloud run. Success means the new version is durably stored locally and recoverable after restart—not merely placed in an in-memory queue. Define and test an interactive latency budget; 40-second saves are explicitly unacceptable. A sub-second target for ordinary small notes is a candidate, not a measured guarantee.
4. **Read your writes:** after a successful save, subsequent reads, metadata, search and task tools see the saved version even if the native mirror or cloud has not caught up. Another consumer must not see an older version merely because it bypasses a write buffer. The plan must define which access paths share this guarantee.
5. **Asynchronous cloud delivery:** distinguish a durable local save from application to the native mirror, a completed cloud sync and verified device delivery. Report **saved locally, pending iCloud sync** when that is all the evidence supports. Routine sync status may remain visible for freshness and diagnostics; it does not determine tool availability.
6. **Honest failures and conflicts:** missing files, version conflicts, unavailable storage and exhausted capacity remain real outcomes. Accepted local edits must not be silently overwritten by incoming remote edits. Preserve both versions when necessary; do not promise automatic semantic merging.
7. **Consumer independence:** scheduling, contention and reconciliation belong inside iCloud. Obsidian and future consumers should not implement their own sync polling, retry schedules or pause/resume sequences. A sync-status transition alone should not invalidate a usable result cursor; actual content/configuration changes still need defined semantics.

Initial setup and genuine safety blockers are separate from routine sync. This requirement does not authorize bypassing initialization, recovery blockers, vault removal or storage errors. The plan must explicitly define local access during Pause, disconnection and recovery rather than equating cloud freshness with local availability.

## Approaches discussed—not architecture decisions

### Keep vaults visible and wait for the worker

Necessary discovery cleanup, but insufficient as the main access design. Allowing reads where safe and waiting to serialize writes would avoid some busy errors. However, an arbitrary write could still wait most of a 40-second run. The user explicitly rejected that experience.

### Smaller subfolder sync jobs

Potentially useful for reducing individual job duration, but not a solution on its own:

- Rclone applies file changes incrementally; a folder sync is **not an atomic transaction**. Smaller jobs do not make it one.
- Each disjoint subtree needs independent sync state; parent/child jobs must not overlap.
- Files directly in the vault root, hidden/nested content, newly created folders and moves across job boundaries need coverage.
- More jobs may increase listings, fixed overhead and provider requests rather than reduce total work.
- Splitting jobs will not restore availability if a service-wide lock still spans all of them.
- Consumers should still see one vault, not be required to understand the partitions.

Measure the cost of checking/listing versus transfer before choosing this route. Do not change sync frequency or partition an existing mirror merely to mask the access defect.

### Durable per-note write buffer / local overlay

A candidate discussed after rejecting long write waits:

1. Persist the new note version locally and return promptly.
2. Make that version authoritative for subsequent consumer reads.
3. Reconcile it into the native mirror and iCloud in the background.

This would decouple the consumer's local save from the worker's current run without allowing uncoordinated writes to the worker-owned mirror. It is **not yet designed or selected**. A queue alone is insufficient if reads still return old mirror bytes or a restart loses acknowledged edits.

A plan considering this option must address conditional versions, repeated edits to the same note, creates racing remote creates, incoming edits/deletes, operation ordering and deduplication, crash recovery, bounded capacity, reconciliation fairness and eventual progress, removal/disconnect with pending edits, and compatibility with existing receipts and per-note previous versions. Never discard an acknowledged edit or blindly replay an uncertain operation. Avoid bringing back whole-folder backups or building a second general-purpose cloud sync engine.

## Verification gap and future acceptance evidence

The release's generated-data scheduled test sampled 596 reads: 595 succeeded and one returned bounded busy. Its two native sync runs took **91.10 ms and 85.61 ms**. That demonstrated exclusion with fast synthetic syncs, not usable access during a 40-second live run. Earlier passing evidence remains valid within that scope; it does not establish the new consumer contract.

A future plan should prove, using generated data:

- A worker held active for at least 40 seconds does not hide an initialized vault or expose routine sync busyness to read/write consumers.
- Reads, searches, tasks and metadata remain usable throughout; a save completes within the agreed local latency budget and is immediately visible through every supported consumer path.
- Create and edit remain correct when sync starts before, during and after the request; multiple vaults do not inherit unrelated worker downtime.
- Restart/crash after acknowledgment preserves the edit. Lost replies and duplicate operation IDs do not duplicate or replay a mutation unsafely.
- Incoming remote edits/deletes and local repeated edits preserve versions without silent loss. Backlogs drain under repeated scheduled runs without starving sync or writes.
- Initial setup, genuine blockers, capacity exhaustion, removal and disconnection have explicit, honest behavior without clearing safety state.
- Diagnostics identify the failing boundary using bounded categories, with synthetic private sentinels proving that content and credentials do not leak.
- Rendered BB review covers discovery and connection across long syncs, narrow/desktop layouts, keyboard use and refresh/navigation races. A passing backend build is not a UI release gate.

Record local-save latency, sync duration and delivery evidence separately. Any personal-vault or disposable cloud/device mutation test still needs specific authorization. This problem note authorizes no production migration, settings change, automatic connection, recovery reset or new implementation.

## Existing product constraints

- Connecting a vault grants whole-vault read/write, including nested and hidden Markdown notes. Do not add folder permissions, read-only switches or per-edit confirmations.
- Support multiple vaults; preserve stable identities and removal/revocation checks.
- Preserve path/symlink containment, conditional writes, per-note recovery, durable receipts and duplicate-operation protection. Notes remain untrusted data.
- No whole-folder backup scheme, Mac relay, note browser/editor or graph UI is required.
- Follow the repository's [observability](../o11y-standards.md), [UX](../ux-standards.md) and shipping standards.

## Related work

- [Original iCloud problem](icloud-plugin.md)
- [Iteration 006 — Obsidian support and release evidence](../plans/006-obsidian-vault-reading.md#release-evidence)
- [Iteration 012 — native iCloud sync](../plans/012-native-icloud-sync.md)
- [Iteration 013 — retry classification](../plans/013-icloud-bisync-retry-classification.md)
- [Pinned rclone references](../references/rclone/README.md)
