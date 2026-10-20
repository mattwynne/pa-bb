# 018 — Update PA, with local-customization choices

Status: review/application and native runtime actions implemented; final review
and delivery gates remain open. [Evidence](018-pa-platform-updates-ordinary-proof.md)
includes original integration handlers, real Pi/Codex installs, BB 0.46.0 → 0.46.1
through its launcher, saved receipts across restart, bounded persisted baseline
continuity, real generated paired-sync reservation/reload/restoration, and rendered
desktop/narrow review. Prepared packages: PA updates **0.2.0** and
iCloud **0.3.2**. No production deployment is claimed.

## Owner decisions

**Exact reviewed-target pinning is no longer a requirement.** The owner accepts
a newer released candidate appearing between preview and application. Use BB's
normal supported compatible update mechanisms and report the versions actually
installed. Preview versions are observations, not immutable installation promises.
Do not block on A-versus-B, fixed-tag retargeting or exact runtime version pins.
Do not seek an upstream pinning contract for this iteration.

The [earlier Gate 0 evidence](018-pa-platform-updates-gate-0.md) remains useful
characterization of BB 0.45.0 and 0.46.1, but its exact-target failure is a
**superseded requirement**, not the current acceptance gate.

The intended release includes PA integrations, the BB application, Pi CLI and
Codex CLI on **the selected PA execution host only**. No whole-platform semver,
BB fork, native-prompt suppression, laptop update or all-machines update is
wanted. Source-editing credentials are separate; no workflow-write grant is
approved or needed to consume updates.

## Outcome and scope

An owner sees **PA update available**, reviews what will change, and clicks
**Update PA**. PA installs available compatible released versions through trusted
configured update channels and reports actual outcomes. Most users see no Git,
development checkout, customization controls or plugin-selection checklist.
Only actual local plugin customizations introduce keep/replace choices.

**Update PA is an action, not a new platform version.** Show each component's own
installed → currently available version. Explain that a newer released version
may be installed if the channel advances before application.

Integration scope is already-installed Calendar, Fastmail, Drive, iCloud and
Obsidian from the trusted PA repository. Leave absent integrations absent and
unrelated plugins unchanged. BB's bundled components follow its normal application
lifecycle, not separate PA plugin updates. Missing required runtimes, unknown
installation provenance and unsupported source types are prerequisites to explain,
not permission to install providers or retarget sources silently.

Do not update the running `pa-updates` package through its own executor in this
slice. Bootstrap its new package through the normal delivery process.

### What “released version” means

The existing marketplace entries use `git:https://github.com/mattwynne/pa-bb.git`
with `ref: main` and each plugin's fixed subdirectory. BB's ordinary compatible
update follows that **published main branch**. It does not install an arbitrary
local checkout, unpublished work, a client-supplied commit or a chosen GitHub
release tag. In this flow, “released version” means the compatible plugin code
available through that trusted configured channel when BB applies the update.

The publication process must make main suitable as a release channel: shipped
code is versioned and checked before publication. A previously fetched PA release
record supplies preview notes and compatibility evidence, not a promise that BB
will install its exact commit or that a later candidate was tested by that record.
Do not label a newer installed candidate as covered by older CI evidence.
Repository-only changes and the same plugin version at a different repository
commit must not manufacture an update or a customization warning.

BB/Pi/Codex likewise use their supported configured distribution/update channels.
Inspect and document those channels before implementation; never accept executable
commands, repositories, package names or host paths from a remote release record
or browser request. No arbitrary unpublished-code route or silent source-retarget
operation is authorized.

## UI

The [interactive mock-ups](018-pa-platform-updates-mockups.html) and
[focused image](018-pa-platform-updates-mockup.png) record the earlier plugin-only
design, now refreshed to use **Install released version** rather than exact-version
choices. Target versions remain useful currently-available previews; completion
illustrates an actually installed version newer than its preview. The implemented
runtime rows, named primary host, native restart consent and saved results have
also been exercised in running BB. The notice uses a native dialog containing the
same review component: opening only the footer disclosure leaves a closed mobile
sidebar inert. The ordinary footer entry remains supported.

- Use the labelled **PA update available** pill near the left footer through the
  supported app-overlay slot. Keep the ordinary footer icon when quiet. No
  animation, DOM tricks, hidden native controls or collisions with provider usage.
- The ordinary review shows release notes, component icons and installed →
  available versions, with one **Update PA** action. Identify the selected
  execution host, active-session impact and required restarts before confirmation.
- Put actual customized plugins together under **Local changes**. Each defaults
  to **Keep local**; its alternative is **Install released version**. Show the
  currently available version nearby without promising that exact version.
- **Keep all local** and **Use release for all** select choices only. They do not
  install. The single update action confirms which plugins may be replaced and
  which must remain untouched.
