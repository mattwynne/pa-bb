# PA BB plugin — standalone marketplace design

## Goal

The `pa-bb` project owns its Google integration end to end. The same native Pi Calendar and Drive/Docs/Sheets/Slides tools must work in local PA Pi and in the Pi process launched by the PA BB instance. A BB plugin supplies a browser-based **Connect Google** screen. An opted-in installation brings and registers the Pi extensions on the selected BB/Pi host; PA container provisioning does not enumerate individual extensions.

This is a design, not a claim that BB-hosted Google OAuth or plugin-managed Pi installation already works. Prove the packaging and lifecycle assumptions before migrating live credentials.

## Decision and proposed layout

Use a standalone `~/git/mattwynne/pa-bb` repository for the BB marketplace plugin and the Google provider package. Do not duplicate Google tools as BB agent tools.

```text
pa-bb/
  integrations/google/         # planned credential/OAuth core + Pi tools
    calendar/                   # existing gcal_* logic, migrated from pi-extensions
    drive/                      # existing gdrive_*, gdocs_*, gsheets_*, gslides_* logic
  server.ts                     # BB backend: UI/callback wiring + Pi registration adapter
  src/pi-registration.mjs       # plugin-owned Pi registration
  spike/                       # temporary harmless packaging/discovery fixture
  docs/plans/pa-bb-plugin.md    # this design
```

The exact split within `integrations/google/` is an implementation detail. Keep Google provider mechanics independent of BB UI/host wiring. Move only the PA-specific Google extensions from `~/git/mattwynne/pi-extensions`; leave unrelated global extensions there. For local PA Pi, install or declare the versioned Google Pi package from `pa-bb` and remove its old extension paths so no session loads two copies. Preserve history or document the source commit in the migration. The `pa` repository remains a consumer, not the implementation owner.

Pi tools remain the **single implementation** of Google operations. The BB plugin does not register `gcal_*` or `gdrive_*` as BB tools. BB's Pi provider launches a real Pi process with its own bridge extension; verify that Pi's normal extension discovery loads these tools alongside it. Standalone local Pi in the PA project loads the same versioned Pi package without BB installed. Marketplace users must explicitly opt in to Pi integration; BB installation alone must not alter an arbitrary user's Pi configuration.

## Why not duplicate the tools?

At design time, the Calendar extension contains **9 Pi tools** in roughly 776 lines of `extension.ts`; Drive/Docs/Sheets/Slides contains **34 Pi tools** in roughly 1,507 lines. Event search and merging, document styling/tables, sheet operations, slide construction, Google API calls, schemas, and result formatting live in those tool handlers and helpers. Rewriting them as BB tools would create a large second implementation. Calendar and Drive also each have a roughly 306-line, largely duplicated credential store and a roughly 120-line Desktop/loopback OAuth flow. Extract that shared mechanism instead.

Current local PA configuration: `.pi/settings.json` points at the sibling `pi-extensions` checkout. Current remote deployment: `hub.local/containers/pa/playbook.yml` installs Pi and BB and writes Pi user settings. `containers/pa/container.yml` maps Proxmox `/home/pa` to container `/home/matt`; `containers/pa/bb.service` runs as `matt`. The PA project checkout is **not** automatically present on that container. The BB plugin artifact must therefore be self-contained; it must not import a path from Matt's Mac or assume the whole PA checkout was cloned onto PA.

## Packaging and installation

