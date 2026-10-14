# Changelog

## [Unreleased]

- iCloud safely removes metadata-free staging only when it contains nothing except empty cloud/local directories. Cleanup takes the worker lock first and uses non-recursive directory removal; files, partials, selectors and ambiguous state remain protected.
- Recovery warnings no longer blame rclone when the stop may come from recovery-copy validation.

- iCloud recognizes stock rclone's exact trust-token expiry error through its private control socket, including after a failed scheduled read. Other provider errors remain retryable rather than being mistaken for expired authorization.
- Reconnect requires explicit Resume for each enabled, recoverable iCloud folder. Paused and retained folders stay stopped, and storage/configuration/critical blockers are preserved.

- iCloud sync now retries ordinary temporary and interrupted failures through its normal protected schedule, shows stale and recovering states clearly, and provides supported Retry, Reconnect/Resume and confirmed fresh-mirror paths without forced resync.
- iCloud recovery keeps conflicts, recovery copies and native partial-transfer evidence instead of silently discarding unique files.
- After fixing a storage or host-configuration problem, an affected iCloud folder can now retry safely without creating a fresh mirror.
