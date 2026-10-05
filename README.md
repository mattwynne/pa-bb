# PA for BB

A planned **BB plugin marketplace** for a personal work assistant and optional service integrations. The idea is to add the PA marketplace to BB, then install only the plugins you want: a PA core, Google Drive/Docs, Calendar, email, and eventually task-focused abilities. BB is the user-facing product; useful parts of Matt's [PA project](https://github.com/mattwynne/pa) and [Pi extensions](https://github.com/mattwynne/pi-extensions) will move over case by case.

Read [the vision](docs/vision.md) for the intended experience and plugin boundaries. The repository has a valid `marketplace.json` catalog, but **no installable PA plugins yet**. Adding the marketplace to BB installs nothing. The root BB plugin remains a non-production packaging spike; do not install it as PA. The PA container currently copies this empty catalog to a local `path:` marketplace; no GitHub remote has been configured for this repository yet.

## Intended shape

BB supports custom Git-hosted marketplace catalogs. The intended repository layout is roughly:

```text
marketplace.json         # BB catalog: currently empty; lists plugins when ready
plugins/
  pa-core/               # assistant guidance and shared behaviour
  google-calendar/       # example integration
  google-drive/          # example integration
```

The plugin directories are a direction, **not** the current file layout or a committed list of first-release plugins. Adding the catalog does not install plugins. Each listed plugin needs its own BB package; an optional `.bb/plugins.json` is a *monorepo plugin index*, not the marketplace catalog. The marketplace and plugins can live in the same Git repository. See the pinned [BB configuration guide](docs/references/bb-configuration.md) and [marketplace v2 schema](docs/references/bb-marketplace-v2.schema.json); validate behavior against the BB version in use before building on it.

## Register the catalog on a BB host

For local testing, run BB and add the checkout as a `path:` marketplace:

```sh
bb marketplace add path:/absolute/path/to/pa-bb
bb marketplace list --json
```

The PA container provisioner instead copies `marketplace.json` into its persistent home and registers that copy, so the path does not depend on this checkout existing on the server. This registers an **empty catalog**, not the packaging spike. A future distributable marketplace needs a published Git source and independently installable plugin entries.

## What exists today

The root `package.json` and `server.ts` define a minimal BB plugin. Its harmless nested Pi extension registers `/pa-bb-discovery-spike`; there are **no** Google tools, connected accounts, OAuth flow, account-connect UI, PA core, or marketplace catalog. The plugin can opt in to registering that extension in a chosen Pi agent directory. Its purpose is to test packaging and Pi discovery, not to deliver a usable assistant.

Local tests have verified that an `npm pack` artifact includes the extension without lifecycle scripts, that an isolated Pi directory discovers it in fresh RPC processes after install/update, and that explicit cleanup removes the plugin-owned registration without touching unrelated settings or credentials. The BB entrypoint's load/reload behavior has been tested with a mock BB API only. These tests **do not** prove a real BB build or marketplace install.

```sh
npm test                 # registration and mocked BB-entrypoint tests
npm run smoke:packed     # isolated npm-pack/install and Pi RPC discovery test; needs pi on PATH
```

`smoke:packed` uses temporary directories, not a real Google account or your normal Pi agent directory. There is no local `bb` executable in the environment where this spike was built; `npm pack` is not `bb plugin build`.

### Important spike limitation

The plugin reconciles its Pi registration on load, not on install alone, because managed install paths may change on update. It does **not** unregister on dispose: BB also disposes plugins on reload and shutdown. Until a safe disable/uninstall hook is proven, an opted-in installation needs explicit cleanup **before deleting its installed files**:

```sh
node spike/cleanup-registration.mjs /absolute/path/to/pi/agent
```

That command removes only a registration it owns; it does not delete credentials. A real BB build, install, update, disable/uninstall, Pi-provider session, and OAuth callback still require testing.

## Documents

- [`marketplace.json`](marketplace.json) — the empty BB marketplace catalog; no plugin is advertised until it is ready.
- [Vision](docs/vision.md) — product direction: BB marketplace, PA core, optional integrations and abilities.
- [Google plugin plan](docs/plans/pa-bb-plugin.md) — earlier Google-focused implementation proposal and packaging-spike notes; **not** the overall product architecture.
- [Upstream BB references](docs/references/README.md) — pinned snapshots of BB marketplace documentation and schema.
