# Iteration 002 findings: remote callback blocks the live proof

Recorded 2026-10-05. **Decision: extend the existing bridge's callback support, then repeat the connection gate.** This spike produced a minimal [experimental package and public probe](../../experiments/fastmail-mcp/README.md). It did not establish a working Fastmail connection in BB. No production configuration, grants, or provider data were changed.

## Reviewed versions and evidence

- Target host CLI: BB **0.44.0**, Node **24.18.0**. `bb status` confirmed this repository's project checkout; work stayed on `main`.
- Agent Plugins source: [`bf78d8767cd4a354985196e1cadaeee49d8102b7`](https://github.com/patleeman/bb-plugins/tree/bf78d8767cd4a354985196e1cadaeee49d8102b7/packages/bb-plugin-agent-plugins), package **0.4.0**, requiring BB `>=0.44` and SDK `>=0.5.29`. Source review is pinned to this commit, not to future `main` or a verified installed release.
- The bridge uses `@modelcontextprotocol/client` (`^2.0.0` in its manifest); the checked-in upstream lockfile was used for mock verification.
- BB's live `plugin install --help` supports pinned Git sources and `--subdirectory`. Its guide describes plugins as full-trust code. Installing the bridge trusts executable third-party code; approving a server is an additional, distinct step.
- The upstream repository's catalog lists `agent-plugins` from `main`. A catalog entry and compatible engine declarations are not evidence of a successful marketplace install. **Managed installation on an isolated host was not attempted**, because the callback gate failed first.

## Public Fastmail discovery: observed

Fastmail documents `https://api.fastmail.com/mcp` and separate read, write, and send consent choices in its [official setup guide](https://www.fastmail.help/hc/en-us/articles/15869557281295-Connecting-AI-tools-via-Fastmail-s-MCP-server). Use read-only consent for the next experiment.

The public probe passed on this host:

| Check | Observed result |
| --- | --- |
| Unauthenticated GET `/mcp` | HTTP 401 with a Bearer resource metadata challenge |
| Protected resource metadata | Resource is `/mcp`; authorization server is `https://api.fastmail.com` |
| Authorization discovery | Registration, authorization and token endpoints advertised on Fastmail's origin |
| OAuth capabilities | S256 PKCE and refresh-token grant advertised |

The resource metadata advertises the MCP scope and `offline_access`; it does not establish which tools a read-only grant will reveal. No registration, consent, authenticated initialization, or `tools/list` request was made.

## Mock verification and reproduction

**43 tests passed in six upstream test files**: loader, OAuth provider, deferred OAuth store, OAuth integration, gateway, and MCP fixture. These include synthetic discovery/registration/PKCE, insufficient-scope handling, reconnect, clearing credentials, stalled exchange timeout, disabled-server filtering, and MCP forwarding. They do not exercise Fastmail or the rendered BB application. The experimental JSON files also passed the pinned bridge's `validateManifest`, `validateMcpEnvelope`, and `validateMcpServer` functions using Node's TypeScript support.

Reproduce outside the repository with a fresh temporary checkout (requires Git, Node 24 and Corepack):

```sh
git clone https://github.com/patleeman/bb-plugins.git /tmp/pa-bb-fastmail-review
git -C /tmp/pa-bb-fastmail-review checkout --detach bf78d8767cd4a354985196e1cadaeee49d8102b7
cd /tmp/pa-bb-fastmail-review
COREPACK_HOME=/tmp/pa-bb-corepack npm_config_cache=/tmp/pa-bb-npm-cache pnpm --filter bb-plugin-agent-plugins... install --frozen-lockfile --store-dir /tmp/pa-bb-pnpm-store
COREPACK_HOME=/tmp/pa-bb-corepack pnpm --filter bb-plugin-agent-plugins exec vitest run src/loader.test.ts src/oauth.test.ts src/oauth-store.test.ts src/oauth.integration.test.ts src/gateway.test.ts src/mcp-fixture.test.ts
```

The dependency install compiles native SQLite if no prebuilt binary is available. These tests use local synthetic services and grants; do not substitute real account credentials. From this repository, run `node experiments/fastmail-mcp/probe.mjs` separately for the public Fastmail check.

## Callback gate: failed for a remote browser without forwarding

In pinned [`server.ts`](https://github.com/patleeman/bb-plugins/blob/bf78d8767cd4a354985196e1cadaeee49d8102b7/packages/bb-plugin-agent-plugins/server.ts#L258), the bridge builds the callback from `bb.server.loopbackBaseUrl`, with this path:

```text
/api/v1/plugins/<bridge-id>/http/oauth/callback?pluginId=<installed-package-id>&serverId=fastmail
```

For a server on port 38886 this gives a loopback URL on that port, not the remotely reachable BB URL. A browser on another machine resolves loopback to itself. No externally configurable redirect base is supplied by this bridge. This is a source-level blocker, not an observed failed Fastmail login. Per the plan's first gate, no live OAuth flow was started.

A local SSH forward could preserve the exact loopback host/port if that port is free on the browser machine. That is a possible diagnostic workaround, **not a verified connection plan or finished setup UX**: browser-machine access and forwarding have not been established here.

The smallest product change is an explicitly configured callback base for remote installations, using BB's supported public routing. Before implementing it upstream, verify that BB accepts an unauthenticated OAuth callback on that public route. Do not merely substitute a public hostname into a route that requires a BB login. Preserve PKCE, state validation, issuer binding, and per-server credential storage. Do not derive the redirect from untrusted request headers.

## Bridge boundaries: source review, not live Fastmail results

The pinned [`oauth.ts`](https://github.com/patleeman/bb-plugins/blob/bf78d8767cd4a354985196e1cadaeee49d8102b7/packages/bb-plugin-agent-plugins/src/oauth.ts) delegates discovery and token handling to the official SDK. The server stores OAuth records in a setting declared `secret: true`, keyed by package/server. Its deferred persistence handles callback route writes; real restart durability still requires a BB restart test.

The [`gateway.ts`](https://github.com/patleeman/bb-plugins/blob/bf78d8767cd4a354985196e1cadaeee49d8102b7/packages/bb-plugin-agent-plugins/src/gateway.ts) and server registration show:

- Approved, enabled servers contribute their discovered tools. The bridge's static discovery/describe/call tools remain registered even when no remote server is connected. Disabling a server removes it from enumeration and closes its connection.
- Generic calls forward to the SDK after catalog and server checks. There is no bridge per-tool allowlist or per-call write confirmation in this path. Tool annotations are not an authorization boundary. Actual Fastmail tool visibility under read-only consent remains unknown.
- The gateway has optional interaction hooks, but this server does not wire elicitation, sampling, or roots callbacks. A provider interaction must not be assumed to reach the user.
- Reconnect keeps credentials; reauthorization clears them. Disconnect clears local credentials and closes the connection, but leaves the server enabled. Later discovery can attempt authentication again. Disabling is the durable switch for removing access from discovery. Local disconnect does not prove remote grant revocation.
- Failed calls are surfaced as errors. An error alone cannot distinguish a rejected mutation from a completed mutation whose response was lost. No uncertain-call recovery or safe retry policy for writes was validated.

No write capability is ready to expose. Read-only consent is the intended provider-side boundary for the next live experiment, subject to verification. Provider data must remain untrusted content, and source attribution must survive forwarding.

## Live result matrix

| Check | Pi through BB | Second provider through BB |
| --- | --- | --- |
| Fresh-session discovery | Not run: callback gate | Not run: callback gate |
| Narrow mail read | Not run | Not run |
| Narrow calendar read | Not run | Not run |
| Narrow contacts read | Not run | Not run |
| Google Calendar coexistence/source attribution | Not run | Not run |

Consent, authenticated transport, restart, reconnect, reauthorization, disconnect, and rendered setup/error states remain unverified. Public discovery and mock OAuth are not substitutes for these checks.

## Packaging decision and next falsifiable experiment

An Agent Plugins package is the smallest candidate: two JSON files and a visible bridge prerequisite. Connection controls live in Agent Plugins. Its package update/remove workflow is separate from BB's bridge update/remove workflow; removing the bridge affects every package using it. Neither the fixture nor the reviewed BB catalog mechanism establishes a one-install Fastmail experience. Do not silently install the bridge or advertise this fixture in our marketplace.

A BB-native Fastmail plugin could own a clearer connection and approval interface, but would take on MCP/OAuth lifecycle work. The callback gap alone does not justify that duplication. First extend/upstream the bridge; no upstream changes or messages were sent during this spike.

Acceptance experiment:

1. Use an isolated BB data directory and distinct port, without copying PA settings or credentials. Install the bridge from the pinned commit, reviewing the full-trust confirmation. Verify managed installation and record the resolved source. The supported source form is `git:https://github.com/patleeman/bb-plugins.git@bf78d8767cd4a354985196e1cadaeee49d8102b7` with `--subdirectory packages/bb-plugin-agent-plugins`.
2. Test a synthetic callback from the actual remote browser to the configured public route. It must reach the bridge and reject invalid state without disclosing request values. Test valid mock PKCE, wrong/missing/replayed state, provider cancellation, timeout, and restart during consent. Keep codes and tokens outside logs and transcripts.
3. Only after that gate passes, install the fixture and invite Matt to consent to **read-only** access. Select only Fastmail; record no account identifier. Verify transport and discovery separately.
4. In fresh Pi and another available BB provider session, choose runtime-discovered read tools for one narrowly bounded operation in each domain. Record pass/fail and counts only. Confirm provider/account/calendar attribution and coexistence with Google Calendar without copying private results into the notes.
5. Restart, reconnect, reauthorize, disconnect, and disable. Verify stale tool IDs cannot access a disabled connection and that Google Calendar still works. Test mutation denial and interaction requests with mocks, not real writes. Review first-run, connected, empty, and error UI states.

If remote callbacks cannot safely pass BB routing, reconsider a native connector with established MCP/OAuth components. If they pass, ship the small package only after the provider matrix and honest install/update/remove documentation are complete.
