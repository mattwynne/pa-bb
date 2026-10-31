# Google Docs semantic API rewrite

## Decision and scope

Build an original BB-native semantic document engine with thin, discoverable tool families. This is not an MCP server, an Apps Script bridge, a wrapper around the reference programs, or a public Google request proxy. Replace the old Docs authoring names after staged cutover; retain recovery interpretation of their durable records. The companion [capability ledger](capability-ledger.md) retains all 211 scope obligations, not a priority list. [semantic contracts](semantic-contracts.md) (K1–K11) supplies the normative schemas, effect-based consent, stage facts, composition examples and review-resolution crosswalk. [coverage manifest](../../../plugins/google-drive/features/docs/coverage/obligations.json) supplies the machine-readable variant/outcome joins; all entries are planned, not test results. Slices are dependency and review boundaries, not an MVP definition.


Use the official Docs discovery revision **20261026**, the method-specific get/batchUpdate contracts, and the current suggestions guide. They expose native tab, named-style, chip, dropdown, anchored-comment and suggestion writes. Schema evidence is not proof of availability for every account. Do not label these domains editor-only. Keep capability failures explicit without automatic downgrade, scope expansion, or speculative write probes.

### Non-negotiable decisions

1. One loss-aware semantic graph, fragment vocabulary, selector resolver, dependency planner, durable executor and independent verifier serve all families.
2. Explicit account, tab, segment and snapshot. Native Docs revision, Drive revision, Drive version, file digest and snapshot ID are distinct types.
3. Native content/index edits use this subject's `requiredRevisionId`, never `targetRevisionId`. Explicit ID-based author collaboration actions without editor revisions use K7's mandatory reviewed no-CAS route; file/Drive/Sheets comparison routes never claim Docs CAS. No write retries, including 429, expired-token POST replay, repair uploads or rollback writes. Read retries may be bounded.
4. Rich documents are supported compositionally. Unknown or unsupported material blocks only operations whose preservation requirements intersect it, not every operation in the document.
5. No hidden public image hosting, sharing, copy/recreation of existing documents, notifications described as suppressed when they are not, or silent format loss.
6. Every supported operation needs executable acceptance coverage through real application/domain/compiler/verifier and real Google adapters, with HTTP and asset networking stubbed. Real disposable SQLite is mandatory.
7. API evidence establishes bounded content/structure/style state, not visual layout, image bytes fetched by Google, delivery of notifications, or recipient access.

## 1. Public surface

### Common envelope and lifecycle

Every family planning tool takes explicit `account`, a `draft` discriminator and typed commands. `draft:{kind:"new",requestId,destination,sources?,mode}` creates a server-issued UUIDv4 operation key; `draft:{kind:"extend",draftId,expectedDraftHash}` extends an unsealed immutable draft head. K2 defines exact shapes and short workflows. Identical subject/thread/requestId replays return the saved draft, not another key. Planning is read-only at Google and holds no exclusive execution claims. A proposal contains the logical plan hash, exact affected scopes, before/after effects, required authority, capability versions, loss/notification/access manifests, constrained stage bindings, expiry and verification obligations. No argument disables approval or enables force/rebase/raw HTTP.

`docs_apply({account,operationId,planHash})` atomically seals the current draft head, acquires execution claims and executes only that proposal under K1 policy. It cannot accept new content/targets/revisions. Repeated calls return its receipt, never restart. `docs_draft_status({account,requestId}|{account,draftId})` recovers interrupted planning; `docs_draft_cancel` cancels only an unsealed draft. `docs_operation_status({account,operationId,receiptKind?}|{account,recoveryHandle})` disambiguates legacy namespaces before read-only recovery (K6). Expiry or changed intent permits a new draft only after conclusively never-submitted work; it never permits a replacement key for unresolved work.

Family planning schemas contain small typed command sets, not a giant public request union. Heterogeneous document content belongs in the shared fragment schema. Internal plans may compose every domain.

| New tool | Contract |
|---|---|
| `docs_inspect` | Metadata/kind; capabilities with evidence; recursive tab/segment tree; outline, objects, lists, ranges, named styles, dropdowns and coverage summaries. Returns a snapshot; metadata-only output is not content coverage. Optional bounded diagnostic structural projection has no editable raw indices. |
| `docs_read` | Page through structured, text, Markdown or HTML projections of explicit scopes from one snapshot; annotations and loss manifest; exact cursor/coverage provenance. Current inline-suggestions view is the only editable view. |
| `docs_find` | Literal or bounded RE2-compatible search, heading/section queries and semantic table-label/header queries against a snapshot; candidates, match counts, context and handles. Search is not complete-read proof. |
| `docs_plan_content` | Insert, append, prepend, replace, delete, scoped replace-all, copy/move supported fragments, page break; typed inline versus block payloads. |
| `docs_plan_style` | Inline, paragraph, named-style, page and structural-section patches; apply heading type; explicit reset/clear sets; link targets. |
| `docs_plan_list` | Create bullet/number/checklist, continue, remove, nest/unnest with descendants and preservation requirements. |
| `docs_plan_table` | Create/populate, ragged/offset patches, label/header filling, rich cell content, explicit growth, row/column splice/delete, merge/unmerge, styles/layout/header pinning. |
| `docs_plan_structure` | Tabs and hierarchy; section breaks; header/footer creation/deletion and footnote creation with fragments. |
| `docs_plan_media` | Public image insertion/replacement/removal; image-placeholder binding; person/resource/date chips; dropdown definition and instance lifecycle. |
| `docs_plan_anchor` | Explicit named-range create/delete/fill; inspect existing bookmarks and build links through style/content tools, not fake bookmark creation. |
| `docs_discussions` | Read/list exact comment or suggestion threads, including resolved/deleted evidence and posts; no mutations. |
| `docs_plan_discussion` | Anchored or explicitly document-wide comment; reply/edit/delete post, delete thread, resolve/reopen and supported assignment/reassignment. |
| `docs_suggestions` | List/read pending text, structure and formatting suggestions with exact IDs and view provenance. |
| `docs_plan_suggestion` | Accept/reject/discard exact inspected suggestions. Suggestion creation is `mode:"suggest"` on eligible authoring plans. |
| `docs_plan_create` | Native creation in root or explicitly chosen existing destination, initial rich fragment/tab tree/page mode; or copy-and-fill template instance. Does not overwrite existing files. |
| `docs_plan_template` | Bind typed values to explicit placeholder/range/image targets in an existing snapshot; optional Sheets read source, frozen values and provenance. |
| `docs_plan_import` | Explicit Markdown/HTML fragment import or supported native Drive conversion to a new Doc. Select existing-tab replacement separately from whole-document tab collapse. |
| `docs_export` | Semantic selected-scope export or Google whole-file converter export to new thread artifacts, with fidelity/asset manifest. No arbitrary output path or overwrite. |
| `docs_history` | Retained Drive revision list/read/diff, time/relative selectors, current-vs-artifact diff; historical output cannot authorize current writes. |
| `docs_working_copy` | Checkout/read/compare Markdown or Word file workflows; local artifact and source provenance, conflict report. No implicit remote mutation. |
| `docs_plan_file_write` | Explicit bounded Markdown or OOXML whole-file update/writeback, distinct concurrency contract and mandatory review; can create a new file instead when requested. |
| `docs_plan_combine` | Combine unsealed owned draft heads against the same destination snapshot/mode; preserve each resolved original-snapshot target rather than reinterpreting coordinates. Atomically supersede inputs and reserve a new key. Cross-family generated references use draft extension; K2 examples settle this distinction. |
| `docs_draft_status`, `docs_draft_cancel` | Same-request planning recovery and no-write cancellation; keep key tombstones and ownership. No execution claim is acquired by a draft. |
| `docs_apply`, `docs_operation_status` | Shared sealing/execution/recovery. Status searches all eligible legacy namespaces and returns recovery-handle candidates on ambiguity, never first-match dispatch. |
| `docs_review_example` | Fixed synthetic no-op review states for rendered/native lifecycle checks. All choices cause zero Google/asset traffic. |

