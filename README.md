# PA for BB

A planned **BB plugin marketplace** for a personal work assistant and optional service integrations. The idea is to add the PA marketplace to BB, then install only the plugins you want: a PA core, Google Drive/Docs, Calendar, email, and eventually task-focused abilities. BB is the user-facing product; useful parts of Matt's [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) will move over case by case.

Read [the vision](docs/vision.md) for the intended experience and plugin boundaries. The marketplace now lists one independently installable [Google Calendar plugin](plugins/google-calendar/README.md). **Each installation supplies its own Google Web OAuth client**; the marketplace does not provide shared credentials. PA core and the other integrations are not built yet. Adding the marketplace to BB **does not install the Calendar plugin**. The PA container provisioner registers the public GitHub repository as a Git-backed marketplace so BB can refresh the catalog without a local checkout.

## Intended shape

BB supports custom Git-hosted marketplace catalogs. The intended repository layout is roughly:

```text
marketplace.json         # BB catalog: Google Calendar entry
plugins/
  google-calendar/       # BB-native Calendar plugin (Web OAuth + nine tools)
  pa-core/               # planned assistant guidance and shared behaviour
  google-drive/          # planned integration
```

Only `plugins/google-calendar/` exists today; the other directories are future possibilities, not a committed release list. Adding the catalog does not install plugins. Each listed plugin needs its own BB package; an optional `.bb/plugins.json` is a *monorepo plugin index*, not the marketplace catalog. The marketplace and plugins can live in the same Git repository. See the pinned [BB configuration guide](docs/references/bb-configuration.md) and [marketplace v2 schema](docs/references/bb-marketplace-v2.schema.json); validate behavior against the BB version in use before building on it.

## Register the catalog on a BB host

Run BB and add this Git-backed marketplace:

```sh
bb marketplace add git:https://github.com/mattwynne/pa-bb.git
bb marketplace list --json
```

BB tracks the default branch and periodically refreshes the catalog. `bb marketplace refresh pa-for-bb` checks immediately. A catalog refresh does not install or update any plugins. To install Calendar separately, run `bb plugin install google-calendar@pa-for-bb` and follow [its OAuth setup guide](plugins/google-calendar/README.md). The GitHub source must contain the plugin before BB can install it.

## What exists today

`plugins/google-calendar/` is a separate BB-native plugin with Web OAuth account management and nine Calendar tools. The Pi extension's behavior informed its Gherkin features; Cucumber tests drive a hexagonal core via fake ports, and adapter/fake-BB tests exercise HTTP, storage, and tool registration. A managed Git marketplace install succeeded in an isolated BB 0.45.0 instance with all nine tools and the settings UI registered. **Live Google authorization and installation on the PA BB host have not yet been verified.**

The repository root is a marketplace catalog, not an installable BB plugin.

```sh
npm install --prefix plugins/google-calendar
npm --prefix plugins/google-calendar test          # BB build, Cucumber and adapter tests (including the marketplace catalog)
npm --prefix plugins/google-calendar run typecheck
```

## Documents

- [`marketplace.json`](marketplace.json) — BB catalog listing the Calendar plugin.
- [Google Calendar plugin](plugins/google-calendar/README.md) — installation, Web OAuth, tool coverage, and current verification limits.
- [Vision](docs/vision.md) — product direction: BB marketplace, PA core, optional integrations and abilities.
- [Calendar iteration plan](docs/plans/iteration-1-marketplace-calendar.md) — historical implementation plan; see the plugin README for current setup and verification status.
- [Upstream BB references](docs/references/README.md) — pinned snapshots of BB marketplace documentation and schema.
