# Normative semantic API contracts


## K1. Consent by actual effects

| Effects in logical plan | Review rule | Required evidence |
|---|---|---|
| Requested native content/style/media/structural edits in direct mode, including deletion, cell replacement, tab-subtree removal and multi-tab collapse | Existing live `requireDocsApproval`. Enabled: exact owner card. Disabled: record `standing_content_consent`, never `owner_approved`. | Full effect footprint and preservation evidence regardless of policy; destructiveness alone introduces no new approval gate. |
| Any suggest-mode authoring, commentProposal, discussion action or suggestion decision | Mandatory exact collaboration review, including possible notifications and CAS/no-CAS route. | Thread/content witnesses, mode and induced thread effects. Even a style suggestion creates collaboration effects. |
| Same-ID Markdown/Word/blob overwrite | Mandatory exact file review; cannot opt out with Docs setting. | Before digest/version, after bytes digest, complete logical diff and non-CAS warning. |
| Existing creation/copy/filing/access/sharing/upload/Sheets routes | Preserve that route's policy without reclassification. Uploaded/imported local files always retain saved preview/digest/mandatory upload review, even in private root. | Existing destination/audience/source policy plus new semantic effects, if any. |
| Mixed plan | Union of effect requirements, one combined exact card where supported. | A mandatory collaboration/file/upload requirement cannot be weakened by an ordinary content opt-out. Approval cannot waive missing evidence. |

A direct content edit that changes existing suggestion summaries or discussion state has collaboration effects and follows that row; no surprise notification-bearing mutation is dispatched under content-only standing consent. Provider notifications are possible, not guaranteed or exhaustively enumerable. No silent switch is invented.

## K2. Drafts, identities and composition

### Boundary grammar

The following TypeScript-like algebra defines JSON shapes. Objects are strict (unknown fields rejected); unions use the shown discriminants. UUID is lowercase UUIDv4; Hash is SHA-256; IDs are opaque bounded strings. Command family schemas enumerate their own operations and share these types; no public raw request or open-ended command object exists.

```ts
type NewDraft = {
  kind: "new";
  requestId: string; // 1..128, [A-Za-z0-9._-], unique within subject+thread
  destination: { snapshotId: string } | { creation: CreationDestination };
  sources?: { alias: string; account: string; snapshotId: string;
              selector: Selector; policy: "frozen" | "requireUnchanged" }[];
  mode: "direct" | "suggest" | "commentProposal";
};
type ExtendDraft = {kind:"extend"; draftId:string; expectedDraftHash:Hash};
type FamilyInput<C> = {account:string; draft:NewDraft|ExtendDraft; commands:C[]};
type Target = {node:string} | {ref:string} |
  {cell:{table:{node:string}|{ref:string}; row:number; column:number}};
type Position = {at:"before"|"after"|"start"|"end"; target:Target};
type Insert = {op:"insert"; at:Position; content:BlockFragment; as?:string};
type Style =
 | {op:"text"; target:Target; set?:TextStylePatch; reset?:(keyof TextStylePatch)[]}
 | {op:"paragraph"; target:Target; set?:ParagraphStylePatch; reset?:(keyof ParagraphStylePatch)[]};
type DraftResult = {draftId:string; operationId:UUID; draftHash:Hash;
  state:"draft"; bindings:BindingSummary[]; exports:Record<string,SymbolType>;
  proposal:EffectManifest; expiresAt:string; nextAction:"extend_or_apply"};
type Apply = {account:string; operationId:UUID; planHash:Hash};
type DraftLookup = {account:string; requestId:string} | {account:string; draftId:string};
type CancelDraft = {account:string; draftId:string; expectedDraftHash:Hash};
type Combine = {account:string; requestId:string;
  inputs:{draftId:string; expectedDraftHash:Hash}[]}; // 2..16, ordered, unique
```

`Selector` is the plan's closed semantic selector vocabulary; `Target.node` is already resolved snapshot identity, not a current ordinal. `ref` addresses a typed exported result. `as` matches `[A-Za-z][A-Za-z0-9_]{0,31}` and is unique across one draft graph. A one-paragraph fragment exports a paragraph; a multi-block insert exports a blockSpan; incompatible style operations reject rather than choose a child arbitrarily. Generated table exports permit `cell` selectors; table cells can additionally export paragraph handles during typed population. No client-supplied provider ID is inferred for generated objects.

The first family planning call issues the UUID server-side and reserves it across namespaces. This avoids requiring a UUID-generation tool. Caller uses a memorable unique requestId, keeps it after interruption, and calls new read-only `docs_draft_status` by the SAME requestId; never starts another draft to recover. The pair subject+thread+requestId is atomically bound to canonical input hash before planning. Duplicate identical planning returns its saved revision/result; changed input under that requestId returns `request_conflict`. Planning rejection has a no-write draft receipt and consumes the requestId/operation key; a genuinely revised request may use a new requestId only when the old receipt is conclusively never submitted and holds no execution claim. Failure before returning a key is recoverable through requestId. `docs_draft_cancel` cancels an unsealed draft without Google calls; it cannot cancel/release a submitted stage.

Drafts are owned by verified subject and originating thread; extension/combine/apply require that owner. Recovery by key is available to the same verified subject across threads, but cannot execute. A draft has immutable revision blobs plus a CAS head hash. Extension supplies the head hash and returns a new hash, invalidating an earlier Apply hash. This is local draft versioning, not mutation of an approved plan. Apply atomically seals the current head, saves approval intent and acquires execution claims. Drafts hold **no exclusive document/access claims**, so independent drafts can coexist. Cancel/supersede/expire retain key tombstones and immutable history; none permit reusing the key.

Hash includes canonical logical commands, resolved initial node identities, mode, ordered bindings, frozen source fragments/assets, capability versions, exact effect/loss/notification/access manifests, resource budgets, expiry, verification specification and permitted generated-binding rules. It excludes concrete future provider IDs/ranges/revisions: these are append-only execution bindings constrained by the sealed plan, not rewritten intent. A later stage cannot expand a table, choose a new tab, omit loss, or substitute content merely because it has fresh provider data.

