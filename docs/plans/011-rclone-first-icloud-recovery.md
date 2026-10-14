# 011 — Unattended iCloud sync, with rclone owning recovery

Status: Implemented and deployed; a completed persistent live sync is verified. Live Apple authorization-expiry recovery remains unverified.

## Goal

Ordinary iCloud read failures and interrupted syncs recover without an agent, shell commands or a host operator. Use stock rclone's retry, bisync recovery and locking mechanisms rather than building a second recovery engine. BB owns consent, scheduling, connection controls and honest status.

Success means demonstrated automatic recovery with preserved files, not just passing tests or replacing the warning text. Exceptional failures that rclone cannot safely recover must stop with a clear action in BB; unattended operation does not mean forcing every run to succeed.

## Starting point

The current adapter disables rclone retries with `--retries 1 --low-level-retries 1`. The service disables a folder after every failed run and treats a restored `running` state as manual recovery. A private worker marker and unfinished backup staging can also block subsequent runs independently of rclone.

A recent failure illustrates the problem: the second cloud listing during recovery-copy validation exited with generic code 1, before bisync began. The wrapper disabled future runs. Subsequent read-only inspection found unchanged successful baselines, valid referenced recovery blobs and a working cloud listing. The underlying provider/network cause remains unknown. That is evidence for removing an unnecessary lockout, not for ignoring failures after writes.

This iteration deliberately revises the blanket fail-closed/manual-review policy in [004](004-icloud-sync.md), [007](007-icloud-sync-progress.md) and [008](008-incremental-icloud-recovery.md). Keep those plans as historical records and update the current plugin guide and tests.

## Rclone-first contract

- Restore rclone's documented retry defaults (three high-level attempts and ten low-level attempts where the command supports them). Verify actual listing behavior: `lsjson` must not be assumed to have the same whole-command retry loop as copy or bisync. Keep bounded command timeouts and allow graceful shutdown.
- For initialized normal runs, use `bisync --resilient --recover` and a documented `--max-lock` duration, verified against pinned stock v1.75.2. Let rclone renew and expire its own bisync locks; do not unlink a live lock or implement another lock-expiry protocol.
- Interpret failures in command context. Bisync documents exit 1 as non-critical/retryable and exit 7 as critical; generic rclone commands have different meanings. Do not apply one exit-code table to every command or parse raw provider messages to decide safety.
- When rclone exhausts an ordinary retryable operation, keep an already authorized folder eligible for the next scheduled run. Use the existing schedule, with no additional retry daemon, recursive retry loop or custom backoff framework. Preserve no-overlap behavior and let Pause stop subsequent attempts.
- Repeated failures must remain visible as stale/unsuccessful syncing, with the last successful timestamp unchanged. Do not imply that all future attempts will succeed or turn a failed attempt into successful history.
- Never add automatic `--resync`, bypass deletion checks, change conflict policy or use `--inplace`. Keep both conflicting versions, existing transfer/deletion bounds, retained local folders and independent recovery copies.

Rclone's documented mechanisms are the starting design, not an assumption that flags alone fix the wrapper. See [bisync recovery and locking](../reference/rclone/docs/content/bisync.md#resilient), [bisync exit codes](../reference/rclone/docs/content/bisync.md#exit-codes) and [rclone retries](../reference/rclone/docs/content/docs.md#retries-int).

## Small implementation sequence

### 1. Prove the native behavior before changing policy

Use stock v1.75.2 against generated local/alias data. Demonstrate retryable bisync exit, graceful and abrupt interruption, recovery on the next invocation, lock renewal/expiry, conflicts and genuinely critical refusal. Choose one documented lock duration from that evidence. Test the configured command timeout with retries enabled; it must not routinely terminate rclone before its own retry/recovery work can complete.

Retain the existing native process and adapter tests. A fake exit code proves BB's response, not rclone's recovery behavior. If the pinned binary cannot meet the contract, record the limitation rather than substituting a custom repair algorithm.

### 2. Stop the wrapper defeating rclone

