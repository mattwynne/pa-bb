# 2. Release PA components explicitly through one shared pipeline

Date: 2026-10-21

Status: superseded for the updater workflow on 2026-10-22 by [021 — Git-first PA updates](../plans/021-git-first-pa-updates.md).

The owner chose **edit → try on the server → commit and push**, with drift measured against `origin` and the code actually applied. A separate versioned release is not required for this workflow. The shared component-release pipeline was not implemented; do not continue it as an updater prerequisite. The decision below is retained as history, not current policy. Formal releases may still be requested separately for distribution.

## Context

PA plugins have independent versions. Calendar has an explicit GitHub release
record, but the other plugins have been updated from `main` and package version
numbers. This incorrectly treats pushed code as released code.

Uncommitted edits, local commits and pushed-but-unreleased work all need the same
protection. Pushing work must not remove a **Local changes** warning or allow an
update to replace that component by default.

## Decision

### One release process, independent component versions

Use one shared GitHub Actions release workflow for Calendar, Drive, Fastmail,
iCloud, Obsidian and PA updater. Release each component independently; there is
no PA platform version.

A release is a deliberate operation for a named component, version and source
revision. The workflow must:

1. Validate that the component, package version and proposed tag agree.
2. Run the affected package's required tests, build, typecheck and applicable
   installed/rendered gates against that revision.
3. Publish a GitHub release and its validated release record only after those
   checks pass. Preparing a tag or draft before publication is not a release.

Use component-specific tags, such as `icloud-v0.3.3` or `pa-updates-v0.2.10`.
Each published record identifies the component, version, source commit and
subdirectory, compatibility requirements and release notes. Include checksums
for any distributed package artifacts.

A published version and its record are immutable: do not replace assets, move
its tag or reuse the version for different code. Releasing one component must
not silently release other components at the same repository revision.

A push, merge into `main`, version bump, tag or draft release alone does **not**
make code released. Only a published, non-prerelease GitHub release with a valid
component record is eligible for ordinary PA updates. Find releases per
component, not through the repository's single global “latest release”.

### Protect work relative to releases, not pushes

The updater must compare work against the component's actual release record,
not the latest code on `main` or a potentially stale remote-tracking branch.

Work not included in that release remains **Local changes**, whether it is:

- uncommitted, including staged or untracked work;
- committed locally;
- pushed to GitHub but not released.

For a component with local changes and an available update, **Keep local** is the
default. Updating that component requires an explicit **Install released
version** choice. Source location is an internal fact, not a distinction the
user must understand to make this choice. These choices never publish or delete
work in the source workspace.

A checkout that is merely behind a release is not evidence of local changes.
If release or local-work status cannot be established, show uncertainty rather
than a green **Up to date** result or automatic update permission.

### Install released code

Both update offers and native installation must use the published release
records. A version number or an entry in the UI is not sufficient: the code
actually installed must belong to an eligible component release. Do not silently
install an unreleased `main` revision because a supported native update API
happens to follow it. If the native delivery mechanism cannot establish this,
report the delivery blocker rather than bypassing the release boundary.

This does not require exact preview-version pinning. A newer compatible,
properly released version remains acceptable; report the version actually
installed. Existing consent, local-work and uncertain-write protections remain.

## Rollout

- Preserve the existing Calendar release as historical evidence; do not retarget
  it to fit the new naming convention.
- Establish the other components' starting release records from verified prior
  deliveries and their exact source revisions. Do not declare the current
  contents of `main` released merely to fill missing records. Unknown baselines
  remain unknown until established.
- Bootstrap only previously released code. Do not release outstanding source
  work to clear a warning or as a side effect of fixing the updater.
- Apply the same workflow and record format to all six components, and update
  the updater's comparisons, offers and installation checks together.
- Test all three unreleased-work states, including work pushed to `main` without
  a release. A metadata-only change is not completion of this decision.
- Use an authorized maintainer route for workflow changes; do not expand an
  agent's credential permissions to work around a publishing restriction.

Until these changes are implemented, the current updater is not proof that
pushed-but-unreleased work is protected. Documentation records this decision;
it does not make the existing pipeline compliant.

## Consequences

Agents can push work without accidentally releasing it. Each plugin follows the
same release rules while retaining its own version. Users see one understandable
local-changes decision, and release records provide a stable boundary for both
comparison and installation.