### Example A: generated paragraph then cross-family style

```json
{"tool":"docs_plan_content","account":"writer@example.test","draft":{"kind":"new","requestId":"decision-paragraph-1","destination":{"snapshotId":"snapA"},"mode":"direct"},"commands":[{"op":"insert","at":{"at":"after","target":{"node":"p7"}},"content":{"kind":"blocks","blocks":[{"kind":"paragraph","inlines":[{"kind":"text","text":"Approved"}]}]},"as":"decision"}]}
```

The acceptance driver takes `insertParagraphInput` from the JSON above and calls the real native tools. Actual returned hashes, not hardcoded placeholder hashes, feed subsequent calls:

```js
const {tool, ...input} = insertParagraphInput;
const inserted = await call(tool, input);
const styled = await call("docs_plan_style", {
  account: input.account,
  draft: {kind: "extend", draftId: inserted.draftId,
          expectedDraftHash: inserted.draftHash},
  commands: [{op: "text", target: {ref: "decision"}, set: {bold: true}}]
});
const result = await call("docs_apply", {
  account: input.account, operationId: styled.operationId,
  planHash: styled.draftHash
});
```

`call` is the native-tool harness driver, not a fake semantic service; owner review is driven separately by the fake BB host. Fixture setup supplies actual snapshot/node IDs for the first input. Style resolves against the draft's virtual state; no Google paragraph must exist yet. This is a heterogeneous plan with no extra combine/read step.

### Example B: generated table, population and styles

```json
{"tool":"docs_plan_table","account":"writer@example.test","draft":{"kind":"new","requestId":"budget-table-1","destination":{"snapshotId":"snapA"},"mode":"direct"},"commands":[{"op":"create","at":{"at":"after","target":{"node":"p7"}},"rows":2,"columns":2,"as":"budget"},{"op":"patchText","table":{"ref":"budget"},"blocks":[{"start":{"row":0,"column":0},"values":[["Item","Total"],["A😀","12"]]}],"growth":"reject"}]}
```

Extend through `docs_plan_style` with `target:{cell:{table:{ref:"budget"},row:0,column:1}}`, `set:{bold:true}`. Stage 1 inserts empty table under r1. Acknowledged r2 and independently verified structure bind `budget` to its exact tab/segment/anchor extent. Stage 2 populates cells under r2; readback at r3 binds final rich cell ranges. Stage 3 styles under r3 (or stage 2 includes styles only if independently validated transforms permit it). No new agent read of the approved empty table is required. A response loss, extra table at the anchor, wrong dimensions, external revision advance or failure to persist bindings stops; claim remains held.

### Example C: combine preserves original intentions

Draft A at snapshot r1 inserts a row before original row 1 of table T. Independent draft B at r1 writes original logical cell `(2,1)`, resolved internally to cell handle `T.c21`. Input:

```js
const combined = await call("docs_plan_combine", {
  account: "writer@example.test", requestId: "combined-budget-1",
  inputs: [draftA, draftB].map(d => ({
    draftId: d.draftId, expectedDraftHash: d.draftHash
  }))
});
```

Here `draftA` and `draftB` are the actual family-tool responses, not fabricated plans.

Combine requires same owner, destination snapshot/mode, compatible source bindings, unsealed heads and unexpired inputs. One SQLite transaction consumes the heads into `supersededBy`, reserves a new key, and saves the combined draft. If it fails, neither input is consumed. The combined plan retains B's `T.c21`, now row 3 after A; it never reinterprets B's original coordinate as new row 2. Preview says “original row 2 → resulting row 3”. If A deletes/merges B's target incompatibly, combine fails with conflicting effects. Overlapping style patches with different values also fail, not last-wins implicitly. Equal patches may coalesce with provenance.

In contrast, a single ordered draft containing `insertRow` followed by a fresh coordinate selector `(2,1)` resolves that later selector in the evolving draft state. To select an original cell in that sequence, use its snapshot node. This difference is part of the schema/preview, not compiler guesswork. Inputs with generated outputs can be combined only if all references are already closed inside each draft; cross-family generated references are made by **extend**, not unresolved imports across independent drafts. No submitted/uncertain key may be combined or superseded.

### Example D: cross-document frozen copy

```json
{"tool":"docs_plan_content","account":"writer@example.test","draft":{"kind":"new","requestId":"copy-terms-1","destination":{"snapshotId":"snapDestination"},"sources":[{"alias":"terms","account":"reader@example.test","snapshotId":"snapSource","selector":{"node":"sectionTerms"},"policy":"frozen"}],"mode":"direct"},"commands":[{"op":"copy","source":{"binding":"terms"},"at":{"at":"end","target":{"node":"destinationBody"}},"lossPolicy":"reject","as":"copiedTerms"}]}
```

Each snapshot resolves its own subject/document/revision/view/scope. Read authority is checked for source, write authority/CAS for destination; revisions never cross subjects. Freeze selected source nodes, style definitions and authorized asset digests in the draft. Preview names source snapshot time and frozen-copy policy. Source revision drift does not change the frozen copy, but loss of source access before execution stops it. `requireUnchanged` additionally requires the source revision/digest still match; drift stops before dispatch, or leaves partial if destination stages already happened. No source mutation is implied. Cross-document move, if later exposed, requires an explicit source write binding, both claims, independent source CAS and destination-first verification; copy permission never grants deletion.

### Lifetime and revision table

