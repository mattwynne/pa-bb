Drafted by Matt's robot

# BB host requirements for iCloud sync

The plugin must detect and explain these prerequisites rather than assume a
particular machine, account, network or provisioning system.

- **Runtime:** a supported BB/Node.js environment, OS and architecture, with
  stock rclone provisioned by the host as specified in
  [ADR 0001](../adrs/0001-provision-rclone-on-the-pa-host.md).
- **Storage:** persistent writable space for mirrored files, configuration,
  cache, sync baselines and bounded recovery copies. Use host-provided locations;
  keep credentials and operational state outside synced folders and plugin code.
- **Permissions:** run syncing as BB's ordinary service user. Do not require
  plugin code to install packages or invoke sudo.
- **Secrets:** protected persistent credential storage with separately protected
  encryption keys. Account form payloads must bypass agent context and logging.
- **Background work:** a supported worker mechanism that survives chat turns,
  preserves state across restarts, prevents overlapping jobs and stops safely.
  Verify BB's available process and lifecycle APIs before selecting it.
- **Networking:** outbound HTTPS to Apple and authenticated BB settings access.
  Do not expose a public rclone control endpoint.
- **Resources:** bound disk, CPU, memory and network use; report insufficient
  capacity without destructive recovery.

Document supported hosts and operator installation steps. User setup remains in
BB settings and requires no filesystem paths, terminal commands or infrastructure
knowledge. No Mac relay or Obsidian desktop installation is required.
