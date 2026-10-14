# 012 — Native iCloud sync without whole-folder recovery copies

Status: iCloud 0.1.10 installed and read-verified. A pre-existing critical native-sync blocker prevents a completed live sync check.

## Decision

Whole-folder recovery copies are not a requirement. The owner accepts the absence of undo for arbitrary overwrites and deletions originating on any device. Native rclone sync should not be held behind an additional backup/indexing pipeline.

Undo for future BB note edits is a separate requirement: retain the previous version of the specific file at the coordinated tool-write boundary. The Obsidian editing tools and that boundary are still planned, not delivered.

This supersedes the whole-folder backup policy in plans 004, 008 and 011. Their recorded results remain historical evidence, not current requirements.

## Implementation

- Both initialization and ordinary runs delegate directly to native bisync. No extra recursive cloud listings, recovery downloads, local hashing, snapshot validation or pruning precede sync. The obsolete capture implementation and its capture-specific tests are removed rather than retained as a hidden option.
- Keep native conflict preservation, the 50% deletion check, final listing checks, normal retries, `--resilient --recover`, two-minute native lock lifecycle, inherited OS worker ownership and existing transfer/time bounds. Initial resync remains limited to a new empty mirror with no baseline; ordinary retries never force resync.
- Acquire worker ownership before writing initial preparation records. An initialized mirror still requires its existing valid initialization marker. Critical, storage, configuration and authorization blockers retain their normal admission rules.
- Leave all existing recovery files opaque and untouched, including old staging and expired/corrupt snapshots. Removing the producer is not permission to delete old versions or automatically clear a saved failure whose cause may be native sync damage.
- Make the reduced guarantee explicit in the initial confirmation, settings disclosure and setup guide: sync can propagate overwrites/deletions without saving old versions. No automatic native backup-directory policy silently replaces the removed layer.
- Show pending and active retries as neutral status, reserving error alerts for stopped states requiring attention. Say Retrying rather than claiming that native recovery has already begun while only checking files.
- Keep historical backup stage/counter schemas readable in diagnostic history. New production runs report only native checking, transfer and verification progress. Diagnostics remain bounded and contain no account content, paths, credentials or raw provider errors.

## Gates

- Regression tests must assert exact command shape: one native bisync, no wrapper `lsjson`/`copy`, no backup directories and no ordinary `--resync`.
- Existing opaque recovery archives, ambiguous staging and oversized blobs must be unchanged and unable to gate native sync. Invalid/missing baselines, busy worker ownership and saved critical blockers must still stop safely.
- The stock-binary generated-data suite must prove two-way edits, conflict preservation, renames/deletions without snapshots, maximum-deletion refusal, interrupted recovery and Pause/reload behaviour. No personal-account writes are test fixtures.
- Package typecheck/build/tests and shared UI drift checks must pass. Review the changed consent text, retry states, recovery errors and file-safety disclosure in rendered BB at desktop/narrow widths with keyboard focus.
- Before updating a running plugin, use supported Pause after the active run finishes. Preserve mirror identity, baselines, failed history, account binding and all existing recovery files. Update only iCloud, restore only the previously enabled eligible mirror through normal controls, and observe a completed scheduled run. Do not use forced resync or a new mirror to make the deployment pass.

## Evidence

- Linux typecheck, build and shared UI checks passed. With stock rclone v1.75.2, all 81 unit/adapter/host tests and 56 scenarios (520 steps) passed, with no skips. Capture-specific tests were retired with the removed feature, not counted as current coverage.
- All 74 rendered-BB cases passed at desktop/narrow widths, including neutral retry messages, unchanged actionable critical alerts, reduced backup consent and the updated file-safety disclosure. The affected narrow screenshots were visually reviewed against BB's connection layout; keyboard focus assertions passed.
- The first Linux scenario run passed 52 of 56 cases. Four strict no-backup-store assertions exposed an old worker-startup directory list that still created an empty `backups` directory. That directory initialization was removed at the source; the tests were not weakened.
- A host interruption removed the disposable test workspace. After an authorized restart, it was recreated and the full Linux gate passed. Supported Pause then confirmed the existing mirror was stopped; protected mirror, baseline, credential-key and recovery files were privately fingerprinted.
- Before this update, the latest sync had failed with native exit 7 after recovery capture, with `recovery_required` and a saved critical blocker. The initialization marker and two baseline listings remain present, but their presence does not authorize clearing that stop. Deployment must preserve this failure and stay paused; a subsequent completed live sync is unverified until the native failure is separately reviewed.
- Runtime commit `3bde0fc` was pushed and only iCloud was updated to 0.1.10. BB reports the plugin running. The original mirror identity, paused failure, last-success timestamp and exit-7 history entry were unchanged. Fingerprints of mirrors, baselines, recovery archives and credential-key files matched the pre-update inspection, and other plugins' versions/enabled states were unchanged.
- A harmless live root-folder browse succeeded after deployment. Recent diagnostics matched the bounded operation/category/evidence format without account content or credentials. The mirror remains stopped for its pre-existing native critical blocker; it was not resumed, rebuilt or forced through resync merely to complete release evidence. A post-update successful persistent sync remains unverified.
- Attribution-banner removal was independently committed and pushed as `4b18a70`; it requires no plugin update.

The native critical failure needs a separate review before restarting the existing mirror. Removing extra backup work is not proof that every remaining native listing is fast, nor proof of real Apple authorization-expiry recovery or a phone-to-BB edit round trip.
