# Fastmail connection experiment

This is a **retired Agent Plugins-spec experiment**, not an installable Fastmail plugin. Its pinned bridge and fixture passed an isolated read-only proof and were briefly used on production PA, then removed when the [standalone Fastmail plugin](../../plugins/fastmail/README.md) connected. Do not reinstall this fixture for normal use. No OAuth grants were copied between installations. The [iteration findings](../../docs/plans/002-fastmail-mcp-findings.md#standalone-successor) preserve the historical evidence.

`agent-plugin/` supplies one server using the official Fastmail endpoint. It contains no credentials, copied tool schemas, account identifiers, or workflows. Read-only access must be selected during Fastmail consent; the JSON cannot enforce it. Agent Plugins is a separately trusted prerequisite.

Run the credential-free public discovery check with Node 22 or later:

```sh
node experiments/fastmail-mcp/probe.mjs
```

The probe makes three unauthenticated GET requests. It follows the resource metadata URL in the challenge, restricts requests to Fastmail's origin, rejects redirects, and has a timeout. Success only proves public discovery. It never registers an OAuth client or requests account data.

For an isolated experiment or authorized single-user pilot, install the [tested bridge fork](https://github.com/mattwynne/bb-plugins/commit/16d6dce2a2a87ce243c703c21a41531030f683ef) explicitly, then install the absolute path to `agent-plugin/` through its Agent Plugins page. Approve only `fastmail` and choose **Read data only** during Fastmail consent. On a remote browser, the `http://localhost` callback will fail to load: paste the full URL from the browser address bar into the bridge's **Callback URL for fastmail** field in BB, not into chat or logs. Discover tools at runtime; do not invent or persist their schemas here. Do not grant write or send access to complete this experiment.
