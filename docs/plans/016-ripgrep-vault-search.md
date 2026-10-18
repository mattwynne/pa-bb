# 016 — Ripgrep-backed vault search

Status: **implementation in progress**. The owner authorized the build and chose host-managed dependencies, with the reusable Ansible manifest in this repository and private deployment configuration in the consuming infrastructure project. Installed-handler, rendered review and delivery gates remain outstanding. The original problem was an incomplete count and matches from a hidden subfolder. This is our Obsidian plugin's search, not Obsidian's built-in search or an iCloud snapshot selection.

Baseline: repository `d802645`; installed iCloud **0.2.0** and Obsidian **0.2.0**, code `1182129`. Preserve [iteration 015](015-icloud-continuous-note-access.md)'s continuous local access, native ownership and durable saves. Follow [observability](../o11y-standards.md), [UX](../ux-standards.md) and the [shipping skill](../../.agents/skills/bb-ship-feedback/SKILL.md).

## Outcome

A question such as “how many project notes have status active?” can search the complete requested scope and return a supported total, not the number found before an alphabetical cutoff. Use **ripgrep**, not a new persistent search index. **Per owner direction, there are no performance release gates. The owner will assess responsiveness in use.** Keep automated correctness, containment, lifecycle and data-safety checks; do not add a benchmark programme before delivery.

The vault is a collection of notes. Search must not infer Git branches, a main workspace, archive status or project identity from directory names. A hidden directory is still part of the vault unless the query explicitly excludes it. A folder containing copies is not evidence that the whole vault is an old snapshot.

Deliver:

- Local, ripgrep-backed literal text search without one plugin RPC per note.
- Exact top-level YAML property filters, existing tag semantics, explicit folder scopes and count-only queries through the existing `obsidian_search_notes` tool.
- True search continuation: exhausting a response/time slice preserves progress into unvisited notes. Result pages are not the same thing as search coverage.
- Correct results over the logical local view, including unapplied edits and creates, during ordinary native sync.
- Clear coverage, partial failures and count semantics. No search result grants permission to edit without the existing complete-read proof.

Do not add an index, watcher, copied vault, general shell tool, regex language, Dataview interpreter, Git integration, permissions UI, folder access restrictions or automatic connection. Do not change reconciliation, receipts, conflict resolution or native deletion semantics. `obsidian_list_tasks` and ambiguous link discovery retain their existing documented bounds in this iteration; do not imply that replacing text search makes every whole-vault tool complete.

## What failed

Source inspection established these independent limits:

| Boundary | Current behaviour | Consequence |
| --- | --- | --- |
| `plugins/icloud/adapters/note-store.ts:list()` | Recursive enumeration capped at 10,000 entries or two seconds; paths sorted afterwards | A large tree can be incompletely discovered before searching starts |
| `plugins/obsidian/core/service.ts:scan()` | At most 500 notes, 16 MiB or three seconds; reads through the iCloud adapter per file | Ordinary vaults can be cut off before later folders are examined |
| `plugins/obsidian/adapters/icloud.ts:call()` | Refreshes the catalog before each note RPC | Repeated host/plugin round trips dominate otherwise local work |
| `service.ts:page()` | Caches rows from that limited scan; pages only those rows | Next page cannot reach the rest of the vault |
| `service.ts:search()` | Literal case-insensitive text and semantic tag matching; no property or folder query | Text such as `status: active` is not a typed property query or a definition of a project |

Hidden directories are included deliberately under whole-vault access. Their lexical order exposed the coverage defect; arbitrarily ignoring them would not repair it. Existing tests proved bounded work and honest `incomplete`, not useful whole-vault search at scale. The exact limit reached in the reported call was not correlated with a trace; do not invent one.

## Query and result contract

Keep all nine public tool names. Extend the object-root schema of `obsidian_search_notes` with:

