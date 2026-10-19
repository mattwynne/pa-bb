# PA updates are fragmented and need to preserve local work

Status: full update application remains an open capability gap. The read-only
`pa-updates` pilot is implemented; see [verification and delivery](../plans/017-pa-update-discovery-review.md).
Chosen direction: an independently installable `pa-updates` plugin,
using supported BB extension points. No BB fork or upstream change is required
for the initial design; native BB/Pi prompts remain.
[Iteration 017](../plans/017-pa-update-discovery.md) implements release discovery and
read-only local-work review for Google Calendar; it does not install updates.
Session-driven source editing, Git credentials and permission to publish changes
are a separate problem, deferred from this brief.

## Problem

The owner sees separate BB and Pi update prompts, while PA plugins have a
separate update process. There is no single answer to “is PA up to date?” or a
single place to review and install a compatible set of changes.

Updates may originate from laptop development or work committed on the server.
An incoming release must not overwrite unfinished edits or commits that have not
been incorporated into that release. Protection should apply per plugin: local
Obsidian work should not prevent an independent Calendar update.

## Desired outcome

Publish tested PA releases for installations to discover and pull. CI checks and
publishes releases; it does not need credentials to push deployments onto the
server. The browser presents the choice; the server performs the update after
fresh safety checks and an explicit user request.

Provide a **PA updates** footer icon alongside the existing sidebar update
controls. It opens a review showing installed and proposed versions, release
notes, required restarts, and anything blocked by local work. The BB/Pi update
pills and native recovery controls remain intact. Replacing them is not part of
this design; do not fork BB or hide controls with DOM manipulation or CSS.

A PA release should identify the plugin revisions and compatible BB/Pi versions.
This is a proposed release record, not a capability already supplied by
`marketplace.json`. Preserve independent plugin installation: an update must not
install integrations the owner has not chosen.

## Investigation findings