- Build the BB plugin from this repository with a **pinned, packaged** Google integration dependency containing the Pi extension entries and runtime dependencies. Decide whether to publish a versioned package, pack the workspace into an artifact, or bundle its source with the plugin after an integration spike. Do not rely on local `file:`/workspace links surviving a managed BB install, nor on npm `postinstall`/`prepare`: BB-managed installs disable lifecycle scripts.
- The BB plugin owns a clearly named Pi registration, for example a plugin-owned symlink under `~/.pi/agent/extensions/` or one scoped package declaration in `~/.pi/agent/settings.json`. Choose the method after testing Pi package discovery and BB's managed plugin paths. Use a stable indirection owned by the plugin so updating the managed install does not leave a stale path.
- On startup/update/reload, reconcile that registration idempotently, verify the Pi package and its dependencies, preserve other Pi settings, and report any registration failure. Do not load the same Google extension through both a symlink and a Pi package declaration. Existing Pi processes need reload/restart; new sessions should see the new version.
- Disabling/uninstalling the plugin removes **only** its registration, never credentials. Do not remove it indiscriminately from a generic dispose handler, which also runs on normal reload/shutdown. Verify BB's actual lifecycle API; if it cannot distinguish uninstall from shutdown, document and test an explicit cleanup command rather than promising automatic removal.
- Container provisioning keeps responsibility for installing Pi, BB, and the pinned PA BB plugin, then checking registration health. It should not list `google-calendar` and `google-drive` separately. The plugin should opt in to managing Pi for a particular user/agent directory, not silently modify any arbitrary BB host's Pi installation.

## Shared credentials and authorization

Keep Calendar and Drive **separate grants and stores**. Share the mechanisms for account registry, verified identity, OAuth clients, refresh-token persistence, locking, and secure file access. A minimal backend API should support explicit `service` and `account` selection, account status, begin/complete Web authorization for BB, Desktop authorization for local Pi, token-backed connection for the Pi tools, and removal. The UI and tools must not receive raw refresh tokens.

Preserve the existing Calendar/Drive storage layout if possible: `oauth-client.json`, version-1 `accounts.json` with stable subject hashes, and `tokens/<subject-hash>.json`; preserve private permissions, atomic writes, locks, and compare-before-merge refresh updates. On macOS the existing per-service data directories are under `~/Library/Application Support/`; on Linux they default to `${XDG_DATA_HOME:-~/.local/share}/pi-google-calendar/` and `.../pi-google-drive/`. Keep environment overrides `PI_GOOGLE_CALENDAR_DATA_DIR` and `PI_GOOGLE_DRIVE_DATA_DIR`. On the PA host, BB and its Pi child run as `matt` and see the same persistent directories. A marketplace install must validate the selected Pi agent directory and provide per-user credential isolation; it must not assume that every BB host has the same OS user, directory layout, or single-user trust model. Keep them outside the repo, plugin artifact, and `~/.pi/agent/auth.json`.

The existing Pi commands `/google-calendar` and `/google-drive` use **Desktop OAuth** with a listener on `127.0.0.1`; retain local behaviour. BB needs a **Web application OAuth client** with an authorized HTTPS callback at each installation's BB domain. Marketplace onboarding must explain the OAuth client and redirect configuration (or provide a hosted, verified client with appropriate security boundaries). Changing a Desktop redirect to that URL is not valid. Tokens are tied to the OAuth client and scopes: decide explicitly whether Desktop and Web grants use separate stores or a client-aware registry, and design migration before replacing a client's credentials. A restored Desktop grant may require a fresh, per-account Web consent; never silently reuse it with a different client ID. Calendar-only authorization must not give Drive access. The existing PA 1Password backup is an optional, separate bootstrap route, not part of a build.

The BB settings page should show Calendar and Drive identities and connection status separately and offer Connect/Remove. An authenticated user begins the flow; the server issues short-lived, one-time state and PKCE, tied to that action. Its callback validates state, replay, redirect and requested service; exchanges the code server-side; verifies Google subject/email, granted scopes and a usable refresh token; then persists it under the correct client/service/account. Handle cancellation, missing consent, expiration and reauthorization safely. The callback may arrive without a BB session cookie: test BB's route auth and origin guard with a real Google redirect. Do not rely on an unauthenticated callback alone as proof of the initiating BB user. For PA, the existing HTTPS reverse proxy/Tailscale route should suffice; do not publicly expose BB or the container's loopback listener. Do not assume other marketplace installations share this network setup.

No OAuth secret, code, access/refresh token, PKCE verifier, or unsanitized provider error may appear in Git, frontend/RPC responses, agent tool output, transcripts, logs or telemetry. Protect the host's backup of `/home/pa`, which includes these credentials.

## Behaviour and safety to retain

