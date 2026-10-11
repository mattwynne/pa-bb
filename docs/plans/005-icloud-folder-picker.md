Drafted by Matt's robot

# 005 — Make the iCloud folder picker feel like a file browser

Status: verified for iCloud 0.1.2; live deployment held while the initial sync is running.

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
- The connected production status reports an initial folder run in progress and no completed sync yet. This is a deployment safety blocker, not proof of a failed sync. No update, live folder mutation or provider-content read was attempted. Live rendering of this version and post-update preservation remain pending until the current run finishes.
