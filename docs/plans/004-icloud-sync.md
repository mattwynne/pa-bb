Drafted by Matt's robot

# 004 — iCloud folder sync

Status: installed; live Apple connection and scheduled sync verified in follow-up iterations, with phone-to-consumer and expired-session checks still pending.

## Outcome

An independently installable iCloud plugin connects one Apple account through protected BB settings, lets people browse and select folders by name, and supplies persistent local mirrors to other integrations. Enable two-way background sync explicitly; poll once per minute. The first live target is a disposable vault, never a personal vault or whole Drive without separate approval. Advanced Data Protection is off for the initial test, not a general requirement.

Follow the [brief](../problems/icloud-plugin.md), [host requirements](../reference/bb-host-requirements.md), [rclone ADR](../adrs/0001-provision-rclone-on-the-pa-host.md), [UX standards](../ux-standards.md), and [observability standards](../o11y-standards.md).

## Architecture

- **Core:** account setup state, selected folders, consent, scheduling eligibility, success/failure state, pause/resume/reconnect/disconnect. It depends on ports, not rclone commands, JSON states, config keys, paths or exit codes.
- **CloudProvider port:** check availability, connect using account credentials, answer an authentication challenge, list child folders, prepare an initial mirror, synchronize a selected folder, disconnect and stop. Return domain challenges and bounded failures. Credentials cross this port only from a protected settings boundary, never from agent tools. The production implementation is `RcloneCloudProvider`; tests use an in-memory fake.
- **StateRepository port:** persistent account-independent folder identifiers, enabled/paused state, last successful sync and recovery state. Never store credentials or raw provider errors here.
- **Rclone adapter:** stock pinned rclone v1.75.2, private permission-protected Unix socket, JSON configuration requests and 2FA continuation. Keep the rclone API inaccessible to browsers and agents. Encrypt persistent configuration with a separately protected key; transfer secrets over pipes or the private socket, not arguments or environment values.
- **BB driving adapters:** authenticated protected account forms, typed status/control RPC, theme-token UI, host-owned persistent storage, one-minute host schedule and disposal hooks. Do not put login secrets in RPC contracts discoverable by other plugins or agent context.
- **Consumers:** an explicit read-only folder inventory reports sync state and host-managed local locations to integrations; the settings UI never requires path selection. No general file-edit agent tools are part of this iteration.

## File safety

Preserve both conflicting versions. Treat renames as creation plus deletion unless verified backend support says otherwise. Propagate deletions only after a successful baseline; retain independent local recovery snapshots for 30 days within a fixed bounded budget. If capacity would prevent a safe run, pause instead of dropping recovery silently. A fresh mirror is empty before initial baseline creation; initial preparation is explicitly authorized by Enable sync. Never automatically resync an existing mirror, clear a stale lock, force deletion checks or recover after errors. Failed or interrupted runs pause and keep their last successful timestamp. Reconnect restores authentication, not permission to resume a failed sync.

## Delivery steps

1. Write Gherkin features and run them with cucumber-js. Define the ports and a fake provider; drive the core entirely through those ports.
2. Implement persistent state and protected credential storage. Verify BB's actual APIs and process lifecycle against the installed SDK/host.
3. Implement and test rclone setup/challenges, private transport, encryption, folder browsing, initial baseline, regular bisync, bounded backups and stop semantics. Test with synthetic secrets; never surface raw stderr or provider error messages.
4. Wire BB schedule, protected forms, folder inventory and controls. Reuse the shared connection UI. Cover first-run, pending 2FA, empty, connected, paused, failed, reconnect and disconnect states.
5. Add marketplace entry, portable setup/host documentation, adapter tests, fake-BB integration tests, shared UI drift checks, builds and typechecks.
6. Review the diff; exercise rendered BB at desktop and narrow widths with keyboard navigation and controlled failures. Use only the approved disposable vault for live mutations. Commit/push/deploy through the repository shipping procedure after gates pass; record exact unverified gates if access prevents completion.

## Executable acceptance coverage

Gherkin scenarios must prove: no sync before consent; Apple challenge completion without exposing setup details; folder selection by name; initial preparation exactly once; scheduled changes in both directions; last success only after completion; overlap prevention; pause/resume; failure and restart fail closed; no automatic recovery; reconnect does not enable sync; disconnect preserves local mirrors; independent folder state; no nested selections; conflict/deletion/rename recovery policy and backup capacity failures. Adapter tests establish actual rclone flags and safe credential/log boundaries rather than pretending a fake proves the provider.

## Release evidence

Record scenario/test counts, build/typecheck results, installed version/commit, safe failure diagnostics, rendered UI observations and narrowly scoped live sync results here. A passing build is not a passed live UX or provider gate.

### First implementation evidence

- Cucumber-js: 19 scenarios, 172 steps passed. Five scenarios exercised the actual stock v1.75.2 executable against generated local data: bidirectional edits, conflicts, deletion recovery, rename propagation and capacity refusal. No Apple account was accessed.
- 19 unit/adapter/fake-BB tests passed, including encrypted config restart, missing-key refusal, private socket permissions, stale lock preservation, timeout handling, account binding, protected form/control boundaries, restored-session verification, safe failure logs, deduplicated backups and 30-day expiry. Build, typecheck, marketplace schema and shared UI drift checks passed. Existing Calendar, Fastmail and Drive suites also passed.
- Rendered running-BB review: ten controlled states at 1280px and 390px, compared with Fastmail. Keyboard focus, protected fields, folder selection, initial-enable confirmation and fresh-mirror recovery confirmation passed. Controlled rendering is not a claim of live Apple authorization.
- Recovery does not repair failed baselines: an explicitly confirmed fresh mirror gets a new local location, preserving the previous mirror and unsent edits with phase `retained`. Historical-version restoration and merging remain operator-assisted. Content-addressed recovery copies avoid accumulating identical full copies every minute; interrupted staging still fails closed.
- Limits: selected folders only; no Photos or whole-Drive selection. Trusted-device and automatically sent SMS codes are supported; selecting among multiple SMS phone numbers is not yet implemented. Consumers must explicitly choose a replacement mirror, not silently switch to it.
- Marketplace deployment: implementation commit `a2745ff` installed as iCloud 0.1.0. Running BB reported stock rclone available, no connection, no selected mirrors and an empty read-only inventory. Other integration versions remained unchanged and running. The actual production first-run form rendered at desktop and narrow widths; protected input and keyboard checks passed without submitting credentials. An isolated host's missing-rclone path produced only `iCloud prerequisite unavailable` in its plugin log.
- Rendered follow-up: explicitly number setup steps because BB resets list markers. Wait for plugin CSS in the review harness before taking screenshots or asserting layout.
- Follow-up evidence: Apple login, folder access, scheduled sync and connected production UI were verified during iterations [005](005-icloud-folder-picker.md) and [007](007-icloud-sync-progress.md). Incremental recovery and its live results are tracked in [008](008-incremental-icloud-recovery.md).
- Remaining live gates: a phone edit reaching BB through a consuming integration, expired-session recovery, and feedback on the current release. Do not use a personal vault merely to close these gates.
