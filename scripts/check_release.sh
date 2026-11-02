#!/usr/bin/env bash
# Release checks (S-4 T1).
#
#   scripts/check_release.sh --version-only <tag>  # tag matches tauri.conf.json, Cargo.toml, package.json
#   scripts/check_release.sh <tag>                 # the Release has every expected bundle; prints sizes
#
# A pre-release tag (v0.1.0-rc.1) proves the version it precedes (0.1.0): MSI versions cannot
# carry a pre-release suffix, so the configs keep the plain version.
# The asset check needs `gh` signed in (GH_TOKEN in CI) and prints release_assets_missing=<n>.
set -euo pipefail
cd "$(dirname "$0")/.."

# Every Release must carry one of each: Linux, Windows, the universal macOS bundles, then the
# updater's manifest.
EXPECTED=('*.deb' '*.AppImage' '*.msi' '*-setup.exe' '*.dmg' '*.app.tar.gz' 'latest.json')

check_version() {
  local want=${1#v}
  want=${want%%-*}
  local conf cargo pkg
  conf=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json)
  cargo=$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)
  pkg=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
  local bad=0 pair
  for pair in "tauri.conf.json=$conf" "Cargo.toml=$cargo" "package.json=$pkg"; do
    if [ "${pair#*=}" != "$want" ]; then
      echo "::error::tag $1 wants version $want but ${pair%%=*} says '${pair#*=}'"
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] && echo "version $want matches tag $1"
  return "$bad"
}

check_assets() {
  local assets name bytes pattern found
  local -a missing=()
  assets=$(gh release view "$1" --json assets --jq '.assets[] | "\(.name)\t\(.size)"')
  echo "| asset | MB |"
  echo "|---|---|"
  for pattern in "${EXPECTED[@]}"; do
    found=0
    while IFS=$'\t' read -r name bytes; do
      # shellcheck disable=SC2053 # the pattern is a glob on purpose
      if [[ -n $name && $name == $pattern ]]; then
        found=1
        echo "| \`$name\` | $(awk "BEGIN { printf \"%.2f\", $bytes / 1048576 }") |"
      fi
    done <<<"$assets"
    [ "$found" -eq 1 ] || missing+=("$pattern")
  done
  for pattern in "${missing[@]}"; do echo "missing: $pattern"; done
  echo "release_assets_missing=${#missing[@]}"
  [ "${#missing[@]}" -eq 0 ]
}

case ${1:-} in
  --version-only) check_version "${2:?usage: $0 --version-only <tag>}" ;;
  ''|-*) echo "usage: $0 [--version-only] <tag>" >&2; exit 2 ;;
  *) check_assets "$1" ;;
esac
