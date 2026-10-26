# 踩坑与对策

按"杀伤力"排序。每条都附实测证据，避免以后重复踩。

---

## 1. Web 端点赞列表约 1,000 页硬上限 🔴 无解

**现象**

```
页 1010: +0 累计 13405 | has_more=1
连续 200 页无新增（已翻 1010 页）
连续 600 页无新增
```

第 1010 页之后接口**不再返回任何数据**，但 `has_more` 一直是 `1`，滚动也不报错。

**证据**：三次独立运行（不同日期、不同内存上限）都停在 1004~1010 页、13.3k 条附近。

**结论**：这是服务端对 Web 端"喜欢"列表的截断，不是内存、不是限流、不是代码 bug。
账号实际点赞 2.4 万，Web 只能给出约 1.3 万。

**对策**：无法绕过。可选官方「个人信息下载」获取完整数据，或接受 Web 可见部分。

---

## 2. headless 模式页面不渲染 🔴

**现象**：headless 下 `document.title` 是通用的「抖音-记录美好生活」，body 只有导航和页脚，接口调用 0 次。

**根因**：抖音 SPA 在无真实合成器时不水合路由。

**对策**：必须 `headless: false`。在无桌面环境时用 WSLg 的 Wayland：
```js
args: ['--ozone-platform=wayland']
env: { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/mnt/wslg/runtime-dir' }
```

---

## 3. 从 Playwright 的 response 读不到 body 🟠

**现象**：`res.text()` 返回空字符串，但 `res.status() === 200`。

**对策**：在页面内 hook `fetch`/`XHR`，直接从 JS 层取数据：

```js
await ctx.addInitScript(() => {
  const of = window.fetch;
  window.fetch = async (...args) => {
    const res = await of.apply(window, args);
    const u = String(args[0]);
    if (/aweme\/detail|aweme\/favorite/.test(u)) {
      const txt = await res.clone().text();
      if (txt) window.__CAP__.push({ url: u, body: txt });
    }
    return res;
  };
});
```

---

## 4. 点赞页滚动卡在 60 条不动 🟠

**现象**：滚轮滚了、`End` 也按了，只加载 60 条，`has_more=1`。

**根因**：真正的滚动容器是 `.route-scroll-container`，不是 `window`。

**对策**：找所有 `scrollHeight - clientHeight > 300` 的元素，优先含 `route-scroll` 的，设 `scrollTop = scrollHeight`：

```js
const cands = [...document.querySelectorAll('*')].filter(
  el => el.scrollHeight - el.clientHeight > 300 && el.clientHeight > 200);
cands.sort((a, b) => (b.className||'').includes('route-scroll') - (a.className||'').includes('route-scroll'));
for (const el of cands.slice(0, 3)) el.scrollTop = el.scrollHeight;
```

---

## 5. 内存随页数线性增长，最后 OOM 🟠

**实测**（15.7GB 宿主机，WSL 默认 7.7GB）：

| 翻页数 | DOM 节点 | JS 堆 | Chrome RSS |
|---:|---:|---:|---:|
| 刚加载 | 2,912 | 178 MB | 1.83 GB |
| 50 页 | 25,746 | 512 MB | 3.05 GB |
| 101 页 | 49,260 | 649 MB | 3.78 GB |
| 151 页 | 71,849 | 849 MB | 4.10 GB |

约 **470 DOM 节点/页、4.4 MB JS 堆/页**，每条视频约 240 KB。

**根因**：无限滚动 SPA 从不释放已渲染的卡片；React 状态里还存着每条视频的完整 JSON（十几组码率地址等）。

**尝试过但无效的对策**：

| 尝试 | 结果 |
|---|---|
| `--blink-settings=imagesEnabled=false` | **更差**（15MB/页），失败图片会重试并生成占位元素 |
| `HeapProfiler.collectGarbage` + `Memory.simulatePressureNotification` | 无改善，活引用 GC 不敢碰 |
| 周期性删除 DOM 卡片 | 破坏虚拟列表 → 渲染进程崩溃 |
| 缩小视口 | 无改善（内存大头是 JS 数据不是布局） |

**有效对策**：加内存。`.wslconfig` 里 `memory=14GB`（宿主 15.7GB 时）。13GB 时实测可到 1010 页而不 OOM。

---

## 6. `--js-flags=--max-old-space-size=512` 导致渲染进程崩溃 🟡

**现象**：跑到 180 页左右报 `Target crashed` / `Page crashed`。

**根因**：V8 堆上限压得太死，页面自己的数据都放不下。

**对策**：不要设堆上限。要控内存只能在系统层加。

---

## 7. 拿不到"点赞时间" 🟡

**现象**：接口返回的 `create_time` 是**视频发布时间**，不是点赞时间。

**影响**：所有"按年份"统计实际是「按视频发布年份」。对"看早年内容"反而更自然，但无法回答"我 2023 年 3 月点了什么赞"。

**对策**：官方数据导出可能带点赞时间；否则无解。

---

## 8. 二维码截图传给用户，扫码时已过期 🟡

**现象**：截一张二维码发给用户，等他看到并扫码已经失效（有效期约 1~2 分钟）。

**关键坑**：定时 `page.reload()` **拿回来的还是同一张过期码**（抖音有缓存，显示"二维码失效 点击刷新"）。

**对策**：必须 `clearCookies()` + 清 `localStorage/sessionStorage` 再重载，才能拿到真正的新码；出图前还要校验不是失效占位图：

```js
const expired = /二维码失效|点击刷新|二维码已过期/.test(document.body.innerText);
```

---

## 9. 二维码元素定位错 🟡

**现象**：截出来的"二维码"是一张写着「下载 APP」的推广卡片。