Drive discovery, metadata, sharing, moving, copying and upload remain Drive tools. Sheets remains Sheets. The ledger specifies additive adjacent capabilities rather than duplicating them under Docs. BB's existing account Settings and access diagnostic remain the auth interface; no OAuth secrets in tools.

### Concrete examples

Identifiers and content below are synthetic. K2 provides the normative family envelope and complete generated-reference/combine/cross-document examples. Hashes below are abbreviated for readability, not accepted hash syntax.

```json
{"tool":"docs_inspect","account":"writer@example.test","document":"docA","scope":{"tabs":["tabA"],"segments":[{"kind":"body"}]},"include":["outline","tables","styles","review"]}
```

```json
{"snapshotId":"snap1","revision":{"kind":"docs","id":"r1"},"view":"inline","coverage":{"materialized":"complete","delivered":"summary","scope":{"tabs":["tabA"]},"aspects":["content","styles","review"],"unknownNodes":1},"outline":[{"headingId":"h1","node":"n4","title":"Terms","level":2}],"capabilities":{"nativeSuggestions":{"schema":"supported","account":"unverified"}},"next":"Plan with an exact target witness; read broad affected scope only when the complete preview cannot supply it."}
```

```json
{"tool":"docs_read","account":"writer@example.test","snapshotId":"snap1","scope":{"tabId":"tabA","segment":{"kind":"body"},"section":{"headingId":"h1","includeHeading":false}},"format":"structured"}
```

```json
{"snapshotId":"snap1","nodes":[{"id":"n5","kind":"paragraph","inlines":[{"kind":"text","text":"Old terms","style":{"bold":true}}]}],"coverage":{"complete":true,"editReady":true,"scopeToken":"cov1"},"nextCursor":null,"losses":[]}
```

```json
{"tool":"docs_plan_content","account":"writer@example.test","draft":{"kind":"new","requestId":"terms-replacement-1","destination":{"snapshotId":"snap1"},"mode":"direct"},"commands":[{"op":"replace","target":{"tabId":"tabA","segment":{"kind":"body"},"text":{"literal":"Old terms","normalization":"exact","cardinality":{"exactly":1},"within":{"node":"n5"}}},"content":{"kind":"text","text":"New terms"},"stylePolicy":"preserveUnchangedInheritStart"}]}
```

```json
{"draftId":"draft1","operationId":"a1111111-1111-4111-8111-111111111111","state":"draft","draftHash":"sha256:example","stages":[{"id":"s1","kind":"docsBatch","atomicContent":true,"requiresRevision":"r1"}],"effects":[{"kind":"textReplacement","before":"Old terms","after":"New terms","scope":"Terms / paragraph 1"}],"approval":{"required":true},"thisCall":{"providerMutationCount":0}}
```

```json
{"tool":"docs_apply","account":"writer@example.test","operationId":"a1111111-1111-4111-8111-111111111111","planHash":"sha256:example"}
```

```json
{"status":"verified","operationId":"a1111111-1111-4111-8111-111111111111","thisCall":{"providerMutationCount":1},"stages":[{"id":"s1","submission":"acknowledged","verification":"matched","revision":"r2"}],"evidence":["Requested text and preservation obligations matched at acknowledged revision r2"],"limitations":["Visual rendering not verified"],"retrySafe":false}
```

Rich payloads are explicit, never guessed from punctuation:

```json
{"kind":"blocks","blocks":[{"kind":"heading","level":2,"inlines":[{"kind":"text","text":"Decision"}]},{"kind":"paragraph","inlines":[{"kind":"text","text":"Approved","style":{"bold":true}},{"kind":"text","text":" on "},{"kind":"date","value":{"kind":"civil","date":"2026-11-02","timeZone":"America/Vancouver"},"dateFormat":"iso","timeFormat":"none","locale":"en-CA"}]},{"kind":"table","columns":2,"rows":[[{"kind":"blocks","blocks":[{"kind":"paragraph","inlines":[{"kind":"text","text":"Owner"}]}]},{"kind":"blocks","blocks":[{"kind":"paragraph","inlines":[{"kind":"person","email":"reviewer@example.test"}]}]}]]}]}
```

Table and collaboration examples:

```json
{"tool":"docs_plan_table","account":"writer@example.test","draft":{"kind":"new","requestId":"table-patch-1","destination":{"snapshotId":"snap2"},"mode":"direct"},"commands":[{"op":"patchText","table":{"node":"table3"},"blocks":[{"start":{"row":2,"column":1},"values":[["A",""],["B"]]}],"growth":"appendToFit"},{"op":"pinHeaders","table":{"node":"table3"},"count":1}]}
```

```json
{"tool":"docs_plan_discussion","account":"writer@example.test","draft":{"kind":"new","requestId":"assigned-comment-1","destination":{"snapshotId":"snap2"},"mode":"direct"},"commands":[{"op":"add","anchor":{"node":"n8"},"content":"Please review this paragraph.","assignTo":"reviewer@example.test"}]}
```

```json
{"status":"partial","model":{"submission":"acknowledged","verification":"matched"},"discussion":{"saveState":"ALL_FAILED_UNKNOWN_REASON","verification":"not_saved"},"unattemptedStages":["s2"],"claim":"retained","retrySafe":false,"nextAction":"docs_operation_status with the same account and operationId"}
```

## 2. Document, fragment, selector and coverage contracts

### Semantic document

An immutable snapshot contains stable account subject, canonical document ID/kind, provider revision namespace, retrieval time, view, ordered recursive tabs and their bodies/headers/footers/footnotes. Blocks include paragraphs/headings, tables, structural section breaks, TOC and opaque blocks. Inlines include exact text runs, links, images, footnote references, person/resource/date/dropdown chips, breaks, auto-text/equations and opaque elements. Lists, named styles, objects, bookmarks, named ranges, comments and suggestions are typed registries/relationships. Tables contain rich cell blocks and a logical span-aware grid, not strings masquerading as a document.

Retain a bounded provider-evidence tree and unknown fields for preservation verification. Unknown nodes retain type, extent, parent, relevant IDs and digest; they are never textual `[TABLE]`/`[IMAGE]` contents. Text/Markdown/HTML are projections with losses. Structured read is loss-aware, not a promise to re-create every opaque element.

Styles distinguish explicit values, absent/inherited values and effective values with provenance (`direct`, `named`, `section/default`, `unknown`). Do not invent effective defaults. Stored versus effective page properties differ in pageless mode.

### Coordinates and selectors: settled conventions

