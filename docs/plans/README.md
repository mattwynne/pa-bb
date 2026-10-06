# Iteration ledger

Plans are numbered in delivery order as `NNN-<iteration-name>.md`. Keep the number when a plan becomes historical; record the current outcome in the ledger rather than rewriting its original starting conditions.

| Iteration | Status | Outcome |
| --- | --- | --- |
| [001 — Marketplace and Google Calendar](001-marketplace-calendar.md) | Delivered | Git marketplace and independently installable Google Calendar plugin. The plan is historical; the [plugin README](../../plugins/google-calendar/README.md) records current verification limits. |
| [002 — Fastmail MCP connection spike](002-fastmail-mcp-connection.md) | Bridge pilot retired; standalone successor connected | [Findings](002-fastmail-mcp-findings.md#standalone-successor): read-only bridge proof is historical. The one-install Fastmail plugin is connected on production; fresh provider-session calls and live writes remain unverified. |
| [003 — Google Drive discovery](003-google-drive-discovery.md) | Read-only plugin built; live authorization pending | Independent Web OAuth and read-only search/folder/metadata/Docs tools with synthetic coverage. Live BB consent and provider reads still need verification. |

See the [roadmap](../roadmap.md) for the proposed order beyond these iterations.
