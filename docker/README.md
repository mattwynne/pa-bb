# Docker

A single-user PA server on **linux/amd64**. Build from a reviewed checkout:

```sh
docker build --platform linux/amd64 -t pa-bb .
docker volume create pa-bb-home
docker run -d --name pa-bb \
  -p 127.0.0.1:38886:38886 \
  --mount source=pa-bb-home,target=/home/bb \
  --shm-size=1g --stop-timeout=60 \
  pa-bb
docker logs -f pa-bb
```

Open <http://localhost:38886> and finish BB setup. For remote access, use your
own authenticated TLS reverse proxy or SSH tunnel; do not expose the port
publicly without access controls. No credentials belong in the image or build
arguments. Connect accounts, configure the public URL, select providers and vaults,
and enable sync through BB after startup. Codex sign-in, for example:

```sh
docker exec -it pa-bb /home/bb/.local/bin/codex login --device-auth
```

## CI images on GHCR

[Docker CI](../.github/workflows/docker.yml) runs Docker unit tests, builds a
**linux/amd64** image, smoke-tests a disposable BB installation and scans the image
for known vulnerabilities on pull requests and pushes to `main`. Pull requests
never log in to GHCR or publish images. Successful builds on `main` publish the
same local image that passed the smoke test:

- `ghcr.io/mattwynne/pa-bb:edge` — the most recently published build from `main`.
- `ghcr.io/mattwynne/pa-bb:sha-<full-commit-sha>` — a commit-specific tag.

These are development builds, not versioned releases. Tag pushes do not trigger
this workflow, and it does not publish `latest`. The smoke test waits for Docker
health and completed startup registration, then verifies each expected plugin's
source and enabled state through BB's CLI. It also runs the note-search plugin's
capability probe and searches generated visible and hidden Markdown files, even
when a generated `.gitignore` excludes them. A missing match, unsupported ripgrep
or failed search blocks publication. It checks that the GTK 3 shared library
loads. The Email check verifies that running BB meets the plugin's minimum
version, imports the same generated email twice through
the real MsgVault adapter, searches and reads it, and checks that a separate archive
stays empty. No mail provider is connected. It creates and removes its own container
and home volume, without publishing a port or using existing BB state. It does not
verify provider sign-in or browser automation.

Trivy scans OS and application packages, including vulnerabilities without fixes.
Each run shows severity counts in its summary and saves the JSON report as the
`image-vulnerabilities` artifact for 14 days. **HIGH/CRITICAL findings with an
available fix block publication**, as do scanner, database, malformed-report,
smoke-test and cleanup failures. Lower-severity findings and findings without a
published fix remain visible in the report. No CVEs are suppressed.

[Dependabot](../.github/dependabot.yml) checks GitHub Actions dependencies weekly
and opens update PRs for the pinned actions. It does not auto-merge or change the
application/tool version pins.

Publishing uses the workflow's `GITHUB_TOKEN`; no registry password or personal
access token is needed. After the first publication, a maintainer must set the
`pa-bb` package's visibility to **Public** in GitHub's package settings. A public
repository does not make a new GHCR package public automatically.

Once public, anyone can pull without signing in:

```sh
docker pull ghcr.io/mattwynne/pa-bb:edge
```

Use that image name instead of `pa-bb` in the run command above. Prefer a
commit-specific tag or image digest when you need to keep a deployment fixed.
Follow the state-preserving update steps below before replacing a container.

## What it includes

The image starts from `node:24-bookworm-slim` and installs dependencies directly
in the Dockerfile—no Ansible or sudo. It includes stock BB, Pi, Codex, native
Claude Code, uv/uvx, rclone, ripgrep, MsgVault, Chrome and the native build toolchain.
BB is pinned to 0.50.1 and MsgVault to 0.26.0, satisfying Email's host requirements.
MsgVault's upstream archive, executable and license are checksum-verified.
Hermes is not bundled. The base image's npm is pinned to a patched release, and
rclone 1.76.0 and ripgrep 14.1.0 use independently verified archive and binary
checksums. The upstream static ripgrep binary satisfies note search's 14+ requirement;
Bookworm's ripgrep 13 package does not.
Each PA plugin gets `npm ci` from its lockfile.

