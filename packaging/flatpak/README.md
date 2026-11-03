# Flathub

The manifest builds the tagged source offline. Its npm and cargo dependencies are listed in
`node-sources.json` and `cargo-sources.json`, which `.github/workflows/flatpak.yml` generates
from the lockfiles. The desktop file and metainfo stay here and are installed from the source.

## First submission (once)

1. Make a tag that contains this folder (v0.1.1 or later), then run
   `gh workflow run flatpak.yml --ref main -f tag=v0.1.1`.
2. Download the run's `flathub` artifact. Its `out/` folder holds the stamped manifest and both
   source lists.
3. Fork [flathub/flathub](https://github.com/flathub/flathub), make a branch from `new-pr`, put the
   three files from `out/` at its root, and open a pull request against `new-pr`, titled
   `Add io.github.nuncaeslupus.NachoViewer`.
4. Answer the reviewers. Once merged, Flathub creates `flathub/io.github.nuncaeslupus.NachoViewer`
   and invites you to it.

## Each release

Add a `<release>` line to the metainfo before tagging. Flathub's checker then opens a pull request
in the app's repo bumping the tag. If `package-lock.json` or `Cargo.lock` changed since the last
release, that build fails: run the workflow for the new tag and push its two source lists to the
checker's branch.
