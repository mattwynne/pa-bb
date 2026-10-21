# PA updates

Review and apply ordinary released updates to Calendar, Fastmail, Google Drive,
iCloud, Obsidian, BB, Pi CLI and Codex CLI. Local integration customizations stay
unless you choose **Install released version**.

## Use it

1. Install `pa-updates@pa-for-bb` through BB’s normal plugin controls.
2. Open **Settings → PA updates**. The update notice and **PA updates** footer
   icon both open this page.
3. Check the versions and the named PA server. Pi/Codex actions target BB’s
   configured primary host, never the computer displaying the browser.
4. Keep the default **Keep local**, or choose **Install released version** for
   a customized integration. Bulk controls change choices, not installations.
5. Choose **Update PA**. If BB has running threads, its restart requires explicit
   permission to interrupt them. Otherwise wait for those threads to finish.
6. After a BB restart, return to **Settings → PA updates** to read the saved result.

Opening the page or checking never installs anything. The server checks every
six hours; repeated Apply requests join one saved job. The updater does not
replace itself, install absent integrations, update unrelated plugins, or change
other machines. It never executes commands supplied by a browser or release record.

## Versions and results

A preview is not a pin. A compatible released version can advance before the
native installer runs. Receipts distinguish the preview from the actual installed
version, kept customizations, unverified/skipped components, native failures and
uncertain results. Completed steps are not rolled back as a group. Uncertain
installation writes are not retried automatically. Automatic discovery and reloads
keep the saved outcome visible until you choose **Check again**. Automatic checks
still discover later integration and runtime offers, so the notice can return
without replacing those results. Opening it preserves the result; **Check again**
opens a fresh review. Steps not reached
say **Waiting…** while the job runs and **Not updated** after it stops.

CLI receipts verify the installed version and managed npm provenance. Existing
provider processes and sessions may retain their previous version until their
normal restart or release. No session is forcibly reset by the CLI updater.

BB updates last through its native launcher. The job records restart intent
before calling BB and reads BB’s durable result after reconnecting. A provisional
startup result stays pending; delayed results can still resolve an uncertain
receipt. The plugin does not supervise BB or promise automatic rollback.

## Optional development checkout

Ordinary installations need no repository. Developers can map one full PA checkout
on the server through BB’s **Development checkout (optional)** setting, or:

```sh
bb plugin config pa-updates set developmentCheckout /absolute/path/to/pa-repository
```

Choose **Check again** after changing the mapping. The five integration folders
are checked for Git-visible unstaged, staged and untracked files, and local branch
changes absent from freshly fetched published `main`. A branch that is merely
behind does not count as local work. Affected rows show **Unpublished local changes**
in amber, alongside their installed versions. These checkout changes are **not
installed code** and do not enable Update PA or change Keep local choices.

Inspection never writes to the checkout or runs its hooks, filters, builds or
scripts. Network Git operations use a disposable directory, not cached
`origin/main`. Inspection is bounded to 60 seconds, 256 published commits and
4,096 changed paths; unsupported layouts or an unavailable comparison show
**Couldn’t check local work**, not a green success. Linked worktrees, shallow or
partial clones and custom checkout filters are not supported. Ignored generated
files do not count as untracked work. Clear the setting to disable this inspection.

## What stays in place

Settings, credentials, account data, enablement and kept customizations remain.
Installing a released integration replaces its local code, interface and assets.
The updater checks local changes again before applying. Avoid editing installed
code while an update runs; the native handoff is not an atomic edit reservation.

A failed baseline check is **unverified**, not proof of customization or permission
to overwrite. That integration is skipped without hiding independent updates.
Local-path, pinned and non-main installations are not silently retargeted.

## Requirements and supported scope

- BB **0.46.0+**, Node **22.18+**, Git, and outbound access to the configured GitHub
  and npm services. The verified native path is Linux with BB’s supported launcher.
- Managed integrations from the fixed `mattwynne/pa-bb` repository, `main` channel
  and their normal `plugins/<id>` subdirectories. “Released” means the compatible
  version available through that configured published channel.