* Public row, column, tab ordinal, occurrence and nesting level are **zero-based**. Prefer IDs/handles; ordinals are snapshot-bound convenience selectors. A list's top level is 0. Grid ranges use `start` plus positive `rowCount`/`columnCount`, never ambiguous inclusive ends. A1 and `r2c3` strings are not alternate coordinate APIs.
* Public text selectors use semantic targets, not offsets. Returned source diagnostics may expose half-open UTF-16 coordinates, but cannot be submitted as write targets. Internal ranges are `(tabId, segmentId, startInclusive, endExclusive)` UTF-16 code units. No cross-segment numeric arithmetic, surrogate splitting or implicit first/all-tab default.
* One primary selector: node; inclusive node span; heading ID or exact heading path; heading-section (through next peer/higher heading); text within scope; table/cell/header/label; object ID; named-range ID/name with cardinality. A heading-section differs from a native layout section. `includeHeading` is explicit for section replacement.
* `exact` matching is byte-preserving Unicode text matching after valid scalar decoding; default case-sensitive and no typography folding. Optional `typographic` normalization maps smart quotes, specified dash variants and Unicode space runs to documented equivalents, with an invertible source-range map; it does not silently NFC-normalize or remove accents. Optional NFC and Unicode simple case-fold are separately named policies. Many normalized characters mapping to one boundary cannot authorize a partial match inside that boundary.
* Default cardinality is exactly one. `occurrence:0` selects the first only when explicitly requested; `all` requires an expected exact count at planning and review. Missing/ambiguous results return candidates. Regex uses an audited linear-time RE2-compatible implementation, no backreferences/lookbehind, no zero-width matches; replacements use explicit capture references. No JavaScript unbounded regex against provider text.
* Text search crosses adjacent styled runs but stops at paragraph and non-text object boundaries. Multiline changes use explicit block/section selectors. Objects never become their display label for matching.
* Handles are snapshot-scoped and expire with their snapshot. Provider IDs are only as persistent as documented. Tables have no native stable table ID. Re-read does not let an old ordinal silently select a different table.
* Within one ordered draft, newly resolved coordinates use its evolving state; `node` retains original logical identity and `as`/typed `ref` targets generated results. Across independently resolved drafts, combine preserves each original-snapshot target: inserting before original row 1 moves B's original row 2 target to resulting row 3, never to the new row 2. Deleted/ambiguously merged targets or incompatible overlapping effects reject combine. K2 contains the grammar and exact examples.

### Fragment and style semantics

`Text` is literal Unicode with LF paragraph breaks only when the operation accepts blocks; inline text cannot contain LF. Reject invalid Unicode and provider-stripped controls/private-use characters before writing, rather than claiming exact preservation after normalization. `InlineFragment` is ordered typed inlines; `BlockFragment` is ordered paragraphs/headings/list trees/tables/breaks. Empty text is a deliberate text clear, not unspecified input. Omitted matrix cells remain untouched; numbers/booleans must be explicitly converted to text, never language-dependent coercion.

A plain text replacement preserves unchanged runs using a minimal-difference mapping; new text inherits explicit style at the first replaced character (`preserveUnchangedInheritStart`), or caller selects `inheritContext`/`resetToNamedStyle`. The preview reports which policy is used. Rich-fragment styles are explicit patches over the fragment's declared base; no accidental blending with deleted mixed styles. Block insertion declares paragraph base/named type; leading/trailing paragraph merges must be modeled and disclosed. A whole-cell/section replacement is different from a text-span edit.

Style patches have `set` and `reset` lists. Omission means no change; reset means remove only named overrides to restore inheritance, not assign an invented default. Set/reset overlap fails. `clearFormatting` expands a documented bounded set of inline or paragraph overrides; it does not clear lists, links, named style definitions or paragraph semantics unless separately requested. Compiler emits precise masks, never `*`. Named-style definition changes affect inheritors throughout the tab; review includes usage and explicit overrides. Unit dimensions are points; colours use explicit opaque sRGB or a typed transparent value only where Google permits it.

### Coverage and revision

Account is resolved once to a verified subject and pinned across every stage; source bindings pin their own subjects. Email changes never transfer receipts. Cursors, snapshots, drafts, approval and recovery have distinct lifetimes in K2: five-minute cursors, ten-minute new-plan snapshots, thirty-minute unsealed drafts, ten-minute approval capped by draft deadline, durable recovery without uncertainty TTL. Cursor expiry does not erase draft-pinned evidence. `witnessSatisfied` and `editReady` are scope/aspect-specific, not document-wide.

A bounded provider read can materialize more than it delivers. Complete internal footprint/dependency evidence is mandatory. K3 permits an exact narrow preimage plus complete effect preview without redundant section reads; metadata can locate a non-destructive style/insertion target when internal evidence proves its footprint. Broad cell/section/tab replacement requires complete affected contents delivered by read OR complete plan preview, not both. Generated approved nodes need verified internal stage reads, not fresh agent ceremony. Continuations enumerate exact delivered scopes; historical exports and accepted/rejected-suggestion views never authorize current writes.

For comments use `includeTabsContent=true`, `suggestionsViewMode=SUGGESTIONS_INLINE`, `commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`. If access to comments is denied, expose a content-only snapshot with missing review coverage only after a separate read; do not represent it as full evidence. Non-destructive disjoint style edits can proceed if their preservation proof does not require missing review data. Deletion, move, replacement or anchor-changing transforms require review evidence for their affected footprint. Suggestions overlapping an edit are represented and handled by a supported transformation or precisely refused, never globally discarded.

Native content/index writes require a current revision from this subject's editor-access snapshot. Google does not populate revisionId for non-editors. K7 separately enables exact witnessed ID-based author collaboration actions without CAS under mandatory review; this is never a fallback for range/index authoring or borrowed revisions. Drive retained revisions remain history; file versions/checksums are comparisons, not CAS.

## 3. Domain behavior and provider boundaries

### Tables and lists

A table's logical coordinate maps to one physical cell with origin/span and rich child blocks. Covered coordinates are aliases, not empty cells. Mutations require the physical origin or an explicit complete span; two writes through aliases conflict even when values agree. Label-to-adjacent-cell filling requires a unique label, table and direction/column; header-based selection requires unique headers.

`patchText` replaces text-only cell content and refuses selected cells with non-text material unless a precise text selector is supplied. `replaceCellFragment` explicitly replaces all cell contents and previews nested objects/tables/anchors removed. Ragged/offset blocks preserve unspecified cells; duplicate physical targets fail. `growth:"reject"` is default; `appendToFit` previews exact trailing rows/columns. Creation dimensions must contain supplied data; never truncate silently.

New tables use create → inspect actual structure → populate/style by default. This avoids relying on undocumented empty-grid formulae; optimization to a one-batch empty-table compiler is allowed only after independent contract evidence and equivalent verification, not needed for completeness. Each native batch is atomic for ordinary model changes, but the semantic task is not. Structural mutations invalidate coordinates; resolve subsequent stages using acknowledged revision, exact anchors and fresh structure, never “last table”.

Merge uses native requests and the actual physical footprint. Nonrectangular footprints fail. Review shows LTR upper-left/RTL upper-right head, concatenation, cell identity loss and affected review anchors. Unmerge leaves content in that head; it is not undo. Delete through merged anchors must either exactly implement the requested axis footprint or refuse; never broaden a one-row request silently. Removing the whole axis is explicit table deletion. Border review includes the neighboring shared edge; invisible merged borders are not promised changed. Column minimum is 5pt; row minimum height is not exact rendered height; pinning headers is separate from bolding.

List trees retain list ID, nesting, numbering/restart evidence, glyph/marker styles and adjacency. Nest/unnest includes descendants, validates parent depth 0–8 and transforms leading tabs consumed by bullet creation. Preserve native list identity and unaffected numbering. Default-preset preserving algorithms ship first within the list slice; custom marker/indent, table-contained items and joined lists must either receive a verified preserving algorithm in the expansion part of that slice or an exact engineering-limit result. Do not substitute indentation-only formatting or rebuild custom numbering while claiming preservation. Arbitrary restart/glyph setters unavailable in REST are provider-limited, not unimplemented API promises.

### Structure, layout, anchors and composition

Tabs support add, title/icon, order, parent/nesting, initial fragment and exact subtree deletion. Deleting a parent includes descendants; sole-tab/provider restrictions are validated from current contracts. All requests carry explicit tab scope, including bulk operations whose provider default is all tabs.

