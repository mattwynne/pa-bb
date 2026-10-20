# 018 — Gate 0: blocked on exact-target replacement

**Iteration 18 is not implemented.** The disposable Linux proof failed its
first required safety property on BB **0.45.0 / SDK 0.6.15** and
**0.46.1 / SDK 0.6.49**, both with Node **24.21.0**. After reviewing commit A
and advancing the tracking branch to B, the public update operation installed
**B**, not A. No production plugin, permission, or BB version was changed.

The [plan](018-pa-platform-updates.md#gate-0--prove-installation-is-possible-before-building-apply)
requires stopping here for an owner decision. No Apply UI, application executor,
or multi-integration release publisher was added. The existing read-only updater
remains unchanged.

The owner subsequently broadened the planned review to include individual BB
application, Pi CLI and Codex CLI versions on the selected PA execution host,
without a whole-platform semver or changes to native update pills. That decision
does not resolve or waive this gate. Exact runtime installation, session-safe
maintenance and supported durable ownership across BB restarts need separate
proofs; a plugin process cannot continue supervising while BB is stopped.

## Reproduce

The portable characterization harness is
[`plugins/pa-updates/test/run-installation-gate.mjs`](../../plugins/pa-updates/test/run-installation-gate.mjs).
It needs Linux, Node compatible with the chosen BB package, Git, and network
access for the fixture's pinned Zod dependency. Supply an already-installed BB
package directory; installing a different BB package for testing belongs in a
separate disposable tools directory, not the production installation.

```sh
node plugins/pa-updates/test/run-installation-gate.mjs "$BB_APP_PACKAGE_DIR"
```

The harness creates its own temporary HOME, BB data directory, loopback ports,
and Git repository. It runs the shipped BB server and CLI, not private server
imports or mocked installers. Its four synthetic plugins have no provider access.
Their names deliberately differ from the real integrations. This is a
counterexample to the installation contract, not acceptance coverage of Calendar,
Drive, iCloud, or Obsidian.

**Expected exit: 2, with `gate: "BLOCKED"`.** Exit 1 means the harness failed to
establish the counterexample. The script does not turn a failed product gate into
a passing test. It stops its server and removes successful-run temporary state;
a harness failure retains its isolated directory for diagnosis. Do not attach raw
host logs to public reports. The JSON result contains only generated commit IDs,
versions, fixed categories and boolean checks.

## Actual public operation sequence

1. Create a Git repository with four version-1.0.0 plugin packages and an
   unchanged `v1.0.0` tag. Install two using
   `bb plugin install git:<generated-repository>@main --subdirectory
   plugins/<fixture> --yes --json`. Install the third using `@v1.0.0` and the
   fourth using `@semver:^1.0.0`. Assert all run; confirm the first pair share
   the same managed checkout using `plugin list`'s active `rootDir` fields.
2. Set a synthetic ordinary setting and secret with `plugin config`. The
   original plugins seed a synthetic KV value; A and B never recreate it, so a
   lost database cannot masquerade as preserved state. A typed read-only identity RPC reports
   executable markers and booleans for sentinel equality, never secret values.
3. Edit only the installed sibling fixture's source, run the public `plugin
   build` command for that plugin, and reload it. Confirm its executable marker
   changed to `kept-custom`. Hash every file in that plugin directory, including
   source, dependencies and generated runtime output.
4. Commit A (version 1.0.1 for all but the kept sibling); add `v1.0.1`. Call
   `POST /api/v1/plugins/updates/check` for the branch-tracking and semver-tracking
   fixtures. Assert both returned reviews contain A's full commit ID.
5. Advance the same tracking branch to B (version 1.0.2); add `v1.0.2`.
   Never move or delete an existing tag.
6. Submit `{ "targetCommit": "<A>" }` to the public plugin update endpoint.
   BB returns **HTTP 400**: its strict request schema accepts an empty object
   only. The original runtime remains active.
7. Try `plugin install git:<generated-repository>@<A>` for the existing plugin.
   BB refuses because the plugin is already installed. The original runtime
   remains active. Repeat with `@v1.0.1` for both the branch-tracking and
   tag-pinned fixtures: both are refused, leaving original runtime and sentinels
   intact. The tag-pinned fixture's ordinary update returns HTTP 422 (`pinned`),
   preserving its original source intent. No removal or database change is attempted.
8. Submit the supported empty update body for the branch-tracking and semver-
   tracking fixtures. Both report `updated`; both actual executable RPCs return
   **`unreviewed-B`**. This is the failing gate, not a fallback installation strategy.
9. Check the setting, secret and KV sentinels; all survive. Check the kept
   sibling's full directory hash and runtime marker; both remain unchanged.
   Compare every unrelated plugin's version, enablement and runtime status;
   all remain unchanged.

Source edits alone did not change the sibling's running marker: managed reload
preferred the built server bundle. Building the fixture before reload made the
customization executable. This reinforces the need to assess effective runtime
code, not just Git status or package version.

## Recorded results

| Observation | BB 0.45.0 | BB 0.46.1 |
| --- | --- | --- |
| SDK shipped with server | 0.6.15 | 0.6.49 |
| Review A, advance remote to B, apply | **B installed — failed** | **B installed — failed** |
| Exact-target request | HTTP 400 | HTTP 400 |
| Exact-commit reinstall over existing managed ID | Refused | Refused |
| First installation pinned to `v1.0.0` | Runs original target | Runs original target |
| Existing `main` → fixed `v1.0.1` reinstall | Refused; original retained | Refused; original retained |
| Existing `v1.0.0` → fixed `v1.0.1` reinstall | Refused; original retained | Refused; original retained |
| Ordinary update of fixed-tag install | HTTP 422, pinned | HTTP 422, pinned |
| Semver-tag tracking: review A, publish tag B, apply | **B installed — failed** | **B installed — failed** |
| Synthetic setting, secret and KV state | Preserved | Preserved |
| Customized sibling in shared checkout | Bytes and runtime preserved | Bytes and runtime preserved |
| Unrelated plugin versions, enablement and status | Unchanged | Unchanged |

Generated commit evidence from the completed Linux runs:

| BB | Reviewed A | Remote B, executed after update |
| --- | --- | --- |
| 0.45.0 | `6154b46dfe6ab633f38d360d634f838591684d1e` | `7c73ad2cf1ecc5a7079c8819b1f074ecbcc4367a` |
| 0.46.1 | `a3e8ab70c9f996bddbb565d752ba0877f850a3c6` | `78138041145ac22d0745f9c5f0b3813eb080da77` |

These commits belong to disposable fixtures, not the PA release repository.
A fresh run generates new commits and reports its own evidence. Both final runs
returned the expected blocked exit code **2**.

Regression checks for this evidence-only change: updater **21 tests**, **four
scenarios / 23 steps**, typecheck/SDK-pin check and build passed. The shared
connection-UI drift check, harness syntax check and `git diff --check` passed.
No shipped plugin source or package version changed. These checks validate the
existing pilot and reproduction, not iteration-18 application.

## Can we use a tag?

**Yes for an exact first installation; not as the missing update operation.**
A fixed tag identifies the code, and BB can install it when the plugin is absent.
But BB refuses to retarget an existing managed plugin from `main` to that tag,
or from one fixed tag to another, through reinstall. Its ordinary update refuses
fixed-tag sources because they are pinned. A semver range follows newer tags:
it still installs B after the owner reviewed A. All of these were exercised on
both tested versions, with immutable-by-convention fixture tags that never moved.

Tags therefore solve target identity, not state-preserving application. A tag-
only release policy cannot close Gate 0. The missing operation is **replace this
existing plugin with this exact resolved target, without removing its state**.
Tag protection and resolving to a verified commit would still be needed after
that operation exists; moving a release tag is not a workaround.

## Missing contract and owner decision

BB needs a supported **state-preserving exact-target replacement** operation for
an existing managed plugin. It must accept a verified immutable target (or a
server-owned prepared-artifact handle), activate that target without re-resolving
the tracking source, and preserve the plugin's registration, state, credentials,
enablement and source intent. An expected-current identity must protect against
stale overwrite authorization. Replacing one plugin must not reset shared code
used by a kept sibling.

Inspection of the shipped 0.46.1 contract agrees with the live reproduction:
`pluginApplyUpdateRequestSchema` is a strict empty object;
`plugins.applyUpdate({ pluginId })` has no target; the update service calls
`resolveUpdateForRow` during application. Asynchronous update jobs do not add a
target parameter. The installer permits a state-preserving path-to-path move,
but rejects replacing a managed Git installation with another source. Changing
to a pinned source via remove/install deletes state and is not an allowed route.

**Recommended next step:** request this contract upstream, then rerun Gate 0 on
an explicitly approved supported BB release. No upstream issue has been filed by
this iteration. Do not silently upgrade BB, edit its database, import private
server modules, reset managed caches, or substitute an ordinary latest update.
Any other implementation route requires an explicit owner decision.

## Gates still unverified

- Exact-target installation, including explicit replacement of customized code.
- Exact BB/Pi/Codex runtime targets, installation provenance, session preservation,
  maintenance reservation/consent and supported continuation across BB restarts.
  No runtime mechanism was exercised or ruled out by this plugin-only harness.
- A trustworthy full installed-code baseline for ordinary installations. The
  generated sibling hash proves retention in this test, not baseline discovery.
- Review/apply concurrency protection and durable application receipts.
- Real multi-integration application, compatibility, disabled-state preservation,
  operational files and iCloud/Obsidian quiescence with generated sync activity.
- Running footer/provider-usage inspection and every rendered iteration-18 state.
  No overlay placement was chosen and no UI pass is claimed.
- Multi-integration publication, updater deployment and owner-confirmed live Apply.

Only the reproduction and this record are deliverable; the product safety gate
remains blocked.
