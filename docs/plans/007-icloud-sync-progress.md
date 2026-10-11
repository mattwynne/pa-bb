Drafted by Matt's robot

# 007 — Honest per-folder sync progress

Status: installed as iCloud 0.1.3; live progress and successful normal completion verified.

## Contract and display

Keep progress in memory, scoped to a single running folder. The cloud-provider port reports bounded byte/file counts and provider-independent stages: checking, saving the cloud recovery copy, saving the local recovery copy, sealing recovery copies, transferring and finishing sync. Never publish filenames, raw provider logs, credentials, or stale progress after success/failure/restart.

Show a visible progress bar below each running folder. Use measured byte progress (or file progress for zero-byte files) when totals are known; otherwise show an indeterminate bar and a clear activity label. Totals may change while listing. A transfer bar reaching 100% is not successful completion; show finishing activity until provider work and the baseline marker complete. Preserve the previous last-successful timestamp throughout the run. Poll status about once a second while running/preparing, without overlapping polls or erasing action errors; poll more slowly when idle. Respect reduced-motion preferences and accessible progressbar/status semantics.

Use private stderr NDJSON stats from each separately spawned stock-rclone command, not the independent configuration daemon's global stats. Bound line buffering and whitelist only numeric counters. A bad stats record or callback must not fail the sync. Leave command arguments, conflict handling, deletion checks and recovery budgets otherwise unchanged.

## Gates

- Cucumber scenarios for stages, measured/unknown totals, completed transfers versus completed operation, privacy and progress reset.
- Parser/process/provider tests for malformed and oversized output, safe numeric fields, split records, failures and real stock-rclone stats on generated files.
- Existing stock-rclone safety suite, unit/host tests, build/typecheck and shared UI drift checks.
- Rendered running-BB review at desktop and narrow widths: checking, both backups, byte/file transfer, changing/unknown totals, finishing, failures and completion; accessibility, focus and reduced motion. Compare with existing connection styling.
- Explicitly pause future syncs through supported controls after the active run completes **before** preparing/updating iCloud. Never rely on an idle observation alone. Update iCloud only, restore its previously enabled selection through normal controls, inspect live progress without printing private account data and observe successful completion.

## Local evidence

- 40 Cucumber scenarios / 351 steps and 29 unit/adapter/host tests passed with no skips, including stock-rclone transfer stats observed mid-command and generated-data conflict/deletion safety. Typecheck, build and shared connection UI checks passed.
- Running isolated BB rendered 29 controlled states at 1280px and 390px (58 cases). Reviewed screenshots for byte/file progress, both recovery-copy stages, unknown/growing totals, complete transfers, finishing activity and success/failure cleanup, plus existing setup/browser/approval states. Tested adaptive polling, preserved timestamps, keyboard focus, non-overflowing layout and reduced motion. Compared with the existing connection styling.
- Installed only iCloud after quiescing the failed mirror and obtaining explicit recovery consent. Preserved incomplete backup versions in the shared recovery store; the existing baseline and local folder were unchanged. Live measured bars, changing counters, focus and layout passed at 1280px/390px, and a normal run completed successfully. Other integrations and the Apple connection were preserved. A later cloud-backup download failed safely before two-way sync; that separate recovery and incremental optimization are tracked in iteration 008.
- Progress is a transient, whitelisted status projection, not saved provider data. The command-local parser drops malformed/oversized NDJSON records and ignores callback failures; private-message/file/error sentinels did not reach status or diagnostics. Failed runs log a bounded operation/stage (for example `sync/backing_up_cloud`) and category, not provider error text.