Application versions and shared download checksums match the Ansible provisioning;
`test_dockerfile.py` flags drift. Ripgrep's version matches the host manifest but
comes from the upstream Linux archive. Other Debian packages follow Bookworm's
repositories rather than Ubuntu's package-version pins. Chrome follows
Google's stable APT channel. Node follows the image's Node 24 updates.

At startup it runs BB as UID 1000 and registers all PA source plugins plus the
official Browser Automation plugin through BB's CLI. Existing registrations and
enablement are preserved; source mismatches stop startup. It never automatically
removes retired plugins or migrates an existing installation. Inspect a failed or
uncertain installation before restarting; there is deliberately no automatic
restart policy in the example.

Docker replaces systemd with a foreground process and an init for signals and
child reaping. Logs go to stdout/stderr. Development watchers are not deployment
services; use BB's native `plugin dev` command separately when developing. Account
setup and private Ansible inventory/settings are not baked into the image.
Chrome's first session and Workspace's first launch still need outbound network
access to prepare their plugin-owned runtimes.

### Optional Obsidian Desktop CLI

Supply the official Linux amd64 bundle. Download
[`obsidian-1.15.1.tar.gz`](https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.1/obsidian-1.15.1.tar.gz)
and run this from the directory containing the archive, outside the Docker build
context. Keep the whole bundle together so Desktop can load its adjacent
libraries and resources.

```sh
(
  set -eu
  printf '%s  %s\n' \
    09074f0635ecf366307d808d0fec06c01a87a0bcc66da6d34126ceece0eb8519 \
    obsidian-1.15.1.tar.gz | sha256sum -c -
  mkdir obsidian-1.15.1-amd64
  tar -xzf obsidian-1.15.1.tar.gz --strip-components=1 -C obsidian-1.15.1-amd64
)
```

#### Smoke-test on the target Docker machine

Use the same image and security policy as the intended BB container. This
example runs as the image's `bb` user under Docker's normal profiles with all
capabilities dropped and no-new-privileges. It uses a disposable profile,
socket and vault with no network access.

```sh
docker run --rm -i --init --platform linux/amd64 --network none --shm-size=1g \
  --cap-drop ALL --security-opt no-new-privileges --no-healthcheck \
  --read-only --tmpfs /tmp:mode=1777 --tmpfs /home/bb --workdir /tmp \
  --mount "type=bind,src=$PWD/obsidian-1.15.1-amd64,dst=/opt/obsidian,readonly" \
  --entrypoint /usr/bin/timeout pa-bb -k 5s 45s /bin/bash -se <<'SH'
set -euo pipefail
bundle=/opt/obsidian
for binary in "$bundle"/{obsidian,obsidian-cli,chrome-sandbox,chrome_crashpad_handler,*.so*} \
    "$bundle"/resources/app.asar.unpacked/node_modules/*/*.node; do
  libs=$(ldd "$binary")
  printf '%s\n' "$libs"
  if grep -q 'not found' <<<"$libs"; then exit 1; fi
done
umask 077
scratch=$(mktemp -d)
cd "$scratch"
export HOME="$scratch/home" TMPDIR="$scratch/tmp" XDG_RUNTIME_DIR="$scratch/run"
export XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache"
export XDG_DATA_HOME="$scratch/data" XDG_STATE_HOME="$scratch/state"
vault="$scratch/vault"
profile="$XDG_CONFIG_HOME/obsidian"
mkdir -p "$HOME" "$TMPDIR" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$profile" "$vault/.obsidian"
printf '{"cli":true,"vaults":{"smoke":{"path":"%s","ts":1,"open":true}}}\n' "$vault" \
  > "$profile/obsidian.json"
printf '[]\n' > "$vault/.obsidian/community-plugins.json"
printf '# Target\n' > "$vault/Target.md"
printf '[[Target]]\n' > "$vault/Source.md"
cli() { timeout -k 1s 2s /opt/obsidian/obsidian-cli vault=smoke "$@" < /dev/null; }
/opt/obsidian/obsidian --user-data-dir="$profile" --ozone-platform=headless \
  --disable-gpu --disable-crash-reporter > "$scratch/desktop.log" 2>&1 &
desktop_pid=$!
trap 'tail -n 20 "$scratch/desktop.log" >&2; kill "$desktop_pid" 2>/dev/null || true' EXIT
until [[ -S "$XDG_RUNTIME_DIR/.obsidian-cli.sock" ]] &&
      [[ $(cli version 2>/dev/null) == '1.15.1 (installer 1.15.1)' ]] &&
      [[ $(cli plugins:restrict 2>/dev/null) == on ]] &&
      [[ $(cli plugins:enabled filter=community format=json 2>/dev/null) == '[]' ]] &&
      cli backlinks path=Target.md format=json 2>/dev/null |
        python3 -c 'import json, sys; sys.exit([r["file"] for r in json.load(sys.stdin)] != ["Source.md"])' 2>/dev/null; do
  kill -0 "$desktop_pid"
  sleep 0.25
done
cli eval 'code=setTimeout(() => window.close(), 250); "closing"' > /dev/null
wait "$desktop_pid"
if cli version > /dev/null 2>&1; then exit 1; else test "$?" -eq 1; fi
trap - EXIT
printf 'Obsidian Desktop CLI smoke test passed.\n'
SH
```

