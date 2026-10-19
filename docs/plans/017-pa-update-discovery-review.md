# Iteration 017 verification

## Verified implementation

`pa-updates` 0.1.0 is independent of Calendar. It contributes one host-rendered
footer disclosure and two typed RPCs (`status`, `check`), with no agent tools,
installation API calls, approval placeholders or arbitrary path/command RPCs.
Calendar remains 0.1.1; its runtime source and behaviour were not changed.
Two timezone test fixtures use the historical 2025 Vancouver transition instead
of predicting a November 2026 fall-back.

The first extension gate inspected the running provider-usage footer on BB
0.45.0, then installed a disposable minimal footer contribution. Keyboard open
and close, public plugin inventory and `getSource` availability passed with SDK
0.6.15. No BB upgrade, fork, native-control hiding or DOM patch was required.

Source inspection uncovered an important limitation: BB's reported source
history contains validated candidates, not only activations. The adapter uses
the installed source's reported revision only, preserving its precision. A
matching 12-character revision cannot establish an exact source match; it stays
**Installed revision unavailable**. A differing reported prefix can establish
mismatch. Path/unrelated sources are not treated as trusted Git installations.
The synthetic exact-match state is not evidence of exact live revision access.

## Automated and disposable-host checks

- Checker: 20 core/adapter/schema/generator/workflow/registration tests and four
  Cucumber scenarios (23 steps).
- Calendar regression: 76 tests and 39 scenarios (266 steps), build and
  typecheck, including BB's SDK-pin check.
- Checker build/typecheck/SDK-pin check, shared generated-UI drift check and
  actionlint 1.7.7 workflow validation.
- Actual Git fixtures: relevant staged/unstaged/deleted/untracked/shared work,
  ignored output, unrelated Obsidian work, unpublished commits, missing objects,
  divergent history, unsupported config, cancellation, output bounds and a
  deterministic concurrent edit. A TERM-resistant generated Git child is killed
  and joined on cancellation before inspection returns. File/index comparisons confirm the inspector
  does not change checkout bytes. Unknown cases never become clean.
- Disposable BB 0.45.0: real original checker backend with injected synthetic
  feed/clock, typed client RPC, generated dirty/divergent checkout cases,
  joined requests, reload cooldown, disable, preserved older Calendar and safe
  diagnostic containing only the failing boundary/category.
- Rendered BB: 42 captures at 1280 and 390 pixels, covering first/checking,
  current/available, absent, unknown/dirty/divergent local work, stale/invalid
  feed, unavailable revision/inventory, incompatible requirements, no release,
  source mismatch, newer installation, RPC/storage failure and recovery.
  Keyboard open/Escape, focus restoration, visible focus, inert notes, expandable
  source details, no horizontal overflow, and persistent visible retry control
  passed. Visual comparison used the running provider-usage disclosure.

The rendered run installs a **generated older Calendar 0.1.0** in a fresh BB
data root with no accounts, and labels its release data **synthetic**. It does
not downgrade production or demonstrate a real newer Calendar release. The
first visual pass found the host's constrained disclosure could clip a long
panel; the final layout bounds its height, scrolls content, keeps retry visible
and puts long notes/source details behind disclosures.

The fixture host proves safe failure handling without exposing real account
content. Production failure modes and owner feedback are recorded separately
below. Runtime dependency audit has no production advisories; the pinned BB
0.45.0 development toolchain carries upstream development-only advisories. It
was not silently upgraded to bypass the supported-version gate.

## Publication and installed delivery

The first trusted-main run ([39329387507](https://github.com/mattwynne/pa-bb/actions/runs/39329387507))
correctly blocked publication on two existing Calendar timezone assertions.
Reproduced with Node 24.21.0 / ICU 78.3 / tzdata 2026c: Vancouver has no November
2026 fall-back in that data, unlike the local Node 24.14.1 / tzdata 2025c.
Fixtures now test the historical November 2025 transition on both runtimes;
no Calendar production code or version change was needed. Publication and
independent plugin installation are pending a passing rerun.
The release workflow grants write authority only after lockfile-based checks
and generation at the exact event revision. Its append-only preflight refuses
existing release tags. Metadata uses HTTPS and repository write controls, not
independent signatures; no executable artifact or automatic upgrade is offered.

Local mapping is optional protected operator configuration. An unmapped live
installation must say **Local work not assessed**, not infer cleanliness from a
managed installed package. Missing target objects stay unknown; this slice does
not fetch or maintain a repository cache. No current result reserves an update
window or proves installed-code drift protection.
