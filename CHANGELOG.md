# Changelog

## [Unreleased]

- iCloud 0.1.11 distinguishes stock rclone's resilient retryable bisync exit 7 from a resync-required lockout using pinned native JSON markers. Only a proven retryable abort enters the ordinary retry path; uncertain output and saved blockers stay stopped. Logs and bounded history now record safe native decisions and a proven listing-failure reason without retaining provider text.
- iCloud 0.1.10 delegates sync directly to native bisync. It no longer takes whole-folder backups, runs extra cloud listings or blocks on legacy recovery archives. Overwrites/deletions no longer have an independent sync-time recovery copy; previously saved copies remain untouched. Rclone's conflict, maximum-deletion, locking and normal recovery checks remain in place, and saved stronger blockers are not automatically cleared.
- Pending/active iCloud retries use neutral status text rather than red error banners; stopped conditions still show actionable errors. Setup and file-safety guidance describe the reduced backup policy honestly.
- Removed robot-attribution banners from repository documentation and report templates.

## Earlier deliveries

- iCloud safely removes metadata-free staging only when it contains nothing except empty cloud/local directories. Cleanup takes the worker lock first and uses non-recursive directory removal; files, partials, selectors and ambiguous state remain protected.
- Recovery warnings no longer blame rclone when the stop may come from recovery-copy validation.

- iCloud recognizes stock rclone's exact trust-token expiry error through its private control socket, including after a failed scheduled read. Other provider errors remain retryable rather than being mistaken for expired authorization.
- Reconnect requires explicit Resume for each enabled, recoverable iCloud folder. Paused and retained folders stay stopped, and storage/configuration/critical blockers are preserved.

- iCloud sync now retries ordinary temporary and interrupted failures through its normal protected schedule, shows stale and recovering states clearly, and provides supported Retry, Reconnect/Resume and confirmed fresh-mirror paths without forced resync.
- iCloud recovery keeps conflicts, recovery copies and native partial-transfer evidence instead of silently discarding unique files.
- After fixing a storage or host-configuration problem, an affected iCloud folder can now retry safely without creating a fresh mirror.