- **Also updating** lists other components and their version previews, with no
  unnecessary controls. Use each plugin's declared BB icon and supported runtime
  branding. Identify code that may be overwritten; credentials, settings and
  account data stay in place.
- Completion names the **actual verified installed versions** and any retained
  local versions. No platform version, duplicate newer-update banner or next-update
  button. The normal footer pill can return after completion if updates remain.
- New remote releases alone do not invalidate authorization. New local code edits
  do: refresh the affected customization choice before overwriting it.
- Failed or partial application shows what actually changed. Do not claim automatic
  rollback or retry an uncertain write blindly.

Follow the [UX skill](../../.agents/skills/bb-plugin-ux/SKILL.md),
[UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md). Mock-up rendering is not a live
BB UI pass.

## Verification scope

Use supported BB/SDK versions and public installation/lifecycle surfaces in
isolated Linux BB with generated data. The historical exact-target counterexample
is not a reason to fail these proofs.

1. **Ordinary managed update:** update multiple installed integrations through
   their trusted configured channels. Preserve registration, settings, secrets,
   enablement, schedules, source intent and operational files. Verify actual
   executable identity, not just package version, history or API success.
2. **Trustworthy customization baseline:** distinguish installed hand edits from
   source/build output and mutable operational data. Account for source, effective
   runtime and assets without requiring a development checkout. An unavailable
   original baseline is unknown, not permission to bless today's bytes as clean.
   A dirty unrelated checkout is not an installed customization. Persist at most
   five active independently reconstructed expected-hash records, keyed by
   integration, source commit and recorded builder. Seed unchanged integrations
   before BB can prune their builders; never learn from installed bytes or build
   a historical artifact/toolchain service.
3. **Keep and replace:** leave a customized plugin byte-for-byte while updating
   compatible siblings, including plugins sharing one cached repository. Explicit
   **Install released version** may replace that plugin's local code, including
   unpublished edits, without deleting data or touching associated source work.
   No shared reset/clean, cache reset or destructive remove/reinstall is allowed.
4. **Review-to-apply safety:** recheck local fingerprints and prerequisites before
   activation and join competing applications. Channel advancement is allowed;
   authorization still applies to the reviewed component set and keep/replace
   decisions. Avoid code edits during native handoff; atomic edit protection is
   outside the accepted scope.
5. **Background work:** for iCloud/Obsidian, prevent new sync runs through supported
   Pause controls, drain active work, retain note operations/baselines, update in
   a compatible order and restore only previously enabled work. Observe completion
   using generated data. Do not clear failures or locks merely to deploy.
6. **Runtime lifecycle:** prove ordinary BB/Pi/Codex updates through supported
   configured channels on the selected execution host. Preserve credentials,
   settings and sessions; verify actual executable versions afterwards. Use BB's
   native interruption consent for its restart. CLI updates do not force session
   resets; existing provider processes may keep old versions until normal release.
7. **BB restart:** prove supported durable lifecycle ownership and continuation
   across BB stopping/restarting. A plugin process cannot supervise its own stopped
   process. BB's native launcher owns the tested restart; the plugin persists
   intent and reconciles its result. Preserve native controls and unrelated hosts.
8. **Host UI:** inspect the actual footer/provider-usage disclosure before fixing
   placement. Record tested BB/SDK versions and portable evidence for each proof.

No direct BB database edits, private server imports, managed-cache resets, BB
forks, destructive reinstall or silent widening of production permissions.
A newer compatible candidate during ordinary application is acceptable. If a
remaining state/baseline/lifecycle property cannot be achieved, report that precise
limitation—not a renamed exact-pin gate—and seek an owner decision on that route.

## Review and application rules

- Compare only supported installed components; omit verified unchanged components and do
  not downgrade newer versions. Source provenance and version/code equality are
  different observations.
- Store a server-owned review with the component set, channel provenance, observed
  versions, fingerprints, compatibility evidence and keep/replace decisions.
  Browser requests refer to that review, never arbitrary commands, paths or refs.
- A newer published candidate may supersede the preview. Recheck supported
  compatibility and safety facts available from BB before starting. Do not claim
  that arbitrary custom code is certified because its version string matches.
- Preflight the resulting released/kept combination, especially the iCloud/Obsidian
  note interface. If a kept version is incompatible, explain before activation;
  never silently replace it or reset its data.
- Join repeated clicks into one job. Use typed, need-shaped ports for review,
  baseline assessment, update, status and lifecycle ownership. No agent mutation
  tool is required; opening the panel or checking updates never installs.
- Persist per-component receipts: reviewed observation, authorized decision,
  activation result, actual verified version/identity and retained exceptions.
  Automatic discovery and reloads retain the displayed result until explicit
  **Check again**. Distinguish waiting/not-updated steps from absent software;
  show actual prerequisites without inventing reasons for skipped receipts.
  Do not store credentials, provider data or arbitrary host exception text.
