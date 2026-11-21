# PA Toolsmith

Improve PA's BB plugins in response to needs encountered while using PA. This adapts [Jesse Vincent's Toolsmith](https://github.com/prime-radiant-inc/toolsmith): the durable tools here are BB plugins, and the specialist works in a visible BB thread.

## Pilot workflow

1. When a capability is missing or a recurring workaround is worth removing, check existing plugins and offer one specific improvement.
2. Wait for the user to confirm. Open a visible child thread in a fresh worktree with a focused brief and a synthetic example. Link it from the original conversation.
3. The child builds, tests, safely loads, and verifies the improvement under PA's normal development rules. The original chat can continue with other work. Publication, credential changes, and live account writes are separate.
4. The child reports through BB's parent notifications. The original chat explains what's available, whether it needs a fresh session, or what's blocked. Nothing automatically replays a live account action.

The confirmation is conversational. This pilot does not expose a privileged spawn API, fork the conversation, install upstream hooks, add a custom panel, or run background automation. Agents use BB's normal thread command and permission policy. Multiple approved tasks may have visible threads at once. Implementation is single-threaded per plugin: each worker's first decision is to run `bb toolsmith claim <plugin>...` for the plugin(s) it will change (existing or new). Claims are exclusive and all-or-nothing, recorded atomically in the plugin's storage, and dropped when the owner's thread is archived or deleted. A refused claim leaves the worker on read-only research and planning until the owner runs `bb toolsmith release` or hands off. Workers on different plugins proceed in parallel. Research is always independent. All workers still serialize integration into the shared checkout and reloads of the same plugin. A claim records intent and gates cooperating workers; it does not technically prevent edits.

## Configure and verify

Use the normal PA local-path plugin workflow. Select the PA development project under Toolsmith settings, or use `bb plugin config toolsmith set project <project-id>`. A new agent session discovers the [pa-toolsmith skill](skills/pa-toolsmith/SKILL.md).

`bb toolsmith status --json` is a read-only preflight. `ready` means it found a configured project with a checkout and completed its bounded scan. It permits a new handoff even when other work exists: `otherThreads` lists active, pending, or background workers and `claims` lists live plugin owners. This is not permission to implement concurrently on the same plugin. `unconfigured`, `invalid_project`, `incomplete`, and command errors still block handoff. The command checks hidden work too, but cannot detect plans or ownership outside BB's view. It no longer returns `busy` merely because another task exists.

Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build` from this package. To pilot the conversation loop, try an existing supported capability (no offer), an actual narrow capability gap (offer only), then explicitly confirm one scoped request (one visible child with a sanitized brief and a report back). Do not use real account changes as test fixtures.

See [UPSTREAM.md](UPSTREAM.md) for sources and how this differs from the upstream plugin.