Header/footer creation currently supports `DEFAULT` only. Existing first/even-page segments can be read and edited where provided; do not fabricate creation types. Section/global ownership and inherited links are explicit. Create/populate is staged using returned IDs. Footnotes also require returned segment IDs; body references cannot be created inside equations, headers, footers or other footnotes. Tables and inline images cannot be inserted in footnotes/equations. Native section breaks are body-only outside tables/segments; continuous/next-page type is chosen on insertion, not promised as in-place type conversion. Sections have at most three columns; stored column width may be output-only. Page-number start is not page-number-field creation. Page size binds to DocumentStyle.pageSize, with width/height Dimension magnitude/unit and mask pageSize, never documentSize. The contract auditor validates nested schema paths, writable fields/enums and masks, including output-only refusals; request-name existence is insufficient.

Named ranges are explicit persistent writes, visible to collaborators. Names can repeat and ranges can split. C101 separately requires successful duplicate-name creation (two distinct IDs sharing the same name), exact-ID selection among duplicates, explicit-all expected-count handling, and refusal only for ambiguous name-only selection. Positive direct-mode duplicate behavior cannot be closed by refusal or a unique-name control; create/delete remain suggest-excluded. Default fill requires one contiguous ID; `replaceDiscontiguous` is a distinct operation whose preview shows first-span insertion and removal of later spans. An explicit per-span fill is compiled as separate edits, not misrepresented as native replaceNamedRangeContent. Deleting an anchor removes the label, not its content. Existing bookmark links work; real bookmark creation/deletion has no supported REST request here. A named range is not an equivalent bookmark.

Copy/move supported fragments preserves mapped styles, lists, links and objects only when reconstruction is supported. Cross-document copy uses complete source/destination snapshots and explicit asset/reference mapping. Same-document move can be a single exact batch when all nodes are supported; if it requires multiple calls, write and verify destination before deleting source, with explicit partial duplicate risk. Do not offer cross-document move as atomic. Unknown nodes, comments/threads whose native identity cannot be copied, equations or drawings yield a loss report and refusal under default `lossPolicy:"reject"`; the user may choose an explicitly lossy copy, never an allegedly native clone. Whole-file copy remains Drive.

### Media and chips

The target image surface includes PNG/JPEG/GIF insertion via already-public HTTPS and native replacement with the sole supported `CENTER_CROP` method, which scales/crops to existing bounds and can remove effects. A contain/resize alternative is separately named `reinsertImage`, with new identity and anchor/effect losses disclosed; it is not another replacement enum. Also include placeholder insertion across runs, inventory/download and deletion of existing inline/positioned objects. Expand the present PNG validator in an isolated media-security slice: signatures, bounded decode/dimensions, decompression limits, no executable payload, GIF frame accounting and rejection of animated GIFs (no implicit conversion or first-frame rendering claim). Keep DNS pinning/private-address/credential/redirect protections; no permissive fetch fallback. New JPEG/GIF support is engineering work, not a reason to declare Google's formats unsupported.

Initial local security budget remains 2 MiB/4 MP per inspected asset; expansion to 10 MiB/16 MP follows memory/fault tests in the same program, still below Google's <50 MB/25 MP and URI limit of 2 KB. Queries or redirects are not enabled merely by format expansion. Image URL/digest can change between review and Google fetch: re-fetch and compare just before submission, disclose the remaining remote race. Verify object/source URI/dimensions and preservation, not image bytes/rendering. Private artifact insertion cannot silently upload/share/host; return the source requirement and explicit alternatives. A separately requested file conversion may embed media but is not equivalent to in-place native image insertion.

Person/resource/date chips are typed inlines, not formatted text. K9 specifies civil-date→local-midnight→UTC conversion, explicit timezone/locale/date/time formats and output-only exclusions; a civil date never defaults to UTC. Validate their specific allowed segments from the request contract (date end-of-segment support differs from rich-link support); never infer every chip works in every segment. Chip display text can differ from one-unit model space. Dropdown definitions are tab-bound, option identities persistent; updates send the full desired options when required. Deleting selected options requires an exact replacement map for affected instances; deleting an in-use definition refuses. Definition creation precedes instance insertion when an ID must be returned. Instance selection changes are native operations; deletion removes the exact inline node.

Positioned image insertion/movement/general property resize, alt title/description setters, drawings/charts editing, native TOC/equation/horizontal-rule generation and automatic page fields are not exposed by supported REST requests in the evidence. Read/preserve them. Explicit manually linked outlines or paragraph borders are different products and named accordingly.

### Modes, comments and suggestions

Authoring plans use exactly one mode: `direct`, `suggest`, or `commentProposal`. `suggest` compiles to `writeControl.writeMode:SUGGEST`; direct to `EDIT`. `commentProposal` creates explicit anchored prose proposals with no content changes, bounded to one comment per requested target and the comment byte limit; it is not a tracked change. No automatic mode fallback.

The capability registry is request- and field-level, derived from pinned schema plus guide constraints and independent fixtures. SUGGEST rejects: `addDocumentTab`, `createNamedRange`, `deleteFooter`, `deleteHeader`, `deleteNamedRange`, `deleteTab`, `updateDocumentTabProperties`, `updateTableColumnProperties`; also `updateDocumentStyle.documentFormat`, `useEvenPageHeaderFooter`, `useFirstPageHeaderFooter`. Other eligible text/style/list/table/section/image/chip/dropdown requests are targets for suggest-mode contracts, not blanket exclusions. Creation/Drive file changes, suggestion decisions and discussion actions are separate direct domains; no mixed-mode batch. Unknown mode support fails before dispatch until the registry has contract evidence. Provider capability denial never triggers a direct write or an authorization scope request.

Native anchored comments require a real inspected range. Explicit document-wide comments use the Drive comments adapter with no counterfeit range; receipts identify the backend and weaker/no document-CAS semantics. Quoted metadata is available only as an explicitly selected document-wide comment field, never fallback from anchoring. A stale/unavailable range produces no alternative write.

Docs comment text and post content are plain text, nonempty except resolve/reopen action posts, at most 2048 UTF-8 units. Post editing/deletion is author-constrained; suggestion head posts cannot be edited. Replies containing actions or assignees cannot be deleted through deleteCommentReply. Assignment at creation is distinct from reassignment: `Post.assigneeEmail` requires an already assigned comment thread and cannot combine with resolve/reopen or target a suggestion thread. Accept requires edit access; reject requires editor or author; discard/delete requires author. Use exact observed thread/post/suggestion IDs and before witnesses. K7 defines editor-CAS and explicitly reviewed non-editor author ID/no-CAS routes, including permission restrictions, races and required save evidence; absence of an editor revision is not mislabeled a Google capability ban.

Comments, assignments and suggestion replies can trigger editor-like notifications. There is no general silent-notification switch in the inspected Docs requests. Preview names intended assignee/mentions and states possible notifications; no promise of complete recipient enumeration or delivery. Explicit notification intent is required, and these consequential collaboration writes always receive owner review, independently of the existing content-format approval opt-out. This is a new collaboration policy, not a change to Sheets/sharing/upload settings.

For collaboration writes, HTTP success and ordinary model atomicity are insufficient. Persist `commentUpdateState`, per-request replies and `suggestionResponses` IDs. `ALL_SAVED` plus appropriate exact thread/model readback can verify; `ALL_FAILED_UNKNOWN_REASON` means threads failed while model changes may have committed. Absent/unspecified state, or `NO_UPDATES_REQUESTED` when threads were expected, is uncertain, never success. Report model and discussion facts separately, retain claims on unresolved effects, stop subsequent stages, and never repeat the batch. A later metadata failure cannot erase already verified content/thread evidence.

### Creation, templates, codecs, history and file workflows

