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

The standard source workspace is `$HOME/src/pa-bb`; there is no folder setting or directory search. Locally developed plugins load from its component folders through BB's local-path mode. Their IDs, settings and data directories stay the same.

BB reload compiles local source itself. BB startup also loads the current working source, so a BB update is held while local edits are unconfirmed. A planned BB restart can itself replace the local-path updater; that replacement is observed, not repeated.

The updater records confirmed native loads, including a file-generation stamp. Restoring old file contents after loading different code cannot falsely produce a green check. Code applied outside this workflow may require an explicit local application to confirm it again.

## Existing GitHub-sourced installations

These use BB's separate installed snapshots. Their normal origin updates still work, including same-version code changes. A missing development checkout is normal. Existing original-build verification remains for these installations during transition: cached proofs or independently reconstructed originals in owned temporary directories, using already-installed/retained builders only. It never changes the working copy or runs a candidate plugin. No historical toolchains are downloaded.

**An in-place source switch is still required for local editing of an existing managed installation.** BB 0.46.1 and the inspected 0.47.1 support local-folder-to-local-folder moves, but reject Git-to-local-folder replacement. Do not uninstall a configured plugin, patch its cache or edit BB's private database to bypass this restriction. This is an installation capability dependency, not a data-migration task.

## Data, consent and recovery

Settings, credentials, enabled state, user source work and account data remain intact. Source checks use an isolated Git directory/index without owner hooks or filters. Fast-forwards stop on local work or ignored-file collisions; they do not push anything.

File-writing integrations are reserved and drained through their supported Pause controls before changing code. Only previously enabled folders resume; explicitly paused or failed folders remain paused. The current iCloud/Obsidian 0.3.x note-interface family is supported; older pairs need their [documented stopped migration](../icloud/README.md).

Native BB restart consent for running threads remains. Pi/Codex updates affect the configured PA execution host, not the browser's computer, and do not forcibly refresh existing provider sessions.

Results survive updater replacement and BB restart. Completed steps remain completed; unknown writes are never retried automatically. After an uncertain result, inspect the saved outcome before retrying or resuming reserved folders. The plugin is not a rollback or session-supervision system.

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
- Existing ordinary/runtime/paired-sync gates retain their narrower historical evidence; rerun affected boundaries, not every old version combination.

Rendered review uses the original app in disposable BB at desktop/narrow widths with keyboard checks. Unit tests or version labels do not substitute for it. Historical Calendar release records and publisher tests remain separate from the updater's Git-based workflow.
