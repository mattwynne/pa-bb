# Iteration 2: Fastmail MCP connection spike

**Status:** Isolated proof complete; read-only two-part pilot connected on production PA BB. See the [findings](002-fastmail-mcp-findings.md#follow-up-isolated-live-proof): Fastmail accepted a `localhost` callback pasted back into BB, not a public HTTPS callback through MCP dynamic registration. Agent-provider, production restart, and marketplace packaging gates remain. The original investigation plan follows.

## Goal

Find the smallest safe way to offer **one Fastmail connection** in BB, giving access to mail, calendars, and contacts through Fastmail's official MCP service. A user should not install separate Fastmail Mail and Fastmail Calendar integrations. Version 1 needs **one Fastmail account per BB installation**; revisit multiple accounts only if feedback warrants it. Google Calendar is already a separate, working plugin and must remain independent.

The [roadmap](../roadmap.md) puts Fastmail before PA core's cross-provider calendar work. PA's [Fastmail Calendar decision](https://github.com/mattwynne/pa/blob/main/docs/adrs/0006-use-official-fastmail-mcp-for-calendar-access.md) chose provider-native MCP tools over its removed CalDAV implementation and a locally copied MCP schema. Do not revive either path here.

## Prior art to test, not assume

[Agent Plugins for BB](https://getbb.app/marketplace/agent-plugins) ([source and README](https://github.com/patleeman/bb-plugins/tree/main/packages/bb-plugin-agent-plugins)) already claims Streamable HTTP MCP support, OAuth via the official MCP client SDK, secret-backed tokens, connection controls, and dynamic tool discovery through `agent_plugins_list_tools`, `agent_plugins_describe_tool`, and `agent_plugins_call`. It installs Agent Plugins-spec packages with `plugin.json` and `mcp.json`. Inspect the actual release and source before relying on those claims; it is a community plugin, not a BB-core capability.

[Agent Tools](https://getbb.app/marketplace/agent-tools) inventories and syncs provider-native MCP configurations; it is not the same runtime bridge. BB's `bb-bridge` exposes *BB plugin tools to agents* and does not by itself connect BB to an external MCP server. Avoid building another MCP client until the existing bridge has been tested against Fastmail.

## Work and evidence

### 1. Establish the available BB path

Record the target BB version, Agent Plugins version/source, installation route, plugin trust/approval model, and whether BB can install the bridge from the marketplace on the target host. Review its MCP and OAuth documentation/code for the Fastmail-compatible transport, OAuth callback address, secret storage, token refresh, failure states, and how a stopped/disconnected server disappears from agent discovery. In particular, check whether its loopback callback works when BB runs on a remote host but the user signs in from another browser. Do not inspect or publish existing private grants to answer this.

**Gate:** Produce a concrete connection plan with a callback URL that the user's browser can actually reach. If the bridge cannot supply one, record the failure and the smallest needed change; do not start a live OAuth flow that cannot complete.

### 2. Prove the connection without writing provider data

In an isolated BB installation, install the bridge from a reviewed/pinned source. Prepare the smallest Fastmail Agent Plugins-spec package/config pointing to the **official Fastmail MCP endpoint**; use the provider's documented endpoint and OAuth discovery rather than a hard-coded token or copied tool schemas. Approve only the intended server. With Matt's explicit participation for consent, connect one account; check status after BB restart and after reconnect. Do not log tokens, callback codes, message bodies, contact data, or calendar details in the spike notes.

Through **BB**, in a fresh Pi provider session and at least one other available provider session, discover and run one narrowly scoped **read-only** mail, calendar, and contacts operation. Record the tool names/schema shapes discovered at runtime only as ephemeral diagnostic evidence, not a committed compatibility contract. Confirm that Calendar coexists with the installed Google Calendar plugin and that results identify their source. Distinguish OAuth success, transport success, tool discovery, and successful read calls; none proves the others.

**Gate:** All three domains are reachable through the *same* Fastmail authorization in BB, or document the exact blocker and reproduction. A successful Pi-only MCP call does not satisfy this gate.

### 3. Examine mutation and distribution boundaries

Determine whether the bridge advertises write-capable Fastmail tools immediately, whether it offers per-tool restrictions or approval, and what happens when the upstream MCP server requests user interaction. Test these paths with mocks or non-mutating diagnostics first. Do **not** send mail, alter contacts, or create/update/delete/RSVP events merely to complete this spike. If BB cannot enforce an intelligible approval boundary, do not claim writes are ready or expose write tools as a safe feature. Check reauthorization, failure after uncertain calls, logout/disconnect, and whether disconnect removes tool access without affecting Google Calendar.

Evaluate two packaging choices against the same user experience: (a) a Fastmail Agent Plugins-spec package installed through the existing bridge, with the bridge as a visible prerequisite; (b) an independently installable BB Fastmail plugin using proven bridge components or another narrowly justified route. Establish whether BB can actually provide a **one-install Fastmail marketplace experience** without silently installing a trusted third-party plugin. Do not commit to a packaging mechanism until this is tested. No cross-provider PA core work belongs in this iteration.

**Gate:** State exactly which capabilities are safe to expose, how the user sees and manages their connection, and the install/update/remove path. Separate observed behavior from design proposals.

### 4. Decide the next build slice

Add a short findings section to this plan or a linked decision note containing versions, reproducible non-secret setup steps, read-test results by provider and domain, OAuth/restart evidence, write-boundary findings, packaging trade-offs, and remaining risks. Choose one of:

- **Reuse the bridge:** implement/document the Fastmail package and its prerequisite, if connection and trust UX are acceptable.
- **Extend or upstream the bridge:** identify a focused missing capability (such as reachable OAuth callback or approval handling), then re-run the failed gate.
- **Build a BB-native Fastmail connector:** only if the existing route cannot meet the product requirements; reuse established MCP/OAuth components, not a new Fastmail calendar or mail protocol.

An inconclusive result is a valid spike outcome if it names the blocker and the next falsifiable experiment. Do not add a Fastmail entry to `marketplace.json` until there is an installable package with honest setup and safety documentation.

## Constraints

- Work in this repository on `main` as directed by `AGENTS.md`; do not change PA's current Pi configuration or credentials. Use an isolated BB data directory for experiments, not the production PA host, until a safe callback and test plan are established.
- Keep any grants and test data outside Git and model transcripts. Do not print secret settings, provider payloads, or private account identifiers in committed findings.
- BB's current Calendar plugin is single-user; this spike assumes a single-user BB installation too. One Fastmail **account** is a separate limit from the number of BB users. Do not claim multi-user isolation without a principal supplied and enforced by BB.
- Preserve the provider's discovered schemas and interaction semantics. Fastmail data is untrusted content, not assistant instructions. A read-only proof does not establish write safety.
