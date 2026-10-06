# Iteration 002 findings: Fastmail MCP connection

Recorded 2026-10-05. The initial investigation below found that the bridge's localhost callback could not be opened directly from a browser on another machine. **A subsequent isolated BB experiment completed read-only Fastmail sign-in using a pasted localhost callback URL.** See [Follow-up: isolated live proof](#follow-up-isolated-live-proof) for the current outcome. No production PA BB configuration or grants were changed.

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

## Initial callback gate: failed for a remote browser without forwarding

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

## Initial live result matrix

| Check | Pi through BB | Second provider through BB |
| --- | --- | --- |
| Fresh-session discovery | Not run: callback gate | Not run: callback gate |
| Narrow mail read | Not run | Not run |
| Narrow calendar read | Not run | Not run |
| Narrow contacts read | Not run | Not run |
| Google Calendar coexistence/source attribution | Not run | Not run |

Consent, authenticated transport, restart, reconnect, reauthorization, disconnect, and rendered setup/error states remain unverified. Public discovery and mock OAuth are not substitutes for these checks.

## Initial packaging decision and next falsifiable experiment

An Agent Plugins package is the smallest candidate: two JSON files and a visible bridge prerequisite. Connection controls live in Agent Plugins. Its package update/remove workflow is separate from BB's bridge update/remove workflow; removing the bridge affects every package using it. Neither the fixture nor the reviewed BB catalog mechanism establishes a one-install Fastmail experience. Do not silently install the bridge or advertise this fixture in our marketplace.

A BB-native Fastmail plugin could own a clearer connection and approval interface, but would take on MCP/OAuth lifecycle work. The callback gap alone does not justify that duplication. First extend/upstream the bridge; no upstream changes or messages were sent during this spike.

Acceptance experiment:

1. Use an isolated BB data directory and distinct port, without copying PA settings or credentials. Install the bridge from the pinned commit, reviewing the full-trust confirmation. Verify managed installation and record the resolved source. The supported source form is `git:https://github.com/patleeman/bb-plugins.git@bf78d8767cd4a354985196e1cadaeee49d8102b7` with `--subdirectory packages/bb-plugin-agent-plugins`.
2. Test a synthetic callback from the actual remote browser to the configured public route. It must reach the bridge and reject invalid state without disclosing request values. Test valid mock PKCE, wrong/missing/replayed state, provider cancellation, timeout, and restart during consent. Keep codes and tokens outside logs and transcripts.
3. Only after that gate passes, install the fixture and invite Matt to consent to **read-only** access. Select only Fastmail; record no account identifier. Verify transport and discovery separately.
4. In fresh Pi and another available BB provider session, choose runtime-discovered read tools for one narrowly bounded operation in each domain. Record pass/fail and counts only. Confirm provider/account/calendar attribution and coexistence with Google Calendar without copying private results into the notes.
5. Restart, reconnect, reauthorize, disconnect, and disable. Verify stale tool IDs cannot access a disabled connection and that Google Calendar still works. Test mutation denial and interaction requests with mocks, not real writes. Review first-run, connected, empty, and error UI states.

If remote callbacks cannot safely pass BB routing, reconsider a native connector with established MCP/OAuth components. If they pass, ship the small package only after the provider matrix and honest install/update/remove documentation are complete.

## Follow-up: isolated live proof

The initial recommendation to use a public HTTPS callback did **not** work with Fastmail's MCP dynamic client registration: a credential-free registration experiment returned `invalid_redirect_uri` for both the private PA HTTPS hostname and an owned public HTTPS domain. Fastmail accepted `http://localhost` with the bridge's callback path and routing query. This is an observed constraint of the MCP dynamic registration endpoint, not a claim that Fastmail can never register an HTTPS client manually.