- Existing `vaultId`, `text`, `tag`, `limit`, `cursor`.
- `folders?: string[]` and `excludeFolders?: string[]`: validated vault-relative directory prefixes, matched on path-segment boundaries. Default is the whole connected scope, including hidden/nested Markdown. These are **query filters, not grants**; explicit reads/writes remain unchanged. Never silently exclude `.worktrees`, honor `.gitignore`, or assume a `Projects` directory exists.
- `properties?: Array<{ key: string; equals: string | number | boolean | null }>`: AND of exact top-level scalar comparisons. No coercion, nested expressions, arbitrary operators or inferred project schema. Preserve the existing restricted YAML rules.
- `mode?: 'results' | 'count'`, default `results`. Count unique `(vaultId, relativePath)` notes, not matching lines. Copies at different paths are distinct notes unless an explicit scope excludes them; this is not a deduplicated count of real-world projects.

Example on a **generated** vault whose schema defines projects by folder:

```json
{
  "folders": ["Projects"],
  "properties": [{ "key": "status", "equals": "active" }],
  "mode": "count"
}
```

Do not assume that schema for an owner's vault. Ask or use supplied evidence if “project” is ambiguous. Bound input as well as execution: retain the 256-character text limit; start with at most 8 property predicates, 128-character keys, 4-KiB scalar strings and 16 folder prefixes per include/exclude list. Validate prefixes with the existing relative-path rules; reject an explicitly empty include list rather than reinterpret it silently. Existing text-only calls continue to mean literal text search. Define case-insensitive matching by ripgrep's Unicode semantics; test and document differences from the old JavaScript lowercase comparison. Preserve literal multiline queries rather than silently treating their lines as alternatives.

Return bounded results plus:

- `coverage.state`: `running`, `complete` or `partial`.
- Visited-note count, processed/skipped/error counts, applied scope and fixed incompleteness reasons. Directory discovery and semantic filtering must both finish before `complete`.
- `matchedNotesSoFar`; `totalMatches` is a number **only after complete coverage and filtering**, otherwise null. A partially visited scope cannot produce a purported total, even when it has no hits.
- `nextCursor` while traversal, filtering or result delivery has more work. An empty result page with a continuation means “keep searching”, not “no matches”.
- `incomplete` retained for compatibility and true until coverage completes, or after any unresolved omission. `nextCursor: null` on a terminal partial failure must not imply completion.
- Observation times and a per-note consistency statement. A complete traversal is **not** an atomic snapshot of a changing vault. Do not claim a point-in-time project inventory during concurrent edits.

Tool descriptions and agent instructions must explicitly require following continuations to complete coverage before giving a total, including empty pages and count-only queries. Do not leave the owner to ask “search the rest” manually. A terminal failure or expiry is different: explain that a total is unavailable rather than endlessly retrying the same prefix. Test the original registered handler through an immediate-continuation driver; do not claim that driver proves a model followed the instructions.

A continuation binds normalized query, mode, connected vault IDs, configuration revision and local source identities. Reject conflicting new filters with an existing cursor; do not silently ignore them. Page size can change. Cloud phase, successful sync timestamps and ordinary Pause/disconnection do not by themselves revoke a sound local search. Removal, source/root replacement, lost ownership, runtime restart and cursor expiry do. Never replay a partially delivered session automatically after expiry.

## Architecture

### 1. iCloud owns file searching; Obsidian owns note semantics

Add an authenticated, versioned search capability and bounded search/cancel RPCs to the iCloud note interface. Exact names can be finalized in the first implementation slice; the required operation is **start or continue one typed query**, not accept a command, arbitrary path, executable, shell fragment or caller-supplied flags. Scope by negotiated revision and explicitly connected mirror IDs, with the same host-verified Obsidian caller as existing note RPCs.

Run enumeration and ripgrep in iCloud's process boundary beside the authoritative logical files. Obsidian must not receive a root directory and run its own command. A logical query may span all connected vaults; schedule its vault lanes fairly rather than create a separate unbounded job per vault. Support the existing maximum of 20 connected sources.

Separate generic file matching from Obsidian syntax:

