#!/usr/bin/env bash
# Tests for scripts/apt_repo.sh. Tiny stand-in .debs and a throwaway gpg key play the release.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPT=$PWD/scripts/apt_repo.sh
failures=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export GNUPGHOME=$work/gnupg
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --passphrase '' --quick-generate-key "apt test <test@example.invalid>" ed25519 sign 1d

fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

make_deb() {
  local root=$work/deb-$1
  mkdir -p "$root/DEBIAN"
  printf 'Package: nacho-viewer\nVersion: %s\nArchitecture: amd64\nMaintainer: test\nDescription: test\n' \
    "$1" >"$root/DEBIAN/control"
  dpkg-deb --build --root-owner-group "$root" "$work/$1.deb" >/dev/null
}

test_repo_keeps_five_and_verifies() {
  local repo=$work/repo v
  for v in 0.1.0 0.2.0 0.9.0 0.10.0 0.11.0 1.0.0; do
    make_deb "$v"
    bash "$SCRIPT" "$work/$v.deb" "$repo" 2>/dev/null
  done
  [ "$(find "$repo/pool" -name '*.deb' | wc -l)" -eq 5 ] || fail "${FUNCNAME[0]}" "pool: $(ls "$repo/pool")"
  [ ! -e "$repo/pool/nacho-viewer_0.1.0_amd64.deb" ] || fail "${FUNCNAME[0]}" "oldest kept"
  [ -e "$repo/pool/nacho-viewer_0.10.0_amd64.deb" ] || fail "${FUNCNAME[0]}" "0.10.0 pruned as older than 0.9.0"
  gpgv --keyring "$repo/nacho-viewer.gpg" "$repo/InRelease" 2>/dev/null ||
    fail "${FUNCNAME[0]}" "InRelease does not verify"
  gpgv --keyring "$repo/nacho-viewer.gpg" "$repo/Release.gpg" "$repo/Release" 2>/dev/null ||
    fail "${FUNCNAME[0]}" "Release.gpg does not verify"
  grep -q '^Version: 1.0.0$' "$repo/Packages" || fail "${FUNCNAME[0]}" "Packages lacks 1.0.0"
  if grep -Eq ' (Release|InRelease|Release.gpg)$' "$repo/Release"; then
    fail "${FUNCNAME[0]}" "Release hashes a signature file"
  fi
}

test_repo_keeps_five_and_verifies

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "apt repo tests passed"