Change `adapters/rclone-process.ts`, `adapters/rclone-cloud-provider.ts` and `core/service.ts` so native retries and normal scheduled recovery can operate. Use only the small amount of state needed to distinguish user-paused, retry-pending, reconnect-required and genuinely blocked folders. Preserve enabled intent through a recoverable interruption, but never revive a user-paused, disconnected or retained folder.

Keep rclone responsible for deciding whether an interrupted initialized bisync can continue. A display progress stage is not durable evidence that no write happened. Initial preparation remains separate: never recover a partly populated initial mirror by silently running `--resync` again.

Review the plugin's private `worker.lock` and daemon lifecycle so an unclean restart cannot permanently lock out an otherwise recoverable folder. Keep process exclusivity using an existing host/OS facility where possible; do not replace the marker with a new lease service. Prove that an old child process cannot overlap a restarted worker or two-way sync.

### 3. Make existing recovery copies compatible with another attempt

Keep the current recovery-copy format, independent verified blobs, retention and capacity checks. This iteration is not a backup-store redesign. Native `--backup-dir1/2` require each backup to be on its corresponding remote; they are not a drop-in replacement for independent local cloud copies.

A failed pre-sync capture must not leave an unfinished staging directory that makes every later attempt refuse to start. Once exclusive ownership is established, preserve completed versions using the existing incomplete-retention format, account for their storage, and permit a new capture. Discard no unique version merely to unblock retry; malformed or unverifiable state still stops before writes. Test a failure at the second cloud listing, not just at the first download.

If files change during capture, abandon that attempt and allow a fresh capture on the normal schedule. Capacity, invalid selections, damaged recovery data and configuration/critical bisync failures are actionable stops, not tight retry loops. Never enter bisync without the required verified recovery capture.

### 4. Make BB usable without an operator

Use the existing connection layout. Proposed states and copy, to refine through rendered review:

- Temporary pre-sync read failure: “Couldn’t check iCloud. No sync changes were applied. Will retry automatically.” Say this only when the command boundary establishes it.
- Interrupted bisync: “Sync was interrupted. Rclone will attempt recovery.” Do not claim writes were rolled back or never happened.
- Repeated failures: show the last successful sync and that the local copy may be stale; keep Pause available.
- Verified authorization failure: offer Reconnect in BB. After successful authorization, offer Resume for previously authorized recoverable folders; no operator review or new folder required. Preserve explicit Pause/Disconnect intent.
- A failure rclone cannot recover: explain the limit and offer a supported BB action, including the existing confirmed fresh-mirror option when appropriate. Keep old files and unsent edits separate; do not present a fresh mirror as a merge or repair.

Do not label every unsuccessful attempt “Needs recovery,” suggest a fresh mirror for a temporary read error, or prescribe “ask the host operator” as the normal recovery path. An unknown command error is not proof of expired Apple authorization.

Existing failed records need a conservative upgrade path. Do not bulk-clear them based on generic exit codes or progress/history labels. Provide a supported BB check/retry path for an existing initialized mirror that runs the normal preservation and rclone safety checks without forced resync; leave ambiguous initial preparation or damaged records stopped with an honest BB recovery choice. Record what can and cannot be recovered automatically.

### 5. Preserve diagnostics and document the new policy

Keep failed/interrupted attempts in the existing scoped history even when a later attempt succeeds. Preserve retention, command evidence and privacy projections. Follow [observability standards](../o11y-standards.md): bounded command/stage categories, no provider bodies, filenames, credentials, raw exceptions or routine success/poll spam. Extend the existing schema only if the user-facing state needs it; do not build another diagnostic subsystem.

Update the setup/recovery guide, plugin README and scenarios that currently require every failure or restart to disable a folder. Describe native recovery limits, conflict preservation, stale local copies and the difference between retrying and rebuilding.

## Release gates

