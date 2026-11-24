#!/usr/bin/env python3
"""Download statistics page for gh-pages: `stats.py <out dir> [snap metric json ...]`.

GitHub Releases counts cover the direct downloads, Homebrew (the cask fetches the .dmg) and
winget (it fetches the installers). The apt repo serves its own copy and has no counts. Snap
installs come from `snapcraft metrics` JSON, when the store credentials allow it.
"""

import csv
import datetime
import html
import json
import os
import sys
import urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "nuncaeslupus/nacho-viewer")
PLATFORMS = [
    ("Windows", (".msi", "-setup.exe")),
    ("macOS", (".dmg", ".app.tar.gz")),
    ("Linux .deb", (".deb",)),
    ("Linux AppImage", (".AppImage",)),
]


def platform(name):
    return next((p for p, ends in PLATFORMS if name.endswith(ends)), None)


def releases():
    out, page = [], 1
    while True:
        url = f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}"
        req = urllib.request.Request(url)
        if token := os.environ.get("GH_TOKEN"):
            req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req) as r:
            batch = json.load(r)
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def github_counts(data):
    """{version: {platform: downloads}} for every release, newest first."""
    table = {}
    for rel in data:
        row = table.setdefault(rel["tag_name"], {p: 0 for p, _ in PLATFORMS})
        for asset in rel["assets"]:
            if p := platform(asset["name"]):
                row[p] += asset["download_count"]
    return table


def snap_series(paths):
    """{metric: {name: latest value}} from snapcraft metrics JSON files."""
    out = {}
    for path in paths:
        try:
            with open(path) as f:
                doc = json.load(f)
        except (OSError, ValueError):
            continue
        for m in doc.get("metrics", [doc]):
            name = m.get("metric_name") or os.path.basename(path).removesuffix(".json")
            out[name] = {s["name"]: (s.get("values") or [0])[-1] or 0 for s in m.get("series", [])}
    return out


def table(headers, rows):
    head = "".join(f"<th>{html.escape(str(h))}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{html.escape(str(c))}</td>" for c in r) + "</tr>" for r in rows
    )
    return f"<table><tr>{head}</tr>{body}</table>"


def main(out, snap_files):
    os.makedirs(out, exist_ok=True)
    today = datetime.date.today().isoformat()
    counts = github_counts(releases())
    totals = {p: sum(r[p] for r in counts.values()) for p, _ in PLATFORMS}
    snap = snap_series(snap_files)
    versions = snap.get("installed_base_by_version")
    snap_total = sum(versions.values()) if versions is not None else None

    history = os.path.join(out, "history.csv")
    fields = ["date", *totals, "Snap devices"]
    rows = []
    if os.path.exists(history):
        with open(history) as f:
            rows = [r for r in csv.DictReader(f) if r["date"] != today]
    rows.append({"date": today, **totals, "Snap devices": "" if snap_total is None else snap_total})
    with open(history, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    names = [p for p, _ in PLATFORMS]
    parts = [
        "<h2>Totals</h2>",
        table(["Source", "Count"], [*totals.items(), ("Snap devices (now)", "n/a" if snap_total is None else snap_total)]),
        "<h2>GitHub downloads per release</h2>",
        "<p>Includes Homebrew and winget installs, which download from GitHub Releases.</p>",
        table(["Release", *names], [(v, *(r[p] for p in names)) for v, r in counts.items()]),
    ]
    for metric, series in sorted(snap.items()):
        ranked = sorted(series.items(), key=lambda kv: -kv[1])
        parts += [f"<h2>Snap: {html.escape(metric)}</h2>", table(["", "Devices"], ranked)]
    parts += [
        "<h2>History</h2>",
        table(fields, [[r.get(k, "") for k in fields] for r in reversed(rows)]),
        '<p><a href="history.csv">history.csv</a>. No counts exist for the apt repo. '
        "The app itself sends no telemetry.</p>",
    ]
    page = (
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        "<title>Nacho Viewer stats</title><style>body{font:15px system-ui;max-width:860px;"
        "margin:2em auto;padding:0 16px}table{border-collapse:collapse;margin:.5em 0 1.5em}"
        "td,th{border:1px solid #ccc;padding:4px 10px;text-align:right}"
        "td:first-child,th:first-child{text-align:left}</style>"
        f"<h1>Nacho Viewer downloads</h1><p>Updated {today} (weekly).</p>" + "".join(parts)
    )
    with open(os.path.join(out, "index.html"), "w") as f:
        f.write(page)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
