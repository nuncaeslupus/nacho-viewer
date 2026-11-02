#!/usr/bin/env bash
# Adds a .deb to the flat apt repo in <dir> and signs the index again (S-4 T10).
#
#   scripts/apt_repo.sh <deb> <dir>
#
# <dir>/pool keeps the newest 5 versions. Signs with the first secret key in gpg's keyring and
# writes its public key to <dir>/nacho-viewer.gpg for `signed-by`. Users add:
#   deb [signed-by=/usr/share/keyrings/nacho-viewer.gpg] https://nuncaeslupus.github.io/nacho-viewer/ ./
set -euo pipefail

deb=$(realpath "${1:?usage: $0 <deb> <dir>}")
dir=${2:?usage: $0 <deb> <dir>}
keep=5

key=$(gpg --list-secret-keys --with-colons | awk -F: '$1 == "fpr" { print $10; exit }')
[ -n "$key" ] || { echo "error: no gpg secret key to sign with" >&2; exit 1; }

field() { dpkg-deb -f "$deb" "$1"; }
mkdir -p "$dir/pool"
cp "$deb" "$dir/pool/$(field Package)_$(field Version)_$(field Architecture).deb"
find "$dir/pool" -name '*.deb' | sort -V | head -n -"$keep" | xargs -r rm --

cd "$dir"
# The old index would hash itself into the new Release.
rm -f Packages Packages.gz Release InRelease Release.gpg
apt-ftparchive packages pool >Packages
gzip -9k Packages
release=$(mktemp)
apt-ftparchive -o APT::FTPArchive::Release::Origin="Nacho Viewer" \
  -o APT::FTPArchive::Release::Label="Nacho Viewer" release . >"$release"
mv "$release" Release
gpg --batch --yes --local-user "$key" --clearsign -o InRelease Release
gpg --batch --yes --local-user "$key" -abs -o Release.gpg Release
gpg --export "$key" >nacho-viewer.gpg
# GitHub Pages serves the files as they are.
touch .nojekyll
