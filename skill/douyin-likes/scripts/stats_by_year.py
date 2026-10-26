#!/usr/bin/env python3
"""统计已采集的点赞视频：按年份分组"""
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__import__("os").environ.get("DOUYIN_ROOT", Path(__file__).resolve().parent.parent)).resolve()
JSONL = ROOT / ".scratch" / "likes-all.jsonl"
CST = timezone(timedelta(hours=8))  # 抖音内容按北京时间更自然


def main():
    if not JSONL.exists():
        print(f"没有找到 {JSONL}，先跑 collect_all.mjs")
        sys.exit(1)

    seen = {}
    for line in JSONL.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        seen[d["aweme_id"]] = d

    items = list(seen.values())
    if not items:
        print("数据为空")
        sys.exit(1)

    by_year = defaultdict(list)
    for d in items:
        ct = d.get("create_time") or 0
        y = datetime.fromtimestamp(ct, CST).year if ct else 0
        by_year[y].append(d)

    print(f"{'年份':<8}{'视频数':>8}{'占比':>8}{'总时长':>12}{'视频':>8}{'图集':>8}{'≈体积':>10}")
    print("-" * 64)
    total = len(items)
    total_dur = 0
    total_size = 0.0
    for y in sorted(by_year, reverse=True):
        rows = by_year[y]
        dur = sum((r.get("duration") or 0) for r in rows) / 1000
        imgs = sum(1 for r in rows if r.get("is_image"))
        vids = len(rows) - imgs
        # 按 1024x576 约 1.5 Mbps 粗估；实际波动很大
        est = dur * 1.5 / 8 * 1.15  # MB
        total_dur += dur
        total_size += est
        pct = f"{len(rows) / total * 100:.1f}%"
        print(f"{y or '未知':<8}{len(rows):>8}{pct:>8}{dur/3600:>10.1f}h{vids:>8}{imgs:>8}{est/1024:>8.1f}G")

    print("-" * 64)
    print(f"{'合计':<8}{total:>8}{'100%':>8}{total_dur/3600:>10.1f}h"
          f"{sum(1 for r in items if not r.get('is_image')):>8}"
          f"{sum(1 for r in items if r.get('is_image')):>8}{total_size/1024:>8.1f}G")

    # 明细补充
    print()
    years = sorted([y for y in by_year if y], reverse=True)
    if years:
        print(f"时间跨度: {years[-1]} ~ {years[0]}")
    auth = Counter(r.get("author") or "?" for r in items)
    print(f"不同作者: {len(auth)} 个")
    print("最高产作者 Top 5:")
    for name, n in auth.most_common(5):
        print(f"  {n:>4} 条  {name}")

    # 每年单独落一份清单，后面下载/归档直接用
    outdir = ROOT / ".scratch"
    for y, rows in by_year.items():
        (outdir / f"likes-{y or 'unknown'}.json").write_text(
            json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n已按年份拆分清单 → .scratch/likes-<年份>.json")


if __name__ == "__main__":
    main()
