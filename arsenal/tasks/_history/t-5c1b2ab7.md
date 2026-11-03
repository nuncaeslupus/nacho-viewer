---
id: t-5c1b2ab7
title: "T4: Export on Windows"
label: "export on Windows"
priority: 5
deps: [t-8f5ad4b0]
requires: [access:human]
tags: [PACKAGING]
workspace: packaging
status: merged
---

Export on Windows (D-29): `print_to_pdf` through WebView2 `PrintToPdf`, with A4 portrait and print backgrounds. A Windows CI job builds the code and runs `cargo test`

Plan: `arsenal/project/packaging/plan.md` T4; spec `arsenal/project/packaging/spec.md` (contracts §5, risks §6).

## Acceptance gate

Gate: `export_pdf_pages_delta <= 1`.

```bash
rustup target add x86_64-pc-windows-msvc >/dev/null && (cd src-tauri && cargo check --target x86_64-pc-windows-msvc)
```

## Tests

`test_export_target_rules_hold_on_windows` in `src-tauri/src/export.rs` — the existing `target` tests pass on the Windows runner; the page count is judged by the owner on the fixture

## Location

src-tauri
