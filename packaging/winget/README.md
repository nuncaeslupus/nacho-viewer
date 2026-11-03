# winget

`channels.yml`'s `winget` job adds each new version to `nuncaeslupus.NachoViewer` in
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) with `komac update`. Komac can
only add a version to a package that exists, so the first submission is made by hand, once.

1. Install [Komac](https://github.com/russellbanks/Komac) (`winget install komac`, or a release
   binary) and give it a classic token with `public_repo` scope: `komac token update`.
2. Submit v0.1.0:

   ```bash
   komac new nuncaeslupus.NachoViewer --version 0.1.0 \
     --urls https://github.com/nuncaeslupus/nacho-viewer/releases/download/v0.1.0/Nacho.Viewer_0.1.0_x64_en-US.msi \
            https://github.com/nuncaeslupus/nacho-viewer/releases/download/v0.1.0/Nacho.Viewer_0.1.0_x64-setup.exe \
     --package-locale en-US --publisher nuncaeslupus --publisher-url https://github.com/nuncaeslupus \
     --publisher-support-url https://github.com/nuncaeslupus/nacho-viewer/issues \
     --package-name "Nacho Viewer" --package-url https://nuncaeslupus.github.io/nacho-viewer/ \
     --moniker nacho-viewer --author nuncaeslupus --license MIT \
     --license-url https://github.com/nuncaeslupus/nacho-viewer/blob/main/LICENSE \
     --short-description "Markdown, beautifully printed." \
     --release-notes-url https://github.com/nuncaeslupus/nacho-viewer/releases/tag/v0.1.0 \
     --submit
   ```

   Komac still asks a few things: accept the defaults, add the file extensions `md` and
   `markdown`, and the tags `markdown`, `viewer`, `pdf`.
3. A Microsoft moderator reviews that first PR. Once it merges, `bash scripts/check_channel.sh
   winget` reports 0.1.0, and later releases go through the job unattended.