Preserve all **9 `gcal_*` and 34 Drive-family tool names**, explicit account selection, argument schemas, API behaviour, and response formats. Calendar writes currently default attendee notifications to `none`. Neither extension currently enforces a runtime confirmation for writes; prompt guidance is not an access-control boundary. BB and local Pi should run the same extension code, not similar-looking tool implementations.

## Delivery and verification

1. **Packaging spike:** from an isolated `pa-bb` worktree, build/install a minimal BB plugin and harmless Pi extension, then test startup, fresh Pi RPC session discovery, update, reload, disable/uninstall and cleanup. Check BB's settings UI and exact HTTP callback route. Determine the actual install path and self-contained artifact format; use no Google secrets.
2. **Move Google integration:** move the existing Google Pi tools and tests from `pi-extensions` into this repository's `integrations/google/` with an installable package boundary; update the consumer PA `.pi/settings.json` to load the package. Keep local Pi behaviour and current credential files intact. Retire only the old PA Google registrations.
3. **Share credentials:** deduplicate storage and connection/refresh logic; introduce testable Web OAuth operations with an explicit Desktop/Web coexistence or migration decision. Preserve read/write behaviour for existing Desktop accounts.
4. **Implement BB plugin:** settings UI, callback, safe account status/actions, plugin-owned Pi registration and health checks. Bundle the pinned integration artifact; no BB copies of the Google agent tools.
5. **Deploy PA:** update `hub.local/containers/pa/` to install the pinned plugin and verify its registration. Do not deploy secrets at build time.

Acceptance tests: local Pi works without BB; a clean PA BB plugin install exposes the same 43 native tools to a fresh Pi session without a separate per-extension provisioning step; browser Connect allows read-only calls for one Calendar and one Drive account; grants survive BB restart and container replacement unless revoked; service/account mismatches, wrong state, replay, invalid client ID, missing refresh token and concurrent token refresh/removal fail safely; updating/uninstalling affects only plugin-owned registration, not credentials or unrelated Pi configuration. Run `npm test` in `pa-bb` for every plugin change. When editing consumer PA configuration, also run `npm test` from the PA repo root, per its `AGENTS.md`.

## First spike progress (not a BB-hosted proof)

The repository root now contains a harmless Pi extension, a minimal BB backend entrypoint, plugin-owned symlink registration, and an explicit cleanup command. A local `npm pack` → `npm install --ignore-scripts` → fresh isolated Pi RPC smoke test confirms discovery on install/update and absence after removal. The BB backend has only been exercised with a mock API; no BB build, managed installation, BB Pi session, or Google OAuth has been tested. See `README.md` for commands and limits.

Upstream BB source at commit `4e458bc` indicates that the server factory runs on load/reload, `onInstall` is first-install-only, and `onDispose` runs on shutdown/reload as well as disable. Its managed install path is version/commit-specific. The provider-pi bridge starts Pi RPC with an additional bridge extension, without `--no-extensions`. Consequently the spike reconciles the Pi symlink on each opted-in load and never removes it from dispose. Explicit cleanup is required until a safe disable/uninstall signal is proven. Confirm all of this against PA's deployed BB version before promotion.

## Questions the spike must settle

- Does the packaged PA integration remain importable after BB installs the plugin with lifecycle scripts disabled? Can the BB plugin point Pi at it without depending on a version-specific managed path?
- What BB lifecycle signal, if any, distinguishes uninstall/disable from reload and shutdown? Which process can update Pi registration before a new BB Pi session starts?
- Can BB's callback route associate a pending authorization with the initiating user under PA's actual auth setup, and is the Google HTTPS redirect URI accepted by the chosen consent configuration?
- What migration path preserves existing Desktop grants without encouraging reuse under a different Web OAuth client?

## Source references

- Existing source: https://github.com/mattwynne/pi-extensions/tree/main/extensions/google-calendar and https://github.com/mattwynne/pi-extensions/tree/main/extensions/google-drive
- Pi package and extension docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md and https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- BB Pi provider and SDK: https://github.com/get-bb/bb/blob/main/plugins/provider-pi/README.md and https://github.com/get-bb/bb/blob/main/packages/plugin-sdk/README.md
- Deployment repo: `~/git/mattwynne/hub.local/containers/pa/`
