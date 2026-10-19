# PA for BB

A **BB plugin marketplace** for a personal work assistant and optional service integrations. Add the PA marketplace to BB, then install only the connections you want: Google Drive/Docs, Calendar, Fastmail, iCloud, Obsidian, and eventually PA core and task-focused abilities. BB is the user-facing product; useful parts of Matt's [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) will move over case by case.

Read [the vision](docs/vision.md) for the intended experience and plugin boundaries. The marketplace lists independent [Google Calendar](plugins/google-calendar/README.md), [Fastmail](plugins/fastmail/README.md), read-only [Google Drive](plugins/google-drive/README.md), [iCloud folder sync](plugins/icloud/README.md), and [Obsidian](plugins/obsidian/README.md) plugins. **Each Calendar installation supplies its own Google Web OAuth client**; Fastmail uses its own MCP OAuth flow. The marketplace provides no shared credentials. PA core and the other planned integrations are not built yet. Adding the marketplace to BB **does not install any plugin**. The PA container provisioner registers the public GitHub repository as a Git-backed marketplace so BB can refresh the catalog without a local checkout.

## Intended shape

BB supports custom Git-hosted marketplace catalogs. The intended repository layout is roughly:

```text
marketplace.json         # BB catalog: independently installed connections
plugins/
  google-calendar/       # BB-native Calendar plugin (Web OAuth + nine tools)
  fastmail/              # BB-native MCP plugin (dynamic granted tools)
  google-drive/          # BB-native read-only Drive/Docs connection
  icloud/                # BB-native protected Apple setup and selected folder sync
  obsidian/              # connected iCloud vault tools and conditional note saves
  pa-core/               # planned assistant guidance and shared behaviour
provisioning/           # reusable Ansible host dependency manifest and role
shared/connection-ui/   # shared connection-screen source
scripts/sync-connection-ui.mjs  # generate self-contained plugin copies
fixtures/               # disposable generated-data verification, not shipped plugins
```

Google Calendar, Fastmail, Google Drive, iCloud, and Obsidian are separate BB packages; the other directory is a future possibility, not a committed release list. Adding the catalog does not install plugins. Each listed plugin needs its own BB package; an optional `.bb/plugins.json` is a *monorepo plugin index*, not the marketplace catalog. The marketplace and plugins can live in the same Git repository. See the pinned [BB configuration guide](docs/references/bb-configuration.md) and [marketplace v2 schema](docs/references/bb-marketplace-v2.schema.json); validate behavior against the BB version in use before building on it.

## Register the catalog on a BB host

