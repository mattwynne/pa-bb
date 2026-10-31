# Google Docs semantic capability ledger

## How to use this ledger

This is the explicit union of implemented user-facing behavior in the four requested references, useful additions in the ecosystem research, current provider capabilities, and existing plugin guarantees. It is a scope and executable-specification contract, **not** a claim that these features are implemented or tested here. It accompanies [semantic API plan](semantic-api-plan.md), [semantic contracts](semantic-contracts.md) (normative K1–K11 and findings crosswalk) and [coverage manifest](../../../plugins/google-drive/features/docs/coverage/obligations.json) (machine-readable variant/outcome joins). All 211 row IDs remain; mixed dispositions are split at semantic-variant level in the manifest. No planning entry is a test pass.


### Dispositions

* **N** — new original implementation required, including expansion of current local limits; difficult work is not silently deferred.
* **R** — reuse an existing plugin capability and prove routing/policy preservation; missing adjacent behavior is separately N.
* **B** — no supported native operation in the inspected API contract, or a genuine provider constraint. Test a precise refusal and any explicitly different alternative; do not count the alternative as native parity.
* **X** — excluded transport/runtime/unsafe convenience, with rationale. Its underlying user intent is covered elsewhere when possible.
* **P** — preservation/recovery obligation across the rewrite, including historical evidence limitations.

Rows remain human-readable summaries; each manifest group has exactly one disposition. [coverage manifest](../../../plugins/google-drive/features/docs/coverage/obligations.json) expands ledgerId/productOperation/semanticVariant/outcomeVariant with explicit applicability profiles and planned/enabled state. Concrete `caseId` is ledgerId.semanticVariant.outcomeVariant within its Feature/Scenario; repeated outline tags are valid, duplicate case IDs are not. Exposure is per product operation/resolved variant/mode and requires every applicable outcome sibling plus all explicit validation/invariant dependencies, not one passing success case. Independent per-outcome evidence cannot authorize exposure. Modes resolve separately from outcome profiles; fixed-mode guard controls cannot claim another mode. Each case joins actual driver/requestedMode, schema discriminator, writable request/field paths and independent fixture, not just a row tag. `preservation` is the sole spelling. Native CAS uses staleRevision; no-CAS routes use comparisonStale. External UI/deployment/review gates are separately recorded. All semantic entries here remain planned until actual evidence is supplied; S01 negative audit fixtures prove missing examples/fixtures/orphans and false refusal closure fail.

### Source and licence register

All reference claims are static source evidence at the pins below, not passing runtime results. Implement original code and original synthetic fixtures from requirements/official contracts. No gdoc code or test copying is permitted without a licence grant. Apache/MIT eligibility does not dispense with notices or a dependency audit. Official documentation prose is generally CC BY 4.0 and code samples Apache-2.0 subject to site terms; cite, do not wholesale transplant.

