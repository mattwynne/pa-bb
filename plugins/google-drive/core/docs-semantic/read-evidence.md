# Internal S02 read-evidence comparisons

These modules are **not tools, planners, compilers, consent checks or executors**.
They perform bounded comparisons of source observations and proposed disclosure.
Every evaluated result keeps `editReady:false` and
`authoringAuthority:"notEstablished"`. No result proves a provider write,
acknowledgement, draft, claim, approval, rendered result or account rollout.
Serving schemas and registrations are unchanged.

## Entry points and trust boundaries

- `resolveTargetEvidence(snapshot, {scope, selector})` rematerializes the original
  bounded GET evidence using the existing model builder and compares every
  derived inventory before using graph edges. It uses the existing resolver,
  enumerates literal matches independently of selected occurrence, and returns
  exact preimages, bounded context, run membership and inverse UTF-16 maps.
  Selection failure/incomplete enumeration is explicit; resource overruns throw
  a fixed `budget` error, never a truncated successful target.
- `inspectEffectEvidence(snapshot, {scope, selector, effect})` returns observed
  target, dependency, boundary and change facts for the vocabulary below. It
  describes a comparison contract, not a compiled request program. A future
  planner must produce the effect and its presentation.
- `compareReadEvidence(snapshot, request, trustedDeliveries)` compares the
  actual presentation with those independently derived facts. Presentation is
  exactly `{target, dependencies, changes, effect}`. Arrays are ordered; object
  key order is immaterial. Broad original evidence is supplied separately as
  `originalRecords` or through real delivered content.
- `createReadEvidenceService({snapshots, clock, ids, diagnose})` is the internal
  application facade. Its `owner` is the verified account/subject/thread result
  of the calling application, never a native argument. `evaluate(owner, args)`
  accepts **tokens**, not delivery arrays, approval input or client proof flags.
  It resolves real sealed SQLite records, verifies snapshot/owner/view/digest,
  coherent read ID, offsets, frozen selection and actual node/aspect membership.
  Diagnostic identities do not deliver content. Partial pages may accumulate
  within one immutable read; a section never delivers its parent or sibling.
- Existing `footprint` constructs a bounded proposal only. Legacy
  `evaluateWitness`/`previewWitness` consume **trusted internal** delivery records
  and validate canonical model facts at witness entry. The `effectWitness`
  option delegates to the typed comparison, checking the exact footprint. An
  old `narrowWitness` alone still cannot certify cardinality/effects, and the
  old named-type summary is explicitly diagnostic, not an indirect-style proof.

## Evaluated effect shapes

| Kind | Exact supported disclosure | Explicit limitations |
| --- | --- | --- |
| `style` | `family: text|paragraph`, nonempty `set`; existing effective before property, proposed value, all targeted nodes and paragraph/newline/list/review/registry dependencies | Text: bold, italic, underline, strikethrough, smallCaps. Paragraph: alignment, keepWithNext, keepLinesTogether. Unknown before values, resets, links, borders and bullet effects are not proven. Text selectors cannot silently expand to paragraph styling. |
| `replaceLiteral` | `replacement`, `stylePolicy: preservePositions`; recomputed exact count, every selected preimage/context/source map, exact equal-width inline changes, complete paragraph/run/style/review dependencies | Equal UTF-16 width only; no newline joins, unequal-width replacement, overlapping matches or list effects. Preserved style positions are a read/effect contract, not proof that a compiler implements that policy. |
| `insertText` | `at: start|end` of one inspected text-only paragraph, nonempty single-line `text`; inherited source identity, newline and exact affected extents | Same-tab/segment affected suffix, including unresolved envelopes and necessary ancestors. Missing downstream bounds remain missing evidence; no opaque/table/list/anchor transforms. No newlines, arbitrary coordinates or generated IDs. |
| `destructiveScope` | `action: delete|replace`; replacement is bounded `{kind: paragraph, text}` blocks; exact removal/style/link/list/object/review disclosure, actual full originals, adjacent boundary evidence | Roots must be whole segment-level paragraphs or tables; text/row/cell and nested-block roots require unsupported parent join/topology contracts. Descendants remain fully witnessed. Unresolved/opaque shifted suffixes, dependent boundary-child review and unsupported object/positioned-object/anchor/review effects refuse. Disjoint rich content is not a document-wide veto. |

