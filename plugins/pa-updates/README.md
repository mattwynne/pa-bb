# PA updates

A **read-only Google Calendar release review** in BB's sidebar footer. It does
not install, update or remove plugins, edit checkouts, suppress native prompts,
or restart BB/Pi. Other PA plugins are outside this pilot.

## Use it

1. Add the PA marketplace if needed (see the repository setup guide).
2. Install `pa-updates@pa-for-bb` independently. Calendar is not installed as a
   side effect.
3. Open the **PA updates** footer icon. Read the installed/published versions,
   local-work status, release notes and last successful release check.
4. Choose **Check again** to retry. Checks are limited to once a minute and
   scheduled every six hours by the server, not by each browser.

Requires BB **0.45.0+**, Node **22.18+**, outbound HTTPS to GitHub, and Git only
if a development checkout is configured. BB 0.45.0 / SDK 0.6.15 are the verified
API baseline; engine ranges are declarations, not a compatibility guarantee for
all later runtimes. Native BB and Pi update controls remain available.

## What the states mean

- **Current** requires matching package version and exact known source revision.
- **Update available** means a higher published version, not permission to apply.
- **Source differs** means the same version has different source (or an unrelated
  installation source). It is not automatically a newer release.
- **Installed revision unavailable** means source equality cannot be established.
  BB 0.45.0 normally reports a 12-character installed revision. We display that
  precision, never expand it from history: its history also includes prepared
  candidates. Matching short revisions do not prove an exact match.
- **Local changes found** covers relevant staged, unstaged, deleted and untracked
  source. **Local commits not in release** covers relevant unpublished commits.
- **No local changes found** is a timestamped observation against the release,
  never an installation reservation or proof against installed-code drift.
- **Local work not assessed / Cannot establish safety** means missing mapping,
  objects, access, supported layout, stable files or ordinary shared ancestry.
  Ask the operator to review the checkout. Discovery still works.
- A failed release check keeps the last validated record and marks it **stale**.
  The last successful check and most recent attempt are shown separately.
  Inventory, local-work and storage failures do not mean “up to date”.

Release notes are inert text. Source details and notes open as disclosures; the
retry control stays visible while the content scrolls.

## Operator configuration

Associate the Calendar development checkout by setting the server environment
variable `PA_UPDATES_CALENDAR_CHECKOUT` to an operator-selected absolute checkout
root, then reload this plugin through BB's normal controls. Keep that value in
protected service configuration; do not put paths in releases, chat or logs.
There is no path/command RPC or browser path-entry form. Without a mapping,
release discovery works and local work is explicitly not assessed.

Trusted scope is declared in `core/release.ts`: `plugins/google-calendar`,
`shared/connection-ui`, and `scripts/sync-connection-ui.mjs`. Dirty Obsidian-only
work does not block Calendar; relevant shared work does. Ordinary ignored build
outputs and state do not block it.

The inspector accepts ordinary non-shallow Git checkouts with a `.git`
directory. Linked worktrees, submodules, replace/graft histories, config
includes, extension/filter configuration and divergent histories stay unknown.
It disables optional Git index writes, external diff/text conversion and
fsmonitor, bounds the entire inspection to ten seconds, bounds child output to
1 MiB, and fingerprints HEAD, index, status and both diff layers before/after.
It never fetches, stashes, resets, cleans, checks out, commits or pushes. Missing
candidate objects yield unknown; **there is no repository cache or cache disk
use in this slice**. Make objects available separately, outside the checker's
read-only operation. Untracked source is always a blocker, not sampled away.

## Release trust and publication

The repository/channel is fixed to `mattwynne/pa-bb`, stable dedicated
`pa-release-<full-source-commit>` GitHub releases. Drafts/prereleases and other
tags are ignored. Selection is newest publication time, then descending tag for
a tie. All pages must complete: at most four pages of fifty entries, each at
most 2 MiB. Reaching the cap is an incomplete check, not “no release”. Metadata
is at most 256 KiB, notes at most 8,000 characters, and each HTTP operation at
most ten seconds. Redirects are bounded to trusted GitHub asset hosts.

`releases/pa-release-v1.schema.json` documents the structural contract;
`core/release.ts` also checks semantic versions/ranges and cross-field commit
identity. Records cannot select arbitrary repositories, paths, commands or URLs.
Only Calendar is listed as tested. The backend stores the last accepted identity
and raw content SHA-256 and rejects changed bytes under that identity. Releases
must be append-only: never edit an asset or retarget a tag; use a new tested
revision instead. Historical identities other than the last accepted one are
not retained as an audit ledger. HTTPS and repository write controls are the
trust boundary, **not independent artifact signing**. No executable artifact is
downloaded by this plugin.

Maintainers trigger **Publish PA release metadata** on trusted `main`. Its read-
only verification job checks out the exact event SHA, uses lockfiles, runs the
pilot and checker gates, and generates the record from the tested Calendar
package. Only the subsequent publishing job has `contents: write`; it refuses
existing tags and does not execute package code. No deployment/account key is
needed. The publisher does not choose a new Calendar version just to show an
update.

## Development and verification

```sh
npm ci
npm run build
npm test
npm run typecheck
BB_REVIEW_CHROME=/path/to/chromium npm run test:rendered
```

The rendered suite starts a disposable BB 0.45.0 with a generated older Calendar
installation and synthetic release data, then checks desktop/narrow widths,
keyboard disclosure controls, focus restoration, notes, retry, stale recovery,
real typed RPCs and real dirty/divergent Git observations. Its output labels
this evidence synthetic; it is not a production downgrade or live account test.
See [iteration 017](../../docs/plans/017-pa-update-discovery.md) for delivery gates.

Diagnostics contain only `pa-updates stage=<fixed stage> outcome=<fixed category>`.
A warning establishes the failing boundary, not its private cause. Logs and UI
diagnostics must never contain paths, Git output, exception payloads or account
content. No agent tools are registered.
