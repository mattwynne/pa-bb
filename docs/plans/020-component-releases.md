# 020 — Component releases and released-code installation

Status: **superseded before implementation** by [021 — Git-first PA updates](021-git-first-pa-updates.md) on 2026-10-22. The owner chose server editing, local application and normal Git synchronization rather than a mandatory component-release stage. Do not build this pipeline as an updater prerequisite.

The original plan below is retained as history. [ADR 0002](../adrs/0002-component-releases.md) is likewise superseded for this workflow.

## Outcome and scope

Publish each of the six PA plugins deliberately through one shared workflow.
Only a published, non-prerelease GitHub release with a valid immutable component
record makes that component eligible for ordinary updates. There is no PA
platform version. Pushing, merging, changing a package version, creating a tag
or preparing a draft is not a release.

Make discovery, local-work comparison and native installation use that same
boundary. Preserve installed state, source work and the existing default:
**Local changes → Keep local**. The alternative is **Install released version**.
The source location is not a distinction the user needs to understand.

The immediate requested follow-up is the factual-sync wording fix already
published as `9f187c16524de3c6ffa6a317be2b3e79659bf513`. It changes iCloud and
Obsidian, but neither has been released or installed with that fix. Complete
the applicable gates and release only those intended components. Do not publish
other outstanding work merely to establish baselines or clear warnings.

## Starting evidence for all six components

Read-only installation provenance was checked on 2026-10-22. These are source
identities of prior deliveries, **not six already-published component releases**.
Unknown release baselines must remain unknown until their records are justified
and deliberately published. Do not substitute today's `main` for missing proof.

| Component | Installed version | Exact prior-delivery source | Published release evidence / next step |
| --- | --- | --- | --- |
| Google Calendar | 0.1.1 | `767b85a84b22dda3f07d14a63878aefa1c948d5e` | Existing published `pa-release-7e1071ca1e452a9e73e912327b28707cb27cabc2`, v1 record for Calendar 0.1.1 at `7e1071ca1e452a9e73e912327b28707cb27cabc2`. Preserve it unchanged. |
| Google Drive | 0.1.1 | `59920ccdf22015fed085402c0a842882c13c5491` | Installed source/history verified; no explicit component release record found. Verify historical gates before proposing a baseline record. |
| Fastmail | 0.1.7 | `73efa3825573b6434f816b707e6867d60c2dc93a` | Installed source/history verified; no explicit component release record found. Review prior delivery evidence and historical gates. |
| iCloud | 0.3.2 | `638d2418b2cb123e39b698b2fc5f64b7c54f340c` | Installed source/history verified; no explicit component release record found. This source predates `9f187c1`. |
| Obsidian | 0.3.1 | `b6f3802e1798dc660af8a62554a863e5a7e6417b` | Installed source/history verified; no explicit component release record found. This source predates `9f187c1`. |
| PA updates | 0.2.9 | `6a75440755aba2ea7f5a21de00c032d945f84f15` | Installed source/history verified; no explicit component release record found. Existing native self-update evidence is separate from release-boundary enforcement. |

Calendar's two whole-package Git trees are **not identical**: the released
revision changes two test files. A direct diff excluding `test/` is empty,
confirming unchanged non-test package contents, including manifests and runtime
source. Keep that distinction in the historical baseline proof; do not describe
installed commit identity as the release's source identity.

Before publishing any baseline, review a six-row record proposal containing the
exact source, version, content identity, historical verification evidence and
remaining unknowns. Bootstrap only verified prior deliveries, not later feature
work. New iCloud/Obsidian behavior requires new component versions rather than
reusing their installed versions.

## Delivery steps

### 0. Check the native admission boundary first

Before implementing a large workflow or updater change, make one bounded check
of the current BB capability and reuse existing native-update evidence. Establish
whether released candidate contents can be validated before activation. Report
an unsupported boundary early; do not build an entire pipeline before discovering
that installation cannot honor its records. No old-version matrix or exact-tag
retargeting research is required.

Read-only inspection of the running BB **0.46.1** distribution found that
`plugins.applyUpdate({ pluginId })` and its experimental asynchronous counterpart
send a strictly empty update body; job phases expose preparation and activation
but no prepared-candidate approval input. No public preparation/admission hook
was found in this bounded inspection. This does not prove a safe released-only
channel exists: establish such a supported route or report native delivery
blocked. A precheck followed by this unguarded apply is not sufficient.