**对策**：先找包含「扫码登录」文本的最小容器（最内层登录面板），再在它的作用域里找 120~300px 的正方形 `img/canvas`。

---

## 10. WSLg 窗口在用户桌面不可见 / 渲染成灰块 🟡

**现象**：任务栏能看到标题为 `[WARN:COPY MODE] ...` 的窗口，点开是灰的。

**影响**：无法让用户直接操作浏览器（例如手动过验证码）。

**失败过的替代方案**：

| 方案 | 结果 |
|---|---|
| TigerVNC + Xvfb | 系统缺 `/usr/bin/xkbcomp`，X server 启动即崩；无 root 无法安装 |
| noVNC 网页 | 同上，依赖 X server |
| **截图推流 + 鼠标注入**（自研） | ✅ 可行 |

**自研方案原理**：浏览器照常跑在 WSLg 里（内部渲染正常），用 Playwright 定时截图推给网页，用户在网页里拖动鼠标 → 通过 WebSocket 反向注入 `page.mouse.*`。

关键实现细节：
- 输入事件必须走**独立串行队列**，否则会被截图轮询挤掉
- 拖拽时把帧率提到 11fps（90ms），空闲降到 2fps
- 事件监听得挂在 `window` 上，按 canvas 坐标换算，否则点黑边丢事件

---

## 11. 计划任务里 `node` 找不到 🟡

**现象**：

```
timeout: failed to execute process: No such file or directory (os error 2)
--- collect 退出码: 127
```

整个脚本 1 秒跑完，条数毫无变化。

**根因**：Windows 计划任务调 `wsl.exe` 起的是**非登录 shell**，`PATH` 里没有 `~/.local/bin`。

**对策**：脚本里显式 `export PATH`，并用绝对路径调用 node/python。

---

## 12. `wsl.exe -e` 返回后后台进程被杀 🟡

**现象**：`nohup bash script.sh &` 启动后，命令一返回进程就没了。

**对策**：用 systemd 瞬态单元（`/etc/wsl.conf` 里 `systemd=true`）：

```bash
wsl.exe -d Ubuntu -e /bin/bash -lc \
  'systemd-run --user --unit=job --collect --setenv=X=1 /path/script.sh'
```

---

## 13. 定时任务与手动运行互相抢 profile 🟡

**现象**：两个 Chromium 用同一个 `--user-data-dir`，后启动的直接失败。

**对策**：长跑前先 `systemctl --user stop <unit>`，或临时禁用计划任务。

---

## 14. 沙箱里 `/tmp` 不共享 🟢

**现象**：一个命令里启动的 X server、另一个命令连不上（`xcb_connect() failed`）。

**根因**：每条命令跑在独立的 bwrap 沙箱里，`/tmp` 是各自的 tmpfs。

**对策**：需要共享的进程放在**同一条命令**里启动；或改用 TCP（不走 unix socket）。

---

## 15. 目标程序硬编码 `/usr/bin/xxx` 🟢

**现象**：`XKB_BINDIR` 环境变量形同虚设，X server 仍去找 `/usr/bin/xkbcomp`。

**对策**：无 root 时基本无解（`/usr` 只读）。想清楚再投入。

---

## 16. PyPI 只有 14 KB/s，playwright 装不动 🟢

**现象**：`pip install playwright` 卡死 40 分钟。

**实测带宽**：

| 源 | 速度 |
|---|---:|
| files.pythonhosted.org | **14 KB/s** |
| npm registry | 264 KB/s |
| archive.ubuntu.com | 415 KB/s |
| cdn.playwright.dev | **10.4 MB/s** |

**对策**：用 npm 装 playwright（`npm i playwright`），浏览器从官方 CDN 下（快 700 倍）。

---

## 17. 下载视频的 ffmpeg 用不了 🟢

**现象**：Playwright 自带的 `ffmpeg-linux` 对合法 MP4 报 `Invalid data found`。

**根因**：那是为屏幕录制裁剪的最小构建，不含 mp4 解封装。

**对策**：不需要 ffmpeg —— 用 Chromium 打开 `file://` 播放本地 mp4，`video.duration` / `readyState` 即可验证完整性（实测 `readyState=4` 表示完全可解码）。

---

## 18. 空 body 不等于没登录 🟢

**现象**：接口 200 但 body 长度 0；同时可能出现滑块验证码（在 iframe 里，`body.innerText` 看不到）。

**对策**：验证码检测要同时看 iframe：

```js
page.frames().some(f => /captcha|verify|secsdk|rmc/i.test(f.url()))
```

---

## 19. 封面字段覆盖率不齐 🟢

**现象**：早期采集的记录没有 `cover` 字段（脚本中途加字段），导致缩略图墙缺图。

**对策**：字段设计要么一开始就冻结，要么允许缺省并在展示层兜底。

---

## 20. 空转判据过松，白等几小时 🟢

**现象**：撞上 1000 页上限后，脚本以"连续 2000 页无新增"为停止条件，结果空转了 2.5 小时。

**对策**：健康会话每页必返回数据，阈值设 80 页即可（约 5 分钟）。

---

## 附：签名方案为什么走不通

| 尝试 | 结果 |
|---|---|
| `window.byted_acrawler.frontierSign(qs)` | 返回 `{"X-Bogus": "..."}`，接口要 `a_bogus` |
| 用 X-Bogus 发请求 | `403 Blocked by ArgusSecurityPlugin Sign Invalid` |
| 复用浏览器发出的完整签名 URL（原样重放） | 返回 HTML 外壳，非 JSON |
| 复用 URL + 改 `max_cursor` | 同上 |

**结论**：签名绑定完整 URL 且有时效，无法用它跳页。桌面端 `a_bogus` 由混淆过的 SDK 生成，未暴露可调用入口。