Native create/copy → populate → follow-ups are durable independent stages, with destination access and partial-content exposure reviewed before the first write. Root is default only for new file creation, not an inferred folder. Preserve IDs; existing edits never become copies. Use existing access claims/markers with a new semantic-operation namespace where needed; do not alter historical markers.

Template bindings are literal by default with explicit scope, `exactly:n` cardinality and missing/unused binding errors. Value types are text, inline/block fragment, image source or an existing image-object replacement. Style policy is retain-template, use-value or explicit patch. Optional Sheets reads supply frozen display values/style runs with a source fingerprint; no formulas execute in the Docs planner and no continuing link is implied. Copy-and-fill is an explicit creation operation, not a hidden convenience.

Codecs: CommonMark plus GFM tables/strikethrough/task syntax, fenced code, nested ordered/unordered lists, explicit footnotes and inline images through the shared model. Task syntax maps to a supported native checklist preset where possible; unsupported checked-state behavior is reported, not simulated as text without disclosure. HTML uses an allowlisted structural parser with no scripts/stylesheets/network loads, explicit CSS subset and source-location losses. Raw HTML in Markdown is rejected unless the HTML codec is explicitly selected. Links are data, not fetch instructions. Default loss policy is reject; `allowListedLosses:[ids]` binds exact transformations, not broad force. Whole-document multi-tab collapse is a distinct destructive plan listing every removed tab; selected-tab replacement preserves siblings.

K8 defines closed semantic/threadArtifact/driveBlob/nativeSnapshot source and artifact/new-native/new-blob/same-ID-blob result unions, authority/digest binding and route-specific consent. Local artifact conversion always retains the existing saved upload preview, exact source/digest/mode/destination and mandatory owner review, even in private root. Native Drive conversion supports requested Word/ODT/HTML/RTF/text/Markdown formats subject to `about.importFormats`, existing grants and bounded validation. Existing modern Office upload stays its own explicit flow; extend formats with adapter/security tests, never relax it incidentally. Export offers Google PDF/DOCX/ODT/RTF/EPUB/text/HTML/Markdown and separate semantic scope export. Google export is whole-file/all-tabs as supported, capped by its 10 MB limit; no promise of selected-tab rendered export. Every export carries source revision/time, scope, omissions, asset manifest and fidelity limits. Safe image downloads require authorized provider content URLs or validated public assets, write new thread artifacts only, and never make them public.

History lists retained Drive milestones with pagination and missing/pruned outcomes; exact/latest/previous/position/time selectors are resolved against that list, not numeric revision arithmetic. Diffs offer word/block/context and structured/text/HTML artifacts with review annotations. Historical working copies are marked nonpushable. They do not reconstruct full editor version history.

Working-copy sidecars record source ID/kind/tab scope/Docs revision or blob checksum, base fragment and loss manifest. Markdown checkout preserves frontmatter and unchanged source blocks; three-way writeback stops on overlapping changes and produces a conflict artifact, never `force` or repair uploads. New Markdown file creation and Markdown-file-to-native working Doc are explicit operations. No background sync hooks are installed.

Direct Word-file editing uses a separate edit validator over shared safe ZIP/XML/media primitives; it does not relax the existing Office import validator or shared XLSX checks. Its table/layout/media scope limits are engineering boundaries, not a Google prohibition on editing OOXML. It is not native Docs parity: exact mapped body/table-cell paragraphs, literal/rich inline text, tracked insertion/deletion and authored comments where OOXML relationships are verified. Preserve untouched ZIP parts; reject macros, signatures, external active parts, unsafe archives or ambiguous paragraph mapping. Rich layout/table/image authoring uses explicit conversion to native Docs instead of claiming equivalent Word edits. Word and Markdown same-ID whole-file updates use live digest/version comparison immediately before upload plus mandatory exact review and a warning that this is **not provider CAS**. Implement documented conditional requests only after independent contract validation; do not invent an ETag guarantee. If a provider forbids a route, offer a new-file artifact/conversion explicitly. Lost replies never cause re-upload or restore. Readback includes exact uploaded digest and, separately, ingestion observations; delayed Google ingestion is not permission to write again.

## 4. Architecture and execution

### File/module ownership

Keep new code under `plugins/google-drive/`:

* `core/docs-semantic/{model,coverage,selectors,fragments,styles,lists,tables,capabilities,planner,compiler,verification,codecs}/`: pure functions and immutable types; no network, SQLite, BB imports or logging side effects.
* `core/docs-semantic/{application,executor,receipts,recovery,approval-policy}.mjs`: use-case coordination and injected narrow ports.
* `adapters/docs-semantic.mjs`: exact get/batch wire adapter, bounded response decoder and typed acknowledgement; `adapters/docs-semantic-store.mjs`: versioned journal, claims and snapshots on real SQLite.
* `adapters/docs-{discussion,history,files}.mjs`: narrow Docs/Drive domains. Reuse existing auth/transport/security primitives without exposing generic requests publicly.
* `docs-semantic-{tools,review}.ts`, family schema modules and `docs-semantic-approval.tsx/css`: BB boundary only. `server.ts` and `app.tsx` remain composition roots.
* `features/docs/`, `features/support/docs/`, `features/step_definitions/docs.*.steps.mjs`, `test/docs-semantic-*`: executable specification, independent fixtures and contracts.
* `docs/semantic-api.md`, `docs/semantic-capabilities.md`, `skills/google-docs-editing/SKILL.md`: final surface/limits/recovery guidance. Keep shared Docs errors available to Sheets/Drive until deliberately extracted to a neutral module.

Ports are deliberately narrow: `ReadDocument`, `SubmitDocsBatch`, `ReadDiscussion`, `DriveMetadata`, `DriveFileCreate/Copy/Convert/Export/BlobUpdate`, `SafeAssetInspect`, `ArtifactStore`, `OperationJournal`, `ResourceClaims`, `Approval`, `Authority`, `Clock/Ids`, `Diagnostics`. The compiler returns an internal typed request program; only the Google adapter serializes it. It is not a public raw-batch escape hatch.

Planner input is snapshot + typed commands + capabilities; output is effects/preconditions/dependency DAG + verification specification. Compiler schedules transforms within each tab/segment, including text insert/delete, paragraph merges, list-tab consumption, table/section insertion and object widths. Reverse ordering applies only to independent disjoint text edits; structural dependencies keep their order. A stage needing server IDs or actual structure pauses for readback. Expected semantic effects are produced by domain rules, not by executing compiler-generated requests in the verifier.

Verifier independently parses actual provider evidence and evaluates explicit postconditions and preservation obligations. It must not call the compiler, production planner simulation or a test simulator to manufacture expected documents. Normalize only documented run splitting, numeric colour/unit representation and authorized index shifts. Do not normalize away changed links, unknown properties, comments or unrelated list IDs. Strict acknowledged-revision matching is required for native-CAS stages. K7's reviewed ID/no-CAS route instead requires an attributable acknowledgement, required collaboration save state and exact ID/witness readback, with the race limitation preserved; it never claims revision-based attribution. Later matching content after unknown submission remains an observation.

### Durable state machine

K4 is the normative per-stage transition table. New keys are globally reserved across retained namespaces and bound to subject/thread/request hash/schema version; historical keys may collide and require K6 disambiguation. Drafts hold no execution claims. Seal/apply acquires claims transactionally. Journal intent before dispatch and acknowledgement before verification/continuation. Stage submission is `not_sent|unknown|rejected|acknowledged`, separate from immutable save facts, verification and current status observations.

States:

