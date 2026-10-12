Drafted by Matt's robot

# 009 — Private, bounded iCloud sync diagnostics

Status: verified for iCloud 0.1.5; paused production deployment pending.

## Contract

Keep the sync, consent and recovery policies unchanged. Retain a small diagnostic history rather than writing a success log every minute: at most 20 completed runs in a separate scoped KV entry; exclude entries older than seven days and prune them on subsequent writes or restart. Record an internal sequence, initial-versus-normal run, timestamps, monotonic duration, outcome, failure stage/category and measured stage counters/durations, including cloud/local reused-file counts. Do not retain folder names, paths, account/provider identifiers, raw progress fields, credentials, content or exception text. Keep active progress transient; persist only a minimal pending-run marker and the completed summary. An unclean restart records an interrupted run with unknown duration and stage, not an invented successful or safely rolled-back operation.

Expose history through a read-only `diagnostics` RPC, not account or sync-control tools. Existing BB failure logs gain a safe run sequence and validated command-exit/timeout/output-limit/signal/start evidence. Known stock-rclone exit codes can distinguish missing files, transfer limits and temporary/fatal errors without parsing or retaining provider messages. An exit code does not establish the underlying Apple response or prove a write was unapplied. Do not reinterpret the earlier generic download error.

History failures must be visible but must not disable syncing, retry a provider operation, overwrite malformed stored history, or relabel a completed provider write as a failed sync. Validate persisted history and every exposed/logged field. Complete successful copy counters from validated staging sizes so short commands do not disappear between one-second stats samples. Preserve existing private process transport, output bounds and file-safety checks.

## Gates

Write Gherkin and tests for successful/failed runs, exact short-copy counters, stage timing, reload persistence, interrupted pending runs, bounded retention, corrupt history, storage failures and synthetic private-field sentinels. Exercise real stock-rclone exit and progress behavior on disposable generated data. Run all iCloud scenarios/tests, typecheck/build/shared UI checks and rendered-BB regression review. Pause scheduled writes through supported controls before updating only iCloud; resume only previously enabled folders. Observe a completed live run, read its safe history, inspect bounded logs, preserve other integrations and request feedback.

## Evidence

- 49 Cucumber scenarios / 432 steps and 62 unit/adapter/host tests passed without skips, including the pinned stock-rclone missing-directory exit code and existing conflict/deletion/baseline gates. Build, typecheck and shared UI drift checks passed.
- Running isolated BB passed all 60 rendered regression cases at 1280px/390px. Transfer completion still returns to finishing activity; the diagnostic counters do not turn a 100% transfer into a completed sync.
- Tests prove scoped-KV persistence and read-only RPC access, retention limits/expiry, monotonic timing through wall-clock changes, interrupted pending runs, short-copy final counts and reused references. Malformed history and read/write failures produce fixed warnings without overwriting unknown history, failing successful syncs or retrying provider operations. Synthetic names/content/credential sentinels do not reach logs or history.
- A full validation command hung and a later generated-data initialization step exceeded Cucumber's five-second timeout. Isolated file-safety and full-scenario reruns passed; three consecutive instrumented full-scenario runs then passed, with the slowest measured command boundary under 300 ms, followed by a passing complete suite. No timeout was relaxed or sync policy changed. The intermittent delay remains unexplained; optional `RCLONE_TEST_TRACE=1` now reports only bounded command/configuration/shutdown boundaries and timings for the generated-data suite.
- Phone-to-consumer and expired Apple-session checks from earlier iterations remain separate, unverified gates. Deployment and live history evidence will be added after observation.
