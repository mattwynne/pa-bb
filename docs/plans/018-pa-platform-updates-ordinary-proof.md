# 018 — Ordinary-update and baseline feasibility

Status: implementation and bounded native/rendered acceptance have advanced beyond
the original feasibility checkpoint. Historical evidence below remains labelled;
current original-handler, runtime and builder results follow it. No production
account, plugin, permission or runtime installation changed. Final review and
remaining delivery gates are not replaced by these tests.

## Why these tests exist

Iteration 017 tests read-only discovery. The historical exact-target harness
characterizes a requirement the owner has since waived. Neither establishes that
an ordinary update can replace customized code while leaving a kept sibling and
account state intact, or that normal installed artifacts can be compared against
an independent original without a development checkout.

The first two harnesses answer those questions. `test/gate-host.mjs` shares only
isolated startup/cleanup and public CLI/HTTP plumbing; it is not an application
framework. The proof does not justify a universal baseline builder, dependency
framework, rollback engine or new BB supervisor.

## Historical ordinary-update feasibility

[`run-ordinary-update-gate.mjs`](../../plugins/pa-updates/test/run-ordinary-update-gate.mjs)
creates four synthetic plugins in one Git repository, installed through BB's real
managed installer. It runs original BB update handlers, not mocked updates.

- Independent committed-source rebuilds reproduce the initial source, server
  bundle, app bundle, CSS, metadata and icon bytes.
- One runtime-only server edit changes the actual identity RPC while source stays
  unchanged. Comparing effective runtime bytes detects it. The test then restores
  its own edit and verifies the original runtime.
- Two plugins receive source, CSS, icon and rebuilt-runtime customizations.
  Updating an unrelated sibling does not manufacture customization on that sibling.
- After previewing A (**1.0.1**), the fixture publishes B (**1.0.2**). Ordinary
  compatible updates install B. **That is a passing result under the new policy.**
- Update the clean plugin, explicitly replace one customized plugin and update a
  disabled plugin. The kept customized sibling remains byte-for-byte and retains
  its executable identity in the shared checkout.
- Synthetic ordinary settings, secret settings and KV values survive. Only the
  original version seeds KV data: replacement code cannot hide loss by recreating it.
- The disabled plugin stays disabled through application. The test separately
  enables it to verify actual executable identity and state, then disables it again.
- Unrelated plugin versions, enablement and status remain unchanged.

Final generated evidence:

| Observation | Value |
| --- | --- |
| Original fixture commit | `221637dbd9306a6a0cedf4f4f1b3a0551fd39884` |
| Preview A | `c328a183abc339d6f3139197b9145c85eaa43f51` |
| Expected remote B (not independently measured runtime provenance) | `200996e1294064126b0f25d5ca39abe6cbb9e342` |
| Actual updated versions | 1.0.2 |
| Normal/authorized-custom/disabled updates | Passed |
| Kept sibling, state and unrelated plugins | Preserved |

The executable marker and installed package versions establish that B's fixture
code ran. The recorded remote HEAD is not itself an installed-commit measurement;
the harness now also records the commit returned by BB's update operation,
separately from that expectation. The fixture's direct calls stand in for already-made choices; this is not yet a
tested server-owned review or authorization implementation.

## Real integration artifact baselines

[`run-integration-baseline-gate.mjs`](../../plugins/pa-updates/test/run-integration-baseline-gate.mjs)
uses an archive produced with `git archive` and supplied with the source label
`0d5359f3691edac2820ade86a83482b65da464fe`, without modifying the integration
implementations. The harness proves reconstruction of the supplied snapshot; it
does not independently bind that label to Git history. It now records the archive's
SHA-256 separately so the actual input is identifiable.
It installs them unconfigured in disposable BB. In separate temporary directories,
it reconstructs their original source from the source archive, installs lockfile
dependencies and invokes the public `bb plugin build` command with the same BB
builder. It never uses today's installed bytes as the expected baseline.

| Integration | Version | Compared source/artifact files |
| --- | --- | ---: |
| Google Calendar | 0.1.1 | 38 |
| Fastmail | 0.1.6 | 30 |
| Google Drive | 0.1.1 | 27 |
| iCloud | 0.3.1 | 76 |
| Obsidian | 0.3.1 | 103 |

