# Contributing to PA for BB

Read [the vision](docs/vision.md) for the intended product and [AGENTS.md](AGENTS.md) for repository working rules. Keep public documentation portable; private deployment configuration belongs in the consuming infrastructure project.

## Develop a plugin

The repository root is a marketplace catalog, not an installable plugin. Each package lives under `plugins/` and builds independently. To work on one:

```sh
npm install --prefix plugins/fastmail
npm --prefix plugins/fastmail test
npm --prefix plugins/fastmail run typecheck
```

Replace `fastmail` with `google-calendar`, `google-drive`, `icloud` or `obsidian` as appropriate. Check the [plugin guides](README.md#available-integrations) for additional requirements and verification steps. Calendar's tests also validate the marketplace catalog; Drive's tests build the sibling Calendar package for cross-plugin checks.

Tests use generated data and fake credentials. Real native iCloud tests need an explicit pinned `RCLONE_TEST_BINARY`; without it, their platform/binary gates skip them. A default passing test run is not proof of native sync or a successful provider call.

## Shared connection screens

Shared connection-screen source lives in `shared/connection-ui/`; plugins carry generated copies so they can be installed separately. Edit the shared source, not those copies:

```sh
node scripts/sync-connection-ui.mjs          # regenerate after editing shared source
node scripts/sync-connection-ui.mjs --check  # check for drift
```

Follow the [shared UI guide](shared/connection-ui/README.md), [UX standards](docs/ux-standards.md) and [observability standards](docs/o11y-standards.md). UI changes need review in running BB, including narrow screens and keyboard use; a passing build is not a substitute.

## Host provisioning

The dependency manifest and reusable Ansible role live under `provisioning/`. See the [provisioning guide](provisioning/README.md) for supported platforms, version pins, safe upgrades and validation commands. Inventory, service lifecycle, storage and secrets stay outside this public repository.

Run its manifest and syntax checks when changing provisioning. Those checks do not prove an applied host or an idempotent repeat run; record private deployment verification in the infrastructure project.

## Integration checks and screenshots

[Verification fixtures](fixtures/README.md) contain standalone generated-data checks. A reusable [local disposable integration-test environment](docs/problems/local-integration-test-environment.md) is still needed; that note links to the earlier experiment in Git.

Use isolated installations and generated data for rendered checks and public screenshots. The [screenshot notes](docs/screenshots/README.md) distinguish the README's example settings from real account or tool-call evidence. Never publish credentials, private account content or deployment details.
