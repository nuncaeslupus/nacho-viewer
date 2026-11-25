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


def api(path, token):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as r:
        return json.load(r)


TRAFFIC = ["Views", "Visitors", "Clones", "Cloners"]


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def write_csv(path, fields, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def traffic(out, today):
    """Repo traffic, which needs TRAFFIC_TOKEN with Administration: read. GitHub keeps only 14
    days, so the daily numbers are merged into traffic.csv and each day's referrers are logged
    to referrers.csv. Returns (daily rows, referrers, paths) or None."""
    token = os.environ.get("TRAFFIC_TOKEN")
    if not token:
        return None
    try:
        views = api("traffic/views", token)["views"]
        clones = api("traffic/clones", token)["clones"]
        refs = api("traffic/popular/referrers", token)
        paths = api("traffic/popular/paths", token)
    except (OSError, ValueError, KeyError) as e:  # HTTPError is an OSError
        print(f"traffic skipped: {e}", file=sys.stderr)
        return None
    days = {r["date"]: r for r in read_csv(os.path.join(out, "traffic.csv"))}
    for key, series in (("Views", views), ("Clones", clones)):
        uniq = "Visitors" if key == "Views" else "Cloners"
        for d in series:
            row = days.setdefault(d["timestamp"][:10], {"date": d["timestamp"][:10], **dict.fromkeys(TRAFFIC, 0)})
            row[key], row[uniq] = d["count"], d["uniques"]
    rows = [days[k] for k in sorted(days)]
    write_csv(os.path.join(out, "traffic.csv"), ["date", *TRAFFIC], rows)
    log = [r for r in read_csv(os.path.join(out, "referrers.csv")) if r["date"] != today]
    log += [{"date": today, "referrer": r["referrer"], "views": r["count"], "visitors": r["uniques"]} for r in refs]
    write_csv(os.path.join(out, "referrers.csv"), ["date", "referrer", "views", "visitors"], log)
    prefix = f"/{REPO}"
    return (
        rows,
        [(r["referrer"], r["uniques"]) for r in refs],
        [(p["path"].removeprefix(prefix) or "/", p["uniques"]) for p in paths],
    )


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
.band{fill:var(--ink);opacity:0}.band:hover{opacity:.08}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);padding:4px 8px;
border-radius:6px;font-size:13px;white-space:nowrap;display:none;z-index:9}
nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--line)}
nav a{padding:8px 12px;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
nav a[aria-selected=true]{color:var(--ink);border-color:#2f6fdb;font-weight:600}
.src{margin:0 0 14px}.src:empty{display:none}
a.group{text-decoration:none;display:block}a.group:hover{border-color:#2f6fdb}
.group .kpis{margin:0 0 8px;gap:10px;grid-template-columns:repeat(auto-fit,minmax(100px,1fr))}.more{color:var(--muted);font-size:13px}
footer{color:var(--muted);font-size:13px;margin-top:20px}a{color:inherit}
"""


# Shows an element's data-tip next to the pointer (mouse hover or touch).
TIP_JS = """
const tip = document.getElementById("tip");
document.addEventListener("pointermove", e => {
  const t = e.target.closest("[data-tip]");
  if (!t) { tip.style.display = "none"; return; }
  tip.textContent = t.dataset.tip;
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.max(4, Math.min(e.clientX + 12, innerWidth - r.width - 4)) + "px";
  tip.style.top = Math.max(4, e.clientY - r.height - 10) + "px";
});
document.addEventListener("pointerleave", () => { tip.style.display = "none"; });
"""


# Shows the tab named in the URL hash (default: the first); without JS every tab shows.
TABS_JS = """
function show() {
  const id = location.hash.slice(1);
  const tabs = [...document.querySelectorAll("section[role=tabpanel]")];
  const cur = tabs.find(t => t.id === id) || tabs[0];
  tabs.forEach(t => t.hidden = t !== cur);
  document.querySelectorAll("nav a").forEach(a => a.setAttribute("aria-selected", a.hash === "#" + cur.id));
  scrollTo(0, 0);
}
addEventListener("hashchange", show);
show();
"""


def esc(x):
    return html.escape(str(x))


def bars(items, color=None, stacked=None, names=None):
    """Horizontal bars. items: [(label, value)] or, with stacked colours, [(label, [values])]
    named by `names` in the hover tip."""
    top = max((sum(v) if stacked else v for _, v in items), default=0) or 1
    out = []
    for label, v in items:
        parts = v if stacked else [v]
        segs = "".join(
            f'<i style="width:{100 * x / top:.2f}%;background:{(stacked or [color(label)])[k]}" '
            f'data-tip="{esc(label)} · {esc(names[k]) + ": " if names else ""}{esc(x)}"></i>'
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


def line_chart(rows, names, what="Downloads per platform"):
    """Values per series over time: SVG lines, with HTML labels that stay readable."""
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

    # One hover band per day, centred on it, whose tip lists every series.
    days = [x(d) for d, _ in pts]
    edges = [0, *((a + b) / 2 for a, b in zip(days, days[1:])), w]
    bands = "".join(
        f'<rect class="band" x="{edges[i]:.1f}" y="0" width="{edges[i + 1] - edges[i]:.1f}" height="{h}" '
        f'data-tip="{d} · ' + esc(", ".join(f"{n} {v[k]}" for k, n in enumerate(names))) + '"/>'
        for i, (d, v) in enumerate(pts)
    )
    lines = "".join(
        f'<polyline fill="none" stroke="{COLORS[k]}" stroke-width="3" vector-effect="non-scaling-stroke" '
        'points="' + " ".join(f"{x(d):.1f},{y(v[k]):.1f}" for d, v in pts) + '"/>'
        for k in range(len(names))
    )
    return (
        f'<div class="axis"><span>{top}</span></div>'
        f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" width="100%" height="180" role="img" '
        f'aria-label="{esc(what)} from {pts[0][0]} to {pts[-1][0]}">{lines}{bands}</svg>'
        f'<div class="axis"><span>{pts[0][0]}</span><span>{pts[-1][0]}</span></div>'
    )


def card(title, body, wide=False):
    return f'<div class="card{" wide" if wide else ""}"><h2>{esc(title)}</h2>{body}</div>'


def kpi_group(title, items, tab):
    tiles = "".join(f'<div class="kpi"><b>{esc(n)}</b><span>{esc(t)}</span></div>' for n, t in items)
    return (
        f'<a class="card group" href="#{tab}"><h2>{esc(title)}</h2>'
        f'<div class="kpis">{tiles}</div><span class="more">Details →</span></a>'
    )


def render(today, counts, totals, snap, snap_total, rows, fields, visits=None):
    """One overview tab of headline numbers, then one tab per data source; nothing mixes sources."""
    names = [p for p, _ in PLATFORMS]
    stable = {v: r for v, r in counts.items() if "-" not in v}
    latest = next(iter(stable), None)
    na = "n/a"

    github = [
        card("Downloads per release", legend(names)
             + bars([(v, [r[p] for p in names]) for v, r in counts.items()], stacked=COLORS, names=names)
             + "<details><summary>Numbers</summary><table><tr><th>Release</th>"
             + "".join(f"<th>{esc(p)}</th>" for p in names) + "</tr>"
             + "".join(
                 f"<tr><td>{esc(v)}</td>" + "".join(f"<td>{r[p]}</td>" for p in names) + "</tr>"
                 for v, r in counts.items()
             )
             + "</table></details>", wide=True),
        card("Total over time", legend(names) + line_chart(rows, names), wide=True),
        card("By platform", bars([(p, totals[p]) for p in names], lambda p: COLORS[names.index(p)])),
    ]

    titles = {
        "installed_base_by_version": "Devices by version",
        "installed_base_by_country": "Devices by country",
        "installed_base_by_operating_system": "Devices by system",
    }
    snap_rows = [r for r in rows if r.get("Snap devices")]
    snap_cards = [card("Devices over time", line_chart(snap_rows, ["Snap devices"], "Snap devices"), wide=True)]
    for metric in sorted(snap, key=lambda m: list(titles).index(m) if m in titles else 99):
        ranked = sorted(snap[metric].items(), key=lambda kv: -kv[1])[:10]
        snap_cards.append(card(titles.get(metric, metric), bars(ranked, lambda _: COLORS[2])))
    if not snap:
        snap_cards.append(card("Today", '<p class="note">Snap metrics unavailable today.</p>'))

    if visits:
        daily, refs, paths = visits
        last14 = daily[-14:]
        traffic_cards = [
            card("Traffic per day", legend(TRAFFIC) + line_chart(daily, TRAFFIC, "Repository traffic"), wide=True),
            card("Referring sites, 14 days", bars(refs[:10], lambda _: COLORS[0]) or '<p class="note">None yet.</p>'),
            card("Top pages, 14 days", bars(paths[:10], lambda _: COLORS[0]) or '<p class="note">None yet.</p>'),
        ]
        visitors = sum(int(r["Views"] or 0) for r in last14)
    else:
        traffic_cards = [card("Today", '<p class="note">Repository traffic unavailable today.</p>')]
        visitors = na

    overview = [
        kpi_group("GitHub downloads", [
            (sum(totals.values()), "All releases"),
            (sum(stable[latest].values()) if latest else 0, f"{latest or 'Latest'} downloads"),
            (len(stable), "Stable releases"),
        ], "github"),
        kpi_group("Snap Store", [(na if snap_total is None else snap_total, "Devices now")], "snap"),
        kpi_group("GitHub repository", [(visitors, "Page views, 14 days")], "traffic"),
    ]
    tabs = [
        ("overview", "Overview", "", overview),
        ("github", "GitHub downloads",
         "Direct downloads from GitHub Releases. Homebrew and winget install from there too, so they "
         "are included. The 3 downloads the release pipeline makes itself (1 .dmg, 2 .deb) are subtracted.",
         github),
        ("snap", "Snap Store",
         "Devices with the Snap installed, as reported by the Snap Store. Separate from GitHub downloads.",
         snap_cards),
        ("traffic", "Repository traffic",
         "Visits to the GitHub repository. Referrers and pages count unique visitors; "
         "clones include CI checkouts and bots.",
         traffic_cards),
    ]
    nav = "".join(f'<a role="tab" href="#{t}">{esc(label)}</a>' for t, label, _, _ in tabs)
    panels = "".join(
        f'<section id="{t}" role="tabpanel"><p class="note src">{esc(note)}</p>'
        f'<div class="grid">{"".join(body)}</div></section>'
        for t, _, note, body in tabs
    )
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Nacho Viewer stats</title><style>{CSS}</style><main>"
        f'<h1>Nacho Viewer stats</h1><p class="sub">Updated {today} · refreshed daily</p>'
        f'<nav role="tablist">{nav}</nav>{panels}'
        "<footer>The apt repo has no download counts, and the app sends no telemetry. Data: "
        '<a href="history.csv">history.csv</a> · <a href="traffic.csv">traffic.csv</a> · '
        f'<a href="referrers.csv">referrers.csv</a></footer></main><div id="tip"></div>'
        f"<script>{TIP_JS}{TABS_JS}</script></html>"
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
    rows = [r for r in read_csv(history) if r["date"] != today]
    rows.append({"date": today, **totals, "Snap devices": "" if snap_total is None else snap_total})
    write_csv(history, fields, rows)

    page = render(today, counts, totals, snap, snap_total, rows, fields, traffic(out, today))
    with open(os.path.join(out, "index.html"), "w") as f:
        f.write(page)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
