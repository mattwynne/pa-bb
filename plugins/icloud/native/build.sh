#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s RCLONE_CHECKOUT OUTPUT_BINARY\n' "$0" >&2
  exit 2
fi

native_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
revision=$(cat "$native_dir/rclone-revision")
source_dir=$(realpath -e -- "$1")
destination=$(realpath -e -- "$(dirname -- "$2")")/$(basename -- "$2")
if ! [[ $revision =~ ^[a-f0-9]{40}$ ]] || ! git -C "$source_dir" cat-file -e "$revision^{commit}"; then
  printf 'The pinned rclone revision is missing from the supplied checkout.\n' >&2
  exit 2
fi
if [[ -e $destination || -L $destination ]]; then
  printf 'Choose a new path for the pinned executable.\n' >&2
  exit 2
fi

source_tmp=$(mktemp -d)
output_tmp=$(mktemp "$(dirname -- "$destination")/.bb-icloud-native.XXXXXX")
trap 'rm -rf -- "$source_tmp"; rm -f -- "$output_tmp"' EXIT
git -C "$source_dir" archive "$revision" | tar -x -C "$source_tmp"
git -C "$source_tmp" apply --unidiff-zero "$native_dir/managed-worker.patch"
(
  cd -- "$source_tmp"
  if [[ ${BB_TEST_NATIVE_WORKER:-} == 1 ]]; then
    "${BB_GO_BINARY:-go}" test ./backend/iclouddrive/... ./cmd/bb-icloud-native ./cmd/bisync -run '^TestBB' -count=1
  fi
  "${BB_GO_BINARY:-go}" build -trimpath -buildvcs=false -o "$output_tmp" ./cmd/bb-icloud-native
)
chmod 0755 "$output_tmp"
ln -- "$output_tmp" "$destination"
sha256sum -- "$destination"