- **Text only:** iCloud returns a first-match citation, bounded snippet, logical path and validated whole-note hash for each matching note. No follow-up `noteRead` per hit just to produce the result.
- **Properties:** conservatively identify possible frontmatter, then return bounded raw frontmatter with original offsets/hash in candidate batches. Obsidian parses and compares it with the existing safe YAML implementation. A prefilter must include every supported quoted-key, flow-map, multiline-scalar, BOM and CRLF form; scanning all notes with frontmatter is preferable to a fast but unsound key/value regex.
- **Tags, or combined semantic filters:** return the necessary bounded candidate Markdown in batches and use `MarkdownNotes`, not a regex pretending to understand code blocks, comments or YAML tags. Text prefiltering is safe when the combined query also requires that text. Never use a prefilter with false negatives for a supported semantic query.
- Extract a frontmatter-only reader from `markdown-notes.ts` so a small valid header does not require a full Markdown AST or fail merely because the body exceeds the current AST budget. Keep YAML restrictions and limits. Existing full-body tag parser limits remain explicit partial outcomes, not false negatives.

Only validated hits or candidates cross plugin RPC, in bounded batches—not every file through a separate `list`/`read`/catalog cycle. Bound RPC payloads in serialized bytes as well as rows. Count mode aggregates after semantic validation without retaining or returning every matching snippet. Literal-only count mode can use compact producer matches, but must satisfy the same coverage and file-safety rules.

### 2. Search the logical view, not stale mirror bytes

Use a query reader/pin interface in `note-overlay.ts` and `note-store.ts`:

1. Enumerate eligible mirror note paths and union active overlay-only creates. Do not route through the old terminal 10,000-entry/two-second listing.
2. For each path, select the active logical overlay head when present; otherwise use a safely opened mirror note. A shadowed mirror match must not survive when the overlay no longer matches, and a pending match must not be missed because the mirror differs.
3. Hold short per-path/blob barriers only to acquire and validate a reader; retain the reader while that batch is searched. Retirement, resolution and garbage collection cannot invalidate its bytes. Do not hold all path locks, a SQLite transaction or the native-command arbiter for the whole search.
4. Preserve regular-file checks, byte limits, strict UTF-8/NUL handling, hashes and exact file/path identity validation. Define before/after observations for every scanned file, including non-matches; do not silently accept unreadable or unstable files as no matches. Retry a changing file locally within a bounded budget, then report the omission honestly.
5. Recheck current revision, membership, source identity and ownership before publishing each response. A new query started after a local save must see that save. A query already running has per-note observations, not a frozen whole-vault snapshot; document and test concurrent changes without claiming global isolation.

Search acquires neither native idle nor the global command queue. Preserve the running generation's actual inherited flock ownership and lifecycle fences. Search children never receive the native worker lock as an accidental inherited descriptor. Close admission/cancel searches on disposal or revocation; verify child exit and reader cleanup before declaring the generation drained. Do not let an abandoned query indefinitely delay shutdown or new durable saves.

### 3. Ripgrep invocation and containment

**Do not implement `rg <mirror-root>` and trust `--no-follow`.** A checked pathname can be replaced before ripgrep opens it; a new fast path must not bypass the existing fd-relative `O_NOFOLLOW` containment.

Preferred implementation to prove first: securely enumerate/open a bounded batch of regular logical-note readers; pass **only those read-only descriptors** to ripgrep. Search explicit child descriptor paths such as `/proc/self/fd/N`, with a private descriptor-to-logical-path mapping. Validate ancestors and revalidate identities through the existing anchored traversal. Never publish descriptor paths or accept them from a tool caller. A process already holding a file descriptor cannot be redirected by a later symlink swap.

Use fresh or explicitly reset readers per invocation/retry; inherited file descriptions can share offsets. Hashing/validation must not leave a reader at EOF. The local design probe caught this pitfall, then passed after using fresh readers. Prove the actual Linux `/proc` behaviour rather than treating the local probe as Linux evidence.

Invoke with asynchronous `spawn`, an argv array, no shell, `--no-config`, machine-readable output, explicit literal/case/encoding behaviour, no mmap, a bounded thread count and an option terminator. Disable user-configured preprocessing and environment-based flag injection. First-match-per-file output is sufficient for the existing one-row-per-note search; use it without confusing an output limit with vault coverage. Keep literal multiline semantics. Treat exit 0 as matches, 1 as ordinary no matches, and 2, spawn failures, signals or malformed output as failures—not empty success.

