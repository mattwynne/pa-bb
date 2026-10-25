# 023 — Preserve configuration when changing plugin sources

Status: delivered. PA updates 0.5.0 (`bee6d23`) and the capability-advertising BB fork (`611fb55ba`) are running. Replaces the resetting source-switch path from iteration 022. Tracked by the configuration-preservation follow-up in `yx`.

## Outcome

Switch a PA plugin between GitHub and its standard local development folder without resetting its configuration. Keep the compact six-plugin page, actual origin and separate edited/unpushed facts. Local application remains independent of committing and pushing.

BB changes live in a [standalone fork](https://github.com/mattwynne/bb), not a subtree or vendored copy here. [Core patch `4a1d9d8d7`](https://github.com/mattwynne/bb/commit/4a1d9d8d79fcbb4ca57f2309575786988cbc69cf) extends the existing direct path-move lifecycle to Git↔path. A separate capability commit (`611fb55ba`) lets clients establish support without guessing from package versions. [Upstream proposal #6250](https://github.com/get-bb/bb/issues/6250) requests alignment; no upstream PR has been opened yet.

## Operation and safety

- Require `experimental_directPluginSourceMoves: true` from the current BB version API. Publish the verified fact in inventory and recheck before native admission. Missing, false, malformed or revoked support never permits a destructive fallback.
- Use one native same-ID install, not uninstall/reinstall. Keep the existing Application mutex, persisted admission, finite helper and native install-job observation so updater self-replacement can finish independently of the disposed instance.
- New client-only requests require `confirmSwitch: true`. Old loss-confirmation requests are rejected. New receipts say `configuration: preserved`; historical resetting receipts remain readable and report their original outcome.
- Retain current source/generation, plugin identity, enabled-state and dependency checks. PA controls continue to require enabled plugins so loaded code can be verified; the underlying BB CLI also supports keeping a moved plugin disabled.
- Reserve and drain file writers through the original Pause protocol. Keep original resume rights; do not issue per-folder user-Pause calls. Restore only previously enabled healthy folders after verification. Failed, user-paused and retained folders stay paused.
- Record native job identity. Recovery verifies the target or original source, never replays installation, and requires positive runner absence. An unknown/expired native job requires the admitting server to be conclusively gone. Missing PID evidence cannot clear an admitted write. Known pre-launch cleanup additionally requires the write-ahead launch lock to be absent.
- Native failed activation restores the previous registration. This is not a promise to undo changes made by plugin startup code. Mutable Git `main` and final local parsing remain non-atomic; keep the existing instruction not to edit during a switch.
- Pin fork deployments deliberately. Disable unsupported native replacement updates and label BB **Managed separately**, rather than offering a stock update or claiming the fork is current against upstream.

Deploying the fork or controls does not authorize switching configured live plugins. Use synthetic disposable instances for source transitions, then harmless live reads and confirmation cancellation for delivery feedback. Retain the existing BB data directory and service identity; drain file writers, check active work, take a consistent protected backup and verify preserved registrations/configuration around the BB restart.

## Verification

- BB core patch: 184 focused server tests and 36 CLI tests, typecheck/build, HTTP/SDK and built-CLI roundtrips. An independent read-only review found no correctness issues; the suggested artifact-promotion-failure regression was added. Four existing lint findings reproduce on the unmodified upstream baseline.
- Capability metadata: 25 focused tests, server/server-contract/SDK typecheck. Absence remains backward-compatible; the fork advertises the capability from its actual install implementation.
- PA updates 0.5.0: 260 tests, four scenarios/15 steps, typecheck, SDK pin and build pass. Host-derived capability, old confirmation refusal, no removal/fallback, privacy sentinels, drain/resume sequencing, ownership/process fences and historical recovery are covered.
- Original app rendered in disposable BB: 47 states × desktop/narrow, 24 plugin/direction/viewport confirmations, 184 screenshots. Keyboard Cancel/Tab/Escape/focus return, actual rejected/lost RPC responses, unknown origin progress, unsupported host controls, historical reset receipts and separately managed BB status pass. Parent inspected actual ordinary/updater confirmations; live review remains part of delivery.
- Original handlers and helper against the built fork's native installer: ten successful source switches, including actual updater self-replacement both ways; 16 native install jobs (15 succeeded, one deliberately failed); **zero native removals**. Source work, settings, secret bytes, declared schedules, KV/database/note and data/file identities survive. Previous registration survives failed installation; observer reload/restarts and helper SIGKILL never replay writes.
- Original UpdatePause with synthetic four-class mirrors: no helper user-Pause calls; original resume rights survive replacement and release; only the originally enabled healthy folder resumes. This is not real Apple/rclone activity or a BB binary-upgrade test.

A fixture initially tried registering a cron only once across plugin factories. BB normally prunes schedules not declared by the new factory; that fixture was corrected to redeclare its persistent cron on startup. The core tests separately verify retained schedule run history. Do not describe this as preservation of undeclared/orphan schedule callbacks.

[Bounded native evidence](023-preserving-source-mode-evidence.json) records input and execution hashes, coverage and exclusions. The tested mutation-engine hashes still match; subsequent changes affect only UI/help, tests and documentation.

## Delivery observation

PA updates 0.5.0 was first delivered as a targeted managed Git update. A fresh read on stock BB confirmed all six source controls remained unavailable without the capability, with no fallback or source change. The pinned source fork was then built with the production settings, checked for identical existing SQL migrations, and started only after file writers were paused and idle, running threads/native jobs were absent, and a consistent protected BB backup was complete. Native BB replacement updates are disabled.

The running server reports source installation and the explicit preserving capability. Fresh PA inspection enables all six controls. Actual desktop/narrow review opened and cancelled Calendar, updater-self and file-writer confirmations, verified keyboard focus return, the **Settings and data stay** copy and **Managed separately** BB row, with zero write requests and no page errors.

Before/after comparison covered 47 plugins: configuration, secret-file hashes, enablement, running status, PA data/database identities and the other PA source identities stayed unchanged. Only the intended updater version changed. Primary execution-host identity/connectivity and provider versions remained intact. The one originally enabled healthy mirror was restored through its supported control; no additional folder was enabled. Private server guidance and operational evidence are kept outside this public checkout.

All six PA plugins still use GitHub sources. No live source switch was used as deployment proof; the owner chooses each switch in Settings.
