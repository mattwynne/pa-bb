# Fastmail connection experiment

This is an **unreleased Agent Plugins-spec fixture**, not a BB plugin or a read-only enforcement layer. Do not install it on the production PA host. The [iteration findings](../../docs/plans/002-fastmail-mcp-findings.md) explain the remote OAuth callback blocker and outstanding live checks.

`agent-plugin/` supplies one server using the official Fastmail endpoint. It contains no credentials, copied tool schemas, account identifiers, or workflows. Read-only access must be selected during Fastmail consent; the JSON cannot enforce it. Agent Plugins is a separately trusted prerequisite.

Run the credential-free public discovery check with Node 22 or later:

```sh
node experiments/fastmail-mcp/probe.mjs
```

The probe makes three unauthenticated GET requests. It follows the resource metadata URL in the challenge, restricts requests to Fastmail's origin, rejects redirects, and has a timeout. Success only proves public discovery. It never registers an OAuth client or requests account data.

For a subsequent isolated BB experiment, first establish a reachable callback using the acceptance test in the findings. Install the reviewed bridge explicitly, then install the absolute path to `agent-plugin/` through its Agent Plugins page. Approve only `fastmail` and have the user select read-only consent. Discover tools at runtime through the bridge; do not invent or persist their schemas here. Do not grant write or send access to complete this experiment.