All compared bytes matched. Each actually served app bundle matched the independent
build, and each original read-only status handler succeeded without an account.
A synthetic server-bundle-only edit was detectable without changing source.
The comparison deliberately includes tracked docs/tests as extra evidence; it is
not the production definition of which files count as user customization.

This establishes a **same-builder reconstruction strategy for these packages**.
It does not establish a general baseline for arbitrary plugins, unavailable old
builders, path installs, native runtime caches or arbitrary custom code. The
application should report unknown prerequisites rather than expand this proof
into a universal reconstruction system.

## Current product and runtime acceptance

The integration gate now invokes the **original PA updater handlers**, application
coordinator and native adapter, substituting only its trusted synthetic repository
and disabling runtime discovery. Its fixture versions are 0.3.1 → preview 0.3.2 →
actual 0.3.3. It checks default Keep, explicit replacement, runtime-only edits,
pre-apply edits, joined clicks, saved receipts after reload, state preservation and
untouched unrelated plugins. This supersedes the earlier direct-call limitation
without changing the historical commit table above.

The actual runtime gate ran in a fresh **Linux aarch64 `node:24-bookworm` Docker
container**, Node **24.22.0**. No host networking, privileged mode, Docker socket,
credentials or host directory mounts were supplied. Only source archives and gate
scripts were copied in. Before any provider installation, the gate asserted its
own HOME/data, executable PATH, login-shell PATH and npm global prefix/config/cache.
It rejected parent provider executables. BB and provider packages were bootstrapped
inside that disposable container; no parent Pi/Codex installation was changed.

The earlier PA updates **0.2.0 / SDK 0.6.37** integration/runtime checkpoint
used a source archive with SHA-256
`ae07b9982d1a99fe608970fce380d00721ebbb0268d48d6a329bedafbd7e7b07`.
Original application handlers and runtime adapters produced these native receipts:

| Component | Before | Preview | Verified actual | Source |
| --- | --- | --- | --- | --- |
| Pi CLI | 1.2.0 | 1.3.0 | 1.3.0 | Managed npm global |
| Codex CLI | 0.162.1 | 0.163.0 | 0.163.0 | Managed npm global |
| BB | 0.46.0 | 0.46.1 | 0.46.1 | Native npm launcher |

- The real BB launcher disconnected and restarted the server. The same persisted
  job completed; each runtime had exactly one recorded write admission.
- Reloading the updater preserved identical receipts. A fresh public native status
  check confirmed the installed versions and selected primary host again.
- An integration built by BB 0.46.0 remained independently reproducible after the
  BB upgrade. A later ordinary managed integration update built with BB 0.46.1
  also reproduced as stock. No checkout setup or historical tool download was
  added to the product.
- Separately, the real Calendar 0.1.1, Fastmail 0.1.6 and Drive 0.1.1 source snapshot
  reproduced under their observed legacy **BB 0.45.0 / SDK 0.6.15** builder: 38,
  30 and 27 compared files, served app bytes and read-only handlers. That input
  archive had SHA-256 `103141b28a23692fbc9d1252bab6d35f0325d27ffaa68017c7f7296727ae2dd5`.
  This is not a claim that the newer paired integrations run under BB 0.45.0.
- No active provider session or provider-account operation was used. Installed
  versions do not prove that existing Pi/Codex processes are fresh. The installer
  does not forcibly restart them. Native running-thread consent has unit and
  rendered coverage, not an asserted live-account interruption experiment.

The gate caught two fixture issues before its clean pass: login shells reset PATH,
so owned profile files and login-shell prefix assertions were added; detached
native children can write during recursive cleanup, so evidence is preserved until
its enclosing disposable container is destroyed. These are fixture boundaries,
not a custom application supervisor or new recovery mechanism.

### Final bounded fixes and native paired-sync acceptance

