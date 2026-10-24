# Working in this repository

## PA server development

- Follow the [Git-first updater specification](docs/plans/021-git-first-pa-updates.md): **edit → try on the server → commit and push**. Changes from `origin` become available updates; a separate versioned release is not required. ADR 0002 and plan 020 are superseded for this workflow.
- Work in `$HOME/src/pa-bb`. Locally developed plugins should load from this working copy through BB's local-path mode. BB-managed packages and caches are deployments, not source workspaces; do not patch them.
- Keep the plugin ID and data directory when changing its code source. Prefer a supported in-place operation. Until BB supports Git↔local changes, the owner has approved per-plugin native uninstall/reinstall ONLY after an explicit Settings confirmation warning that settings, credentials and schedules will be deleted. This does not authorize switching live plugins merely to deploy or test the controls. Never edit BB's private database/cache or introduce a data-migration framework.
- Inspect the branch, edited files and unpushed commits before editing. Preserve unrelated work. Never reset, rebase, merge, stash or publish it silently.
- **Check again** is read-only: fetch comparison refs in an owned temporary directory. **Update PA** may explicitly fast-forward the working copy; it must stop rather than overwrite local work or invent a merge strategy. Applying local changes builds/reloads without committing or pushing them.
- Compare plugin contents, not just versions or whole-repository commits. A working copy matching `origin` is not proof that BB is running that code. Unknown or unapplied code must not get a green **Up to date** check.
- Agents use normal Git for commits, pushes and resolving both-sided changes. The Settings page is not a Git client. Keep server-wide agent guidance outside the checkout; do not alter source merely to refresh private instructions.
- Formal releases remain an optional distribution task, not a prerequisite for server development. Do not build a release catalogue or expand credential permissions for this updater.

## Repository workflow

- Use one implementation thread at a time; do not fan work out to parallel implementation agents. Sequential subagents are approved for the source-mode controls; read-only research/review may run independently.
- Work directly on `main` for planning, documentation, and implementation. Do not create worktrees for this repository for now; this project explicitly overrides the default worktree rule in `~/AGENTS.md`.
- For any plugin UI planning, implementation, or review, load the project-local `bb-plugin-ux` skill at `.agents/skills/bb-plugin-ux/SKILL.md`. Its rendered-BB review is a delivery gate, not a passing-build substitute.
- Public documentation must describe portable requirements, not Matt's private deployment. Keep hostnames, private addresses, machine IDs, usernames, home paths, and personal provisioning details out of briefs, ADRs, and public references. Keep deployment notes in private infrastructure documentation.
- For plugin backend changes and reviews, follow `docs/o11y-standards.md`; test failure diagnostics without exposing account content or credentials.
- Once implementation passes its gates, load `.agents/skills/release-and-deploy/SKILL.md` and follow its verify, apply, commit/push and feedback steps rather than stopping at a local test pass.
