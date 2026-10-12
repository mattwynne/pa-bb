Drafted by Matt's robot

# 010 — Longer iCloud history, with errors kept separately

Status: verified for iCloud 0.1.6; paused production deployment pending.

## Contract

Keep successful sync summaries for seven days and failed/interrupted summaries for 30 days. Healthy runs must never evict errors. The default diagnostic response remains a small latest-20 page, not a retention limit; support bounded pages of up to 100, an older-run cursor and an errors-only filter. Report retained counts and any capacity trimming honestly.

Move history from one growing KV value to indexed rows in the plugin's existing scoped SQLite database. BB KV values are capped at 256 KB; retaining several days by increasing the old array limit would eventually fail writes and repeatedly serialize the entire history. Persist one minimal active marker and append one validated completed row at a time. Use the host's append-only migration helper. Preserve the old KV value for rollback/reference and import its available records exactly once; summaries already evicted by the old 20-run limit cannot be recovered.

Bound success history independently to 20,000 rows / 16 MiB of summary payload, and errors to 5,000 rows / 8 MiB. These are emergency caps, not a promise of unlimited traffic; expose capacity-trim counts and warn once if reached. Account for SQLite/index overhead separately from payload caps. Expire on writes/restart, and exclude expired records on read. Query only a bounded page. Keep the existing privacy projection, safe failure evidence and fail-independent storage behavior. Do not log routine successes, retry provider writes, repair baselines or change sync consent.

## Gates

Test errors surviving more than 20 healthy runs, distinct seven/30-day expiry, interrupted runs, reload and one-time legacy migration, pagination/filtering, independent row/byte budgets, invalid rows/history, storage failures and private-field sentinels. Exercise native SQLite and BB's 256 KB KV boundary. Preserve all existing stock-rclone file-safety tests, builds/typechecks, shared checks and rendered regression gates. Pause future syncs before updating only iCloud, preserve existing summaries and baselines, then resume previously enabled folders and inspect a completed persistent live summary.

## Evidence

- Typecheck/build/shared checks passed. Full stock-rclone v1.75.2 suite passed: 51 scenarios / 447 steps and 76 tests, no skips. Native SQLite tests cover TTL, independent row/byte caps, transaction failures, pending-marker import, private malformed rows and a 1,600-row history larger than BB's KV limit. Storage failure keeps a separate temporary last-20 cache for each outcome class, so healthy traffic does not erase its remembered errors either.
- All 60 rendered BB regression cases passed at desktop/phone widths. The interface and file-safety controls are unchanged.
- In an isolated running BB, a generated eight-day-old error survived 25 healthy summaries, while an eight-day-old success and 31-day-old error expired. The default latest-20 page retained an older seven-entry page; the errors-only query still found the old error. The actual server/core/logger captured a newly injected failure as `iCloud sync/backing_up_cloud sync_failed run=29 evidence=command_exit exit=4`. Synthetic names, messages, causes, credentials and provider-body sentinels were absent from logs/history; the folder paused without retry. The fixture contacted no Apple account and was removed after review.
- Production migration, preserved baseline/connection evidence and completed live-run observation remain pending. Existing phone-to-consumer and expired-session checks remain separate.
