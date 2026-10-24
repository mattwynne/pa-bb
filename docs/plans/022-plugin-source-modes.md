# 022 — Per-plugin GitHub and local development modes

Status: delivered as PA updates 0.4.0 (`3c574b2`). Tracked in `yx` under “Switch PA plugins between GitHub and local development”. Extends 021 with an explicitly approved destructive transition; retaining configuration is follow-up work, not a prerequisite.

## Outcome

Each PA plugin row offers a switch between **GitHub** and **Local development**. GitHub means BB's existing managed source from this repository; do not mislabel `main` as a published versioned release or add a release pipeline. Local development uses the plugin's standard folder under `$HOME/src/pa-bb`. No arbitrary folder picker, Git dashboard, fork, database edit or cache patch.

In local mode, show the configured Git origin safely, whether the working copy has uncommitted changes, and whether it has unpushed commits. Distinguish these facts; a clean working copy may have unpushed commits. Never expose credentials embedded in remote URLs or claim an unknown check is clean.

## Confirmation and scope

The initial implementation uses BB's supported remove/install operations because existing Git↔local source changes are rejected. Before either direction, name the affected plugin and target mode, explain that settings, saved credentials and schedules are deleted and reconnection/reconfiguration will be necessary, and offer Cancel plus an explicit destructive confirmation. Source files and commits are not discarded. Confirmation is per plugin; no implicit all-plugin switch or registered agent tool for source changes.

Preparation validates the intended source and same plugin ID before removal. Serialize switches with normal updates and checks. Persist outcomes before native writes; do not silently retry removal or an uncertain install. A lost response is not proof of failure. Failure after removal must remain visible with an honest recovery path. Pausing a file-writing integration is required before removal; settings reset must never cause automatic folder resumption. Preserve user-paused siblings and unrelated plugin state.

The updater itself is included: its native removal disposes its running instance and app. Execution and outcome observation must survive that disposal without running a second supervisor or replaying the switch on startup. Prove the actual native behavior, not just mocked callbacks.

Switching back to GitHub changes code, not the working copy. No reset, stash, branch switch, commit or push is part of a source switch. Build and source validation must not publish local work.

## Gates

- Unit/contract tests for strict client confirmation, one admission, changed sources, failed preflight, missing workspace, dirty and ahead states, safe origin display, source mode and failure outcomes. Diagnostics use synthetic private sentinels and bounded categories only.
- Disposable native Git→path→Git tests: same plugin ID, real changed behavior, expected settings/secrets/schedule loss, local source files/commits retained, disabled state handled honestly, actual updater self replacement and durable outcomes, install failure after removal without repeated destructive writes.
- Native file-writing Pause/drain behavior where affected; do not substitute an idle read for a reservation.
- Rendered BB desktop/narrow/keyboard review: mode labels/actions, origin and separate edited/unpushed states, warning/Cancel/confirm, progress, failures and reconfiguration guidance. Compare with the existing compact Settings page.
- Commit/push/deploy only the controls. A fresh harmless live read verifies delivery; no live source switch is authorized by this implementation task.

## Implementation decisions

- Keep the existing Application admission/persistence boundary. A source switch is a confirmed operation on one of the six known IDs, never an arbitrary source command.
- BB removal disposes the updater itself, so an independent finite Node task must finish that switch. It uses the captured public loopback API, not an untyped CLI locator, a second supervisor or a restarted background task. Persist admission and inspect outcomes; never replay an unknown write.
- SDK 0.6.37 has no plugin-files storage API. Bounded operation receipts live in a private application-owned state folder outside BB's data/cache directories, separated by a hash of the running server's identity. Settings, credentials and personal account content are not backed up there. BB KV is separate from settings and is not cleared by the inspected uninstall path.
- Reserve/drain file writers first. Transfer every mirror's pause to a user-style pause before removal, clearing automatic resume rights; release the reservation only once the handoff is confirmed. No folder is enabled after resetting credentials.
- Native fresh installation starts enabled. Reject switching an already-disabled plugin rather than silently starting it; preserving disabled state without startup needs upstream support or a separately explicit capability.
- Recheck local identity/generation immediately before native installation, including after removal. The native generic install API still lacks an atomic expected-plugin-ID constraint. Exact preview pins and mid-switch editing locks remain waived: keep the selected source unchanged until the switch finishes, and do not describe this two-operation transition as atomic.
- Configured origin is normalized from the actual isolated Git config. `dirty` describes edited files; `ahead` is described as verified unpushed commits only when a fresh fetch actually matched that origin. Missing or differing origins stay unverified, not clean.

## Verification

The backend and Git metadata pass 210 tests, four Git-first scenarios/15 steps, typecheck and the SDK-pin check. Updater 0.4.0 builds. Independent read-only review identified recovery gaps around a dead task and uncertain reservation acquisition. Regressions now cover UUID/PID-bound ownership, positive process-death proof, explicit recovery after operator BB restart when prior delivery cannot be settled, and post-removal local identity checks. Startup remains observe-only; no mutation is replayed.

Original-handler native switching now passes on BB 0.46.1 and 0.47.1: per version, 11 removals and 16 install jobs (one deliberate failure), with no automatic folder enables. The ordinary same-version and updater self roundtrips, expected configuration loss with retained data, refusal/failure/manual recovery, original Pause caller/drain semantics, owned-task SIGKILL and restart-gated null-hold cleanup are verified. [Portable evidence](022-native-source-mode-evidence.json) records hashes, coverage and exclusions. These tests do not claim real Apple/rclone activity or a BB binary upgrade.

Rendered review uses the original app in disposable BB 0.46.0 with validated synthetic RPC states: 41 states at desktop/narrow widths, 24 plugin/direction/viewport warning cases and 166 screenshots. Keyboard Cancel/Tab/Escape/return focus, no writes on cancellation, one explicit confirmation and saved failure/recovery outcomes pass. Actual rejected RPCs and lost responses do not leak private error text or replay writes. Fresh per-row origin verification prevents a previous successful snapshot from producing a false green during a new check. The parent inspected actual desktop/narrow, local-origin, ordinary/self warnings, rejected-response and progress screenshots. This is UI proof, not native switching proof; no live plugin was switched.

The final display/error changes do not modify the tested mutation engine; its five recorded source-file hashes still match the frozen native fixture. Selected rendered evidence: [desktop](022-source-modes-desktop.png), [local details](022-local-details-narrow.png), [reset warning](022-switch-warning-narrow.png), [updater warning](022-self-switch-warning-narrow.png), [unverified progress](022-unverified-progress-narrow.png).

## Delivery observation

Implementation `3c574b2` is pushed and updater **0.4.0** is running after a targeted native Git update. Fresh live inspection and desktop/narrow review show all six source controls enabled. Ordinary and updater-self warnings were opened and cancelled, including keyboard focus return; no source-switch or other write RPC was attempted. The page reported no browser errors.

All 44 installed plugins retained their status and enablement; only the intended updater version changed. BB 0.46.1, Pi 1.3.0 and Codex 0.163.0 stayed installed. All six PA sources remain **GitHub**, with no source-switch receipt or reset. Working-copy runtime dependencies were prepared with install scripts disabled, without loading those plugins, and the checkout stayed clean. Private server guidance was aligned outside the checkout.

## Follow-up

Remove the loss warning only after configuration preservation is proven through a tested workaround or a supported upstream BB change. Keep this separate from delivering the initial controls.
