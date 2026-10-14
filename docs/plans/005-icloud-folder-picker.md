# 005 — Make the iCloud folder picker feel like a file browser

Status: iCloud 0.1.2 installed; deployment interruption recovered with explicit approval and a successful normal sync.

## Change

Replace the loose name/Open/Select layout with BB-themed folder rows: a folder icon and clickable name for navigation, a chevron, and a clearly bordered Select button. Add compact back/close icon buttons and breadcrumb navigation. Show already-selected folders and nested-selection restrictions directly instead of offering an action that will fail. Keep a prominent Select this folder action for the current folder, and explain temporary disabled controls during an operation.

Use BB's shared icon component and existing connection button styles; keep labels for screen readers and visible keyboard focus. The provider currently lists folders only, so do not invent file rows or claim files can be selected. Add folder and action icons to selected mirrors and everyday controls without changing consent, provider calls, credentials or sync behaviour. Progress reporting is a separate change, not part of this visual pass.

## Gates

- Unit tests for selected/parent/child restrictions and retained previous mirrors.
- Existing Cucumber, adapter/host tests, build/typecheck and shared UI drift checks.
- Rendered running-BB review at desktop and narrow widths: root/nested/empty folder listings, breadcrumb/back navigation, selected/overlapping entries, long names, pending/error feedback, keyboard focus, icon rendering and confirmation dialogs. Compare with an existing connection and inspect screenshots rather than relying on a build.
- Ship only iCloud. Since syncing is already enabled, check that no folder run is active before reload; do not deliberately interrupt a run, request a resync, change selections or access personal file content to verify a UI change. Preserve other plugins and connection state. Seek feedback from the deployed screen.

## Verification

- 29 Cucumber scenarios / 222 steps and 22 unit/adapter/host tests passed, including the stock-rclone checks with no skips. Typecheck, build and shared connection UI drift checks passed.
- Running isolated BB rendered 17 controlled states at 1280px and 390px. Exercised keyboard focus, navigation through parent/root breadcrumbs, selection feedback, overlap restrictions, loading/error recovery, close-during-request handling and consent dialogs. Inspected screenshots and compared the controls with the existing Fastmail connection. Corrected unsupported icon names found during visual review.
- Initial deployment was held while the first sync was running. The initial sync subsequently completed, and production reported successful later runs.
- Only iCloud was updated to 0.1.2 after an idle status check; the account remained connected and the other installed integrations stayed unchanged. The idle check did not reserve the window: a scheduled run started during update preparation and plugin disposal interrupted it. This was a deployment mistake. Sync is now failed/disabled with the last successful timestamp preserved; no automatic retry, baseline reset, lock clearing or resync was attempted.
- Read-only recovery metadata inspection found an initialized marker, no baseline lock, no baseline writes after the last success, no interrupted backup staging directories and retained recovery manifests. This does not establish that it is safe to resume. Recovery review and live rendering of this version remain pending.
- Future updates must explicitly quiesce new runs before preparing/reloading the plugin and wait for the current run to finish. A point-in-time idle check is not sufficient. The shipping skill now requires this.

## Approved recovery

A stock-rclone dry run against a private copy of the original baseline succeeded with no proposed file operations or errors. The original baseline and local file metadata remained unchanged. The owner explicitly approved resuming the existing folder. With the plugin stopped, a private checkpoint was saved and only the interrupted status was changed to paused; files and baselines were untouched. The plugin was restarted and resumed through its normal validated control. A subsequent normal sync completed successfully, leaving the folder enabled/ready with no failure and an advanced successful timestamp. No resync, fresh mirror, lock removal or file restore was performed; other integrations were unchanged.

The deployed connected UI was inspected in running BB at 1280px and 390px, including native icons, keyboard focus and layout. Private folder names were masked in review screenshots. Progress bars are tracked separately in [iteration 007](007-icloud-sync-progress.md).
