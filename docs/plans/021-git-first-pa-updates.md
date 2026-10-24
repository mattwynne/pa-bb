# 021 — Git-first PA updates

Status: updater 0.3.0 delivered; local-path development verified in disposable BB. Existing managed installations still need BB's supported Git-to-local source switch before they can use local development. Supersedes the release-based updater direction in ADR 0002 and plan 020.

## Purpose

Make **edit → try on the server → commit and push** easy. Show when PA differs from `origin`, whether from local work or other contributors. A push makes changes available; applying them makes them run. Neither requires a versioned release.

Keep the existing compact **Settings → PA updates** home, footer link, update notice, real per-component check progress and saved outcomes. There is no PA platform version, release catalogue, source-folder setting or Git dashboard.

## Source and applied code

Agents edit the standard `$HOME/src/pa-bb` working copy. Locally developed plugins use BB's local-path mode with the same plugin IDs and persistent data directories. Editing files does not imply that a new build is running.

Track two facts internally: the working copy's differences from `origin`, and which plugin contents BB last applied. Versions are secondary information. Same-version code changes count; unrelated repository changes must not offer every plugin an update.

The six PA plugins remain separate rows. BB, Pi and Codex retain their normal version-based vendor updates on the existing selected execution host.

## Row states

| State | Meaning |
| --- | --- |
| **Up to date** | Applied code, working copy and `origin` agree. Only a successful current check earns green. |
| **Local changes** | Edited files or commits not present on `origin`. Keep these by default. |
| **Updates available** | `origin` contains changes not yet taken by the server. |
| **Local and upstream changes** | Both sides changed. Review through normal Git; never silently merge or discard. |
| **Changes ready to apply** | The working copy contains code BB has not applied. This can accompany local changes. |
| **Couldn't check** | Source, origin or applied-code identity cannot be established. Not green, and not update authority. |

A commit pushed to `origin` is no longer unpushed work. If BB still runs older code, show changes ready to apply instead of inventing a pushed-but-unreleased state.

## Actions

- **Check again:** read-only comparison, fetching fresh comparison refs in an owned temporary Git directory. No working-copy build, reload, push, owner-checkout fetch or account write. Existing Git-snapshot installations retain their isolated original-build verification during transition; it never runs a candidate plugin or changes the working copy. Local-path checks need no reconstructed build.
- **Apply local changes:** explicitly build/reload the affected working-copy plugins. Do not commit, push, pull, switch branches or overwrite local source. Record which contents were applied only after successful activation. A failed or uncertain operation must remain visible and must not be retried automatically.
- **Update PA:** bring in safe changes from `origin` and apply affected code, plus ordinary eligible vendor updates. Use a fast-forward only; if normal Git cannot do this without losing local work, stop that source update and explain what needs review. No automatic reset, stash, rebase, merge strategy or partial cherry-pick engine.
- **Keep local** remains the default. Source conflicts are resolved by agents using normal Git, not by an updater that silently chooses one side. The page need not offer commit, push or merge controls.

Do not show versions as the only evidence of a change, or say that editing/applying code has shared it with others. Preserve native BB running-thread restart consent. Updating a CLI does not refresh existing provider sessions.

## Safety retained

Preserve settings, credentials, enabled state, user source work, sync ownership and update outcomes. Reserve/drain file-writing integrations through existing Pause controls before build/reload; restore only previously enabled folders. Keep the established BB restart handling. BB startup also compiles current local-path source: hold a BB restart while local edits are unconfirmed, and record an expected local self replacement before a planned BB restart rather than reloading it twice. Otherwise apply the updater last. Don't create another session supervisor, rollback system or dependency framework.

Changing the code source is not a data migration. Do not uninstall a configured plugin, edit BB's private database or patch its managed cache. BB 0.46.1 and the inspected 0.47.1 registration path permit direct local-path moves only when the existing source is also a direct local path. A supported Git-to-local source switch is therefore a concrete transition dependency, not a reason to add release infrastructure. Test local-mode behavior in disposable BB; don't claim the live installations have switched until that operation exists and is verified.

## Delivery steps

