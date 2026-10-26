#!/usr/bin/env python3
"""生成点赞数据的汇总表与分析图表（纯 SVG，无外部依赖）"""
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSONL = ROOT / ".scratch" / "likes-all.jsonl"
OUT = ROOT / "web" / "report.html"
CST = timezone(timedelta(hours=8))

BG = "#0d1117"
CARD = "#161b22"
BORDER = "#21262d"
TEXT = "#e6edf3"
MUTED = "#8b949e"
ACCENT = "#58a6ff"
PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#39c5cf", "#db61a2", "#a5a5a5"]


def load():
    seen = {}
    for line in JSONL.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        seen[d["aweme_id"]] = d
    return list(seen.values())


def svg_bar(rows, width=760, height=260, color=ACCENT, unit="条"):
    """rows: [(label, value)]"""
    if not rows:
        return ""
    pad_l, pad_b, pad_t = 46, 34, 14
    w = width - pad_l - 12
    h = height - pad_b - pad_t
    mx = max(v for _, v in rows) or 1
    n = len(rows)
    bw = w / n * 0.62
    gap = w / n
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" style="display:block">']
    # y 网格
    for i in range(5):
        y = pad_t + h - h * i / 4
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width-12}" y2="{y:.1f}" stroke="{BORDER}"/>')
        parts.append(f'<text x="{pad_l-8}" y="{y+4:.1f}" fill="{MUTED}" font-size="10" text-anchor="end">{int(mx*i/4):,}</text>')
    for i, (label, v) in enumerate(rows):
        bh = h * v / mx
        x = pad_l + gap * i + (gap - bw) / 2
        y = pad_t + h - bh
        parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{bh:.1f}" rx="3" fill="{color}" opacity="0.9"/>')
        parts.append(f'<text x="{x+bw/2:.1f}" y="{y-5:.1f}" fill="{TEXT}" font-size="10.5" text-anchor="middle">{v:,}</text>')
        parts.append(f'<text x="{x+bw/2:.1f}" y="{height-12}" fill="{MUTED}" font-size="11" text-anchor="middle">{label}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_hbar(rows, width=760, bar_h=26, color=ACCENT):
    """rows: [(label, value)] 横向条形"""
    if not rows:
        return ""
    n = len(rows)
    height = n * bar_h + 16
    label_w = 210
    w = width - label_w - 60
    mx = max(v for _, v in rows) or 1
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" style="display:block">']
    for i, (label, v) in enumerate(rows):
        y = 8 + i * bar_h
        bw = w * v / mx
        parts.append(f'<text x="0" y="{y+15}" fill="{TEXT}" font-size="12.5">{label[:15]}</text>')
        parts.append(f'<rect x="{label_w}" y="{y+3}" width="{bw:.1f}" height="{bar_h-9}" rx="3" fill="{color}" opacity="0.85"/>')
        parts.append(f'<text x="{label_w+bw+8:.1f}" y="{y+15}" fill="{MUTED}" font-size="12">{v:,}</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_donut(items, width=240, height=240, r=78):
    total = sum(v for _, v in items) or 1
    cx, cy = width / 2, height / 2
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" style="display:block">']
    ang = -90
    for i, (label, v) in enumerate(items):
        sweep = 360 * v / total
        a0 = ang
        a1 = ang + sweep
        import math
        x0 = cx + r * math.cos(math.radians(a0))
        y0 = cy + r * math.sin(math.radians(a0))
        x1 = cx + r * math.cos(math.radians(a1))
        y1 = cy + r * math.sin(math.radians(a1))
        large = 1 if sweep > 180 else 0
        parts.append(
            f'<path d="M {cx} {cy} L {x0:.1f} {y0:.1f} A {r} {r} 0 {large} 1 {x1:.1f} {y1:.1f} Z" '
            f'fill="{PALETTE[i % len(PALETTE)]}" opacity="0.9"/>')
        ang = a1
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r*0.58:.1f}" fill="{CARD}"/>')
    parts.append(f'<text x="{cx}" y="{cy-2}" fill="{TEXT}" font-size="20" text-anchor="middle" font-weight="600">{total:,}</text>')
    parts.append(f'<text x="{cx}" y="{cy+16}" fill="{MUTED}" font-size="11" text-anchor="middle">总计</text>')
    parts.append("</svg>")
    return "".join(parts)


def svg_line(rows, width=760, height=200, color="#3fb950"):
    if not rows:
        return ""
    pad_l, pad_b, pad_t = 46, 30, 12
    w = width - pad_l - 12
    h = height - pad_b - pad_t
    mx = max(v for _, v in rows) or 1
    n = len(rows)
    pts = []
    for i, (_, v) in enumerate(rows):
        x = pad_l + (w * i / max(1, n - 1))
        y = pad_t + h - h * v / mx
        pts.append(f"{x:.1f},{y:.1f}")
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" style="display:block">']
    for i in range(4):
        y = pad_t + h - h * i / 3
        parts.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width-12}" y2="{y:.1f}" stroke="{BORDER}"/>')
        parts.append(f'<text x="{pad_l-8}" y="{y+4:.1f}" fill="{MUTED}" font-size="10" text-anchor="end">{int(mx*i/3):,}</text>')
    parts.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{color}" stroke-width="2"/>')
    step = max(1, n // 7)
    for i in range(0, n, step):
        x = pad_l + (w * i / max(1, n - 1))
        parts.append(f'<text x="{x:.1f}" y="{height-10}" fill="{MUTED}" font-size="10" text-anchor="middle">{rows[i][0]}</text>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    rows = load()
    total = len(rows)
    now = datetime.now(CST)

    by_year = defaultdict(list)
    by_month = defaultdict(int)
    authors = Counter()
    author_digg = defaultdict(int)
    dur_buckets = Counter()
    for r in rows:
        ct = r.get("create_time") or 0
        if ct:
            dt = datetime.fromtimestamp(ct, CST)
            by_year[dt.year].append(r)
            by_month[dt.strftime("%Y-%m")] += 1
        else:
            by_year[0].append(r)
        authors[r.get("author") or "未知"] += 1
        author_digg[r.get("author") or "未知"] += r.get("digg") or 0
        s = (r.get("duration") or 0) / 1000
        if s <= 0:
            dur_buckets["无(图集)"] += 1
        elif s < 15:
            dur_buckets["<15秒"] += 1
        elif s < 30:
            dur_buckets["15-30秒"] += 1
        elif s < 60:
            dur_buckets["30-60秒"] += 1
        elif s < 180:
            dur_buckets["1-3分钟"] += 1
        elif s < 600:
            dur_buckets["3-10分钟"] += 1
        else:
            dur_buckets[">10分钟"] += 1

    years = sorted([y for y in by_year if y])
    year_rows = [(str(y), len(by_year[y])) for y in years]

    # 表格数据
    table = []
    for y in sorted(years, reverse=True):
        rs = by_year[y]
        dur = sum((r.get("duration") or 0) for r in rs) / 3600000
        vids = sum(1 for r in rs if not r.get("is_image"))
        imgs = len(rs) - vids
        au = len({r.get("author") for r in rs})
        top = Counter(r.get("author") or "未知" for r in rs).most_common(1)
        avg = (sum((r.get("duration") or 0) for r in rs) / len(rs) / 1000) if rs else 0
        table.append({
            "year": y, "n": len(rs), "pct": len(rs) / total * 100, "hours": dur,
            "avg": avg, "vids": vids, "imgs": imgs, "authors": au,
            "top_author": top[0][0] if top else "", "top_n": top[0][1] if top else 0,
        })

    # 月度序列（近 48 个月）
    months = sorted(by_month)
    month_rows = [(m[2:], by_month[m]) for m in months][-48:]

    top_authors = [(a, n) for a, n in authors.most_common(20)]
    top_digg = sorted(((a, v) for a, v in author_digg.items() if v), key=lambda x: -x[1])[:10]

    total_dur = sum((r.get("duration") or 0) for r in rows) / 3600000
    imgs_total = sum(1 for r in rows if r.get("is_image"))
    peak_year = max(year_rows, key=lambda x: x[1])
    top1 = top_authors[0] if top_authors else ("", 0)
    top10_share = sum(n for _, n in top_authors[:10]) / total * 100

    # 表格 HTML
    trs = []
    for t in table:
        trs.append(
            f'<tr><td><b>{t["year"]}</b></td><td class="n">{t["n"]:,}</td>'
            f'<td class="n">{t["pct"]:.1f}%</td><td class="n">{t["hours"]:.1f}h</td>'
            f'<td class="n">{t["avg"]:.0f}s</td><td class="n">{t["vids"]:,}</td>'
            f'<td class="n">{t["imgs"]:,}</td><td class="n">{t["authors"]:,}</td>'
            f'<td class="au">{t["top_author"][:14]} <span class="m">({t["top_n"]})</span></td></tr>')

    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>我的抖音点赞 · 数据分析</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:{BG};color:{TEXT};font-family:system-ui,"Noto Sans CJK SC",sans-serif;padding:22px 26px}}
