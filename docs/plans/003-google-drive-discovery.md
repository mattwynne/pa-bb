# 003 — Google Drive and Docs discovery

## User outcome

After connecting one or more Google accounts, find files and folders in Drive, follow their source links, and read a Google Doc by ID or URL in BB. The connection is an independently installed plugin; it does not require Google Calendar and does not reuse Calendar's stored tokens. Every read of a specific file identifies its Google account.

## First slice

- Installation-owned Google Web OAuth client, with an HTTPS BB callback, PKCE, one-use expiring state, stable verified identity, separate SQLite token store, and the read-only Drive scope (also accepted by Docs `documents.get`).
- Account status, add/remove account, and setup/recovery screens using the shared BB connection layout. Multiple accounts are supported; do not assume one account or copy the Calendar API's setup instructions verbatim.
- Agent tools for account status, Drive file search (not just folder-name matching), folder contents, file metadata/links, and Google Docs plain-text reading. Preserve the account and file ID in each result; paginate without silently declaring the search complete. Report inaccessible/unsupported MIME types rather than pretending to read them.
- Synthetic OAuth, scoped API, pagination, cross-account, failure, and isolated-install tests. Review setup, connected, empty, error, and narrow/keyboard states in running BB before calling UX verified. Live authorization and reads require an owner-provided OAuth client; do not print grants or private files in logs or chat.

## Deliberately later

Document creation, editing, sharing, filing, and Sheets/Slides. Adding mutation tools will require an explicit scope-upgrade/reconnect path and BB-owner approval for consequential changes; do not acquire write scopes merely for this read-only slice. Do not port the Pi extension's large tool catalogue or its Desktop OAuth credentials.

## Gates

A marketplace install must stand alone; removal must not change Calendar or Fastmail data. A Google callback must consume state before token exchange and never expose codes, tokens, or provider diagnostics. Unknown accounts, account subject changes, missing scopes, and uncertain or incomplete search results must fail visibly. The plugin remains single-user at the BB host level until BB supplies an enforceable user boundary.