| Item | Lifetime / binding | Expiry or restart behavior |
|---|---|---|
| Read cursor | Five minutes, single-use continuation of snapshot; bound subject/thread/doc/view | New read required; cursor expiry does not erase materialized evidence retained by a draft. |
| Unreferenced snapshot | Ten minutes for starting new plans; bounded pool | Cannot create/extend new target coverage from expired snapshot. Draft-pinned copies remain evidence, not new current reads. |
| Draft head | Thirty minutes from initial creation; extension does not extend deadline | Expire only unsealed head, keep key tombstone. Saved exact witness may support Apply after cursor expiry; fresh internal revalidation still required. |
| Approval | Ten minutes from card creation, capped by draft deadline before first dispatch | No first dispatch after expiry. Standing consent is checked live, not converted into permanent approval. |
| Executing plan | Same approved sequence/deadline; every stage checks expiry | Expiry before any dispatch is not_sent/expired. Expiry after any completed stage is partial with retained claim. No automatic reapproval/resume. |
| Stage revision | First stage uses initial destination revision; next uses preceding acknowledged **and verified** revision for that document | Unexpected external revision stops; do not reset to the original revision or accept a fresh unrelated one. Each generated binding is verified against predecessor effects. |
| Recovery evidence/key | No uncertainty TTL; durable across restart/account reconnect to same subject | Status is read-only, no continuation, key replacement or claim release for partial/unknown work. |
| Local export/checkout artifacts | Caller requestId + frozen source digest/format/options; operation receipt persisted | Repeat returns same artifact IDs/digests; changed input conflicts. Missing artifact reports missing, not silently recreated. Explicit new export gets a new requestId. Retention/deletion follows owner artifact policy; metadata receipt remains. |

## K3. Read witnesses without redundant ceremony

Internal complete footprint/dependency/preservation evidence is always required. A separate agent-delivered full document is not.

| Operation | Minimum agent-visible witness | Internal coverage required | Extra delivered read? |
|---|---|---|---|
| Unique narrow literal replacement/deletion | Exact matched preimage, count, context, proposed text and complete induced-effect preview | Full mapped runs/paragraph boundaries/style/object/review footprint | No, if complete bounded witness is returned by planning. Exact text in a metadata summary alone is insufficient. |
| Non-destructive style or insertion at an inspected ID/handle | Target identity/path and complete property/insert effect preview | Target and adjacent newline/list bullet/anchor dependencies, inherited style evidence | No mandatory read; inspect→plan→apply is normal. |
| Whole cell/section/tab/body replacement/deletion or move | All affected original nodes/content and removals, including nested/opaque nodes, delivered by read **or complete plan preview** | Whole destructive scope plus boundary and review dependencies | Yes only if preview cannot deliver the complete affected scope; do not require both. Truncation blocks Apply. |
| Named-style definition | Old/new definition plus complete inheritor/override footprint summary and representative values; indirect text is not deleted | All usage nodes, explicit overrides, effective affected properties | No unrelated prose read; every indirectly affected node/property identified, possibly paged before Apply. |
| Table merge/unmerge/axis deletion/shared borders | Complete affected cell contents/spans/adjacent edges and movement/deletion effects | Physical topology and review anchors throughout actual footprint | Complete preview suffices. |
| Generated nodes in approved draft | Already delivered fragment/effect manifest plus verified returned-ID binding | Fresh complete stage read, predecessor revision and preservation | No extra agent-read ceremony. |
| ID-based own collaboration action | Exact thread/post/suggestion IDs, content/action/author witness and non-CAS caveat where selected | Fresh complete target thread, relevant suggestion footprint, permission evidence | No whole document read for own-post text edit; index-changing actions require relevant model evidence. |
| Frozen source copy/file overwrite | Complete selected source/diff or exact package/digest manifest appropriate to route | Source binding/authority, full selected fragment or byte package and all declared preservation | Does not require reading unrelated tabs or binary bytes into chat. Mandatory file/upload cards retain their existing content-not-fully-rendered disclaimer. |

Coverage separates `materialized`, `delivered`, `witnessSatisfied` and `missingAspects`; no boolean grants blanket document edit authority. Broad witness paging binds one immutable hash. Missing comment access allows disjoint style work only when the verifier can prove no dependent thread effect; do not silently drop review dependencies.

## K4. Submission facts, status and claims

Per-stage record:

```ts
type StageFacts = {
  stageId:string;
  submission:"not_sent"|"unknown"|"rejected"|"acknowledged";
  intentPersisted:boolean;
  dispatchObserved?:true;
  rejection?:{httpStatus:number; category:string};
  acknowledgement?:{documentId:string; revisionId?:string; replyDigest:string};
  collaborationSave?:"ALL_SAVED"|"ALL_FAILED_UNKNOWN_REASON"|
    "NO_UPDATES_REQUESTED"|"UNSPECIFIED"|"ABSENT";
  verification:"not_run"|"matched"|"mismatch"|"unavailable";
};
type Receipt = {operationId:string; receiptKind:string; stages:StageFacts[];
  status:string; claim:"none"|"held"|"released";
  thisCall:{providerMutationCount:number}; observation?:object;
  historicalEvidenceVersion:string; retrySafe:false};
```

Facts are append-only: not_sent may become unknown on dispatch intent, then rejected/acknowledged on attributable response. Acknowledgement never becomes rejection because a later GET fails. Unknown is not proof a POST occurred. Response persistence failure leaves durable unknown even if the process briefly held a response; recovery cannot invent the missing fact. Verification may gain later evidence; historical matched verification is retained separately from current drift.

| Boundary/result | Stage submission | Operation status | Claim |
|---|---|---|---|
| Preflight/final-gate fails before dispatch; durable known local cancellation recorded | not_sent | not_submitted (or named no-write reason) | Release only when every stage conclusively not_sent and no prior effects. |
| Durable intent then crash before known dispatch | unknown | uncertain | Hold across reopen. |
| Dispatched definitive 400/403 rejection with attributable response | rejected; dispatchObserved true | rejected only if no previous effects; otherwise partial | Release for a single conclusively rejected stage with no effects; hold on multi-stage partial. |
| Acknowledged POST then GET 403 | acknowledged; verification unavailable | uncertain | Hold; keep acknowledgement. |
| Acknowledgement receipt persistence fails | durable unknown | uncertain | Hold; no subsequent stage. |
| Model ack with ALL_FAILED_UNKNOWN_REASON | acknowledged; failed collaboration save | partial if model facts known, otherwise uncertain | Hold, even if threads are reported failed. |
| Model ack with absent/unknown/contradictory thread status | acknowledged; unresolved save | uncertain | Hold. |
| Stage 1 verified, stage 2 rejected/expired/cancelled/not_sent | preserve both facts | partial | Hold; no auto-resume/repair/release. |
| All stages acknowledged and verified with required save evidence | acknowledged throughout | verified | Release normal completed content claim; existing access-route rules still apply. |
| Status observes match after unknown submission | unchanged unknown | uncertain + observed_matching | Hold; thisCall.providerMutationCount=0. |

