#!/usr/bin/env bash
# Development only. The desktop bundle and extraction stay outside the checkout.
set -euo pipefail
version=1.15.1
digest=3f6808c14204063349d5a7a59b9f2f637958063fa85eeebe767e13e06d314c0f
cache="${XDG_CACHE_HOME:-$HOME/.cache}/pa-bb/obsidian-desktop/$version"
mkdir -p "$cache"
scratch=$(mktemp -d "$cache/fetch.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
artifact="obsidian-$version.asar.gz"
if [[ -f "$cache/$artifact" ]]; then
  cp "$cache/$artifact" "$scratch/$artifact"
else
  curl --fail --silent --show-error --location \
    "https://github.com/obsidianmd/obsidian-releases/releases/download/v$version/$artifact" \
    --output "$scratch/$artifact"
fi
(
  cd "$scratch"
  printf '%s  %s\n' "$digest" "$artifact" | sha256sum --check --status
)
gzip -dc "$scratch/$artifact" > "$scratch/app.asar"
# The asar CLI is needed only for this opt-in research command.
npm --cache "$cache/npm" exec --yes --package=@electron/asar@3.4.1 -- \
  asar extract "$scratch/app.asar" "$scratch/extracted"
test -s "$scratch/extracted/app.js"
mv "$scratch/$artifact" "$cache/$artifact"
mv "$scratch/app.asar" "$cache/obsidian-$version.asar"
mv "$scratch/extracted/app.js" "$cache/app.js"

if [[ "${1:-}" == --linux-app ]]; then
  linux_artifact="obsidian-$version.tar.gz"
  linux_digest=09074f0635ecf366307d808d0fec06c01a87a0bcc66da6d34126ceece0eb8519
  if [[ ! -f "$cache/$linux_artifact" ]]; then
    curl --fail --silent --show-error --location \
      "https://github.com/obsidianmd/obsidian-releases/releases/download/v$version/$linux_artifact" \
      --output "$scratch/$linux_artifact"
    printf '%s  %s\n' "$linux_digest" "$scratch/$linux_artifact" | sha256sum --check --status
    mv "$scratch/$linux_artifact" "$cache/$linux_artifact"
  fi
  printf '%s  %s\n' "$linux_digest" "$cache/$linux_artifact" | sha256sum --check --status
  mkdir -p "$cache/linux"
  tar -xzf "$cache/$linux_artifact" -C "$cache/linux" --strip-components=1
fi
printf '%s\n' "$cache/app.js"
