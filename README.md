# Nacho Viewer

[![CI](https://github.com/nuncaeslupus/nacho-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/nuncaeslupus/nacho-viewer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nuncaeslupus/nacho-viewer?include_prereleases&sort=semver)](https://github.com/nuncaeslupus/nacho-viewer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-nuncaeslupus.github.io-d9822b)](https://nuncaeslupus.github.io/nacho-viewer/)

<!-- claude-arsenal:attribution: added by claude-arsenal's /init. Delete this block to drop it (it is not put back), or set `attribution = false` in the arsenal config.toml. -->
[![Built with claude-arsenal](https://img.shields.io/badge/built%20with-claude--arsenal-d97756)](https://github.com/nuncaeslupus/claude-arsenal)
<!-- /claude-arsenal:attribution -->

<p align="center">
  <img src="https://raw.githubusercontent.com/nuncaeslupus/nacho-viewer/main/docs/hero.png" width="100%" alt="Nacho Viewer: the tortilla-chip logo and wordmark, the tagline Markdown, beautifully printed, the app open on a typeset document in light and dark, and the formats it opens: Markdown now, images and PDF next">
</p>

**Markdown, beautifully printed.** A free, open-source document viewer for Linux, Windows and macOS
that makes `.md` files read like a well-typeset document instead of plain text. Images and PDF
pages come next; it stays a viewer, not an editor.

> Status: building v1. The specification is [`status/specification.md`](status/specification.md) and
> the task plan [`status/plan.md`](status/plan.md). `make dev` runs the app; `make lint test` is the gate.

## Planned for v1

- A paper-sheet reading view with book-quality typography, light and dark
- Everything GitHub renders (GFM, footnotes, alerts, emoji, math, Mermaid) plus extras
  (highlight, sup/sub, wiki links, abbreviations, definition lists)
- Tabs with back/forward, outline sidebar, live reload, zoom, print to PDF
- Built with [Tauri v2](https://v2.tauri.app/)

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/nuncaeslupus/nacho-viewer/main/docs/screenshot-light.png" width="49%" alt="Nacho Viewer in light mode: two tabs, the toolbar, and a document with a tip, a numbered list, a table and code set on a paper sheet">
  <img src="https://raw.githubusercontent.com/nuncaeslupus/nacho-viewer/main/docs/screenshot-dark.png" width="49%" alt="The same document in dark mode">
</p>

## Install

Every release is on [GitHub Releases](https://github.com/nuncaeslupus/nacho-viewer/releases). The
AppImage, .msi/.exe and .dmg update themselves; the other channels update through their store.

### Linux

- **Releases**: the `.deb` (`sudo apt install ./Nacho*Viewer_*.deb`) or the AppImage (`chmod +x`, then run it)
- **Flathub** (coming soon): `flatpak install flathub io.github.nuncaeslupus.NachoViewer`
- **Snap** (coming soon): `sudo snap install nacho-viewer`
- **apt repo**: add the key and the source once, then `sudo apt install nacho-viewer`; updates come with `apt upgrade`

  ```bash
  sudo curl -fsSLo /usr/share/keyrings/nacho-viewer.gpg https://nuncaeslupus.github.io/nacho-viewer/nacho-viewer.gpg
  echo "deb [signed-by=/usr/share/keyrings/nacho-viewer.gpg] https://nuncaeslupus.github.io/nacho-viewer/ ./" | sudo tee /etc/apt/sources.list.d/nacho-viewer.list
  sudo apt update && sudo apt install nacho-viewer
  ```

### Windows

- **Releases**: the `.msi` or `.exe` installer
- **winget** (coming soon): `winget install nuncaeslupus.NachoViewer`

The app is not code-signed yet, so SmartScreen may warn on first run: click **More info → Run anyway**.

### macOS

- **Releases**: the `.dmg`; drag Nacho Viewer to Applications
- **Homebrew**: `brew install --cask nuncaeslupus/tap/nacho-viewer`

The app is not notarized, so macOS blocks the first launch. Open **System Settings › Privacy &
Security** and click **Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/Nacho Viewer.app"`.

## License

[MIT](LICENSE)
