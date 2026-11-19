# Set up and run PA

Use `provisioning/playbook.yml` from a reviewed provisioning revision. Keep that
revision separate from the writable application checkout: changing the
provisioning pin never pulls, resets, switches or overwrites existing source.

## Inputs and first setup

The supported host is Ubuntu 24.04 x86_64 with Python 3. Infrastructure must
provide an unprivileged account and persistent writable home before invoking
PA. The controller needs ansible-core 2.16 or later. See the
[dependency guide](README.md) for pinned native requirements.

Private inventory defines `bb_hosts`, `pa_bb_user` and `pa_bb_home`. Optional inputs:

| Input | Default / behavior |
| --- | --- |
| `pa_bb_group` | The application user's group |
| `pa_bb_prefix` | The user's `.local` directory |
| `pa_bb_source_dir` | `src/pa-bb` inside the user's home |
| `pa_bb_service_name` | `bb` |
| `pa_bb_bind_host` | `127.0.0.1`; external access is infrastructure policy |
| `pa_bb_require_home_mount` | `false`; enable when the home itself must be a mount |
| `pa_bb_app_url` | Unchanged unless supplied |
| `pa_bb_pi_settings` | Private bootstrap defaults; existing settings are never overwritten |
| `pa_bb_cli_argv`, `pa_bb_user_path` | User-local stock BB CLI and tool PATH |
| `pa_bb_version_url` | The local stock BB version endpoint |
| `pa_bb_dev_mode` | `true`; persistent native watchers for enabled PA plugins |
| `pa_bb_allow_service_start` | `false` for a stopped existing installation |
| `pa_bb_retirement_backup` | Required private archive path when removing retired plugins |

Use a private inventory outside this checkout; never put credentials in command
arguments or enable verbose logs. From the reviewed provisioning checkout:

```sh
export ANSIBLE_ROLES_PATH="$PWD/provisioning/roles${ANSIBLE_ROLES_PATH:+:$ANSIBLE_ROLES_PATH}"
ansible-playbook -i "$BB_INVENTORY" provisioning/playbook.yml --syntax-check
ansible-playbook -i "$BB_INVENTORY" provisioning/playbook.yml --check --diff
# Review the plan, backups and recovery access, then apply:
ansible-playbook -i "$BB_INVENTORY" provisioning/playbook.yml
# Repeat immediately; require no unexpected changes:
ansible-playbook -i "$BB_INVENTORY" provisioning/playbook.yml
```

Check mode on an absent installation previews bootstrap tasks but cannot query
a server that does not yet exist. It never starts watchers or registers plugins.
An infrastructure caller can import this playbook after creating the `bb_hosts`
inventory group and supplying private inputs. Preserve other Ansible role paths.

Node 24, Pi, stock BB and Codex are bootstrapped only when absent. A broken
existing executable is refused, not overwritten. Working versions, native BB
updates, account grants and runtime configuration remain under their existing
controls. The checksum-pinned Workspace launcher is also installed only when
absent. No account sign-in is performed. Existing Pi settings are preserved.

## What repeat provisioning does

PA reads main's tracked `plugins/*/package.json` files with `git ls-tree` and
`git show`. Ignored remnants and packages tracked only on another branch do not
become plugins. The current files must have the same IDs and a package lock.
Dirty files and unpublished commits stay untouched. Bring main forward yourself
through normal reviewed Git operations when wanted; provisioning never fetches
or updates it. The resolved main commit is recorded in the reconciliation plan.

BB's native plugin list is compared with those manifests:

- Missing plugins are registered from their existing local paths.
- Correct registrations are not reinstalled. Disabled plugins stay disabled
  and do not get watchers.
- A same-ID source mismatch stops provisioning; it is not a source transition.
- Registrations directly inside this checkout's `plugins/` directory that are
  absent from main are retired through `bb plugin remove`. Independently
  sourced plugins are untouched. No retirement list or custom registry exists.

