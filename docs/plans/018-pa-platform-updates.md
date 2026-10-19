# 018 — Update PA, with local-customization choices

Status: planned; no application flow or new update prompt implemented.
Baseline: `ea258ea`; `pa-updates` **0.1.1** supplies the read-only Calendar pilot.
This iteration implements the platform-first outcome from the
[updates problem](../problems/updates.md), incorporating the owner's example
mapping after [017](017-pa-update-discovery.md).

## Outcome and scope

An owner sees **PA update available**, reviews what will change, and clicks
**Update PA**. PA installs the reviewed plugin versions and verifies the result.
Most users see no developer setup or customization controls. Only actual local
customizations introduce keep/replace choices.

**Update PA is an action, not a new platform version.** Show individual plugin
versions, not an invented “PA 1.5.0”. An internal immutable release record binds
the target versions/commits together. Update only already-installed integrations
from the trusted PA repository: Calendar, Fastmail, Drive, iCloud and Obsidian.
Do not install missing integrations, touch unrelated/builtin plugins, or update
BB/Pi. The updater's own replacement remains separate; bootstrap this iteration's
new `pa-updates` package through the normal delivery process.

This must deliver functioning installation, not another metadata-only release
or mock-up. Multi-plugin cases must use the actual managed installer in
disposable BB, not only mocked update calls.

## Agreed UI

The [standalone interactive mock-ups](018-pa-platform-updates-mockups.html) and
[focused image](018-pa-platform-updates-mockup.png) record the agreed design.
All target versions in them are illustrative, not release promises. Their icons
are line-art stand-ins; implementation uses each plugin's declared BB icon.

- Use the accepted labelled **PA update available** pill near the left footer
  through the supported app-overlay slot. No animation or native-control hiding.
  Retain the ordinary footer icon when no update is available.
- The normal review shows release notes and installed → target plugin versions,
  with one **Update PA** action. No plugin-selection checklist or development
  checkout is required for an ordinary managed installation.
- If plugins are customized, show all of them in one **Local changes** section.
  Each defaults to **Keep local**; its alternative names the exact target,
  e.g. **Use 0.1.2**. Only these rows need choices.
- **Keep all local** / **Use release for all** select choices; neither installs.
  The single update action confirms the visible keep/replace summary.
- **Also updating** lists other plugin icons and installed → target versions,
  without unnecessary controls. Clearly identify code that will be overwritten;
  credentials, settings and account data must stay in place.
- Completion shows verified plugin versions and any local versions retained.
  No platform-version label, duplicate “another update” banner, or next-update
  button. If another release is waiting, the usual footer pill returns after
  completion.

Follow the [UX skill](../../.agents/skills/bb-plugin-ux/SKILL.md),
[UX standards](../ux-standards.md) and
[observability standards](../o11y-standards.md). Mock-up rendering is not a
passing review of this UI in BB.

## Gate 0 — prove installation is possible before building Apply

Iteration 017 did not establish safe exact-target application. The inspected BB
contract accepts an empty plugin-update body, and its implementation resolves
the tracked source again during `applyUpdate`. A check followed by an unpinned
update is not a way to install the release already reviewed. `getSource` also
reports abbreviated revisions and history containing prepared candidates, not
just activations. Do not use that history to guess what is installed.

Before broad UI or publisher changes, run a bounded disposable-host proof:

1. Use the supported BB/SDK version and public lifecycle/installation surfaces
   to update an existing managed integration to an explicitly chosen commit,
   preserving registration, state, secrets, enablement and unrelated plugins.
2. Review target A, advance its remote tracking source to B, then apply. **A must
   be installed**, not B. Post-install detection that B slipped through is a
   failed gate, not a recovery strategy.
3. Identify and verify the active code and an expected installed-code baseline
   without assuming package version or a short SHA proves content equality.
4. Show a locally modified plugin can be kept byte-for-byte, or explicitly
   replaced without deleting its data. Include multiple plugins sharing a Git
   checkout/artifact cache: replacing one must not alter a kept sibling.
5. Capture the actual operation sequence, tested BB/SDK versions, and evidence
   in a portable verification record. Inspect the running footer and existing
   provider-usage disclosure before committing to overlay placement.

No direct BB database edits, private server-module imports, managed-cache resets,
remove/reinstall that loses data, BB fork, or ordinary `update latest` workaround.
Do not widen production permissions or upgrade BB silently to pass the proof.
If supported mechanisms cannot satisfy the requirements, stop and report the
specific missing contract for an owner decision. Do not spend the iteration on
more status UI and call it delivery. Re-evaluate the implementation route only
with an explicit decision; the user outcome above remains the target.

## Stories and examples

### 1. Update an ordinary PA installation

As an owner who has never customized a plugin, I can review and install the
available PA integration updates without learning Git or configuring a checkout.

- Compare only installed supported integrations with the tested release record.
  Omit unchanged plugins from the update list; do not downgrade newer versions.
- A repository-only change, missing developer mapping, or matching package
  version at another repository commit must not manufacture an update or local
  customization. Version/code evidence and provenance are separate concerns.
