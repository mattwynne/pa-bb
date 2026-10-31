# 025 — Google Docs semantic API

## Status and scope

Revision 3 **passed independent design review**. The full combined rich-library scope remains 211 ledger IDs, implemented sequentially through S00–S16. This is a BB-native API, not MCP. Design approval does not establish implementation, provider rollout or deployment.

- **S00 delivered**, baseline `57130c85762511bed4c2a47571a41ac31f7ca698`: narrow formatting acknowledgement/recovery correction and bounded post-auth checks, with 30 Docs acceptance cases and 12 existing OAuth cases. The [baseline harness](../../plugins/google-drive/features/docs/README.md) documents remaining async-policy races and replacement's lack of a durable claim.
- **S01 acceptance foundation — implemented and independently reviewed**: repository publication, executable coverage audit, independent wire contracts and closed-network harness. Verification passed 172 Docs scenarios, 12 OAuth scenarios and 771 Node tests, plus type/shared checks. No runtime code changed; no semantic product is enabled.
- **S02–S16 planned**: no future semantic operation is publicly enabled by this publication. S03's atomic epoch/intent/dispatch protocol is not delivered by S00.

## Normative documents

1. [Semantic API plan and sequential roadmap](025-google-docs-semantic-api/semantic-api-plan.md)
2. [Complete capability ledger and pinned source/licence register](025-google-docs-semantic-api/capability-ledger.md)
3. [Semantic contracts K1–K11](025-google-docs-semantic-api/semantic-contracts.md)
4. [Single machine-readable obligation manifest](../../plugins/google-drive/features/docs/coverage/obligations.json)

The manifest is the sole machine source of truth: 1,190 base variants, 1,579 resolved ledger/operation/mode combinations, **11,197 planned outcome keys**. These are not 11,197 tests. Product exposure requires every outcome sibling and explicit same-mode validation/failure/no-op and named invariant dependency. Direct and suggest are independent. Delivered baseline cases are recorded separately, not promoted into complete future families.

## Evidence boundaries

Tests run real application services, the Google HTTP adapter and disposable SQLite, with synthetic provider/asset transports. Independent hand-authored request/readback fixtures and a deliberately small wire simulator supplement acceptance; unsupported simulator requests fail closed. Pinned [official discovery fixture and attribution](../../plugins/google-drive/features/docs/coverage/fixtures/README.md) establish schema evidence, not account availability.

Revision-3 independent review resolved complete exposure closure, total mode-aware expansion, positive duplicate-name contracts and writable wire paths. S01 rejects missing named-style parent/type masks and string-valued booleans, alongside malformed dependency selectors, counterfeit execution claims and swallowed transport faults. The research checker was not a production validator. K10 uses the corrected phrase “declared global profile-specific exclusions.”

Rendered BB review, applied-code evidence, independent implementation review and scoped delivery remain separate external gates. Offline test passes cannot substitute for them. No connected-provider write, permission change, source switch or formal release is authorized by this plan. Reference implementations supply functional evidence only; no reference-program code or tests are incorporated.
