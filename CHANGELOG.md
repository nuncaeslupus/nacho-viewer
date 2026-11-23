# Changelog

Notable changes per release. The full list is on
[GitHub Releases](https://github.com/nuncaeslupus/nacho-viewer/releases).

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