Research inspected published plugin SDK **0.6.15**, used by this repository, and
upstream `get-bb/bb` source at
[`5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62`](https://github.com/get-bb/bb/tree/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62)
(SDK **0.6.57**). These establish source capabilities, not availability on the
installed server. The server was unreachable during this investigation; no live
API, rendered UI or update was verified. The repository's
[pinned configuration guide](../references/README.md) is older than this upstream
source and must not be treated as current API evidence.

### A plugin can contribute a footer entry

`app.experimental_sidebarFooter.register` supports a host-rendered icon action
or a disclosure with plugin-rendered content above the footer. Its contract is
present in SDK 0.6.15 as well as the inspected upstream source. Upstream's
`provider-usage` plugin supplies a comparable disclosure. A PA entry opening an
update review is therefore plausible without modifying BB's DOM.

This is an experimental icon/disclosure API, not a demonstrated replacement for
the native conditional, labelled update pills. Dynamic availability, attention
badges and exact placement still need a rendered proof in the target BB version.

Sources: [footer contract](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/packages/plugin-sdk/src/app-contract.ts)
(`ExperimentalSidebarFooter`),
[provider-usage example](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/plugins/provider-usage/app.tsx).

### Replacing the BB/Pi prompts needs an upstream hook

`AppSidebar` renders `SidebarUpdatesBadge` separately from plugin footer items.
That component derives BB and provider update pills from the update inventory;
it does not consult a plugin replacement or visibility setting. The footer
customization preferences cover ordinary footer items, not these update pills.
No supported suppression hook was found in the inspected source.

This is a limitation we accept, not a dependency to resolve for `pa-updates`.
Leave the native prompts and unrelated machine-attention warnings alone. Do not
turn off BB update support simply to remove its prompt. A future supported
replacement hook could be evaluated separately; no upstream issue or change has
been submitted.

Sources: [native update pills](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/apps/app/src/components/sidebar/SidebarUpdatesBadge.tsx),
[sidebar composition](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/apps/app/src/components/sidebar/AppSidebar.tsx),
[footer preferences](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/apps/app/src/components/sidebar/sidebarFooterPreferences.ts).

### Existing APIs provide building blocks, not a bundled updater

The plugin frontend's `useSdk()` exposes public SDK areas. SDK 0.6.15 declarations
include `system.appUpdate`, `system.applyAppUpdate`, `hosts.providerCliStatus`,
`hosts.installProviderCli`, `plugins.checkUpdates` and `plugins.applyUpdate`.
Upstream retains these and adds experimental plugin update jobs. This offers
existing mechanisms to investigate before inventing shell-based installers.

However, the inspected apply requests do not select exact release targets:

- BB accepts `confirmInterruptingThreads`, not a requested version.
- Provider CLI installation accepts a provider and action kind, not a version;
  the inspected Pi maintenance command targets its package's `latest` release.
- Plugin update application follows the installation's tracking source, rather
  than accepting a commit in the apply request.

Do not call these independently and claim to have installed a tested bundle.
Exact target selection, prevention of target changes between review and apply,
and verification of the resulting combination remain design gaps. Reusing
existing APIs must also preserve the local-work checks below; their presence
does not establish that those checks already exist.

Sources: [system SDK](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/packages/sdk/src/areas/system.ts),
[plugin update requests](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/packages/server-contract/src/api/plugins.ts),
[BB update request](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/packages/server-contract/src/api/system.ts),
[provider CLI requests](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/packages/host-daemon-contract/src/local.ts),
[Pi maintenance](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/plugins/provider-pi/src/bridge/provider-maintenance.ts).

BB's launcher can own a BB update and restart, with active-thread confirmation
and a persisted outcome. That does not make a plugin/BB/Pi sequence atomic or
restart-safe. BB explicitly does not automatically roll back application
updates; database migrations can prevent downgrades. Plugin activation snapshots
are not a rollback guarantee for the whole release. See upstream
[update lifecycle](https://github.com/get-bb/bb/blob/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62/docs/configuration.md#in-app-updates).

## Plugin-only design

### Entry and review

Register a host-rendered footer icon labelled **PA updates** through the existing
experimental disclosure API, following `provider-usage`. Keep the entry available
whether updates exist or not; a conditional pill or dynamic badge is not required
for the first slice. The disclosure supplies the changing status.

The panel shows:

- **Checking**, **Up to date**, **Updates available**, or **Could not check**.
  A failed or stale check must not look like a current successful result.
- Installed and proposed versions, release notes, and the last successful check.
- Per-plugin outcomes such as **Ready**, **Blocked by local changes**,
  **Check unavailable**, **Updating**, **Updated** and **Failed**.
- **Check again** and, once safe application is implemented, **Review update**.
  The review names exactly which plugins will change and which will be left
  alone. Confirmation is **Update selected plugins**, not an ambiguous promise
  to update all of PA.

Show a safe explanation for each blocker and the next action, such as committing
and publishing local work. Do not expose local paths or diffs in general status
or logs. Read-only discovery needs no installation approval. Applying an update
requires explicit confirmation; no operation should install merely because the
panel opened.

### Backend responsibilities

The plugin backend checks a configured trusted release source on a bounded
schedule and on request. Store the last validated result and check outcome so
browser reloads do not start competing polls. Validate release records as data,
not executable commands, and compare only already-installed PA plugins.

The backend, not browser state or an agent's assertion, owns safety checks and
application. Associate protected development checkouts with plugin IDs, account
for shared dependencies, serialize update jobs, and recheck at application time.
An unknown target, failed check or unavailable safe installation mechanism blocks
that update. Resolve exact targeting through supported installation semantics
before enabling Apply; post-install verification alone cannot make installing
the wrong revision safe.

The panel reconnects to recorded outcomes rather than inferring success from a
closed request. Never promise an atomic bundle or automatic rollback. Removing
`pa-updates` leaves installed integrations and BB/Pi's native controls intact.

### BB and Pi in this design

Initially show BB/Pi installed and available versions where supported, with a
route to BB's existing Updates settings for their native review and actions.
Label these separately from PA plugin changes. This is one useful overview, not
yet a single tested BB/Pi/plugin bundle. Failure to read BB/Pi status must not
silently mean they are current.

Coordinated BB/Pi installation can follow only when supported APIs can select
the intended targets and safely handle active sessions and BB restarts. Do not
work around missing APIs by modifying BB, disabling its controls or substituting
arbitrary package-manager commands. That limitation does not block plugin
release discovery or the subsequent guarded plugin-update slice.

## Local-work safety rules

Keep the development checkout, managed installed code and persistent account
data separate. Deployments must not update the development checkout as a side
effect. Associate development checkouts with the plugins they protect explicitly;
a clean managed install alone is not proof that no local work exists.

For each requested plugin update:

- Modified, deleted, staged or untracked source files block it. Ignore normal
  ignored build outputs and runtime data, not arbitrary untracked source.
- Local commits whose relevant changes are missing from the release also block
  it. A clean working tree is not sufficient. Define comparison across branches,
  merges and cherry-picks before implementing this check.
- Unexpected edits to installed code block replacement and are preserved.
  Establish the expected installed artifact without treating BB-generated build
  output as hand edits.
- Relevant shared-code changes block dependent plugins. A supported independent
  update may proceed despite unrelated dirty work; a required compatible group
  must wait together.
- Missing checkout information or a failed safety check is not “clean”. Name the
  blocker and leave that component untouched.

Never automatically stash, reset, clean, force-pull, rebase or discard work.
Recheck immediately before application and prevent concurrent editing or
competing updates from invalidating that check. Record the target, actual
installed revision and per-component outcome. Partial completion is not “PA is
up to date”; blocked components need a clear next step.

## Stories and first slice

1. **Discover and review a PA update.** A `pa-updates` footer disclosure shows a
   published, validated release record, installed/proposed plugin versions and
   local-work blockers. Start with one plugin without background syncing, leave
   BB/Pi unchanged, and keep native prompts. This read-only first slice proves
   the supported UI surface and release comparison without risking local work.
2. **Apply one plugin update safely.** Add explicit install, fresh safety checks,
   exact-target verification and live read-only confirmation. Prove that a dirty
   target is untouched, a clean independent target can update, and unpublished
   commits or shared edits cannot be silently lost. Preserve credentials,
   settings, enablement and unrelated plugins.
3. **Include BB/Pi status.** Show supported version information and open native
   Updates settings for actions. Keep their existing prompts; no BB fork or
   prompt-suppression work is needed.
4. **Coordinate BB and Pi.** Resolve exact target selection, compatibility,
   ordering, active-session consent and durable continuation across BB restarts.
   Report partial failures without promising automatic downgrade.
5. **Support background-sync updates.** Pause scheduling, drain active work,
   update, restore prior enablement and observe completion. An idle snapshot is
   not an update reservation.

## Boundaries and open decisions

- How are release records published only after CI and other required gates,
  authenticated, and bound to immutable source revisions? Do not treat a remote
  manifest as arbitrary shell instructions. No server deployment credentials
  should be needed by the publishing job.
- How are supported partial combinations declared, and which updates must apply
  together? A bundled offer is not automatically an all-or-nothing transaction.
- Which host's Pi installation is managed? Start with the server's selected host;
  do not silently update every enrolled machine or the browser's computer.
- Updating the running `pa-updates` package itself needs a handoff that survives
  its replacement; defer that mechanism from the first slice. Giving a PA
  session authority to edit, commit and publish its own source remains a
  separate problem, not a prerequisite for pulling laptop-authored releases.
- No BB fork, native-prompt suppression, unattended installation, conflict
  resolution, host provisioning changes or blanket `plugin update --all`. Keep
  private deployment configuration outside this repository.

Follow [UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md). Test unavailable release feeds,
malformed records, failed checks, concurrent edits, interrupted updates and
partial results with synthetic data and safe diagnostics. Review discovery,
no-update, available, blocked, applying, restart and recovery states in running
BB at desktop/narrow widths with keyboard navigation before claiming delivery.
The investigation itself implemented no plugin or release pipeline. Iteration
017 now supplies the read-only discovery pilot and gated metadata publisher;
application, prompt suppression and coordinated upgrades remain excluded.
