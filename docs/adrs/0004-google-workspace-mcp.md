# 4. Use Workspace MCP behind a thin Google Workspace plugin

Date: 2026-11-09

Status: accepted; implementation and live replacement are separate milestones.

## Context

Our Google Drive plugin has grown into a custom Drive, Docs and Sheets
implementation. The Docs work in particular accumulated a document model,
planners, verification rules, approval flows, write coordination and recovery
machinery. This is more software to maintain than the requested workflows need,
and its restrictions make ordinary document editing difficult.

[Taylor Wilsdon's Google Workspace MCP server](https://github.com/taylorwilsdon/google_workspace_mcp)
already implements Drive file/folder operations, rich Docs editing, Sheets,
Calendar and Gmail. It offers useful editing abstractions, including Markdown and
heading-addressed sections, rather than only a transport for raw Google API
requests. It is MIT-licensed and can accept existing Google access tokens.

We want useful Google Workspace capabilities without maintaining a second
Workspace application. Authentication should remain understandable inside BB;
introducing another backend must not require another Google sign-in merely
because the implementation changed.

## Decision

Build a new, independently installable **`google-workspace`** BB plugin around
upstream Workspace MCP. Initially enable **Drive, Docs, Sheets, Calendar and Gmail**,
not every Google service the server supports. Gmail includes reading, attachments,
drafts, sending, labels and filters under the account's granted permissions. This plugin may eventually replace
`google-drive` and `google-calendar`; building or installing it does not authorize
removing, switching or disconnecting those plugins.

### Keep our connector thin

Upstream owns Google operations and document/spreadsheet behaviour. Our plugin
owns the BB integration: account selection, connection status, runtime lifecycle,
tool discovery/registration and translation of results into BB's supported form.
Forward upstream tool schemas and semantics rather than recreating an editing
API around them. Prefix tool names so old and new plugins can coexist.

Run a pinned upstream version locally over loopback HTTP in external-token mode.
The first implementation targets `workspace-mcp` **2.3.0**. Account for its Python
runtime in installation and support; this is not a zero-dependency replacement.
Treat upstream upgrades as normal dependency updates, not permission to fetch
unreviewed latest code on each startup. Prefer upstream fixes over a growing
private fork.

### Keep Google authentication in BB

BB remains responsible for Google authorization and refreshing tokens. Supply a
fresh short-lived access token to upstream for the selected account. Do not give
upstream another refresh-token store or send the owner through its standalone
Google login flow.

Reuse the existing Google Cloud OAuth app and Web client where configured;
register Workspace's own callback alongside the existing callbacks. No separate
upstream OAuth app is needed. Enable the Gmail API and configure the required
Gmail scopes in that project. Google verification requirements depend on those
scopes and how the OAuth app is distributed.

Workspace needs its own usable combined connection flow in the initial scope,
because existing Drive and Calendar grants do not authorize Gmail. Ask for the
selected services in one Google consent flow. Adding Gmail requires explicit
additional consent; existing tokens do not silently acquire mail access. This is
a permission expansion, not a permanent second authentication system.

Copy existing Web client settings through caller-checked, server-only RPCs where
available, or enter that same client ID and secret in Workspace. Do not build a
token-delegation system between plugins: it would not supply Gmail permissions
and would add an avoidable dependency. The combined Workspace grant is separate
from the old user grants. Retiring the old plugins must not leave Workspace
dependent on their authentication.

### Build confident software

An explicit user request supplies intent; the connected Google grant determines
available access. **Do not add per-action approval prompts in this plugin.** Honor
interactions actually required by Google or BB, but do not invent another layer
of confirmation to demonstrate caution.

Do not port our concurrent-edit framework, durable operation journals,
interrupted-write recovery engine or document-planning system into the connector.
Those are not requirements for this replacement. Retain upstream's behaviour
rather than rebuilding our former guarantees around it.

Keep protections that address real problems: select the correct account, keep
credentials private, treat provider content as data rather than instructions,
and report failures honestly. The connector must not automatically replay a
failed call: a write may already have succeeded. More generally, justify added
friction and machinery by a concrete user need or failure, not hypothetical
completeness or security theatre.

## Alternatives considered

- **Continue the native implementation:** retains control, but also the expanding
  feature backlog, restrictive workflows and maintenance burden we want to remove.
- **Wrap [`googleworkspace/cli`](https://github.com/googleworkspace/cli):** a credible
  standalone binary with existing-token support and broad API coverage. Its Docs
  helper appends plain text; rich editing primarily exposes raw Google API
  requests. Choose MCP's existing higher-level tools instead of rebuilding those
  abstractions around the CLI. The CLI repository explicitly says it is not an
  officially supported Google product.
- **Wrap `workspace-cli`:** adds a subprocess and printed-output interface while
  still requiring the same MCP server. Connect directly to MCP instead.

## Consequences

We maintain less service-specific code and inherit broader capabilities, but
also depend on upstream behaviour, releases and runtime availability. This is a
deliberate trade, not a claim of exact parity with our old implementation or every
Google editor feature.

Test our boundaries: token reuse and refresh delegation, account routing, tool
forwarding, runtime lifecycle, safe diagnostics and the rendered BB experience.
Use upstream tests for upstream editing behaviour rather than duplicating them
here. [ADR 0003](0003-layered-hexagonal-testing.md) still applies to the connector;
it does not require bringing upstream's document model into our codebase.

This supersedes plan 025's custom-engine direction **for the new plugin**, not the
behaviour of existing installations. Do not carry its capability ledger forward
as a prerequisite. Retire old code and plugins only through a separately verified
cutover. The [delivery workflow](../plans/021-git-first-pa-updates.md) and
[observability standards](../o11y-standards.md) remain applicable. Implementation
sequencing and verification results belong in [plan 027](../plans/027-google-workspace-mcp.md),
not this decision record.
