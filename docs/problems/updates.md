# PA updates are fragmented and need to preserve local work

Status: full update application remains an open capability gap. The read-only
`pa-updates` pilot is implemented; see [verification and delivery](../plans/017-pa-update-discovery-review.md).
Chosen direction: an independently installable `pa-updates` plugin,
using supported BB extension points. No BB fork is planned; native BB/provider
prompts remain. The read-only design needed no upstream change, but exact-target
application is now blocked on a missing supported installation contract.
[Iteration 017](../plans/017-pa-update-discovery.md) implements release discovery and
read-only local-work review for Google Calendar; it does not install updates.
[Iteration 018](../plans/018-pa-platform-updates.md) now plans reviewed integration,
BB application, Pi CLI and Codex CLI versions on the selected PA execution host,
with local-plugin customization choices and no whole-platform version number.
Its [Gate 0 proof](../plans/018-pa-platform-updates-gate-0.md) is **blocked**: real
managed updates on BB 0.45.0 and 0.46.1 installed a newer branch commit rather than
the previously reviewed target. Runtime/session/restart feasibility is unproved.
The accepted mock-ups cover the earlier plugin-only scope, not restart consent.
Session-driven source editing, Git credentials and permission to publish changes
are a separate problem, deferred from this brief.

## Problem

The owner sees separate BB and provider CLI update prompts, while PA plugins have a
separate update process. There is no single answer to “is PA up to date?” or a
single place to review and install a compatible set of changes.

Updates may originate from laptop development or work committed on the server.
Most installations will not customize their plugins. The normal task is
**update my PA platform**, not select and maintain each plugin separately. Local
customizations are an exception: identify the changed plugin and ask whether to
keep its local version or explicitly replace it with the released version.
Never silently overwrite local work.

## Desired outcome

Publish tested PA releases for installations to discover and pull. CI checks and
publishes releases; it does not need credentials to push deployments onto the
server. The browser presents the choice; the server performs the update after
fresh safety checks and an explicit user request.

Provide a noticeable **PA update available** pill near the left-hand footer
when a new release exists, opening a platform-level review with release notes
and an **Update PA** action. A supported app-wide overlay can supply the labelled
pill; its responsive placement still needs rendered verification. The existing
footer icon remains a quiet entry when nothing is new. Native BB/Pi update pills
and recovery controls remain intact: no BB fork or DOM/CSS-based suppression.

Pin installation to the immutable release the user reviewed. If a newer release
appears meanwhile, install the original reviewed release. The normal update
pill can reappear afterwards; do not add a duplicate newer-release banner or
action to the completion panel. Never silently substitute latest or require
another review merely because a newer release now exists. This does not permit
using a reviewed release whose original contents or integrity have changed.

A PA release should identify exact integration revisions and individual BB
application, Pi CLI and Codex CLI versions, artifact integrity and compatibility.
It has an immutable internal identity, not a whole-platform semver. Runtime
updates apply only to the selected PA execution host, not laptops or all enrolled
machines. This is a proposed release record, not a capability already supplied by
`marketplace.json`. Preserve independent plugin installation: an update must not
install integrations the owner has not chosen.

## Investigation findings

