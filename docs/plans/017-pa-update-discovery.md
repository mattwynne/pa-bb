# 017 — PA update discovery and local-work review

Status: delivered; real baseline published, independent checker 0.1.1 installed,
and live read-only/rendered checks passed. Owner feedback is pending. See the [verification record](017-pa-update-discovery-review.md).
This is the read-only first slice from the
[updates problem](../problems/updates.md), not permission to build the complete
updater in this iteration.

## User outcome

Open **PA updates** in BB's sidebar to see whether a published Google Calendar
update exists, what it contains, and whether local development would block it.
Nothing installs, edits a checkout or restarts merely because a check ran.

Ship an independent `pa-updates` plugin. Keep native BB/Pi prompts and controls;
no BB fork, upstream change, DOM manipulation or CSS-based hiding. A release
record covers only components actually tested for that release, not an implied
compatible bundle of every PA plugin, BB and Pi.

## Baseline and first implementation gate

Planning starts at repository `81d033c`. Read-only host checks confirm BB
**0.45.0**, Google Calendar **0.1.1**, and the existing provider-usage plugin
running. Calendar has no background sync worker and is the sole pilot target;
do not change its behaviour or manufacture a version bump to demonstrate an
available update.

SDK **0.6.15** declares the experimental sidebar disclosure and public inventory
APIs. The problem brief also records newer upstream source evidence. Neither
proves the exact installed UI: before implementing layout, inspect the running
BB footer and provider-usage disclosure, then install a disposable minimal
footer contribution on the supported BB version. Confirm inventory/source
metadata are available through supported APIs. Record the minimum BB/SDK
versions actually verified; do not silently upgrade production to satisfy the
plan. Missing extension or source metadata is a blocker to resolve or report,
not permission to patch BB or guess installed revisions.

Follow the [local UX skill](../../.agents/skills/bb-plugin-ux/SKILL.md),
[UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md). The initial planning baseline had no rendered review. Implementation evidence
and tested versions are recorded in the [verification record](017-pa-update-discovery-review.md).

## Three stories

### 1. See a real published candidate

As the owner, I can open PA updates and compare my installed pilot plugin with
a release published after its checks passed.

- Install `pa-updates` independently from the marketplace. It adds one persistent
  host-rendered footer icon labelled **PA updates**, opening a disclosure like
  provider-usage. A conditional pill or dynamic badge is not required.
- Show pilot scope explicitly: **Google Calendar updates**. Do not say all of PA
  is current while other components are outside this iteration.
- Show installed/proposed versions, known source revisions, plain-text release
  notes and the last successful check. Missing installed source evidence is
  **Installed revision unavailable**, not a guessed match based on version.
- An installation without Calendar shows **No supported plugin installed**;
  checking must not install Calendar or offer unrelated catalog entries.
- Expose **Check again**. There is no Install/Apply control, including a disabled
  placeholder suggesting that safety or exact-target installation is ready.

### 2. See local-work blockers without changing files

As the owner, I can distinguish a candidate with no detected local conflicts
from one that would overwrite work, without committing or discarding anything.

- Associate an operator-configured development checkout with the pilot plugin
  and its declared shared-source paths. Keep paths in protected host/plugin
  configuration, not public release records, chat tools or logs. User-facing
  review must not require entering terminal commands or provisioning paths.
- Assess staged/unstaged edits, deletions and untracked source, including changes
  in relevant shared code. Ignore ordinary ignored build outputs and state.
- Detect local commits containing relevant work absent from the candidate. Start
  conservatively with ordinary same-history comparisons; branch divergence,
  unknown ancestry or equivalent-looking cherry-picks may return **Cannot
  establish safety** rather than claiming they are safe.
- Distinguish **Local changes found**, **Local commits not in release**, **No
  local changes found** and **Local work not assessed**. Missing mapping,
  permissions, Git, target objects or unsupported layout yields the last state
  with a useful next step; it must not disable release discovery.
- Assessment uses read-only local metadata commands with bounded output and
  duration. Do not fetch into the development checkout, refresh its index,
  stash, reset, clean, checkout, commit or push. If candidate objects are needed,
  use a separate bounded plugin-owned cache outside the development checkout.
- A result is a timestamped observation, not an update reservation. If files or
  HEAD change during inspection, return unknown/retry, not a clean verdict.
  Actual application will need fresh checks and edit/update coordination in a
  later iteration.

