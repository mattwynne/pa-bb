# Sharing verification

## Automated checks

- `npm test`: shared connection UI drift check; Drive and Calendar builds; 12 OAuth-client reuse scenarios / 82 steps; 167 Node tests.
- `npm run typecheck`: TypeScript and installed public SDK declaration check.
- Public-SDK import scanner and `git diff --check` pass. Native tool parameters have an object root for provider compatibility; the service separately enforces strict action-specific fields.
- Sharing fixtures cover file/folder user/group/public grant, change and revoke; commenter support; discovery-to-link reduction; unrelated permissions/owners; inherited/shared-drive/limited-access/authority/incomplete-list refusals; read-only/Docs-only consent; notification opt-in/defaults; denied/cancelled/malformed/expired approvals; expiry during revalidation; concurrent keys; stale proposals; identity/account isolation; lost POST/PATCH/DELETE replies; provider IDs; response parsing; 4xx refusals; timeouts/rate-limit/server uncertainty; failed verification; durable receipt failure; restart recovery; and later changes to historical verified receipts.
- Native tool-host tests prove mandatory approval even when Docs replacement approval is disabled. Synthetic private content in provider errors/causes/codes does not enter logs. Safe fixed stage/category diagnostics are asserted at the handled boundary.

## Rendered native BB review

The opt-in controller `test/run-sharing-preview.mjs` creates a fresh loopback BB installation and enrolled disposable host, loads the actual working-copy plugin with no accounts, and installs an inert approval fixture. It copies the unchanged production renderer/styles and uses the actual sharing adapter to construct synthetic previews. It does not rewrite source, attach to production data, import credentials or perform provider writes.

Run with a built compatible BB installation (optionally set `BB_REVIEW_ROOT`). The controller prints its disposable URL and process ID. Open that URL using Browser Automation, use **Skip setup** on the fresh profile, then run `test/sharing-browser-review.mjs` at `reviewWidth=1280` and `reviewWidth=390`. Terminate the controller afterwards; it removes its server, daemon and temporary profile. Never install the fixture in a real BB profile.

All 18 cases passed (nine states at each width): named grant with requested email, link grant without email, folder impact, change/decline, revoke/cancel, discoverability reduction, incomplete payload, controlled failed submission and controlled busy submission. The review checks actual native thread placement, focus/disclosure, wrapping, disabled actions, keyboard submission and BB form receipts. Screenshots were inspected at both widths. Spacing was improved after the first visual review, then both runs were repeated against the final renderer. Threads remained inert pending fixtures: no provider turn or Google write occurred. Busy/error controls inject fixture-only waits/failures before the real BB submission; they do not claim to reproduce every network failure.

The unchanged connection UI remains shared with existing Docs approval styling. The new sharing card uses BB theme tokens, an explicit current/proposed summary, account/audience, notification copy and a quiet concurrency/recovery disclosure. It blocks approval of incomplete payloads.

## Local application and limits

The plugin was rebuilt and reloaded through its existing local-path registration, preserving its ID, enabled state, configuration and data. The running plugin advertises `gdrive_change_sharing` and `gdrive_sharing_status`; a harmless connected-identity RPC read succeeds. No source switch, OAuth change, approval-setting change or distribution release was needed.

Provider mutation/readback behavior and recipient ability to open an item remain **unverified against real Google writes**. Production provider-error diagnostics were not induced; controlled failures and redaction were verified with synthetic hosts. Delivery never changes real file/folder access or sends invitations. A separate authorized sharing task must inspect the exact live items, obtain approval and evaluate the resulting readback. Conservative ancestry/policy refusals are expected limits, not permission to bypass them.
