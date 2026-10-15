# 013 — iCloud native bisync retry classification

Status: iCloud 0.1.11 installed from `515b0b8`; generated-data recovery and a completed live scheduled sync verified.

## Decision

Stock rclone v1.75.2 can exit 7 for either a retryable resilient abort or a critical abort requiring resync. The exit code, intact listings, and provider prose do not prove which occurred. A complete, exact native JSON log marker with pinned source metadata may classify a new run as retryable. Conflicting, missing, malformed, truncated, or oversized observations remain blockers. No automatic resync or retrospective clearing of saved blockers is permitted.

Observe stderr in bounded records without saving raw output. Persist only fixed `native` decisions and the exact native `listing_failure` reason when proven, alongside existing bounded exit evidence and stage. These diagnostics explain rclone's decision, not the underlying provider response or whether a write applied. Old failures cannot be reclassified from history or listing files.

## Verification

- On isolated non-root Linux with stock rclone v1.75.2: package typecheck, shared connection-UI drift check, plugin build, 56 scenarios (520 steps), and all 87 unit/adapter/host/native tests passed with **zero skips**. Generated local fixtures proved exit-7 retryable listing abort, ordinary subsequent retry, resync-required transfer lockout, and the real `run()` path without a progress reporter.
- Synthetic private sentinels in records, messages, causes, and stored failure evidence were excluded from logs/history. Tests covered forged source/message, conflicting markers, chunk boundaries, malformed and oversized records, SQLite reload, safe attributable failure logs, and preserved saved blockers. The controlled provider/form diagnostic test passed without sentinel leaks.
- Tests use only generated local data, not an Apple account. Before deployment, the existing stopped mirror was recovered separately through an approved checkpointed correction of its saved admission blocker and an ordinary supported retry. The original mirror completed successfully without resync, rebuild, baseline reset or credential replacement. The underlying cause of its historical exit 7 remains unknown.
- Only iCloud was updated to 0.1.11 from `515b0b8` after supported Pause prevented new runs. The paused mirror identity, last-success timestamp, failure state and 2,824 protected file fingerprints were unchanged across update; other plugins' versions and enabled states were unchanged. A harmless Apple folder read succeeded, and only the previously enabled mirror was resumed.
- The installed version completed scheduled run 347 successfully in 46,953 ms; persistent history retained prior failures and the mirror remained enabled. Scoped logs contained bounded historical diagnostics with no new failure entry. Real Apple outages and authorization expiry were not induced; live success does not prove those failure paths. No UI was changed.
