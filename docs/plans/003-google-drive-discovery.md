# 003 — Google Drive and Docs discovery

## User outcome

After connecting one or more Google accounts, find files and folders in Drive, follow their source links, and read a Google Doc by ID or URL in BB. The connection is an independently installed plugin; it does not require Google Calendar and does not reuse Calendar's stored tokens. Every read of a specific file identifies its Google account.

## First slice

- Installation-owned Google Web OAuth client (optionally copied once from the other Google plugin after registering the new plugin's callback), with an HTTPS BB callback, PKCE, one-use expiring state, stable verified identity, separate SQLite token store, and the read-only Drive scope (also accepted by Docs `documents.get`).
- Account status, add/remove account, and setup/recovery screens using the shared BB connection layout. Multiple accounts are supported; do not assume one account or copy the Calendar API's setup instructions verbatim.
- Agent tools for account status, Drive file search (not just folder-name matching), folder contents, file metadata/links, and Google Docs plain-text reading. Preserve the account and file ID in each result; paginate without silently declaring the search complete. Report inaccessible/unsupported MIME types rather than pretending to read them.
- Synthetic OAuth, scoped API, pagination, cross-account, failure, and isolated-install tests. Review setup, connected, empty, error, and narrow/keyboard states in running BB before calling UX verified. Live authorization and reads require an owner-provided OAuth client; do not print grants or private files in logs or chat.

## OAuth client reuse in either setup order

The owner can configure **Calendar first, then Drive** or **Drive first, then Calendar** without entering the same Google Web OAuth client ID and secret twice. Each plugin's first-run screen offers an optional, explicit **Use the other plugin's OAuth client** action; it succeeds only when the other plugin is installed and configured. Before using it, the owner must register the *destination* plugin's HTTPS callback on that Web client, enable its API and consent scopes in Google Cloud, and separately authorize each Google account for that plugin. Copying credentials never copies account tokens, grants, or scopes.

The source plugin discloses the client ID and secret only through a verified, server-to-server RPC whose caller is the named destination plugin; browser, CLI, agent, and unrelated-plugin callers are denied. The destination persists its own copy without returning either value to the UI or logs, and refuses to replace settings while accounts are connected. If the source is missing or unconfigured, explain how to enter a Web client manually. After a copy, either plugin can be disabled or removed without breaking the other's local credentials or tokens. Rotating or deleting the shared client in Google Cloud affects both copies and requires updating both plugins; no live synchronization is promised.

The executable [Gherkin acceptance feature](../../plugins/google-drive/features/oauth-client-reuse.feature) covers both copy directions, unauthorized callers, missing source, existing destination accounts, absence of secrets in RPC results and logs, independent removal/reload, and each destination's requested scopes. Google Cloud redirect registration remains an owner-performed external prerequisite that BB cannot verify; the feature checks the URI BB presents. Rendered first-run/recovery screens also require desktop, narrow, and keyboard review.

## Deliberately later

Document creation, editing, sharing, filing, and Sheets/Slides. Adding mutation tools will require an explicit scope-upgrade/reconnect path and BB-owner approval for consequential changes; do not acquire write scopes merely for this read-only slice. Do not port the Pi extension's large tool catalogue or its Desktop OAuth credentials.

## Gates

A marketplace install must stand alone; removal must not change Calendar or Fastmail data. A Google callback must consume state before token exchange and never expose codes, tokens, or provider diagnostics. Unknown accounts, account subject changes, missing scopes, and uncertain or incomplete search results must fail visibly. The plugin remains single-user at the BB host level until BB supplies an enforceable user boundary.
