// 采集「我点赞的视频」列表：滚动翻页，拦截 favorite 接口
// 用法: node scripts/collect_likes.mjs [条数] 
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 路径无关化：项目根目录由脚本位置推导 ----
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 数据目录：默认是本技能目录，可用 DOUYIN_ROOT 指向任意工作区
const ROOT = path.resolve(process.env.DOUYIN_ROOT || SKILL_DIR);
// playwright 下载的 chrome 版本号会变，这里自动搜索
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const base of [path.join(ROOT, 'browsers'), path.join(SKILL_DIR, 'browsers')]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'chrome';
}
const CHROME = findChrome();



const OUT = path.join(ROOT, '.scratch');
const LIMIT = Number(process.argv[2] || 12);
const MAX_SCROLL = Number(process.argv[3] || 25);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
  executablePath: CHROME,
  headless: false, userAgent: UA, locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--lang=zh-CN',
    '--ozone-platform=wayland', '--disable-blink-features=AutomationControlled'],
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = ctx.pages()[0] || (await ctx.newPage());

// 收集从 favorite 接口拿到的一手 aweme
const items = new Map();
const pages = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/\/aweme\/v1\/web\/aweme\/favorite\//.test(u)) return;
  try {
    const txt = await res.text();
    if (!txt) { log('favorite 接口空 body'); return; }
    const j = JSON.parse(txt);
    const list = j.aweme_list || [];
    pages.push({ cursor: j.cursor, has_more: j.has_more, n: list.length });
    let added = 0;
    for (const a of list) {
      if (a?.aweme_id && !items.has(a.aweme_id)) { items.set(a.aweme_id, a); added++; }
    }
    log(`接口返回 ${list.length} 条（新增 ${added}）累计 ${items.size}，has_more=${j.has_more}`);
  } catch (e) {
    log('解析 favorite 失败:', e.message);
  }
});

await page.goto('https://www.douyin.com/user/self?showTab=like', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);
log('页面标题:', await page.title());
log('当前 URL:', page.url().slice(0, 100));

let idle = 0;
while (items.size < LIMIT && idle < MAX_SCROLL) {
  const before = items.size;
  await page.mouse.wheel(0, 2400);
  await page.waitForTimeout(1800 + Math.random() * 800);
  if (items.size === before) idle++; else idle = 0;
  log(`滚动中… 已有 ${items.size} 条（连续无新增 ${idle}）`);
  if (pages.length && pages[pages.length - 1].has_more === 0) { log('已到底'); break; }
}

const all = [...items.values()].slice(0, LIMIT);
const dump = all.map((a) => ({
  aweme_id: a.aweme_id,
  desc: a.desc || '',
  author: a.author?.nickname || '',
  create_time: a.create_time,
  duration: a.video?.duration,
  digg: a.statistics?.digg_count,
  comment: a.statistics?.comment_count,
  collect: a.statistics?.collect_count,
  share: a.statistics?.share_count,
  has_video: !!a.video,
  images: (a.images || []).length,
  play_addr: a.video?.play_addr?.url_list || [],
}));

fs.writeFileSync(path.join(OUT, 'likes-raw.json'), JSON.stringify(all, null, 1));
fs.writeFileSync(path.join(OUT, 'likes-summary.json'), JSON.stringify(dump, null, 1));

log(`\n=== 共采集 ${all.length} 条 ===`);
dump.forEach((d, i) => {
  const dt = d.create_time ? new Date(d.create_time * 1000).toISOString().slice(0, 10) : '?';
  console.log(`${String(i + 1).padStart(2)}. [${dt}] ${d.author} | ${(d.desc || '(无标题)').slice(0, 46)} | ${(d.duration / 1000).toFixed(1)}s | 赞${d.digg} | 图集${d.images}`);
});
await ctx.close();
