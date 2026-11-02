# Plan: Packaging and distribution (S-4)

**Date**: 2026-10-28
**Specification**: `arsenal/project/packaging/spec.md` (approved r2, Option B)
**Author**: Claude Opus 5.5, with the owner
**Revision**: 1
**Status**: approved (2026-10-28, revision 1) — without annotations
**Revision log**:
- r1 — first draft
- r1 corrections (2026-11-02), no notes export: names after the rename to Nacho Viewer;
  `channels.yml` dispatched from `publish`; T7 updates from rc.2; T12 builds from source.

> Review record, kept the way the spec keeps its own: each round of notes bumps
> **Revision** with a log line naming the `<repo>-plan-v<N>-<date>-notes.md`
> export it applied, committed beside this file in the same commit. Approval is
> `approved (YYYY-MM-DD, revision N)`, plus `— without annotations` when there
> were none.

---

## Technical solution

### Architecture overview

There are two workflows, and each OS is built once:

- **`release.yml`** runs on a `v*` tag push. It builds Linux, Windows and macOS with
  `tauri-apps/tauri-action`, signs the updater bundles, and attaches everything to a **draft**
  Release. It then runs an install smoke test per OS and un-drafts the Release.
- **`channels.yml`** is dispatched by `release.yml`'s `publish` job for stable tags only (a
  Release published with `GITHUB_TOKEN` triggers no `release: published` run, and a pre-release
  must not reach the stores). It has one job per channel, and each job takes the Release's assets
  and nothing else, matched by pattern because asset names follow the product name:
  - **Homebrew tap:** bumps the cask in `nuncaeslupus/homebrew-tap`.
  - **winget:** opens a PR on `microsoft/winget-pkgs` with komac.
  - **apt:** regenerates the signed flat repo on `gh-pages`.
  - **Snap:** repackages the .deb and uploads it to `stable`.

  Flathub is not a job here. Flathub builds from source (it does not accept a repackaged .deb),
  so its manifest in `flathub/io.github.nuncaeslupus.NachoViewer` builds the tagged source, with
  the metainfo kept upstream. The owner opens the submission PR: Flathub does not take
  submissions opened or automated by AI tools.

In the app, one Rust module decides whether this install may update itself (D-31). When it may,
the app checks GitHub once after start-up and tells the frontend that a version is available.
The More menu then gains "Restart to update to x.y.z". Windows and macOS gain their own
`print_to_pdf` beside the Linux one in `src-tauri/src/export.rs` (D-29).

### Data flow

```drawspec
{"version": 1, "kind": "flow", "title": "From tag to user",
 "nodes": [
  {"id": "tag", "text": "git push vX.Y.Z"},
  {"id": "rel", "text": "release.yml\nbuild 3 OS, draft"},
  {"id": "smoke", "text": "install smoke\nper OS"},
  {"id": "pub", "text": "Release published\n+ latest.json"},
  {"id": "ch", "text": "channels.yml\ntap, winget, apt, snap"},
  {"id": "fh", "text": "Flathub checker\nbump PR"},
  {"id": "app", "text": "installed app\nupdater check"}
 ],
 "edges": [
  {"from": "tag", "to": "rel"},
  {"from": "rel", "to": "smoke"},
  {"from": "smoke", "to": "pub"},
  {"from": "pub", "to": "ch"},
  {"from": "pub", "to": "fh"},
  {"from": "pub", "to": "app"}
 ]}
```

### State changes

| Service | Store | Change | Description |
|---------|-------|--------|-------------|
| GitHub Releases | release assets | CREATE | One Release per tag: bundles, `.sig` files, `latest.json` |
| `gh-pages` branch | apt repo | UPDATE | `pool/` keeps the last 5 .debs; `Packages`, `Release`, `InRelease` regenerated and signed |
| `nuncaeslupus/homebrew-tap` | `Casks/nacho-viewer.rb` | UPDATE | Version and sha256 per release |
| Actions secrets | repo secrets | CREATE | `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`, `APT_GPG_PRIVATE_KEY`, `HOMEBREW_TAP_TOKEN`, `WINGET_TOKEN`, `SNAPCRAFT_STORE_CREDENTIALS` (created by the owner) |

### Technology choices

