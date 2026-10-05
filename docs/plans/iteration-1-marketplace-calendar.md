# Iteration 1: Git marketplace and Google Calendar for BB

## Agreed scope

Publish this repository at `github.com/mattwynne/pa-bb` as a **BB marketplace** and make one independently installable Google Calendar plugin. Matt will manually add the Git marketplace to his running BB instance and install the plugin. This iteration targets **one BB user**, but that user may connect **multiple Google accounts**, each with multiple calendars. Deliver the same nine agent-tool capabilities as the Pi Google Calendar extension. Reusing its code is optional; duplicating it is acceptable if behavior stays in parity.

PA core, Drive/Docs, Gmail, general multi-user account isolation, and migration of existing Pi Desktop OAuth grants are **out of scope**. The existing Pi installation must continue to work untouched.

## Starting point and prerequisites

- `marketplace.json` exists but has **no plugin entries**. The root `package.json` is a harmless Pi-registration spike, not the Calendar plugin. Leave it unadvertised; put the new plugin under `plugins/google-calendar/` with its own BB manifest and dependencies.
- This checkout currently has no Git remote, and `mattwynne/pa-bb` does not yet exist on GitHub. Create and publish the repository before testing a `git:` marketplace. A public repo is the simplest install source; if private, prove BB's Git authentication first. No credentials may enter its history or artifacts.
- The PA container provisioner in `~/git/mattwynne/hub.local/containers/pa/` currently registers an **empty `path:` marketplace** named `pa-for-bb`. Switching the same marketplace to Git requires coordinating that provisioner with removing the path source and adding the Git source; otherwise a future provision may restore the old catalog. Adding a marketplace installs no plugins.
- Provisioning targets BB 0.45.0, but verify the **running** version and the BB SDK/type contract before implementing against it. The root spike pins an older SDK; use an appropriate SDK in the new plugin. Confirm the BB HTTPS public URL (`https://pa.home.wynne.family`) and callback reachability through its existing private access route.
- Supply a Google Cloud project with Calendar API enabled and a **Web application** OAuth client whose authorized redirect exactly matches the plugin callback. The Pi extension's Desktop client and refresh tokens cannot simply be used for this flow. Google testing-mode consent may require an allowlist and periodic reauthorization.

## Delivery sequence and gates

### 1. Publish and install the skeleton

Publish the repo, add a v2 entry in `marketplace.json` whose Git source points to `plugins/google-calendar`, and build a minimal BB-native plugin there. Verify the manifest against [`../references/bb-marketplace-v2.schema.json`](../references/bb-marketplace-v2.schema.json). Use a stable plugin ID (proposed: `google-calendar`) so callback URLs and stored credentials survive updates. For development, a Git ref can follow a known commit/branch; use a tested tag for a release.

**Gate:** On the running host, after retiring the enforced path catalog, manually add the Git marketplace, refresh it, install only Google Calendar, and run one harmless native agent tool in a *new* BB provider session. Use `bb.agents.registerTool` and session configuration rather than the Pi symlink spike. Verify a managed build/install with lifecycle scripts disabled. If marketplace installation or native tool registration fails, fix that before building OAuth or porting Calendar behavior.

### 2. Prove browser connection and durable multi-account storage

Provide an account-management screen/action in BB: configure a Web OAuth client, Connect account, list status, reauthorize, and Remove account. Start authorization through a restricted user-initiated route; use short-lived, one-use state and PKCE, bind the callback to the pending initiation, and handle cancellation/replay. The Google callback may arrive without a BB session cookie; a callback route with `auth: "none"` must not itself grant authority. Validate the redirect, expected scopes, verified Google identity and usable refresh token before saving. Key accounts by stable Google subject, not mutable email; reject duplicate identities and keep Calendar grants separate from other services.

Keep client secrets and refresh tokens in private, plugin-owned persistent storage, never the repository, tool output, transcript, frontend payload, or log. Refresh/update/removal must handle concurrency without resurrecting a removed token. This release assumes only one authorized BB user can access the installation; BB's native tool context does **not** carry an authenticated user principal, so do not present this as multi-user safe. Document revocation, backup implications, and reauthorization after expired/revoked grants.

**Gate:** Connect two distinct Google accounts through the BB browser, including calendars beyond each account's primary one. List both, restart BB, list them again, remove one without affecting the other, and verify state replay/invalid scope/wrong redirect/missing refresh token fail safely.

### 3. Port the nine tool capabilities

Register these BB-native tools under their existing names and retain their argument and result contracts wherever possible:

| Capability | Tool(s) |
| --- | --- |
| Account status and calendar discovery | `gcal_auth_status`, `gcal_list_calendars` |
| Cross-account/calendar search | `gcal_search_events` |
| Explicit account/calendar reads | `gcal_list_events`, `gcal_get_event` |
| Availability | `gcal_free_busy` |
| Writes | `gcal_create_event`, `gcal_update_event`, `gcal_delete_event` |

Preserve explicit account and calendar selection for single-target operations; never silently choose a personal default. Aggregate search should retain selected-plus-primary defaults, `primary`/`all` selection, account and explicit target filters, pagination, merged/deduplicated recurring events with source attribution, bounded results/concurrency, and partial-failure reporting. Retain all-day/timed events, timezone behavior, event moves, and the existing `sendUpdates: "none"` default for writes. Expose reauthentication-required errors without leaking tokens. Port/adapt the Pi extension's tests as behavior fixtures even if implementation code is duplicated. The Pi `/google-calendar` settings command is **not** a BB agent tool; BB's account-management UI replaces its function.

**Gate:** With two live connected accounts, run each of the nine tools in BB. Search across multiple calendars, check an event shared between accounts, and create/update/delete a disposable event. A consequential write must have an explicit, enforceable approval boundary; prompt text alone is insufficient. Prove the actual BB approval mechanism before enabling writes. Fresh sessions must discover the tools after install/update; removal must stop exposing them without deleting unrelated state.

### 4. Verify release and document manual operation

Automate manifest/schema, BB SDK fake-host, mocked Google API, OAuth failure/replay, storage, tool parity, and no-secret-output tests. The fake host does **not** prove HTTP route authentication or browser redirects: test install, Connect, callback, restart, update, and uninstall on the actual PA BB host as well. Record exact marketplace add/install/update commands and OAuth client setup in the plugin README. Update the root README once real plugin installation works; do not describe spike results as proof of production behavior.

The first iteration is complete only when a fresh BB session installed from the **Git marketplace** can connect two Google accounts, use all nine native Calendar tools (including an approved write), retain grants across restart, and leave the existing Pi Calendar extension and credentials alone.

## Design constraints to resolve early

1. Which BB UI/route affordance gives a safe account-management initiation under the single-user installation, and can Google reach the callback at the configured HTTPS URL? Test this before implementing the full OAuth store.
2. How will BB enforce approval for each Calendar mutation? If the SDK cannot provide a safe interactive approval path, do not advertise the write tools as ready until an equivalent enforceable flow exists.
3. What is the exact deployed BB/SDK version and managed artifact format? Pin the plugin implementation to what the running host actually supports.