1. Replace release-based policy/specification with this workflow. Preserve historical decisions and releases as history.
2. Reuse the bounded read-only Git inspector, adding upstream differences and per-plugin content identity. Remove version-increase gates and release-feed dependence from this page.
3. Add applied-code tracking and explicit local build/reload through supported BB operations. Reuse existing sync and runtime lifecycle handling rather than adding a new framework.
4. Render the states above and exercise them in BB at desktop/narrow widths, including keyboard navigation and failed checks.
5. Prove dirty files, unpushed commits, remote-only and both-sided changes, same-version edits, pushed-but-not-applied code and per-plugin isolation in temporary repositories. Check inspection leaves the owner checkout unchanged.
6. Prove local-path build/reload with synthetic settings, secrets, disabled state and data in disposable BB. Verify actual changed behavior, not just a version label. Reuse accepted runtime/sync evidence unless its boundary changed.
7. Commit/push only owned work. Deploy only through a supported operation, observe a safe read, and report the live source-switch dependency separately if still blocked. Do not apply unrelated workspace changes merely to test the updater.

## Verification

Updater 0.3.0 passes 106 unit tests, four Git-first scenarios (15 steps), typecheck, SDK-pin check and native build. The obsolete Calendar release-discovery service, GitHub feed, duplicate inventory/Git adapters and release-choice UI fixtures were removed. The historical release-record validator remains only for publisher tests and optional distribution.

The disposable BB 0.47.1 gate uses the original updater handlers and fresh local-path installations. It verifies edit/apply before commit or push, same-version source changes locally and from origin, affected-component isolation, self replacement with the same saved job, root-documentation-only synchronization, kept both-sided work and preserved synthetic settings/secrets/KV. Two actual same-binary server restarts prove planned implicit self loading is not repeated and restored source files cannot falsely certify different running code. This is not a BB binary-upgrade test, existing Git-to-local transition or real-provider proof.

The separate local-path primitive gate verifies that editing or building alone does not replace loaded code, native reload compiles working source, and same-ID local-folder moves preserve disabled state and the data-directory inode.

Read-only safety review found two defects, both fixed with regressions: failed canonical-source inspection now holds BB restart; applied-code receipts require matching file-generation metadata, not just restored source bytes. No uncertain native operation is replayed.

Rendered review in BB 0.46.0 uses the original app with validated synthetic RPC states: current, local, incoming same-version, both-sided, pushed-but-unapplied, unconfirmed applied code, live per-row progress, restart consent, source-only readiness, failed checks and uncertain saved outcomes. Desktop/narrow screenshots, native footer keyboard navigation, local-apply keyboard activation and consent controls pass. A failed check stays unconfirmed after an unrelated read of the old successful snapshot, until a fresh check succeeds. No accounts are connected or written. Comparison with Calendar confirms native layout/tokens without copying its multi-account model. The narrow sidebar's animation is allowed to settle before judging geometry.

Selected rendered evidence: [desktop](021-local-desktop.png), [local changes](021-local-narrow.png), [both sides](021-both-sided-narrow.png), [progress](021-check-progress-narrow.png), [restart consent](021-restart-consent-narrow.png), [source-only update](021-source-only-narrow.png), [uncertain result/recovery](021-uncertain-narrow.png).

The package version increases once so older version-gated updater installations can discover this controller. It is not a new requirement to version or publish every source edit. Live application and the unsupported source-switch dependency must be reported separately.

## Delivery observation

Implementation `73d7e1f` is pushed. A targeted native update activated updater **0.3.0** on BB **0.46.1**. A fresh read-only check and desktop/narrow rendered inspection succeeded without page errors. All 44 installed plugins retained their version/status/enablement except the intended updater version change. BB, Pi, Codex and the other PA plugins were not upgraded; no provider/account writes or all-plugin update were used.

The four unchanged PA components correctly agree with both working copy and origin. The existing iCloud/Obsidian source changes appear as **Changes ready to apply** despite unchanged package versions; they remain unapplied. Saved updater history survived replacement. The six PA installations remain managed Git sources, with no local-apply action offered for them: the unsupported in-place source switch is still a real limit, not completed live local development. Server-wide guidance was aligned separately, outside the source checkout.
