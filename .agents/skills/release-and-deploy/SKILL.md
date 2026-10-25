---
name: release-and-deploy
description: Deliver verified PA for BB changes and get feedback from the running BB installation. Use after implementing plugin, marketplace, or documentation changes that are ready for delivery.
---

# Release and deploy

Finish with working code and feedback, not just a passing build. Follow `../../../AGENTS.md`, `../../../docs/o11y-standards.md` and, for UI work, `../bb-plugin-ux/SKILL.md`.

## Normal development

On the server, use **edit → verify → apply locally → observe → commit and push**. For changes arriving from elsewhere, verify them, commit/push, then safely fast-forward the server working copy and apply them. Respect explicit review, publication or deployment holds; don't ask for routine permission already covered by the task.

1. Inspect the working tree and diff. Preserve others' work and stage only your own files. Run affected tests, typechecks and shared checks. A failing gate must be reported, not hidden.
2. Build/reload the intended plugin through BB's supported local-path lifecycle, retaining its ID, settings, credentials, enabled state and data. Applying code does not commit or push it. Existing managed installations may receive a targeted native Git update during transition; never update all plugins as a bootstrap or claim that this switches their source mode. Source switching requires BB's explicit configuration-preserving capability and native same-ID installation, never uninstall/reinstall. Delivering/testing the controls never grants permission to switch configured live plugins. Never patch BB's database or cache to change sources.
3. Before changing a file-writing plugin, use its supported Pause controls to reserve the update window and drain active work. Restore only the previously enabled folders afterwards. Do not clear failures, locks, sync baselines or recovery state to make deployment pass.
4. Confirm the intended code is applied, not merely present in the working copy. Use a narrowly scoped read-only RPC/tool call and bounded logs. Don't perform a live account mutation just to prove deployment. Review UI in running BB at desktop/narrow widths and with keyboard navigation; otherwise report that gate as unverified.
5. Commit on `main`, push the intended work to `origin/main`, and report what changed, what is running, verification and any remaining limit. No separate component release is required. Documentation-only work needs no plugin reload.

Use the operator's private infrastructure notes for access. Keep private deployment details out of public docs. Don't print credentials, account content, raw exceptions or callback URLs. Don't retry uncertain writes automatically.

## Optional distribution releases

Publish a versioned release only when explicitly requested for distribution. Existing historical releases remain valid; never move their tags or replace their assets. Do not build a release pipeline or enlarge credential permissions as part of ordinary server development.
