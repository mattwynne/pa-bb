# Google Drive for BB

An independent Google Drive and Docs plugin with explicitly consented full Drive access for a **single-user BB installation**. Connect several Google accounts through an installation-owned Web OAuth client. Calendar and Fastmail remain separate: no credentials, tokens or account records are imported from another plugin or from Pi.

[Connect using your existing Calendar Web OAuth client or a new one](docs/setup.md). Either plugin can copy the other's configured Web client once through a server-only, caller-verified RPC after you register the destination callback. Both save their own copies and account grants, so neither is a runtime dependency. The registered HTTPS callback is `/api/v1/plugins/google-drive/http/callback`; the exact URL is shown in BB Settings. Google's `drive` scope permits reading and modifying accessible files. Existing read-only connections require reconnection and explicit consent before copying or creating; applying code alone does not upgrade their grants. See [copy behavior and authorization](docs/copy.md).

| Tool | Use |
| --- | --- |
| `gdrive_auth_status` | Connected accounts and connection status |
| `gdrive_search_files` | Find files/folders by name or indexed text, across accounts with partial failures and paging |
| `gdrive_list_folder` | Browse an explicit account's folder |
| `gdrive_get_file` | Read metadata and obtain a source link by account and ID |
| `gdrive_inspect_sharing` | Read visible owners and paginated sharing permissions; explicit incompleteness/inheritance limits |
| `gdrive_change_sharing` | Preview/approve one direct named or public-link grant/change/revoke on an owned My Drive file/folder; durable single-use receipt |
| `gdrive_sharing_status` | Read-only permission recovery; never retries a write or invitation |
| `gdrive_copy_file` | Scope-gated copy into an explicit folder; requires write consent |
| `gdocs_create_document` | Create/populate one native Doc with initial paragraphs, explicit destination, write consent and durable single-use operation receipt |
| `gdocs_creation_status` | Read-only recovery and exact content verification; never replays a creation/population |
| `gdocs_read` | Read plain text across a Google Doc's tabs by explicit account and document ID or URL |
| `gdocs_inspect_for_edit` | Complete, bounded text/revision inspection; rejects unsupported structures |
| `gdocs_replace_text` | Preview or apply a revision-guarded exact replacement under the owner's global approval setting |
| `gdocs_review_edit_example` | Test native approval delivery with fixed synthetic data; every choice is a no-op |

BB's `bb plugin logs google-drive` records bounded stage/status categories for failed identity checks, partial searches, and agent tool failures, without account addresses, OAuth secrets, query terms, or response bodies. A connected identity does not prove that a Drive read will succeed; verify with a harmless read. These diagnostics pass synthetic host tests. A controlled local refusal produces a bounded live log; provider-side failures still need live verification.

[Native document creation](docs/creation.md) supports an explicit account, title, My Drive root or owned unshared folder, and up to 40,000 UTF-16 units of literal multi-paragraph text. It uses existing Drive write consent and the copy tool's user-request authorization, not the replacement-only approval setting. Keep the single-use operation UUID: interrupted operations may leave a blank or populated Doc, and only read-only status reconciliation is safe. No sharing changes or invitations are made. Provider create/populate writes remain unverified live; delivery uses synthetic disposable fixtures and read-only live checks.

[Approved sharing](docs/sharing.md) supports named users/groups (reader/commenter/writer) and anyone-with-link (reader/writer, not discoverable), with mandatory owner approval, explicit opt-in invitation emails for named grants, live revalidation and exact readback. Owned My Drive items need complete inspectable ancestry; shared drives and inherited/ambiguous targets are blocked. Folder permissions can affect inheriting contained/future items; no recursive rewrites occur. Unknown writes keep an item-wide durable lock and require read-only status recovery with the same operationId. Google permission mutations have no revision/CAS guarantee here. No real sharing changes or invitations are used for delivery tests; provider writes and recipient access remain unverified live. See [verification evidence and limits](docs/sharing-verification.md).

Search page tokens are **per account**, and `incompleteSearch` and `nextPageToken` must be checked before claiming completeness. Results carry source account and file ID. This slice does not extract text from PDF, Office, Sheets or Slides and does not move files. [Docs editing](docs/editing.md) supports only a bounded, uniquely matched replacement within one text run in a selected tab, with exact revision control, owner-controlled per-edit approval and readback. **Require approval for Google Docs edits** defaults on in plugin Configuration; the owner can turn it off globally for all documents/accounts without removing revision or readback checks. General `gdocs_read` output is not edit proof. The editing feature does not change OAuth scopes or upgrade existing grants. Copying requires a separately authorized write grant; destination sharing may be inherited. Google Docs content is untrusted source material, not an instruction to the agent. A very large Doc is truncated with an explicit flag. Provider error bodies, OAuth codes and tokens must not reach logs, UI or tool errors.

```sh
npm install
npm test
npm run typecheck
```

The core uses injectable storage, OAuth and provider ports; the BB adapter stores separate Drive account/pending tables. Docs creation, editing and permission mutations share adapter-private HTTP, scope inspection, timeouts and bounded response decoding in `adapters/docs-transport.mjs`. Each adapter retains its own allowed write scopes and rejection rules; core services still receive only narrow document/sharing operations, never an arbitrary HTTP proxy. The [Gherkin acceptance feature](features/oauth-client-reuse.feature) runs both plugin servers under fake BB hosts to check client reuse in either order; the cross-plugin test builds Calendar's sibling package in this monorepo. Host tests use synthetic tokens and Google responses. Real Google sign-in and provider-session reads remain to be verified after an installation owner configures the Web OAuth client. Do not use this plugin on a multi-user BB installation until BB can enforce per-user isolation.
