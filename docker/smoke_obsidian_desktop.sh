#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: bash docker/smoke_obsidian_desktop.sh IMAGE" >&2
  exit 2
fi
image=$1
staging=$(mktemp -d)
volume=''
cleanup() {
  if [[ -n $volume ]]; then docker volume rm "$volume" >/dev/null || return 1; fi
  rm -rf -- "$staging"
}
trap cleanup EXIT
python3 "$(dirname -- "${BASH_SOURCE[0]}")/obsidian_desktop_seccomp.py" > "$staging/seccomp.json"
volume=$(docker volume create)
security=(--cap-drop ALL --security-opt no-new-privileges --security-opt "seccomp=$staging/seccomp.json")
run=(docker run --rm --pull never -i --init --platform linux/amd64 --shm-size=1g "${security[@]}"
  --no-healthcheck --read-only --tmpfs /home/bb --workdir /tmp --entrypoint /usr/bin/timeout)

# First installation happens inside the stock image, as its BB user. Only the
# runtime cache survives into a second container with networking turned off.
managed_bundle() {
  node --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module - "$1" <<'JS'
import { ManagedDesktop } from '/opt/pa-bb/plugins/obsidian/adapters/desktop-install.ts';
import { dirname } from 'node:path';
const desktop = new ManagedDesktop(process.argv[2], (stage, category) => console.error(stage, category));
await desktop.ensure(new AbortController().signal);
console.log(dirname(desktop.binaries.desktop));
JS
}
{ declare -f managed_bundle; cat <<'SH'
set -euo pipefail
test -z "$(find /opt/pa-bb -type f \( -name obsidian -o -name obsidian-cli -o -name obsidian.asar -o -name 'obsidian-*.tar.gz' \) -print -quit)"
managed_bundle /tmp/desktop >/dev/null
SH
} | "${run[@]}" --mount "type=volume,src=$volume,dst=/tmp" "$image" -k 5s 210s /bin/bash -se

{ declare -f managed_bundle; cat <<'SH'
set -euo pipefail
bundle=$(managed_bundle /opt/cache/desktop)
test -x "$bundle/obsidian" && test -x "$bundle/obsidian-cli"
for binary in "$bundle"/{obsidian,obsidian-cli,chrome-sandbox,chrome_crashpad_handler,*.so*} \
    "$bundle"/resources/app.asar.unpacked/node_modules/*/*.node; do
  libs=$(ldd "$binary")
  if grep -q 'not found' <<<"$libs"; then
    printf '%s\n%s\n' "$binary" "$libs" >&2
    exit 1
  fi
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
printf '{"cli":true,"updateDisabled":true,"vaults":{"smoke":{"path":"%s","ts":1,"open":true}}}\n' "$vault" \
  > "$profile/obsidian.json"
printf '[]\n' > "$vault/.obsidian/community-plugins.json"
printf '# Target\n' > "$vault/Target.md"
printf '[[Target]]\n' > "$vault/Source.md"
cli() { timeout -k 1s 2s "$bundle/obsidian-cli" vault=smoke "$@" < /dev/null; }
"$bundle/obsidian" --user-data-dir="$profile" --ozone-platform=headless \
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
# Chromium's sandbox zygote enters a nested PID namespace. Sandboxed
# children install another seccomp filter beyond the outer Docker policy.
python3 - "$desktop_pid" <<'PYTHON'
import pathlib, sys

def status(pid):
    lines = pathlib.Path('/proc', pid, 'status').read_text().splitlines()
    return dict(line.split(':', 1) for line in lines)

main = sys.argv[1]
parent = status(main)
pending = [main]
nested = filtered = False
while pending:
    pid = pending.pop()
    try:
        entry = status(pid)
        if entry['Name'].strip() == 'obsidian':
            nested |= len(entry['NSpid'].split()) > len(parent['NSpid'].split())
            filtered |= (int(entry['Seccomp_filters']) > int(parent['Seccomp_filters'])
                         and entry['Seccomp'].strip() == '2' and int(entry['CapEff'], 16) == 0)
        pending.extend(pathlib.Path('/proc', pid, 'task', pid, 'children').read_text().split())
    except (FileNotFoundError, ProcessLookupError):
        continue
if parent['NoNewPrivs'].strip() != '1' or int(parent['CapEff'], 16) or not (nested and filtered):
    raise SystemExit('Chromium namespace and seccomp sandbox were not observed.')
PYTHON
cli eval 'code=setTimeout(() => window.close(), 250); "closing"' > /dev/null
wait "$desktop_pid"
if cli version > /dev/null 2>&1; then exit 1; else test "$?" -eq 1; fi
trap - EXIT
printf 'Obsidian Desktop CLI smoke test passed.\n'
SH
} | "${run[@]}" --network none --tmpfs /tmp:mode=1777 \
  --mount "type=volume,src=$volume,dst=/opt/cache,readonly" "$image" -k 5s 60s /bin/bash -se
