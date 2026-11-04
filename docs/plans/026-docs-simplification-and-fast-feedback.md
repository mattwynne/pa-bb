# 026 — Simplify Docs, make feedback fast, then deliver create/edit

Status: simplification and bounded create/edit increment applied locally after owner authorization. Synthetic handler/rendered checks and runtime registration checks passed; real Google document operations remain unverified.

## Initial cleanup and literal-edit result

The retired acceptance/evidence engine is removed, with 235 paths and approximately 160,500 lines removed in the cleanup checkpoint. The affected create/edit loop now runs 58 real behavior/negative cases in roughly 320–450 ms including npm startup. The complete maintained pure suite remains separate: 1,007 cases in 17.35 seconds, not milliseconds. Focused actual-handler/storage regression passed 282 cases in 75.69 seconds.

Existing native plain-text creation is reused. Existing inspect/replace handlers add one bounded body-paragraph literal edit beside unrelated tables/logos, with style and structural preservation checks, existing approval, revision control and uncertain-write holds. Arbitrary rich editing, table authoring, section reconstruction and live Google correctness are not claimed. The unchanged replacement approval was reviewed in disposable BB at desktop/narrow widths with keyboard, cancellation and error states. The exact committed source was then verified independently of unfinished work: 58 fast tests, 728 integration/regression cases, 12 OAuth scenarios, build/types and shared UI checks passed. The existing local plugin was updated through its native lifecycle with a state backup; plugin identity, source, enablement and configuration fingerprint were preserved. Applied build files matched the clean verified build, new tool descriptions were registered, and a synthetic unknown-account inspection stopped before provider access. No real Google document was created, read or edited for activation testing.

## Applied bounded increment: heading prose

Applied locally after independent review: `gdocs_replace_section` selects one exact
unique native heading in an explicit tab and replaces its nonempty uniform
ordinary prose. The heading and last body newline remain. LF-separated new
paragraphs can change the paragraph count; nested headings, mixed styles, lists,
links, objects, tables and custom paragraph styles in the section refuse before
submission. Paragraph style is inherited or `NORMAL_TEXT`, permitting only
absent/explicit LEFT_TO_RIGHT direction (documented non-inherited LTR default)
as an additional property. Old/new prose is at most 2000 UTF-16 units.
Supported structure outside the section is preserved and independently compared.

Selection, compilation and independent verification are pure core functions.
The operation shares the existing inspection/revision, approval-policy,
required-revision batch and legacy writer exclusion flow. No new executor,
journal, draft system or public raw-index input was added. Historical receipt
interpretation stays text-only; new immediate section readback does not upgrade
old receipts. Unknown responses remain held, even if later content matches.

Independent review identified two bounded applicability corrections: explicit/
default LTR, and direct text values set to inherit when equal to a proven parent.
Both are now handled only on affected content. Unchanged, unambiguous same-tab
NORMAL_TEXT/named-style observations must prove a supported parent value;
unknown editor defaults remain unknown. The new inheritance equivalence is
confined to newly inserted literal text, or the styled section body including
its last newline. Untouched text and parent definitions remain exact under the
existing preservation contract. No general style-resolution engine was added.