1. **Real rclone:** a recoverable failure and both graceful and abrupt interruption resume on subsequent runs without manual state edits, lock removal or `--resync`. Recovery after a partial transfer preserves changed/conflicting versions. Critical refusal remains a refusal. Lock expiry never permits overlap with a live run.
2. **Whole plugin:** injected temporary cloud-read failures at both capture listings, a source change during capture and a host/plugin restart recover through the real BB scheduler and adapter. Failures remain in history; success advances the timestamp only after completion. Repeated failures do not grow staging/storage without bound. Use a disposable provider fixture; synthetic failures must not touch the owner's Apple account.
3. **Controls and safety:** Pause, Disconnect and retained folders stay stopped across restart/reconnect. Initialization failures cannot overwrite an existing mirror. Capacity, corrupt recovery records, deletion limits and critical bisync errors stop safely. Existing bidirectional-edit, conflict, rename and deletion-recovery tests still pass with stock rclone and no real-binary skips.
4. **Self-service:** existing failed initialized folders can take the supported BB retry path without an agent. Controlled authorization expiry can be resolved through Reconnect and Resume. Unrecoverable cases provide an honest supported choice rather than promising automatic lossless repair.
5. **Rendered BB:** inspect retry-pending, repeated-failure/stale, interrupted/recovering, reconnect, capacity, critical-stop and fresh-mirror confirmation states at desktop and narrow widths with keyboard focus. Compare with an existing connection. Follow [UX standards](../ux-standards.md) and the project-local UX skill; a build is not rendered verification.
6. **Delivery:** run the full iCloud suite, typecheck/build and shared UI checks. Commit/push and update only iCloud after supported controls quiesce future runs and active children finish. Preserve grants, baselines, local files, copies, history and other integrations. Do not silently clear a pre-existing production failure during deployment; use the supported recovery path and obtain any consent required by the old failed state. Observe a completed persistent live sync and seek feedback from running BB. Report generated-data versus live Apple evidence separately; do not manufacture personal-account writes or outages to close a gate.

## Out of scope

A generic recovery framework, new retry scheduler, backup-store rewrite, automatic forced resync, automatic merging of old/new mirrors, broad rclone upgrades and Obsidian features. Genuine damage may still require specialist help; ordinary service interruptions must not.

## Initial implementation evidence (0.1.7)

- The final combined main-branch suite passed 95 unit/adapter/host tests and 56 Cucumber scenarios (522 steps), without skips, against stock rclone v1.75.2. This includes the natural-duration lock renewal/expiry and graceful/abrupt recovery proof, legacy-worker handoff, same-generation reacquisition, and refusal to discard extra or mismatched completed-capture data.
- A separate isolated BB scheduler run against generated local/alias data recovered a first-listing failure automatically, recovered repeated second-listing failures without unbounded staging growth, and recovered a source change on the next scheduled attempt. Pause followed by reload stayed stopped. Persistent history retained four failures, and bounded `checking`/`saving_recovery` diagnostics excluded the synthetic private sentinel. This is actual one-minute BB scheduler evidence, not Apple-provider evidence.
- An isolated BB 0.45.0 instance rendered 39 controlled states at both 1280px and 390px (78 screenshots). The review exercised first-run, pending, connected, folder browsing, retry-pending, repeated stale failure, interrupted recovery, reconnect/Resume, capacity, configuration, critical stop, eligible legacy Retry, initialization block, fresh-mirror confirmation, progress lifecycles and keyboard focus. The final screenshots were inspected against the existing Fastmail connection layout; no section overflow was found.
- The final shared connection UI drift check, TypeScript check against BB SDK 0.6.15 and plugin build passed. All 78 rendered cases were rerun after the final UI edit, including the explicit post-reconnect “Resume required” state. The iCloud package version is 0.1.7; the comparison Fastmail installation remained unchanged at 0.1.6.
- Temporary failures retain enabled intent and use only the ordinary schedule. Pause cancels future attempts while preserving the outcome. Reconnect requires explicit Resume. Capacity and configuration blockers never auto-retry; after the condition is fixed, explicit Retry rechecks the ordinary capture/rclone path, restores the blocker on failure and clears it on success. Invalid selections use the configuration blocker. Critical and ambiguous-initialization states remain unretryable and alone expose the confirmed fresh-mirror path.
- Generated enabled-plugin hot reload now defers to a live same-parent daemon before and after flock acquisition without signalling it, unlinking live paths or replacing the lock inode. A legacy predecessor without flock is preserved too. After a transient busy run, the same replacement generation completed the next ordinary one-minute scheduled run successfully. Linux procfs and util-linux `/usr/bin/flock` are therefore explicit host requirements.
- The rendered review used controlled RPC fixtures and no provider accounts. Live Apple authorization, Apple session expiry, real provider outage/recovery, a phone-to-BB round trip, production deployment and post-deployment persistent sync were not verified in this iteration. Production access was unavailable, so deployment and post-deployment feedback remain blocked. Production credentials, files, baselines, grants and failure state were not changed.