* `proposed`, `reviewing`, `approved`: no provider write implied; approval is immutable and expires.
* `not_submitted`, `declined`, `cancelled`, `expired`, `stale`, `unsupported`: whole-operation no-write outcomes only when every stage is conclusively not_sent. After prior effects the result is partial; a persisted unresolved intent is unknown. A local no-op is `no_change`.
* `submitting`: durable intent; dispatch may have occurred. Restart treats this as unresolved, never resumes automatically.
* `acknowledged`: exact response/document/request-reply/revision evidence persisted; verification pending.
* `verified`: all required stages acknowledged and independently matched; release normal content claim.
* `rejected`: attributable rejection of a dispatched batch, not preflight or later-read failure. Stage submission is rejected; prior completed stages make the operation partial, not globally rejected/no-write.
* `partial`: completed effects plus stopped/rejected stages, including created-empty resources or failed collaboration saves. Retain claims for every partial operation in this program, including after reopen. No status/resume/new-key/reconciliation release is authorized here.
* `uncertain`: any submission/acknowledgement/save/verification ambiguity. Retain claim and no replay.

Outcome and observation are separate: current `observed_matching`, `verification_unavailable` or `changed_since_verification` never rewrites history. `thisCall.providerMutationCount` is always zero on status, even for acknowledged historical writes. Legacy `writeAttempted` remains ambiguous legacy evidence only; never backfill it as not_sent. Readback 401/403 retains acknowledgement and claim. Unknown/corrupt legacy versions fail closed.

### Final submission gate: after asynchronous authorization

K5 defines the bounded local linearization point: async identity/scope/policy/claim/asset checks with locally observed epochs; short synchronous SQLite intent transaction; synchronous epoch/cancel/expiry/hash recheck and one immediate dispatch with no intervening application await. `AuthorityDispatch` owns generation tracking and sequencing. No SQLite transaction spans network awaits. A crash after intent is unknown, even before provable dispatch.

Barrier tests pause tokeninfo AND final policy/account/claim/storage awaits and intent persistence. Observed local invalidation before dispatch yields zero POST. Remote-only revocation invisible locally may yield a submitted rejection; external edits use Google CAS where available. Do not claim atomic remote authorization. S00 closes the demonstrated legacy callback window and documents remaining limits; S03 supplies the complete protocol.

### Claim compatibility and shared dependencies

Document claims are keyed by provider document ID across accounts. New reservations atomically consult legacy formatting/image claims and known created-file/access claims. New access leases coordinate relevant sharing/move/upload operations on the file and destination ancestry through the existing access-claims implementation; do not claim to lock external Google clients. Avoid deadlocks by sorted resource acquisition in one SQLite transaction.

Preserve existing SQLite migrations/tables/receipts, subject bindings, hashes, timestamps, IDs and creation/copy/upload markers. Add only targeted schema tables/adapters. No generic migration framework, data-directory replacement or plugin-ID change. Retain versioned legacy verifiers privately for missing-kind creation, shared creation v1, page-only formatting and image receipts. Do not invent acknowledgement fields for old hash-only creation success; show `evidenceVersion:"legacy"` and its limits.

New `docs_operation_status` searches every eligible retained namespace for this subject. Ambiguity returns bounded receiptKind/recoveryHandle candidates; no first-match dispatch. New reservations collision-check every namespace transactionally, without exposing other-subject records. K6 defines key/child-key and corruption rules. Retired unsent proposals cannot be translated into expanded writes; cancel/expire safely. Existing pending cards must drain or be cancelled before cutover; retain their renderer for history/recovery, not execution. Unknown records fail closed. Removing an account never deletes receipts; reconnecting must match subject.

Shared helpers in `docs-edit.mjs`, `docs-approval.mjs`, `native-create.mjs`, Google transport, creation/store and CSS are not dead code merely because old tools retire. Sheets comparison fingerprints do not become CAS, and its mandatory approval does not inherit Docs opt-out. Upload fixes and Sheets merged-cell rules remain covered by cross-family regressions. Preserve the saved-preview-required upload guard, fail-closed XLSX opaque/embedded-package checks and shared `adapters/ooxml-media.mjs` helper. Media/OOXML expansion must not weaken these contracts or mistake the helper for Docs-only code.

## 5. Approval and outcome UX

Use BB native pending interactions and existing connection/button/theme patterns. No replacement Settings page is needed. Review card hierarchy:

1. Document title/link, verified account, mode and tab/segment/heading path.
2. Semantic before/after diff with exact replacement text, rich runs, table grid/spans and styles. Unchanged context collapsible; never hide affected content behind a truncated summary with an enabled approval button.
3. Explicit destructive footprint: nested nodes, merged content, deleted tab descendants, anchor/thread effects, source deletion, audience exposure and non-CAS file overwrite risk.
4. Stages labelled “one atomic content batch” versus “multiple saves; earlier changes can remain”. Collaboration save-state caveat is separate.
5. Source assets/digest/URI/dimensions and fidelity/notification limits. Do not load remote image pixels in the card.
6. Primary `Apply changes` / `Suggest changes` / `Post comment` / `Create document` as appropriate, secondary `Decline`, quiet `Cancel review`. No force/continue-anyway action.

K1 preserves the existing live requireDocsApproval for ALL requested native direct content/style/media/structural edits, including destructive edits. Disabled means standing content consent, never synthesized owner approval. Destructiveness changes exact disclosure/evidence, not a new approval gate. Suggest-mode, notification-bearing collaboration/decisions and non-CAS file overwrite have mandatory separately described review; mixed plans inherit actual effect requirements. Existing creation/access/Sheets/sharing/upload policies remain unchanged. No setting change is part of this rewrite.

Malformed/incomplete/expired payload disables Apply. Busy prevents double submit. Submission error says no new approval was confirmed, not that Google changed nothing. Idle thread must still receive native deferred result; stop/delete/reload/cancel preserve distinct reasons. Uncertain result shows “Change may have been saved” and a same-key read-only recovery action, never Retry. Partial result lists what was saved, not attempted and unresolved, with links to retained resources. Successful API verification explicitly excludes rendered fidelity.

Use escaped text, accessible status/error regions, keyboard focus, desktop/narrow layout and horizontal scrolling only within table views. Native synthetic examples cover long/mixed/destructive/dark/narrow/expired/partial/uncertain states. Actual host rendering and idle deferred completion are delivery gates; source/SSR assertions alone do not pass them.

## 6. Bounded resources and honest expansion

Centralize versioned budgets. Proposed defaults: provider JSON 8 MiB; 100,000 semantic nodes; structural depth 32 (tab depth additionally respects provider rules); snapshot materialized pool 32 MiB per service and four active snapshots per subject/thread; five-minute cursor lifetime; output page ≤64 KiB serialized; plan ≤100 commands, 500 matches, 1,000 changed cells, 200,000 inserted UTF-16 units and 256 KiB review payload; provider batch ≤100 requests/1 MiB serialized; ≤32 stages; ten-minute approval lifetime. Refuse before first write if estimated effects exceed durable/review budget. Never silently chunk a reviewed “atomic” operation.

Receipts retain unresolved evidence without TTL deletion. Store compressed immutable snapshot blobs deduplicated by digest, plus bounded per-stage evidence. Budget proposed/pending evidence globally (initial 128 MiB); reject new reservations before exhaustion and report capacity, never garbage-collect unresolved receipts. Completed evidence retention follows explicit owner policy, not this rewrite silently deleting history. No private evidence in logs or exported diagnostics.

These are engineering bounds, not Google hard limits. Expansion path: measured streaming projections/indexes; separate complete scope evidence; artifact-backed full reviews; larger batch plans with explicit non-atomic stages; stronger asset decoders. Each budget has exact boundary/overrun/CPU/SQLite growth tests and a capability response explaining which limit was hit. A large source beyond the provider JSON cap may be readable via converter export, but that export is not mutation evidence. Do not use partial field projections to pretend preservation coverage is complete.

## 7. Executable acceptance specification

### Harness and discovery

