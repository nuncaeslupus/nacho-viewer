---
id: t-e5ac1b6e
title: "review: macOS file association never opens the file (no RunEvent::Opened handler)"
priority: 5
status: merged
---

Imported from issue #152

**Severity:** high · **Confidence:** high · **Category:** correctness

**Where:** `src-tauri/src/main.rs:37-43, src-tauri/src/main.rs:84, src-tauri/src/commands.rs:84-87, src-tauri/tauri.conf.json:35-37`

### Finding
tauri.conf.json registers .md/.markdown file associations and a dmg/app is shipped, but files are only taken from argv (open_at_launch) and the single-instance callback. On macOS, Finder double-click / 'Open With' delivers the file as an Apple Event (tauri RunEvent::Opened), not argv, so the app launches (or is focused) with an empty window.

### Evidence
grep -rn 'Opened\|RunEvent' src-tauri/src returns nothing; Builder uses .run(generate_context!()) with no run-event callback. The macOS release smoke passes the path on argv to the inner binary, so CI cannot see it.

### Suggested direction
Use .build()?.run(|app, event| ...) and route RunEvent::Opened { urls } through AppState::open + the pending/open-files path; add a macOS test for it.

_From the full repo review of 2026-11-11 (finding #1). Not fixed yet; verify before acting._

## Acceptance gate

<!-- This task came from an issue, so its "gate" is prose. Write a real check
     below, then DELETE the `requires: [human:gate]` line in the front matter.
     Until that line is gone the selector will not offer this task, which is
     deliberate: a prose gate runs nothing, and a gate that runs nothing passes
     everything. -->

```bash
# arsenal:gate-placeholder — replace with the real check; it may land in this task's own PR
false
```
