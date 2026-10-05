# PA BB plugin — packaging spike

This standalone repository is a **non-production spike** for the first step of `docs/plans/pa-bb-plugin.md` and is intended to become a BB marketplace plugin. It contains a minimal BB backend entrypoint and a harmless Pi command (`/pa-bb-discovery-spike`), not the Google tools, credentials, UI, or OAuth. Do not deploy it to PA.

## What is proven locally

- The plugin's `npm pack` artifact contains its nested Pi extension without relying on npm lifecycle scripts.
- After `npm install --ignore-scripts` from that tarball, an isolated Pi agent directory can register the installed extension through an explicitly owned symlink.
- Fresh Pi RPC processes discover the command after install and a managed-path update, then cease discovering it after explicit removal.
- Registration refuses to overwrite an unrelated entry, leaves other Pi settings/extensions and credentials untouched, and is idempotent for the same installed path.
- The BB backend entrypoint requires an explicit absolute Pi agent directory in plugin settings before touching Pi. A mock-BB test verifies load/reload behavior, but does not substitute for a real BB install.

Run `npm test` in this repository for the registration tests. Run `npm run smoke:packed` to pack, install with lifecycle scripts disabled, and verify fresh Pi RPC discovery across install, update, and removal. The smoke test needs `pi` on PATH and never uses a real Google account or the user's Pi agent directory.

## Not yet proven

The upstream BB SDK shows that managed npm and Git cache paths change by version/commit, `onInstall` does not run on update/reload, and `onDispose` also runs at shutdown/reload. The entrypoint therefore reconciles on every load and does **not** unregister on dispose. There is no confirmed disable/uninstall hook: after an explicit disable or uninstall, run `node spike/cleanup-registration.mjs /absolute/path/to/pi/agent` from the installed plugin **before deleting its files**. This command refuses to remove an unowned registration; it never removes credentials or settings.

A real BB `plugin build`/managed install, new BB Pi session, update/reload/disable/uninstall, UI and HTTP callback still need testing against the deployed BB version. The repository has no local `bb` executable, and `npm pack` is **not** a BB build. The first-pass sidecar registration is not a concurrent/crash recovery protocol; it fails closed on incomplete or tampered state. No Google OAuth flow has been attempted.
