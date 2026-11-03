#!/usr/bin/env bash
# How far a store channel lags the latest Release (S-4 T8-T11 gates).
#
#   scripts/check_channel.sh <brew|winget|apt|snap>
#   scripts/check_channel.sh flathub   # prints flathub_published=<0|1>
#
# Prints the channel's version and channel_version_lag_hours=<n>: 0 when it has the latest
# Release, else the hours since that Release was published. Exits 1 when the lag is over 72.
# Needs curl and jq; apt also needs gpgv. Reads only public URLs.
set -euo pipefail

REPO=nuncaeslupus/nacho-viewer
get() { curl -fsSL --retry 3 "$@"; }

channel_version() {
  case $1 in
    brew)
      get "https://raw.githubusercontent.com/nuncaeslupus/homebrew-tap/main/Casks/nacho-viewer.rb" |
        sed -n 's/^ *version "\(.*\)"$/\1/p'
      ;;
    winget)
      get "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/n/nuncaeslupus/NachoViewer" |
        jq -r '.[] | select(.type == "dir") | .name' | sort -V | tail -1
      ;;
    apt)
      # Only a signed index counts: gpgv must accept InRelease with the repo's own key.
      local base=https://nuncaeslupus.github.io/nacho-viewer tmp
      tmp=$(mktemp -d)
      get -o "$tmp/key.gpg" "$base/nacho-viewer.gpg"
      get -o "$tmp/InRelease" "$base/InRelease"
      gpgv --keyring "$tmp/key.gpg" "$tmp/InRelease" 2>/dev/null || {
        echo "error: InRelease does not verify" >&2
        rm -rf "$tmp"
        return 1
      }
      rm -rf "$tmp"
      get "$base/Packages" | sed -n 's/^Version: //p' | sort -V | tail -1
      ;;
    snap)
      get -H 'Snap-Device-Series: 16' "https://api.snapcraft.io/v2/snaps/info/nacho-viewer" |
        jq -r '[."channel-map"[] | select(.channel.name == "stable")][0].version'
      ;;
    *)
      echo "usage: $0 <brew|winget|apt|snap>" >&2
      return 2
      ;;
  esac
}

# Flathub's gate is only whether the app is listed: its own checker keeps the version current.
if [ "${1:-}" = flathub ]; then
  published=0
  get -o /dev/null "https://flathub.org/api/v2/appstream/io.github.nuncaeslupus.nacho_viewer.NachoViewer" 2>/dev/null &&
    published=1
  echo "flathub_published=$published"
  [ "$published" -eq 1 ]
  exit
fi

have=$(channel_version "${1:-}")
release=$(get "https://api.github.com/repos/$REPO/releases/latest")
want=$(jq -r '.tag_name | ltrimstr("v")' <<<"$release")
echo "release_version=$want"
echo "channel_version=$have"
if [ "$have" = "$want" ]; then
  lag=0
else
  published=$(date -d "$(jq -r .published_at <<<"$release")" +%s)
  lag=$((($(date +%s) - published) / 3600))
fi
echo "channel_version_lag_hours=$lag"
[ "$lag" -le 72 ]
