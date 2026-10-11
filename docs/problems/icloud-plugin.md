Drafted by Matt's robot

# iCloud Drive support for BB

Status: first implementation built; live Apple/disposable-vault verification pending. See [plan 004](../plans/004-icloud-sync.md) and the [plugin README](../../plugins/icloud/README.md) for delivered behaviour and limits.

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

Use the [pinned rclone documentation](../reference/rclone/README.md) for the
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
- **File safety:** retain recoverable conflicting versions and independent,
  bounded backups. Define rename and deletion behaviour. Pause on failures;
  never automatically resync or clear locks to bypass an error.
- **Private credentials:** use encrypted persistent storage with separately
  protected keys. Keep secrets out of synced folders, agent context, arguments,
  environment values and logs. Use BB's protected form/backend boundary.
- **Safe development:** use a disposable vault. Access to personal data,
  whole-Drive syncing and destructive tests require explicit approval.

Follow repository instructions and [UX](../ux-standards.md) and
[observability](../o11y-standards.md) standards. Ship through the marketplace and
verify setup, recovery and folder selection in running BB. See
[host requirements](../reference/bb-host-requirements.md) for runtime prerequisites.
