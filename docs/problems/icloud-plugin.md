# iCloud Drive support for BB

Status: native folder sync and continuous local note access delivered through iCloud **0.2.0**. Live scheduled sync and discovery during native activity are verified; exact cloud/device bytes and real authorization-expiry recovery remain unverified. See the [iteration ledger](../plans/README.md) and [plugin README](../../plugins/icloud/README.md) for delivered behaviour and limits. The original requirements below remain historical context.

Live Obsidian feedback exposed routine sync blocking note access and hiding initialized vaults. The paired 0.2.0 correction is shipped; see [continuous note access during background sync](icloud-continuous-note-access.md) and [plan 015](../plans/015-icloud-continuous-note-access.md) for separate generated-data and read-only production evidence.

## Need

Obsidian is the driver: notes edited on the phone must reach BB, and edits made
through BB must reach the phone without a Mac relay. Build an independent
`plugins/icloud/` plugin and marketplace entry. It supplies synced local folders
to Obsidian and other integrations; it owns Apple authentication and syncing.
Scope: iCloud Drive, including supported app libraries.

## Dependencies and configuration

Host provisioning supplies stock rclone, as specified in
[ADR 0001](../adrs/0001-provision-rclone-on-the-pa-host.md). Detect the installed
executable and supported version; do not hardcode a deployment's username or paths.

Configure an rclone remote with backend `iclouddrive` and service `drive`.
Provide Apple account setup and reconnect through protected BB settings, using
the ordinary Apple password and 2FA. Rclone's default password storage is
obscured, not encrypted; protect the configuration as described below.
No terminal or SSH setup should be required from the user.

Use the [pinned rclone documentation](../references/rclone/README.md) for the
configuration interface and `bisync` options. Allocate configuration, cache,
baselines and mirrored folders in persistent host-provided storage, outside
installed plugin code. Keep credentials and sync state separate from mirrored files.

## Required behaviour

- **Simple setup:** connect one Apple account. Browse and select iCloud folders,
  or explicitly choose whole Drive where supported. Nothing syncs until enabled.
- **No path choices:** BB allocates local storage automatically. Show folders by
  name; consuming integrations select them by name too.
- **Two-way background sync:** use stock rclone `bisync`, independently of chat
  turns. Preserve state across restarts and prevent overlapping runs.
- **Useful controls:** show connection state, last successful sync, errors and
  recovery actions. Support pause, resume, reconnect and disconnect without
  deleting local files. Do not equate worker activity with successful sync.
- **File safety:** use native conflict preservation, maximum-deletion checks and
  interrupted-sync recovery. Define rename and deletion behaviour. Whole-folder
  backups and undo for changes from arbitrary devices are not required; see
  [plan 012](../plans/012-native-icloud-sync.md). Future BB editing tools retain
  the individual file's previous version at their write boundary. Keep stronger
  blockers stopped; never automatically resync or clear locks to bypass an error.
- **Private credentials:** use encrypted persistent storage with separately
  protected keys. Keep secrets out of synced folders, agent context, arguments,
  environment values and logs. Use BB's protected form/backend boundary.
- **Safe development:** use a disposable vault. Access to personal data,
  whole-Drive syncing and destructive tests require explicit approval.

Follow repository instructions and [UX](../ux-standards.md) and
[observability](../o11y-standards.md) standards. Ship through the marketplace and
verify setup, recovery and folder selection in running BB. See
[host requirements](../references/bb-host-requirements.md) for runtime prerequisites.