Drain stdout incrementally with backpressure; bound individual machine-output frames, snippets, candidate RPC JSON and stderr capture, including a one-MiB single-line note and escaping expansion. Use NUL-delimited generated descriptor names and numeric line prefixes for ripgrep output: JSON submatch arrays can amplify a repeated literal into unbounded work even with one matching line. Preserve fixed-string matching and retain every bounded RPC response remainder. Kill/await children on cancellation or quota violations. Never log raw stdout/stderr or ripgrep exceptions: matches, patterns and paths can be private. Candidate data returned to the authorized consumer is not diagnostic data.

The first Linux mechanism check must show descriptor inheritance, Unicode/multiline matching and unchanged safety. If it cannot preserve those properties, stop and revise the mechanism. No throughput or latency threshold blocks delivery. Do not weaken containment, copy the whole vault or substitute a persistent index.

### 4. Real continuation with bounded resources

A search session owns its discovery frontier, progress, pending candidates/results and totals. Cursor state lives in memory, not in the durable note ledger. Resume unvisited directory entries/files and unfinished semantic filtering; never start again at the first alphabetical path for each page. Deduplicate overlay/mirror paths and repeated traversal observations by logical path within the session. Ordering may be traversal order; do not require collecting/sorting the entire vault before delivering a first page.

Bound buffers and pause work under backpressure instead of ending coverage after 500 rows. Close file readers between work slices when they are no longer needed. Bound enumeration state and directory handles too; retain the existing supported path rules rather than introducing an unexplained short nesting limit. Fairly interleave multiple vaults and searches. Count mode must complete for more than 500 matches without fetching hundreds of result pages or retaining their note bodies.

Initial resource envelope to validate, not a measured guarantee:

| Resource | Proposed bound / behaviour |
| --- | --- |
| Active sessions | 4 globally; at most 2 running ripgrep children, one bounded-thread child per active batch |
| Batch readers | Start at 64 note descriptors; account separately for bounded directory handles and verify cleanup at OS descriptor limits |
| RPC work slice | Yield cooperatively with a real continuation; a watchdog aborts a wedged child. Slice length is a resource-management choice, not a latency release gate |
| RPC candidate payload | At most 1 MiB serialized; use bounded frontmatter/full-Markdown projections within their parser budgets and compact text hits for larger notes; check escaping/framing behaviour in the mechanism tests, never silently drop a valid candidate |
| Tool result | Preserve the existing 48,000-character page / 64,000-character final response bounds and maximum 50 delivered rows |
| Session memory | Aim for 32 MiB per session, 128 MiB aggregate incremental budget; include path/frontier/dedup/JSON buffers, not only rows |
| Lifetime | 5-minute idle expiry, 30-minute absolute lifetime; disclose expiry, cancel/reclaim eagerly and never pretend expired work completed |

These are scheduling/storage protections, **not** performance gates or 500-note, three-second or 10,000-entry scope caps. Genuine resource exhaustion can still produce a terminal partial result with a fixed reason. The correctness fixtures below must finish, without a completion-time target; safe truncation alone does not prove complete search. Check that the limits are enforced and cleanup works, and disclose any changed bounds. No profiling or benchmark pass is required.

## Host dependency, compatibility and UI

Ripgrep must be available to BB's service user, not just an interactive coding agent. Read-only host inspection found no installed ripgrep package and no `rg` on the service user's PATH. Generated Linux tests passed with stock **14.1.0**. The owner chose a [project-owned Ansible manifest and role](../../provisioning/README.md), consumed at a pinned revision by the infrastructure project. Keep inventory, VM/container configuration, users, mounts, service lifecycle and deployment notes out of this public repository. Do not make the plugin invoke sudo, download an executable at runtime or depend on an agent's private tool path. No host package has been installed yet; dry-run, apply, verification and repeat-run evidence belong to the private deployment record.

Add explicit search capability/version and prerequisite state without changing note access v2's read/write negotiation. Missing/unsupported ripgrep disables **search only**, not sync, saves, exact reads, discovery or existing vault connections. A new consumer on an old producer reports an actionable search incompatibility; it does not silently fall back to the defective scanner. An old consumer on a new producer keeps its existing RPCs. This is an additive search interface, no storage migration or new activation switch. Verify both mixed orders and strict schema handling before relying on that claim.