Run BB and add this Git-backed marketplace:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git
bb marketplace list --json
```

BB tracks the default branch and periodically refreshes the catalog. `bb marketplace refresh pa-for-bb` checks immediately. A catalog refresh does not install or update any plugins. To install Calendar, run `bb plugin install google-calendar@pa-for-bb` and follow its [OAuth setup guide](plugins/google-calendar/docs/google-oauth-setup.md). To install Fastmail independently, run `bb plugin install fastmail@pa-for-bb` and follow its [connection guide](plugins/fastmail/README.md). To install read-only Drive/Docs, run `bb plugin install google-drive@pa-for-bb` and follow its [OAuth setup guide](plugins/google-drive/docs/setup.md). The GitHub source must contain each plugin before BB can install it.

## What exists today

`plugins/google-calendar/` is a separate BB-native plugin with Web OAuth account management and nine Calendar tools. The Pi extension's behavior informed its Gherkin features; Cucumber tests drive a hexagonal core via fake ports, and adapter/fake-BB tests exercise HTTP, storage, and tool registration. A managed Git marketplace install succeeded on BB, and the PA BB host has completed HTTPS Google authorization for multiple accounts. Live Calendar tool use and the write-approval UI still need end-to-end verification.

`plugins/fastmail/` connects to Fastmail's official MCP endpoint. It discovers granted tool schemas at runtime, including mutation tools in broader grants; no writes have been live-tested through this standalone plugin. Synthetic OAuth/MCP and isolated BB install/disable/remove checks passed. The standalone plugin is connected on production PA; the old Agent Plugins bridge pilot was removed. See its [setup guide](plugins/fastmail/docs/setup.md).

`plugins/google-drive/` adds read-only file search, folder browsing, file metadata/links and Google Docs text reads under a separate Google Web OAuth grant. Synthetic tests cover the grant, API and BB host; live authorization and provider-session reads still need verification. See its [README](plugins/google-drive/README.md).

`plugins/icloud/` adds protected Apple login/2FA, selected folders and persistent one-minute two-way syncing. Its TypeScript core uses a need-shaped cloud port with Cucumber-js specs. From 0.1.10, sync delegates directly to native bisync without whole-folder backups or extra recovery listings; previously saved versions remain untouched. Native safeguards and safe reload handoff remain. See its [setup and recovery guide](plugins/icloud/docs/setup.md) and [current verification record](docs/plans/012-native-icloud-sync.md).

`plugins/obsidian/` connects multiple initialized iCloud vaults and supplies search, reads, metadata, links, tasks, creation, targeted edits and property updates. Connecting grants whole-vault read/write without per-edit confirmations. iCloud owns native coordination, conditional atomic saves, private previous versions and durable receipts; a local save does not verify cloud or device delivery. Generated-data native/BB/provider and rendered checks passed; see the [setup guide](plugins/obsidian/docs/setup.md) and [release evidence](docs/plans/006-obsidian-vault-reading.md#release-evidence) for installed status and remaining limits.

The repository root is a marketplace catalog, not an installable BB plugin.

```sh
npm install --prefix plugins/google-calendar
npm --prefix plugins/google-calendar test          # BB build, Cucumber and adapter tests (including the marketplace catalog)
npm --prefix plugins/google-calendar run typecheck
npm install --prefix plugins/fastmail
npm --prefix plugins/fastmail test
npm --prefix plugins/fastmail run typecheck
npm install --prefix plugins/google-drive
npm --prefix plugins/google-drive test
npm --prefix plugins/google-drive run typecheck
npm install --prefix plugins/icloud
npm --prefix plugins/icloud test
npm --prefix plugins/icloud run typecheck
npm install --prefix plugins/obsidian
npm --prefix plugins/obsidian test
npm --prefix plugins/obsidian run typecheck
node scripts/sync-connection-ui.mjs --check    # generated UI copies match shared source
```

## Documents

- [`marketplace.json`](marketplace.json) — BB catalog listing Calendar, Fastmail, Drive, iCloud and Obsidian separately.
- [Fastmail plugin](plugins/fastmail/README.md) — single-account MCP setup, grant semantics, security and test limits.
- [Google Calendar plugin](plugins/google-calendar/README.md) — installation, Web OAuth, tool coverage, and current verification limits.
- [Google Drive plugin](plugins/google-drive/README.md) — read-only Drive/Docs setup, tool coverage and verification limits.
- [iCloud plugin](plugins/icloud/README.md) — selected folder sync, protected Apple setup, recovery and verification limits.
- [Obsidian plugin](plugins/obsidian/README.md) — whole-vault tools, coordinated writes, setup and recovery limits.
- [Host provisioning](provisioning/README.md) — pinned rclone/ripgrep requirements; inventory, services and private deployment stay in the infrastructure project.
- [Shared connection UI](shared/connection-ui/README.md) — common account/status/onboarding components and generated-package workflow.
- [Verification fixtures](fixtures/README.md) — isolated native and installed-BB checks using generated data.
- [Observability standards](docs/o11y-standards.md) — safe diagnostics, partial failures, and verification gates for plugins.
- [Google OAuth setup guide](plugins/google-calendar/docs/google-oauth-setup.md) — step-by-step instructions for a new installer.
- [Vision](docs/vision.md) — product direction: BB marketplace, PA core, optional integrations and abilities.
- [Roadmap](docs/roadmap.md) and [iteration ledger](docs/plans/README.md) — priorities and plans.
- [Calendar iteration plan](docs/plans/001-marketplace-calendar.md) — historical implementation plan; see the plugin README for current setup and verification status.
- [Fastmail spike findings](docs/plans/002-fastmail-mcp-findings.md#follow-up-isolated-live-proof) — historical bridge pilot and the standalone successor.
- [Upstream BB references](docs/references/README.md) — pinned snapshots of BB marketplace documentation and schema.