The updater now persists at most five active independently reconstructed
expected-hash records, one per integration, bound to its source commit and recorded
builder. It seeds unchanged integrations as well as offered updates. Unit tests
remove the original builder between instances, then verify stock/custom detection
from the saved original, key mismatch refusal, failed persistence and disposal
fencing. This closes the two-upgrade retention gap without downloading old tools
or keeping installation history. It is simulated pruning coverage, not a claim
that two real BB upgrades were exercised.

Startup and six-hour discovery now retain the displayed complete or uncertain job
until explicit **Check again**. Tests exercise the actual registered startup and
schedule callbacks across reload, including the review/job relationship that
makes receipts visible. Unreached steps say **Waiting…** or **Not updated**, and
unknown rows show their actual prerequisite rather than always blaming a baseline.

The [generated paired-sync gate](../../plugins/pa-updates/test/run-paired-sync-gate.mjs)
passed in the isolated Linux environment, with all Linux capabilities dropped,
stock rclone **1.75.2** and current original iCloud/Obsidian factories. Fixture-only
entries supply generated local alias data and forward the original Obsidian tool
handlers. Both package manifests use synthetic **0.3.1 → 0.3.2** versions; this
is not a test of bootstrapping Pause support in an old installed release.

- A real minute-scheduled transfer ran for about **16 seconds**. Its native partial
  file was observed before Apply; the updater held its reservation while the
  actual sync was still running, then drained it before native disposal.
- The same durable Pause job and its one owned folder survived iCloud disposal and
  native reload. Both folders were disabled at the handoff. Native installation
  ran once per integration and reported actual 0.3.2 versions.
- Only the previously enabled folder resumed, and a subsequent real scheduled run
  completed. The user-paused sibling never started a native run.
- Two generated notes retained their exact bytes/hashes and original operation
  receipts; connected vault IDs survived. The paused note remained local rather
  than silently syncing. The updater's own reload retained the visible job result.

[Sanitized native evidence](018-paired-sync-evidence.json) records the assertions
and input archive hashes. That accepted native checkpoint used updater archive
`19a3c87f354ebd31bcba29a86ee0ffa7b5aa1199d3cc298376998ca06bb744a0`;
the ordinary integration-handler gate also passed with this archive. The earlier
runtime-installer checkpoint above remains separately identified.

Two fixture setup failures were corrected without changing sync behavior or
resetting failed sources: host archive ownership could not be restored with
capabilities dropped, and an empty prior bisync listing was refused. Extraction
now keeps the container's ownership; fresh generated aliases include a seed note,
as in the archived installed-BB recipe. No privileges or account access were added.

Running **BB 0.46.0** rendered the original app at 1280px and 390px across 17 states:
first/checking/current, offers, unknown and failed checks, explicit restart consent,
applying/restarting, complete/failed/uncertain receipts, distinct prerequisites,
preflight and partial-CLI failures, RPC failure and storage failure. Checks include default Keep, native dialog focus/Escape/return, footer
entry, scroll/action visibility, release notes and failed-check recovery. The first
mobile attempt found an inert closed-sidebar disclosure; the notice now opens the
same review component in a native dialog. The final overlap cleanup also passed;
38 captures include keyboard-checked consent and visible pending/skipped-result copy. Synthetic RPC states are UI evidence,
not native installation evidence. Selected captures:
[desktop dialog](018-update-pa-dialog-desktop.png),
[narrow dialog](018-update-pa-dialog-narrow.png),
[narrow footer consent](018-update-pa-consent-narrow.png),
[prerequisite reasons](018-update-pa-prerequisites-narrow.png), and
[unreached steps](018-update-pa-result-narrow.png).

Local suites at that checkpoint passed: updater build, **60 tests / 4 scenarios**, typecheck and
SDK-pin check; iCloud build/shared-source check, **80 tests / 46 scenarios**, and
typecheck. Its **143 native tests / 10 native scenarios were skipped** without the
stock-rclone test binary. They are not a full native-suite pass; the focused
paired-sync acceptance above is separate evidence.

### Later-offer notification follow-up

Closure review found that retaining a completed result had also stopped all later
automatic offer checks. Discovery now refreshes one transient readiness flag and
check time using the existing integration/runtime inspections, without rewriting
the saved review or job. The pill uses that fresh readiness, not the consumed
review or Calendar-only feed. Old kept/uncertain offers do not create a duplicate
completion notice. A new native runtime offer remains eligible after a successful
update, including source BB commits sharing a displayed version.