| Choice | Justification |
|--------|--------------|
| `tauri-apps/tauri-action` | Tauri's own action. It builds every bundle, signs updater artifacts and writes `latest.json`, so we write no packaging scripts |
| `tauri-plugin-updater` | The official updater. Its minisign key is free, and it verifies each download against the public key in `tauri.conf.json` |
| komac (winget) | Writes and submits winget manifests from a release URL in one command, from CI |
| `apt-ftparchive` + `gpg` | Both are already on Ubuntu runners. A flat repo needs no server and no extra tool |
| snapcraft `gnome` extension, `core24` | Supplies WebKitGTK and GTK to a repackaged Tauri .deb |
| `webview2-com` (Windows) | Its `ICoreWebView2_7::PrintToPdf` binding is what Tauri's Windows webview exposes through `with_webview` |
| `objc2-web-kit` / `objc2-app-kit` (macOS) | Calls `WKWebView.printOperation(with:)` with an `NSPrintInfo` set to save to a file, which gives paginated output (`createPDF` gives one long page) |

### Out of scope

- Paid signing and notarization: the Apple Developer program and any paid Windows certificate
  (D-24).
- Linux arm64 and Windows arm64 builds (spec §4).
- The Microsoft Store and the Mac App Store.
- Building any channel from source (Option C). That includes a Launchpad PPA.
- Print pagination (D-30). That is S-1's task `print pagination (t-6723dbe0)`.

---

## Implementation tasks

| T# | Description | Service | Size | Depends | Gate | Tests |
|----|-------------|---------|------|---------|------|-------|
| T1 | `release.yml`: a `v*` tag builds .deb, AppImage, .msi, NSIS .exe and a universal ad-hoc-signed .dmg into a draft Release. It fails when the tag differs from `tauri.conf.json` or `Cargo.toml`, and reports each bundle's size. `scripts/check_release.sh <tag>` lists any missing asset. Proven on the tag `v0.1.0-rc.1` | ci | M | — | `release_assets_missing == 0` | `test_release_tag_must_match_version` in `scripts/check_release.test.sh` — `check_release.sh --version-only v9.9.9` exits 1 when the config says 0.1.0 |
| T2 | Install smoke jobs in `release.yml`. Each OS installs its own bundle (apt, `msiexec /qn`, copy the .app from the .dmg), opens `e2e/fixtures` README, checks the process is alive at 10 s, and only then un-drafts the Release | ci | S | T1 | `install_smoke_failures == 0` | `test_smoke_fails_when_app_exits` in `scripts/smoke.test.sh` — the smoke script exits 1 when the launched command exits before 10 s |
| T3 | Updater (D-28, D-31): `tauri-plugin-updater` with the public key and the `latest.json` endpoint, and the signing key in secrets. `updater::enabled()` is false under `FLATPAK_ID`, `SNAP` or an executable below `/usr`. A check after first paint emits `update-available`, and More shows "Restart to update to x.y.z" | src-tauri, src | M | T1 | `updater_tests_failed == 0` | `test_updater_is_off_in_flatpak_snap_and_usr` in `src-tauri/src/updater.rs` — `enabled()` is false for each of the three and true for an AppImage path; `test_update_item_appears_only_when_available` in `src/ui/shell.test.ts` — More has no update item until the event arrives |
| T4 | Export on Windows (D-29): `print_to_pdf` through WebView2 `PrintToPdf`, with A4 portrait and print backgrounds. A Windows CI job builds the code and runs `cargo test` | src-tauri | M | T1 | `export_pdf_pages_delta <= 1` | `test_export_target_rules_hold_on_windows` in `src-tauri/src/export.rs` — the existing `target` tests pass on the Windows runner; the page count is judged by the owner on the fixture |
| T5 | Export on macOS (D-29): `print_to_pdf` through `WKWebView.printOperation` with `NSPrintSaveJob` to the chosen URL, so the output is paginated. A macOS CI job builds the code and runs `cargo test` | src-tauri | M | T1 | `export_pdf_pages_delta <= 1` | `test_export_target_rules_hold_on_macos` in `src-tauri/src/export.rs` — the existing `target` tests pass on the macOS runner; the page count is judged by the owner on the fixture |
| T6 | README Install section: Releases per OS, the channel commands, and the unsigned-app steps ("More info › Run anyway"; "Privacy & Security › Open Anyway") | docs | S | — | `readme_install_sections == 3` | `test_readme_names_each_os` in `scripts/check_release.test.sh` — README has an Install heading with Linux, Windows and macOS subsections |
| T7 | First public Release `v0.1.0`. The owner creates the updater key, tags, and checks an AppImage, .msi and .dmg install by hand, including the self-update from `v0.1.0-rc.2` (rc.1 has no updater, and `releases/latest` skips pre-releases) | release | S | T2, T3, T4, T5, T6 | `owner_install_checks_failed == 0` | Manual: install each bundle on a clean machine, double-click a .md file, update from rc.2; recorded in the Evidence log |
| T8 | Homebrew tap: create `nuncaeslupus/homebrew-tap` with `Casks/nacho-viewer.rb` (`auto_updates true`, caveats for Open Anyway). A `channels.yml` job bumps the version and sha256 | ci, tap repo | S | T7 | `channel_version_lag_hours <= 72` | `test_cask_matches_release` in `scripts/check_channel.sh` — `brew info --cask nuncaeslupus/tap/nacho-viewer` reports the latest tag |
| T9 | winget: a komac job in `channels.yml` submits `nuncaeslupus.NachoViewer` for each release. The first submission is reviewed by hand | ci | S | T7 | `channel_version_lag_hours <= 72` | `test_winget_matches_release` in `scripts/check_channel.sh` — `winget show nuncaeslupus.NachoViewer` (or the winget-pkgs manifest path) lists the latest tag |
| T10 | Signed apt repo on `gh-pages`: a job adds the .deb, keeps the last 5, regenerates and signs the index, and the README gives the keyring and `sources` lines | ci | M | T7 | `channel_version_lag_hours <= 72` | `test_apt_repo_signature_verifies` in `scripts/check_channel.sh` — `gpgv` accepts `InRelease` and `Packages` lists the latest version |
| T11 | Snap: `snap/snapcraft.yaml` (core24, gnome extension, strict, `home` and `removable-media`) repackages the .deb. The owner registers the name `nacho-viewer`, and a job uploads to `stable` | ci | M | T7 | `channel_version_lag_hours <= 72` | `test_snap_matches_release` in `scripts/check_channel.sh` — `snap info nacho-viewer` shows the latest tag on stable |
| T12 | Flathub: a manifest for `io.github.nuncaeslupus.NachoViewer` that builds the tagged source (Flathub does not accept a repackaged .deb), with `x-checker-data`, and metainfo and the desktop file kept upstream. The owner opens the PR to `flathub/flathub` | flathub | M | T7 | `flathub_published == 1` | `test_flathub_lists_app` in `scripts/check_channel.sh` — `flatpak remote-info flathub io.github.nuncaeslupus.NachoViewer` succeeds |
| T13 | SignPath Foundation: the owner applies with the public repo. Once approved, the Windows job signs the .msi and .exe | ci | S | T7 | `windows_bundles_signed == 2` | `test_windows_bundles_signed` in `scripts/check_release.sh` — `osslsigncode verify` passes on both downloaded Windows bundles |

