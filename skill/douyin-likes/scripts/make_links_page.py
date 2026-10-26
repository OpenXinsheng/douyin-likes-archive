#!/usr/bin/env python3
"""把采集到的点赞记录导出成可点击的网页 + CSV"""
import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__import__("os").environ.get("DOUYIN_ROOT", Path(__file__).resolve().parent.parent)).resolve()
JSONL = ROOT / ".scratch" / "likes-all.jsonl"
OUT_DIR = ROOT / "exports"
WEB = ROOT / "web"
CST = timezone(timedelta(hours=8))


def main():
    rows = []
    seen = set()
    for line in JSONL.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d["aweme_id"] in seen:
            continue
        seen.add(d["aweme_id"])
        rows.append(d)

    # 采集顺序 ≈ 点赞时间从新到旧
    for i, r in enumerate(rows):
        r["order"] = i + 1
        ct = r.get("create_time") or 0
        dt = datetime.fromtimestamp(ct, CST) if ct else None
        r["date"] = dt.strftime("%Y-%m-%d") if dt else ""
        r["year"] = dt.year if dt else 0

    OUT_DIR.mkdir(exist_ok=True)
    WEB.mkdir(exist_ok=True)

    csv_path = OUT_DIR / "likes-all.csv"
    with csv_path.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["点赞顺序", "发布日期", "作者", "标题", "时长秒", "点赞数", "链接", "视频ID"])
        for r in rows:
            w.writerow([
                r["order"], r["date"], r.get("author", ""),
                (r.get("desc") or "").replace("\n", " "),
                round((r.get("duration") or 0) / 1000, 1),
                r.get("digg") if r.get("digg") is not None else "",
                r.get("url", ""), r["aweme_id"],
            ])

    # 网页：搜索 + 按年筛选 + 可点击
    data = [{
        "o": r["order"], "d": r["date"], "y": r["year"],
        "a": r.get("author", ""), "t": (r.get("desc") or "").replace("\n", " ")[:120],
        "u": r.get("url", ""), "g": r.get("digg"),
        "s": round((r.get("duration") or 0) / 1000),
    } for r in rows]

    html = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>我点赞的抖音视频 · 全部链接</title>
<style>
body{margin:0;background:#0f1115;color:#e6edf3;font-family:system-ui,"Noto Sans CJK SC",sans-serif}
header{position:sticky;top:0;background:#161b22;border-bottom:1px solid #21262d;padding:10px 14px;z-index:5}
h1{font-size:15px;margin:0 0 8px;font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 9px;font-size:13px}
input{flex:1;min-width:200px}
#cnt{color:#8b949e;font-size:12px;margin-left:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{padding:6px 8px;border-bottom:1px solid #21262d;text-align:left;vertical-align:top}
th{color:#8b949e;font-weight:500;position:sticky;top:74px;background:#0f1115}
tr:hover{background:#161b22}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.num{color:#6e7681;width:56px}
.date{color:#8b949e;white-space:nowrap;width:88px}
.au{color:#d2a8ff;width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<header>
  <h1>我点赞的抖音视频 · 全部链接</h1>
  <div class="row">
    <input id="q" placeholder="搜索标题 / 作者…">
    <select id="y"><option value="">全部年份</option></select>
    <span id="cnt"></span>
  </div>
</header>
<table><thead><tr><th class="num">#</th><th class="date">发布</th><th class="au">作者</th><th>标题</th><th>链接</th></tr></thead>
<tbody id="tb"></tbody></table>
<script>
const DATA = __DATA__;
const tb=document.getElementById('tb'), q=document.getElementById('q'), ys=document.getElementById('y'), cnt=document.getElementById('cnt');
const years=[...new Set(DATA.map(d=>d.y).filter(Boolean))].sort((a,b)=>b-a);
years.forEach(y=>{const o=document.createElement('option');o.value=y;o.textContent=y+' 年';ys.appendChild(o)});
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function render(){
  const kw=q.value.trim().toLowerCase(), yv=ys.value;
  const rows=DATA.filter(d=>(!yv||String(d.y)===yv)&&(!kw||(d.t||'').toLowerCase().includes(kw)||(d.a||'').toLowerCase().includes(kw)));
  cnt.textContent=rows.length+' / '+DATA.length+' 条';
  const frag=document.createDocumentFragment();
  for(const d of rows){
    const tr=document.createElement('tr');
    tr.innerHTML='<td class="num">'+d.o+'</td><td class="date">'+d.d+'</td><td class="au">'+esc(d.a)+
      '</td><td>'+esc(d.t||'(无标题)')+'</td><td><a href="'+d.u+'" target="_blank" rel="noreferrer">打开</a></td>';
    frag.appendChild(tr);
  }
  tb.innerHTML=''; tb.appendChild(frag);
}
q.addEventListener('input',render); ys.addEventListener('change',render);
render();
</script></body></html>"""
    (WEB / "links.html").write_text(
        html.replace("__DATA__", json.dumps(data, ensure_ascii=False)), encoding="utf-8")

    print(f"已导出 {len(rows)} 条")
    print(f"  CSV : {csv_path.relative_to(ROOT)}")
    print(f"  网页: web/links.html")
    years = {}
    for r in rows:
        years[r["year"]] = years.get(r["year"], 0) + 1
    print("  分年:", ", ".join(f"{y}:{n}" for y, n in sorted(years.items(), reverse=True)))


if __name__ == "__main__":
    main()
