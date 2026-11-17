# Architecture decision records

These records explain consequential choices and their trade-offs. Keep superseded
records so their original reasoning remains discoverable. Implementation tasks and
migration sequences belong in [plans](../plans/README.md).

| ADR | Status | Decision summary |
| --- | --- | --- |
| [0001 — Provision rclone as a BB host dependency](0001-provision-rclone-on-the-pa-host.md) | Accepted | Provision stock rclone separately from the iCloud plugin; the host owns installation and the plugin owns sync behaviour and user state. |
| [0002 — Release PA components explicitly through one shared pipeline](0002-component-releases.md) | Historical; updater retired | Originally required explicit component releases; current [local-path development](../../CONTRIBUTING.md#local-path-development) uses stock BB and normal Git without a mandatory release stage. |
| [0003 — Adopt a hexagonal (ports-and-adapters) architecture for all plugins](0003-layered-hexagonal-testing.md) | Accepted | Keep all business logic and domain models in the core, with thin adapters and fast core tests. |
| [0004 — Use Workspace MCP behind a thin Google Workspace plugin](0004-google-workspace-mcp.md) | Accepted | Delegate Drive, Docs, Sheets, Calendar and Gmail to upstream; keep Google authentication in BB and build confident software without extra approval or recovery frameworks. |
