# BB host requirements for iCloud sync

The plugin must detect and explain these prerequisites rather than assume a
particular machine, account, network or provisioning system.

- **Runtime:** a supported BB/Node.js environment on Linux, with stock rclone,
  `/usr/bin/flock` from util-linux and mounted procfs exposing child-process
  metadata to BB's service user, provisioned by the host as specified in
  [ADR 0001](../adrs/0001-provision-rclone-on-the-pa-host.md). Use the reusable
  [host dependency manifest and Ansible role](../../provisioning/README.md)
  from a pinned repository revision; keep deployment-specific configuration in
  the consuming infrastructure project.
- **Vault search:** stock ripgrep on BB's service-user PATH. The host manifest
  pins the Linux-validated 14.1.0 release. This is a search-only requirement;
  missing ripgrep must not disable sync, ordinary reads or durable saves.
  Plugin support for this search capability is being implemented in
  [iteration 016](../plans/016-ripgrep-vault-search.md).
- **Storage:** persistent writable space for mirrored files, configuration,
  cache, sync baselines and bounded recovery copies. Use host-provided locations;
  keep credentials and operational state outside synced folders and plugin code.
- **Permissions:** run syncing as BB's ordinary service user. Do not require
  plugin code to install packages or invoke sudo.
- **Secrets:** protected persistent credential storage with separately protected
  encryption keys. Account form payloads must bypass agent context and logging.
- **Background work:** a supported worker mechanism that survives chat turns,
  preserves state across restarts, prevents overlapping jobs and stops safely.
  The iCloud worker uses an operating-system flock inherited by command
  children so exclusivity survives a parent crash until the last child exits.
  Procfs inspection lets a replacement generation defer to a live predecessor
  without signalling it or replacing live lock/socket paths.
- **Networking:** outbound HTTPS to Apple and authenticated BB settings access.
  Do not expose a public rclone control endpoint.
- **Resources:** bound disk, CPU, memory and network use; report insufficient
  capacity without destructive recovery.

Document supported hosts and operator installation steps. User setup remains in
BB settings and requires no filesystem paths, terminal commands or infrastructure
knowledge. No Mac relay or Obsidian desktop installation is required.
