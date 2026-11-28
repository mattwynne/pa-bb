# Vault scans take about four minutes

Status: open, cause unknown.

## Problem

The scheduled bisync scan is how changes made on other devices reach BB. It's also how conflicts are detected and how anything a push missed gets repaired. A scan of a vault of about 4,000 files now takes about four minutes. A change made on another device can therefore take minutes to reach BB.

Conflict resolution waits for scans too. A conflict only appears once a scan sees both sides changed. If a scan was already running when the edits were made, it misses them, and the conflict waits for the following scan.

## Current evidence

From the plugin's own sync history on 2026-11-28:

- The first stock rclone scan after the switch (`b782bae`, 2026-11-27) took 40 s.
- Later scans of the same vault took 2.5–4 minutes, for example 05:00:41–05:04:39 and 05:05:31–05:09:30 UTC, with four checkers.
- Small folders on the same account finish in a few seconds.

No investigation yet. Candidates:
- Apple's listing rate.
- Rclone's iCloud directory cache.
- Bisync checking both sides after every change.
- Byte-comparing copies that changed on both sides, which downloads both.

Use the plugin's `diagnostics` and `rcloneLogs` RPCs for timings; they hold no file names.

## Desired outcome

Ordinary scans that bring nothing in should finish in well under a minute, using stock rclone options. If iCloud's listing speed is the limit, document it and size the schedule to match.