Add a Cucumber configuration with two profiles: `oauth` retains current OAuth feature/steps and Calendar build dependency; `docs` discovers `features/docs/**/*.feature` and imports only Docs support/step files. Default `acceptance` runs both explicit profiles. The pre-S00 invocation hardcoded only `features/oauth-client-reuse.feature`; preserve the delivered S00 runner seed while expanding explicit discovery in S01. Adding files alone is not coverage. CI totally expands obligations.json by exact operation and declared requested mode, independently of outcome profiles. Public exposure is per operation/resolved semantic variant/mode and requires ALL matching ledger outcome siblings plus explicit validation/invariant dependency closures, concrete Examples rows, actual driver/mode, capability and independent fixture evidence. Per-outcome success cannot enable a writer while lostReply/finalAuthGate or dependencies remain planned. Duplicate case IDs fail; repeated outline tags are valid. Planned future entries are not enabled or counted as skipped passes. External rendered/deployment gates remain separate. One Feature per file.

A Docs World constructs the real application, pure domain/compiler/verifier, real Google adapter and real `createBbStore`/semantic store on disposable file-backed SQLite. Reopen that database for crash/reload tests. Native-tool scenarios go through the real schemas/registration and `createFakePluginHost` behavior calls, including actual supported approval submit/cancel. Application scenarios bypass only the BB transport, not semantics.

Inject Google `fetchImpl`, OAuth userinfo/token/tokeninfo, Drive endpoints, asset DNS resolver and HTTPS request transport. Deny every unexpected network call; no global internet, credentials or production paths. Real URL/SSRF/decoder logic runs with synthetic bytes. Use deterministic clock/IDs and explicit barriers before dispatch, after apply-before-reply, after acknowledgement-before-save, during readback and during final auth. Assertions inspect public results, exact wire requests, independently expected structure, SQLite state/claims and redacted logs.

Two independent evidence tracks prevent a shared compiler/simulator bug:

* Hand-authored before/request/after Google fixtures, pinned to official contracts, reviewed independently of compiler implementation. Include UTF-16, run splits, variable-length rich cells, list-tab removal, merged ranges, sections, dropdown replies and collaboration save states. Fixture expected offsets are not computed by production helpers.
* A bounded test-only Google wire simulator for composition, revision validation and failure injection. It imports no production planner/compiler/verifier. Its own contract tests run those hand-authored vectors. Unsupported requests fail; never synthesize a semantic `verified` response. Some scenarios use scripted independent readback fixtures instead of the simulator. Property-based/metamorphic compiler tests supplement, not substitute for either track.

Schema tests validate serialized requests/replies against the pinned discovery subset and constraints not expressible in discovery. Store fixture provenance/licensing; do not copy unlicensed reference tests. No-live-write evidence cannot prove actual account rollout, renderer behavior or Google ingestion, so final reports separate those gates.

### Normative scenario conventions

K10 and obligations.json define executable joins, outcome applicability and exact case IDs. Use `preservation` consistently. Each row expands operation × base semantic variant × explicit mode applicability × applicable required outcomes; caseId is ledgerId.resolvedSemanticVariant.outcomeVariant. Guards retain same-mode legal controls; provider-rejection invariants preserve actual dispatch facts and cannot masquerade as feature success. C131 has five exact real docs_plan_content Markdown-fragment driver bindings, not a missing-mode internal codec shortcut. Native CAS and no-CAS comparison have different profiles, with explicit non-applicability reasons. N implementation variants cannot close with refusal; B/X variants have separate refusal/routing cases. S01 includes audit-negative fixtures for missing Examples/fixtures, orphans, duplicate IDs, false N closure, external substitution, success-only exposure/missing lostReply or finalAuthGate, missing validation/invariant dependencies, missing mode, guard-as-success, requested-mode mismatch, duplicate-name refusal-as-support, and nonexistent/output-only schema paths/enums or invalid masks. The approved revision-3 inventory expands to 11,197 planned keys; these are specification obligations, not executed tests.

Required executable vertical specifications include:

```gherkin
@F_EXEC @S_FORMAT403
Feature: Preserve acknowledgement when verification fails
  Scenario: Formatting succeeds before readback loses permission
    Given the real formatting service and Google adapter use disposable SQLite
    And Google will acknowledge the formatting batch at revision "r2"
    And its following document read returns 403 with synthetic private error content
    When the approved formatting operation is applied
    Then exactly one Google mutation was attempted
    And the receipt retains the acknowledgement and unresolved document claim
    And the outcome is uncertain, not rejected or not attempted
    When the database is reopened and the same key is inspected
    Then recovery sends only reads
    And diagnostics contain only the fixed verification failure category
```

```gherkin
@F_COMPOSE @S_RICH
Feature: Compile rich content through structural checkpoints
  Scenario: A table and nested list precede a styled heading
    Given a complete inline snapshot of a tab with an unrelated drawing
    When I plan a table containing different-length Unicode rich cells
    And I compose a nested list and a heading after that table
    And the owner approves the exact multi-stage plan
    Then the real adapter sends only revision-guarded dependency-ordered batches
    And independently authored readback confirms each style on its intended text
    And bullet tab removal and table growth cannot shift the heading target
    And the unrelated drawing is preserved
```

```gherkin
@F_EXEC @S_FINAL_GATE
Feature: Recheck authority at the dispatch boundary
  Scenario Outline: State changes during final asynchronous authorization
    Given an approved plan is paused in the adapter's final authorization check
    When <state> changes before that check returns
    Then the final submission gate rejects dispatch
    And no Google mutation is sent
    Examples:
      | state              |
      | account subject    |
      | locally observed grant epoch |
      | approval policy    |
      | approval expiry    |
      | durable claim      |
      | cancellation       |
      | plugin generation  |
```

```gherkin
@F_REVIEW @S_PARTIALSAVE
Feature: Separate model commits from discussion saving
  Scenario Outline: Suggestion save evidence is not inferred from HTTP success
    Given Google acknowledges model changes for a suggestion batch
    And commentUpdateState is <saveState>
    When the application evaluates the response and bounded readback
    Then discussion completion is <completion>
    And later stages are <continuation>
    And no mutation is retried
    Examples:
      | saveState                  | completion                 | continuation |
      | ALL_SAVED                  | verified only with readback | gated        |
      | ALL_FAILED_UNKNOWN_REASON  | failed with model facts    | stopped      |
      | absent                     | uncertain                  | stopped      |
      | NO_UPDATES_REQUESTED       | uncertain                  | stopped      |
```

Other ledger features cover complete/partial read coverage, matching normalization/cardinality, style inheritance, preservation, lists, table topology, tabs/segments, media security, discussion rights, templates/codecs, history/files, old receipts, adjacent routing and UX. Implement specifications first in each slice, then minimum production changes to satisfy the whole slice; never leave failing future features in the normal runner or count pending scenarios as delivered.

## 8. Sequential implementation slices and gates

Only one source owner at a time on main. Each handoff records base commit, exact owned files, tests/evidence and unresolved holds. Research/review does not confer build/reload ownership. Common gates for every slice: executable scenarios first; pure/adaptor/SQLite/native host tests; safe diagnostics with sentinels; independent preservation/request fixture review; docs/ledger update; no unexplained skips. Shared roots belong to the current integrator only.

