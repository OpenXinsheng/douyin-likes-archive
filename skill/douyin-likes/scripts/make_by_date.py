#!/usr/bin/env python3
"""生成按「视频发布时间」排序的浏览页（可搜索、按年筛选、可正/倒序）"""
import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__import__("os").environ.get("DOUYIN_ROOT", Path(__file__).resolve().parent.parent)).resolve()
JSONL = ROOT / ".scratch" / "likes-all.jsonl"
OUT = ROOT / "web" / "by-date.html"
CSV_OUT = ROOT / "exports" / "by-publish-date.csv"
CST = timezone(timedelta(hours=8))


def main():
    seen = {}
    for line in JSONL.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        seen[d["aweme_id"]] = d
    rows = list(seen.values())

    data = []
    for r in rows:
        ct = r.get("create_time") or 0
        dt = datetime.fromtimestamp(ct, CST) if ct else None
        data.append({
            "d": dt.strftime("%Y-%m-%d") if dt else "",
            "y": dt.year if dt else 0,
            "a": r.get("author") or "",
            "t": (r.get("desc") or "").replace("\n", " ")[:110],
            "u": r.get("url") or "",
            "s": round((r.get("duration") or 0) / 1000),
            "g": r.get("digg"),
            "i": 1 if r.get("is_image") else 0,
        })
    data.sort(key=lambda x: x["d"], reverse=True)

    # CSV 同步导出（按发布日倒序）
    CSV_OUT.parent.mkdir(exist_ok=True)
    with CSV_OUT.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["发布日期", "作者", "标题", "时长秒", "点赞数", "类型", "链接"])
        for r in data:
            w.writerow([r["d"], r["a"], r["t"], r["s"], r["g"] if r["g"] is not None else "",
                        "图集" if r["i"] else "视频", r["u"]])

    years = {}
    for r in data:
        years[r["y"]] = years.get(r["y"], 0) + 1

    html = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>按发布时间浏览 · 我的抖音点赞</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0f1115;color:#e6edf3;font-family:system-ui,"Noto Sans CJK SC",sans-serif}
