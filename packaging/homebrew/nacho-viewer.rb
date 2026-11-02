# Template for Casks/nacho-viewer.rb in nuncaeslupus/homebrew-tap (S-4 T8).
# channels.yml fills @VERSION@, @SHA256@ and @DMG@ (the Release asset's name) for each release.
cask "nacho-viewer" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/nuncaeslupus/nacho-viewer/releases/download/v#{version}/@DMG@"
  name "Nacho Viewer"
  desc "Markdown viewer"
  homepage "https://github.com/nuncaeslupus/nacho-viewer"

  # The app updates itself in place.
  auto_updates true

  app "Nacho Viewer.app"

  zap trash: [
    "~/Library/Application Support/io.github.nuncaeslupus.NachoViewer",
    "~/Library/Caches/io.github.nuncaeslupus.NachoViewer",
    "~/Library/WebKit/io.github.nuncaeslupus.NachoViewer",
  ]

  caveats <<~EOS
    Nacho Viewer is not notarized by Apple. If macOS refuses to open it, open
    System Settings > Privacy & Security and click "Open Anyway". macOS may ask
    again after an update.
  EOS
end
