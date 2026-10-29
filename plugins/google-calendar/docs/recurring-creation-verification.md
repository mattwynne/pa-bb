# Recurring creation verification

## Implemented contract

Creation supports daily, weekly, monthly and yearly repeats, timed or all-day. One shared Zod definition validates both tool and service boundaries. Intervals are 1–52 periods; counts are 1–1000 actual occurrences including the first. Omit count and cutoff for no end date. Weekly alone requires unique weekdays including the first local start's weekday. Monthly anchors to that date's day; yearly anchors to its month/day. Nonexistent month-end/leap-day dates are skipped, not shifted, and approval explicitly says so. No custom RRULEs, ordinal-weekday patterns, exclusions, recurrence editing, or “this and future” changes were added.

Timed creation requires an IANA timezone with matching explicit start/end offsets. The cutoff must be an offset datetime, is inclusive of occurrence starts, and is normalized/reviewed in UTC. All-day creation uses floating dates, an exclusive end (default next date), and a date-only inclusive occurrence-start cutoff. A multi-day occurrence may finish after that cutoff. A supplied timezone does not shift all-day dates.

Google receives one event with a paired start/end and generated RRULE. Both timed boundaries carry the timezone; all-day boundaries use date fields only. Google owns expansion and future timezone rules. Timed ends also depend on the original duration, especially across timezone transitions. The plugin has no expansion engine.

The server prepares normalized approval view strings. The frontend imports no backend validator and does not reinterpret recurring times using browser timezone laws. Both timed offsets remain visible; cutoff is explicitly UTC. Older pending recurring proposals without normalized view data must be declined and proposed again. One-off pending proposals remain readable. Writes retain native owner approval and notification-default-off. Update/delete still use only the supplied event ID and show verified occurrence/series scope or an unknown-scope warning.

## Automated evidence

- Build, TypeScript/SDK checks and shared connection UI drift check pass.
- 39 Cucumber scenarios / 266 steps and 212 Node tests pass.
- 132 recurrence/service-host tests also pass when launched under `TZ=America/New_York`; tests do not mutate global timezone settings.
- Coverage includes all four frequencies in timed/all-day modes, exact paired provider payloads, all-day default/exclusive ends and date cutoffs, month-end/leap-day anchors and approval warnings, interval/count limits, date/datetime cutoff mismatches, invalid dates, weekday membership, spring gaps, both fall-fold offsets, historical DST payloads, approval/decline/cancellation, notification defaults and uncertain-insert non-retry.
- A renderer regression simulates older browser timezone laws: an identical server-approved 14:30 (UTC−07:00) start and 21:30Z cutoff stay consistent instead of showing an invented 13:30 cutoff. A fold-straddling first appointment retains different start/end offsets.
- The test-only `rrule` dependency and surrogate expansion tests were removed. Payload assertions are not proof of Google's actual series expansion.
- Diagnostic tests retain synthetic private-content sentinels. Validation produces only the bounded `recurrence_invalid` category; uncertain writes are not replayed or exposed.
- The existing 12 dependency advisories (3 moderate, 8 high, 1 critical) were not repaired by this feature; no new production dependency was added.

From the package directory:

```sh
npm test
npm run typecheck
TZ=America/New_York node --test test/recurrence.test.mjs test/recurrence-host.test.mjs
```

## Isolated native rendered review

A fresh, credential-free BB loads the actual working-copy package and verifies an empty account status. A small test-only fixture registers the production Approval component in BB's real pending-interaction slot. It has no Google adapter, credentials or agent tools. Source files are copied unchanged into the fixture package to meet BB's package-local import requirement; production source strings and tool registrations are not rewritten.

The controller enrolls a disposable host and creates 17 inert scheduled threads through public APIs. Their first dispatch is far in the future, with an explicit inert model; no provider catalogue discovery, conversation or environment work runs. All final timeline rows are submitted plugin forms with null turn IDs. The isolated server/daemon/data and scheduled queue are removed on shutdown.

**34 native cases pass:** the 17 states at both 1280px and 390px. They cover indefinite/count/cutoff, one-off and legacy pending proposals, update-series/occurrence and delete-series, daily/monthly/yearly timed creation, all four all-day frequencies, and failed/busy submission states. Tests check keyboard traversal, disclosure, approval/decline, checked/unchecked notification receipts, host-recorded choices, blocked legacy approval, recovery after a rejected submit, disabled actions during a controlled pending submit, and non-overflowing layout. Screenshots of timed cutoff and all-day month-end cards were visually reviewed at both widths.

Only the failed/busy cases use a deterministic fixture wrapper before forwarding the owner's choice to BB's actual submit callback. They test production renderer state handling, not a failed network connection. An initial combined matrix run exceeded an automation RPC deadline; the final matrix was rerun successfully in bounded, separate per-width calls.

Reproduce with a built BB that supports public scheduled-thread and plugin-interaction APIs (or a compatible `bb-app` devDependency):

```sh
BB_REVIEW_ROOT=/path/to/built-bb node test/run-recurring-preview.mjs
# Open the printed disposable URL in an explicit browser session; skip onboarding.
# Add ?reviewWidth=1280 to that URL, then run:
bb browser-automation run <session-id> \
  --script-file /absolute/path/to/google-calendar/test/recurring-browser-review.mjs \
  --script-host <host-id> --timeout 120s --json
# Reopen the disposable URL with ?reviewWidth=390 and repeat the same command.
```

The controller inherits no provider credentials or personal home directory. All synthetic choices are no-ops. SIGTERM to its printed controller PID stops the server/daemon and removes isolated data. Never install this fixture in a configured BB profile.

## Remaining limits

Actual Google series expansion, future DST behavior on Google's database, and real series write/readback remain **unverified**. No real event, invitation, appointment or account mutation was made. Native rendering uses inert threads, not a provider tool conversation. Broader connection setup states and real submission network failures were not re-exercised by this native matrix. Production activation and harmless provider reads must be checked separately from this synthetic record; they do not establish that any appointment was created.