### 1. Define and test the component record

Use one strict record format for the fixed six-component allowlist. Record:
component ID, semantic version, exact source commit, fixed package subdirectory,
component-specific tag, BB/SDK/Node requirements, release notes, and checksums
for distributed artifacts. Define a deterministic identity for the installable
package contents, including runtime source and assets; tests alone are not
executable identity. Cover build inputs and shared/generated package contents.

Validate component, manifest version, source and tag agreement. Use namespaced
tags such as `icloud-v0.3.3` and `obsidian-v0.3.2`. Retain a narrow reader for the
historical Calendar v1 record rather than rewriting its tag or asset.

Reject oversized/malformed records, unexpected repositories or subdirectories,
missing compatibility evidence, and changed published identities. Do not accept
commands, arbitrary paths or installer arguments from release metadata.

### 2. Replace the Calendar-only workflow with one shared workflow

An explicit dispatch selects component, version, exact source revision and notes.
Check out that revision, validate its package and proposed tag, then run that
component's required tests/build/typecheck and applicable shared, Linux-native,
installed and rendered gates. Evidence must identify the exact candidate; a
checked box or a passing unrelated package is not sufficient.

Publish the GitHub release and validated record only after those gates pass.
Refuse existing version/tag/asset identities; never overwrite assets, move tags
or reuse published versions. A workflow dispatch for one component publishes
only that component, even when other changes share its source revision.
Push/tag events must not silently release anything. Drafts and prereleases are
not ordinary update candidates.

**Publication authorization:** the server credential deliberately has no
Workflows permission. Use an existing authorized maintainer route to publish
workflow changes. If none is available, report the specific maintainer step as
a blocker. Do not expand credential permissions or work around the restriction.
Local development and tests can proceed without that permission.

### 3. Discover releases per component and compare source work

Enumerate eligible published releases for each component, not the repository's
single global latest release. Verify record identity, compatibility and content
before making an offer. Cache bounded immutable records independently of saved
reviews and application receipts. Missing or unverifiable release information
is uncertainty, not green **Up to date** or automatic install permission.

Compare the component's installed and optional development contents against
its verified release contents. Preserve these distinct cases:

- uncommitted, staged or untracked component work is **Local changes**;
- locally committed work absent from a release is **Local changes**;
- pushed work absent from a release is still **Local changes**;
- a source checkout merely behind a release is not local customization;
- unrelated repository changes do not customize every component;
- a missing development checkout is normal; failed inspection is not clean.

Read the canonical development checkout without fetching into it, resetting,
rebasing, publishing or deleting its work. Fetch comparison objects only in an
owned temporary directory. Existing independently reconstructed installed-code
baselines remain useful, but they do not turn an unreleased source into a
release. Update agent guidance to name the release boundary consistently.

### 4. Admit only eligible code to the native installer

Before **any** native apply, establish that the candidate's component contents
belong to an eligible published release. A record around a version label or
`git:@main` offer is not enough. Cover ordinary plugin updates and the updater's
own final replacement. Recheck reviewed local fingerprints and keep/replace
choices before allowing code to be overwritten.

Use the supported BB preparation/activation boundary if it can validate the
actual prepared candidate before activation. Prove this with a controlled
candidate that advances to unreleased contents between review and apply. A
check of `main` followed by an unguarded native apply leaves a race and does not
pass. Post-install detection alone is too late.

If the available native API cannot enforce that boundary, stop with an explicit
delivery blocker or use a supported released-only channel whose publication
rules enforce it. Do not silently retarget installed sources, patch BB, edit
managed packages or introduce a second package manager. Exact preview-version
pinning remains out of scope: a newer compatible, properly released candidate
is acceptable. Do not reopen the superseded fixed-tag retargeting investigation.

After activation, independently verify actual version/content and source proof.
Preserve credentials, settings, schedules, operational files, receipts and kept
siblings. Retain uncertain-write handling; never retry an uncertain native
mutation automatically. Keep PA updater last and preserve its durable restart
reconciliation.

### 5. Verify, publish and install only the requested changes

Reuse prior native self-update, runtime and paired-sync proofs unless their
boundaries change; do not repeat the entire BB/Pi/Codex/provider matrix. Rerun
focused regressions for changed release/admission paths and the affected
plugins. Follow [release-and-deploy](../../.agents/skills/release-and-deploy/SKILL.md),
[UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md).

