---
name: release-and-deploy
description: Deliver verified PA for BB changes and get feedback from the running BB installation. Use after implementing plugin, marketplace, or documentation changes that are ready for delivery.
---

# Release and deploy

Finish with working code and feedback, not just a passing build. Follow `../../../AGENTS.md`, `../../../docs/o11y-standards.md` and, for UI work, `../bb-plugin-ux/SKILL.md`.

## Normal development

Use stock BB with permanent local-path plugin installations from a Git checkout: **edit → reload → try → commit and push**. Verify affected source before reloading and observe applied behaviour before publishing. For incoming changes, inspect local work and use normal Git to safely fast-forward the checkout, then verify/reload/try. Stop on divergence rather than overwriting work or inventing a merge strategy. Respect explicit review, publication or deployment holds.

Before applying unpublished work, inspect the actual installed source. Build/reload the checkout BB loads; never patch a managed package or cache. A local preview does not require a commit/push. Moving an existing managed installation to a local path is a separate deployment task requiring authorization and a verified state-preserving route. This workflow does not require a BB fork or source-switching controls. If safe application is blocked, report it and use a disposable BB preview.

1. Inspect the working tree and diff. Preserve others' work and stage only your own files. Run affected tests, typechecks and shared checks. A failing gate must be reported, not hidden.
2. Build/reload only the intended local-path plugin through BB's supported lifecycle, retaining its ID, settings, credentials, enabled state and data. Applying code does not commit or push it. Never update all plugins as a bootstrap, uninstall/reinstall a configured integration, or patch BB's database/cache to change sources.
3. Before changing a file-writing plugin, use its supported Pause controls and drain active work. Restore only prior plugin/folder enablement afterwards; do not resume user-paused or failed folders. Do not clear failures, locks, sync baselines, receipts or recovery state to make deployment pass. Existing iCloud updater Pause reservations must be settled before retiring an installed updater; source deletion does not release those durable holds.
4. Confirm the intended code is applied, not merely present in the working copy. Use a narrowly scoped read-only RPC/tool call and bounded logs. Don't perform a live account mutation just to prove deployment. Review UI in running BB at desktop/narrow widths and with keyboard navigation; otherwise report that gate as unverified.
5. Commit only owned changes on the authorized branch. Integrate and push to `origin/main` only when authorized; never include unrelated work. Report what changed, what is running, verification and any remaining limit. No separate component release is required. Documentation-only work needs no plugin reload.

Use the operator's private infrastructure notes for access. Keep private deployment details out of public docs. Don't print credentials, account content, raw exceptions or callback URLs. Don't retry uncertain writes automatically.

## Optional distribution releases

Publish a versioned release only when explicitly requested for distribution. Existing historical releases remain valid; never move their tags or replace their assets. Do not build a release pipeline or enlarge credential permissions as part of ordinary server development.