Status always has mutation count zero, regardless of historical submission. Legacy `writeAttempted` is returned only inside `legacyFacts` with its original semantics; never use false there to overwrite acknowledgement or infer not_sent. New public results use stage submission plus current-call mutation count, not an overloaded writeAttempted boolean.

For this program partial operations and failed/unknown collaboration saves **retain claims**. Reconciliation/release of such claims is not designed here and cannot be smuggled into status or a force/new-key argument. This is deliberately stricter than “all effects accounted for”.

## K5. Bounded final-gate linearization

A new `AuthorityDispatch` port owns local authority epochs and dispatch sequencing. Settings/account/plugin lifecycle changes increment synchronous locally readable generation tokens as soon as the host callback is observed. This is a local guarantee, not atomic remote authorization.

1. Outside any SQLite transaction: inspect current plan/preconditions, refresh/check identity/scope, read current policy, inspect asset digest, and obtain durable claim state. Capture epochs before and after these awaits; changed epochs require stopping/reinspection, not a hidden write retry.
2. In a short synchronous SQLite transaction, validate exclusive owner/head/stage and persist exact stage intent. No network await in this transaction. The DB adapter must expose this local transactional operation, not pretend an arbitrary async store function is synchronous.
3. Immediately after persistence, synchronously validate local epochs, cancellation/disposal, expiry, sealed hash and in-process dispatch ownership. Invoke the one transport dispatch synchronously with no intervening application await. A synchronous veto is recorded as known not_sent; a crash after intent before recording that veto remains unknown.
4. The dispatch invocation is the local linearization point. After it, local cancellation/policy changes cannot promise zero POST. Remote scope revocation invisible locally can cause a submitted Google rejection; external edits are protected by requiredRevision where available, not SQLite.

Barriers cover tokeninfo, final policy read, account read, claim read, intent persistence and before synchronous dispatch. Tests change local epochs at each await and prove no dispatch where observed before the linearization point. A remote-only grant change is a separate fixture asserting a rejected POST, not zero POST. No process-wide DB/network lock is held across waits.

S00 adds the smallest legacy post-auth callback and tests its demonstrated window, explicitly documenting its remaining async-store/epoch limits and replacement's lack of durable claim. S03 implements this complete port/protocol. S00 does not claim to solve all races by copying image callbacks.

## K6. Legacy namespaces and new-key reservations

`docs_operation_status` accepts `{account,operationId,receiptKind?}` or `{account,recoveryHandle}`. Known namespaces include semantic, legacy formatting, legacy image and native creations (Docs, Sheets, copy, upload kinds within that store); preserve their actual storage names internally. Lookup searches all eligible namespaces for the pinned subject before selecting a verifier. One match resolves; multiple matches return bounded `{receiptKind,recoveryHandle,createdAt,status}` candidates and no first-match provider lookup. More candidates than output budget returns paged ambiguity, never guesses. Wrong-subject records disclose no content; unknown/corrupt kind retains its existing claim and returns safe unsupported recovery evidence.

New UUID reservation transaction checks **all retained key namespaces**, including records for other subjects, without exposing their content. Collision returns key-conflict before mutation; server-generated key may be regenerated only before any draft reservation exists. After reservation it is immutable. New delegated child operations use separate globally reserved keys recorded in the parent; shared claim ownership is explicit, not two operations racing each other. Historical keys are not renamed or rewritten. Cross-namespace same-key, wrong-subject, corrupt record, unsupported version and reconnect fixtures are mandatory.

## K7. Operation/mode/permission/revision/save matrix

Legend: C = requiredRevision CAS from this subject's editable inline snapshot; I = explicitly reviewed ID-action no-CAS route; D = Drive/file comparison only. T = ALL_SAVED plus relevant thread readback; M = independent model readback; SR = per-request suggestionResponses IDs/action evidence. All readbacks have bounded completeness and current-vs-historical distinctions.

| Operation class / exact requests | Mode | Permission and revision route | Save/readback evidence |
|---|---|---|---|
| insertText/deleteContentRange/updateTextStyle/updateParagraphStyle/createParagraphBullets/deleteParagraphBullets, insertPageBreak, insertTable/row/column and deleteTableRow/Column, merge/unmerge, updateTableCellStyle/RowStyle, pinTableHeaderRows, insertSectionBreak/updateSectionStyle, createHeader/Footer/Footnote, replaceNamedRangeContent, insertInlineImage/replaceImage/deletePositionedObject, insertPerson/RichLink/Date, dropdown operations, updateNamedStyle, allowed document-style fields | EDIT or SUGGEST, subject to request/field contracts | C; content-index writes without an editor revision are not offered by this product. Google permission to suggest may be broader: this is an explicit product concurrency restriction, not Google API absence. | EDIT: M; T/SR additionally if plan/response has induced thread effects. SUGGEST: M+T+SR, created/updated IDs and unchanged base-vs-suggested semantics. |
| addDocumentTab/deleteTab/updateDocumentTabProperties; createNamedRange/deleteNamedRange; deleteHeader/deleteFooter; updateTableColumnProperties | EDIT only; SUGGEST preflight refusal | C | M, plus T/SR for any induced thread effects; no direct fallback. |
| updateDocumentStyle.documentFormat/useEvenPageHeaderFooter/useFirstPageHeaderFooter | EDIT only; other writable fields separately eligible | C | M and conditional thread evidence. |
| insertComment anchored; commentProposal | EDIT collaboration action, not SUGGEST writeMode | C for exact range route. A non-editor range-index route is a product concurrency restriction, not a statement Google disallows comments. | T + returned commentId + exact range/content/assignee readback. |
| addCommentReply/updateCommentPost/deleteComment/DeleteCommentReply on inspected IDs; resolve/reopen/reassign | EDIT collaboration action | C when same subject has revision. I chosen at **planning** when revision absent and target author/role can perform action. Update/delete post author-only restrictions and action/assignee exclusions enforced. Reply/action role checked via provider permissions and exact target evidence; no speculative write probe. | T + reply IDs or exact updated/deleted target evidence. No suggestion head-post editing. |
| acceptSuggestion | EDIT decision | Editor only, C. No non-editor fallback. | T+SR accepted IDs + resulting model/thread evidence. |
| rejectSuggestion | EDIT decision | Editor C or non-editor author I. | T+SR rejected IDs + bounded model/target readback; if unavailable after acknowledgement, unresolved claim. |
| deleteSuggestion (discard) | EDIT decision | Author, C if revision available, otherwise I. | T+SR deleted IDs + target absence/model witness; no substitute rejection. |
| Document-wide/quoted-metadata comment through Drive | Drive route, no Docs writeMode | D; exact file/thread witness, mandatory review, explicit backend. | Drive acknowledged resource ID + exact readback; no invented Docs commentUpdateState. |
| Native file create/copy and file conversion/export | Route-specific | Existing grant/access policy; no borrowed Docs revision for Drive creation | Acknowledged created ID; content stages use its own revisions; converters report bounded readback, not fidelity. |

