# Marketplace installs can be tried locally

Status: delivered. PA updates 0.5.1 (`0285b4c`) and standalone BB fork `52a6a22ba` are running.

## What went wrong

Iteration 023 tested direct Git installs. The real six-plugin installation had
marketplace registrations backed by the same Git repository. The page checked
BB's direct-source capability but not each plugin's registration. It offered a
switch that the admission check correctly refused, then incorrectly suggested
updating BB. No native installation or removal began.

A separate development conversation also presented committing/pushing as
necessary to review a new UI. That is not the intended workflow. An agent must
inspect the installed source and offer a preserving Local development switch,
with permission, so unpublished work can be tried first. If switching is
unavailable, explain the blocker and offer a disposable BB preview. Publication
is a separate choice, not a prerequisite for UI review.

## Fix

The standalone BB fork adds one narrow transition to its existing lifecycle:
a Git-backed marketplace registration can move to a direct local path with the
same plugin ID. Configuration, storage, enablement and failed-start restoration
are retained. On failure, the original marketplace registration is restored.
No uninstall, private database edit or migration mechanism is involved.

BB separately advertises `experimental_catalogGitToLocalSourceMoves: true`.
`experimental_directPluginSourceMoves` alone does not authorize this move.
PA updates 0.5.1 checks the capability appropriate to each actual registration,
including again in the independent task immediately before native admission.
Missing, malformed, false or unavailable support disables switching. Bundled,
npm, unknown and managed-to-managed replacements remain excluded.

Choosing local development deliberately makes this a direct installation rather
than a marketplace installation. Choosing GitHub afterwards uses the direct Git
source; it does not silently restore marketplace ownership. Files, edits,
unpushed commits, configuration and data are kept throughout.

Errors no longer prescribe a BB upgrade. An unsupported attempt that stopped
before native admission says **Switch did not start**, rather than implying a
partially applied change. Its saved outcome remains available, and nothing is
replayed when the controller or BB reloads.

## Verification

- Inspected the running version, all six actual registrations/sources, failed
  receipt, active work and working-copy status before editing. The development
  checkout contained unrelated work; delivery must not pull/reset/stash it.
- Reproduced rejection before the fix with real migrated SQLite and the native
  installer: marketplace root/subdirectory moves and disabled-state handling.
- BB: 104 server tests across five relevant files, 23 CLI tests; server,
  server-contract, SDK and CLI typechecks; packaged application build passed.
- PA: 280 tests, four acceptance scenarios/15 steps, typecheck, SDK alignment
  and build passed. Includes distinct registration/capability eligibility,
  revoked support at both task checks, protected registrations and privacy.
- Rendered original app: 48 states at desktop/narrow widths, 188 screenshots,
  24 confirmations, keyboard/Cancel/focus, legacy outcomes and the saved
  unsupported attempt. No account writes.
- The live cutover check found another real-server case: finished update jobs
  use `completed`, not the install-job state `succeeded`. The controller and
  task now validate each job family's actual terminal states separately.
  Active/unknown states still block; a real completed update is seeded before
  native switching tests so this cannot be hidden by a server restart.
- Disposable Linux BB: all six seeded through the real marketplace API, using
  a synthetic HTTPS repository mapped to an owned local bare Git repository.
  Original controller/task code performed 12 successful source switches,
  including Google Drive and actual updater self-replacement both ways.
  Twenty native jobs: 19 succeeded, one deliberately failed; zero removals.
  Configuration, secrets, schedules, storage, inodes, dirty files and unpushed
  work remained intact. Pause ownership, interruption, settled-job recovery
  and no-replay checks passed. Mirrors were synthetic, not real provider work.

The earlier resetting gate and iteration 023's direct-source proof remain
historical evidence, not proof that marketplace installs worked before this fix.

## Delivery

The updater was delivered with a targeted native Git update, not an all-plugin
update or a source conversion. On the older fork, its six marketplace controls
correctly stayed disabled until the separate marketplace capability was present.
The fork was built in a separate source worktree before touching the service.
After supported Pause/drain, no running threads or active native jobs, and a
protected consistent backup, the service moved to that pinned worktree with BB
replacement updates still disabled.

All seven deployed execution-file hashes match the final native gate. Before/
after checks cover 47 plugins: configuration, secret hashes, enablement, running
status and existing storage identities are unchanged; only the intended updater
changed version/source revision. Provider versions and credential-file hashes
are unchanged, and the existing primary host remains connected. Only the one
originally enabled healthy sync folder was resumed.

The development thread committed its unrelated work while this fix was being
prepared. Once the working copy was clean, delivery fast-forwarded only the
controller/policy changes and verified the Google Drive tree was unchanged.
Private server guidance now explicitly offers local testing before publication.

Fresh live inspection verifies all six marketplace controls and their local
runtime dependencies. Desktop/narrow review opened and cancelled Google Drive,
updater-self and file-writer confirmations, checked keyboard/focus and the
honest **Switch did not start** outcome, with zero write attempts/page errors.
No live source switch was used as proof. All six still use their marketplace
GitHub sources, and the earlier refused attempt was not replayed. The user
chooses a fresh switch.
