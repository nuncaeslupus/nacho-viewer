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
# Downloads channels.yml makes itself for each stable release: Homebrew hashes the .dmg,
# the apt and Snap jobs each fetch the .deb. Subtracted so the page counts people.
PIPELINE = {"macOS": 1, "Linux .deb": 2}


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
    for rel in sorted(data, key=lambda r: r.get("published_at") or r["created_at"], reverse=True):
        row = table.setdefault(rel["tag_name"], {p: 0 for p, _ in PLATFORMS})
        for asset in rel["assets"]:
            if p := platform(asset["name"]):
                row[p] += asset["download_count"]
        if not rel.get("prerelease"):
            for p, n in PIPELINE.items():
                row[p] = max(0, row[p] - n)
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


COLORS = ["#2f6fdb", "#d9822b", "#2e9e6b", "#8a5cd1"]
CSS = """
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e4e4e0;--track:#eeeeea}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e21;--ink:#ececef;
--muted:#9a9aa2;--line:#2e2e33;--track:#2a2a2f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.45 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:24px;margin:0}h2{font-size:15px;margin:0 0 12px}.sub{color:var(--muted);margin:4px 0 20px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.kpis{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:14px}
.kpi b{display:block;font-size:28px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.wide{grid-column:1/-1}.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:var(--muted);margin-bottom:8px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
.row{display:grid;grid-template-columns:92px 1fr 36px;gap:8px;align-items:center;font-size:13px;margin:5px 0}
.row .n{text-align:right;font-variant-numeric:tabular-nums}.bar{display:flex;height:14px;
background:var(--track);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.note{color:var(--muted);font-size:13px}
details{margin-top:10px;font-size:13px}summary{cursor:pointer;color:var(--muted)}
table{border-collapse:collapse;margin-top:8px}td,th{padding:3px 10px;text-align:right;border-bottom:1px solid var(--line)}
td:first-child,th:first-child{text-align:left}
footer{color:var(--muted);font-size:13px;margin-top:20px}a{color:inherit}
"""


def esc(x):
    return html.escape(str(x))


def bars(items, color=None, stacked=None):
    """Horizontal bars. items: [(label, value)] or, with stacked colours, [(label, [values])]."""
    top = max((sum(v) if stacked else v for _, v in items), default=0) or 1
    out = []
    for label, v in items:
        parts = v if stacked else [v]
        segs = "".join(
            f'<i style="width:{100 * x / top:.2f}%;background:{(stacked or [color(label)])[k]}" '
            f'title="{esc(x)}"></i>'
            for k, x in enumerate(parts)
            if x
        )
        out.append(
            f'<div class="row"><span>{esc(label)}</span><div class="bar">{segs}</div>'
            f'<span class="n">{sum(parts)}</span></div>'
        )
    return "".join(out)


def legend(names):
    return '<div class="legend">' + "".join(
        f'<span><i style="background:{COLORS[k]}"></i>{esc(n)}</span>' for k, n in enumerate(names)
    ) + "</div>"


def line_chart(rows, names):
    """Cumulative downloads per platform over time: SVG lines, with HTML labels that stay readable."""
    pts = [(datetime.date.fromisoformat(r["date"]), [int(r.get(n) or 0) for n in names]) for r in rows]
    if len(pts) < 2:
        return '<p class="note">The trend appears once there are two days of data.</p>'
    w, h = 900, 220
    span = (pts[-1][0] - pts[0][0]).days or 1
    top = max(max(v) for _, v in pts) or 1

    def x(day):
        return (day - pts[0][0]).days * w / span

    def y(v):
        return h - 4 - v * (h - 8) / top

    lines = "".join(
        f'<polyline fill="none" stroke="{COLORS[k]}" stroke-width="3" vector-effect="non-scaling-stroke" '
        'points="' + " ".join(f"{x(d):.1f},{y(v[k]):.1f}" for d, v in pts) + '"/>'
        for k in range(len(names))
    )
    return (
        f'<div class="axis"><span>{top}</span></div>'
        f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" width="100%" height="180" role="img" '
        f'aria-label="Downloads per platform from {pts[0][0]} to {pts[-1][0]}">{lines}</svg>'
        f'<div class="axis"><span>{pts[0][0]}</span><span>{pts[-1][0]}</span></div>'
    )


def render(today, counts, totals, snap, snap_total, rows, fields):
    names = [p for p, _ in PLATFORMS]
    stable = {v: r for v, r in counts.items() if "-" not in v}
    latest = next(iter(stable), None)
    kpis = [
        (sum(totals.values()), "GitHub downloads"),
        (sum(stable[latest].values()) if latest else 0, f"Downloads of {latest or 'latest'}"),
        ("n/a" if snap_total is None else snap_total, "Snap devices now"),
        (len(stable), "Stable releases"),
    ]
    cards = [
        '<div class="card wide"><h2>Downloads per release</h2>' + legend(names)
        + bars([(v, [r[p] for p in names]) for v, r in counts.items()], stacked=COLORS)
        + "<details><summary>Numbers</summary><table><tr><th>Release</th>"
        + "".join(f"<th>{esc(p)}</th>" for p in names) + "</tr>"
        + "".join(
            f"<tr><td>{esc(v)}</td>" + "".join(f"<td>{r[p]}</td>" for p in names) + "</tr>"
            for v, r in counts.items()
        )
        + "</table></details></div>",
        '<div class="card wide"><h2>Total over time</h2>' + legend(names) + line_chart(rows, names) + "</div>",
        '<div class="card"><h2>By platform</h2>'
        + bars([(p, totals[p]) for p in names], lambda p: COLORS[names.index(p)]) + "</div>",
    ]
    titles = {
        "installed_base_by_country": "Snap devices by country",
        "installed_base_by_version": "Snap devices by version",
        "installed_base_by_operating_system": "Snap devices by system",
    }
    for metric, series in sorted(snap.items()):
        ranked = sorted(series.items(), key=lambda kv: -kv[1])[:10]
        cards.append(f'<div class="card"><h2>{esc(titles.get(metric, metric))}</h2>{bars(ranked, lambda _: "#2e9e6b")}</div>')
    if not snap:
        cards.append('<div class="card"><h2>Snap</h2><p class="note">Snap metrics unavailable today.</p></div>')
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Nacho Viewer stats</title><style>{CSS}</style><main>"
        f'<h1>Nacho Viewer downloads</h1><p class="sub">Updated {today} · refreshed daily</p>'
        '<div class="kpis">'
        + "".join(f'<div class="card kpi"><b>{esc(n)}</b><span>{esc(t)}</span></div>' for n, t in kpis)
        + '</div><div class="grid">' + "".join(cards) + "</div>"
        "<footer>GitHub counts include Homebrew and winget, which download from GitHub Releases, "
        "minus the 3 downloads the release pipeline makes itself (1 .dmg, 2 .deb). "
        "The apt repo has no counts, and the app sends no telemetry. "
        '<a href="history.csv">history.csv</a></footer></main></html>'
    )


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

    page = render(today, counts, totals, snap, snap_total, rows, fields)
    with open(os.path.join(out, "index.html"), "w") as f:
        f.write(page)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