I route schema: `{concurrency:{kind:"reviewed_id_no_cas",witnessId,expectedThreadDigest,authorWitness:{me:true,userResource?,readSubject},action}}`. Author-only actions require provider `PostAuthor.me:true` from the pinned subject's read; `userResource` is optional additional evidence. Never equate a display name or People resource with the OAuth subject, and never add People scopes to fill missing evidence. Reply/action permissions not requiring authorship use an explicit role/capability witness instead. It is selected and reviewed before writing, not fallback after CAS failure. Re-read exact target immediately before dispatch; changed author/content/assignment/resolution/suggestion footprint stops. Missing read permission stops. Same-ID races can still occur after comparison; card states this. Required revision is omitted only on this whitelisted ID route. One attempt, durable document claim, strict acknowledgement/save evidence, no attribution from absence after a lost reply. A non-editor author's action remains a real Google capability even if readback is unavailable and the result must stay uncertain.

Capability entries store schemaSupport, productRoute, accountEvidence and exact field/mode rule separately. All unknown account rollout is `unverified`; an actual capability denial is reported without altering permissions. Ordinary EDIT batches with no expected thread effect may accept NO_UPDATES_REQUESTED or absent thread status if M matches and response has no suggestion effects. Unexpected suggestionResponses or ALL_FAILED/unknown save state in a thread-affecting footprint stop as uncertain; never discard them. The planner records expected affected thread IDs and SR action sets. Deleting accepted/rejected suggestions is not equivalent to deleting text.

## K8. File sources, result routes and adjacent boundaries

### Closed sources and destinations

```ts
type FileSource =
 | {kind:"semantic"; content:Text|BlockFragment|{kind:"markdown"|"html";text:string}}
 | {kind:"threadArtifact"; artifactId:string; expectedSha256:Hash; mimeType:string}
 | {kind:"driveBlob"; account:string; fileId:string; expectedVersion:string;
    expectedSha256:Hash; mimeType:string}
 | {kind:"nativeSnapshot"; account:string; snapshotId:string; selector:Selector};
type FileResult =
 | {kind:"threadArtifact"; format:"md"|"html"|"txt"|"docx"|"pdf"|"odt"|"rtf"|"epub"}
 | {kind:"newNativeDoc"; account:string; folderId:string; title:string;
    conversion?:"docx"|"odt"|"html"|"rtf"|"txt"|"md"}
 | {kind:"newDriveBlob"; account:string; folderId:string; name:string; mimeType:string}
 | {kind:"replaceDriveBlob"; account:string; fileId:string;
    expectedVersion:string; expectedSha256:Hash};
```

No arbitrary path/URL file source. A threadArtifact is resolved through authorized host thread storage, safe regular-file capture and digest, not supplied local/server paths. Existing upload tool's source shape remains unchanged; semantic adapter resolves the artifact to its supported captured source and never broadens that boundary. Drive blobs require verified subject access, bounded download and exact digest/version; a native Doc is not a blob. NativeSnapshot uses model coverage, not opaque exported bytes as edit proof. Cross-account source and destination authorities are independently pinned.

Working-copy sidecar is plugin-owned data bound to artifact ID+digest, source subject/file/version/scope, base digest and codec version. User-edited frontmatter is content, never trusted authority; tampering/missing sidecar makes the artifact a fresh explicit input, not a pushable baseline. Generated bytes are saved before preview with exact digest and package-preservation manifest. Results belong to the requesting thread or explicit Drive destination; no sharing or overwrite inferred.

| Source → result | Consent / transport route | Concurrency and verification |
|---|---|---|
| Inline semantic text/fragment → new native Doc | Existing creation/access policy, plus actual semantic/collaboration effects | Durable create/populate; acknowledged ID + revisions/readback. |
| Inline authored Markdown/HTML/text → new Drive blob | Explicit new-file creation/access review policy; no upload-source exemption for bytes actually originating in an artifact | New ID + exact downloaded bytes digest. This route accepts authored bounded text only, not arbitrary binary. Artifact-origin provenance survives conversion into a string and retains mandatory upload review. |
| Thread artifact → new Drive blob or converted Doc | **Existing upload preview and mandatory owner approval** regardless of root privacy. Saved args/source digest/mode/destination are reused exactly on apply. | Parent semantic receipt links globally unique child upload key; apply delegates that exact preview, never a new upload. Status reads both, never replays. Existing 4 MiB/binary/Office contracts remain until separately expanded and tested. |
| Drive blob → new converted Doc | New explicit import route with mandatory source/digest/conversion/destination/access review, no hidden download-to-public-host | Bounded private byte download/upload through Drive grant; created ID and bounded native readback. No whole-model fidelity claim. |
| Semantic Markdown/HTML → existing Doc fragment | Native content policy; codec/loss manifest | C; source string/artifact digest frozen; no network asset fetch except separately approved public image route. |
| NativeSnapshot → local export/checkout | Read-only Google; idempotent local artifact requestId | Source revision/view/loss manifest + artifact digest; provider export whole-file semantics distinct. |
| Markdown/Word working artifact → same-ID Drive blob | Mandatory file overwrite card; separate `docs_plan_file_write` adapter, **not** existing no-overwrite upload tool | Before version+digest and after exact bytes+digest+logical/package diff; recheck before dispatch but no CAS guarantee. Ack + downloaded bytes digest verifies bytes only; ingestion/model projection separate and may lag. |
| Native working Doc → Markdown origin blob | Same overwrite rule, three-way source conflict check | Preserve unchanged source blocks/frontmatter/comment markup; conflict artifact not force. |
| Any input → new local edited Word artifact | No Google write; explicit artifact save | Bytes digest and OOXML structural proof, no Google ingestion/rendering claim. |

