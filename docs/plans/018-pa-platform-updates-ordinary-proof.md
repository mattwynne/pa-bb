# 018 — Ordinary-update and baseline feasibility

Status: these bounded proofs passed on isolated Linux **BB 0.46.0 / SDK 0.6.37**,
Node **24.21.0**. They support the revised ordinary-update route, not a claim that
Update PA is implemented or ready to deploy. No production account, plugin,
permission, provider write or runtime installation changed.

## Why these tests exist

Iteration 017 tests read-only discovery. The historical exact-target harness
characterizes a requirement the owner has since waived. Neither establishes that
an ordinary update can replace customized code while leaving a kept sibling and
account state intact, or that normal installed artifacts can be compared against
an independent original without a development checkout.

Two current harnesses answer those questions. `test/gate-host.mjs` shares only
isolated startup/cleanup and public CLI/HTTP plumbing; it is not an application
framework. The proof does not justify a universal baseline builder, dependency
framework, rollback engine or new BB supervisor.

## Ordinary managed updates

[`run-ordinary-update-gate.mjs`](../../plugins/pa-updates/test/run-ordinary-update-gate.mjs)
creates four synthetic plugins in one Git repository, installed through BB's real
managed installer. It runs original BB update handlers, not mocked updates.

- Independent committed-source rebuilds reproduce the initial source, server
  bundle, app bundle, CSS, metadata and icon bytes.
- One runtime-only server edit changes the actual identity RPC while source stays
  unchanged. Comparing effective runtime bytes detects it. The test then restores
  its own edit and verifies the original runtime.
- Two plugins receive source, CSS, icon and rebuilt-runtime customizations.
  Updating an unrelated sibling does not manufacture customization on that sibling.
- After previewing A (**1.0.1**), the fixture publishes B (**1.0.2**). Ordinary
  compatible updates install B. **That is a passing result under the new policy.**
- Update the clean plugin, explicitly replace one customized plugin and update a
  disabled plugin. The kept customized sibling remains byte-for-byte and retains
  its executable identity in the shared checkout.
- Synthetic ordinary settings, secret settings and KV values survive. Only the
  original version seeds KV data: replacement code cannot hide loss by recreating it.
- The disabled plugin stays disabled through application. The test separately
  enables it to verify actual executable identity and state, then disables it again.
- Unrelated plugin versions, enablement and status remain unchanged.

Final generated evidence:

| Observation | Value |
| --- | --- |
| Original fixture commit | `221637dbd9306a6a0cedf4f4f1b3a0551fd39884` |
| Preview A | `c328a183abc339d6f3139197b9145c85eaa43f51` |
| Expected remote B (not independently measured runtime provenance) | `200996e1294064126b0f25d5ca39abe6cbb9e342` |
| Actual updated versions | 1.0.2 |
| Normal/authorized-custom/disabled updates | Passed |
| Kept sibling, state and unrelated plugins | Preserved |

The executable marker and installed package versions establish that B's fixture
code ran. The recorded remote HEAD is not itself an installed-commit measurement;
the harness now also records the commit returned by BB's update operation,
separately from that expectation. The fixture's direct calls stand in for already-made choices; this is not yet a
tested server-owned review or authorization implementation.

## Real integration artifact baselines

[`run-integration-baseline-gate.mjs`](../../plugins/pa-updates/test/run-integration-baseline-gate.mjs)
uses an archive produced with `git archive` and supplied with the source label
`0d5359f3691edac2820ade86a83482b65da464fe`, without modifying the integration
implementations. The harness proves reconstruction of the supplied snapshot; it
does not independently bind that label to Git history. It now records the archive's
SHA-256 separately so the actual input is identifiable.
It installs them unconfigured in disposable BB. In separate temporary directories,
it reconstructs their original source from the source archive, installs lockfile
dependencies and invokes the public `bb plugin build` command with the same BB
builder. It never uses today's installed bytes as the expected baseline.

| Integration | Version | Compared source/artifact files |
| --- | --- | ---: |
| Google Calendar | 0.1.1 | 38 |
| Fastmail | 0.1.6 | 30 |
| Google Drive | 0.1.1 | 27 |
| iCloud | 0.3.1 | 76 |
| Obsidian | 0.3.1 | 103 |

All compared bytes matched. Each actually served app bundle matched the independent
build, and each original read-only status handler succeeded without an account.
A synthetic server-bundle-only edit was detectable without changing source.
The comparison deliberately includes tracked docs/tests as extra evidence; it is
not the production definition of which files count as user customization.

This establishes a **same-builder reconstruction strategy for these packages**.
It does not establish a general baseline for arbitrary plugins, unavailable old
builders, path installs, native runtime caches or arbitrary custom code. The
application should report unknown prerequisites rather than expand this proof
into a universal reconstruction system.

## Reproduce

Use a disposable Linux environment with Node, Git, tar and an installed compatible
BB package. Network access is needed for pinned npm dependencies. Supply a trusted
archive produced from this repository, never an untrusted tarball.

```sh
node plugins/pa-updates/test/run-ordinary-update-gate.mjs "$BB_APP_PACKAGE_DIR"
REV=0d5359f3691edac2820ade86a83482b65da464fe
git archive "$REV" plugins/google-calendar plugins/fastmail \
  plugins/google-drive plugins/icloud plugins/obsidian > integration-source.tar
node plugins/pa-updates/test/run-integration-baseline-gate.mjs \
  "$BB_APP_PACKAGE_DIR" integration-source.tar "$REV"
```

Both scripts create fresh HOME/data/repository directories and loopback listeners;
they never connect to an existing BB instance. Successful runs exit zero and remove
their temporary state. A failure retains isolated evidence for diagnosis. Current
scripts bound command failures to a fixed message, handle setup failures inside
cleanup, and stop the disposable server on SIGINT/SIGTERM. These are test-harness
safeguards, not claims about application-job failure handling.

The helper sets `BB_APP_VERSION` to the supplied package's actual version, matching
BB's public launcher, and asserts the public `/system/version` response. Directly
launching the server entry without this value reports `0.0.0-dev`; that would skip
production-version compatibility checks. This was caught during reconstruction
because CLI-built and server-built metadata differed. See the qualification added
to the [historical proof](018-pa-platform-updates-gate-0.md).

## Still to implement or verify

- The actual bounded baseline adapter, server-owned review, keep/replace
  authorization and recheck, ordinary update job and actual-version receipts.
- Real integration application with generated iCloud/Obsidian activity and safe
  pause/drain/resume, not only unconfigured integration baseline reads.
- Supported BB/Pi/Codex channel updates, session handling and BB restart
  continuation under BB's existing launcher/lifecycle ownership.
- The running-BB pill/review/result UI. The refreshed HTML/PNG mock-ups use
  **Install released version**, currently-available previews and actual completion
  versions. Their bulk-choice and narrow-overflow checks passed in a browser, but
  they are not a live-BB UX gate; runtime/restart design is explicitly pending.

No exact-preview-target, fixed-tag-retargeting or upstream pinning-contract work
is needed. These proofs are a checkpoint toward a working Update PA, not another
metadata-only release presented as delivery.