| Code | Pinned source / licence / evidence locations |
|---|---|
| M | [mmedum/google-docs-mcp, 06a2a2a0b8c121fee249258fcf0584e4192fab03](https://github.com/mmedum/google-docs-mcp/tree/06a2a2a0b8c121fee249258fcf0584e4192fab03), Apache-2.0. `internal/tools/{read,more_read,history,write,table,objects,layout,tabs,comments}.go`; `internal/service/{targets,apply,followup,markdown_write,docx}.go`; `internal/doc/model.go`, `internal/plan`, `internal/markdown`. |
| G | [LucaDeLeo/gdoc, e3d07fd18169729c97f3e02f7c75d9053e6a6b16](https://github.com/LucaDeLeo/gdoc/tree/e3d07fd18169729c97f3e02f7c75d9053e6a6b16), **no licence found** in tracked files/package metadata. `gdoc/cli.py` parser/handlers, `api/{docs,drive,revisions}.py`, `state.py`, `listnest.py`, `mdparse.py`, `mdimport.py`, `mcp.py`; tests are evidence only. |
| P | [tanaikech/gdoctableapppy, a4208a6b48045242f6ddb0b5af8eef1b37235a86](https://github.com/tanaikech/gdoctableapppy/tree/a4208a6b48045242f6ddb0b5af8eef1b37235a86), MIT (`LICENCE`). Entire `gdoctableapppy/gdoctableapp.py`. Interactive sample is not an assertion suite; CI tests disabled at this pin. |
| T | [tanaikech/go-gdoctableapp, fc57e5b4e33e6a7002b4d1b0c5ee2d7439933dc8](https://github.com/tanaikech/go-gdoctableapp/tree/fc57e5b4e33e6a7002b4d1b0c5ee2d7439933dc8), MIT (`LICENCE`). `methods.go`, `handler.go`, `processes.go`, `struct.go`; no tracked Go tests. |
| E1 | [UseJunior/safe-docx, dc665af88bd4b586f8b0fcdc8468fc3b75652201](https://github.com/UseJunior/safe-docx/tree/dc665af88bd4b586f8b0fcdc8468fc3b75652201), `packages/google-docs-core`, Apache-2.0 with NOTICE. `document.ts`, `anchors.ts`, `document-view.ts`, `write-operations.ts`, `concurrency.ts`. Parent project's wider DOCX surface is not attributed to this package. |
| E2 | [gravitas-md2gdocs, 47c6fcc77cbf329cdd770484ae011d99bc2db238](https://github.com/Significant-Gravitas/gravitas-md2gdocs/tree/47c6fcc77cbf329cdd770484ae011d99bc2db238), MIT. `converter.py`, `__init__.py`: pure request builder plus less-safe convenience helpers. |
| E3 | [MarkGDoc, ceb85214e7ba0763a53f1f20db7bda4cfae8ebe5](https://github.com/awesomeadi00/MarkGDoc/tree/ceb85214e7ba0763a53f1f20db7bda4cfae8ebe5), GPLv3. `src/markgdoc/markgdoc.py`; behavior inspiration only, no source transplant. |
| E4 | [docdown, 7eae6e73383324837df9ff8883edbe5173bf51f9](https://github.com/abidjappie/docdown/tree/7eae6e73383324837df9ff8883edbe5173bf51f9), package declares MIT OR Apache-2.0 but no root licence text found. `src/markdown/to_docs.rs`, `src/google/docs.rs`, `src/sync.rs`; resolve before any source reuse. |
| E5 | [gd2md-html, 27362947fadc27664419e8bf695484e02553269f](https://github.com/evbacher/gd2md-html/tree/27362947fadc27664419e8bf695484e02553269f), Apache-2.0. `addon/gdc.gs` element exporter; Apps Script editor add-on, not server REST. |
| E6 | [DocNamedRangeApp, 4233d2c9645448f97852e587c27bd8ffa4e9130b](https://github.com/tanaikech/DocNamedRangeApp/tree/4233d2c9645448f97852e587c27bd8ffa4e9130b), MIT. `DocNamedRangeApp.js`. |
| E7 | [RichTextApp, 2b0ecec3ad220a8f5e18f9280578b5ccf2213ee3](https://github.com/tanaikech/RichTextApp/tree/2b0ecec3ad220a8f5e18f9280578b5ccf2213ee3), MIT. `RichTextApp.js`, scoped Docs/Sheets style-transfer paths, not complete layout interchange. |
| E8 | [TemplateApp, d5b38bcb6b6ee09069fd142e3b41f16f336e5286](https://github.com/tanaikech/TemplateApp/tree/d5b38bcb6b6ee09069fd142e3b41f16f336e5286), MIT. `TemplateApp.js`, template/style/image routes. |
| E9 | [DocsServiceApp, 2b3d7171c6093630ddcb3f207a3c048157f9ac36](https://github.com/tanaikech/DocsServiceApp/tree/2b3d7171c6093630ddcb3f207a3c048157f9ac36), MIT. `DocumentAppp.js`, `WordApp.js`: export-derived table width observation, not general Docs editing. |
| E10 | [node-gdoctableapp, 1fb4427989871208ee88e13737ad443b3d3be20d](https://github.com/tanaikech/node-gdoctableapp/tree/1fb4427989871208ee88e13737ad443b3d3be20d), MIT. `index.js`; same lineage as P/T, not independent correctness evidence. |
| O | Official [discovery](https://docs.googleapis.com/$discovery/rest?version=v1), inspected revision **20261026**; [request](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request), [document](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents), [get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get), [batch](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate), [suggestions](https://developers.google.com/workspace/docs/api/how-tos/suggestions), [tables](https://developers.google.com/workspace/docs/api/how-tos/tables), [tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs). Saved official discovery SHA-256: `3948e9385816c87782b0548c577a39d240336015d2f4e63e1f40bac835f81741`. Table-scout serialization `24c05009490bb205a3c5f751b1a4a9201d84f04da31d0d13b046f4e50e976cb6` has equal parsed JSON, not identical bytes. Pin the actual fixture copied. Public URLs are mutable. |
| D | Official Drive [export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export), [formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions), [comments](https://developers.google.com/workspace/drive/api/guides/manage-comments). Distinct concurrency and conversion contracts. |
| A | Official Apps Script [DocumentApp](https://developers.google.com/apps-script/reference/document/document-app), [DocumentTab](https://developers.google.com/apps-script/reference/document/document-tab), [Body](https://developers.google.com/apps-script/reference/document/body), image/bookmark/named-range classes. Runtime/editor-only features are not REST evidence. |
| C | Existing `plugins/google-drive` source at completed baseline above: core Docs/Sheets/Drive modules, adapters, tools, approval UI, skills and tests. Existing source licence applies; preserve shared dependencies. Static architecture findings are not runtime reproductions. |

### Pinned licence texts

These links record source-use constraints; this implementation copies no reference-program code or tests.

- M: [Apache-2.0](https://github.com/mmedum/google-docs-mcp/blob/06a2a2a0b8c121fee249258fcf0584e4192fab03/LICENSE).
- P: [MIT](https://github.com/tanaikech/gdoctableapppy/blob/a4208a6b48045242f6ddb0b5af8eef1b37235a86/LICENCE).
- T: [MIT](https://github.com/tanaikech/go-gdoctableapp/blob/fc57e5b4e33e6a7002b4d1b0c5ee2d7439933dc8/LICENCE).
- E1: [Apache-2.0](https://github.com/UseJunior/safe-docx/blob/dc665af88bd4b586f8b0fcdc8468fc3b75652201/LICENSE), [NOTICE](https://github.com/UseJunior/safe-docx/blob/dc665af88bd4b586f8b0fcdc8468fc3b75652201/NOTICE).
- E2: [MIT](https://github.com/Significant-Gravitas/gravitas-md2gdocs/blob/47c6fcc77cbf329cdd770484ae011d99bc2db238/LICENSE).
- E3: [GPLv3](https://github.com/awesomeadi00/MarkGDoc/blob/ceb85214e7ba0763a53f1f20db7bda4cfae8ebe5/LICENSE).
- E5: [Apache-2.0](https://github.com/evbacher/gd2md-html/blob/27362947fadc27664419e8bf695484e02553269f/LICENSE).
- E6: [MIT](https://github.com/tanaikech/DocNamedRangeApp/blob/4233d2c9645448f97852e587c27bd8ffa4e9130b/LICENCE).
- E7: [MIT](https://github.com/tanaikech/RichTextApp/blob/2b0ecec3ad220a8f5e18f9280578b5ccf2213ee3/LICENCE).
- E8: [MIT](https://github.com/tanaikech/TemplateApp/blob/d5b38bcb6b6ee09069fd142e3b41f16f336e5286/LICENCE).
- E9: [MIT](https://github.com/tanaikech/DocsServiceApp/blob/2b3d7171c6093630ddcb3f207a3c048157f9ac36/LICENCE).
- E10: [MIT](https://github.com/tanaikech/node-gdoctableapp/blob/1fb4427989871208ee88e13737ad443b3d3be20d/LICENCE).
- G has no licence grant found at its pin; E4's declaration lacks a root licence text. Neither is permission to reuse source.

## A. Discovery, reading, selectors and semantic evidence

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C001 | Native Doc/Markdown/Word kind, metadata, capabilities, read-only/default mode and counts; do not infer permission from connection | `docs_inspect` | READ/KIND | S02 | M read; G info; C; N |
| C002 | Recursive tab tree, titles/IDs/parents, all-tab and explicit selected-tab reads; identical titles ambiguous | inspect/read explicit scope | READ/TABS | S02 | M read/tabs; G cat/tabs; E1/E4; O; N |
| C003 | Body/header/footer/footnote inventory and scoped content | inspect/read segment | READ/SEGMENTS | S02 | M read/model; O; N |
| C004 | Heading outline with IDs, levels, depth filter, deep links and section sizes | inspect outline | READ/OUTLINE | S02 | M get_outline; G toc; N |
| C005 | Text and Markdown output, style/review annotations, omit-image projection, bounded continuation without false coverage | read formats/options | READ/PROJECTIONS | S02 text/structured; S12 Markdown/HTML | M read; G cat; C reader; N/P |
| C006 | Structured diagnostic view with styles/objects/ranges/suggestions, no public arbitrary field mask or write indices | read structured | READ/STRUCTURE | S02 | G structure; M scoped JSON; O; N; raw mask transport X |
| C007 | Adjacent styled runs render without invented newlines; rich/nested cells remain addressable | read structured/table projection | READ/RICH_CELLS | S02 | P/T parser defects; E1/E10; N |
| C008 | TOC/equation/auto-text/drawing/unknown nodes readable and preserved without false round-trip claims | opaque nodes and loss manifest | READ/OPAQUE | S02 | E5; O; N |
| C009 | Paged snapshot ownership, expiry/replay/wrong account/thread, provider overrun, partial/empty coverage | read cursors | READ/COVERAGE | S02 | C reader; G per-tab state; N/P |
| C010 | Inline/accepted/rejected suggestion projections have separate identities; only inline is writable | read view | READ/VIEWS | S02 | G docs; O get/suggestions; N |
| C011 | Comments require tabs + explicit inline view; denied comments never becomes full coverage | read include review | READ/COMMENT_VIEW | S02 | O get; N |
| C012 | Literal cross-run find with bounded context, scope and limit; no match across chips/paragraphs | `docs_find` | SELECT/LITERAL | S02 | M find; G edit; N |
| C013 | Typography normalization, explicit NFC/case policy, inverse source mapping, emoji/combining/RTL | find/text selectors | SELECT/NORMALIZATION | S02 | M targets; G normalize; O UTF-16; N |
| C014 | Bounded linear regex and captures, scoped replace-all expected count; no empty-match loops | find + content replaceAll | SELECT/REGEX | S04 | M find/write; N |
| C015 | Default exactly-one, explicit zero-based occurrence or all with expected count; ambiguity returns candidates | shared selectors | SELECT/CARDINALITY | S02 | M/G; N |
| C016 | Heading ID/text/path/level and heading-section through next peer, includeHeading distinction | shared section selector | SELECT/SECTION | S02 | M targets; N |
| C017 | Snapshot block handles/inclusive node spans; stale handle never rebinds to current ordinal | shared selectors | SELECT/HANDLES | S02 | M/E1; G tab baseline; N |
| C018 | Table path/handle/header/label-to-right or explicit-column selectors, nested/duplicate contexts | find + table family | SELECT/TABLE_LABEL | S06 | G cell label; P/T table ordinals; N |
| C019 | Named-range ID/nonunique name/discontinuous spans, object IDs, existing bookmark/heading links | shared selectors | SELECT/IDENTITIES | S02/S09 | M/E6/O; N |
| C020 | Fully explicit tab URL/ID/path resolution; reject conflicting explicit selector and URL rather than hidden defaults | identity parser | SELECT/TAB_SCOPE | S02 | G URL/tab precedence; O; N |
| C021 | K3 exact narrow witness/complete preview avoids redundant reads; broad affected scope delivered by read OR preview; history never current proof, no sibling authority | coverage gate | SELECT/PROOF | S02 | G state/tests; C gaps; N |

## B. Content, rich text, paragraphs, lists and composition

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C022 | Insert/append/prepend before/after node, paragraph start/end and segment start/end, preserving terminal newline | `docs_plan_content` | CONTENT/INSERT | S04 | M edit; G insert; E2; N |
| C023 | Literal replacement/deletion, newlines/block replacement, cross-run minimal difference and chosen style policy | content replace/delete | CONTENT/REPLACE | S04 | M/G; C replacement; N/P |
| C024 | Replace-all exact match scope/count, same text elsewhere untouched; no first/all-tab provider default | content replaceAll | CONTENT/ALL | S04 | M/G; O bulk defaults; N |
| C025 | Text versus inline fragment versus block fragment versus explicit Markdown/HTML; no format guessing | fragments/codecs | CONTENT/TYPES | S04/S12 | M markdown; E2/E4; N |
| C026 | Paragraph merge/deletion preserves style/list/object/anchor boundaries or refuses exact unsupported effect | content structural delete | CONTENT/BOUNDARIES | S04 | O delete rules; M guards; N |
| C027 | K2 new/extend draft, generated typed refs, original-target-preserving combine, no draft execution claims, exact request/key recovery | family plans + combine | COMPOSE/ORDER | S03/S05 | M ops/followup; P/T phases; N |
| C028 | Supported fragment copy/move in one document, destination-first multi-stage safety and partial duplicates | content copy/move | COMPOSE/MOVE | S05 | A element copy; O no clone primitive; N |
| C029 | N: frozen or unchanged-source reconstructed copy with separately pinned subjects/assets; B: native clone-any-element request absent | content copy | COMPOSE/CROSS_DOC | S11 | A; E1; O; N/B |
| C030 | Native page break; preserve protected terminal structures | content pageBreak | CONTENT/PAGE_BREAK | S04 | M edit; O; N |
| C031 | Bold/italic/underline/strike/small caps/font family/weight/size | `docs_plan_style` inline | STYLE/FONT | S04 | M format; E2/E7; O; N |
| C032 | Foreground/highlight, baseline super/subscript/normal; transparent only where legal | style inline | STYLE/COLOUR_BASELINE | S04 | M format; O; N |
| C033 | URL links, existing heading/bookmark/tab destinations; no link fetch | style link | STYLE/LINK | S04/S09 | M/G/E2/E5; O; N |
| C034 | Explicit/inherited/effective distinction; selected resets/clearFormatting preserve unrequested semantics; set/reset conflict is a same-mode guard, not successful writing | style set/reset/clear | STYLE/INHERIT_RESET | S04 | M clear; E7 counterexample; O; N |
| C035 | Heading/title/subtitle/normal named type application is semantic, not visual bold | style paragraph namedType | STYLE/HEADING | S04 | M/G/E2/E4; O; N |
| C036 | Paragraph start/center/end/justify alignment, spacing above/below, line percentage, direction | style paragraph | STYLE/PARAGRAPH_SPACE | S04 | M; C format; O; N/P |
| C037 | Start/end/first-line indents, complete paragraph borders/padding/shading; K9 full-border merge/reset and adjacent rendering dependencies; missing border evidence is a same-mode guard | style paragraph | STYLE/PARAGRAPH_BOX | S04 | M format; E2 quote/code styling; O; N |
| C038 | Keep-with-next, keep-lines, widow/orphan, page-break-before controls | style paragraph | STYLE/PAGINATION | S04 | M format; O; N |
| C039 | Create bullet/numbered/checklist presets; remove bullets with explicit indentation consequences | `docs_plan_list` | LIST/CREATE_REMOVE | S05 | M format; G Markdown; E2/E4; O; N |
| C040 | Continue native list, adjacency/join behavior, numbering identity; no arbitrary restart guarantee | list continue | LIST/CONTINUATION | S05 | G listnest; O lists; N/B |
| C041 | Nest/unnest item/range plus descendants, levels 0–8 and valid parent topology | list nest/unnest | LIST/NEST | S05 | G nest/unnest; N |
| C042 | Preserve custom marker/indent, table-contained items, suggestions/positioned attachments and joined lists; refusal alone cannot close these engineering obligations | list preservation algorithms | LIST/CUSTOM | S05 | G exclusions are algorithmic, not provider evidence; N for every listed variant; arbitrary setters separately B in C044 |
| C043 | List tab-removal shifts later ranges; variable table text shifts later styling; non-BMP correctness | compiler transforms | COMPOSE/RICH | S05 list/non-BMP; S07 table-rich composition | E2/E4 defects; G listnest; O; N |
| C044 | Arbitrary glyph/numbering/restart property mutation not provided by supported REST; read/preserve instead | capability/refusal | LIST/UNAVAILABLE_SETTERS | S05 | O read-only list properties; B |

## C. Tables: full union plus modern provider surface

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C045 | Discover all tables recursively by tab/segment/path, no durable table ID invented | inspect table registry | TABLE/DISCOVER | S06 | P GetTables; T GetTables; E10; O; N |
| C046 | Whole table/cell/range values and rich fragments; styled runs and multiline text preserved | read table/grid | TABLE/READ | S06 | P/T GetValues; M table; N |
| C047 | Set ragged matrix from origin; omitted cells unchanged, explicit empty clears text | table patchText | TABLE/RAGGED | S06 | P SetValues; T SetValuesBy2DArray; N |
| C048 | Multiple offset value blocks; duplicate physical coordinates rejected without mutating caller input | table patchText blocks | TABLE/OFFSETS | S06 | P object values; T SetValuesByObject; N |
| C049 | Explicit trailing grow-to-fit rows and columns; default reject, never invisible growth | table growth | TABLE/GROW | S06 | P/T automatic growth adapted; N |
| C050 | Append multiple rows with values; wider input adds columns only when requested | table appendRows | TABLE/APPEND | S06 | P/T AppendRow; N |
| C051 | Create blank/populated table at semantic anchor or segment end; absent values valid, dimensions reject overflow | table create | TABLE/CREATE | S06 | P/T CreateTable; M insert; N |
| C052 | Create/read/populate checkpoints, identity not last ordinal, partial empty table on rejected second stage | executor/table | TABLE/CREATE_PARTIAL | S06 | P/T/M stages; N |
| C053 | Text-span edit inside rich cell preserves images/nested table/other paragraphs | content cell selector | TABLE/TEXT_SPAN | S06 | M table rich edits; O; N |
| C054 | Explicit replaceCellFragment/clearAllContents discloses nested-content removal and final newline preservation | table replaceCellFragment | TABLE/REPLACE_CELL | S06 | P/T whole-cell replacement hazards; N |
| C055 | Nested table discovery/insertion/editing in valid cell paragraphs, never raw outer-table index | table create/content | TABLE/NESTED | S06 | O; P/T only placeholders; N |
| C056 | Logical span grid maps covered cells to origin; conflicting aliases and partial-merge targets rejected | table model | TABLE/SPANS | S06 | O; P/T defects; N |
| C057 | Insert rows above/below and columns left/right, merged-anchor footprint explicit | table splice | TABLE/INSERT_AXES | S07 | M table; O; N |
| C058 | Delete row-only/column-only/both; duplicates/negative/out-of-range rejected; descending original-axis targeting | table deleteAxes | TABLE/DELETE_AXES | S07 | P/T defects; M; N |
| C059 | Exact whole-table deletion; last-axis deletion reported as table deletion; no subsequent dangling operation | table delete | TABLE/DELETE_TABLE | S07 | P/T DeleteTable; O; N |
| C060 | Merged anchor deletion cannot silently delete extra rows/columns | table deletion planner | TABLE/DELETE_MERGED | S07 | O; N |
| C061 | Merge rectangular physical set; LTR/RTL concatenation head and loss of cell identity disclosed | table merge | TABLE/MERGE | S07 | M; O; N |
| C062 | Unmerge touched cells; content remains head, not an undo; no merged cells yields no change | table unmerge | TABLE/UNMERGE | S07 | M; O; N |
| C063 | Cell background, vertical alignment, all/four padding sides; precise masks/reset | table styleCells | TABLE/CELL_STYLE | S07 | M; O supersedes P/T old README; N |
| C064 | Four/shared borders, adjacent effects, invisible merged edges, width-zero hide not transparent colour | table styleBorders | TABLE/BORDERS | S07 | M; O; N |
| C065 | Fixed/even column widths via TableColumnProperties.width, minimum 5pt, selected/all columns; no rendered-width claim | table columns | TABLE/COLUMNS | S07 | M; O; N |
| C066 | Row min height/preventOverflow/header properties; selected/all rows, not exact pixels | table rows | TABLE/ROWS | S07 | M; O; N |
| C067 | Pin N leading header rows/unpin 0; distinct from bold | table pinHeaders | TABLE/PIN | S07 | M; O; N |
| C068 | Rich text/lists/links/images/chips in cells reuse shared fragment engine, not separate lossy API | table fragments | TABLE/RICH | S06/S09 | M/O; E7; N |
| C069 | Table header/label filling, positive duplicate-label disambiguation and separate ambiguous-label guard; whole-cell versus subspan explicit | table fill | TABLE/FORMS | S06 | G edit --cell; N |
| C070 | Placeholder-to-image in tables/body, cross-run/all matches/Unicode/neighbor preservation, explicit scoped tableOnly | media bindImages | TABLE/IMAGE_PLACEHOLDER | S09 | P ReplaceTextsToImages; T URL/File/TableOnly/SetImageSize; E10; N |
| C071 | Public string-only values; no Python/Go coercion differences, no out-of-grid truncation | table input schema | TABLE/INPUT_TYPES | S06 | P/T source defects; N |
| C072 | Export-derived DOCX table/grid widths with twips/unit provenance, not authoritative native geometry | export analysis | TABLE/DERIVED_WIDTH | S12 | E9; N |
| C073 | Table sort/move/copy/resize not claimed as primary-library APIs; supported fragment move/copy and explicit splices are distinct additions | content/table composition | TABLE/COMPOSITION | S05/S07 | P/T absence; A/O; N with preservation bounds |

## D. Tabs, segments, structural layout and named styles

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C074 | Add tab with optional initial rich content and returned-ID dependency | `docs_plan_structure` addTab | STRUCT/TAB_ADD | S08 | M/G add-tab; E4; O; N |
| C075 | Rename/reorder/reparent/nest/icon tabs; validate tree/cycles/provider depth and sibling preservation | structure tabProperties | STRUCT/TAB_PROPERTIES | S08 | M manage_tabs; O; N |
| C076 | Exact parent-tab subtree deletion, all descendants previewed, stale tree invalidates plan | structure deleteTab | STRUCT/TAB_DELETE | S08 | M delete_tab; O; N |
| C077 | Create/delete global or section DEFAULT header/footer; get ID then populate; existing first/even segments editable | structure header/footer | STRUCT/HEADER_FOOTER | S08 | M edit; O; N |
| C078 | First/even creation types not supported by current create enum; preserve ownership/inheritance | capability + style settings | STRUCT/HEADER_LIMITS | S08 | O DEFAULT enum; B/N |
| C079 | Footnote reference and rich text content staged by returned ID, valid body placement only | structure footnote | STRUCT/FOOTNOTE | S08 | M; E5 export; O; N |
| C080 | Insert continuous/next-page structural section break; no sections in tables/segments/equations | structure sectionBreak | STRUCT/SECTION_BREAK | S08 | M layout; O; N |
| C081 | Change page size/custom dimensions via DocumentStyle.pageSize and nested Dimension/mask contracts; orientation/margins/background/header-footer distance/number start | `docs_plan_style` page | LAYOUT/PAGE | S08 | M layout; C page format; O; N/P |
| C082 | Paged/pageless, first/even header settings; stored versus effective properties and suggest-mode field exclusions | style page | LAYOUT/MODE | S08 | M/G new config; O; N |
| C083 | Section margins/orientation/number start/first-page setting; columns 1–3/gap/separator/direction | style section | LAYOUT/SECTION | S08 | M layout; O; N |
| C084 | Named-style definition, inheritors/overrides, exact tab; K9 named_style_type and required parent+nested masks, explicit clear-all distinction | style namedStyle | LAYOUT/NAMED_STYLE | S08 | M; O updateNamedStyle; N |
| C085 | In-place section-break type conversion unavailable as direct setter; explicit replacement needs full destructive footprint | structure capability/replacement | LAYOUT/BREAK_TYPE | S08 | M/O; B/N |
| C086 | Page number start is not automatic field insertion; TOC generation not inferred from outline | capability/refusal | LAYOUT/AUTO_FIELDS | S08 | O/A distinction; B |

## E. Images, chips, dropdowns, anchors and unsupported object edits

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C087 | Image/chart/drawing/positioned object inventory and inspect exact object ID/properties | inspect/read objects | MEDIA/INVENTORY | S02/S09 | G images; M get_document; O; N |
| C088 | Safe image asset download to new thread artifact, private/temporary URI provenance; no public hosting | export assets | MEDIA/DOWNLOAD | S09 | G images download; E5 asset warnings; N |
| C089 | Insert inline image at valid semantic paragraph/cell/segment location; width/height/aspect, explicit tab | `docs_plan_media` insertImage | MEDIA/INSERT | S09 | M/G/P/T/O; C additive PNG; N/P |
| C090 | Native replace has CENTER_CROP only, preserving bounds with possible effect removal; separate reinsertImage contain/resize changes identity and discloses anchor losses | media replaceImage | MEDIA/REPLACE | S09 | M/G/E8/O; N |
| C091 | Delete exact inline or positioned object without unrelated text deletion | media removeObject | MEDIA/DELETE | S09 | M/O; N |
| C092 | PNG/JPEG/GIF validation and local budget expansion, DNS/HTTPS stubs, changed digest and Google-fetch race | asset adapter | MEDIA/FORMATS_SECURITY | S09 | O native formats; C PNG adapter; N |
| C093 | Local/private file convenience cannot silently publish, upload/share/delete temp image; explicit alternatives only | media source validation | MEDIA/NO_PUBLICATION | S09 | G/P/T/E8/E10 unsafe convenience; X; user image intent C089/C090 |
| C094 | Alt title/description/general image property mutation and positioned insert/move unavailable in REST; preserve/read | media capabilities | MEDIA/UNAVAILABLE_PROPERTIES | S09 | A setters vs O inventory; B |
| C095 | Person/resource chips; K9 civil/instant dates, local midnight→UTC, timezone/locale/writable date/time enums; reject ambiguous midnight/output-only custom format | media insertChip | MEDIA/CHIPS | S09 | M objects; O insertPerson/RichLink/Date; N |
| C096 | Chip model width/display distinction, per-chip allowed segments, typed delete/replace without flattening | fragments/media | MEDIA/CHIP_BOUNDARIES | S09 | O schemas; G UTF-16; N |
| C097 | Create/read dropdown definition with option IDs/labels/colours and tab identity | media dropdownDefinition | DROPDOWN/DEFINE | S10 | O createDropdownDefinition; N |
| C098 | Rename/reorder/update options, full list mask, selected-option replacement map for deletions | media updateDropdownDefinition | DROPDOWN/UPDATE | S10 | O updateDropdownDefinitionProperties; N |
| C099 | Insert dropdown using returned definition ID and explicit selection; native default reported if used | media insertDropdown | DROPDOWN/INSERT | S10 | O insertDropdown; N |
| C100 | Change selected option, delete exact instance; refuse deleting in-use definition | media dropdown operations | DROPDOWN/INSTANCE_DELETE | S10 | O updateDropdownProperties/deleteDropdownDefinition; N |
| C101 | Named-range create/list/read/delete labels; positive duplicate-name creation with distinct IDs, exact-ID and explicit-all handling among duplicates; separately refuse ambiguous name-only selector. N direct success; native suggest excluded | `docs_plan_anchor` | ANCHOR/LIFECYCLE | S09 | M edit; E1/E6; O; N |
| C102 | Fill contiguous range; discontinuous native fill deletes later spans and must be distinct reviewed command | anchor fill | ANCHOR/SPLIT_FILL | S09 | M/O; N |
| C103 | Persistent paragraph/table associations require explicit named-range write; inspection creates no anchors | anchor create + inspect | ANCHOR/OPT_IN | S09 | E1 injectAnchors; E6; N |
| C104 | Existing bookmark discovery/linking supported; real create/delete unavailable, named ranges not equivalent | inspect/style/capability | ANCHOR/BOOKMARK | S09 | A bookmark; O no lifecycle; N/B |
| C105 | Native TOC/equation/drawing/chart content editing/general element clone unavailable; preserve opaque nodes | capability/refusal | MEDIA/OPAQUE_WRITES | S09 | E5/A/O; B |
| C106 | Manual linked outline and paragraph-border rule are explicitly different from auto-updating TOC/native horizontal rule | content/style | MEDIA/MANUAL_ALTERNATIVES | S04/S09 | G toc read; E3 border; A rule; N/B |

## F. Comments, suggestions, modes and partial saves

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C107 | List/read one/all threads, resolved/deleted inclusion, anchors/replies and Markdown annotations | `docs_discussions` | REVIEW/READ_THREADS | S10 | M list_comments; G comments/comment-info; O; N |
| C108 | Anchored comment success on exact inspected range; known-stale preflight guard versus actual 403 dispatch-failure invariant; neither silently falls back | `docs_plan_discussion` add | REVIEW/ANCHOR | S10 | M/G fallbacks replaced; O insertComment; N |
| C109 | Explicit document-wide comment and optional quoted metadata via Drive, backend/CAS distinction | discussion addDocumentWide | REVIEW/DOCUMENT_WIDE | S10 | M/G; D; N |
| C110 | Assign at creation; reassign only already assigned comment via reply; reject action/suggestion combinations | discussion assign/reassign | REVIEW/ASSIGN | S10 | M; O InsertComment/Post; N |
| C111 | Reply to comment or suggestion thread, exact separate thread/post IDs | discussion reply | REVIEW/REPLY | S10 | M/G; O addCommentReply; N |
| C112 | Edit own post; suggestion head post immutable; plain text UTF-8 byte cap | discussion editPost | REVIEW/EDIT_POST | S10 | M; O updateCommentPost; N |
| C113 | Delete own thread or own reply; replies with action/assignee not deletable | discussion deleteThread/deletePost | REVIEW/DELETE | S10 | M/G; O; N |
| C114 | Resolve/reopen with optional text, native action posts, no false deletion | discussion resolve/reopen | REVIEW/ACTIONS | S10 | M/G; O Post; N |
| C115 | Notification/mention/assignment consequences visible, no invented silent switch or delivery proof | approval + receipts | REVIEW/NOTIFICATIONS | S10 | O editor-like notifications; N |
| C116 | List text/format/structure pending suggestions and IDs/affected ranges/metadata/posts | `docs_suggestions` | REVIEW/SUGGESTIONS | S10 | M list_suggestions; G cat; O; N |
| C117 | True tracked direct/suggest/commentProposal modes; proposal comments not tracked edits | authoring mode | REVIEW/MODES | S10 | M modes; G suggest; O writeMode; N |
| C118 | K7 request/field/mode/permission/revision/save matrix; distinguish schema support, account evidence and non-editor index-write policy; no direct fallback | capability/compiler | REVIEW/MODE_MATRIX | S10 | O guide eight request exclusions/three style fields; N |
| C119 | Editor CAS accept/reject, author discard; explicit reviewed ID/no-CAS reject/discard for non-editor author with exact witnesses; no borrowed revision or substitution | `docs_plan_suggestion` | REVIEW/DECISIONS | S10 | M review_suggestion; O; N |
| C120 | ALL_SAVED/failed/absent/unspecified/contradictory NO_UPDATES; independent model/thread facts; partial or failed/unknown save claims held across reopen | executor/verifier | REVIEW/PARTIALSAVE | S10 | O batch/guide; G tests; M apply gap; N |
| C121 | Created/updated/deleted/accepted/rejected suggestion IDs mapped per request; exact readback | suggestion verifier | REVIEW/RESPONSES | S10 | O SuggestionResponse; M/G; N |
| C122 | CommentProposal generated prose bounded per exact target; text >2048 UTF-8 units not split silently | mode/comment schema | REVIEW/BYTE_LIMIT | S10 | M comment mode; O; N |
| C123 | Later metadata failure cannot erase acknowledged and verified suggestion/content outcome | evidence lifecycle | REVIEW/METADATA_FAILURE | S10 | G suggest tests; C; P/N |

## G. Templates, creation, codecs, imports, exports and history

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C124 | Blank native Doc, plain/Markdown/rich initial body, explicit destination/page mode/tab tree | `docs_plan_create` | CREATE/NATIVE | S11 blank/plain/structured; S12 Markdown | M create_document; G new; C create; N/R |
| C125 | Create/copy/populate known IDs, stage acknowledgement and partial shared-content exposure | creation executor | CREATE/STAGES | S11 | M/G/C; D; N/P |
| C126 | Copy template file and populate as explicit new instance; preserve original ID/content | create from template | TEMPLATE/COPY | S11 | E8; D; R/N |
| C127 | Literal typed text/fragment/image bindings; missing/unused keys are same-mode guards with legal controls, not positive writes; exact match count, cross-run neighbor preservation | `docs_plan_template` | TEMPLATE/BIND | S11 | E8/M/P/T/G; N |
| C128 | Template-style/value-style/noStyle policies; image placeholders by text or existing object identity | template policies | TEMPLATE/STYLES_IMAGES | S11 | E8; M objects; N |
| C129 | Sheets display values/rich runs into Docs template with frozen snapshot/provenance; no hidden live link or formula execution | template source | TEMPLATE/SHEETS | S11a real rich-read prerequisite, then S11 binding | E7/E8; N/R |
| C130 | CommonMark headings/paragraphs/emphasis/strike/inline code/links/fenced code/blockquote | content/import Markdown codec | CODEC/MARKDOWN_CORE | S12 | M/E2/E3/E4; G Markdown; N |
| C131 | N: nested lists/GFM tables/task presets/footnotes/inline images via exact real docs_plan_content Markdown insert driver with direct/suggest contracts; B: absent native arbitrary checked-state setter, not all task syntax | docs_plan_content.markdownRich + Markdown codec | CODEC/MARKDOWN_RICH | S12 | M/G/E4/E5; O; N/B for nonwritable semantics |
| C132 | HTML allowlisted structures/style subset, no script/external loads, source-location losses | import/export HTML codec | CODEC/HTML | S12 | E5; D; N |
| C133 | Selected-tab Markdown write/insert preserve siblings; whole-document multi-tab collapse distinct reviewed destructive plan | content/import | CODEC/TAB_REPLACEMENT | S12 | G write/push; E4; N |
| C134 | Unsupported markup/opaque node/assets produce loss manifest; reject default or exact listed losses, no silent flattening | codec contract | CODEC/LOSS | S12 | E5; E4 placeholders counterexample; N |
| C135 | K8 source/result routes for DOCX/ODT/HTML/RTF/text/Markdown conversion; artifact source preserves saved upload preview/digest/mandatory review even in private root; unadvertised import format is a fixed-route preflight guard | `docs_plan_import` | IMPORT/FORMATS | S12 | M/G; D; C DOCX upload; R/N |
| C136 | Modern Office upload remains explicit, original binary versus conversion distinguished, no fidelity promise | existing `gdrive_upload_file` | IMPORT/OFFICE_POLICY | S12 | C upload/office readback; R/P |
| C137 | Whole-file Google exports PDF/DOCX/ODT/RTF/EPUB/text/HTML/Markdown to new artifacts; format limit/errors | `docs_export` provider | EXPORT/FORMATS | S12 | M export; G export; D; N |
| C138 | Selected-scope semantic text/Markdown/HTML export is separate from whole-file rendered conversion | export semantic | EXPORT/SCOPE | S12 | M scoped read; E5; N |
| C139 | Export asset manifest, headers/footers/tabs/footnotes/page breaks/unknown loss, temporary image URIs | export loss/asset manifest | EXPORT/FIDELITY | S12 | E5; G export; D; N |
| C140 | Google export 10 MB limit; bounded artifact creation/no arbitrary path/overwrite/archive extraction hazards | artifact/export adapter | EXPORT/BOUNDS | S12 | D; M export directory; N |
| C141 | Retained Drive revision listing with pagination/order/limit, sparse/pruned/permission failures | `docs_history` list | HISTORY/LIST | S12 | M list_revisions; G revisions/history; D; N |
| C142 | Exact/latest/head/previous/head-minus-position/time selectors, not numeric ID arithmetic | history selectors | HISTORY/SELECT | S12 | G revisions adapter; N |
| C143 | Historical Markdown/text/export read with provenance; no current handles/CAS namespace reuse | history read | HISTORY/READ | S12 | M/G; D; N |
| C144 | Revision-to-revision/time/current-vs-file diff, word/block/context/coalescing and comment annotations | history diff/working compare | HISTORY/DIFF | S12 | M diff_revisions; G diff; N |
| C145 | Structured/plain/HTML diff artifacts; terminal colour is presentation, not a separate domain mutation | history output | HISTORY/FORMATS | S12 | G diff JSON/HTML/plain/color; N/X terminal-only |

## H. Markdown and Word file workflows, working copies and interchange

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C146 | Create Markdown file as distinct Drive blob, not mislabeled native Doc | create/file adapter | FILE/MARKDOWN_CREATE | S13 | M create_document; D; N |
| C147 | Native working Doc from existing Markdown file, origin link/base snapshot and explicit creation | create workingCopy | FILE/WORKING_DOC | S13 | M create_document; N |
| C148 | Pull/checkout current document/tab into Markdown artifact with sidecar/frontmatter provenance | `docs_working_copy` checkout | FILE/CHECKOUT | S13 | G pull; M writeback; E4; N |
| C149 | Historical checkout stamped source/revision and nonpushable; metadata-only read cannot heal unseen baseline | workingCopy checkout | FILE/HISTORICAL | S13 | G pull/state tests; N |
| C150 | Compare local Markdown to native Doc and plan scoped push/write; no quiet/force conflict bypass | workingCopy compare + content | FILE/PUSH | S13 | G push/write/insert/diff; N |
| C151 | Working-Doc-to-Markdown source writeback preserves unchanged blocks/frontmatter/comment markup | `docs_plan_file_write` Markdown | FILE/WRITEBACK | S13 | M markdown_write; N |
| C152 | Three-way nonoverlap reconciliation; overlap conflict artifact, no source-winning force/repair upload | file merge planner | FILE/CONFLICT | S13 | M force semantics/E4 sync adapted; N; unsafe repair X |
| C153 | K8 before version/digest, exact after bytes/digest/logical/package diff, just-in-time comparison with non-CAS race warning; mandatory review, one attempt and durable claim | file executor | FILE/NO_CAS | S13 | M/G file paths; D; N/P |
| C154 | Bounded Word body/table-cell paragraph mapping, original package bytes/relations preserved for unrelated parts | Word working copy/parser | FILE/WORD_MAP | S13 | M docx.go; D; N |
| C155 | Word mapped text/rich-inline replacement, OOXML tracked insert/delete and comment mode as separate file semantics | file write Word | FILE/WORD_EDIT | S13 | M docx.go; N |
| C156 | Word ingestion polling/readback after upload; stale mapping/unknown state/refused route never triggers replay | Word verifier | FILE/WORD_INGEST | S13 | M docx poll; C office readback; N |
| C157 | B: native Docs mutation of a Word blob unavailable. N: explicit OOXML codec scope/preservation/expansion contracts; table/layout/media codec limits are engineering, not Google bans. Conversion is not parity | file capability + codec scope | FILE/WORD_LIMITS | S13 | M limited codec is not provider evidence; O/D native route; variant-level B and N |
| C158 | Separate OOXML edit validator over safe ZIP/XML/media primitives; macros/signatures/active parts rejected; existing import/XLSX/media-helper contracts not weakened | OOXML security | FILE/WORD_SECURITY | S13 | C Office validators; M file intent; N/P |
| C159 | Docs→Sheets rich-text runs and Sheets→Docs rich-text, explicit style subset and inheritance losses | existing Sheets context extension + fragments | INTEROP/RICH_TEXT | S11a read; S14 write | E7; N; no false whole-layout interchange |
| C160 | Rich text/Sheet range→HTML table, no claimed full native Doc table interchange | codec/interchange | INTEROP/HTML_TABLE | S14 | E7; N |
| C161 | Font-size fitting is calculated suggestion with measurement limits, not actual Docs renderer geometry | style preview utility | INTEROP/FONT_FIT | S14 | E7 font-size fitting; N with explicit approximation |

## I. Adjacent Drive and Sheets scope and deliberate transport exclusions

These rows account for the adjacent behaviors exposed by gdoc and ecosystem examples. They do not authorize changing real permissions, grants or files during research/testing. Reuse preserves existing mandatory owner review and uncertain-write recovery; missing capabilities require bounded new work, not an invented claim of current support.

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C162 | Drive list/search title/content/folder/type, multi-account pagination and incomplete results | existing `gdrive_search_files`, `gdrive_list_folder` | ADJACENT/SEARCH | S14 | M search_documents; G ls/find; C; R |
| C163 | Owner/modified-after/native-vs-Markdown structured filters, newest order and shared-drive search where authorized | extend Drive search schema | ADJACENT/FILTERS | S14 | M search_documents; G find; D; N |
| C164 | Raw Drive query expression is not a public raw-HTTP/API escape; expose supported semantic filters instead | Drive search validation | TRANSPORT/RAW_QUERY | S14 | G --query; X transport with C163 replacement, not syntax parity |
| C165 | File metadata/info and change-awareness provenance | existing get file + semantic inspect | ADJACENT/METADATA | S02/S14 | G info; C; R/N |
| C166 | Copy existing file into explicit destination with exact access review and marker recovery | existing `gdrive_copy_file/status` | ADJACENT/COPY | S11/S14 | G cp; C; R |
| C167 | Rename file, preserving ID, no content-baseline laundering | bounded Drive rename tool | ADJACENT/RENAME | S14 | G rename; C missing; N |
| C168 | Folder creation and file move preserve ID; batch filing/recovery and inherited-access policy | existing folder/move/filing tools | ADJACENT/FILING | S14 | G mkdir/mv/move; C; R |
| C169 | List shared drives and search their contents; not blanket write/ownership permission | Drive discovery addition | ADJACENT/SHARED_DRIVES | S14 | G drives/ls; D; N |
| C170 | Existing named user/group/anyone sharing grants/role changes/revokes and opt-in invitations | existing sharing tools/status | ADJACENT/SHARING | S14 | G share subset; C mandatory consent; R |
| C171 | K8 domain/anyone linkOnly/searchable forms, exact role/permission/ancestry/notify witness, mandatory preview/review and no-CAS recovery; no new grants | bounded sharing extension | ADJACENT/DOMAIN_DISCOVERY | S14 | G share; D; N; never hidden Docs effect |
| C172 | Sheets bounded read and tab inventory/A1 convenience converted to exact indices | existing Sheets read plus typed A1 resolver | ADJACENT/SHEETS_READ | S14 | G cat --range/tabs; C; R/N |
| C173 | Sheets values/rectangles/repeated values/explicit formulas, preserve existing formula grammar and no-CAS warning | existing Sheets edit family | ADJACENT/SHEETS_WRITE | S14 | G cells subset; C; R |
| C174 | K8 fixed inspected blank append rectangle, complete table footprint, artifact CSV/TSV/JSON and explicit parsed locale; merge/protection/table guards, mandatory review, existing formula grammar and no USER_ENTERED escape | Sheets bounded extension | ADJACENT/SHEETS_APPEND | S14 | G cells; N; existing grammar remains restrictive |
| C175 | Sheets merged-text anchors/formula/typed-value protections survive shared-helper changes | cross-product regressions | ADJACENT/SHEETS_BASELINE | S14 before reuse; S15 rerun | C completed baseline; P |
| C176 | Existing Office binary/convert upload, saved-preview requirement, fail-closed XLSX opaque/embedded-package checks and shared adapters/ooxml-media.mjs preserved | existing upload/status | ADJACENT/UPLOAD_BASELINE | S12 before reuse; S15 rerun | C preserved upload baseline plus delivered S00 baseline;  P, keep applied-code evidence distinct from Git state |
| C177 | CLI JSON/verbose/plain, stdin/files, terminal colours/confirmation mapped to native tool results/artifacts/review, not external executable | BB family adapters | TRANSPORT/CLI | S15 | G CLI; M server export files; X transport/N user workflows |
| C178 | MCP tools/resources/read URIs and argparse-derived MCP server excluded; same user capabilities native BB | native tool inventory | TRANSPORT/MCP | S15 | M MCP; G mcp/resources; X |
| C179 | Auth/config/account switching/command allowlist reuse BB verified account/settings/tool configuration; pin subject per operation | BB config + authority | TRANSPORT/AUTH_CONFIG | S03/S15 | G auth/config/account/allowlist; C; R/N |
| C180 | CLI self-update/install and editor sync/pull hooks excluded; normal repository/BB lifecycle, explicit working-copy actions | BB lifecycle/docs | TRANSPORT/UPDATER_HOOKS | S15 | G update/_sync-hook/_pull-hook; E4 sync; X |
| C181 | Active editor cursor/selection/select range/move cursor/containment unavailable in server REST; semantic selection replaces intent, not editor UI | capability/refusal | TRANSPORT/EDITOR_SELECTION | S09 | E6/A; B/X |
| C182 | Apps Script fluent runtime/detached element objects not executed remotely; typed fragments compile equivalent supported semantics | shared fragments/compiler | TRANSPORT/APPS_SCRIPT | S04 | A/E5/E6/E7/E8; X runtime/N supported semantics |
| C183 | Library credentials/OAuth pickles/debug raw API dumps/process exits excluded; BB auth and bounded errors | adapters/diagnostics | TRANSPORT/UNSAFE_WRAPPERS | S03 | P/T/G; C; X |
| C184 | Force/quiet/raw indices/raw field masks/public batch endpoints excluded; exact selectors/effects/loss policies instead | all schemas | TRANSPORT/BYPASS | S03/S15 | M force/G quiet/force/structure; X |
| C185 | Retry 429/5xx/network or repair/restore whole-file writes excluded even when reference implements them | transport/executor | EXEC/NO_RETRY | S03 | M 429; E1 5xx; M repair; C single-attempt; P/X |

## J. Safety, legacy data, execution, testing and delivery obligations

| ID | Capability and exact acceptance intent | Proposed API / operation | Feature/scenario | Slice | Evidence; disposition |
|---|---|---|---|---|---|
| C186 | Formatting readback 403 after acknowledged mutation retains attempted/ack/claim; reproduce before fix | legacy formatting service | EXEC/FORMAT403 | S00 | C static defect, contrasted image guard; P/N |
| C187 | K5 bounded local epoch/intent/dispatch linearization with policy/claim/storage barriers; remote-only revocation may produce submitted rejection, not guaranteed zero POST | every writer beforeSubmission | EXEC/FINAL_GATE | S00/S03/S15 | C image gate and format/replacement gap; P/N |
| C188 | Explicit subject/account pinning, grant versus document permission, refresh races, no scope expansion | authority ports | EXEC/AUTHORITY | S03 | G account; C auth/transport; P |
| C189 | Native content/index CAS uses own-subject revision; K7 reviewed ID/no-CAS collaboration route explicitly separate; no targetRevision/rebase or stale rebuild | compiler/executor | EXEC/CAS | S03 | O; M/E1/C; P/N |
| C190 | Server-issued draft key/requestId recovery; immutable tombstones, duplicate/conflict rules and transactional collision checks across all retained namespaces | journal/apply | EXEC/KEYS | S03 | C format/image; replacement gap; N/P |
| C191 | Cross-account document claims, old/new family contention and relevant sharing/move/create/access conflicts | SQLite claims | EXEC/CLAIMS | S03 | C legacy interlocks/access claims; N/P |
| C192 | K4 submission not_sent/unknown/rejected/acknowledged separate from verification, immutable save facts and current-call mutation count; partial claims retained | executor/status | EXEC/STAGES | S03 | M/P/T multi-call; C; N/P |
| C193 | Matching unacknowledged observation not causal success; no automatic continuation/retry/rollback/unlock | operation status | EXEC/RECOVERY | S03 | C strong image semantics; N/P |
| C194 | Independent verifier proves expected changes and all footprint preservation, not compiler-generated expected output | verifier/fixtures | EXEC/INDEPENDENCE | S03 | C tests gaps; scout recommendations; N |
| C195 | Rich unrelated opaque structures remain editable around; intersecting unsupported footprints fail precisely | preservation model | EXEC/PRESERVATION | S02/S04 | M/G/O; C global restrictions replaced; N |
| C196 | K6 namespace-disambiguated legacy lookup/recoveryHandle; missing-kind/hash-only/shared-v1/page/image evidence preserved without invented ack or first-match lookup | legacy recovery dispatch | LEGACY/VERSIONS | S03/S15 | C stores/tests; P |
| C197 | Legacy uncertain/writing/reviewing/verified/corrupt/unknown records survive; unresolved locks fail closed | store/claim upgrade fixtures | LEGACY/STATES | S03/S15 | C; P |
| C198 | Remove old authoring names/RPC inventories/skills without aliases; old receipt lookup and pending-card history remain | tool cutover/status | LEGACY/TOOL_CUTOVER | S15 | C fourteen old Docs tools; user direction; N/P |
| C199 | Pending old approvals cannot execute expanded operations; drain/cancel, never translate consent | native interaction lifecycle | LEGACY/PENDING_CARDS | S15 | C deferred interactions; P |
| C200 | K1 existing requireDocsApproval for all requested native direct edits including destructive; exact standing/owner distinction, suggest/collaboration/file policies and mixed-effect union | review/apply | APPROVAL/POLICY | S03/S15 | C; N/P |
| C201 | Destructive/shared audience/notification/non-CAS effects and full content shown; no truncation-approved plan | semantic review | APPROVAL/EFFECTS | S10/S11/S15 | C UX; O semantics; N |
| C202 | Actual BB deferred completion after idle; stop/delete/reload distinct, no new approval on submission error | native host/renderer | APPROVAL/LIFECYCLE | S15 | C lifecycle tests; N/P |
| C203 | Bounded proposal/snapshot/requests/stages/receipts/assets; reject before mutation, preserve unresolved history at capacity | budgets/journal | EXEC/BOUNDS | S02/S03/S09 | C existing divergent limits; N/P |
| C204 | Privacy-safe bounded category/stage diagnostics; synthetic secrets in errors/causes/codes/bodies never leak | safe logger | EXEC/DIAGNOSTICS | S00/S03/S15 | repository o11y standards; C; P |
| C205 | Real application/compiler/verifier + real Google HTTP adapter + actual disposable SQLite; no fake semantic success | Cucumber World | HARNESS/REAL_PATH | S00 minimal legacy seed; S01 expansion; S03/S04 real semantic activation | C existing host/OAuth harness; N |
| C206 | Closed Google/OAuth/Drive HTTP plus asset DNS/HTTPS stubs; unexpected network fail; no live writes | World transports | HARNESS/OFFLINE | S00 closed HTTP seed; S01 asset expansion | C asset uses separate transport; N |
| C207 | Independent fixture and simulator contract tests; no production helper generates expected requests/readback | contract fixtures | HARNESS/ORACLES | S01 | scouts compiler defect examples; N |
| C208 | S00 runner seed; S01 total mode-aware expansion, complete sibling/dependency exposure gate, R1–R4 negative fixtures, writable nested schema/mask checks; orphan/fixture/example checks and external evidence separate | package scripts/config + manifest audit | HARNESS/DISCOVERY | S00/S01/S16 | C pre-S00 OAuth-only discovery and delivered S00 seed; N for future generalized audit |
| C209 | Source/SSR not rendered evidence: desktop/narrow/keyboard/full state/no-op native reviews | rendered BB gate | DELIVERY/RENDERED | S15 | repository UX/testing skill; P/N |
| C210 | Supported local try retains ID/config/data; inspect actual source, no implicit source switch or release | delivery workflow | DELIVERY/LOCAL | S15 | repository delivery skill; P |
| C211 | Independent review and full ledger audit, adjacent regressions, scoped commit/push; no unrelated publication | final evidence report | DELIVERY/AUDIT | S16 | repository instructions; P/N |

## Explicit source-surface closure

This crosswalk is a check against omitting an upstream public entry point while consolidating semantics. It does not add compatibility aliases.

* **M**: `get_document` C001–C003/C019/C087; `get_outline` C004/C016; `read_document` C005–C011/C143; `find_in_document` C012–C015; `search_documents` C162–C164; `export_document` C137–C140; `edit_document` C022–C030/C077/C079/C101–C102; `format_document` C031–C042; `edit_table` C045–C069; `insert_object` C089–C096; `layout_document` C080–C086; `manage_tabs`/`delete_tab` C074–C076; `list_comments`/`add_comment`/`reply_comment`/`delete_comment` C107–C115; `list_suggestions`/`review_suggestion` C116–C123; `list_revisions`/`diff_revisions` C141–C145; `create_document` C124–C126/C146–C147; `write_markdown_file` C151–C153. Word-file dispatch C154–C158; MCP resources C178.
* **G**: `ls`/`find` C162–C164/C169; `info` C001/C165; `cat` C005/C010/C143/C172; `structure` C006/C184; `tabs`/`toc` C002/C004/C172; `add-tab` C074; `edit` C012–C015/C018/C023–C025/C069; `suggest` C117–C118/C120–C121; `nest`/`unnest` C039–C044; `write`/`insert` C022/C133/C150; `pull`/`push` C148–C150; `diff` C144–C145; `revisions`/`history` C141–C143; `comments`/`comment-info` C107; `comment` C108–C110; `reply`/`resolve`/`reopen`/`delete-comment` C111–C114; `images` C087–C088; `insert-image`/`replace-image` C089–C093; `export` C137–C140; `new` C124; `cp`/`rename`/`mkdir`/`mv`/`move`/`drives` C166–C169; `share` C170–C171; `cells` C173–C174; `auth`/`config`/`update`/`mcp`/`_sync-hook`/`_pull-hook` and global account/output/quiet/force/allowlist C177–C185/C188.
* **P/T**: GetTables/GetValues C045–C046; SetValues/SetValuesBy2DArray/SetValuesByObject C047–C049/C053–C056/C071; CreateTable/append/createIndex C051–C052; AppendRow C050; DeleteTable/DeleteRowsColumns C058–C060; ReplaceTextsToImages/ByURL/ByFile/TableOnly/SetImageSize C070/C089/C092–C093; optional API-response debugging/configuration C183. Their absent merge/style/tab/revision capabilities are covered as modern additions, not falsely attributed to them.
* **E1–E10**: semantic views/explicit anchors C001–C021/C101–C104; pure builder/style/list/Markdown/table composition C025–C043/C051/C130–C134; exporter/loss/assets C137–C140; named-range navigation vs editor selection C101–C104/C181; rich text/HTML/font fitting C129/C159–C161; template text/image/Sheets binding C126–C129; derived widths C072; Node table sibling C045–C071/C093. Apps Script/editor runtimes C181–C182 and unsafe retry/hosting patterns C093/C185 are explicitly excluded.

## Completion rules and remaining evidence boundaries

1. Before each slice, turn its rows into actual Gherkin plus independent Google request/response fixtures. A row is closed only with its enumerated operations/properties/formats and applicable failure variants, not one broad scenario bearing its tag.
2. Each row's API/schema registration, application implementation, compiler/adaptor contract, verifier, approval/evidence wording, docs and tests must agree. Provider limitations and engineering bounds appear in the capability response and guide, not merely in this planning ledger.
3. K10 and obligations.json define ledgerId/productOperation/semanticVariant/outcomeVariant joins to exact case IDs, schema/capability registrations, fixtures and current runner results. Repeated outline tags are valid; duplicate case IDs, both-direction orphans and missing Examples/fixtures fail. S01 negatives also reject success-only exposure, missing lostReply/finalAuthGate/dependencies, missing/mismatched modes, guard-as-success, duplicate-name refusal-as-support and invalid/output-only schema paths/masks. Planned future variants are not enabled passes; final completion cannot silently drop them. External gates require separate evidence.
4. For B/X rows, assert zero mutation and truthful alternative/routing. A named range is not a bookmark, a comment is not a suggestion, a paragraph border is not a horizontal-rule node, a conversion is not in-place Word parity, and a matched read after loss is not an acknowledgement.
5. Local engineering limits requiring expansion remain visible N work until implemented or explicitly accepted as a measured bound. In particular list preservation algorithms, image decoders/budgets, OOXML mapping, large-scope review and richer adjacent Sheets/Drive features cannot disappear under a generic “unsupported” label.
6. Offline acceptance demonstrates application and wire-contract behavior against independent evidence, not live rollout, visual Google rendering, image bytes Google fetched, notification delivery or full Office fidelity. Rendered BB review and safe applied-code verification are separate gates. No live business mutation, sharing/scope change, source switch or formal release is authorized by this ledger.
