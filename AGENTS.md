# Working in this repository

- Work in a single agent thread; do not fan work out to parallel implementation agents.
- Work directly on `main` for planning, documentation, and implementation. Do not create worktrees for this repository for now; this project explicitly overrides the default worktree rule in `~/AGENTS.md`.
- For any plugin UI planning, implementation, or review, load the project-local `bb-plugin-ux` skill at `.agents/skills/bb-plugin-ux/SKILL.md`. Its rendered-BB review is a release gate, not a passing-build substitute.
