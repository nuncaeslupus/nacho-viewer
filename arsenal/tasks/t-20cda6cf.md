---
id: t-20cda6cf
title: "T8: Homebrew tap"
label: "Homebrew tap"
priority: 10
deps: [t-04725ec9]
requires: [access:human]
tags: [PACKAGING]
workspace: packaging
---

Homebrew tap: create `nuncaeslupus/homebrew-tap` with `Casks/nacho-viewer.rb` (`auto_updates true`, caveats for Open Anyway). A `channels.yml` job bumps the version and sha256.

Plan: `arsenal/project/packaging/plan.md` T8; spec `arsenal/project/packaging/spec.md` (contracts §5, risks §6).

## Acceptance gate

Gate: `channel_version_lag_hours <= 72`.

```bash
bash scripts/check_channel.sh brew
```

## Tests

`test_cask_matches_release` in `scripts/check_channel.sh` — `brew info --cask nuncaeslupus/tap/nacho-viewer` reports the latest tag

## Location

ci, tap repo