| Slice | Owned files / dependency | Completion gate |
|---|---|---|
| S00 Safety regression (delivered at baseline; historical scope) | Separately reviewed/delivered: `core/docs-format.mjs`, relevant `core/docs-edit.mjs`, `adapters/docs.mjs` (transport only if necessary), focused tests and minimal Docs feature/World/runner config. Avoid upload/Sheets semantics. | First add tiny Docs Cucumber seed preserving OAuth, real formatting service/Google adapter/file-backed SQLite/closed HTTP. Reproduce FORMAT403, reopen and prove ack/claim/read-only recovery. Add pre-dispatch/dispatched-rejection/readback/storage matrix and smallest correction. Add format/replacement post-auth callbacks and bounded legacy race tests; replacement still lacks durable own claim. No new engine or public tool. |
| S01 Acceptance foundation | Expand S00 World/runner under `features/support/docs/*`, independent fixture/contract tests, obligation audit and composition seam only as needed. | Add asset transports and bounded independent simulator; total mode-aware expansion, complete sibling/dependency exposure gate, schema-path checks and R1–R4 audit negatives. No skipped future scenarios counted. Real semantic path cases activate as S03/S04 provide production logic, not mocked early success. |
| S02 Snapshot and selection | New semantic model/coverage/selectors/reader modules, read tools and tests. | Structured/text F_READ/F_SELECT variants complete; unknown nodes, exact witnesses and coverage. Markdown/HTML read variants remain planned until S12 codec integration, not flattened or falsely enabled. |
| S03 Durable engine | Semantic planner/compiler skeleton/executor/store/recovery/claims and neutral helper extraction with all consumers. | F_EXEC/F_LEGACY success, rejection, uncertainty, crash matrix; old/new cross-account exclusion; final gate proven for generic stage. No authoring publicly enabled until this gate. |
| S04 Text and style vertical slice | Content/style family, preservation verifier, inline/block codecs. | Rich cross-run edits beside opaque nodes, exact style/reset/inheritance, headings/links; real end-to-end approval and readback. |
| S05 Lists and composition transforms | List model/compiler/verifier; block composition/copy/move. | List identity/nesting/custom-preservation algorithms and list→heading transforms; table→list→heading cases remain open until S06/S07. Refusal alone does not close N preservation variants. Native arbitrary list setters remain separate B variants. |
| S06 Tables, content | Table parser/grid/selectors, create/populate/patch/growth and rich-cell modules. | Ragged/offset/clear/label/nested-cell cases, no integer coercion/truncation, staged partial creation and Unicode style placement. |
| S07 Tables, topology/layout | Table splice/merge/styles/layout/pinning modules. | Full logical/physical spans, RTL merge, final-axis deletion, shared borders, row/column constraints and evolving coordinates. |
| S08 Tabs/segments/layout | Structure family, page/section/named-style modules. | Tab subtree preservation, returned-ID stages, default vs first/even header rules, footnotes, pageless/stored-effective styles, three-column/native placement constraints. |
| S09 Anchors and media security | Anchor/media tools, asset adapter expansion, image/chip model/compiler/verifier. | Named-range split effects and actual duplicate-name creation/ID/all handling versus ambiguous-selector refusal, explicit assets/no hosting, PNG/JPEG/GIF security, object inventory/download, typed links/person/resource/date chips and provider-blocked mutations. |
| S10 Dropdowns and collaboration | Dropdown registry, discussion/suggestion adapters and UI sections. | Definition/instance integrity; exact mode matrix; thread author/assignment rules; notifications; ALL_SAVED/partial-save handling and format-only suggestions. |
| S11a Read-interop prerequisite | Bounded real Sheets display/rich-run read port and independent fixtures; no Sheets writes. | Frozen value/style provenance available before template consumers; rich-text write extension remains S14. |
| S11 Creation and templates | Depends on S11a; creation/template binder and existing access claims. | Blank/plain/structured create/copy/populate and template fills. Markdown initial-content variant remains planned until S12. Preserve upload review for artifact-source routes per K8. |
| S12 Codecs/import/export/history | Markdown/HTML codecs, artifact/history/conversion adapters. | Actual codecs enable pending S02 Markdown/HTML reads and S11 Markdown creation; full loss policies, scope/collapse, formats, idempotent artifact receipts, sparse/pruned history. Uploaded conversions retain exact upload preview/digest review. C176 upload regression evidence is required before reuse here and rerun at S15. |
| S13 Working-copy and Word files | Working-copy journal, three-way Markdown, bounded OOXML patch and file-write adapter. | K8 source/result unions, before/after byte digests and non-CAS review; separate OOXML edit validator; import/XLSX validators unchanged. Codec scope limits are engineering, not Google bans. Ingestion delay never replays. |
| S14 Adjacent integration | Narrow Drive search/rename/shared-drive discovery/sharing extensions and Sheets rich-text/append gaps as listed in ledger, each in its own existing bounded context. | K8 explicit domain/discoverability sharing, rich Sheets mode, fixed inspected append cells and parsed artifact values; mandatory policy/no-CAS evidence; existing formula grammar, merges/protection/table guards intact. S11a read port precedes these consumers. C175 Sheets regressions are required here and rerun at S15. Sequential sub-slices only. |
| S15 Surface cutover and delivery | Integrator owns server/app/schema inventories, Docs skill/README/guides, capability RPC and pending-card transition. | All ledger-backed new authoring exposed; old authoring removed without aliases; legacy status routing/cards retained; whole-plugin/cross-feature gates and rendered BB review. |
| S16 Whole-program audit | Independent reviewer; no parallel implementation edits. | Every ledger row accounted, scenario/example discovery equals execution, limitations classified honestly, licence and contract audit, normal scoped delivery and final evidence report. |

S00 is intentionally focused, before adopting older lifecycle code. S01/S03 do not replace S00 with a large framework rewrite. Later slices may be divided into sequential implementer-sized tasks while retaining their coverage obligations; no difficult feature becomes silently “later/MVP out of scope”. A blocked native capability stays a named limitation with tested alternative, not a passing native implementation claim.

## 9. Cutover, verification and delivery

Before changing serving code, inspect installed source through supported BB interfaces and reserve/drain applicable writers/pending operations. Follow repository delivery skill. If current installation is local, use supported build/reload retaining plugin ID/data/settings; if Git-backed, source switching requires separate permission and positively advertised capability for that registration. Do not uninstall/reinstall, edit caches/databases or update all plugins. A disposable BB preview is acceptable for rendered review when live application is blocked; report runtime gate unverified rather than requiring publication to see UI.

Cutover phases: register new read/recovery surfaces; internally validate authoring families; drain/cancel old pending authoring safely; expose complete new family inventory and remove old authoring registration/descriptions/RPC contracts together. Keep legacy receipt parsers and historical card renderers private. Do not retain misleading authoring aliases or active old mutation paths bypassing new claims. Generic status accepts historical keys; skills explicitly direct same-key recovery.

Run whole Drive tests, type/build/shared checks, OAuth acceptance and every Docs feature, plus Sheets/creation/sharing/filing/copy/upload regressions. Review final post-async-auth gate at **every** writer including blob/Drive stages, and assert no hidden write retries. Inspect rendered BB desktop/narrow/keyboard/long-table/error/expired/partial/uncertain/no-op cards and native idle deferred completion. Verify intended applied code with supported bounded read-only capability evidence and safe logs; no business write is required or authorized by this plan.

Independent review audits request/response fixtures, compiler/verifier separation, capability completeness, licences, preserved old evidence and claims, no-CAS disclaimers, security/observability and rendered findings. Ordinary scoped Git workflow: inspect diff and unpushed commits, preserve unrelated work, stage only owned changes, commit on main and push intended work after gates and supported local try. No reset/rebase/stash/merge or unrelated publication. No formal versioned release is implied.

Final coverage report lists ledger rows implemented, genuinely provider-blocked, deliberately excluded transports and remaining **engineering** gaps separately; a gap is not “complete” because an alternative exists. Record exact tests/scenarios executed, applied-code evidence, rendered review, and unavailable live-provider evidence. The revision-3 design passed independent review. Implementation and delivery require their own independent gates.