Preserve the per-plugin policy in generated tests: unrelated dirty Obsidian work
must not become a Calendar blocker; relevant shared edits must. This iteration
reads only the configured pilot scope and never opens account data or notes.

### 3. Understand failed and stale checks

As the owner, I can tell the difference between no update and a check that
failed, and retry without losing the last known information.

- Distinguish first check, checking, no published release, no supported plugin,
  matching release, newer candidate, source mismatch, incompatible candidate,
  and unavailable/invalid release information. A newer installed version is not
  a downgrade offer. Same version with different source is not automatically a
  newer release.
- Retain the last validated result after a failure, visibly marked as last
  known/stale. Display last success separately from the most recent failed
  attempt. Never present cached success as a fresh check.
- Installed inventory and local-work inspection failures remain separate from
  release-feed failures. One failure must not turn unknown state into clean or
  up to date. Local-work status is independent of whether an update exists.
- Restart, browser reconnect and multiple viewers do not create duplicate
  background checks. Disabling/removing the plugin stops its scheduled work
  without touching integrations, account state or native update controls.

## Minimal release publication

Add a versioned JSON schema and generator for a small `pa-release.json` record:

- Schema version, release identity and source commit.
- A bounded list of tested plugin IDs; initially only `google-calendar`.
- For each: package version, known repository-relative subdirectory, exact
  source commit, declared BB/SDK engine requirements and bounded plain-text
  release notes. Treat engine ranges as declared requirements, not proof of
  compatibility with every satisfying runtime.

Keep the source repository and accepted GitHub release channel fixed in trusted
plugin code/configuration. A record cannot nominate arbitrary repositories,
filesystem paths, commands or download URLs. Use stable dedicated PA release
tags; ignore drafts/prereleases. Define selection and bounded pagination so a
failed/incomplete listing is not mistaken for “no release”. Unknown schema
versions, duplicate IDs, bad commits, unexpected paths and oversized records
fail validation. Release notes render as inert text; any links must use trusted
validated destinations.

Add an explicitly triggered GitHub Actions publishing job for trusted `main`
revisions. Before generating/publishing a record, run the pilot's build/tests,
typecheck, generated-UI check and release-schema/generator tests against that
exact revision with lockfiles. Generate version/requirements from that tested
package rather than hand-copying them. Grant write permission only to the
publishing job; pull-request/untrusted code must not receive release authority.
No server SSH key, account grant or personal deployment credential is needed.

Published records are append-only by policy: do not retarget existing release
identities. Retain the last accepted identity/content digest and reject a changed
record under that identity. HTTPS and repository write controls are the initial
trust model, not independent artifact signing; document that limit. A candidate
is advertised by metadata only: this iteration downloads no executable plugin
artifact and performs no upgrade.

Publish one real baseline record after checks pass, even if Calendar is already
at that version. Prove the newer-candidate view in disposable BB with a generated
older installation and synthetic release data; label it as synthetic evidence.
Do not downgrade or change production Calendar merely to exercise that view.
A fixture-only feed is not completion of the publishing story.

## Implementation shape and limits

Proposed new paths, to create during implementation:

- `plugins/pa-updates/`: package, lockfile, `server.ts`, `app.tsx`, `contract.ts`,
  a small comparison/assessment core, adapters, feature specs and tests.
- `releases/pa-release-v1.schema.json` and `scripts/build-pa-release.mjs`.
- `.github/workflows/pa-release.yml`: gated baseline/candidate publication.
- A `pa-updates` entry in `marketplace.json`, plus plugin README/setup guidance.

Use typed status/check RPCs and injectable release-source, installed-inventory,
local-Git, storage and clock ports. No agent tools or arbitrary command/path RPC.
Keep runtime packages self-contained; do not introduce an updater dependency
into Calendar or require shared connection-account UI for a non-account screen.

The backend owns one joined in-flight check and bounded scheduling; browser
mounts read status rather than owning a timer. Initial budgets: a six-hour
scheduled check, a one-minute manual recheck cooldown, 256-KiB release record,
10-second network/Git operation timeout and at most one assessment at a time.
Bound repository-cache disk use and child output as well; large/unsupported
histories must yield unknown, not silently sample into a safety verdict. Prefer
supported host-owned scheduling/lifecycle hooks and stop work safely on reload.
Persist last success/attempt and fixed outcome categories; routine polls should
not produce success-log noise. Test that content, local paths, Git output and
exception payloads never enter logs. Do not log arbitrary release notes or raw
network responses.

