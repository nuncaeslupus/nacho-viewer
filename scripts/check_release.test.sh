#!/usr/bin/env bash
# Tests for scripts/check_release.sh. A fake `gh` on PATH stands in for the GitHub Release.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPT=scripts/check_release.sh
FAKE=$(mktemp -d)
trap 'rm -rf "$FAKE"' EXIT
failures=0

fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

# The fake prints "<name>\t<bytes>" for each name in $FAKE/assets, like the jq query in the script.
cat > "$FAKE/gh" <<'EOF'
#!/usr/bin/env bash
while read -r name; do printf '%s\t1048576\n' "$name"; done < "$(dirname "$0")/assets"
EOF
chmod +x "$FAKE/gh"

all_assets() {
  printf '%s\n' Nacho.Viewer_0.1.0_amd64.deb Nacho.Viewer_0.1.0_amd64.AppImage \
    Nacho.Viewer_0.1.0_x64_en-US.msi Nacho.Viewer_0.1.0_x64-setup.exe \
    Nacho.Viewer_0.1.0_universal.dmg Nacho.Viewer_universal.app.tar.gz latest.json
}

test_release_tag_must_match_version() {
  if bash "$SCRIPT" --version-only v9.9.9 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "v9.9.9 accepted while the config says 0.1.0"
  fi
  bash "$SCRIPT" --version-only v0.1.0 >/dev/null || fail "${FUNCNAME[0]}" "v0.1.0 rejected"
  # A pre-release tag proves the version it precedes.
  bash "$SCRIPT" --version-only v0.1.0-rc.1 >/dev/null || fail "${FUNCNAME[0]}" "v0.1.0-rc.1 rejected"
}

test_complete_release_has_no_missing_assets() {
  all_assets > "$FAKE/assets"
  out=$(PATH="$FAKE:$PATH" bash "$SCRIPT" v0.1.0) || fail "${FUNCNAME[0]}" "exit $?: $out"
  grep -q '^release_assets_missing=0$' <<<"$out" || fail "${FUNCNAME[0]}" "no zero count: $out"
}

test_missing_asset_is_listed() {
  all_assets | grep -v '\.msi$' > "$FAKE/assets"
  if out=$(PATH="$FAKE:$PATH" bash "$SCRIPT" v0.1.0); then
    fail "${FUNCNAME[0]}" "exit 0 with the .msi missing"
  fi
  grep -q '^missing: \*\.msi$' <<<"$out" || fail "${FUNCNAME[0]}" "msi not listed: $out"
  grep -q '^release_assets_missing=1$' <<<"$out" || fail "${FUNCNAME[0]}" "wrong count: $out"
}

test_readme_names_each_os() {
  grep -q '^## Install' README.md || fail "${FUNCNAME[0]}" "no Install heading"
  for os in Linux Windows macOS; do
    grep -q "^### $os" README.md || fail "${FUNCNAME[0]}" "no $os subsection"
  done
}

test_release_tag_must_match_version
test_complete_release_has_no_missing_assets
test_missing_asset_is_listed
test_readme_names_each_os

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "check_release tests passed"
