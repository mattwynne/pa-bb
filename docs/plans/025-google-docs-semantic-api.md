# 025 — Google Docs semantic API

## Status and scope

The design follows [ADR 0003: ports and adapters](../adrs/0003-layered-hexagonal-testing.md): all domain models and business logic in the core, thin adapters, fast core and stubbed-I/O adapter tests, and focused real integration tests. The full scope remains 211 ledger IDs across S00–S16. This is a BB-native API, not MCP. Revision 3 passed independent design review; later refinements and implementation require their own review. Design approval does not establish provider rollout or deployment.

- **S00 delivered**, baseline `57130c85762511bed4c2a47571a41ac31f7ca698`: narrow formatting acknowledgement/recovery correction and bounded post-auth checks, with 30 Docs acceptance cases and 12 existing OAuth cases. The [baseline harness](../../plugins/google-drive/features/docs/README.md) documents remaining async-policy races and replacement's lack of a durable claim.
- **S01 acceptance foundation — implemented and independently reviewed**: repository publication, executable coverage audit, independent wire contracts and closed-network harness. Verification passed 172 Docs scenarios, 12 OAuth scenarios and 771 Node tests, plus type/shared checks. No runtime code changed; no semantic product is enabled.
- **S02 partially implemented and independently reviewed**: 238 of 367 required outcomes accepted, 129 remaining; four supplemental candidates are separate from accepted outcomes. No new semantic tool is publicly exposed or deployed. Implemented read/selection outcomes use actual core/application execution with mandatory real-adapter, SQLite and native-registration companions; [test commands and boundaries](../../plugins/google-drive/features/docs/testing.md) describe their scope. Architectural/test refactoring preserves these historical facts; it does not count as new capability acceptance.
- **S03–S16 planned**: S03's atomic epoch/intent/dispatch protocol is not delivered by S00. Future features remain in scope.

## Normative documents

1. [Semantic API plan and sequential roadmap](025-google-docs-semantic-api/semantic-api-plan.md)
2. [Complete capability ledger and pinned source/licence register](025-google-docs-semantic-api/capability-ledger.md)
3. [Semantic contracts K1–K11](025-google-docs-semantic-api/semantic-contracts.md)
4. [Single machine-readable obligation manifest](../../plugins/google-drive/features/docs/coverage/obligations.json)

The manifest is the sole machine source of truth: 1,190 base variants, 1,579 resolved ledger/operation/mode combinations, **11,197 planned outcome keys**. These are not 11,197 tests. Product exposure requires every outcome sibling and explicit same-mode validation/failure/no-op and named invariant dependency. Direct and suggest are independent. Delivered baseline cases are recorded separately, not promoted into complete future families.

## Evidence boundaries

Fast tests run real domain models and application services with substitutes only at external ports. Adapter tests execute real adapters with stubbed HTTP/CLI calls. Separate integration tests establish real SQLite, process and BB guarantees; SDK-host tests retain real storage. Independent expectations, shared port contracts and required companion proofs link these results without pretending that every semantic case invoked the whole stack. A small wire simulator fails closed on unsupported requests. Pinned [official discovery fixture and attribution](../../plugins/google-drive/features/docs/coverage/fixtures/README.md) establish schema evidence, not account availability.

Develop and verify in a separate worktree, not the live plugin checkout. No test build implicitly installs or activates the rewrite. Preserve old evidence and unique regression assertions; independently review replacements before retiring expensive paths.

Revision-3 independent review resolved complete exposure closure, total mode-aware expansion, positive duplicate-name contracts and writable wire paths. S01 rejects missing named-style parent/type masks and string-valued booleans, alongside malformed dependency selectors, counterfeit execution claims and swallowed transport faults. The research checker was not a production validator. K10 uses the corrected phrase “declared global profile-specific exclusions.”

Rendered BB review, applied-code evidence, independent implementation review and scoped delivery remain separate external gates. Offline test passes cannot substitute for them. No connected-provider write, permission change, source switch or formal release is authorized by this plan. Reference implementations supply functional evidence only; no reference-program code or tests are incorporated.
