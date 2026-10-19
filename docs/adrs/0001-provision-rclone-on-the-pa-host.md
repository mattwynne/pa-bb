# 1. Provision rclone as a BB host dependency

Date: 2026-10-10

Status: accepted.

## Context

The [iCloud plugin](../../plugins/icloud/README.md) needs two-way background sync
between iCloud Drive and local folders, initially for Obsidian. Users should
configure their connection in BB without managing command-line tools.

## Decision

Use stock rclone for file reconciliation. Provision it as a dependency of the
host running BB, separately from the plugin.

- Pin the release and architecture-specific checksum, initially v1.75.2.
- Provide a root-owned executable at a stable path, runnable by BB's service user.
- Use Linux and provide util-linux `flock` at `/usr/bin/flock`; the plugin uses
  its inherited file-descriptor lock to prevent old and restarted workers from
  overlapping.
- Mount procfs with child-process metadata readable by BB's service user so a
  replacement plugin generation can defer safely to its live predecessor.
- Make installation repeatable and upgrades reversible. Coordinate upgrades with
  active workers; preserve sync state.

The iCloud plugin owns login/2FA, protected credentials, folder selection,
automatically managed local storage, worker lifecycle, status and recovery.
It checks rclone compatibility but does not install packages or invoke sudo.
Other BB hosts must provision the documented dependency too. The reusable
[Ansible role and dependency manifest](../../provisioning/README.md) live in this
repository. Infrastructure projects consume a pinned revision and own their
inventory, VM/container setup, service users, storage and service lifecycle.
Keep private deployment details in those projects, not in this manifest.

Provisioning installs the executable only: no Apple credentials, account
connection or automatic syncing.

## Consequences

Host rebuilds reproduce the dependency; plugin and binary updates remain
separate. Removing the plugin leaves rclone and synced local files intact.

Host provisioning maintains the binary; the plugin maintains the user-facing
connection. We do not bundle a second installer or build an Apple client.
Apple's interface remains unofficial. Sync safety and credential handling follow
the plugin's documented requirements.