## Acceptance and release gates

| Scenario | Required result |
| --- | --- |
| Matching installed revision and valid baseline | Pilot is current; local-work assessment remains separate |
| Newer valid pilot release | Candidate version/revision and notes visible; no install action |
| Pilot absent | Clear supported-scope empty state; nothing installed |
| Dirty pilot or relevant shared source | Local-change warning; bytes and index unchanged |
| Unrelated plugin dirty | Pilot assessment unaffected; unrelated files untouched |
| Clean checkout with unpublished relevant commits | Blocker or explicit unknown; never clean by omission |
| No mapping, missing metadata or changed HEAD | Local work not assessed/cannot establish safety |
| Offline, invalid or mutated release record | Attributable safe error; last good result labelled stale |
| Concurrent checks/reload/disable | Joined bounded work; no leaked timers or child processes |

Automated gates: new package build, Cucumber/core/adapter tests, typecheck, release
schema/generator and workflow checks; pilot tests/typecheck where publication or
catalog contracts are affected; shared generation check. Use synthetic private
sentinels in failure payloads and assert absence from logs/UI diagnostics.

Installed-BB gates: prove the real footer registration and typed RPC path, read
installed revision metadata without account content, exercise generated dirty
and divergent checkout cases, and compare file/index state before and after.
Assert no calls to install/update/remove APIs and no checkout mutations occur.

Rendered review is mandatory at desktop/narrow widths with keyboard open/close,
focus restoration, accessible status announcements and readable release notes.
Cover first-run/checking, current, available, absent pilot, unknown/dirty local
work, feed failure with stale data and recovery. Do not invent approval states
for this read-only slice. Record tested BB/SDK versions and compare with the
actual provider-usage footer; source/build checks alone are not this gate.

Once verified, follow the [shipping skill](../../.agents/skills/bb-ship-feedback/SKILL.md):
commit/push, install only the new plugin, verify its running version, make a
narrow read-only check and inspect safe failure diagnostics. Confirm existing
plugins, credentials, source choices and native BB/Pi prompts are unchanged.
Seek owner feedback on finding the icon and understanding candidate/blocker
status. Record unavailable gates honestly rather than declaring delivery.

## Explicitly deferred

Applying any candidate; exact-target install mechanisms; atomic or partial
bundle deployment; BB/Pi status aggregation or upgrades; background-sync pause
and drain; automatic reconciliation of local changes; development/Git write
permissions; updater self-replacement; prompt suppression and BB forks.

A following iteration can add guarded single-plugin Apply once exact targeting,
installed-code drift detection and concurrent edit protection are demonstrated.
Do not mistake this iteration's advisory assessment for those guarantees.

## Next planning decision after delivery

Delivery and a separate verification rerun passed; see the
[follow-up evidence](017-pa-update-discovery-review.md#independent-follow-up-verification).
Keep this iteration delivered, with owner feedback pending. Do not expand it
retroactively into an installer or treat the remaining unknown states as defects
to bypass.

Before committing to an Apply iteration:

1. Get owner feedback on finding the footer entry and understanding **Source
   differs** and **Local work not assessed**. The real baseline and installed
   Calendar share version 0.1.1 but report different repository revisions;
   neither that difference nor matching short prefixes prove a runtime-code
   change or an exact installed build. Do not bump versions or replace Calendar
   merely to make the display look current.
2. Prove an exact-target, non-destructive managed-plugin update on disposable BB
   through supported mechanisms, without a BB fork. Establish trustworthy
   installed-source/artifact identity and drift detection; do not infer the
   activated commit from candidate history. Repository-only changes must not
   be confused with a new plugin version. A correct read-only report is not
   evidence that the current apply API can install a chosen record.
3. Define explicit checkout mapping and protection against concurrent editing
   during application. The live host currently has no mapping, and this slice
   deliberately has no fetch/cache, reservation or installed-code drift check.
   Missing objects, unsupported layout or unknown safety must stay blockers.
   Any live mapping/provisioning work is a separate operator action, not part of
   this documentation review.

If those proofs succeed, scope the next iteration to one user-approved Calendar
update with existing state preserved and actual installed target verified. If
supported APIs cannot enforce the target and safety rules, report the limitation
and retain read-only discovery; do not work around it with remove/reinstall,
checkout resets or an unpinned latest update. Keep BB/Pi and background-sync
upgrades deferred. Detailed Apply planning should use these results and owner
feedback, not assume the gaps are already solved.
