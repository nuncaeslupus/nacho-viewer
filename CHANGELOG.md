# Changelog

Notable changes per release. The full list is on
[GitHub Releases](https://github.com/nuncaeslupus/nacho-viewer/releases).

## 0.1.7 — 2026-11-24

- Settings › Language lists System first, then Latin-script languages A–Z, then the rest.

## 0.1.6 — 2026-11-24

- The interface and the user guide come in Catalan.

## 0.1.5 — 2026-11-24

- Settings › Language is a dropdown. The outline button shows a side-panel icon.
- Remote images over `http` (including `srcset`) load over `https` when remote images are on.
- A settings file from a newer version keeps the settings this version knows, and is backed up
  before this version saves over it.
- Leftover print previews are cleared at startup.

## 0.1.4 — 2026-11-23

- The interface comes in 14 languages: English, Spanish, German, French, Italian, Portuguese,
  Chinese, Japanese, Hindi, Bengali, Indonesian, Korean, Turkish and Vietnamese. It follows the
  system language by default, and Settings › Language changes it. The user guide is translated
  too.
- Security: dependency updates for RUSTSEC-2026-0594 (cookie) and RUSTSEC-2026-0592 (url).
- A `SECURITY.md` explains how to report a vulnerability privately.

## 0.1.3 — 2026-11-23

- Security: remote images are off by default. Read access is narrower: broad folders such as
  home or a drive root are no longer granted recursively, recent files grant no folder, and
  closing a folder's last tab revokes access. SVG `style` is sanitised.
- macOS: Finder's Open and Open With reach the app.
- Windows: relative and wiki links resolve on drive and UNC paths.
- Export asks before overwriting `name.pdf` when `.pdf` was added after the dialog.
- Live reload notices changes that keep the file's modification time. A render that times out
  fails cleanly.

## 0.1.2 — 2026-11-04

- Flatpak: files handed over by the desktop open by their real path, so images and links
  resolve. Print preview works from the cache.

## 0.1.1 — 2026-11-04

- Flatpak build for Flathub, with metainfo and desktop file.
- Publisher name fixed in the installers.
- Store listings: Snap, winget.

## 0.1.0 — 2026-11-03

- First public release: tabs, GitHub-flavoured Markdown, Mermaid diagrams, KaTeX math, Find,
  Print, Export to PDF, five document styles, light and dark themes.