Research inspected published plugin SDK **0.6.15**, used by this repository, and
upstream `get-bb/bb` source at
[`5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62`](https://github.com/get-bb/bb/tree/5e7c06e637102a73ea2dba5c5e2d5d03f09c7c62)
(SDK **0.6.57**). These establish source capabilities, not availability on the
installed server. The server was unreachable during that initial investigation;
no live API, rendered UI or update was verified then. The subsequent
[Gate 0 record](../plans/018-pa-platform-updates-gate-0.md) adds actual isolated
Linux managed-install evidence, not production application or runtime-upgrade
proof. The repository's [pinned configuration guide](../references/README.md) is older than this upstream
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

## Plugin-led review and coordinated application

### Entry and review

Iteration 017 supplies the icon/disclosure pilot. The next design is
platform-first: a labelled update pill opens one **Update PA** review. Normal
users see the reviewed PA release, what is new, any required restart, and the
update action—not a plugin checklist or development-checkout setup.

**Update PA** is the product action, not a new platform-version scheme in the
next iteration. Show individual integration, BB, Pi and Codex versions; do not
invent a PA version in the UI. The reviewed release record still identifies the
fixed set of targets internally.

Only detected local customizations introduce plugin-specific choices:

- **Keep local changes:** leave that plugin's local version untouched while
  updating the remaining compatible components.
- **Use released version:** explicitly replace that plugin's local code with
  the reviewed release. Preserve settings, credentials and account data.

When several plugins are customized, show one review screen, not a sequence of
dialogs. Put those plugins under **Local changes**; each defaults to **Keep
local**, with an individual keep/use-release choice. Show the target plugin
version directly in that choice, such as **Use 0.1.2**, and in the confirmation
summary. Under **Also updating**, list the other components and their version
changes without unnecessary controls. Identify the selected execution host and
any session interruption or required restart before confirmation. Show each
plugin's declared BB icon beside its name in both sections and the completion
summary. Offer **Keep all local** and **Use release for all** selection shortcuts;
these select choices but never install by themselves. Summarize exactly which local versions will be retained or replaced
before **Update PA**, and identify retained versions in the completion summary.
If keeping a custom plugin cannot form a supported combination, explain that
dependency rather than silently replacing it or claiming the complete release
was installed. Dependency handling is internal;
“relevant shared code” is not a user-facing category.

Keep local details/source information behind a disclosure. Normal discovery
needs no installation approval and opening the panel never installs anything.
A failed or stale check must remain distinct from “up to date”.

### Backend responsibilities

The plugin backend checks a configured trusted release source on a bounded
schedule and on request. Store the last validated result and check outcome so
browser reloads do not start competing polls. Validate release records as data,
not executable commands. Compare only already-installed supported PA integrations
and the BB/Pi/Codex installations on the selected PA execution host. Unknown
installation provenance or absent required runtimes is a prerequisite to explain,
not permission to install a provider or target another host silently.

The backend, not browser state or an agent's assertion, owns safety checks and
application. Detect installed-code customization against a trustworthy recorded
baseline; a different whole-repository commit alone is not a customization.
Ordinary installations need no development checkout or special opt-out setting.
Where a checkout is explicitly associated with a local customization, preserve
that source as well. Account for dependencies internally, serialize updates and
recheck the reviewed choices before application. New local changes require a
fresh choice, not an automatic overwrite. Missing checkout mapping alone is not
a failure; an unavailable installed-code baseline is genuinely unknown and must
not be presented as clean.

Resolve exact targeting through supported installation semantics before enabling
Apply; post-install verification alone cannot make installing the wrong revision
safe. A newer release notification does not change a previously reviewed target.

The panel reconnects to recorded outcomes rather than inferring success from a
closed request. Never promise an atomic bundle or automatic rollback. Removing
`pa-updates` leaves installed integrations and BB/Pi's native controls intact.

### BB, Pi and Codex in this design

The owner expanded iteration 018 to include the BB application, Pi CLI and Codex
CLI in the reviewed release, not just a link to native status. Each retains its
own version. Native update pills and settings remain available and unchanged.
Failure to read runtime status must not silently mean the installation is current.

This expanded scope is planned, not implemented. Prove exact-target installation
and artifact verification for each runtime, including A-reviewed/B-available,
on the selected PA execution host. Establish active-session drain/interruption
controls and consent, compatibility/order, preserved credentials/configuration,
and durable continuation across BB restarts. The plugin cannot own continuation
while its BB process is stopped; a supported external lifecycle owner or launcher
handoff must be proved rather than assumed. Do not invent a rollback guarantee
for BB migrations or claim that restarted sessions continued safely without tests.

Stop if supported mechanisms cannot satisfy these properties. Do not bypass the
existing plugin Gate 0 failure, modify BB, disable its controls, use floating
latest, or treat arbitrary package-manager commands as an approved replacement
route. Runtime feasibility needs a separate disposable proof; the plugin
counterexample neither proves nor disproves those runtime mechanisms.

## Customization policy and examples

The default is a standard PA installation with no local plugin customization.
Check installed artifacts against their expected baseline without treating
BB-generated builds, normal state or unrelated repository commits as hand edits.
Do not require every owner to configure a development checkout.

If actual local customization is found, ask **keep local** or **use released
version** for that exception. Uncommitted edits and unpublished custom commits
must not be silently lost, but committing/publishing is not mandatory before an
owner can explicitly choose to replace their local version. Keep development
checkouts, installed code and persistent account data separate. Permission to
replace plugin code is not permission to reset a source checkout, delete account
data or erase unrelated changes. Unknown baseline/safety evidence is not proof
of either cleanliness or customization.

| Example | Expected outcome |
| --- | --- |
| Standard installation, no customized plugin | Review one PA release and choose Update PA |
| Calendar is customized | Ask keep local Calendar or use released Calendar; other components remain part of the platform update |
| Several plugins are customized | One exception screen with individual keep/use-release choices and bulk shortcuts; summarize mixed choices before Update PA |
| Owner chooses keep local Calendar | Preserve it and update the rest where compatible; report the retained customization |
| Owner chooses released Calendar | Explicitly replace its local code, preserving settings/connections and unrelated source work |
| New PA release appears after review | Install the original reviewed release; let the normal update pill reappear, without an extra completion banner |
| Same plugin version, unrelated repository changes | Do not invent a local customization or upgrade |

Preserve the reviewed release identity and customization choices through
application; do not widen them when new work or releases appear. Record actual
installed versions and retained exceptions, without an unqualified claim that
all components match the stock release. Continuation and visible outcomes after
a planned BB restart are now required; general connection-drop recovery beyond
that lifecycle remains outside the next iteration.

## Stories and first slice

1. **Discover and review a PA update.** A `pa-updates` footer disclosure shows a
   published, validated release record, installed/proposed plugin versions and
   local-work blockers. Start with one plugin without background syncing, leave
   BB/Pi unchanged, and keep native prompts. This read-only first slice proves
   the supported UI surface and release comparison without risking local work.
2. **Update PA, with customization exceptions.** Provide one platform-release
   review and Update PA action, pinned to that reviewed release. Prove the normal
   no-customization path without checkout setup; ask keep/replace only for an
   actually customized plugin. Verify the resulting release and any retained
   local exception, preserving credentials, settings and unrelated source work.
   Exact-target application and installed-artifact identity remain technical
   prerequisites, not assumptions already proven by the discovery pilot.
3. **Review BB/Pi/Codex targets.** Include individual exact versions and selected
   execution-host identity in the same release review. Preserve native prompts;
   no BB fork or prompt-suppression work is needed.
4. **Coordinate BB, Pi and Codex.** Prove exact target selection, artifact
   identity, compatibility, ordering, active-session consent and durable ownership
   across BB restarts before implementing application. Report partial failures
   without promising automatic downgrade.
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
- Manage BB, Pi and Codex only on the selected PA execution host. Prove its
  installation provenance and lifecycle authority; do not update every enrolled
  machine, a laptop or the browser's computer.
- Updating the running `pa-updates` package itself needs a handoff that survives
  its replacement; defer that mechanism from the first slice. Giving a PA
  session authority to edit, commit and publish its own source remains a
  separate problem, not a prerequisite for pulling laptop-authored releases.
- No BB fork, native-prompt suppression, unattended installation, automatic
  source merging, host provisioning changes or unpinned blanket
  `plugin update --all`. Explicit keep/replace choices are not automatic conflict
  resolution. Keep private deployment configuration outside this repository.

Follow [UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md). Test unavailable release feeds,
malformed records, failed checks, concurrent edits, explicit keep/replace choices
and partial results with synthetic data and safe diagnostics. Review discovery,
no-update, available, blocked, applying, restart and recovery states in running
BB at desktop/narrow widths with keyboard navigation before claiming delivery.
The investigation itself implemented no plugin or release pipeline. Iteration
017 now supplies the read-only discovery pilot and gated metadata publisher;
application and coordinated BB/Pi/Codex upgrades are planned in 018 but blocked;
prompt suppression remains excluded. Self-development credentials are separate:
the owner has rejected workflow-write permission, and release consumption must
not require broader repository publishing authority.