Use the existing Obsidian `ConnectionAlert` for one quiet connected-state warning when search is unavailable: “Vault search is unavailable. Ask the host operator to check the search requirements.” Link the guide; retain connection rows, local availability and Check again. Do not say “disconnected” or ask for another vault connection, credentials, terminal commands, or permissions. No new search settings, headings or UI browser are needed. Inspect the actual host/comparable connected view before implementing the warning. Apply the local UX skill and review ready, missing binary, unsupported binary, producer mismatch and recovery at desktop/narrow widths with keyboard focus in actual disposable BB. Existing first-run screenshots are baseline evidence only, not a passing review of this change.

## Implementation sequence and files

Work sequentially on `main` under repository instructions; no parallel implementation agents or worktrees.

1. **Linux mechanism check and failing regressions.** Generated roots only. Prove descriptor-based ripgrep and containment. Capture the current scanner's incomplete result beyond its old cutoffs as a red test. Set query/coverage schema, process flags, byte framing and resource bounds before wiring production. Stop only if the mechanism cannot meet correctness or safety requirements; do not require a performance spike.
2. **Producer search reader and engine.** Add `adapters/note-search.ts` (proposed), bounded safe enumeration/reader helpers in `note-store.ts`, logical-head reader pins in `note-overlay.ts`, and search session admission/cancellation in `note-runtime.ts`. Preserve all durable-write paths. Add lifecycle/process/security tests before RPC wiring.
3. **Capability and batch transport.** Extend `core/note-contract.ts`, public `contract.ts` and the identical consumer copy in `plugins/obsidian/adapters/icloud-note-contract.ts`. Register caller-verified search RPCs in iCloud `server.ts`. Add safe `note_search` diagnostics and sentinel tests in `adapters/diagnostic-log.ts` and affected core types. Keep failure fields fixed; never expose an executable path or raw error.
4. **Consumer semantics and true paging.** Add a typed search port to `plugins/obsidian/core/ports.ts` and implement it in `adapters/icloud.ts`. Replace search's use of `scan()`/row-only cursor state in `core/service.ts`; do not accidentally change task parsing or grant complete-read proofs. Extract the frontmatter reader in `adapters/markdown-notes.ts`. Extend only the existing search tool's schema/description and agent instructions in `contract.ts`/`server.ts`; keep object-root provider schemas and reject ambiguous cursor/filter combinations. Update fake, host, service, boundary and feature tests.
5. **Prerequisites and narrow UI.** Add capability status and the existing-style warning to Obsidian settings/`app.tsx`, guides, plugin READMEs and portable host requirements. Preserve IDs, connected names, pending operations and readiness of unrelated tools. Run actual rendered review, not just component snapshots.
6. **Installed proof and controlled delivery.** Run generated workloads in actual Linux BB with the unchanged original registered search handler and verified caller path, then affected full checks. No new provider conversation is authorized by this plan; the prior authorized conversation has been consumed. An actual model/provider validation needs separate authorization and must not be relabelled as covered by a fixture bridge. When implementation is approved and verified, follow the shipping skill for only iCloud/Obsidian, recording versions and restoring exact prior enablement. Pause/drain sync and keep both plugins disabled through both managed completions as in iteration 015. No personal-note query or write solely to prove deployment, no baseline resets and no automatic connections. Observe read-only readiness, a normal scheduled completion and bounded diagnostics; report any unverified gate explicitly.

The owner has authorized implementation and selected managed host provisioning. Keep that work reproducible through the shared manifest and the consuming infrastructure dependency; do not substitute a one-off package installation.

## Acceptance tests: usefulness as well as safety

### Complete search beyond the old cutoffs

Use deterministic generated Markdown, including hidden folders and duplicate copies. Independently compute expected path sets and typed-property counts from the fixture generator—not from the search implementation. A correctness fixture of **12,000 small notes**, more than **16 MiB** total and at least **600 matches** crosses the former entry, byte, note and result cutoffs; put matched and unmatched notes at the end. Force work-slice yields in unit tests so continuation correctness does not depend on machine timing. Cover 20 sources with small fixtures and include a source with no matches. There is no 100,000-note benchmark or timed acceptance run.

Required correctness:

