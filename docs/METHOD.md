# 实现方法

## 一、采集：拦截浏览器自己的请求

核心思路一句话：**不生成请求，只读响应。**

```
Chromium(headed) → 打开点赞页 → 应用自己滚动加载 → 应用自己算签名发请求
                                        ↓
                            Playwright 监听 response
                                        ↓
                             取 JSON → 去重 → 落盘
```

### 1. 打开页面

```js
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.douyin.com/user/self?showTab=like');
```

必须 `headless: false`（见 PITFALLS #2）。

### 2. 监听响应

```js
page.on('response', async (res) => {
  if (!/\/aweme\/v1\/web\/aweme\/favorite\//.test(res.url())) return;
  const j = JSON.parse(await res.text());
  for (const a of j.aweme_list || []) {
    if (items.has(a.aweme_id)) continue;     // 去重
    fs.writeSync(fh, JSON.stringify(slim(a)) + '\n');   // 立即落盘
  }
});
```

字段裁剪后再存：只保留 id、文案、作者、发布时间、时长、统计、链接、播放地址、封面。

### 3. 触发翻页

滚 `.route-scroll-container`（PITFALLS #4），每次间隔 2~5 秒随机。

### 4. 停止条件

| 条件 | 说明 |
|---|---|
| `has_more === 0` | 正常到底 |
| 连续 80 页无新增 | 判定撞上接口上限（PITFALLS #1） |
| 页数上限 | 防止无限跑 |

---

## 二、登录：扫码 + 持久化

```js
const ctx = await chromium.launchPersistentContext('./profile', { ... });
```

`profile/` 目录就是登录态（cookies + localStorage）。实测有效期约 2 个月。

扫码流程的两个关键点：
1. 必须 `clearCookies()` + 清 storage 才能刷出**新**二维码（PITFALLS #8）
2. 截图前校验不是"二维码失效"占位图

---

## 三、下载：从 JSON 里取无水印直链

详情接口返回的 `video` 对象里有多个地址，按优先级降级：

| 优先级 | 字段 | 说明 |
|---|---|---|
| 1 | `video.play_addr.url_list` | 无水印原片 |
| 2 | `video.play_addr_h264.url_list` | 兼容性更好 |
| 3 | `video.bit_rate[]` 按码率降序 | 有时画质更高 |
| 4 | `video.download_addr.url_list` | 带水印，最后兜底 |

下载只需要两个头：

```js
headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' }
```

不需要 cookie。但 **URL 带时效**，必须拿到就下。

### 断点续传

```js
if (fs.existsSync(part)) start = fs.statSync(part).size;
headers.range = `bytes=${start}-`;
// 下完校验 content-length + start === 实际字节数
```

### 失败分类

| 情况 | 判定 | 处理 |
|---|---|---|
| 直链过期 | HTTP 403/410 | 重新拉详情换新地址，重试 2 次 |
| 私密/已删 | detail 404 或 status≠0 | 标记 `deleted`，退出队列，保留元数据 |
| 会员/受限 | `play_addr` 为空 | 标记 `restricted`，隔天重试 |
| 网络抖动 | 超时/连接重置 | 指数退避 1/2/4/8s，最多 5 次 |
| 图集 | 无 `video` 字段、有 `images[]` | 逐张下载到同名目录 |

---

## 四、分析：纯 SVG 图表

不引入图表库，`scripts/report.py` 直接拼 SVG 字符串，好处是：

- 零依赖、离线可用
- 单文件 HTML，发给谁都能看
- 可以截图成 PNG（用 Chromium `fullPage` 截图）

指标：分年数量、时长分布、内容构成（视频/图集）、近 48 个月趋势、Top 20 作者、年度汇总表。

---

## 五、远程操作浏览器（可选）

当需要人工过验证码而本地又看不到窗口时，`remote_collect.mjs` 提供：

1. 浏览器照常跑在 WSLg
2. 每 90ms（拖拽时）/ 450ms（空闲）截图，JPEG 推给网页
3. 网页里的鼠标事件反向注入 `page.mouse.*`

设计要点见 PITFALLS #10。

---

## 六、调度

Windows 计划任务 → `wsl.exe` → `nightly.sh`：

```
schtasks /Create /TN DouyinLikesNightly /SC DAILY /ST 01:00 \
  /TR "C:\Windows\System32\wsl.exe -d Ubuntu -e /bin/bash /path/scripts/nightly.sh"
```

`nightly.sh` 负责：等 WSLg 就绪 → 采集 → 重算统计 → 刷新页面 → 写日志。

注意 PITFALLS #11（PATH）和 #12（进程托管）。

---

## 七、实测性能

| 指标 | 数值 |
|---|---|
| 每页耗时（2.5s 延迟） | 约 4~11 秒 |
| 1,000 页总耗时 | 约 50 分钟 ~ 3 小时 |
| 每页内存增长 | 4.4 MB（JS 堆）/ 470 节点 |
| 1,000 页峰值内存 | 13 GB（含 swap 余量） |
| 单条视频下载 | 2~20 MB，约 1~5 秒 |
