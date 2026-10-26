---
name: douyin-likes-archive
description: 采集、下载、归档、分析当前登录账号在抖音「点赞过」的全部视频。用 Playwright 驱动真实 Chrome 拦截接口响应（不逆向签名），输出清单（JSONL/CSV）、可搜索网页、无水印视频、数据分析报告。
whenToUse: 用户要求"备份/导出/整理我的抖音点赞"、"把点赞过的视频下载下来"、"统计我点赞过的内容分布"，或需要排查该流程失败原因时。
---

# 抖音点赞归档

把账号「点赞过」的视频做成可搜索、可下载、可按年份归档的本地数据集。

## 目录约定

技能自带的 `scripts/` 可直接用，数据默认落在技能目录里。若想指定工作区（推荐，避免数据混进技能包）：

```bash
export DOUYIN_ROOT=/path/to/workspace    # 所有脚本都认这个变量
```

工作区需要满足：

```
$DOUYIN_ROOT/
├── node_modules/     # npm i playwright ws
├── browsers/         # npx playwright install chromium
├── profile/          # 登录态（脚本自动创建）
├── .scratch/         # 采集中间数据
├── videos/
├── web/
└── exports/
```

## 前提条件

```bash
node -v                 # 需要 >= 20
npm install             # playwright / ws
npx playwright install chromium
python3 -c "import sys; print(sys.version)"
```

Linux 无 root、Chromium 起不来（缺 libnss3 等）时：

```bash
python3 scripts/fetch_libs.py "$(find browsers -name chrome -type f | head -1)"
```

## 标准流程

### 1. 登录（必须真人扫码，不要尝试自动化）

```bash
node scripts/login_live3.mjs 60
```

脚本会把二维码保存成 `qr-<时间戳>.png`。把这张图给用户，让他用**抖音 App** 扫码。
登录态落在 `profile/` 目录，实测有效期约 2 个月。

> 二维码约 1~2 分钟过期。**重新加载页面拿回来的还是旧码** —— 必须清 cookie + 清 storage 才会发新码（脚本已处理）。

### 2. 先小规模验证

```bash
node scripts/collect_all.mjs 20 3000     # 20 页，每页间隔 3 秒
```

看到 `页 1: +18 累计 18` 才算通了。若一直是 `+0`，按下面的排查表处理。

### 3. 全量采集

```bash
node scripts/collect_all.mjs 3000 2500
```

- 增量写入 `.scratch/likes-all.jsonl`（已存在的 id 自动跳过，可反复跑）
- 每页约 4~11 秒，1000 页约 50 分钟~3 小时
- 想要更快就调小第二个参数，但**别低于 1000ms**，容易触发滑块

### 4. 生成产物

```bash
python3 scripts/stats_by_year.py      # 分年统计 + 拆分明细
python3 scripts/make_links_page.py    # web/links.html + exports/likes-all.csv
python3 scripts/make_by_date.py       # web/by-date.html + exports/by-publish-date.csv
python3 scripts/report.py             # web/report.html（SVG 图表）
```

可选：`node scripts/files_server.mjs 8090` 起个静态服务，支持视频 Range 播放。

### 5. 下载视频（可选）

```bash
node scripts/fetch_one.mjs "https://v.douyin.com/xxxxx/"   # 单条验证
node scripts/download_likes.mjs 20                          # 批量
```

输出 `videos/日期_作者_ID_标题.mp4` + 同名 `.json` / `.cover.jpg`。
下载只需 `user-agent` + `referer`，不需要 cookie，但**直链有时效，拿到就下**。

## 排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 接口 403 `Uifid Not Found` | 没登录 / 没签名 | 走登录流程，别手写请求 |
| 页面只有导航和页脚，接口 0 次调用 | headless 模式不水合 | `headless: false`（无桌面用 `--ozone-platform=wayland`） |
| 只加载 60 条就不动了 | 滚错容器 | 滚 `.route-scroll-container`，不是 window |
| `has_more=1` 但再也不返回数据，卡在约 1000 页 | Web 端服务端截断 | 无解，见 `references/PITFALLS.md#1` |
| `res.text()` 返回空 | Playwright 读不到 body | 在页面内 hook `fetch`/`XHR` |
| 跑到几百页 `Target crashed` | V8 堆上限压太死 | 别设 `--max-old-space-size` |
| OOM 被杀 | 无限滚动页面囤积 DOM | 加内存（每页约 +4.4MB 堆），别禁图片（反而更费） |
| 计划任务里 `exit 127` | 非登录 shell 找不到 node | 脚本里写死 PATH 和绝对路径 |

完整 20 条见 `references/PITFALLS.md`，实现细节见 `references/METHOD.md`。

## 产物

| 路径 | 内容 |
|---|---|
| `.scratch/likes-all.jsonl` | 原始数据，一行一条，含播放地址/封面地址 |
| `exports/likes-all.csv` | Excel 可开，含链接列 |
| `web/links.html` | 全量可搜索列表 |
| `web/by-date.html` | 按视频发布时间排序，可正/倒序、按年筛选 |
| `web/report.html` | 数据分析报告 |
| `videos/` | 无水印视频 + 元数据 + 封面 |

## 验收标准

1. `wc -l .scratch/likes-all.jsonl` 的数值 ≥ 用户预期（或明确解释为何受限）
2. 每条记录都有 `url`，格式 `https://www.douyin.com/video/<id>`，且尾部 id 与 `aweme_id` 一致
3. 下载的视频能播放：用 Chromium 打开 `file://` 路径，`video.readyState === 4`

## 重要提醒

- **点赞时间拿不到**：接口只返回视频发布时间，所以"按年份"统计的是**发布年份**，不是点赞年份。
- **Web 端上限**：约 1000 页 / 1.3 万条。账号实际点赞更多时，剩余部分 Web 拿不到，需建议用户走官方「个人信息下载」。
- **只读自己账号**；采集频率别低于每页 1 秒；下载的视频版权归原作者，仅供个人备份。
- `profile/`、`likes-all.jsonl`、`videos/` 含个人数据，**不要提交到任何公开仓库**。