Conversion and OOXML editing have **separate validators**. Reuse safe ZIP/XML/media primitives, never weaken `office-import.mjs` or `ooxml-media.mjs` to let edit-specific comments/tracked changes through import. Edit validator allows explicitly modeled tracked-change/comment parts and preserves untouched safe parts; refuses macros, signatures, active/external relationships or unknown mutation-dependent structures. Scope of OOXML editing is an engineering codec boundary, not a Google ban on editing Word table/layout/media XML. Native Docs writes against a Word blob remain a distinct unavailable route. C157 stays open N for codec expansion contracts where required; conversion does not close parity.

### Adjacent Drive/Sheets schemas and invariants

| Capability | New/extended typed input | Exact contract |
|---|---|---|
| Drive search filters | `{name?,text?,owner?,modifiedAfter?:RFC3339,kind:"nativeDoc"|"markdown"|"word"|"sheet"|"any",folderId?,driveId?,order:"modifiedDesc",pageToken?}` | No raw q. Escape literals internally. Explicit account/drive access, page/incomplete status; owner filter is not a sharing permission. |
| Rename | `{account,operationId,fileId,expectedName,newName,expectedVersion,preview:true}` then exact apply | Mandatory exact metadata review for new route, preserve ID/parents/content. Recheck comparison, no CAS claim; ack + metadata readback, no content-baseline laundering. |
| Domain/discoverable sharing | Existing exact grant/change/revoke envelope; audience `{type:"domain",domain}` or existing user/group/anyone. `discoverability:"linkOnly"|"searchable"` only domain/anyone. | Roles constrained by Drive and inspected file capability; no implicit public discovery. Mandatory saved preview/owner approval binds current permission ID/role, entire audience/domain/discoverability/notify state, ancestry and affected folder scope. Named notification remains opt-in; domain/anyone has no invented invitation switch. Existing unresolved access claims block. Lost response: same-key status, no retry. No Docs setting opt-out. |
| Rich Sheets read → Docs | `{account,spreadsheetId,sheetId,rectangle,projection:"displayRichText"}` | Bounded returned display values + runs/provenance; computed values are data, not formula execution requests. Read port delivered S11a before template consumption. |
| Docs → Sheets rich-text write | New explicit rich-text mode, not literal/formulas schema widening: `{mode:"richText",values:[[{text,runs:[{start,end,style}]}]],expectedFingerprint,...}` | Zero-based UTF-16 run bounds, closed font/size/colour/bold/italic/strike/underline subset; links only when separately supported. Mandatory preview/review. Inspect exact range, notes/styles/merges/tables/protection. Initially reject any merge/protection/table in changed footprint; this is local engineering bound, not silent unmerge. No formula object or user-entered parsing in richText mode. Verify entered text/runs and preservation; no Sheets CAS. |
| Append Sheets rows | `{tableRange:{sheetId,startRow,startColumn,rowCount,columnCount},appendAfterRow,expectedFingerprint,values,mode:"literal"|"formulas"|"parsedInput",preview:true,...}` | Fixed inspected destination, no server-inferred moving append boundary. Inspect complete declared logical table and blank target rectangle, merges/protection/table objects/notes/styles; refuse occupied/uncertain target or auto-shift. Review exact cells and footprint; recheck immediately, acknowledge possible concurrent overwrite. Use one bounded explicit cell update, not retryable values.append. Lost reply retains claim. |
| Artifact/file values and parsedInput | `{source:{artifactId,expectedSha256,format:"csv"|"tsv"|"json"},parse:{locale,datePattern?,decimalSeparator},...}` | Capture once, reject ambiguous dates/numbers, preview exact expanded typed cells. Leading `=` stays literal unless explicit formula entries/mode requested. Formulas go through existing allowlisted financial grammar; no USER_ENTERED escape. Repeated values expand boundedly before preview. Parse mode cannot bypass merged/formula/typed-format protections. |

Dropdown definitions additionally enforce the provider's 2–50 option bound before any create/update; option deletion/replacement still follows the full-reference contract.

Every adjacent write has its own product operation registration, complete comparison footprint, claim/receipt and exact readback. Sheets append and richText are new scope, not alleged existing `gsheets_update_range` support. Their no-CAS races remain visible despite successful comparison. Shared-drive listing/search does not imply shared-drive mutation support.

## K9. Provider-specific wire constraints and independent fixtures

Use actual copied official discovery SHA-256 `3948e9385816c87782b0548c577a39d240336015d2f4e63e1f40bac835f81741`; the table-scout serialization `24c050…` is semantically equal but not byte-identical. Pin the artifact actually copied into contract fixtures.

