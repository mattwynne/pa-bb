# Host dependencies

This directory owns the **portable Ansible role for PA for BB's host
requirements**. An infrastructure project consumes a pinned Git revision of
this repository. It owns inventory, transport, VM/container creation, storage,
service users, secrets, service lifecycle and scheduling.

The plugins never install packages, run sudo or download executables. Applying
this role installs dependencies only: it does not install BB, connect an
account, select a vault, start sync, or change plugin settings or note storage.

## Manifest and supported host

[`roles/pa_bb_host_dependencies/vars/main.yml`](roles/pa_bb_host_dependencies/vars/main.yml)
is the dependency manifest. The initial supported target is **Ubuntu 24.04,
x86_64 Linux**, with:

- Stock rclone **1.75.2**, pinned official archive and extracted-binary SHA-256,
  installed root-owned at `/usr/local/bin/rclone`.
- Stock ripgrep **14.1.0**, pinned Ubuntu package `ripgrep=14.1.0-1`.
- `ca-certificates`, `unzip` and util-linux's `/usr/bin/flock`, provided by the
  supported distribution. These base packages follow its configured repository
  versions; the manifest is not a lock of the entire operating system.
- An existing mounted procfs. The role verifies its descriptor interface; the
  infrastructure project must also ensure BB's service user can inspect its
  own processes and inherited descriptors.

The role uses Ansible's built-in modules only; use **ansible-core 2.16+** on the
controller. The target needs Python 3 and configured Ubuntu package sources
with the pinned package available. Repository selection, APT cache refreshes
and operating-system updates remain infrastructure responsibilities. The role
neither adds repositories nor runs a system-wide upgrade or downgrade.

Additional platforms need reviewed package/version/checksum entries and
validation; do not substitute an untested architecture or silently use whatever
executable is on PATH.

## Consume from infrastructure

Keep a checkout of this repository at a **reviewed commit**, using the
infrastructure project's dependency manager, Git submodule or equivalent
lock. Add its `provisioning/roles` directory to `ANSIBLE_ROLES_PATH`, preserving
any other role paths needed by that project. Do not copy the role or repeat its
version pins in the caller.

```yaml
# In the consuming infrastructure playbook; inventory is supplied separately.
- name: Install project host requirements
  hosts: bb_hosts
  become: true
  gather_facts: true
  roles:
    - role: pa_bb_host_dependencies
```

The infrastructure project owns the dependency's pinned revision and must
include that revision in its reprovisioning/change detection. Updating the
revision must not be skipped just because its own container files are unchanged.

For a standalone invocation, set `PA_BB_CHECKOUT` to the pinned checkout and
`BB_INVENTORY` to a private inventory that defines the `bb_hosts` group:

```sh
export ANSIBLE_ROLES_PATH="$PA_BB_CHECKOUT/provisioning/roles${ANSIBLE_ROLES_PATH:+:$ANSIBLE_ROLES_PATH}"
ansible-playbook -i "$BB_INVENTORY" "$PA_BB_CHECKOUT/provisioning/playbook.yml" --syntax-check
ansible-playbook -i "$BB_INVENTORY" "$PA_BB_CHECKOUT/provisioning/playbook.yml" --check --diff
# Review the plan, then explicitly apply the same pinned revision:
ansible-playbook -i "$BB_INVENTORY" "$PA_BB_CHECKOUT/provisioning/playbook.yml"
# Verify without installing anything, then repeat the apply for idempotence:
ansible-playbook -i "$BB_INVENTORY" "$PA_BB_CHECKOUT/provisioning/tests/verify.yml"
```

Keep inventory, addresses, private keys and deployment notes outside this public
repository. A dependency update is an infrastructure change, not a plugin's
startup action.

## Existing rclone and safe upgrades

An existing rclone with the declared checksum is kept, without replacing its
bytes or restarting a worker. Ownership/mode are checked and corrected to
`root:root` and `0755`. Symlinks and files owned by another user are refused.

A different existing binary is **not automatically replaced**. The caller must
stop dependent services and their supervisors, let all native workers exit, and
then supply `pa_bb_allow_rclone_replacement: true` for that run. A separate
process check also refuses installation while rclone is alive or process
metadata cannot be inspected. That check is additional protection, not a
substitute for stopping a supervisor that could start a new worker.

Downloads use a private temporary directory. Both archive and binary checksums
must match before atomic publication; temporary installer files are removed.
There is no automatic rollback, process killing, service restart, resync or
baseline repair. A failed run leaves services stopped for the operator to fix
forward. Do not downgrade a binary against newer sync state without separate
compatibility evidence.

## Validation

From the repository root, with Ansible and its Python dependencies available:

```sh
python3 -m unittest discover -s provisioning/tests -p 'test_*.py'
ANSIBLE_ROLES_PATH="$PWD/provisioning/roles" ansible-playbook \
  -i 'localhost,' provisioning/playbook.yml --syntax-check
ANSIBLE_ROLES_PATH="$PWD/provisioning/roles" ansible-playbook \
  -i 'localhost,' provisioning/tests/verify.yml --syntax-check
```

Local manifest/syntax tests are not an applied-host or idempotence proof. Record
host check/apply/repeat results in the private infrastructure project, without
copying deployment identities here. Search correctness and plugin delivery have
separate gates.
