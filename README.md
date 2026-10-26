# 抖音「我点赞的视频」全量归档

把抖音账号里**点赞过的视频**批量采集、下载、归档、分析的整套工具链。

用真实浏览器（Playwright + Chromium）驱动抖音 Web 端，拦截它自己发出的接口响应 —— **不逆向签名算法、不伪造请求**，因此长期可用性远高于手写签名方案。

---

## 结果示例

在真实账号上跑出的规模（单账号，7 年跨度）：

| 指标 | 数值 |
|---|---|
| 采集到点赞记录 | 13,405 条 |
| 覆盖时间 | 2019-08 ~ 2026-10 |
| 涉及作者 | 9,741 位 |
| 累计时长 | 449 小时 |
| 已下载视频 | 12 个（验证下载链路） |

> ⚠️ Web 端存在约 **1,000 页 / 1.3 万条**的硬上限（详见 `docs/PITFALLS.md` #1）。
> 如果你的账号点赞总数超过这个数，Web 端**拿不到**全部——这不是代码问题，是服务端限制。

---

## 为什么必须用浏览器

| 尝试 | 结果 |
|---|---|
| 直接 `curl` 接口 | `403 Blocked by ArgusSecurityPlugin Uifid Not Found` |
| 带上 cookie 再试 | 仍然 403，需要 `a_bogus` / `msverify` 等动态签名 |
| 自己调签名函数 `byted_acrawler.frontierSign` | 只返回旧的 `X-Bogus`，接口要 `a_bogus` → `403 Sign Invalid` |
| 复用浏览器已签名的 URL 重放 | 返回网页外壳（签名绑定完整 URL 且有时效） |

**结论：让浏览器自己发请求，我们只负责读响应。**

---

## 架构

```
┌─────────────────────────────────────────────┐
│  Chromium (headed, 需要真实渲染)              │
│    └─ douyin.com/user/self?showTab=like     │
│         └─ 无限滚动 → 自动发 /favorite/ 请求  │
└──────────────┬──────────────────────────────┘
               │ Playwright 拦截 response
               ▼
      ┌──────────────────┐
      │ likes-all.jsonl  │  增量去重，一条一行
      └────────┬─────────┘
               │
    ┌──────────┼───────────┬──────────────┐
    ▼          ▼           ▼              ▼
 下载视频   分年统计     链接页/浏览页   分析报告
 (mp4+json) (stats)     (HTML)         (SVG 图表)
```

---

## 快速开始

```bash
# 1) 依赖
npm install                      # playwright / ws / novnc
npx playwright install chromium  # 下载 Chromium（约 190MB）

# 2) （Linux，无 root 时）补齐 Chromium 运行时库
python3 scripts/fetch_libs.py $(find browsers -name chrome -type f | head -1)

# 3) 登录（把弹出的二维码用抖音 App 扫）
node scripts/login_live3.mjs 60

# 4) 采集（先跑 20 页验证）
node scripts/collect_all.mjs 20 3000

# 5) 全量采集（约 1 小时/千页）
node scripts/collect_all.mjs 3000 2500

# 6) 生成产物
python3 scripts/stats_by_year.py
python3 scripts/make_links_page.py    # 全量链接页
python3 scripts/make_by_date.py       # 按发布时间浏览
python3 scripts/report.py             # 数据分析报告
```

---

## 脚本一览

| 脚本 | 作用 |
|---|---|
| `login_live3.mjs` | 扫码登录，登录态存进 `profile/` |
| `collect_all.mjs` | **核心**：滚动采集，增量写 `likes-all.jsonl` |
| `collect_likes.mjs` | 早期版本：只采前 N 条（调试用） |
| `fetch_one.mjs` | 单条下载：给分享链接/ID 就下无水印原片 |
| `download_likes.mjs` | 批量下载（幂等、限速、多地址降级） |
| `stats_by_year.py` | 按年份统计并拆分明细 |
| `make_links_page.py` | 生成可搜索的全量链接页 + CSV |
| `make_by_date.py` | 生成按发布时间排序的浏览页 + CSV |
| `report.py` | 生成 SVG 数据分析报告（无外部依赖） |
| `files_server.mjs` | 静态文件服务（支持视频 Range 播放） |
| `remote_collect.mjs` | 远程操作：画面推流 + 鼠标注入（用于手动过验证码） |
| `fetch_libs.py` | 无 root 解决 Chromium 缺失的 .so |
| `nightly.sh` | 定时任务入口（Windows 计划任务调用） |

---

## 数据格式

`likes-all.jsonl`，一行一条：

```json
{
  "aweme_id": "7695556501943271397",
  "desc": "标题/文案",
  "author": "作者昵称",
  "create_time": 1792750502,
  "duration": 9300,
  "digg": 39310, "comment": 257, "collect": 635, "share": 1715,
  "is_image": false,
  "url": "https://www.douyin.com/video/7695556501943271397",
  "play_addr": "https://v26-web.douyinvod.com/...",
  "cover": "https://p3-sign.douyinpic.com/..."
}
```

> `create_time` 是**视频发布时间**，不是点赞时间 —— 抖音不返回点赞时间（见 `docs/PITFALLS.md` #7）。

---

## 已知限制

1. **Web 端约 1,000 页上限**：第 1010 页后接口不再返回数据，`has_more` 却始终为 1。三次独立运行都停在同一位置，判定为服务端限制。
2. **没有断点续传**：列表只能从头翻。每次运行都要重新滚过前面的页，所以必须单次跑完。
3. **需要真实渲染**：headless 模式下抖音页面不水合（只出导航和页脚），必须 headed。
4. **验证码**：请求过快会触发滑块，需要人工处理。

---

## 合规与免责

- 本工具**只读取你自己账号的内容**，不涉及他人隐私。
- 采集频率默认很低（每页 2.5 秒），但仍可能触发平台风控，**账号风险自负**。
- 下载的视频版权归原作者，**仅供个人备份，请勿二次分发**。
- 请遵守抖音用户协议及当地法律法规。

---

## License

MIT

---

## 作为 Skill 使用

仓库里的 `skill/douyin-likes/` 是一个可直接安装的 agent skill（DSH / Claude 等支持 skill 的环境）：

```bash
# 项目内使用（推荐）
mkdir -p <项目>/.dsh/skills && cp -r skill/douyin-likes <项目>/.dsh/skills/

# 全局使用
mkdir -p ~/.dsh/skills && cp -r skill/douyin-likes ~/.dsh/skills/
```

装好后在助手里说「帮我备份抖音点赞」即可自动命中，无需重复描述流程。

`doubao/` 目录是给豆包（或其他不支持执行代码的助手）用的纯提示词版本：`智能体设定.md` 粘进系统提示，`知识库-常见问题.md` 作为知识库上传。
