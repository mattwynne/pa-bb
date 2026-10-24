# Keep PA's server code and origin understandable

Status: Git-first updater 0.3.0 delivered in [iteration 021](../plans/021-git-first-pa-updates.md). [Iteration 022](../plans/022-plugin-source-modes.md) adds per-plugin switches to/from local development, initially with an explicit settings-loss warning.

## Problem

Agents need to hack on plugins from the server, try their changes, and send them back to `origin`. Other contributors also change `origin`. The owner needs to see both kinds of drift without managing a release catalogue or guessing which copy of the code BB is using.

BB currently loads separate GitHub-sourced snapshots for these installations, not the editable server working copy. A working copy can match `origin` while BB still runs older code. Comparing package versions, whole-repository commits or published-release labels does not answer this question correctly.

## Desired workflow

**Edit → try on the server → commit and push.**

- One standard working copy, used by agents and by locally developed plugins through BB's local-path mode.
- Same plugin ID and persistent data directory. Retaining settings and credentials remains the desired end state; the initial source switch may delete them only after an explicit per-plugin warning and confirmation.
- Explicit build/reload to apply code. Applying does not commit or push it; pushing does not apply it.
- Fresh, read-only checks against `origin`. Local edits and unpushed commits remain visible and are kept by default.
- Safe updates from `origin`; when both sides changed, agents resolve differences through normal Git. No silent overwrite or invented merge engine.
- No mandatory versioned-release stage. Existing releases remain historical distribution records, not the updater's source of truth.

## Settings page

Keep **Settings → PA updates**, its footer entry, update notice, compact icon/name rows, real checking progress and saved results. Show all installed supported PA plugins and the existing BB/Pi/Codex rows.

Use **Local changes**, **Updates available**, **Local and upstream changes**, and **Changes ready to apply**. Green **Up to date** requires verified agreement between applied code, working copy and `origin`. Failed or unknown checks are never green. Detect changes even when package versions are unchanged.

Provide **Check again**, explicit application of local code, and **Update PA** for safe incoming updates. Each PA plugin also offers **GitHub** or **Local development**, with an explicit reset warning before switching. In local mode show the safe Git origin, uncommitted changes and unpushed commits separately. Keep commits, pushes and conflict resolution in agents' normal Git workflow rather than building a Git client into Settings. No source-folder field.

## Boundaries

Use supported BB lifecycle operations and preserve data, file-writing sync ownership and restart consent. Keep native update controls. Do not fork BB, patch managed caches, edit its private database, force provider-session refreshes or construct a rollback framework. Deployment/testing of controls never authorizes switching real configured plugins.

The current BB installer restricts in-place source moves to local-path-to-local-path. The owner has approved an initial explicit per-plugin native uninstall/reinstall, warning that settings, credentials and schedules are lost and reconfiguration is necessary. Keep source files and commits intact, drain file writers, leave their folders paused and report partial failures honestly. Do not start a disabled plugin silently. Removing that warning through proven preservation or upstream BB support is a separate follow-up, not a prerequisite.

Historical implementation and evidence remain in [017](../plans/017-pa-update-discovery.md), [018](../plans/018-pa-platform-updates.md) and its [ordinary-update proof](../plans/018-pa-platform-updates-ordinary-proof.md). [Plan 020](../plans/020-component-releases.md) and [ADR 0002](../adrs/0002-component-releases.md) record the superseded release-based direction.
