---
name: bb-ship-feedback
description: Ship verified PA for BB repository changes and get feedback from the running BB installation. Use after implementing plugin, marketplace, or documentation changes that are ready for delivery.
---

# Ship and get feedback

The default end to implementation in this repository is **verify → commit → push → deploy → observe**, not “code complete, awaiting a separate request.” Do this without asking for routine permission. Follow `../../../AGENTS.md` and `../../../docs/o11y-standards.md`; for any plugin UI change also load `../bb-plugin-ux/SKILL.md`. Its rendered-BB review remains a release gate even if tests pass.

1. Review the diff and working-tree status. Stage only your own changes; never include someone else's concurrent edits. Run the affected package tests and typechecks, plus applicable shared checks. Preserve user data and grants. Stop and report any failing gate rather than shipping unverified code.
2. Commit on `main`, push the commit to `origin/main`, and deploy only the affected plugin(s). A Git marketplace refresh does not update installed plugins. On Matt's PA BB host, use `ssh hub.local` and Proxmox LXC `120` (`pa`); the BB CLI works through `pct exec 120 -- runuser -u matt -- /usr/bin/env node /home/matt/.local/lib/node_modules/bb-app/host-daemon/dist/bb`. Check `bb plugin outdated`, then `bb plugin update <id> --yes` for each affected plugin, **never `--all`**. Document-only changes need no plugin update. BB snapshots plugin state before an update, but that is not a substitute for checking the result.
3. Confirm the installed version/commit, that the plugin is running, and that existing credentials and other plugins remain intact. Exercise a narrowly scoped **read-only** RPC or tool call; inspect plugin logs for bounded errors without printing private results or secrets. Do not perform a live mutation merely to prove a deploy. For UI changes, inspect the rendered BB page in relevant states and widths with keyboard navigation; if that cannot be done, say the UX gate is unverified rather than claiming release complete.
4. Report the shipped commit, installed versions, tests, live observations, and any unverified gate or rollback. If the server is unreachable or deployment fails, say what did and did not ship. Seek user input only for an actual blocker, risky migration, or consequential action outside the requested work.

Do not log OAuth callbacks, tokens, account addresses, provider bodies, or arbitrary exception messages while diagnosing production. Do not auto-retry uncertain writes.
