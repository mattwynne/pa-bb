# Working in this repository

## PA server source workspace

- On a PA server, work in `$HOME/src/pa-bb`. BB-managed installed packages and caches are deployments, not source workspaces; do not patch them.
- Inspect the existing branch, uncommitted changes and unpublished commits before editing. Preserve unrelated work. Do not move, reset, rebase or publish that work as part of an updater task.
- PA updates reads this canonical checkout without changing it. Fetch comparison references only in an owned temporary directory, never in the working checkout. A missing checkout is normal for installations without development work.
- Keep server-wide agent guidance outside the checkout; do not modify unpublished source just to refresh instructions. Installing a released package does not publish or delete workspace changes.

## Component releases

- Follow [ADR 0002 — Component releases](docs/adrs/0002-component-releases.md). Release each PA plugin, including the updater, independently through one shared GitHub release pipeline; there is no PA platform version.
- Pushing, merging, bumping a version, creating a tag or preparing a draft is not a release. Uncommitted, committed and pushed-but-unreleased work all remain **Local changes**, with **Keep local** as the update default.
- Release only the intended component after its required gates pass. Never release unrelated work, overwrite a published release, or declare `main` released merely to clear a warning.
- Pipeline and updater enforcement are still pending. Do not deploy unreleased `main` as a workaround or claim the policy is already enforced; report the blocker. Do not expand credential permissions to bypass release or workflow restrictions.

## Repository workflow

- Work in a single agent thread; do not fan work out to parallel implementation agents.
- Work directly on `main` for planning, documentation, and implementation. Do not create worktrees for this repository for now; this project explicitly overrides the default worktree rule in `~/AGENTS.md`.
- For any plugin UI planning, implementation, or review, load the project-local `bb-plugin-ux` skill at `.agents/skills/bb-plugin-ux/SKILL.md`. Its rendered-BB review is a release gate, not a passing-build substitute.
- Public documentation must describe portable requirements, not Matt's private deployment. Keep hostnames, private addresses, machine IDs, usernames, home paths, and personal provisioning details out of briefs, ADRs, and public references. Keep deployment notes in private infrastructure documentation.
- For plugin backend changes and reviews, follow `docs/o11y-standards.md`; test failure diagnostics without exposing account content or credentials.
- Once implementation passes its gates, load `.agents/skills/release-and-deploy/SKILL.md` and follow its commit, push, component-release, deploy and feedback steps rather than stopping at a local test pass.