- Original-build verification uses published Git objects and an already-installed
  BB builder matching the artifact’s recorded version, or a saved independently
  reconstructed original for that exact integration, source commit and builder.
  It can use the exact native app-version sibling retained by BB. It never
  downloads old BB toolchains or requires a development checkout. Normal builds may download pinned dependencies;
  this is not an offline operation.
- Reconstruction uses temporary files, bounded to 512 source entries and 32 MiB
  per package. At most five active expected-hash records persist—one per integration,
  not an artifact history. Checks seed unchanged integrations before a later BB
  upgrade can prune their builders. Expected hashes come from independent original
  reconstruction, never the currently installed bytes. Tests, documentation,
  dependencies and ordinary operational data are not executable customizations.
- BB must offer a supported native npm/latest or clean source/main update. Desktop,
  development, dirty or unsupported installations use BB’s normal instructions.
  Pi/Codex must already have supported managed npm installations. Missing CLIs
  are not installed as a side effect; external installations are not overwritten.

### iCloud and Obsidian

Automatic paired updates support the current **0.3.x** note-interface family.
Older pairs require the [documented stopped migration](../icloud/README.md).
The installed iCloud must already provide updater-aware Pause support; an older
provider without it cannot safely bootstrap this capability while enabled. Use
that stopped delivery procedure first.

During a paired update, iCloud reserves scheduling and drains work. Its durable
reservation records only folders it paused. User-paused folders stay paused,
including across reload. Failed folders remain paused but release the updater’s
restoration rights, so ordinary recovery controls remain usable. The update shows
an attention result rather than trapping the folder behind the reservation.

After an uncertain integration write, inspect the native result before choosing
**Resume previously enabled folders**. This does not clear recovery failures.

## Release notes and trust

The existing immutable `pa-release-<source-commit>` feed supplies release notes.
Its v1 publisher still covers Calendar only; absent notes are shown as unavailable,
not invented. Offers and application come from the supported native channels.
Older release metadata does not certify a later version installed from `main`.

The optional `PA_UPDATES_CALENDAR_CHECKOUT` environment setting belongs to the
historical read-only discovery check. It is not required for installed-code
assessment or application. Normal users need no checkout mapping.

Repository/channel allowlists, native engine checks and HTTPS/repository controls
are the trust boundary—not independent artifact signing. No workflow-write or
account credential is needed to consume public releases.

## Development and verification

```sh
npm ci
npm run build
npm test
npm run typecheck
npm run test:rendered
```

The rendered gate starts disposable BB and uses the original app with synthetic
typed RPC states at desktop/narrow widths. It checks choices, consent, scrolling,
notes, errors, keyboard access and focus return. It does not perform native writes.

`test/run-ordinary-update-gate.mjs` exercises the original integration executor.
`test/run-runtime-update-gate.mjs` exercises real native CLI installers and BB’s
launcher, then verifies original-build reconstruction and a later plugin update
across the BB upgrade. `test/run-paired-sync-gate.mjs` exercises the actual
updater-aware iCloud/Obsidian pair with generated local alias data and stock
rclone 1.75.2: active sync, reservation, native reload, restored enablement and
preserved notes/receipts. Run these native installer gates **only inside a fresh
disposable Linux container**, with no host credentials, broad mounts, privileged mode or host
networking. Its own HOME/data/PATH/npm-prefix checks are an additional boundary,
not a substitute for the container. Copy evidence before destroying that container.

See [iteration 018 evidence](../../docs/plans/018-pa-platform-updates-ordinary-proof.md)
for tested versions and outstanding gates. A portable unit pass is not native sync
acceptance or permission to deploy.

Diagnostics contain only `pa-updates stage=<fixed stage> outcome=<fixed category>`.
Never log raw installer output, paths, exception payloads, credentials or account
content. No agent mutation tools are registered. BB’s `client` caller category
includes app, CLI and agent clients; it is not an agent-exclusion boundary.
