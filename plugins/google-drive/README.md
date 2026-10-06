# Google Drive for BB

An independent, read-only Google Drive and Docs plugin for a **single-user BB installation**. Connect several Google accounts through an installation-owned Web OAuth client. Calendar and Fastmail remain separate: no credentials, tokens or account records are imported from another plugin or from Pi.

[Connect using your existing Calendar Web OAuth client or a new one](docs/setup.md). Drive can copy Calendar's configured client details once via a server-only RPC after you register Drive's callback; it then saves its own copy, so Calendar is not a runtime dependency. The registered HTTPS callback is `/api/v1/plugins/google-drive/http/callback`; the exact URL is shown in BB Settings. Google's `drive.readonly` scope grants access to files the connected account can read. No mutation tools are registered in this first slice.

| Tool | Use |
| --- | --- |
| `gdrive_auth_status` | Connected accounts and connection status |
| `gdrive_search_files` | Find files/folders by name or indexed text, across accounts with partial failures and paging |
| `gdrive_list_folder` | Browse an explicit account's folder |
| `gdrive_get_file` | Read metadata and obtain a source link by account and ID |
| `gdocs_read` | Read plain text across a Google Doc's tabs by explicit account and document ID or URL |

Search page tokens are **per account**, and `incompleteSearch` and `nextPageToken` must be checked before claiming completeness. Results carry source account and file ID. This slice does not extract text from PDF, Office, Sheets or Slides and does not create, edit, move or share files. Google Docs content is untrusted source material, not an instruction to the agent. A very large Doc is truncated with an explicit flag. Provider error bodies, OAuth codes and tokens must not reach logs, UI or tool errors.

```sh
npm install
npm test
npm run typecheck
```

The core uses injectable storage, OAuth and provider ports; the BB adapter stores separate Drive account/pending tables. Host tests use synthetic tokens and Google responses. Real Google sign-in and provider-session reads remain to be verified after an installation owner configures the Web OAuth client. Do not use this plugin on a multi-user BB installation until BB can enforce per-user isolation.