Full originals are actual provider objects for **every** affected physical node,
not digests, strings, a parent summary or a `complete` flag. Known hyperlink loss
must appear in both source originals and removal effects. Unknown dependent
fields and unsupported losses cannot be waived by a presentation. Global
missing-review diagnostics are separate from scoped missing aspects; independent
boolean style evidence need not deliver unrelated prose. Content/index evidence
still needs this subject's current inline editor revision, not a preview/history
revision or a borrowed subject. This is a necessary evidence condition, not Apply.

Requests, targets, presentations and individual retained witnesses are bounded
by 64 KiB; target/dependency sets by 500 nodes; literal text by 2,000 UTF-16 units;
style patches by 16 properties. Existing model/search/store bounds also apply.
Oversized valid material is a visible engineering limit, not provider prohibition.

## Retained evidence

`retain(owner, {request, expires})` first compares ordinary live evidence, then
atomically saves the exact result/references in an existing delivery record and
acquires a new B pin. No migration is added. The handle includes actual pin ID,
owner-bound snapshot/evidence/revision binding, immutable deadline, witness
record token/digest and exact references. It is `retainedEvidenceOnly`.

`consume(owner, handle)` validates that same pin, sealed snapshot, witness and
referenced deliveries, including after SQLite reopen and ordinary cursor/snapshot
expiry. It returns **only previously covered facts**. It performs no selection,
new read, effect construction, planning, TTL extension or provider call. Pins
retain B's immutable maximum 30-minute deadline. Expired/released/corrupt pins and
unsealed historical data fail closed. Seals are trusted-storage integrity checks,
not protection against an actor able to rewrite both rows and all their seals.
No actual draft/reservation is claimed. Legacy write claims and migrations 0–9
are unchanged.

## Generated observations

`compareGeneratedEvidence(before, after, request)` compares independent complete
GET models with exact predecessor and observed revision bindings. It supports
one inserted paragraph/table/inline object at a unique scoped anchor, or an
observed returned heading/inline-object ID. A native table has **no fabricated
stable ID**. The expected actual provider fragment must match exactly. All other
physical nodes require explicit preservation pairs/extents, and the complete
remaining provider graph must match, excluding only canonical structural
coordinates and the root revision. Unknown coordinate-like fields stay substantive.
Drive metadata version/time may advance and are reported separately, never as
Docs CAS; every other metadata field is preserved exactly.

Missing/ambiguous IDs, wrong scope/type/shape/revision, changed predecessor or
preserved content refuse. No client `verifiedStage` flag is accepted. A positive
comparison needs no additional agent-delivered read of the generated structure;
it is still only `generatedReadComparison` with
`protocolProvenance:"notEstablished"`. The future executor must supply genuine
acknowledgement, stage persistence, claim, approval and authority provenance.

## Named-style properties

`inspectNamedStyleEvidence(snapshot, request, {offset, limit})` and
`compareNamedStyleEvidence(snapshot, request, pages)` reuse A's atomic property
classification, effective provenance and registry references. The witness names
the exact old definition/property/new value, all scoped usages, direct and named
overrides, actual NORMAL_TEXT dependencies and before/after affected values.
Actual inheritance-selecting paragraphs and relevant ancestors carry owner IDs/digests,
review, unknown fields and registry relationships. Unknown named/editor/table parents
or typed values remain missing evidence; unrelated paragraph/tab dependencies are
not substituted for the usage's owners.
Non-inheriting properties are not falsely advertised as indirect updates.

Pages bind one digest over the entire immutable usage enumeration. Missing,
reordered, changed or truncated usages do not satisfy it, irrespective of any
`complete` flag. No unrelated text delivery is required. These are property-level
read comparisons, not a second inheritance engine or named-style writer.

All eight C021 pairs are supplemental real-interface tests. They grant no audited
Cxxx outcomes: D/E's production inventory/intake/schema joins and exact outcome
executions remain separate work, with all S02 obligations still planned.
