# Recurring creation verification

## Implemented contract

Creation accepts structured weekly weekdays, a 1–52 week interval, and an optional 1–1000 occurrence count or inclusive offset-datetime cutoff. Omission of both end conditions explicitly means indefinite recurrence. One-off inputs are unchanged. Timed recurring creation requires an IANA timezone and valid, matching start/end offsets; raw rules, unsupported frequencies, duplicate weekdays, invalid dates and inconsistent rules fail before any provider read or approval.

The effective normalized proposal is reviewed before inserting one Google series. Both dateTime boundaries carry the IANA zone and the RRULE uses an explicit Monday week start; UNTIL is UTC. Updates/deletes still use exactly the requested ID. Their preview uses provider metadata to distinguish an occurrence from the whole series, or warns when scope is unknown. No recurrence editing, “this and future”, all-day recurrence or automatic mutation retry was added.

## Automated evidence

- Package build, TypeScript/SDK checks and shared connection UI drift check pass.
- 39 existing Cucumber scenarios / 266 steps pass.
- 151 Node tests pass, including independent RFC5545 expansion (test-only `rrule`), structured validation, generated API payloads, native fake-host schema/interaction tests, approval/decline/cancellation and notification defaults, malformed persisted approval data and uncertain-insert non-retry diagnostics.
- The motivating Thursday 14:30–17:00 schedule is checked beginning 2026-10-29 in `America/Vancouver`. Runtime tzdata 2026c no longer has a Vancouver November 2026 fall-back. Historical Vancouver spring/fall transitions and the Los Angeles October–November 2026 transition independently verify local wall-clock preservation, including UTC offset changes. Google expansion still depends on Google's timezone database, not the test expander. The focused 57-test recurrence suite also passes with the host timezone set to `America/New_York`; the test-only expander's documented pseudo-UTC Date behaviour is isolated under UTC, not used by production code. Recurring previews preserve server-approved local start/end values instead of reinterpreting them with potentially different browser tzdata.
- A package-lock-only npm audit comparison against the pre-change lockfile found the same 12 advisories (3 moderate, 8 high, 1 critical), with no newly affected package. Those existing dependency advisories were not repaired by this feature.

Run from the package directory:

```sh
npm test
npm run typecheck
```

## Isolated application and rendered review

A fresh, credential-free running BB installed a disposable copy of the plugin as a local path and reported it running. A read-only status RPC returned no connected accounts. The unchanged production tool handler rejected a controlled invalid recurrence and emitted the attributable bounded diagnostic `Google Calendar agent_tool gcal_create_event recurrence_invalid`. Neither the synthetic private-input sentinel nor any credentials or calendar data appeared in that log. This proves that installed validation boundary, not production Google connectivity or provider failure diagnostics.

The actual production Approval component was mounted in BB Settings by a **fixture-only** app extension, alongside the ordinary connection UI. Twenty-two rendered cases passed at 1280px and 390px: indefinite, count/multiple weekdays/interval, cutoff, one-off, malformed recurrence, submission error, pending submission, decline, update-series, update-occurrence and delete-series. Keyboard focus, keyboard submission, collapsed technical details, notification-default-off, busy-disabled actions and non-overflowing approval layout were checked. Desktop and narrow screenshots were visually reviewed, with the comparable Google Drive connection viewed in the same real BB host.

To reproduce this opt-in review, use a built BB checkout (or the `bb-app` devDependency), start the controller, and navigate a browser automation session to the printed disposable URL:

```sh
BB_REVIEW_ROOT=/path/to/built-bb node test/run-recurring-preview.mjs
# In a separate shell with an explicit browser session and machine:
bb browser-automation run <session-id> \
  --script-file /absolute/path/to/google-calendar/test/recurring-browser-review.mjs \
  --script-host <host-id> --timeout 120s --json
```

Skip BB's first-run onboarding if it appears. The preview controller inherits no provider credentials or personal home directory, connects no Google accounts, exposes only a fixed invalid-input diagnostic probe, and removes its disposable installation on clean SIGTERM. All synthetic choices are no-ops. Do not install this generated fixture into a configured BB installation.

## Remaining delivery limits

The production Google Calendar installation was inspected as a Git-backed marketplace registration and **was not switched or patched**. A preserving Local development switch was offered; permission was not supplied during this implementation. Unpublished code was therefore tried only in the disposable BB above. Production application, real Google series readback and native pending-interaction placement in a real conversation remain **unverified**; synthetic Settings rendering and fake-host consent tests are not proof of those boundaries. No provider/model conversation was started for review.

No real appointment, invitation, Google event or account mutation was made. These tests do not establish that any requested appointment exists. Use the normal owner approval for an explicitly requested creation after the intended code is applied; inspect the calendar rather than replaying an uncertain write.
