# PA for BB

A planned **BB plugin marketplace** for a personal work assistant and optional service integrations. The idea is to add the PA marketplace to BB, then install only the plugins you want: a PA core, Google Drive/Docs, Calendar, email, and eventually task-focused abilities. BB is the user-facing product; useful parts of Matt's [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) will move over case by case.

Read [the vision](docs/vision.md) for the intended experience and plugin boundaries. The marketplace now lists one independently installable [Google Calendar plugin](plugins/google-calendar/README.md); PA core and the other integrations are not built yet. Adding the marketplace to BB **does not install the Calendar plugin**. The root BB plugin remains a non-production packaging spike; do not install it as PA. The PA container provisioner registers the public GitHub repository as a Git-backed marketplace so BB can refresh the catalog without a local checkout.

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

BB tracks the default branch and periodically refreshes the catalog. `bb marketplace refresh pa-for-bb` checks immediately. This discovers the Google Calendar catalog entry, not the packaging spike; a catalog refresh does not install or update any plugins. To install Calendar separately, run `bb plugin install google-calendar@pa-for-bb` and follow [its OAuth setup guide](plugins/google-calendar/README.md). The GitHub source must contain the new plugin before BB can install it.

## What exists today

`plugins/google-calendar/` is a separate BB-native plugin with Web OAuth account management and nine Calendar tools. The Pi extension's behavior informed its Gherkin features; Cucumber tests drive a hexagonal core via fake ports, and adapter/fake-BB tests exercise HTTP, storage, and tool registration. **Live Google authorization and a managed install on the running BB host have not yet been verified.**

The root `package.json` and `server.ts` still define an unrelated minimal **spike**. Its harmless nested Pi extension registers `/pa-bb-discovery-spike`. It is not PA core or Google Calendar; do not install it for Calendar access.

Local tests have verified that an `npm pack` artifact includes the extension without lifecycle scripts, that an isolated Pi directory discovers it in fresh RPC processes after install/update, and that explicit cleanup removes the plugin-owned registration without touching unrelated settings or credentials. The BB entrypoint's load/reload behavior has been tested with a mock BB API only. These tests **do not** prove a real BB build or marketplace install.

```sh
npm test                                # root spike/catalog tests
npm install --prefix plugins/google-calendar
npm --prefix plugins/google-calendar test          # BB build, Cucumber and adapter tests
npm --prefix plugins/google-calendar run typecheck
npm run smoke:packed                    # isolated Pi spike smoke test; needs pi on PATH
```

`smoke:packed` uses temporary directories, not a real Google account or your normal Pi agent directory. There is no local `bb` executable in the environment where this spike was built; `npm pack` is not `bb plugin build`.

### Important spike limitation

The plugin reconciles its Pi registration on load, not on install alone, because managed install paths may change on update. It does **not** unregister on dispose: BB also disposes plugins on reload and shutdown. Until a safe disable/uninstall hook is proven, an opted-in installation needs explicit cleanup **before deleting its installed files**:

```sh
node spike/cleanup-registration.mjs /absolute/path/to/pi/agent
```

That command removes only a registration it owns; it does not delete credentials. For **this old Pi-registration spike**, a real BB install, update, disable/uninstall, and Pi-provider session still require testing; Calendar OAuth and live BB verification are separate plugin work.

## Documents

- [`marketplace.json`](marketplace.json) — BB catalog listing the Calendar plugin.
- [Google Calendar plugin](plugins/google-calendar/README.md) — installation, Web OAuth, tool coverage, and current verification limits.
- [Vision](docs/vision.md) — product direction: BB marketplace, PA core, optional integrations and abilities.
- [Google plugin plan](docs/plans/pa-bb-plugin.md) — earlier Google-focused implementation proposal and packaging-spike notes; **not** the overall product architecture.
- [Upstream BB references](docs/references/README.md) — pinned snapshots of BB marketplace documentation and schema.