| Contract | Public semantics → wire rule | Required independent fixture |
|---|---|---|
| Image replacement | `method:"centerCrop"` only → `imageReplaceMethod:"CENTER_CROP"`; scales/crops to existing bounds and may remove effects | exact enum + size/effect preservation. A contain/resize delete-reinsert is separately named `reinsertImage`, creates new identity and discloses anchors/effects; not native replace parity. |
| Civil date chip | `{kind:"civil",date:"2026-11-02",timeZone:"America/Vancouver"}` resolves local 00:00 to UTC `2026-11-02T08:00:00Z`; time disabled. Reject nonexistent/ambiguous midnight rather than guess. | timezone/DST/date-line fixtures prove civil date unchanged. Explicit instant form accepts RFC3339 and named display timezone. No implicit UTC interpretation. |
| Date fields | Resolve and seal the UTC instant and timezone-data version in the draft before review; a timezone update cannot change approved bytes. Public dateFormat `monthDayShort|monthDayLong|monthDayYearShort|iso` maps to corresponding four writable DATE_FORMAT enums. timeFormat `none|hourMinute|hourMinuteZone` maps to DISABLED/HOUR_MINUTE/HOUR_MINUTE_TIMEZONE. locale must be in discovery allowlist; timeZone maps to `timeZoneId`. | `DATE_FORMAT_CUSTOM` and displayText are output-only; UNSPECIFIED not exposed. UTC timestamp wire is RFC3339 google-datetime string, not locale text or epoch-number guessing. |
| Named-style masks | `named_style_type` always included. Set bold uses `named_style_type,text_style,text_style.bold`; alignment includes `paragraph_style,paragraph_style.alignment` plus type. | Assert exact required nested masks and no wildcard. Empty parent style resets all nested fields only on explicit clear-all selection. |
| Page dimensions and writable paths | Public size/customSize → `documentStyle.pageSize`, mask `pageSize`; width/height each have finite positive magnitude and unit PT. Never `documentSize`. Table column width → `TableColumnProperties.width`, not `columnWidth`. | Validate request union, property refs, nested/array paths, supplied value types/enums and exact masks against pinned discovery plus reviewed request-specific restrictions. Reject nonexistent paths, read-only/output-only properties and enum values, including `defaultHeaderId`, section `columnProperties.width`, date `displayText` and DATE_FORMAT_CUSTOM. Whole-border and named-style rules below still apply; a valid schema field is not blanket write permission. |
| Paragraph borders | A changed border is complete colour,width,dashStyle,padding; user partial patch is merged against fully inspected effective/stored border or refused if unknown | updateParagraphStyle mask names whole border, no `borderBottom.width` partial request. Adjacent paragraph rendering/indent dependency is previewed. |
| Text-style side effects | Ranges may extend to adjacent newline; full list paragraph updates bullet style. Setting a value equal to parent may become inherited. | Independent before/request/after cases for newline extension, bullet style, explicit→inherit normalization and hyperlink side effects. Include induced effects in manifest; no generic normalization erasing them. |

Custom list preservation (custom markers/indents, table-contained list items, positioned attachments, overlapping suggestions) remains N engineering work with separate variants. Arbitrary list-property setters are B under C044. Fragment reconstruction is N; a native clone-any-element request is B. Native writable checked checklist state is B only where the pinned request inventory supplies no setter; importing supported list/task syntax remains N. Unknown rollout is neither B nor passing evidence.

## K10. Coverage manifest and executable join

[coverage manifest](../../../plugins/google-drive/features/docs/coverage/obligations.json) is a normalized machine-readable specification, not generated passing results. It contains every C001–C211 row, semantic variants, one unambiguous disposition per variant group, outcome profiles, operation/schema/capability bindings and independent fixture/scenario naming. All semantic entries remain `planned`. Delivered S00 cases live in a separate baseline registry; they do not close future engine obligations. No future feature is marked enabled merely because it appears here.

Expansion algorithm is normative: resolve the exact/longest-prefix binding, then modes from the BASE group's native/noCas binding independently of outcome profile. Missing native mode policy fails. Explicit fixedModes require reasons; otherwise guard/noOp modes follow the binding, with edit-only validation restricted explicitly to direct. Native eligible variants resolve direct and suggest (suggest earliest S10); edit-only supported variants also produce B `suggestRefused`, whose requestedMode is suggest. Other base profiles use the declared read/local/route/capability mode mapping. Append `__mode` to every base variant, including guards and invariants. Resolve outcome overrides separately and expand every required outcome. Every fixture/result must match the resolved requestedMode and real driver; a suggest refusal cannot be a direct guard's accepted control. C131's five native integrations bind exactly to `docs_plan_content.markdownRich` driving real `docs_plan_content` insert with a Markdown fragment and per-variant wire request sets, not the internal codec prefix. Key is `ledgerId/productOperation/resolvedSemanticVariant/outcomeVariant`. `preservation` is the sole spelling. Concrete test identity is `featureId/scenarioId/exampleId`, with exampleId `ledgerId.resolvedSemanticVariant.outcomeVariant`; outline rows contain that exact `caseId`. Repeated Feature/Scenario tags are valid; duplicated concrete caseId is not. Fixture IDs follow `fixturePrefix.semanticVariant.outcomeVariant`, unless a profile explicitly maps a non-provider/local-only outcome to a local fixture. These are planned identifiers until fixture files actually exist.

Enablement belongs to `variantExposure[operation/resolvedSemanticVariant]`, never an outcome key. Before public exposure, join ALL ledger bases matching that product variant, ALL their applicable required outcome siblings and ALL explicit dependencyRules obligations. The closure includes same-operation same-mode guards/failure/noOp cases, named cross-operation validation (e.g. style set/reset conflict), family invariants, shared writer invariants and exact authority-dispatch dependencies. Rows select all relevant invariant outcomes, with explicit staged exceptions, not an unrelated convenient case. Public lifecycle/recovery controls use kind control and their complete closure; internal invariants cannot authorize product exposure. Each required key must join schema/capability, actual driver+mode, current passed runner case and independent fixture. `deliveryOverrides` records independent per-outcome evidence only; it cannot set enabled or authorize exposure. Success with lostReply/finalAuthGate still planned fails. Direct and suggest bundles are independent. The dependency selectors and modes are explicit in JSON; no automatic mode or future-codec dependency inference. A capability binding remains a contract, not evidence of implementation. A generic row tag cannot close several missing variants. Public operation/mode/field variants lacking a manifest obligation are orphans; scenarios claiming an obligation but driving no matching operation/invariant are reverse orphans. Refusal evidence can close B/X variants only, never an N implementation variant. Reused R/P routes still require actual regression evidence, not a promise to retain them.

