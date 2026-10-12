Drafted by Matt's robot

# Iteration ledger

Plans are numbered in delivery order as `NNN-<iteration-name>.md`. Keep the number when a plan becomes historical; record the current outcome in the ledger rather than rewriting its original starting conditions.

| Iteration | Status | Outcome |
| --- | --- | --- |
| [001 — Marketplace and Google Calendar](001-marketplace-calendar.md) | Delivered | Git marketplace and independently installable Google Calendar plugin. The plan is historical; the [plugin README](../../plugins/google-calendar/README.md) records current verification limits. |
| [002 — Fastmail MCP connection spike](002-fastmail-mcp-connection.md) | Bridge pilot retired; standalone successor connected | [Findings](002-fastmail-mcp-findings.md#standalone-successor): read-only bridge proof is historical. The one-install Fastmail plugin is connected on production; fresh provider-session calls and live writes remain unverified. |
| [003 — Google Drive discovery](003-google-drive-discovery.md) | Read-only plugin built; live authorization pending | Independent Web OAuth and read-only search/folder/metadata/Docs tools with synthetic coverage. Live BB consent and provider reads still need verification. |
| [004 — iCloud folder sync](004-icloud-sync.md) | Installed; live follow-ups remain | Apple connection, folder access and scheduled sync verified; phone-to-consumer round trip and expired-session recovery remain unverified. |
| [005 — iCloud folder picker](005-icloud-folder-picker.md) | Installed; sync recovered | Native icons and navigation with clear selection buttons; approved recovery after a deployment interruption, successful normal sync and live rendered review. |
| [006 — Obsidian vault reading](006-obsidian-vault-reading.md) | Planned | Guided iCloud-first onboarding with distinct setup/recovery messages; one explicitly authorized synced vault, read-only note search/reads, link resolution, task discovery and citations. Live dependency navigation/handoff, sync/read safety and rendered UX are release gates. |
| [007 — iCloud sync progress](007-icloud-sync-progress.md) | Installed; live verified | Per-folder measured transfers and honest checking/backup/finishing activity, with private bounded provider statistics. |
| [008 — Incremental iCloud recovery](008-incremental-icloud-recovery.md) | Installed; unchanged-run verified | Approved recovery and two successful live syncs; unchanged recovery downloaded zero file bodies while retaining fail-closed conflict/deletion protection. |
| [009 — iCloud sync diagnostics](009-icloud-sync-diagnostics.md) | Installed; live verified | Bounded private run history, stage timings and downloaded/reused counts, correlated command failure evidence, and fail-independent diagnostic storage. |
| [010 — iCloud history retention](010-icloud-history-retention.md) | Installed; live verified | Seven-day success / 30-day error history, independent budgets, indexed SQLite rows, safe legacy import and bounded paginated reads. |

See the [roadmap](../roadmap.md) for the proposed order beyond these iterations.
