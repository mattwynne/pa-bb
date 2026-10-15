# Iteration ledger

Plans are numbered in delivery order as `NNN-<iteration-name>.md`. Keep the number when a plan becomes historical; record the current outcome in the ledger rather than rewriting its original starting conditions.

| Iteration | Status | Outcome |
| --- | --- | --- |
| [001 — Marketplace and Google Calendar](001-marketplace-calendar.md) | Delivered | Git marketplace and independently installable Google Calendar plugin. The plan is historical; the [plugin README](../../plugins/google-calendar/README.md) records current verification limits. |
| [002 — Fastmail MCP connection spike](002-fastmail-mcp-connection.md) | Bridge pilot retired; standalone successor connected | [Findings](002-fastmail-mcp-findings.md#standalone-successor): read-only bridge proof is historical. The one-install Fastmail plugin is connected on production; fresh provider-session calls and live writes remain unverified. |
| [003 — Google Drive discovery](003-google-drive-discovery.md) | Read-only plugin built; live authorization pending | Independent Web OAuth and read-only search/folder/metadata/Docs tools with synthetic coverage. Live BB consent and provider reads still need verification. |
| [004 — iCloud folder sync](004-icloud-sync.md) | Installed; live follow-ups remain | Apple connection, folder access and scheduled sync verified; phone-to-consumer round trip and expired-session recovery remain unverified. |
| [005 — iCloud folder picker](005-icloud-folder-picker.md) | Installed; sync recovered | Native icons and navigation with clear selection buttons; approved recovery after a deployment interruption, successful normal sync and live rendered review. |
| [006 — Obsidian vault reading and editing](006-obsidian-vault-reading.md) | Planned | Connect one or more iCloud-synced vaults for whole-vault reading and editing, with no folder permissions, read-only mode or edit confirmations. [Simple UX overview](006-obsidian-ux-options.html). Version conflicts, coordinated sync/write safety, recovery and rendered UX remain release gates. |
| [007 — iCloud sync progress](007-icloud-sync-progress.md) | Installed; live verified | Per-folder measured transfers and honest checking/backup/finishing activity, with private bounded provider statistics. |
| [008 — Incremental iCloud recovery](008-incremental-icloud-recovery.md) | Installed; unchanged-run verified | Approved recovery and two successful live syncs; unchanged recovery downloaded zero file bodies while retaining fail-closed conflict/deletion protection. |
| [009 — iCloud sync diagnostics](009-icloud-sync-diagnostics.md) | Installed; live verified | Bounded private run history, stage timings and downloaded/reused counts, correlated command failure evidence, and fail-independent diagnostic storage. |
| [010 — iCloud history retention](010-icloud-history-retention.md) | Installed; live verified | Seven-day success / 30-day error history, independent budgets, indexed SQLite rows, safe legacy import and bounded paginated reads. |
| [011 — Rclone-first iCloud recovery](011-rclone-first-icloud-recovery.md) | Installed; persistent live sync verified | Native ordinary-failure recovery and supported Retry/Reconnect/Resume/fresh-mirror actions. Empty-staging recovery and subsequent live sync verified; real Apple expiry remains unverified. |
| [012 — Native iCloud sync](012-native-icloud-sync.md) | Installed; live read verified at delivery | Whole-folder backups and extra recovery listings removed; native safeguards and old recovery archives retained. Per-file recovery belongs at future BB tool writes. The pre-existing blocker was separately recovered during iteration 013. |
| [013 — Native bisync retry classification](013-icloud-bisync-retry-classification.md) | Installed; live scheduled sync verified | Proven resilient exit-7 aborts retry normally; true critical and unknown outcomes stay blocked. Safe native decisions and listing-failure reasons persist in logs/history. Existing mirror recovered without resync or rebuild. |

See the [roadmap](../roadmap.md) for the proposed order beyond these iterations.
