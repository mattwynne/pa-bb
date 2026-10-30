# Create a native Google Doc

`gdocs_create_document` creates one new Google Doc and inserts its initial plain
text as a single user-requested operation. Search/read, copying an existing file
and single-run text replacement could not previously create and populate a new
native Doc. This tool fills that gap without a general-purpose write proxy.
It does not copy a template. Choose
an explicit connected account, title, destination and fresh lowercase UUID v4:

```json
{
  "account": "writer@example.com",
  "operationId": "fe638131-e722-4d66-9712-05dd34650283",
  "folderId": "root",
  "title": "Interview reflections",
  "text": "Thank you for reflecting on our work together.\n\n1. What helped?\n\nKallee:\n\nSharon:\n\nLily:\n\n2. What could improve?\n\nKallee:\n\nSharon:\n\nLily:"
}
```

Use a **new UUID for each genuinely new request**, not the example key. Keep the
same key throughout an interrupted operation. The account must already have an
owner-authorized `drive` or `drive.file` write grant. Existing read-only or
Docs-only grants cannot create through this tool. Installing code does not
upgrade grants; only the owner can authorize supported Settings reconnection.
No OAuth scopes, approval settings or credentials are changed by creation.

As with `gdrive_copy_file`, creation is authorized by the user's explicit
request and existing Google write consent. Shared destinations additionally require a per-operation owner review; this is separate from the replacement-only approval
card/setting. The global **Require approval for Google Docs edits** setting
continues to govern `gdocs_replace_text` only. Do not interpret a request to
implement this capability, test it, or draft text as permission to create a real
document or contact respondents.

## Destination, content and visibility

- `folderId` is required. `root` selects the connected account's My Drive root;
  use it unless the user selected a folder. There is no implicit account or
  destination selection.
- Other IDs must identify an explicitly selected writable My Drive folder. The existing owner-only check remains for visibly unshared owned folders. Shared or non-owned parents require complete bounded ancestry and permission evidence, direct visible user owner/writer authority, and an exact owner review. Shared drives, unknown authority and incomplete evidence are rejected. This deliberately supports fewer destinations than copying.
- There are no permissions mutations, sharing links, invitations or respondent
  notifications. Root is the privacy-preserving default choice, but Google or
  organization policies and later changes still control access. Provider-visible
  checks are not a general certificate of privacy. Do not broaden permissions.
- Titles are 1–255 UTF-16 units; initial text is 1–40,000, excluding whitespace-only
  values, malformed Unicode and unsupported controls. Use LF (`\n`) for paragraph
  breaks and blank lines. CRLF, tabs, private-use characters and line separators
  are rejected rather than silently rewritten.
- Text is literal, **not Markdown or HTML**. Use plain numbered questions and
  answer labels, separated by blank paragraphs. Google default paragraph styling
  is used; rich styling, tables and embedded objects are out of scope. Google's
  final body paragraph newline is additional to the supplied text. Verification
  checks this exact body text, title and destination, not visual formatting.

## Outcomes and recovery

Only `outcome: "verified"` confirms that the title, explicit parent and complete
single-tab body text were read back exactly. The result includes `documentId`
and a usable `https://docs.google.com/document/d/…/edit` link when known.

Creation uses one Drive metadata POST followed by one revision-guarded Docs
insert POST. These requests cannot form a provider transaction. A failure may
leave a blank document; the tool never deletes it to hide a partial result.
Neither POST is retried, including on 401, timeouts, 429 or server errors.

Before the first POST, the plugin durably reserves `operationId` in its own
SQLite database. Same-key calls (including concurrent calls and after reload)
return the receipt and **never write again**. Changing the account or content
under a consumed key is rejected. Receipts retain hashes and IDs, not the title,
body or credentials, and are not automatically evicted: they prevent duplicates.
This is same-key replay prevention, not provider-wide idempotency; a new key
could create a duplicate and must never be used to bypass uncertainty.

For `reserved`, `created`, `uncertain`, `incomplete` or
`verification_unavailable`, retain the operation key and call:

```json
{"account":"writer@example.com","operationId":"fe638131-e722-4d66-9712-05dd34650283"}
```

with **`gdocs_creation_status`**. This tool only reads Google and updates the
local receipt. If no ID was received, it searches a private app-property marker,
not the title, then verifies the known document. It never creates, populates,
shares or deletes. An empty, incomplete or ambiguous lookup is **uncertain**,
not evidence that creation failed; indexing can lag. Do not automatically retry,
populate a partial document, or generate another key. Inspect any returned link
and reconcile with the user. Unknown-account/unknown-receipt errors also do not
authorize recreation. A reserved receipt reports `writeAttempted: "unknown"`
because the process might have stopped on either side of submission.

`not_created` means a known pre-submission failure or definitive creation
rejection. The key remains consumed. A rejected POST can still have
`writeAttempted: true`; it was submitted but not applied. Resolve the blocker
before a separately requested new operation. A result with `receiptOnly: true` from a repeated create call is historical;
that call neither wrote nor read Google. `writeAttempted` describes the original
operation, not the repeat call. Use status for a fresh readback.
Later edits by humans can make a status read incomplete without undoing the
original creation.

## Verification and diagnostics

Tests use the supported fake BB host with disposable SQLite storage and synthetic
Google responses: real scopes and identity checks at the adapter boundary,
exact native POST shapes, multi-paragraph readback, denied authorization,
concurrency/reload, partial creation, ambiguous recovery, lost replies,
verification failures, cancellation and persistence failure. No live account
write is required or performed for delivery testing. Real Google create/populate
and visual paragraph rendering require a separately authorized disposable
provider document if that end-to-end test is wanted.

Bounded diagnostics identify `reserve`, `create`, `populate`, `verify`,
`receipt`, `status`, `status_mismatch` and `lookup_uncertain` stages (each prefixed
`docs_creation_` in logs), or the agent-tool boundary for preflight refusals.
They contain fixed categories and validated HTTP statuses only, never title,
text, account address, identifiers, credentials or provider response bodies.
An uncertainty diagnostic cannot establish whether a document exists.

## Shared destination review

The card shows the account, destination path, owners, visible audience, title, file type and complete requested content. If the complete card exceeds its bound, creation is refused before any write. The owner must approve each shared creation. A blank file, partial content or full content may be visible to the destination audience and may remain after failure. Group membership and organization rules are not fully visible. Access and authority are rechecked before creation and population; other Google clients can race those checks. No staging, moves, permission changes or invitations occur.

New shared-destination receipts record the acknowledgement of each submission. After a lost response, a matching observation does not establish acknowledgement: the operation remains unresolved and retains its local access claim. Status never replays a write. Local claims block sharing changes on inspected ancestors and the new file and moves of the exact new file; independent creations and filing can share ancestors. They cannot lock Google or other clients. Existing root and unshared-folder receipts retain their previous recovery semantics and are not claimed to have complete ancestry assessment.
