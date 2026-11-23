# YNAB for BB

BB runs version 0.8.0 of the community [YNAB MCP server](https://github.com/calebl/ynab-mcp-server) over stdio. It uses a YNAB personal access token. The plugin exposes the server’s tool catalog and passes tool calls through to the pinned package.

## Set up

1. Install the plugin with `bb plugin install path:/path/to/pa-bb/plugins/ynab`. The BB server needs Node 22 or 24 and later.
2. Create a personal access token in YNAB under **Account Settings → Developer Settings**. [YNAB token documentation](https://api.ynab.com/#personal-access-tokens)
3. In BB, open **Settings → Installed plugins → YNAB → Configuration**. Enter the token in **YNAB personal access token**. BB stores it as a secret on the server.
4. Run `bb ynab check` to verify access. This lists plans through YNAB’s API and reports whether the read succeeded. It keeps plan names and IDs out of the command output.
5. Open a fresh BB agent session. Use `ynab_list_tools` to discover tools and schemas, then `ynab_call_tool` to make a request.

The plugin starts in read-only mode. Enable **Allow changes to YNAB plans** if you want the same write tools available in a read/write stdio configuration. The package’s AI categorization feature stays disabled. The token can access the plans that YNAB grants to that account.

Clear the token in BB Configuration to disconnect. Revoke it in YNAB Developer Settings if you want to invalidate it at YNAB.

## Verify

Run `npm ci`, `npm run typecheck`, `npm test`, and `bb plugin build`. Tests start the pinned package for catalog discovery with a synthetic token and use a local stdio fixture for tool results and failures. `bb ynab check` makes the live read. `bb plugin logs ynab -n 20` gives failure categories without including the token, provider stderr, or plan data.
