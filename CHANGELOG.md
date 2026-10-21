# Changelog

## [Unreleased]

- PA updates 0.2.9 uses one **Local changes** decision for installed edits and unpublished source work, defaulting to **Keep local**. Source work is found at the standard server workspace without a configuration form. PA updater joins the six-component list and replaces itself last, preserving the same receipt across native replacement and BB restart without replaying uncertain writes.

- PA updates 0.2.8 can inspect one explicitly mapped development checkout. Affected integrations show amber **Unpublished local changes**, separately from installed customizations; dirty files and unpublished branch changes are checked against fresh published main without changing the checkout or authorizing an update.

- PA updates 0.2.7 shows a spinner for pending checks and each component’s fresh result as it arrives. Partial results cannot authorize updates; saved reviews and receipts remain intact until the check finishes.

- PA updates 0.2.6 clarifies unsuccessful version checks as “Couldn’t check” and in-progress refreshes as “Checking…”, without changing specific local, pinned or setup statuses.

- PA updates 0.2.5 adds green checks beside confirmed Up to date versions. Local changes and failed, pinned or unverified checks stay neutral; a failed refresh cannot turn cached results green.

- PA updates 0.2.4 moves the review into Settings → PA updates. The update-available notice remains, and both it and the footer shortcut open that same page. Choices, saved results and the single Update PA action are unchanged.

- PA updates 0.2.3 keeps all installed PA integrations visible after checking, with current versions and honest current, local-change, pinned or unavailable status. This read-only inventory is separate from update offers: current integrations are not reinstalled or added to update receipts.

- PA updates 0.2.2 uses shorter copy and compact, bordered version rows with one Update PA action. Local changes still default to Keep local; individual and bulk choices, restart consent and saved results remain available.

- Fastmail 0.1.7 adds optional CardDAV contact-group list/inspection and preview-first membership add/remove. The MIT service is copied locally from pi-extensions, with BB secret settings, conditional writes, read-back verification and no automatic write retries. Existing MCP tools still own contact creation; message-label changes do not update future sender routing. Live CardDAV access and downstream routing remain unverified.

- PA updates 0.2.0 adds server-owned review/apply/status for the five integrations and BB/Pi/Codex on the configured PA server. Local customizations default to Keep local. Actual-version receipts survive BB’s native restart and remain visible until Check again; uncertain writes are not automatically retried. Five active independently reconstructed baseline records survive later builder pruning. Missing and external CLIs are not silently installed or replaced. Native/runtime and rendered evidence is recorded in iteration 018; delivery gates remain separate.
- iCloud 0.3.2 adds updater-specific, host-verified Pause ownership across reload. User-paused folders stay paused; failed folders release the reservation so normal recovery remains usable. Account and Obsidian note permissions are unchanged. Initial rollout uses the stopped paired procedure.

- iCloud 0.1.11 distinguishes stock rclone's resilient retryable bisync exit 7 from a resync-required lockout using pinned native JSON markers. Only a proven retryable abort enters the ordinary retry path; uncertain output and saved blockers stay stopped. Logs and bounded history now record safe native decisions and a proven listing-failure reason without retaining provider text.
- iCloud 0.1.10 delegates sync directly to native bisync. It no longer takes whole-folder backups, runs extra cloud listings or blocks on legacy recovery archives. Overwrites/deletions no longer have an independent sync-time recovery copy; previously saved copies remain untouched. Rclone's conflict, maximum-deletion, locking and normal recovery checks remain in place, and saved stronger blockers are not automatically cleared.
- Pending/active iCloud retries use neutral status text rather than red error banners; stopped conditions still show actionable errors. Setup and file-safety guidance describe the reduced backup policy honestly.
- Removed robot-attribution banners from repository documentation and report templates.

## Earlier deliveries

- iCloud safely removes metadata-free staging only when it contains nothing except empty cloud/local directories. Cleanup takes the worker lock first and uses non-recursive directory removal; files, partials, selectors and ambiguous state remain protected.
- Recovery warnings no longer blame rclone when the stop may come from recovery-copy validation.

- iCloud recognizes stock rclone's exact trust-token expiry error through its private control socket, including after a failed scheduled read. Other provider errors remain retryable rather than being mistaken for expired authorization.
- Reconnect requires explicit Resume for each enabled, recoverable iCloud folder. Paused and retained folders stay stopped, and storage/configuration/critical blockers are preserved.

- iCloud sync now retries ordinary temporary and interrupted failures through its normal protected schedule, shows stale and recovering states clearly, and provides supported Retry, Reconnect/Resume and confirmed fresh-mirror paths without forced resync.
- iCloud recovery keeps conflicts, recovery copies and native partial-transfer evidence instead of silently discarding unique files.
- After fixing a storage or host-configuration problem, an affected iCloud folder can now retry safely without creating a fresh mirror.
