Drafted by Matt's robot

# Changelog

## [Unreleased]

- iCloud sync now retries ordinary temporary and interrupted failures through its normal protected schedule, shows stale and recovering states clearly, and provides supported Retry, Reconnect/Resume and confirmed fresh-mirror paths without forced resync.
- iCloud recovery keeps conflicts, recovery copies and native partial-transfer evidence instead of silently discarding unique files.
- After fixing a storage or host-configuration problem, an affected iCloud folder can now retry safely without creating a fresh mirror.