## Release-review follow-up (0.1.8)

- Stock rclone wraps backend failures in control-socket HTTP 500. The adapter now recognizes only its exact native `trust token expired, please reauth` marker for an iCloud listing, not arbitrary provider messages, HTTP status alone or stderr. Unknown failures remain retryable. After a normal command reports `sync_failed`, a harmless control-socket read can prove expiry while preserving the original bounded command evidence. Capacity, configuration, critical and interrupted outcomes are not downgraded by that check.
- Expiry and manual Reconnect now require explicit Resume for every enabled, recoverable folder. Paused and retained folders stay stopped, and stronger storage/configuration/critical blockers are preserved. Regression tests cover reload, failed reconnect, independent per-folder Resume and synthetic private data in error envelopes.
- The Linux suite passed 102 tests and all 56 scenarios (522 steps), with no skips, against stock rclone v1.75.2. Typecheck, build and shared UI checks passed. The isolated rendered-BB review passed 80 desktop/narrow cases; the affected reconnect and two-folder Resume screenshots were inspected against the existing Fastmail layout, including visible keyboard focus.
- Only iCloud was updated to 0.1.8 from commit `962156e`. A harmless live Apple folder read succeeded, persistent history remained available, and other plugins' versions and enabled states were unchanged. The existing initialized failed folder remained disabled with its last-success timestamp and failure intact. Recent attributable plugin diagnostics contained only bounded fields.
- At the end of the 0.1.8 delivery, no consent to retry that pre-existing production failure was assumed. A completed persistent sync and real Apple authorization-expiry recovery were therefore still unverified; the expiry checks above use controlled native-error fixtures, not an induced personal-account outage.

## Empty-staging follow-up (0.1.9)

- The old failed capture had left metadata-free staging containing only empty side directories. A crash after creating staging but before writing its metadata can leave the same shape. The adapter now removes only valid staging names with no entries, or only empty `cloud`/`local` directories. It uses atomic non-recursive directory removal: zero-byte files, partials, selectors, nested entries, symlinks, malformed metadata and entries arriving at either removal boundary are never treated as empty.
- A local control-socket no-op acquires worker ownership before any recovery-copy retention/pruning begins, rather than waiting for the first cloud listing. A regression test proves that a busy worker leaves staging untouched. Recovery warnings refer honestly to sync records or recovery copies rather than claiming rclone caused every stop.
- The Linux suite passed 120 tests and all 56 scenarios (522 steps), with no skips, against stock rclone v1.75.2. Typecheck, build and shared UI checks passed. The 80 rendered-BB cases passed at desktop/narrow widths; the changed recovery warning was visually inspected against the existing connection layout and its keyboard focus checked.
- Only iCloud was updated to 0.1.9 from commit `7a0f455`. With explicit consent, a separate one-off inspection confirmed the legacy staging was empty and the stopped attempt had not reached bisync. The reviewed saved blocker was corrected offline while retaining the failed outcome, history, mirror and last-success timestamp. Protected-file fingerprints were unchanged by that repair; no lock, baseline or account credentials were reset.
- Supported Retry then exercised the new guarded cleanup. The first ordinary listing hit its five-minute timeout and remained failed in history; the next scheduled attempt completed successfully and advanced the last-success timestamp. The original mirror stayed enabled, all previously retained recovery blobs were checksum-verified, and other plugins' versions/enabled states stayed unchanged. No fresh mirror, forced resync or synthetic personal-account write was used. Harmless root/folder reads succeeded and recent plugin diagnostics contained only bounded fields.
- This verifies recovery of the inspected empty-staging case and a subsequent persistent live sync, not lossless recovery of every ambiguous backup or critical bisync failure. Real Apple authorization expiry and a phone-to-BB edit round trip remain unverified.
