# 027 — Google Workspace through upstream MCP

Status: connector implemented with synthetic verification; live Google and rendered BB integration are awaiting owner testing. No live installation, source switch or account mutation has been performed.

Architecture decision: [ADR 0004 — Workspace MCP](../adrs/0004-google-workspace-mcp.md).

## Scope and product rule

A separate `google-workspace` plugin enables **Drive, Docs, Sheets, Calendar and Gmail** through `workspace-mcp` 2.3.0. It owns a combined BB Google connection. Existing Calendar and Drive plugins keep their IDs, configuration, enabled state and tools. Retiring them is a separate cutover.

Build confident software: requested actions run without an extra PA approval prompt. Do not bring over the custom document model, concurrent-edit framework, write journals, planning/recovery system or capability ledger. Keep correct account selection, private credentials and honest outcomes. Do not automatically replay a failed call.

## Architecture

- `core/workspace.mjs` owns account selection, schema adaptation and tool forwarding. It depends on an account port and an MCP port, not SDK, HTTP, database or process types.
- `adapters/mcp.mjs` implements MCP with the official client SDK. `testing/memory-mcp.mjs` implements the same port in memory. Shared contract tests run against both; real adapter tests substitute HTTP, not the SDK.
- `core/auth.mjs` owns Google account/authorization behaviour behind OAuth and account-store ports. OAuth HTTP, real BB SQLite and process lifecycle have separate adapters.
- `server.ts` is the BB composition root. Upstream schemas are discovered at runtime; prefixed tools coexist with old plugins, with generic list/call fallback for unsupported BB schemas.
- One pinned local Python backend runs over loopback HTTP in external-token/stateless mode. It receives only a short-lived selected-account token, never a refresh token. `uvx` is a documented host prerequisite; no upstream Google login is exposed.

See [the port contracts](../../plugins/google-workspace/core/ports.md) and [setup/manual testing](../../plugins/google-workspace/README.md).

## Authentication decision after adding Gmail

The original prototype borrowed existing Calendar and Drive tokens. That would not authorize Gmail and would keep the new plugin dependent on the old plugins. It has been removed rather than expanded into a token-delegation system.

Workspace now reuses the **OAuth app and Web client**, not the old user grants. The old plugins gain only a caller-checked `exportOAuthClientForWorkspace` RPC for one-time server-side client-settings copying. Manual client entry works independently of them. No legacy database access, token export, settings reset or grant modification is needed.

Register Workspace's own callback on the same Web client, enable the five Google APIs, and authorize `openid`, `email`, `drive`, `calendar`, `gmail.modify` and `gmail.settings.basic` in one BB-owned flow. Existing Drive/Calendar permissions do not silently gain mail access. Account for Google's applicable testing/verification requirements without assuming the existing app's publication state.

## TDD and verification

Tests were introduced and observed failing before implementing the corresponding ports/behaviour. Red-to-green increments covered the MCP adapter/double, application forwarding, combined OAuth, real store adapter, BB wiring, Web-client export, Gmail runtime selection and useful unknown-account errors.

Current automated checks:

- 36 fast core/adapter/contract/architecture cases. Measured `npm test`: 0.71 seconds end-to-end on the development host; the Node runner reported roughly 0.22 seconds. No server or Google connection is involved.
- 12 built-BB-handler and real temporary SQLite cases, with synthetic MCP/OAuth.
- Two tests of the actual legacy plugin handlers proving the Web client export rejects browser/unrelated-plugin callers and exports client settings only. The 25 existing Calendar/Drive host regression cases also pass, along with their TypeScript checks and the shared connection UI drift check.
- Workspace build and TypeScript/BB SDK checks pass against BB 0.45.0 / SDK 0.6.15. The legacy-plugin tests use each source plugin's own newer SDK harness.

The small fixture server used by adapter tests is stubbed HTTP, not a running Google Workspace MCP server. Synthetic passes do not establish real Google calls, process execution, refresh after a real token expires, or rendered UI quality.

The owner will manually test integration. In particular: combined consent with the existing app, one harmless read in each service, selected disposable edits if wanted, restart/refresh/reconnect and desktop/narrow/keyboard settings review. No sending, sharing or other real mutation is required as an automated gate. File workflows use upstream's stateless inline/upload-URL paths; automatic BB thread-file handling is not implemented.

## Delivery boundary

The plugin is available as a local-path package, not yet a marketplace entry. No live plugin was installed/reloaded/switched; no Google account was connected or read. Rendered BB and live-provider verification remain **unverified** until the owner performs them. Do not silently apply or publish this work or unrelated local commits while preparing that handoff.

## Earlier research

Research at upstream commit `aa91bf7573006f0e3ff28f23da0a82edee8c8cbf` (Docs/auth/CLI code matches v2.3.0): 603 Docs/CLI tests and 44 authentication tests passed in an isolated environment. Stdio discovery returned 19 Docs tools, or seven in read-only mode. That is historical upstream evidence, not verification of the new BB integration.

`googleworkspace/cli` v0.22.5 successfully forwarded a supplied token in synthetic local read/write calls without a login or credential file. Its Docs helper appends plain text; rich edits use raw Google API requests. The MCP project was chosen for its existing higher-level tools rather than recreating them around the CLI.
