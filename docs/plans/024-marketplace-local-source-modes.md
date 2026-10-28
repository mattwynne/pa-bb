# Marketplace installs can be tried locally

Status: verified; delivery in progress.

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
- PA: 273 tests, four acceptance scenarios/15 steps, typecheck, SDK alignment
  and build passed. Includes distinct registration/capability eligibility,
  revoked support at both task checks, protected registrations and privacy.
- Rendered original app: 48 states at desktop/narrow widths, 188 screenshots,
  24 confirmations, keyboard/Cancel/focus, legacy outcomes and the saved
  unsupported attempt. No account writes.
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

Pending targeted updater delivery and pinned fork cutover, preserving the
server's existing working changes. Do not switch live plugins as a test or
replay the user's earlier refused attempt. The user chooses a fresh switch
when the updated controls are ready.
