# Host and browser provisioning

This directory owns the **portable Ansible role for PA for BB's host
requirements**. An infrastructure project consumes a pinned Git revision of
this repository. It owns inventory, transport, VM/container creation, storage,
service users, secrets, service lifecycle and scheduling.

The PA integration plugins never install packages or run sudo. The
`pa_bb_host_dependencies` role owns root package tasks. The separate
`pa_bb_browser_automation` role installs/enables BB's official
`builtin:browser-automation` as the existing BB service user. Neither role
installs BB, connects accounts, selects vaults, starts sync or changes note
storage. BB must already be running before the browser plugin role runs.

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
- Native `google-chrome-stable` from Google's signed Linux APT repository.
  The role manages `/etc/apt/sources.list.d/pa-bb-google-chrome.list` and a dedicated,
  checksum-pinned public key under `/etc/apt/keyrings` from
  [Google’s Linux repositories](https://www.google.com/linuxrepositories/).
  APT resolves the browser's declared shared-library/font dependencies; Ubuntu's Snap `chromium-browser`
  is not used. Chrome follows the stable channel available at initial install;
  `state: present` preserves an installed version on repeat runs. Security
  updates remain the infrastructure project's responsibility.
- An existing mounted procfs. The role verifies its descriptor interface; the
  infrastructure project must also ensure BB's service user can inspect its
  own processes and inherited descriptors.

The role uses Ansible's built-in modules only; use **ansible-core 2.16+** on the
controller. The target needs Python 3 and configured Ubuntu package sources
with the pinned package available. Ubuntu repository selection, routine APT
cache refreshes and operating-system updates remain infrastructure
responsibilities. The one managed additional
repository is Google's Chrome stable channel, restricted with `signed-by` to
its checksum-pinned key. Its creation refreshes the APT cache; no system-wide
upgrade or downgrade runs. Review any existing Chrome repository configuration
before adopting this role. Ansible disables the package's `repo_add_once`
and `repo_reenable_on_distupgrade` controls in `/etc/default/google-chrome`,
and removes the standard `google-chrome.list`/`google-chrome.sources` entries
in favor of its own source. This prevents Chrome's post-install/cron migration
from rewriting the managed source or creating a second repository. Other
source filenames are preserved; inspect any custom Chrome entries for
duplicates. A signing-key rotation requires a reviewed manifest checksum change. Package
service actions are suppressed for the transaction; Ubuntu's `needrestart` is
restricted to listing, not restarting, affected services. The role leaves
service restart decisions to the infrastructure project.

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

## Browser Automation installation and runtime

The standalone playbook runs the host role as root, then the browser plugin
role as the configured BB user. In a consuming playbook, add this second play
**after BB installation and service startup**:

```yaml
- name: Provision the official browser plugin
  hosts: bb_hosts
  gather_facts: false
  roles:
    - role: pa_bb_browser_automation
```

Private inventory must supply `pa_bb_user` (existing, non-root service user),
`pa_bb_home` (its absolute home), and, if needed, `pa_bb_cli_argv` (a list,
for example `["/usr/bin/node", "/opt/bb/cli.js"]`) and `pa_bb_user_path`.
The defaults use `bb` and `/usr/local/bin:/usr/bin:/bin`. Include the existing
Node/npm/BB bin directories in that PATH. The CLI must resolve to this user's
existing server; keep connection configuration in that user's protected BB
configuration. Run this role once per BB server, not once per enrolled worker.
Apply the host role to each supported host where headless sessions will run.

The role reads `bb plugin list --json`, installs
`bb plugin install builtin:browser-automation --yes --json` only if absent,
and enables an existing disabled official plugin. It refuses another source,
checks for running status after apply, and never updates/reinstalls an already
enabled plugin. Check mode reads state and reports planned changes without
installing/enabling anything. Plugin output is suppressed to protect other
installed-plugin metadata. A failed or uncertain install must be inspected
with the supported CLI before rerunning provisioning.

Requirements were checked against BB 0.46.1's installed Browser Automation
skill/host bundle and installed `dev-browser@1.0.0-rc.3` documentation, plus the
[upstream plugin README](https://github.com/get-bb/bb/blob/main/plugins/browser-automation/README.md).
The packaged plugin omits its README; upstream may describe a newer runtime.
BB's [browser guide](https://getbb.app/guides/agent-browser) also documents the
first-run requirements. Specifically:

- Node/BB are infrastructure prerequisites. npm **9.5+** must be on the browser
  host worker's PATH; the plugin role checks the service user's npm version.
  Provision npm with the existing supported Node installation, rather than
  installing Ubuntu's separate Node/npm stack over it.
- Chrome discovery checks `<plugin host dataDir>/runtime/chrome`, then the
  macOS Chrome path, then `google-chrome`, `google-chrome-stable`, `chromium`,
  and `chromium-browser` on PATH. This provisioning uses the native Chrome
  package's `/usr/bin/google-chrome-stable`; it does not guess a plugin-data
  location or create a symlink. Keep `/usr/bin` on the BB host worker's PATH.
- The first session downloads the plugin-pinned DevBrowser npm release and
  GitHub artifact into plugin-owned host storage, verifying provenance and
  digest. It needs outbound HTTPS to npm, its attestation services and GitHub.
  Verified warm starts work offline. Do not globally install DevBrowser or
  duplicate its pin in Ansible. Google's APT repository needs outbound HTTPS
  during provisioning; persistent writable plugin storage is required.
- Plugin-owned headless Chrome launches with `--no-sandbox` in the inspected
  release. Use a trusted, isolated BB host and account for that upstream limit;
  this provisioning does not change kernel sandbox settings or launch flags.
  Desktop attachment retains the existing desktop browser's launch flags.

After applying, repeat the playbook and require zero changes. As the BB user,
confirm `bb plugin list --json` shows the official plugin running. For the
end-to-end gate, select the intended connected machine explicitly and open a
session from a BB thread:

```sh
bb browser-automation open --backend local --headless --machine <host-id> --json
bb browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("data:text/html,<title>Provisioned</title><h1>Ready</h1>"); console.log(await p.title())' --json
bb browser-automation close <session-id> --json
```

First open prepares plugin-owned runtime storage and can take a minute. When
working through an agent, emit its returned `previewDirective` exactly once.
Record this gate and first/repeat apply results in private infrastructure
notes. A version check or running plugin alone does not prove browser startup.
Provisioning tests never open a live browser or change the running BB server.

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

The suite includes local Ansible execution of the BB-user role with synthetic
BB/npm/Chrome commands: fresh install, repeat with zero changes, enabling a
disabled plugin, check mode, configuration/source refusal and bounded failures.
It does not connect to BB or run root package tasks. These execution tests are
skipped if `ansible-playbook` is absent; a release validation needs them present.

Local manifest/syntax tests are not an applied-host or browser-startup proof. Record
host check/apply/repeat results in the private infrastructure project, without
copying deployment identities here. Search correctness and plugin delivery have
separate gates.