- Determine dependency-safe ordering from tested component requirements. Do not
  assume BB-first, atomic application or universal downgrade/rollback support.
- No remaining updates after keep choices means no empty installation and no
  claim that retained custom versions match stock releases.

## Publication and evidence model

Keep Calendar v1 metadata as historical pilot evidence and optional release
notes, not a complete multi-component offer. Native APIs provide current offers
for the fixed integration/runtime allowlists. Missing notes are explicit. No new
whole-platform release format or workflow permission is required to consume
those supported channels.

Each integration entry records its package version, repository/subdirectory,
source revision, engines and release notes. Declare known inter-plugin requirements
and component coverage. Runtime entries identify the supported distribution channel,
observed release version, platform requirements and notes; their versions are not
immutable apply targets. Missing metadata is incomplete evidence, not proof that
all components are current or permission to invent a channel.

Keep immutable metadata identities and reject mutated published records. That
protects the truth of the preview/evidence; it does **not** prevent a newer
compatible channel candidate from being installed. Keep reviewed observations
separate from the latest-feed cache and actual installation receipts.

Changed shipped code needs that plugin's own version increment. Test/docs-only
or unrelated repository changes do not require cosmetic bumps. CI must build,
test and typecheck every advertised integration at the recorded revision, including
shared, generated-source and native checks with portable Linux prerequisites.
Test the advertised BB/Pi/Codex/plugin combination; skipped required gates must
not produce “tested” metadata. Never attribute later code to earlier test results.

Retain trusted-main publication, lockfiles, fixed channels, bounded network access
and safe diagnostics. No server/account credentials in the publishing job.
Source-author workflow changes follow normal reviewed CI work, not PA-session
credential grants. Define disk/cache retention before introducing any executable
staging; prefer BB-owned installation rather than a second package manager.

## Acceptance and delivery

| Given / when | Required result |
| --- | --- |
| Ordinary managed install without checkout | Review and update without development setup |
| Several integrations have newer released versions | One Update PA applies ordinary compatible updates and verifies actual versions |
| Component absent, unchanged or newer than preview | No accidental integration install, churn update or downgrade |
| Actual local customizations | Only those get keep/replace choices; default Keep local |
| Bulk/mixed choices | No immediate install; clear overwrite/keep summary |
| Install released version selected | Replace authorized local code only; preserve data/source work |
| Keep local selected | Bytes retained; compatible remainder updates; result names exception |
| Channel advances after preview | Newer compatible released candidate allowed; report actual installed version |
| Local code changes after review | Refresh affected authorization before overwrite |
| Kept version/background state incompatible | Explain before activation; no silent replacement or reset |
| Baseline or provenance unknown | Honest prerequisite; do not guess clean |
| Runtime updates | Selected execution host only; supported channels; verify actual versions |
| BB restart or active sessions | Required consent, safe maintenance, durable continuation and verified result |

Automated gates: updater build/tests/typecheck/SDK pin; advertised integration,
schema/generator/workflow and shared-source checks. Use synthetic private sentinels
in Git, installer, storage, release and RPC failures. Logs use fixed review,
baseline, prepare, activate, verify, quiesce and restart categories, never raw
exceptions, credentials or account content.

Installed-BB gates use original handlers and actual managed updates: multiple
integrations, preserved sentinels, untouched absent/unrelated/kept plugins, local
and runtime drift, advancing channels, and generated sync activity. Runtime and
BB-restart tests use a disposable Linux container and durable receipts. CLI
versions do not assert freshness of existing provider processes. Native thread
consent is retained; distinguish unit/rendered consent checks from any actually
exercised active-thread case. No personal notes or provider-account writes are needed.

Rendered gates cover quiet/available pill, ordinary review, one/multiple
customizations, bulk/mixed choices, Also updating, applying, success with/without
retained versions, unknown/incompatible/partial results, runtime versions,
session/restart consent and restored status. Check desktop/narrow, sidebar
arrangements, scrolling, overlays, keyboard, focus restoration and accessible
status. Record missing gates rather than claim a blanket pass.

After verification follow the [shipping skill](../../.agents/skills/bb-ship-feedback/SKILL.md):
commit, push, bootstrap the updater, verify its running source/version and a
harmless read, publish genuine checked metadata and seek feedback. No production
downgrades or cosmetic bumps to light the pill. If no genuine update is available,
record production Apply as pending first owner-confirmed use. Verify actual
versions and retained state after that use; never relabel a dry-run as live apply.

## Out of scope

Exact reviewed-target pinning; fixed-tag retargeting; upstream pinning-contract
work; whole-platform semver; BB forks; native prompt suppression; updates on
laptops/non-selected hosts; self-development credentials; updater self-replacement;
automatic source merging or checkout resets; unattended installation; general
connection-drop recovery beyond planned BB restarts; universal compatibility
certification or cross-component atomic rollback.