The reviewed bridge already had a `finishAuthentication` RPC that accepts a callback URL and validates its OAuth state through the existing gateway, but no UI to invoke it. An [isolated fork change](https://github.com/mattwynne/bb-plugins/commit/16d6dce2a2a87ce243c703c21a41531030f683ef) ([upstream PR](https://github.com/patleeman/bb-plugins/pull/10)) uses `localhost` for the loopback redirect, exposes a paste-back form in the bridge UI, checks the pasted callback's origin/path/server context before the state/PKCE exchange, and lets the browser callback route run without a BB session. Automated tests cover wrong and replayed state, route access, callback URL validation, and the form. The upstream bridge is still a separately trusted prerequisite; the fork is **not** a Fastmail plugin release.

On an isolated BB **0.45.0** instance on the PA host, the fork installed from that pinned commit and the fixture installed from this repository. The bridge reached Fastmail's consent screen with a `localhost` callback; Matt selected **Read data only**, copied the failed browser redirect into the BB form, and completed the connection. No callback URL, code, state, token, account name, or provider result was added to Git. One earlier callback was pasted into a chat by mistake; its pending OAuth state was canceled before a new sign-in was used. Never paste these URLs into chat.

| Live check in isolated BB | Result |
| --- | --- |
| One Fastmail authorization | Connected; MCP server `ready` without an error |
| Tool discovery | 12 tools, all read-only by observed name/catalog; no mutation tool exposed under the read-only grant |
| Narrow mail search | Succeeded; no private results retained in findings |
| Calendar list | Succeeded; names and details withheld |
| Narrow contacts search | Succeeded; no private results retained in findings |
| BB restart | Connection remained `ready`; all 12 tools rediscovered |
| Invalid synthetic callback | HTTP 400; response did not disclose the supplied code |

These calls were made through BB's plugin CLI against the isolated instance; they do **not** yet prove agent tool use in a fresh Pi and a second BB provider session. Writes, browser-rendered UX review, reauthorization, disconnect/disable, update/remove behavior, and a one-install Fastmail marketplace experience remain unverified. Do not copy the isolated OAuth grant into production.

### Production pilot installation

With the isolated read-only proof complete, the same pinned bridge fork and Fastmail fixture were installed and approved on the **single-user production PA BB instance** as a two-part pilot. Matt chose **Read data only** again and pasted that installation's localhost callback URL directly into the BB form; the sandbox grant was not copied. Production now reports the Fastmail server `ready` without error, exposes the same 12 read-only tools, and successfully ran narrow mail and contacts searches and a calendar-list read through BB's plugin CLI. Private results were not retained. Google Calendar remains running. This is **not** a PA marketplace entry or a general Fastmail release. Restart durability on production and agent use in fresh Pi and another provider session remain unverified; the isolated BB restart did pass. Do not claim write safety from these reads.

### Capability policy for the release

Matt chose to make the tools available under the user's Fastmail MCP consent, **including mutation tools if the user grants them**. Read-only was a cautious choice for the live proof, not a permanent restriction or a reason to build a tool-name denylist. Let Fastmail enforce its scopes and preserve its tool and interaction semantics; do not add a second Fastmail-specific approval layer. Agent actions still need a user request, must treat provider content as untrusted, and must not blindly retry an uncertain mutation. Test the mutation call path with mocks and document its limits without performing real writes just to satisfy the release gate. The bridge pilot's production authorization stayed read-only until the pilot was removed. See the standalone successor below; its grant was chosen separately by Matt.

### Standalone successor

A [standalone BB Fastmail plugin](../../plugins/fastmail/README.md) is now listed in the PA marketplace alongside Google Calendar. It uses Fastmail's official MCP endpoint and the official MCP client directly, discovers tool schemas at runtime, and owns its connection and tool lifecycle without an Agent Plugins dependency. Automated tests cover synthetic OAuth/PKCE, callback rejection, paginated tool discovery, grant-dependent mock mutation forwarding, BB tool selection, and disconnect. An isolated BB 0.45.0 install/disable/remove passed; no provider content or tokens were committed.

The standalone plugin was installed from the marketplace on production PA, authorized with a **new** grant, and reports a connected catalog of 30 tools. That count does not prove particular scopes or a successful live write. The retired Agent Plugins Fastmail fixture was removed with its local data, then the bridge plugin was uninstalled. Google Calendar remains running. A fresh Pi smoke-test thread was stopped and deleted before it produced verified tool-call evidence; live standalone mail/calendar/contacts reads and write calls in provider sessions remain to be checked.

The Fastmail settings UI was reviewed in running BB at desktop and narrow widths for first-run, pending callback, safe error recovery, connected status, and keyboard focus. It now follows [the UX standard](../ux-standards.md) where the provider exposes enough information. The MCP `list_identities` tool returns send-from addresses, not proof of the login username. The UI shows only the one address explicitly marked as the default sender, labelled as such, and falls back when no unambiguous default is available. The old bridge's provider-side authorization may still need manual revocation in Fastmail even though its BB credentials were deleted.
