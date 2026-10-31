# Plain text in a merged spreadsheet cell

Discover `sheetsMergeCapabilities` before relying on this surface. Contract
`sheets-merged-anchor-text-v1` permits a narrow value edit, not merging,
unmerging, formatting, comments or arbitrary Sheets batch requests. A note
written as displayed cell text is different from Google's cell `note` metadata;
cell notes remain untouched.

## Supported targets

- An ordinary literal or explicit-formula rectangle may be edited when validated
  merges elsewhere on the selected tab do not intersect it. Existing formula
  opt-in, typed-value and approval rules remain unchanged.
- A target intersecting a merge must be **one cell at the exact top-left anchor**.
  Inspect and edit in default `mode:"literal"`, supplying a one-by-one matrix of
  a plain string or `null`/empty text to clear it. For example, to correct text
  displayed across `A26:O26`, target only `A26`; do not request `A26:O26` as the
  value-write rectangle.
- The complete merge must fit within **100 inspected cells, 20 columns and
  100 rows**, and the existing bounded output size. At most 256 validated merges
  may exist on the selected tab. Unrelated merges may be larger than the target
  inspection limit, but must have finite in-grid coordinates and not overlap.
- Formulas mode, numeric/typed values, `formatTypedValues`, covered cells,
  mixed/multi-cell merged targets and malformed/overlapping merge metadata are
  refused. This change does not relax protection or table checks: either
  structure anywhere on the selected tab remains unsupported.

## Inspection, consent and preservation

Inspection reads the **complete bounded merge footprint**. The returned
`range` and `rows` still identify only the requested one-cell write. Additional
`mergedRange`, `mergedRows` and canonical `mergeLayout` describe inspected
context, not permission to write those other cells. Covered cells must have no
entered values or computed-only output. Unsupported rich text, chips,
validation or pivot/data-source structures fail closed. Entered formatting and
cell-note metadata across the footprint are retained in the comparison.

The normal inspect → same-key preview → mandatory exact owner review → apply
protocol is unchanged. The native card names both the full displayed merge and
its one-cell write anchor, shows exact before/after text, and warns that Google
Sheets offers no revision/CAS guard. A fingerprint binds merge geometry and the
retained footprint; inspection is not permission to bypass review.

The adapter sends only the anchor's `userEnteredValue` using the existing
constructed `updateCells` request. There is no unmerge/remerge, range expansion,
formula replacement, style rewrite or neighboring-value update. After an
acknowledged response, bounded readback compares the expected anchor text,
merge geometry and retained footprint. This is API evidence, not rendered-layout
verification or an audit of every other cell. Dependent formulas elsewhere may
recalculate. An external collaborator can still race after the last comparison.

Changed merge geometry, anchor text or retained metadata during review stops
submission. Lost or malformed replies remain uncertain/locked even if current
text matches; use `gsheets_edit_status` with the original account/key. Never
replay, replace the key, unmerge, force-unlock or recreate the spreadsheet to
compensate. Historical ordinary/formula receipts are not rewritten.

Refusals distinguish protected/table tabs, unsupported merge metadata,
non-anchor/mixed targets, merged non-text mode and oversized footprints. A
blanket unsupported-structure error does **not** establish that the requested
cell itself is merged. Report the actual bounded diagnosis rather than guessing.
No real provider write is authorized merely to test this feature.
