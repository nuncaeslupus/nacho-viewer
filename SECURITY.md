# Security policy

Nacho Viewer renders Markdown files that may come from anyone, and it updates itself, so a
bug in either is a security bug.

## Reporting a vulnerability

Please report it privately through
[GitHub's private vulnerability reporting](https://github.com/nuncaeslupus/nacho-viewer/security/advisories/new),
not in a public issue. Include the file or steps that reproduce it, plus your OS and app version
(⋮ More › About).

You'll get an answer within a week. A fix ships in a patch release, and the advisory is
published once users can update.

Examples of what counts:

- a Markdown, SVG or HTML file that runs script, escapes the sanitizer or reads files the user
  didn't open
- a way to make the updater install something other than a signed release from this repository
- a remote request made while remote images are turned off

## Supported versions

Only the latest release gets fixes.
