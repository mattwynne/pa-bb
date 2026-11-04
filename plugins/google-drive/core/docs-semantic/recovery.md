# Unregistered read-only operation status

`docs-operation-status-tools.mjs` defines, but does not install in the serving
plugin, the strict K6 `docs_operation_status` tool. It accepts account plus a
historical operation key and optional closed receipt kind, or account plus a
canonical catalog handle. Neither selector is execution authority.

The core searches every retained namespace for the SQL-filtered subject before
provider access. Ambiguity includes unsupported candidates. Semantic metadata
uses the existing validated local draft/execution/evidence readers even in
ambiguity; a self-consistent JSON hash alone is not a valid draft or runtime.
Legacy codecs keep SQL lifecycle separate from older JSON lifecycle and preserve
absent/null/false flags. Decoder tags describe interpretation, never a backfill.

Current observations support semantic runtime v2 (bold/1, replacement/1 and /2),
legacy formatting including explicit page-only structured preservation, and
inline-image location/source URI/dimensions/preservation. Saved canonical expected
shapes are checked before any GET. Image ACK fields must be a valid pair; absent
both can support an explicitly unattributed comparison but cannot supply ACK.
Private native-document title/text hashes plus concrete ID/destination, and copy
metadata/marker with valid declared source binding, have narrow observations.
Shared native creation, upload/conversion, Sheets edits, sharing and filing/task
remain historical metadata without a provider verifier in this first edition.
Unknown versions, damaged bindings or insufficient expected state remain retained
unsupported; they never disappear in favor of another namespace.

The read store exposes only SELECT operations and existing validated local reads.
The HTTP adapter exposes only fixed userinfo, Drive metadata and Docs GETs, using
bounded **fatal UTF-8** decoding. Core credential policy requires a still-valid
cached token and matching verified userinfo subject/email. It never refreshes,
updates email/token caches, inspects assets or requests new grants. Expiry, denial,
identity drift or unavailable readback produce unavailable observations.

All status calls have mutation count zero and retrySafe false. Recovery projects
K4 ACK/rejection/save facts from the validated retained runtime response, not the
closed persisted stage or a current GET. A recorded UNKNOWN collaboration-save
value projects conservatively as UNSPECIFIED; the bounded response facts retain
UNKNOWN separately. No raw provider body is exposed. Historical ACK,
verification and claims are not changed by current matches or drift. The selected
raw rows, accounts and semantic evidence are checked again after the network read;
concurrent advancement returns changedDuringObservation without stale attribution,
saving, retrying or rolling anything back. No SQL transaction spans a provider
await. Observations are not permission, atomicity, rendering/image-byte fidelity,
creation-population ACK, a safe retry or an unlocked write path.
