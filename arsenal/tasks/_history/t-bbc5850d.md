---
id: t-bbc5850d
title: "review: Export appends .pdf after the dialog's overwrite check"
priority: 5
status: merged
---

Imported from issue #159

**Severity:** medium · **Confidence:** medium · **Category:** correctness

**Where:** `src-tauri/src/commands.rs:172-175, src-tauri/src/export.rs:19-26`

### Finding
save_dialog passes the chosen path through with_pdf_extension after the native dialog returned. If the user types 'report' (GTK does not auto-append the filter extension), the dialog checks for 'report' only, and export then silently overwrites an existing report.pdf.

### Evidence
Traced: blocking_save_file() -> with_pdf_extension -> stored as export_path -> print_to_pdf writes it; no exists() check between. Platform dialog behaviour not exercised.

### Suggested direction
If the extension was added and the new path exists, re-prompt (or ask the frontend to confirm) before writing.

_From the full repo review of 2026-11-11 (finding #8). Not fixed yet; verify before acting._

## Acceptance gate

```bash
cd src-tauri && cargo test test_export_typed_name
```