The affected loop now runs 112 cases in measured 310/320/340 ms end-to-end with
npm startup. The separate full pure suite passes 1061 cases in 16.84 seconds.
Focused production-handler/SDK/file-SQLite/HTTP, creation/literal, approval,
writer/recovery, transport, formatting and registration regression passes 185
cases in 17.04 seconds. Build, types and shared connection UI checks pass. Disposable BB
rendered section approval at desktop/narrow widths, keyboard approval, busy,
error, cancellation and incomplete states; no Google port was present.
Independent correction review passed, including 16 separate pure probes and
three production-handler probes. Parent checks passed 112 fast cases in 350 ms
and 36 actual section/literal handler cases. The reviewed source was applied
through the existing local plugin's native lifecycle with a state backup;
plugin identity, source, enablement and configuration fingerprint were retained.
All five build artifacts matched the reviewed build and the section tool was
registered in the running plugin. A synthetic unknown-account inspection stopped
before provider access. Real Google document semantics/rendering remain
unverified; no real document test operation or publication was performed.
Exact supported scope: [editing guide](../../plugins/google-drive/docs/editing.md#replace-prose-under-a-heading).

## Decision

Sharpen the axe first. Reduce code and test complexity, establish a millisecond-scale development loop, then deliver useful Google Docs creation and editing. Apply the 80/20 rule to sequencing, not to authorization, preservation or truthful outcomes.

This plan supersedes plan 025's acceptance-count-driven implementation order and broad exposure prerequisites for the next bounded capabilities. The eventual capability catalogue remains a scope reference, not a requirement to complete an execution platform before delivering one operation. Historical reports remain historical; no missing outcomes become passes.

ADR 0003 remains the architecture: real domain/application behavior in the core, thin adapters at actual external boundaries. This is the authorized test migration under its adoption clause, not a new test framework.

## Order of work

### 1. Preserve work and remove unnecessary machinery

Preserve existing commits, unrelated changes and the unfinished table candidate before modifying overlapping files. Keep unfinished work recoverable without pretending it passed review. Do not reset, stash, clean, overwrite unrelated changes or alter historical storage migrations.

Classify code by the retained behavior it supports. Delete obsolete acceptance producers, duplicate integrations, redundant fixture corpora and coherent-forgery proof machinery after replacing their useful assertions at the appropriate boundary. Do not merely move all the old machinery to a nightly command. Keep original evidence outside the active test path and use Git history for retired tracked code.

Challenge generalized drafts, multi-stage execution, composition and persistent proof infrastructure against actual retained capabilities. Simplify or remove abstractions that have no present use; do not change existing receipt interpretation or release uncertain writes just to shrink code. Table authoring is deferred. Do not introduce another compatibility framework or coverage ledger to supervise the cleanup.

### 2. Test behavior without booting systems

Start with compiler/verifier and policy tests that currently construct complete SDK/SQLite worlds. Use small independently authored document inputs and expected requests/results. Exercise the real core, with simple substitutes only at external ports. Keep Unicode, ambiguity, style, preservation, ownership and failure examples where they belong.

Separate these boundaries:

- Core/application behavior: in memory, no database, filesystem, SDK host, network, sleep or process launch during cases.
- Adapter translation: real adapter with substituted HTTP/CLI transport.
- Storage/BB integration: small representative cases for actual SQL, schema, authorization, approval and wiring guarantees.

A retained crash/restart test must justify a retained persistence promise; it is not mandatory merely because an earlier plan specified a crash matrix. No simulated core test is labeled physical durability proof. Do not mock the SDK host database or substitute the compiler/verifier's own answers for independent expectations.

### 3. Make the editing loop fast and explicit

The current package default builds multiple plugins, runs acceptance and then all Node tests. Replace that as the normal development entry point with a documented fast command and separate explicit integration/build checks.

Target the complete affected-behavior command at **500 ms or less end-to-end** on the development host. Count startup, discovery, fixture setup and assertions. Report cold and repeated timings and all selected cases; do not quote a tiny function benchmark as suite time. Measure the complete pure-core suite separately and reduce avoidable process/import/setup overhead. Timing targets are goals until measured, not promises already achieved.

Fast-path boundaries must be enforced. Do not meet the target by selecting only happy paths, dropping relevant assertions, skipping failures, increasing timeouts or relocating all important behavior to a slow bucket. Use existing tooling and a small script if needed; no benchmark service, dependency migration or new runner framework.

### 4. Prove the migration once, delete the old path

For replacements, retain the independently expected behavior and relevant previously caught faults. Use a compact explanation of what moved, what was removed and why. No one-to-one recreation of 11,197 generated outcomes is required. Run affected checks during editing, one focused independent review, and a consolidated regression at the stable boundary. Do not re-run an obsolete 37-minute certification pipeline solely to authorize retiring that pipeline.

Done for simplification means materially less active code/fixture machinery, fast repeatable feedback, no hidden failed tests, clear remaining integration purposes, and preserved retained behavior. If a timing budget is missed, report the actual measurement and cause; do not silently redefine the target.

### 5. Deliver a small create/edit workflow

Only after the fast loop is established:

- Reuse existing native document creation where it already meets the need; do not rebuild a working create service to fit a new abstraction. Demonstrate bounded title/body creation with truthful partial or uncertain results.
- Implement or simplify one useful literal edit in a representative document with a logo/table elsewhere: read revision and exact target, show the change, obtain the existing required approval, issue one revision-guarded batch, and independently verify changed and preserved content.
- Reject ambiguous or unsupported affected structures before dispatch. An uncertain response remains uncertain; never automatically retry. Preserve account/grant checks, existing writer exclusion and historical receipts without building a generic workflow platform.
- Test the representative rich-document shape first, not after completing an artificial plain-document demo. Do not invent omitted style defaults from one sample response.
- Use actual production handlers and independent provider fixtures in integration tests. Add no raw provider-request tool or bypass of consent.

Review the actual rendered BB workflow using a supported disposable, synthetic-only environment when live installation changes are not authorized. Build/SSR is not rendered verification. Preserve the existing plugin ID, data and configuration for any later authorized activation. Do not silently merge unfinished work or switch the live source to review UI.

## Working cadence

One implementation owner at a time. Read-only review can overlap; there is no parallel source-writing fan-out. The first checkpoint is after a bounded work session: deletions, actual command timings, retained behavior and blocker. Continue authorized work instead of stopping at an arbitrary clock checkpoint; reassess scope if the work is expanding rather than simplifying.

Reviewer setup fixes may use new, recorded versions while preserving business expectations; ordinary technical corrections do not need repeated coordinator round trips. A genuine unresolved safety defect blocks exposure. Do not allow review to expand into malicious-producer attestation or a new generalized evidence system.

Report in plain language: what was removed, test timings, what creation/editing can actually do, what was rendered, what is running, and what remains blocked. Source, tests, rendered preview and live delivery are separate facts.

## Boundaries

Development and synthetic tests/preview are authorized. No production source/database/cache edits, installation switch, reload, publishing, connected-account test reads/writes, sharing/grant changes or real scratch-document operations are implied. Existing deployment/provider holds remain until explicitly lifted. Local reviewed commits may preserve coherent work; do not publish unrelated history. No promise of overnight completeness overrides these boundaries.
