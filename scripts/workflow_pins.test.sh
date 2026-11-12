#!/usr/bin/env bash
# Third-party actions run next to release secrets, so every one is pinned to a commit SHA (a
# moved tag cannot swap the code), and the updater signing key is read by one step only.
# arsenal-queue.yml is vendored by /init and refreshed from upstream, so it is not ours to pin.
set -euo pipefail
cd "$(dirname "$0")/.."

failures=0
fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

unpinned=$(grep -nE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -v arsenal-queue.yml \
  | grep -vE 'uses:\s*\S+@[0-9a-f]{40}(\s|$)' || true)
[[ -z "$unpinned" ]] || fail test_actions_pinned_by_sha "$unpinned"

refs=$(grep -c 'secrets\.TAURI_SIGNING_PRIVATE_KEY\b' .github/workflows/release.yml || true)
[[ "$refs" == 1 ]] || fail test_signing_key_single_step "referenced $refs times, want 1"

((failures == 0)) && echo "workflow_pins: ok"
exit $((failures > 0))
