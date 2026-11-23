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

[Docker CI](../.github/workflows/docker.yml) runs the Docker unit tests and builds
**linux/amd64** images on pull requests and pushes to `main`. Pull requests never
log in to GHCR or publish images. Successful builds on `main` publish:

- `ghcr.io/mattwynne/pa-bb:edge` — the most recently published build from `main`.
- `ghcr.io/mattwynne/pa-bb:sha-<full-commit-sha>` — a commit-specific tag.

These are development builds, not versioned releases. Tag pushes do not trigger
this workflow, and it does not publish `latest`. CI checks the build and startup
unit tests, not live provider sign-in or browser automation.

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
Claude Code, Hermes, uv/uvx, rclone, ripgrep, Chrome and the native build toolchain.
Each PA plugin gets `npm ci` from its lockfile.

Application versions and download checksums match the Ansible provisioning;
`test_dockerfile.py` flags drift. Debian packages, including ripgrep, follow
Bookworm's repositories rather than Ubuntu's package-version pins. Chrome follows
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
Before recreating with changed file-writing plugin code, pause sync and drain
active work through BB, back up the volume, then stop the old container. Never
run old and new containers concurrently against the same state or automatically
resume failed/user-paused sync folders.

## Verification

```sh
python3 -m unittest discover -s docker -p 'test_*.py'
docker inspect --format '{{.State.Health.Status}}' pa-bb
docker exec pa-bb node /home/bb/.local/lib/node_modules/bb-app/host-daemon/dist/bb plugin list --json
```

A healthy HTTP endpoint is not proof of provider sign-in or a working browser.
After setup, try a harmless Browser Automation session using its normal BB tools.
