# Unregistered first literal replacement profile

This is a closed engineering extension of the same native execution path, not a
new public tool, serving registration, S03/S04 completion or live/rendered proof.
`docs_plan_replace_internal` accepts a previously inspected paragraph node ID and
literal old/new text. Apply/status still accept only account, operation ID and
immutable head. The serving server and app entrypoints do not register this path.

## Supported intent and actual evidence

`paragraphReplace` (original `/1`, narrowly extended `/2` below) selects exactly one nonempty literal in
THAT paragraph. Other occurrences in preceding/following paragraphs or other tabs
do not contribute to cardinality. No normalization, regex, occurrence fallback or
replaceAllText exists. Strings are scalar-valid, at most2000 UTF-16 units; no-op,
newline/control/private-use insertion and empty old text refuse. Empty new text
is deletion. Command literals reject ALL Unicode General_Category=Cc controls
(including C1 U+0080–U+009F), U+2028/U+2029 and General_Category=Co private use;
scalar validation separately rejects ill-formed surrogates. Printable NBSP U+00A0
and well-formed astrals remain allowed. The known plain body also rejects Cc and
U+2028/U+2029 except its required FINAL LF; opaque unrelated metadata is not scanned.
A scalar-safe common prefix/suffix is retained; the changed span may be deletion-only,
insertion-only or replacement. The terminating newline remains.

The actual read-side replacement evidence resolves the command node in the S02
model, checks the complete plain body, actual mapped runs, local unique preimage,
full paragraph before/after, complete active style sources and downstream index
changes. It is NOT the old equal-width preservePositions witness renamed true.
Publication and recovery use a closed replacement-plan codec and actual retained
source binding. Original paragraph-bold/1 input, plan and payload hashes remain.

Selected body admission is bounded to100 content records and100 pure text runs
per paragraph, with an optional original leading section break. Other simple
paragraphs before/after are supported; no document-wide single-paragraph rule.
Lists, rich inlines, unknown affected body/paragraph fields and known review/range/
object registries refuse. Opaque unrelated document metadata, unused named-style
properties and other unchanged tabs are retained, not recursively interpreted as
indices merely because a property is named startIndex/endIndex.

The original `/1` selected paragraph must have homogeneous COMPLETE OBSERVED supported text
style: bold, italic, underline, strikethrough, fontSize(PT), weightedFontFamily
(with observed weight), foregroundColor(with all RGB components). Values may be
explicit or read from its actual named-style definition; no defaults are invented.
Unsupported ACTIVE baselineOffset/smallCaps/background/link or missing effective
properties refuse. At a paragraph-start insertion the actual preceding inheritance
boundary must also have no unsupported active properties. Unused definitions and
non-boundary neighbor styles are opaque preserved facts, not a global style ban.
Every inserted changed interval explicitly restores ALL seven properties, even
when the neighboring paragraph has a different font/colour/bold. No wildcard
style clearing, paragraph-style mutation or rendered-font equivalence is claimed.

## Closed /2 documented font-weight default only

New planning selects `paragraph-replace/2` ONLY when the actual selected style
needs documented font-weight400 derivation. All-observed inputs keep EXACT `/1`
plans/heads/payloads; old saved `/1` normalization and NoDSP never upgrade.
`/2` has witness version2, stage `text-2`, execution `nativeParagraphReplace-v2`,
and the closed `docs-weight-400/1` provenance/normalization contract. No caller
profile flag exists. This is not an extension of S02's observed model.

The pinned Docs discovery WeightedFontFamily.weight and the official TextStyle /
[WeightedFontFamily reference](https://developers.google.com/docs/api/reference/rest/v1/documents#WeightedFontFamily)
explicitly default an OMITTED weight to400. Only an EXISTING font object with a
valid nonblank fontFamily qualifies. Present weight must be an integer multiple
of100 in100..900; null/false/0/NaN/invalid presence is NOT omission. A whole font
property is selected atomically: explicit `{fontFamily:'Inter'}` overrides named
`{fontFamily:'Arial',weight:700}` as Inter/default400, never Inter/borrowed700.
Absent whole font uses a known active parent property, never invented Arial or a
font object. Default-derived admission requires the actual Reader to have source
property evidence for all seven fields and an actual named-style reference where
inheritance is needed. Raw explicit/named objects, missing keys and S02 partial /
missing propertyEvidence remain unchanged. The replacement witness and actual
native card label400 as DOCUMENTED DEFAULT, NOT OBSERVED, with source/reference.
Weight400 is not a rendered-weight/font-fidelity claim; bold remains independent.

The /2 compiler restores effective400 inside the inserted interval ONLY. The
independent verifier rederives400 from retained raw before/after. Its extra
normalization permits omitted-weight/explicit400 equivalence ONLY in recognized
body TextStyle.weightedFontFamily objects and the actual active named-style
TextStyle owner; it never adds a whole font property or recursively walks opaque
objects named weight/weightedFontFamily. Whole-property inheritance and all other
values remain exact. Full actual raw after and its omission facts are retained.
Malformed raw scalars are rejected BEFORE coalescing. Old /1 still mismatches an
after weight omission: no implicit contract backfill.

RGB remains COMPLETE OBSERVED: black{}, missing zero channels, whole colour /
colour children / nulls still refuse. No RGB-zero codec is established here.
Active baselineOffset/smallCaps/background/link and other unsupported styles
still refuse. This is not support for every ordinary Google Doc.

## One protected execution, independent verification

The SAME controller, opaque fresh-winner store capability, observed authority,
consent clock, synchronous intent/gate/once-fetch, ACK journal, budget accounting
and no-replay recovery are reused. Header kind/capability and text-1 stage are
closed (with the versioned text-2 extension above); immutable programShape holds independently derived delete/insert units.
Reply arity is one delete plus insert/style pairs when present, NOT compiler
request length as authority. Expected counts are1/2/3 for the supported shapes.
No SQL migration changes; old v1 NoDSP and v2 bold records are not reinterpreted.

The new compiler derives tab-qualified deleteContentRange/insertText and a narrow
explicit style patch under requiredRevisionId/EDIT. The NEW verifier independently
resolves the actual command/node/literal from retained RAW before, derives scalar
minimal difference and inserted style, and checks actual full after. It does not
import planner/compiler output or a simulated expected document. It normalizes
only adjacent pure text runs with identical COMPLETE stored style, and only
recognized body paragraph/run coordinates. Every unrelated raw value, including
opaque numeric startIndex/endIndex sentinels, stays compared unchanged. Equivalent
content at r3 cannot verify own ACK r2. Mismatches retain ACK/full-after/claims.

## Actual native review and held delivery gates

`docs-replacement-approval.tsx` shows old/new, full paragraph before/after, unique
match, literal AND actual changed/inserted ranges, style/provenance, index shift,
account/title/revision/head and seal/effective card expiry. It is bound by the
isolated `docs-replacement-review-app.tsx` public-SDK composition; serving app.tsx
is unchanged. The final bounded payload is hashed after the single effective
consent deadline is calculated. Existing live Docs opt-out is distinct standing
consent, never an invented owner choice. No truncation or hidden-format payload.

Actual SDK/file-SQLite/raw-HTTP and isolated renderer-source/SSR cases are not
rendered desktop/narrow/keyboard/deferred interaction or live-provider fidelity.
Those gates and deliberate enabling remain held. Unknown results cannot replay,
rekey, infer ACK from observation or release claims. Accepted coverage delta0.