Outcome profile exclusions are explicit reasoned non-applicability, not missing rows. Named preflight-validation variants use the `guard` profile (guardRejected + acceptedControl + noMutation), not a fictitious successful invalid write; acceptedControl proves validation is not an unconditional refusal. These N safety obligations cannot close a sibling N product-success obligation. Provider-denial/no-substitution variants use failureInvariant with expectedFailure, same-mode permittedControl, submissionFacts, noFallback, preservation and restart; they never assert zero dispatch for an actually rejected request. C108 staleNoFallback is specifically known preflight drift (guard); deniedNoFallback is an acknowledged provider 403 rejection (failureInvariant), not a fake successful comment or no-send claim. Exact no-op variants use a separate noOp profile with no impossible lost-write requirement. All remaining outcomes are covered by each profile's explicit exclusions or the declared global profile-specific exclusions. Read-only profiles exclude approval/CAS/lost-write outcomes; no-CAS profiles use comparisonStale rather than staleRevision; B/X use refused/routed and noMutation. External gates (rendered BB, applied-code verification, scoped delivery and independent review) live in `externalGates`, with status/evidence references, never as fake Google acceptance passes. C202 has both native-host cases and rendered deferred-result gate.

S01 implements audit-negative fixtures: missing Examples/fixture; public/reverse orphan; duplicate caseId; N closed by refusal; exposed group still planned; stale result; external-gate substitution; success with missing lostReply/finalAuthGate; missing validation/invariant dependency; missing native mode; guard-to-success expansion; requested-mode mismatch; duplicate-name support replaced by refusal/unique-name control; nonexistent nested schema path, wrong dimension type/unit, output-only path/enum and invalid field mask. Research expansion checks are specification evidence only; the repository auditor must independently validate actual execution evidence. Every deliberately broken fixture must fail for its named reason. Default CI audits enabled operations; final audit additionally requires every planned N/R/P obligation closed, or records an explicit remaining engineering gap that blocks whole-program completion. No scope deletion or automatic conversion N→B is allowed.

### Named-range duplicate-name contract (R3)

`createDuplicateName` must start with one existing Shared label, create another Shared label at a different witnessed range, and verify two distinct IDs with unchanged first range. `exactIdAmongDuplicates` removes only the selected ID among real duplicate names; `explicitAllDuplicates` removes exactly two explicitly counted labels and preserves their text. These are N direct successes with separate native suggest exclusions. Only `ambiguousNameSelector` is a direct guard; its control selects one actual duplicate ID, never a unique-name substitute. Neither guard success nor refusal closes duplicate creation.

## K11. Dependency repairs and review-resolution crosswalk

| Work | Correct dependency / enablement |
|---|---|
| S00 regression | Minimal Docs runner/profile and side-effect-free real-formatting/Google-adapter/SQLite World **inside S00**, then failing reproductions and narrow fixes. Own docs-format/docs-edit/docs adapter and minimal runner/tests; no semantic engine. |
| S01 | After focused design approval, expand the delivered S00 seed to asset networking, simulator/independent fixtures and total mode-aware coverage/exposure audit with R1–R4 negatives; no future skipped-case credit. |
| S02 read projections | Structured/text projections complete here. Markdown/HTML operation variants remain planned until S12; schemas advertise only enabled formats, no mocked codec success. |
| S05 list transforms | List→heading transform closes here; table→list→heading composition remains open until S06/S07 and media variants S09. |
| S11a read interop prerequisite | Add bounded real Sheets rich-display-value read adapter/fixtures before template binding. This is read-only; adjacent Sheets rich writes stay S14. |
| S11 create | Blank/plain/structured fragments and template copy/fill close here. Markdown initial-content variant stays open until real S12 codec; no raw insertText masquerading as Markdown. |
| S12 codec completion | Enables previously planned read projections/Markdown creation and all codec-dependent variants after real integration. C176 upload regressions run before reuse here and again at S15. |
| S13 OOXML | Separate edit validator over safe primitives; existing upload/import validator unchanged. Local codec bounds are not Google hard limits. |
| S14 | Rich Sheets writes, append/parsedInput and sharing additions follow K8; C175 Sheets regressions run before reuse here and again at S15. No backward dependency from S11a reads. |

| Review finding | Concrete resolution | Acceptance/manifest join |
|---|---|---|
| 1 | K1 preserves requireDocsApproval for all native structural/content edits; suggest/collaboration/file routes separately reviewed | C023/C133/C200/C201 policy variants |
| 2 | K4 per-stage submission facts, current-call count, strict partial/save-failure claim retention | C120/C123/C186/C192/C193 and reopen variants |
| 3 | K5 local epoch/intent/dispatch linearization; async-storage barriers; remote race limits | C187/C188/C192 finalAuthGate and comparison/rejection cases |
| 4 | K2 strict draft/ref/combine/source grammar and four workflows, lifespan table; K3 witness matrix | C009/C021/C027–C029/C052/C074/C077/C099/C190/C203 |
| 5 | K6 namespace-disambiguated recovery and transactional all-namespace collision checks | C190/C196/C197 recoveryHandle/collision cases |
| 6 | K11 minimal S00 runner first; narrow files and remaining legacy gaps explicit | C186/C187/C204–C208 staged applicability |
| 7 | K7 request/mode/permission/revision/save-state table and explicit reviewed ID no-CAS route | C107–C123/C188/C189 |
| 8 | K8 source/result unions, upload-preserving consent and file/adjacent contracts | C129/C135–C176 route variants |
| 9 | K10 machine expansion/join, planned-vs-enabled, variant-level dispositions, external gates and negative audits | C205–C211 + full manifest |
| 10 | K9 CENTER_CROP, civil dates, masks/borders/newline/bullet effects; narrow N/B splits | C029/C037/C042/C084/C090/C095/C131/C157 |
| 11 | K2 short workflows/idempotent artifacts and K11 actual dependency staging | C005/C043/C124/C129/C159 |