For the factual-sync fix, finish iCloud and Obsidian rendered review in running
BB at desktop/narrow widths with keyboard navigation and relevant status/error
states. Use generated data and disposable BB; do not install unreleased code
on the personal installation to obtain review evidence.

Review record/baseline proposals before creating tags or assets. Release only
the intended component after its gates pass. Deploy only when native candidate
admission proves released code. Quiesce scheduled file writes through supported
controls **before update preparation**, drain active work, preserve prior
selections and restore only previously enabled work. Use the documented stopped
paired-upgrade procedure where required. Never clear failures, locks or
baselines merely to deploy.

## Focused acceptance tests

| Case | Required result |
| --- | --- |
| Uncommitted / committed / pushed-but-unreleased component work | All three remain Local changes with Keep local as default. |
| Real `9f187c1` after push, before release | iCloud and Obsidian are not treated as released or clean merely because remote `main` includes the fix. |
| Checkout only behind a release | No invented local customization. |
| No checkout, unavailable release or unknown installed baseline | Honest absence/uncertainty; no unsafe automatic admission. |
| Only one component released; another has a newer global release | Correct component offer; no implicit sibling release. |
| Draft, prerelease, tag-only, version bump or wrong record | Not eligible; mutation/retarget/asset replacement is refused. |
| Candidate changes after review | Newer eligible released contents allowed; unreleased contents refused before any apply/activation. |
| Native API lacks enforceable candidate boundary | Delivery blocker, not a version-label workaround. |
| Keep a local component while updating a sibling | Kept bytes and canonical source remain unchanged. |
| Updater self-replacement | Same release admission and durable receipt rules; updater runs last. |
| Release/network/Git/installer/storage failures with synthetic sentinels | Bounded attributable categories; no secret, account content or raw exception leaks. |
| Rendered update review | Desktop/narrow/keyboard: Local changes, default Keep local, unavailable record, applying and truthful completion. |

## Verification checkpoint — 2026-10-22

The factual-sync fix is already in source; no product implementation was changed
for this checkpoint. Fresh checks of the current packages passed:

- Obsidian: build, typecheck (SDK pin and host both 0.6.15), 8 scenarios / 38
  steps, 72 unit/host tests, no skips in those tests.
- iCloud: build and typecheck (SDK pin and host both 0.6.15), 46 passing scenarios
  / 456 steps; 10 scenarios / 64 steps skipped. Unit/host suite: 80 passes,
  143 platform/opt-in skips. These are not Linux-native gate results.
- Shared connection UI drift check passed as part of both package tests.
- Obsidian rendered assertions in disposable BB 0.45.0 passed at 1280 and 390
  pixels: 58 screenshots covering connected/setup/paused/running/error/recovery
  states, keyboard focus, navigation and overflow. Representative desktop and
  narrow screenshots were inspected; the factual sync timestamp is readable.
  RPC states are synthetic, not proof of native note access or cloud delivery.
- A subsequent disposable **Linux BB 0.45.0** mounted both unmodified production
  plugin factories with isolated home/storage and no account connection. Both
  synthetic RPC-rendered suites passed: **74 iCloud** and **58 Obsidian** desktop/
  narrow screenshots, including status/error/retry/progress states, keyboard
  focus and factual timestamps. Representative images were inspected. These
  prove rendering, not native sync, provider calls or account/device delivery.
- The Linux unit/host run initially reported 170 passes, one failure and 52
  skips. Its byte-at-a-time synthetic stderr fixture called `process.exit(7)`
  before the output drained. A controlled delayed-reader probe reproduced
  truncation (171 of 349 bytes, three times); natural `exitCode = 7` termination
  preserved all 349 bytes three times. The fixture-only correction changes no
  plugin runtime behavior; the isolated marker regression and local package
  tests/typecheck passed afterwards.
- A broader Linux rerun with native rclone fixtures enabled reported **188
  passes, one failure and 34 skips**. The marker regression passed, but
  `scheduler retries native interruption, respects Pause across reload, and
  preserves stronger critical blockers` received `busy` during its post-reload
  Retry. That failure remains unresolved; do not call the native suite passing
  or release the plugins on this evidence. No scheduler/runtime fix was made.

Component pipeline implementation, release-boundary updater enforcement,
verified baseline publication, the native scheduler regression and supported
released-candidate admission remain pending. No component tag/release,
production plugin update, account-content read or provider write was performed
for these checks.
