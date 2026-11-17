# Workspace ports

The core owns these contracts. They are ordinary objects, not an interface framework.

## MCP server

- `listTools(accessToken, { signal }?) → Tool[]`: complete upstream catalogue, preserving schemas.
- `callTool(accessToken, { name, arguments }, { signal }?) → CallToolResult`: one attempt, preserving supported upstream result content and `isError`.
- `close()`: release active connections and the owned runtime.

Tokens are opaque strings to the core. HTTP headers, sessions, pagination and SDK types belong to `adapters/mcp.mjs`. The in-memory implementation is `testing/memory-mcp.mjs`. Both run the same contract tests; adapter tests use the real SDK with stubbed HTTP, not a replacement SDK client.

## Connected accounts

- `list() → { subject, email }[]`: public account facts only.
- `access(email) → accessToken`: get a current token for that exact account.

`core/auth.mjs` implements this port using two outgoing ports:

- OAuth: `authorizationUrl(fields)`, `exchange(request)`, `refresh(request)`, `identity(accessToken)`.
- Store: `accounts()`, `byEmail(email)`, `bySubject(subject)`, `saveAccount(record)`, `removeAccount(subject)`, `savePending(record)`, `consumePending(stateHash)`.

`consumePending` removes the one-use authorization state atomically. The SQLite adapter owns SQL, while core tests use an in-memory store. This is authentication state, not an operation journal or document recovery system.

The core knows no BB SDK, network, process or database types. It makes no claims about Google's document-editing correctness: that remains upstream's responsibility and the installation owner's integration check.
