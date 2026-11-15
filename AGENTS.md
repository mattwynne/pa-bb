# Working in this repository

## PA server development

- Use stock BB with permanent local-path plugin installations from a Git checkout for server development: **edit → reload → try → commit and push**. Applying code does not publish it; pushing does not reload it. A separate versioned release is not required. See [Contributing](CONTRIBUTING.md#local-path-development).
- Edit the checkout that BB actually loads. BB-managed packages and caches are deployments, not source workspaces; do not patch them. Use BB's supported build/reload lifecycle, retaining plugin ID, configuration, enabled state and data.
- Before editing, inspect the branch, edited files and unpushed commits. Preserve unrelated work. Never reset, rebase, merge, stash or publish it silently.
- Use normal Git to inspect and bring in incoming changes. Fast-forward only when safe; stop for local work or divergence and resolve it explicitly. There is no PA updater or source-switching Settings workflow, and no BB fork is required for local-path development.
- Inspect the actual installation before applying code. Moving an existing managed installation to a local path is a separately authorized deployment task, not an implicit development step. Do not uninstall/reinstall configured plugins, edit BB's private database/cache, or assume a source transition preserves state. If safe application is unavailable, use a disposable BB preview and report the blocker.
- Before reloading file-writing integrations, pause and drain applicable work through supported controls. Preserve failures, locks, sync baselines, receipts and recovery state. Restore only prior enablement; never auto-resume a user-paused or failed folder.
- Verify applied code with a harmless read and bounded logs; a checkout matching `origin` does not prove BB is running it. Keep server-wide agent guidance and private infrastructure configuration outside this repository.
- Formal releases remain an optional distribution task, not a prerequisite for server development. Keep native BB and runtime update controls; do not build a replacement updater or expand credential permissions.

## Repository workflow

- Use one implementation thread at a time; do not fan work out to parallel implementation agents. Read-only research/review may run independently.
- For any plugin UI planning, implementation, or review, load the project-local `bb-plugin-ux` skill at `.agents/skills/bb-plugin-ux/SKILL.md`. Its rendered-BB review is a delivery gate, not a passing-build substitute.
- Public documentation must describe portable requirements, not private deployments. Keep hostnames, private addresses, machine IDs, usernames, home paths, and personal provisioning details out of briefs, ADRs, and public references. Keep deployment notes in private infrastructure documentation.
- For plugin backend changes and reviews, follow `docs/o11y-standards.md`; test failure diagnostics without exposing account content or credentials.
- Once implementation passes its gates, load `.agents/skills/release-and-deploy/SKILL.md` and follow its verify, apply, commit/push and feedback steps, subject to explicit deployment/publication holds.
