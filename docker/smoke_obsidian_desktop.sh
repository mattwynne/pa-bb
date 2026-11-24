#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash docker/smoke_obsidian_desktop.sh IMAGE [EXTRACTED_OBSIDIAN_BUNDLE]" >&2
  exit 2
fi
image=$1
if [[ $# == 2 ]]; then
  bundle_directory=$(realpath -e -- "$2")
else
  staging=$(mktemp -d)
  trap 'rm -rf -- "$staging"' EXIT
  archive=$staging/desktop.tar.gz
  curl -fsSL --retry 2 --retry-max-time 120 --max-time 90 -o "$archive" \
    https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.1/obsidian-1.15.1.tar.gz
  printf '%s  %s\n' 09074f0635ecf366307d808d0fec06c01a87a0bcc66da6d34126ceece0eb8519 \
    "$archive" | sha256sum -c -
  bundle_directory=$staging/desktop
  mkdir "$bundle_directory"
  tar -xzf "$archive" --strip-components=1 -C "$bundle_directory"
  chmod 755 "$staging" "$bundle_directory"
fi
test -x "$bundle_directory/obsidian" && test -x "$bundle_directory/obsidian-cli" || exit 2

docker run --rm --pull never -i --init --platform linux/amd64 --network none --shm-size=1g \
  --cap-drop ALL --security-opt no-new-privileges --no-healthcheck \
  --read-only --tmpfs /tmp:mode=1777 --tmpfs /home/bb --workdir /tmp \
  --mount "type=bind,src=$bundle_directory,dst=/opt/obsidian,readonly" \
  --entrypoint /usr/bin/timeout "$image" -k 5s 45s /bin/bash -se <<'SH'
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