header{position:sticky;top:0;z-index:20;background:#161b22;border-bottom:1px solid #21262d;padding:10px 16px}
h1{font-size:15px;margin:0 0 8px;font-weight:600}
h1 span{color:#8b949e;font-weight:400;font-size:12px;margin-left:8px}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input[type=search]{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 10px;font-size:13px;min-width:240px;flex:1;max-width:420px}
button{background:#1f6feb22;border:1px solid #1f6feb66;color:#58a6ff;border-radius:6px;padding:6px 11px;font-size:12.5px;cursor:pointer}
button:hover{background:#1f6feb33}
button.on{background:#1f6feb;color:#fff;border-color:#1f6feb}
.tabs{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.tab{background:#0d1117;border:1px solid #30363d;color:#8b949e;border-radius:999px;padding:3px 10px;font-size:12px;cursor:pointer}
.tab.on{background:#1f6feb;border-color:#1f6feb;color:#fff}
#cnt{color:#8b949e;font-size:12px;margin-left:auto;white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:12.8px}
thead th{position:sticky;top:0;background:#0f1115;color:#8b949e;font-weight:500;font-size:11.5px;
  padding:8px 10px;text-align:left;border-bottom:1px solid #21262d;z-index:5}
td{padding:6px 10px;border-bottom:1px solid #1b2028;vertical-align:top}
tr:hover td{background:#161b22}
.d{color:#8b949e;white-space:nowrap;width:92px;font-variant-numeric:tabular-nums}
.a{color:#d2a8ff;width:150px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s{color:#6e7681;width:56px;text-align:right;font-variant-numeric:tabular-nums}
.g{color:#8b949e;width:70px;text-align:right;font-variant-numeric:tabular-nums}
.l{width:54px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.badge{display:inline-block;background:#d2992233;color:#d29922;font-size:10.5px;padding:1px 5px;border-radius:4px;margin-left:5px}
#more{margin:16px auto;display:block;padding:9px 22px}
#end{color:#6e7681;font-size:12px;text-align:center;padding:18px}
</style></head><body>
<header>
  <h1>按发布时间浏览<span>共 __TOTAL__ 条 · 点「打开」回抖音看原片</span></h1>
  <div class="controls">
    <input id="q" type="search" placeholder="搜索标题 / 作者…">
    <button id="sort">最新在前 ↓</button>
    <span id="cnt"></span>
  </div>
  <div class="tabs" id="tabs"></div>
</header>
<table><thead><tr>
  <th class="d">发布日期</th><th class="a">作者</th><th>标题</th>
  <th class="s">时长</th><th class="g">赞</th><th class="l">链接</th>
</tr></thead><tbody id="tb"></tbody></table>
<div id="end"></div>
<script>
const DATA = __DATA__;
const tb=document.getElementById('tb'), q=document.getElementById('q'), cnt=document.getElementById('cnt');
const sortBtn=document.getElementById('sort'), tabs=document.getElementById('tabs'), endEl=document.getElementById('end');
const PAGE=400;
let view=[], shown=0, desc=true, year=0;

const YEARS = __YEARS__;

function buildTabs(){
  tabs.innerHTML='';
  const all=document.createElement('div');
  all.className='tab'+(year===0?' on':''); all.textContent='全部 '+DATA.length;
  all.onclick=()=>{year=0;rebuild()}; tabs.appendChild(all);
  for(const [y,n] of YEARS){
    const t=document.createElement('div');
    t.className='tab'+(year===y?' on':''); t.textContent=y+' ('+n+')';
    t.onclick=()=>{year=y;rebuild()}; tabs.appendChild(t);
  }
}
function esc(s){return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmtDur(s){ if(!s) return '—'; return s<60?s+'s':Math.floor(s/60)+'m'+(s%60?(s%60)+'s':''); }
function rebuild(){
  const kw=q.value.trim().toLowerCase();
  view=DATA.filter(d=>(!year||d.y===year)&&(!kw||(d.t||'').toLowerCase().includes(kw)||(d.a||'').toLowerCase().includes(kw)));
  if(desc) view=view.slice().sort((a,b)=>b.d<a.d?-1:b.d>a.d?1:0);
  else view=view.slice().sort((a,b)=>a.d<b.d?-1:a.d>b.d?1:0);
  tb.innerHTML=''; shown=0; endEl.textContent=''; addRows();
  buildTabs();
}
function addRows(){
  const frag=document.createDocumentFragment();
  const next=view.slice(shown, shown+PAGE);
  for(const d of next){
    const tr=document.createElement('tr');
    tr.innerHTML='<td class="d">'+d.d+'</td><td class="a" title="'+esc(d.a)+'">'+esc(d.a)+
      '</td><td>'+esc(d.t||'(无标题)')+(d.i?'<span class="badge">图集</span>':'')+
      '</td><td class="s">'+fmtDur(d.s)+'</td><td class="g">'+(d.g==null?'—':d.g)+
      '</td><td class="l"><a href="'+d.u+'" target="_blank" rel="noreferrer">打开</a></td>';
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  shown+=next.length;
  cnt.textContent=shown+' / '+view.length+' 条';
  if(shown>=view.length){ endEl.textContent = view.length? '— 到底了 —' : '没有匹配结果'; }
}
q.addEventListener('input',()=>{rebuild()});
sortBtn.onclick=()=>{desc=!desc; sortBtn.textContent=desc?'最新在前 ↓':'最早在前 ↑'; rebuild();};
window.addEventListener('scroll',()=>{
  if(shown<view.length && window.innerHeight+window.scrollY > document.body.offsetHeight-800) addRows();
});
rebuild();
</script></body></html>"""

    html = html.replace("__DATA__", json.dumps(data, ensure_ascii=False))
    html = html.replace("__YEARS__", json.dumps(sorted(years.items(), reverse=True)))
    html = html.replace("__TOTAL__", f"{len(data):,}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")

    print(f"条目 {len(data):,} | 年份 {min(years)}-{max(years)}")
    print(f"网页: {OUT.relative_to(ROOT)}")
    print(f"CSV : {CSV_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
