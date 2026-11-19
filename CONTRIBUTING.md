# Contributing to PA for BB

Read [the vision](docs/vision.md) for the intended product and [AGENTS.md](AGENTS.md) for repository working rules. Keep public documentation portable; private deployment configuration belongs in the consuming infrastructure project.

## Develop a plugin

The repository root is a marketplace catalog, not an installable plugin. Each package lives under `plugins/` and builds independently. To work on one:

```sh
npm install --prefix plugins/fastmail
npm --prefix plugins/fastmail test
npm --prefix plugins/fastmail run typecheck
```

Replace `fastmail` with `google-workspace`, `icloud` or `obsidian` as appropriate. Check the [plugin guides](README.md#available-integrations) for additional requirements and verification steps. Fastmail's tests also validate the marketplace catalog. Workspace's `test:host` script checks its built BB handlers and storage without Google access.

Tests use generated data and fake credentials. Real native iCloud tests need an explicit pinned `RCLONE_TEST_BINARY`; without it, their platform/binary gates skip them. A default passing test run is not proof of native sync or a successful provider call.

## Local-path development

Use stock BB with plugins permanently installed from a Git checkout through its supported local-path mode. The public marketplace remains available for people who want managed Git installations; it is not the source workspace for local development. No PA updater or BB fork is required.

**Edit → reload → try → commit and push.**

1. Inspect the branch, edited files and unpushed commits. Work in an isolated Git worktree and preserve unrelated changes. Confirm which checkout the intended BB installation actually loads; a separate worktree is not automatically applied there.
2. Edit the plugin, run affected checks, then build/reload it through BB's supported local-path lifecycle. Keep its ID, configuration, enabled state and persistent data. Never patch BB-managed packages or caches. Pause and drain file-writing integrations first, preserving recovery state and prior enablement.
3. Try the applied code in BB with a harmless read, bounded logs and rendered review where appropriate. Reloading does not commit or push; reviewing unpublished work does not require publication.
4. Commit only owned changes, then integrate and push through normal Git when authorized. For incoming changes, inspect local work, fetch and fast-forward only when safe, then verify/reload/try. Stop on divergence and resolve it explicitly; never silently reset, stash or overwrite work. Package versions and a checkout matching `origin` do not prove which code BB has loaded.

Moving an existing managed installation to a local path is a separate, authorized deployment task. Verify a state-preserving route for that actual installation; never uninstall/reinstall a configured plugin or edit BB's private database. If safe application is unavailable, use a disposable BB preview and report the limit. Portable application provisioning, plugin discovery and service definitions live in `provisioning/`. The consuming infrastructure project supplies checkout paths and private settings; neither project maintains a separate plugin list.

Use native BB/runtime update controls for the host and normal Git for plugin code. Versioned distribution releases are optional, not a development prerequisite. Follow the [delivery skill](.agents/skills/release-and-deploy/SKILL.md) and respect review, deployment and publication holds.

## Shared connection screens

Shared connection-screen source lives in `shared/connection-ui/`; plugins carry generated copies so they can be installed separately. Edit the shared source, not those copies:

```sh
node scripts/sync-connection-ui.mjs          # regenerate after editing shared source
node scripts/sync-connection-ui.mjs --check  # check for drift
```

Follow the [shared UI guide](shared/connection-ui/README.md), [UX standards](docs/ux-standards.md) and [observability standards](docs/o11y-standards.md). UI changes need review in running BB, including narrow screens and keyboard use; a passing build is not a substitute.

## Host provisioning

The application entrypoint and reusable Ansible roles live under `provisioning/`. See the [provisioning guide](provisioning/README.md) for supported platforms, safe setup, default-on native development watchers and validation commands. Infrastructure supplies inventory, identity, storage, access, backups and secrets. PA owns its application service definitions and plugin setup.

Run its manifest and syntax checks when changing provisioning. Those checks do not prove an applied host or an idempotent repeat run; record private deployment verification in the infrastructure project.

## Integration checks and screenshots

[Verification fixtures](fixtures/README.md) contain standalone generated-data checks. A reusable [local disposable integration-test environment](docs/problems/local-integration-test-environment.md) is still needed; that note links to the earlier experiment in Git.

Use isolated installations and generated data for rendered checks and public screenshots. The [screenshot notes](docs/screenshots/README.md) distinguish the README's example settings from real account or tool-call evidence. Never publish credentials, private account content or deployment details.