#### Enable in BB

Enable only after the smoke test passes under the intended security policy.
Select a trusted vault with no filesystem links (symbolic or hard links) or
nested mounts exposing files from outside the vault. Desktop can write vault
settings when it opens that vault.

Mount the same bundle read-only at `/opt/obsidian` in the BB container. Set
`PA_OBSIDIAN_DESKTOP=/opt/obsidian/obsidian`,
`PA_OBSIDIAN_CLI=/opt/obsidian/obsidian-cli`, and `PA_OBSIDIAN_DESKTOP_VAULT_ID`
to the exact connected vault ID selected for this opt-in. If the host's
security policy blocks Desktop's namespace setup, leave this route disabled.

## Persistent state and updates

Use a **new named volume**, not an existing host BB home. Docker populates an
empty named volume with the image's seeded home, including user-local agent tools.
A bare empty bind mount hides those tools and will not work. The home contains
BB settings, accounts, credentials, plugin data, synced files, agent configuration
and workspaces; protect and back it up. Do not share it between running containers.
Mount additional workspace or vault storage explicitly if needed.

Runtime tools in that home follow BB's native update controls, just as with
Ansible: rebuilding the image does not overwrite a persistent home's installed
tools. Rebuild/recreate to update OS dependencies and `/opt/pa-bb` plugin source;
use native controls for existing home tools (or a new volume for a clean install).
An existing home can still run an older BB even after the image is updated. Email
requires BB 0.50.1 or later; use BB's native update controls for that installation,
with backups and the pause/drain precautions below. Do not discard its data volume
to force an upgrade.
In particular, older volumes can still contain a previously bundled Hermes
installation; a new image does not remove its tools, credentials or data. Back up
and inspect an existing home before changing it—do not discard the volume merely
to remove a tool.
Before recreating with changed file-writing plugin code, pause sync and drain
active work through BB, back up the volume, then stop the old container. Never
run old and new containers concurrently against the same state or automatically
resume failed/user-paused sync folders.

## Verification

```sh
python3 -m unittest discover -s docker -p 'test_*.py'
node --test docker/test_email_smoke.mjs
# Checks a new disposable installation, not the existing pa-bb container:
python3 docker/smoke_test.py pa-bb
docker inspect --format '{{.State.Health.Status}}' pa-bb
docker exec pa-bb node /home/bb/.local/lib/node_modules/bb-app/host-daemon/dist/bb plugin list --json
```

A healthy HTTP endpoint is not proof of provider sign-in or a working browser.
After setup, try a harmless Browser Automation session using its normal BB tools.