- Exact expected path sets through genuine continuation, with no missing/duplicate logical notes; zero-hit queries complete instead of returning an incomplete empty prefix.
- Count-only results equal the generator's oracle for text, properties and combined filters, including more than 500 hits. Returned totals remain null until complete; unreadable notes prevent an unqualified total. Invalid/unsupported metadata prevents a total for queries that depend on it, but unrelated YAML errors must not break an otherwise valid literal-text query.
- Scope tests for root/nested/hidden folders, explicit exclusions, `.gitignore`, prefix boundaries and identical content at distinct paths. No inferred main workspace or automatic worktree exclusion.
- Text/property distinction: body prose, YAML comments or `inactive` must not satisfy `{status: active}`. Cover quoted keys, scalar types, multiline scalars, CRLF, BOM, empty/malformed headers, unsupported YAML features, and long bodies with small valid headers. Preserve tag/comment/code semantics.
- Multiline and Unicode literal text, option-like patterns, large single lines, 1-MiB notes, unsupported files, output escaping and more matches than result buffer capacity.

### Owner performance feedback

The owner will test responsiveness after delivery. Do not require p95/max latency thresholds, completion deadlines, repeated-query measurements, cache comparisons, a profiling report or a large-vault performance fixture. Do not query personal notes to benchmark the change. If the owner reports a speed problem, investigate that concrete problem then.

Keep resource limits, cancellation, safe cleanup, complete coverage and truthful totals as correctness requirements. Search and saves must remain usable during native activity rather than explicitly waiting for native idle, but there is no additional timed workload gate for this iteration.

### Logical edits, concurrency and lifecycle

- A saved overlay-only create matches immediately; an unapplied edit can add or remove a hit despite opposite mirror bytes. Count mode and mixed filters see the same logical version.
- Search and saves during a real native run, plus application, retirement, conflict retention and maintenance; no temporary loss or duplication of a logical path. Reuse existing native regression coverage rather than add a timed long-sync benchmark. Incoming/recovery/old generations are not searchable as current notes.
- Concurrent directory/file publication: stable returned hashes/citations or explicit bounded omissions, no fabricated atomic snapshot. Complete-read/CAS requirements remain unchanged.
- Cancellation, abandoned cursors, result backpressure, zero-result continuations, expiry, process death, restart, disposal, removal and source replacement; no surviving children or leaked descriptors, no responses after revocation. Configuration fences remain effective at cached-page delivery too.
- Directory/file symlink swaps between discovery/open/child execution, special files, traversal attempts, malicious patterns/config, stderr sentinels and nonexistent/unsupported executables. Assert no bytes outside selected logical note readers reach either results or logs.
- Two concurrent broad searches and ordinary saves, plus 20-source fairness. Native sync must continue making progress; do not trade the old save outage for search-induced starvation.

### Independent installed/UI and regression gates

Run affected typechecks, build/spec/package tests, copied-contract equality, shared UI checks, existing Linux ownership/storage/crash/CAS suites and new real-ripgrep Linux tests with zero skips in the targeted acceptance run. Retain Mac platform skips as separate evidence. Compare actual BB original-handler results to the independent generator oracle, record exact installed versions/commit and inspect desktop/narrow screenshots. Failure diagnostics must use only fixed categories with no generated private sentinel leakage.

Release still needs functional installed-handler evidence, safe diagnostics and applicable rendered review; a passing build or safe truncation alone does not establish correctness. Record precisely which layer was exercised. Performance acceptance belongs to the owner. Exact Apple/device delivery is outside this search change.

## Design evidence and remaining decisions

A local generated two-file descriptor probe with ripgrep 15.2.0 passed case-insensitive literal matching, literal multiline matching, option-like input treated as text, and exit-1 no-match handling. It also exposed shared descriptor-offset reuse; fresh readers corrected the probe. These are feasibility observations, not Linux security, large-vault performance or installed-handler proof. Scratch roots were removed. No personal note content was read.

At the start of approved implementation, resolve the actual supported Linux ripgrep version, safely bounded discovery frontier/directory handles, reader validation/hash correctness, semantic candidate byte framing and end-to-end cancellation supported by BB's actual SDK. These correctness/safety decisions do not require a performance spike and do not permit bypassing ownership or quietly reinstating the old scanner.