- Prepare a server-owned review identifying the exact target for every changed
  integration. Confirmation applies that set, not the newest feed contents.
- Recheck installed-code fingerprints and prerequisites before changing anything.
  Repeated clicks must not start competing updates.
- Install in a dependency-safe order, then verify running versions/identities,
  retained state and untouched integrations. Report actual outcomes; one button
  does not imply an atomic transaction or blanket rollback guarantee.

**Examples:** Calendar and Drive have newer tested versions → one review, one
Update PA, both verified. Fastmail is not installed → leave it absent. Calendar
has no runtime/version update but the repository advanced → no spurious offer.
A newer release appears after review → install the original reviewed targets,
then let the ordinary pill show what remains available.

### 2. Ask only about actual local customizations

As an owner who changed one or several installed plugins, I can keep or replace
each local version while still treating the operation as one PA update.

- Establish customization against a trustworthy installed artifact/source
  baseline. Do not treat a dirty but unrelated development repository as an
  installed customization, or bless today's bytes as the expected original.
  Account for source, effective runtime code and assets; distinguish normal
  BB-generated output and mutable operational data from hand edits.
- Standard managed installs need no development checkout or special opt-out.
  Keep an explicitly associated source checkout separate and untouched by
  deployment. An unavailable installed baseline is unknown, not automatically
  clean or customized; explain the real prerequisite without directing every
  user into development setup.
- **Keep local** leaves that installed code untouched and updates the compatible
  remainder. **Use [target version]** explicitly replaces that plugin's local
  code, preserving its configuration, credentials and account data. This is not
  permission to reset a source checkout or silently lose unrelated work.
- Include staged/uncommitted/unpublished work where the active custom install
  uses such source. The owner may choose replacement without first publishing
  it. Do not restore the superseded unconditional dirty-plugin block from 017.
- If code changes after review, ask again about that changed exception. A newer
  remote release alone does not invalidate the reviewed targets or choices.
- Check known integration requirements against the resulting mix of released
  and kept versions. If a retained version is incompatible, explain the
  dependency before starting; never silently replace it. Do not claim arbitrary
  custom code is certified just because its package version matches.

**Examples:** Calendar modified → keep or use its named target. Calendar,
Obsidian and Fastmail modified → one screen, three choices; keep Obsidian and
replace the other two, with Drive/iCloud listed under Also updating. All kept →
update only the remaining compatible components. No remaining changes → do not
run an empty installation or claim retained custom plugins match stock code.

### 3. Notice the update and understand completion

As an owner, I can see when there is something new, understand my choices and
see the outcome without repeated prompts or technical noise.

- Show the labelled pill only for a verified available update, not for a stale
  check, raw source mismatch or an unassessed development checkout.
- Use plugin icons and target versions in choices, ordinary updates and results.
  Keep commit details and technical evidence behind disclosures.
- A mixed completion says which local versions stayed local. Never label all
  components stock/current if some were deliberately retained.
- Basic failed/partial application gets a safe, honest result showing what did
  change. Do not claim automatic rollback or retry uncertain writes. Dedicated
  connection-drop/reconnect stories and recovery UX are outside this iteration.

## Publication and internal release model

Extend `core/release.ts`, the JSON schema, generator and gated workflow from the
Calendar-only v1 pilot to a bounded, allowlisted integration record. Use a new
schema version where needed; continue reading v1 safely as historical pilot
metadata, not an installable multi-plugin offer. No separate platform semver.
The new record must declare its integration coverage; a missing installed
supported component is incomplete metadata, not permission to fetch its latest
version independently or claim the whole supported set is current.

For each included integration, bind its own package version, exact repository
commit/subdirectory, engine requirements, notes and the integrity/baseline
information required by Gate 0. Declare known inter-plugin requirements where
keeping one version affects another; at least cover the iCloud/Obsidian note
interface. Do not invent a general dependency framework for unrelated plugins.

Changed shipped plugin code needs that plugin's own version increment; an
unrelated repository commit or test/docs-only edit does not require bumping every
plugin. Enforce this discipline rather than publishing different runtime code
under an unchanged version and relying on whole-repository mismatch warnings.

CI must build/test/typecheck every integration it advertises at the exact source
revision, including applicable shared, native and generated-source checks.
Provide Linux native prerequisites from the portable host requirements where
needed. A missing/skipped required gate must not yield “tested” metadata. Keep
lockfiles, trusted-main publication, fixed source/channel and append-only release
identities; no server/account credentials in the publishing job.

The review stores its validated release bytes/digest, exact target set and
keep/replace decisions independently of the feed's latest-record cache. A
newer valid record cannot retarget that review. Mutating the original reviewed
record or making its target unverifiable is an integrity error, not permission
to substitute latest. Preserve the existing bounded-network and safe-diagnostics
behaviour, and define cache/artifact retention and disk limits before introducing
executable staging. Staging is not activation; metadata history is not proof of
what is running. Use trusted fixed code paths, not remote executable commands.

## Application, state and background work