**Status legend**: ☐ not started · ◐ in progress · ☑ merged

**Merge order**:
1. T1 and T6 together.
2. T2, T3, T4 and T5 in parallel.
3. T7.
4. T8 to T13 in parallel. T13 waits on SignPath's approval.

**Branch pattern**: `arsenal/<task-id>` from `main` (claim_task.sh).

### Dependency graph

```drawspec
{"version": 1, "kind": "flow", "title": "Task dependencies",
 "nodes": [
  {"id": "T1", "text": "T1 release.yml"},
  {"id": "T2", "text": "T2 smoke"},
  {"id": "T3", "text": "T3 updater"},
  {"id": "T4", "text": "T4 Win PDF"},
  {"id": "T5", "text": "T5 mac PDF"},
  {"id": "T6", "text": "T6 README"},
  {"id": "T7", "text": "T7 v0.1.0"},
  {"id": "T8", "text": "T8 brew"},
  {"id": "T9", "text": "T9 winget"},
  {"id": "T10", "text": "T10 apt"},
  {"id": "T11", "text": "T11 snap"},
  {"id": "T12", "text": "T12 flathub"},
  {"id": "T13", "text": "T13 SignPath"}
 ],
 "edges": [
  {"from": "T1", "to": "T2"},
  {"from": "T1", "to": "T3"},
  {"from": "T1", "to": "T4"},
  {"from": "T1", "to": "T5"},
  {"from": "T2", "to": "T7"},
  {"from": "T3", "to": "T7"},
  {"from": "T4", "to": "T7"},
  {"from": "T5", "to": "T7"},
  {"from": "T6", "to": "T7"},
  {"from": "T7", "to": "T8"},
  {"from": "T7", "to": "T9"},
  {"from": "T7", "to": "T10"},
  {"from": "T7", "to": "T11"},
  {"from": "T7", "to": "T12"},
  {"from": "T7", "to": "T13"}
 ]}
```

## Evidence log

| T# | Gate | Measured | Command | SHA | Env | Date |
|----|------|----------|---------|-----|-----|------|

---

## Sign-off

- [ ] Plan approved by the owner
- [ ] Owner has the accounts the channel tasks need: Snap Store, a winget-pkgs fork token, the Homebrew tap token, and a Flathub GitHub login
- [ ] Ready for execution
