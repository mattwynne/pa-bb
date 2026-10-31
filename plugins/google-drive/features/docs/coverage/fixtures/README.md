# Independent test fixtures

`docs-discovery.json` is the exact official Google Docs v1 discovery response,
revision **20261026**, SHA-256
`3948e9385816c87782b0548c577a39d240336015d2f4e63e1f40bac835f81741`.
Source: <https://docs.googleapis.com/$discovery/rest?version=v1> (mutable URL;
the digest pins the bytes used here). Google API definitions are provided by
Google; see <https://developers.google.com/terms/site-policies> for attribution
and licensing (documentation CC BY 4.0; code samples Apache 2.0). This fixture
is test-only, not a runtime dependency or proof of live account rollout.

All other vectors are original synthetic, hand-authored contracts derived from
[official requests](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request).
They do not copy any reference library's code, tests or prose. Expected values
are literal data, never produced by production planner/compiler/verifier code.
The fixture index pins file digests and authorship/source provenance; runner
attachments bind executed case identities to those exact bytes. Authorship
metadata alone cannot establish a pass: the auditor requires actual files,
current Cucumber results and matching registered drivers/modes.

Only explicitly supported request validators may validate payloads. Structural
checks of planned mappings do not assert that future payloads are verified.
The simulator supports only the legacy text formatting/replacement vectors;
it is not a Google emulator, semantic planner or verification oracle.