**BB removal deletes the retired plugin's settings, secrets and schedules.**
Before removal, review an offline, protected backup and recovery route, then
supply its existing private archive path as `pa_bb_retirement_backup`. A missing
or unprotected archive stops the run before removals or registrations. The
role checks the archive's presence/mode, not its recoverability: the operator
must verify that. Local source folders are never deleted. Do not restore old
sync databases against newer files without separate compatibility review.

Missing dependencies are installed with `npm ci` only for absent or disabled
plugins. Provisioning refuses to replace dependencies under an enabled plugin.
It does not explicitly rebuild or reload correct existing registrations.
An active BB is never automatically restarted when its unit changes: the change
is staged and reported. A stopped existing BB requires explicit startup approval,
because startup itself can apply working-copy code.

## Development mode

Dev mode is on by default and persists across reboots. It does not pause sync or
remove functionality. Each enabled PA plugin has a systemd service running stock
`bb plugin dev <path>`. Independent plugins are not watched.

```sh
# Session controls; run with service-management permission:
systemctl start pa-bb-dev.target
systemctl stop pa-bb-dev.target
systemctl status pa-bb-dev.target 'pa-bb-dev-*.service'
journalctl -u 'pa-bb-dev-*.service' -n 40 --no-pager
```

Stopping the target stops its watchers, not BB or its integrations. A session
stop leaves boot enablement unchanged. To turn dev mode off persistently, set
`pa_bb_dev_mode: false` in private inputs and provision again. Provisioning
restores the configured choice, including after a manual session stop.
Use normal Git worktrees for edits; only the checkout BB actually loads is
watched. A separate worktree is not automatically applied.

A watcher builds and asks BB to reload after source changes. Starting a watcher
alone is not a guarantee that it has replaced the loaded backend.
**A build is not proof that new code is running.** In the tested BB 0.49/iCloud
0.3.2 arrangement, iCloud rejects native hot reload with `busy` because the old
instance still owns its filesystem worker. BB retains the running old instance;
the watcher must not disable it, kill its worker or retry through another route.
To try changed iCloud code, schedule an explicit controlled stop/start, preserving
sync failures, baselines, locks and recovery state. Check active work first and
never restart a service hosting your agent without a durable handoff.

An Obsidian reload can interrupt a caller whose save is still completing. Treat
that outcome as uncertain: inspect the original operation receipt through status
before doing anything else; never repeat an append or create blindly. Generated
Linux ARM64 container tests with stock BB 0.49 held saves for over six seconds before/after durable
publication. Reloading Obsidian preserved exact bytes and one receipt; reloading
iCloud was refused and the original save completed. These tests are not proof
of every crash, BB version or cloud-provider failure. Do not generalize native
reload safety to a different file writer without testing its lifecycle.

The BB service and development target have separate native systemd controls.
A BB restart propagates to the watcher units. After a deliberate full stop,
start BB and then the development target again if dev mode is configured on.
No deployment coordinator, migration service or release publisher is added.

## Verify and roll back

After apply and repeat, inspect the effective unit (`systemctl show` and any
reviewed drop-ins), the running version endpoint's `currentVersion` and
`installKind`, and `bb plugin list --json`. Check actual source registrations and
enabled states, not just package versions. Confirm watcher processes stay alive,
and observe successful activation or an explicit refusal after a synthetic
change in a disposable installation. Perform only harmless provider reads and
inspect bounded logs; leave pre-existing failures alone.

For a watcher-only rollback, stop `pa-bb-dev.target`, set `pa_bb_dev_mode: false`
and re-provision. No plugin reinstall or account reconnection is needed. For an
application-provisioning rollback, select the prior reviewed provisioning
revision and review its plan; do not blindly apply an older bootstrap playbook
that might overwrite current state. Restore saved service definitions only
through reviewed infrastructure code and an explicit maintenance window. Source
and data remain in place. Restore a protected data backup only as a separately
reviewed recovery operation, not a routine code rollback.
