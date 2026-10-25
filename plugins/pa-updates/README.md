# PA updates

A compact **Settings → PA updates** page for the six PA plugins, BB, Pi and Codex.
For plugin development, the workflow is **edit → try on the server → commit and push**.
GitHub releases and version bumps are not required to detect or apply code changes.

## Everyday use

- **Check again** compares the working copy with fresh `origin` and the last confirmed applied code. It does not alter the working copy, reload a plugin, commit or push.
- **Apply local changes** asks BB to compile/load the affected local-path plugins. It does not pull, commit or push. Try the result before sharing it through normal Git.
- **Update PA** safely fast-forwards incoming source changes and applies affected plugins, together with eligible native BB/Pi/Codex updates. Local work is kept. If the checkout needs a merge, ask PA to review it through normal Git; the updater does not reset, stash or choose a merge strategy.

The footer entry and update notice open this page. Checks show real per-component progress. Opening the page never starts an update. Background checks run every six hours.

## What the rows mean

- **Up to date:** applied code, working files and origin agree. Versions alone cannot earn a green check.
- **Local changes:** edited files or code not yet shared with origin.
- **Updates available:** origin has changes the server has not taken.
- **Local and upstream changes:** both sides changed; review through Git.
- **Changes ready to apply:** known applied code differs from the working copy.
- **Couldn't check:** source or applied-code identity is uncertain. This is not permission to overwrite anything.

The standard source workspace is `$HOME/src/pa-bb`; there is no folder setting or directory search. Locally developed plugins load from its component folders through BB's local-path mode. Reloads and supported source-mode switches preserve configuration and data. Switching requires an explicit host capability; package versions alone are not proof.

BB reload compiles local source itself. BB startup also loads the current working source, so a BB update is held while local edits are unconfirmed. A planned BB restart can itself replace the local-path updater; that replacement is observed, not repeated.

The updater records confirmed native loads, including a file-generation stamp. Restoring old file contents after loading different code cannot falsely produce a green check. Code applied outside this workflow may require an explicit local application to confirm it again.

## Existing GitHub-sourced installations

These use BB's separate installed snapshots. Their normal origin updates still work, including same-version code changes. A missing development checkout is normal. Existing original-build verification remains for these installations during transition: cached proofs or independently reconstructed originals in owned temporary directories, using already-installed/retained builders only. It never changes the working copy or runs a candidate plugin. No historical toolchains are downloaded.

## Switch between GitHub and local development

Each PA row shows **GitHub** or **Local development**, with a control for the other mode. Confirm **Switch source** to use BB's native same-ID install operation, keeping configuration and data. The updater never uninstalls a plugin to switch its source. These controls currently require an enabled plugin so the newly loaded code can be verified; they never enable a disabled plugin implicitly.

Prepare the standard checkout and run `npm ci` in the intended plugin folder before choosing local development. BB's local install does not install runtime dependencies automatically. Local mode displays the configured Git origin safely, edited files and unpushed commits separately. Unpushed status is unverified when the comparison did not check that origin. Do not edit the selected plugin while a switch is in progress.

Switching does not pull, reset, stash, commit or push the working copy. Switching to GitHub installs its managed `main` source; this is not a claim that every commit is a tagged distribution release. Switching to local development loads the current working files, including edits.

BB must advertise `experimental_directPluginSourceMoves: true` through its version API. A stock version number, including 0.47.1, does not establish support. Unsupported hosts disable these controls; there is no destructive fallback. Direct Git/path sources are supported, not catalog/npm/builtin replacement. Do not patch BB's database or cache. Deploying the controls does not authorize switching configured plugins.

## Data, consent and recovery

Ordinary updates and supported source switches retain configuration, enabled state and persistent data. Existing receipts from the historical resetting implementation still report what happened; new switches never select that implementation. Source checks use an isolated Git directory/index without owner hooks or filters. Fast-forwards stop on local work or ignored-file collisions; they do not push anything.

File-writing integrations are reserved and drained through their supported Pause controls before changing code. Updates and source switches retain reservation ownership and restore only previously enabled healthy folders. User-paused, failed and retained folders are not automatically enabled. The current iCloud/Obsidian 0.3.x note-interface family is supported; older pairs need their [documented stopped migration](../icloud/README.md).

Native BB restart consent for running threads remains. A BB installation pinned and updated outside the native updater is labelled **Managed separately**, not offered a stock replacement. Pi/Codex updates affect the configured PA execution host, not the browser's computer, and do not forcibly refresh existing provider sessions.

Results survive updater replacement and BB restart. Completed steps remain completed; unknown writes are never retried automatically. After an uncertain result, inspect the saved outcome before retrying or resuming reserved folders. **Check recovery** verifies the current target or original source and safely clears pause ownership; it never removes, installs or replays a switch. An unsettled native operation or unverified pause window may require an operator BB restart after running work finishes. Missing or ambiguous runner ownership remains blocked rather than guessed. The plugin does not restart BB automatically for recovery and is not a rollback or session-supervision system.

Switching the updater itself reloads this page. Save the independent native install command shown in its confirmation outside BB first. A finite independent task finishes the native switch and records the outcome; startup does not replay it. Bounded private operation receipts live under `$HOME/.local/state/pa-updates/source-modes/`, outside BB's database/cache. They contain no backed-up settings or credentials.

## Development and verification

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:rendered
```

Temporary-repository tests cover local, incoming, both-sided and same-version changes, read-only checks, safe fast-forward and preservation of local/ignored files. Native disposable gates use synthetic settings, secrets and data only:

- `test/run-local-path-gate.mjs`: native reload and same-ID local-folder movement preserve data and disabled state.
- `test/run-local-development-gate.mjs`: original updater handlers, edit/try before push, same-version local/origin changes, self replacement, source-only updates, kept work and actual same-binary BB restarts. It does not claim to upgrade the BB binary.
- `test/run-source-mode-gate.mjs`: original-handler Git↔local switches on a disposable capability-advertising BB fork, actual updater self-replacement, retained configuration/storage, failed installation keeping the previous registration, no replay, original Pause/drain/resume ownership and process-death/restart recovery. Zero native removals and zero helper user-Pause calls. Synthetic mirrors are not real Apple/rclone activity. [Current evidence](../../docs/plans/023-preserving-source-mode-evidence.json); the older resetting gate remains historical in iteration 022.
- Existing ordinary/runtime/paired-sync gates retain their narrower historical evidence; rerun affected boundaries, not every old version combination.

Rendered review uses the original app in disposable BB at desktop/narrow widths with keyboard checks. Unit tests or version labels do not substitute for it. Historical Calendar release records and publisher tests remain separate from the updater's Git-based workflow.