- Put review, customization assessment and application behind typed,
  need-shaped ports. Add client-authorized review/apply/status RPCs; an apply
  request refers to a server-owned review, not arbitrary paths, repositories,
  commands or caller-supplied unverified commits. No agent mutation tool is
  required. Opening a panel/checking releases never installs.
- Use a single joined application job with durable per-component receipts:
  reviewed target, kept/replaced decision, activation outcome and actual verified
  target. Preflight the complete chosen combination before the first activation.
  Prevent conflicting updates/edits from invalidating the assessment. Do not
  equate a timestamped observation with a reserved update window.
- Preserve settings, secrets, connections, enablement, schedules, source choices
  and operational files. Do not copy credentials into previews or receipts.
  Keep replacement of one plugin isolated from shared repository/artifact roots
  used by another; do not reset or clean a shared checkout.
- For affected iCloud/Obsidian updates, quiesce using supported controls before
  preparation: prevent new sync runs, drain active work, preserve local note
  operations and prior enablement, update in a compatible order, then restore
  only previously enabled work and observe completion. Test this with generated
  data. Never clear baselines, locks or failures just to deploy. If safe quiescence
  or a compatible retained/released combination is unavailable, explain that
  limitation before applying—not silently skip a component or stop the server.
- Do not update the running `pa-updates` package through its own executor in this
  slice. Native BB/Pi update controls, independent marketplace installation and
  unrelated plugins remain unchanged.

## Delivery sequence and acceptance

1. Pass Gate 0 and record the supported installation/baseline strategy.
2. Drive the normal and exception rules with failing core/adapter/Gherkin tests;
   implement review/execution and multi-plugin release publication.
3. Implement the approved pill/review/result using BB theme/icon components and
   supported app APIs. Adapt the panel/overlay to host constraints rather than
   fitting a long form into 017's small disclosure or covering other controls.
4. Run actual managed-install and rendered gates, then ship and get feedback.

| Given / when | Required result |
| --- | --- |
| Ordinary managed install, no checkout | Review and apply without development setup |
| Two integrations have newer tested versions | One Update PA applies and verifies both targets |
| Integration is absent, current or newer than target | No accidental install, churn update or downgrade |
| One or several actual customizations | Only those need choices; default Keep local |
| Bulk shortcut or mixed choices | No immediate install; exact overwrite/keep summary before confirmation |
| Owner explicitly chooses Use [version] | Replace only authorized local code; preserve state/source work |
| A version is kept local | Bytes retained; compatible remainder updates; result names the exception |
| New remote release appears during review/apply | Reviewed targets installed; normal pill returns later |
| Installed code changes after review | No stale overwrite authorization; refresh the affected choice |
| Kept version or background state is incompatible | Explain before activation; no silent substitution or data resets |
| Known baseline or exact target cannot be established | Honest prerequisite error; do not guess clean or install latest |

Automated gates: updater build/tests/typecheck/SDK-pin check, all advertised
integration gates, schema/generator/workflow checks and shared-source checks.
Test safe diagnostics with synthetic private sentinels in Git, installer,
release/storage and RPC failures; never forward arbitrary host exception text.
Bound logs by fixed stages such as review, baseline, prepare, activate, verify
and quiesce. Store only the metadata needed to explain outcomes.

Installed-BB gates must exercise original handlers through real managed updates
on isolated Linux BB, including at least two integrations, state/secrets
sentinels, unchanged absent/unrelated/kept plugins, exact A-despite-newer-B,
multiple local choices, runtime/source drift and generated sync activity. Verify
actual executable version/identity and receipts, not only returned API success.
Use disposable accounts/data; no provider writes or real notes are needed.

Rendered gates: available/quiet pill; ordinary review; one/multiple customizations;
all-keep/all-release/mixed selections; read-only Also updating; applying; simple
success with/without retained versions; incompatible/unknown/partial failure.
Check desktop/narrow widths, sidebar rail/list/collapsed arrangements, scrolling,
other overlays, keyboard/focus restoration and accessible status. Preserve native
BB/Pi controls. Record any unavailable state/gate, not a blanket visual pass.

Follow the [shipping skill](../../.agents/skills/bb-ship-feedback/SKILL.md) after
verification. Bootstrap only the new updater package through normal deployment;
verify its running source/version and a harmless read-only call. Publish a genuine
tested record. Do not downgrade production or create a cosmetic integration
version bump merely to light the pill. Actual installation must already have
passed in disposable BB; if no genuine newer integration release exists, record
production Apply as pending its first owner-confirmed use. Do not relabel a mock
or dry-run as live application. On that first real update, verify installed targets
and retained state without reading provider account content, then seek feedback.

## Explicitly out of scope

BB/Pi upgrades or prompt suppression; BB forks; PA platform-version numbering;
self-development/Git write permissions; updater self-replacement; automatic source
merging or checkout resets; a plugin-management dashboard; unattended application;
connection-drop/reconnect stories; universal compatibility certification or
cross-plugin atomic rollback. This iteration is planning only until implementation
begins; copying its mock-ups does not deploy the new UI.