Opening the returning pill keeps the saved result visible. The existing **Check
again** action explicitly requests the new review; an explicit call joining an
automatic scan promotes that same scan rather than returning old results.

Updater build, **65 tests / 4 scenarios**, typecheck and SDK-pin check passed.
Registered startup/scheduled callbacks cover later integration and runtime offers,
no-new-release checks, unchanged saved complete/kept/uncertain results, and reload.
Focused rendered checks passed **22 captures** at desktop/narrow widths: returning
pill, result reopening through the footer, actual new review after Check again,
and suppression during active/reserved work. This supplements the earlier 38
captures; native installer/sync evidence remains accepted and was not rerun for
this discovery-only change. [Example new runtime review](018-update-pa-later-offer-narrow.png).

## Reproduce

Use a disposable Linux environment with Node, Git, tar and an installed compatible
BB package. Network access is needed for pinned npm dependencies. Supply a trusted
archive produced from this repository, never an untrusted tarball.

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -cf updater-source.tar -C plugins/pa-updates package.json package-lock.json \
  server.ts contract.ts app.tsx app.css core adapters
node plugins/pa-updates/test/run-ordinary-update-gate.mjs \
  "$BB_APP_PACKAGE_DIR" updater-source.tar
REV=0d5359f3691edac2820ade86a83482b65da464fe
git archive "$REV" plugins/google-calendar plugins/fastmail \
  plugins/google-drive plugins/icloud plugins/obsidian > integration-source.tar
node plugins/pa-updates/test/run-integration-baseline-gate.mjs \
  "$BB_APP_PACKAGE_DIR" integration-source.tar "$REV"
```

The scripts create fresh HOME/data/repository directories and loopback listeners;
they never connect to an existing BB instance. Native-launcher runs retain evidence
until the enclosing owned container is destroyed; other successful fixtures remove
their temporary state. A failure retains isolated evidence for diagnosis. Current
scripts bound command failures to a fixed message, handle setup failures inside
cleanup, and stop the disposable server on SIGINT/SIGTERM. These are test-harness
safeguards, not claims about application-job failure handling.

The helper sets `BB_APP_VERSION` to the supplied package's actual version, matching
BB's public launcher, and asserts the public `/system/version` response. Directly
launching the server entry without this value reports `0.0.0-dev`; that would skip
production-version compatibility checks. This was caught during reconstruction
because CLI-built and server-built metadata differed. See the qualification added
to the [historical proof](018-pa-platform-updates-gate-0.md).

For native runtime acceptance, copy the archive plus `gate-host.mjs` and
`run-runtime-update-gate.mjs` into a fresh disposable Linux container, install a
trusted BB package inside it, then run:

```sh
node run-runtime-update-gate.mjs "$BB_APP_PACKAGE_DIR" updater-source.tar
```

For the focused paired-sync gate, also copy `run-paired-sync-gate.mjs` and its
`paired-fixtures` directory. Install stock rclone 1.75.2 and provide a second source
archive containing `plugins/icloud` and `plugins/obsidian` with their current source
and lockfiles, excluding dependencies, build outputs and OS metadata. Then run:

```sh
node run-paired-sync-gate.mjs "$BB_APP_PACKAGE_DIR" updater-source.tar pair-source.tar
```

Copy needed evidence before destroying only that owned container. Never run these
installer gates in a shared PA host merely because HOME is temporary.

## Remaining delivery limits

- Initial delivery must use the stopped paired procedure to introduce updater-aware
  Pause to older iCloud installations. The product refuses an enabled provider
  without that capability; it does not bypass the prerequisite.
- The Calendar v1 release-note feed does not advertise tested coverage for all
  components or later channel versions.
- Targeted independent review and controlled delivery/running-BB feedback remain
  separate gates; the affected local suites above do not replace them. No production Apply has occurred.

No exact-preview-target, fixed-tag-retargeting or upstream pinning-contract work
is needed. These proofs are a checkpoint toward a working Update PA, not another
metadata-only release presented as delivery.
