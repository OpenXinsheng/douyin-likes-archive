// 全量采集「我点赞的视频」（可分轮续跑，追加写入不丢数据）
// 用法: node scripts/collect_all.mjs [最大页数] [每页后延迟毫秒]
//   node scripts/collect_all.mjs 600 0        # 快速一轮
//   node scripts/collect_all.mjs 2000 5000    # 慢速（每页停顿 5 秒）
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 路径无关化：项目根目录由脚本位置推导 ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// playwright 下载的 chrome 版本号会变，这里自动搜索
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const base = path.join(ROOT, 'browsers');
  if (!fs.existsSync(base)) return 'chrome';
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'chrome-linux64', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return 'chrome';
}
const CHROME = findChrome();



const OUT = path.join(ROOT, '.scratch');
const MAX_PAGES = Number(process.argv[2] || 600);
const VW = Number(process.env.VW || 1280), VH = Number(process.env.VH || 900);
const DELAY = Number(process.argv[3] || 0);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

fs.mkdirSync(OUT, { recursive: true });
const JSONL = path.join(OUT, 'likes-all.jsonl');

// 读已有数据，续跑不重复
const items = new Map();
if (fs.existsSync(JSONL)) {
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); items.set(d.aweme_id, d); } catch {}
  }
}
log(`已有 ${items.size} 条，本轮上限 ${MAX_PAGES} 页，每页延迟 ${DELAY}ms`);
const fh = fs.openSync(JSONL, 'a');

let pages = 0;
let hasMore = 1;
let lastNew = Date.now();

const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
  executablePath: CHROME,
  headless: false, userAgent: UA, locale: 'zh-CN',
  viewport: { width: VW, height: VH },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--lang=zh-CN',
    '--ozone-platform=wayland', '--disable-blink-features=AutomationControlled',
    ],
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const page = ctx.pages()[0] || (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);
async function reclaimMemory() {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });
  } catch {}
}

page.on('response', async (res) => {
  if (!/\/aweme\/v1\/web\/aweme\/favorite\//.test(res.url())) return;
  try {
    const txt = await res.text();
    if (!txt) return;
    const j = JSON.parse(txt);
    pages++;
    hasMore = j.has_more;
    let newCount = 0;
    for (const a of j.aweme_list || []) {
      if (!a?.aweme_id || items.has(a.aweme_id)) continue;
      const slim = {
        aweme_id: a.aweme_id,
        desc: a.desc || '',
        author: a.author?.nickname || '',
        uid: a.author?.sec_uid || '',
        create_time: a.create_time || 0,
        duration: a.video?.duration || 0,
        digg: a.statistics?.digg_count ?? null,
        comment: a.statistics?.comment_count ?? null,
        collect: a.statistics?.collect_count ?? null,
        share: a.statistics?.share_count ?? null,
        is_image: !!(a.images && a.images.length),
        images: (a.images || []).length,
        url: `https://www.douyin.com/video/${a.aweme_id}`,
        cover: a.video?.cover?.url_list?.[0] || a.images?.[0]?.url_list?.[0] || '',
        play_addr: a.video?.play_addr?.url_list?.[0] || '',
      };
      items.set(a.aweme_id, slim);
      fs.writeSync(fh, JSON.stringify(slim) + '\n');
      newCount++;
    }
    if (newCount) lastNew = Date.now();
    if (pages % 100 === 0) {
      try {
        const dom = await page.evaluate(() => document.getElementsByTagName('*').length);
        const heap = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1);
        log(`  [资源] DOM ${dom.toLocaleString()} 节点 | JS堆 ${heap.toFixed(0)} MB | 累计 ${items.size} 条`);
      } catch {}
    }
    log(`页 ${pages}: +${newCount} 累计 ${items.size} | has_more=${j.has_more}`);
    if (hasMore === 0) log('已到最后一页');
  } catch (e) {
    log('解析失败:', e.message);
  }
});

await page.goto('https://www.douyin.com/user/self?showTab=like', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
log('页面标题:', await page.title());

let stall = 0;
while (pages < MAX_PAGES) {
  if (hasMore === 0) break;
  const before = items.size;
  await page.evaluate(() => {
    const cands = [...document.querySelectorAll('*')].filter(
      (el) => el.scrollHeight - el.clientHeight > 300 && el.clientHeight > 200);
    cands.sort((a, b) =>
      (b.className || '').toString().includes('route-scroll') - (a.className || '').toString().includes('route-scroll'));
    for (const el of cands.slice(0, 3)) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1500 + Math.random() * 600 + DELAY);
  if (items.size === before) {
    stall++;
    // 续跑时前面几百页必然全是重复，所以只有翻过上一轮的位置后才允许判停
    if (stall % 20 === 0) log(`连续 ${stall} 页无新增（已翻 ${pages} 页）`);
    if (stall >= 80) { log("连续 80 页无新增，判定已到接口上限"); break; }
  } else {
    stall = 0;
  }
}

fs.closeSync(fh);
fs.writeFileSync(path.join(OUT, 'likes-all.meta.json'), JSON.stringify({
  total: items.size, pages_this_run: pages, has_more: hasMore,
  finished_at: new Date().toISOString(), complete: hasMore === 0,
}, null, 1));
log(`\n=== 本轮结束：累计 ${items.size} 条 / 本轮 ${pages} 页 / has_more=${hasMore} ===`);
await ctx.close();