h1{{font-size:20px;margin:0 0 2px}}
.sub{{color:{MUTED};font-size:12.5px;margin-bottom:18px}}
.kpis{{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}}
.kpi{{background:{CARD};border:1px solid {BORDER};border-radius:10px;padding:12px 14px}}
.kpi .v{{font-size:21px;font-weight:650;letter-spacing:.3px}}
.kpi .l{{color:{MUTED};font-size:11.5px;margin-top:3px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.card{{background:{CARD};border:1px solid {BORDER};border-radius:10px;padding:14px}}
.card h2{{font-size:13.5px;margin:0 0 10px;font-weight:600;color:{TEXT}}}
.card h2 span{{color:{MUTED};font-weight:400;font-size:11.5px;margin-left:6px}}
.full{{grid-column:1 / -1}}
table{{width:100%;border-collapse:collapse;font-size:12.5px}}
th,td{{padding:6px 8px;border-bottom:1px solid {BORDER};text-align:left;white-space:nowrap}}
th{{color:{MUTED};font-weight:500;font-size:11.5px}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}}
td.au{{color:#d2a8ff;max-width:180px;overflow:hidden;text-overflow:ellipsis}}
.m{{color:{MUTED};font-size:11px}}
tr:hover>td{{background:#1c2128}}
.legend{{display:flex;gap:14px;font-size:11.5px;color:{MUTED};margin-top:6px;flex-wrap:wrap}}
.legend i{{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}}
.note{{color:{MUTED};font-size:11.5px;margin-top:8px;line-height:1.55}}
</style></head><body>
<h1>我的抖音点赞 · 数据分析</h1>
<div class="sub">数据截至 {now:%Y-%m-%d %H:%M} · 共 {total:,} 条点赞 · 按视频<strong>发布时间</strong>统计（抖音不返回点赞时间）</div>

<div class="kpis">
  <div class="kpi"><div class="v">{total:,}</div><div class="l">点赞总数</div></div>
  <div class="kpi"><div class="v">{total_dur:,.0f}h</div><div class="l">累计时长（约 {total_dur/24/365:.1f} 年）</div></div>
  <div class="kpi"><div class="v">{len(authors):,}</div><div class="l">涉及作者</div></div>
  <div class="kpi"><div class="v">{peak_year[0]} 年</div><div class="l">点赞最多年份（{peak_year[1]:,} 条）</div></div>
  <div class="kpi"><div class="v">{top1[1]}</div><div class="l">最常点赞的作者<br><span class="m">{top1[0][:12]}</span></div></div>
</div>

<div class="grid">
  <div class="card full">
    <h2>按年份分布 <span>越靠右越早</span></h2>
    {svg_bar(year_rows)}
    <div class="note">注：{now.year} 年只统计到 {now.month} 月，并非完整年份，占比会偏低。</div>
  </div>

  <div class="card">
    <h2>内容构成</h2>
    <div style="display:flex;align-items:center;gap:18px">
      <div style="width:200px">{svg_donut([("视频", total - imgs_total), ("图集", imgs_total)])}</div>
      <div class="legend" style="flex-direction:column;gap:8px">
        <div><i style="background:{PALETTE[0]}"></i>视频 {(total-imgs_total):,} 条（{(total-imgs_total)/total*100:.1f}%）</div>
        <div><i style="background:{PALETTE[1]}"></i>图集 {imgs_total:,} 条（{imgs_total/total*100:.1f}%）</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>视频时长分布</h2>
    {svg_bar([(k, v) for k, v in [("<15秒",dur_buckets["<15秒"]),("15-30秒",dur_buckets["15-30秒"]),("30-60秒",dur_buckets["30-60秒"]),("1-3分",dur_buckets["1-3分钟"]),("3-10分",dur_buckets["3-10分钟"]),(">10分",dur_buckets[">10分钟"])]], height=230, color="#d29922")}
  </div>

  <div class="card full">
    <h2>近 48 个月趋势 <span>按视频发布月份</span></h2>
    {svg_line(month_rows)}
  </div>

  <div class="card">
    <h2>Top 20 作者 <span>按点赞条数</span></h2>
    {svg_hbar(top_authors)}
  </div>

  <div class="card">
    <h2>Top 10 作者 <span>按累计点赞量</span></h2>
    {svg_hbar(top_digg, color="#f85149")}
    <div class="note">前 10 位作者占你全部点赞的 {top10_share:.1f}%，说明你的兴趣{pick_lang(top10_share)}。</div>
  </div>

  <div class="card full">
    <h2>年度汇总表</h2>
    <table><thead><tr>
      <th>年份</th><th style="text-align:right">点赞数</th><th style="text-align:right">占比</th>
      <th style="text-align:right">总时长</th><th style="text-align:right">平均时长</th>
      <th style="text-align:right">视频</th><th style="text-align:right">图集</th>
      <th style="text-align:right">作者数</th><th>该年最常点赞的作者</th>
    </tr></thead><tbody>{''.join(trs)}</tbody></table>
    <div class="note">合计 {total:,} 条 · {total_dur:,.0f} 小时 · {len(authors):,} 位作者。数据来自本机采集，点赞时间不可得，故按视频发布年份归类。</div>
  </div>
</div>
</body></html>"""

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")

    # 控制台摘要
    print(f"总数 {total:,} | 时长 {total_dur:,.0f}h | 作者 {len(authors):,} | 图集 {imgs_total:,}")
    print("\n年份   数量    占比    总时长   平均   视频   图集   作者数")
    for t in table:
        print(f"{t['year']}  {t['n']:>6,}  {t['pct']:>5.1f}%  {t['hours']:>6.1f}h  {t['avg']:>4.0f}s  "
              f"{t['vids']:>6,}  {t['imgs']:>4,}  {t['authors']:>5,}")
    print("\nTop 10 作者:")
    for a, n in top_authors[:10]:
        print(f"  {n:>4} 条  {a}")
    print(f"\n已生成: {OUT}")


def pick_lang(share):
    if share > 60:
        return "非常集中，是少数几个人的铁粉"
    if share > 35:
        return "比较集中，有明显的偏好"
    if share > 20:
        return "比较分散"
    return "极其分散，属于广泛浏览型"


if __name__ == "__main__":
    main()
