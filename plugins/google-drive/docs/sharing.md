# Approved file and folder sharing

`gdrive_change_sharing` proposes or applies **one direct permission** on an explicit connected account and exact file/folder ID. It always requires native BB owner approval; **Require approval for Google Docs edits** does not affect sharing. There is no sharing-approval bypass setting. No ownership transfer, domain grants, recursive rewrites or other Drive management is included.

## Supported requests

Use a fresh lowercase UUID `operationId` for each new intention. Default `preview:true` inspects live metadata, permissions, complete bounded ancestry and existing write scope, then saves the proposal without changing access. Apply with the **same arguments/key**, changing only `preview:false`. BB shows the exact item/account, audience, current/proposed permission, notification behavior, exposure and folder impact. Approval expires ten minutes after the initial preview. Repeated previews return the saved receipt rather than refreshing it.

```json
{
  "account": "owner@example.test",
  "operationId": "f067bf54-b93f-450e-a622-71f63ddde3ef",
  "fileId": "exact-item-id",
  "action": "grant",
  "audience": { "type": "user", "emailAddress": "recipient@example.test" },
  "role": "writer",
  "notify": false
}
```

- Named grants accept `type:user` or `type:group`, an exact email address and reader/commenter/writer. A group affects members not enumerated here and later membership changes. An existing matching permission must be changed, not granted again.
- Public-link grants use `audience:{"type":"anyone"}` and reader/writer. The adapter always sends `allowFileDiscovery:false`: **anyone with the link**, not publicly searchable/discoverable. A forwarded link may expose the item to others. Public commenter and discoverable grants are not supported.
- Change: `action:change`, exact `permissionId` from `gdrive_inspect_sharing`, and role (no audience/notify). Changing an existing discoverable public permission explicitly reduces it to link-only; both current and proposed discovery states are shown.
- Revoke: `action:revoke`, exact `permissionId` (no audience/role/notify). Removing public-link access does not remove named, domain, group or inherited access, or copies already made.
- Unspecified permissions and owners are preserved. Effective access may remain broader through another route; a named downgrade is not a guarantee that a person loses broader access.

## Authority, ancestry and folder effects

This conservative implementation supports **owned My Drive items with fully inspectable, owned My Drive ancestry**. It blocks shared drives, shortcuts, limited-access ancestry, orphan/ambiguous parent chains, missing authority, incomplete listings, pending ownership and unsupported permission forms. Only unambiguous direct user/group/anyone targets can change. Expiring targets, owners and domain targets are not editable. Unsupported domain/organization restrictions are not overridden; Google may still reject a permitted-looking recipient.

Google's `permissionDetails` does not establish My Drive directness when absent. The adapter drains up to ten permission pages per inspected item and walks a single parent chain to the resolved My Drive root (at most 32 ancestors). A matching ancestor grantee/permission is conservatively treated as inherited, even if it could also have a direct grant. It will not edit ancestors to work around that refusal. Inaccessible, unowned, ambiguous or truncated ancestry blocks a proposal. This is a deliberately limited authority check, **not** exhaustive audience enumeration: group members, implicit domain access and other policies can remain unknown.

A folder change can affect contained items inheriting that permission, including future items. Descendants are not enumerated or rewritten. The approval states this explicitly; no claim is made that every contained item has identical permissions. Other permissions, ownership and independent descendant grants remain untouched.

## Consent and notifications

The adapter checks the connected identity and existing `drive` or `drive.file` scope before preview and before submission. Read-only/Docs-only grants cannot share. Installing this code never changes OAuth grants, credentials or approval settings. A scope does not itself prove authority over a file; metadata and ancestry checks still apply.

Named grants default to `notify:false`, explicitly sending `sendNotificationEmail=false`. `notify:true` opts into Google's sharing email for that recipient and is displayed in approval. Public grants reject notification opt-in. Google's permission update/delete API exposes no notification switch: the tool requests no invitation but cannot promise suppression of every Google service notification. Readback does not verify mail delivery. No custom email body is accepted.

## Staleness and concurrency

After approval the adapter re-inspects the reviewed target, authority, permissions and ancestry and compares the entire normalized snapshot. Any change or expiry prevents submission. A plugin-owned SQLite reservation serializes active/unresolved changes for an exact item across connected accounts and process restarts. Duplicate calls/key conflicts never submit another mutation.

Google Drive v3 permission mutations expose **no revision/CAS precondition in this integration**. A local lock cannot prevent another Drive client racing the final read/write. The plugin does not invent an ETag or Google idempotency guarantee. It makes exactly one POST/PATCH/DELETE, with no retries even for timeouts, 401/429/5xx or unreadable replies. Definite 400/401/403/404/409/412/422 refusals consume the key as `rejected`; timeouts, rate limits, server errors and unreadable replies stay unresolved. Post-write readback checks the exact target permission/ID, preservation of all other Google-visible permissions and reviewed context. A mismatch is uncertain, not silently rolled back.

Reference: [create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create), [update](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/update), [delete](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/delete), [permission resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions).

## Durable recovery

Keep the account and `operationId`. `gdrive_sharing_status` only inspects; it never replays a write or invitation, removes another permission, or performs rollback.

Receipts persist the request, reviewed permission snapshot and target/audience details in the plugin-owned database. They contain account content necessary for exact recovery, but no credentials. Logs contain only fixed stage/category codes and bounded HTTP status classes, never target names, account/recipient addresses, IDs, arguments or provider bodies. BB owns the database backup lifecycle.

- `proposed`: saved preview only, no approval/write. Applying requests approval.
- `declined`, `cancelled`, `expired`, `stale`, `not_submitted`: no mutation was submitted by this operation; the key is consumed. Inspect before requesting a new intention.
- `rejected`: a definite Google request/authority/policy refusal, not a successful change. The key is consumed but the item lock is released. Inspect live state before any separately requested new proposal; no automatic retry occurs.
- `reviewing`: approval in progress. A recovered interrupted review can be cancelled locally; its old continuation cannot pass the conditional writing transition.
- `writing`, `uncertain`, `verification_unavailable`: no completion claim. A request may have applied despite a missing reply/receipt. The item remains blocked until exact read-only reconciliation succeeds. The blocking operation ID is reported on a competing apply.
- `verified`: exact permission and other visible permission readback matched, **not** proof the recipient can open the document, exhaustive privacy, which actor performed a matching recovered change, or notification delivery. Repeated change calls return historical receipts only. Status performs a fresh observation.
- `changed_since_verification`: a fresh status no longer matches the historical verified result. It does not seize a new unresolved lock or undo later authorized work.

A lost create-permission reply is reconciled only when exactly one matching grantee has the expected role/discovery, ID (if known), unchanged other permissions and context. Update/delete use the saved exact permission ID. Unknown/changed IDs, duplicate grantees, changed context or unrelated permission changes remain unresolved. An unchanged/absent permission after a timeout does not establish that a request can never finish later. Do not generate another key to bypass that lock. Inspect in Google Drive and seek operator review; there is deliberately no automatic force-unlock, retry or hidden rollback.

Synthetic tests and disposable native-BB approval review cover these paths without real permission changes or invitations. Actual Google write/readback and end-recipient access remain unverified until a separately authorized user task uses the tools.
