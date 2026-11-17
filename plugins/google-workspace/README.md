# Google Workspace for BB

A thin connector to [Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp), enabling **Drive, Docs, Sheets, Calendar and Gmail**. Google operations and document-editing behaviour stay upstream. BB owns account selection, Google sign-in, token refresh and the local backend process.

**Status:** installed for an owner trial using a local-path source. Synthetic tests, real Linux backend startup, anonymous-auth refusal and rendered BB settings checks pass. Google account consent and real Google operations remain for owner testing. Workspace replaces the retired standalone Calendar and Drive plugins; their source and earlier verification records remain in Git history.

Requested writes run without a second PA approval prompt. The connector adds no document model, edit planner, operation journal or recovery framework. It makes one attempt per call; inspect current Google state before retrying an uncertain write.

## Setup

Requirements: a single-user BB installation, BB 0.45+/SDK 0.6.15+, Node 22+, and [uv](https://docs.astral.sh/uv/getting-started/installation/) available to the BB service as `uvx`. First backend startup downloads Python 3.12 and `workspace-mcp==2.3.0`; subsequent starts reuse uv's cache. This is a local process, not a hosted Taylor Wilsdon service.

For a **fresh local-path test installation**, from this repository on the BB server:

```sh
cd plugins/google-workspace
npm ci
npm run build
cd ../..
bb plugin install ./plugins/google-workspace
```

Workspace is also available as `google-workspace@pa-for-bb` in the PA marketplace. Use BB's native update lifecycle for an existing Workspace installation; do not uninstall a configured plugin to update its source.

When replacing an old Calendar/Drive installation, configure Workspace and verify the Google tasks you need first. Then explicitly uninstall the old plugins with `bb plugin uninstall google-calendar` and `bb plugin uninstall google-drive`. Uninstalling deletes their BB settings, secrets and schedules, not Google content. Do not revoke the shared Google OAuth app just to retire the plugins; that may also affect Workspace.

Successful Google sign-in returns directly to these Workspace settings, where the verified account is listed. If sign-in cannot finish, a standalone recovery page links back to Workspace without showing callback details.

### Reuse the existing Google Cloud OAuth app

No second OAuth app is needed. The existing Web OAuth client can authorize Workspace too; Workspace obtains its own combined user grant; it does not import another plugin's tokens.

1. In the existing Google Cloud project, enable **Drive API, Docs API, Sheets API, Calendar API and Gmail API**.
2. Configure the OAuth app's audience/test users and data access as appropriate. Workspace requests `openid`, `email`, `drive`, `calendar`, `gmail.modify` and `gmail.settings.basic`. Drive permission also authorizes Docs and Sheets operations. Gmail adds real permissions; old Drive/Calendar tokens cannot silently gain mail access. Public Gmail integrations may require Google's verification; testing-mode requirements are different.
3. Open Workspace's BB settings. Copy its displayed callback URL into the Web client's **Authorized redirect URIs**. Its form is `https://<BB origin>/api/v1/plugins/google-workspace/http/callback`.
4. Enter the Web client's ID and secret in Workspace's Configuration. Existing Workspace settings are retained when updating; no other Google plugin is needed.
5. Choose **Connect account**, select the Google account and approve all requested services, including Gmail. Return to BB after the callback, then choose **Refresh** if the backend is still unavailable. A first runtime download can take longer than later starts.

Add more accounts with **Add account**. Every agent call selects an account explicitly. **Reconnect** preserves account identity. **Remove** deletes this plugin's saved account connection, not Google content or another plugin's grant. Revoke remote access separately in Google account settings if wanted.

## Using it

The connector discovers schemas at runtime and registers names such as `gworkspace_modify_doc_text_<schema-hash>`. Start a fresh agent session after connecting, changing the catalogue or removing an old plugin.

- `gworkspace_accounts`: list connected accounts, without tokens.
- `gworkspace_list_tools`: inspect the discovered upstream tools and their BB-facing schemas.
- `gworkspace_call_tool`: fallback for schemas BB cannot register directly. Supply an upstream tool name and its arguments, including `account`.

Drive includes file/folder discovery, creation, copying, moving, uploads/imports and sharing. Docs includes rich reading/editing, Markdown, headings, tables and formatting. Sheets includes values/formulas, formatting and structural tools. Calendar includes calendars/events and availability. Gmail includes search/read, attachments, drafts/send, labels and filters. Consult the actual discovered schemas rather than guessing parameters or claiming every Google editor feature is supported.

The backend runs in upstream's stateless mode with local-file access disabled. File tools use upstream's inline or upload-URL paths rather than arbitrary BB-server file paths. In particular, request `return_base64` when actual Gmail attachment bytes are needed; the default stateless response may only show a prefix. Automatic BB thread-file/artifact handling is not implemented. Verify the file workflows you need during manual integration testing.

## Architecture and tests

- `core/workspace.mjs`: account selection, schema adaptation and forwarding through the core-owned MCP port.
- `adapters/mcp.mjs`: real MCP SDK and HTTP translation.
- `testing/memory-mcp.mjs`: in-memory implementation of the same port, not another Google implementation.
- `core/auth.mjs`: Google authorization/account behaviour behind OAuth and store ports.
- `adapters/google-oauth.mjs`, `adapters/bb-store.mjs`, `adapters/runtime.mjs`: external boundaries.
- `server.ts`: BB composition/registration; `app.tsx`: connection UI.

See [the ports](core/ports.md) and [ADR 0004](../../docs/adrs/0004-google-workspace-mcp.md).

```sh
npm test                 # Fast core/adapter/contract tests; no server or Google
npm run test:host        # Built BB handlers and real temporary SQLite; synthetic MCP/OAuth
npm run test:runtime     # Opt-in: real pinned backend startup; uvx required; no Google login
npm run typecheck
```

The MCP adapter and test double run the same contract tests. Adapter tests use the actual SDK with stubbed HTTP, including initialization, pagination and calls. They do not prove a real Workspace MCP or Google session works. The SDK host tests likewise do not substitute for rendered BB review.

Tokens remain in the plugin-owned BB database; only short-lived access tokens reach the loopback MCP process. Upstream also requires a startup signing key even in external-token mode; the adapter generates a throwaway local key rather than passing Google's client secret. The database is not separately encrypted; protect the BB data directory/backups. Diagnostics name failing boundaries with fixed categories, without account addresses, arguments, tokens or provider bodies. Upstream logging is suppressed and credential persistence disabled in the child. Tool result content remains task data, not instructions.

## Manual integration check

1. Inspect first-run/setup, connected, empty and error states in running BB at desktop and narrow widths; use keyboard navigation and check the callback Copy action.
2. Reuse the existing OAuth app, complete combined consent, and confirm the right account appears without an upstream login.
3. In a fresh agent session, try a harmless read in each service. Check the selected account and actual result, not just the tool catalogue.
4. If testing edits, use a disposable document or spreadsheet and request the change explicitly. Test drafts/sending only when you intend that mail action. No automated live write is required to finish this connector.
5. Restart/reload, check token refresh/reconnect, then inspect bounded logs for a controlled failure. Do not paste callbacks, tokens or private provider output into public reports.

Rendered BB setup, configured-empty, connected-fixture and error states passed at desktop/narrow widths, including keyboard focus, Copy, recovery and cancellation of Remove. Connected-state data was synthetic; no Google account was connected for these checks. The actual upstream process started on Linux and rejected anonymous MCP initialization with HTTP 401. Live Google operations and real token refresh remain **unverified** until the owner performs them.
