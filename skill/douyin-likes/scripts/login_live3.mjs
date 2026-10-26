// 常驻登录会话 v3：精确定位二维码 + 定时换码 + 候选元素可审计
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



const PROFILE = path.join(ROOT, 'profile');
const OUT = path.join(ROOT, '.scratch');
const MINUTES = Number(process.argv[2] || 60);
const QR_LIFE_MS = 70 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

fs.mkdirSync(OUT, { recursive: true });
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true, userAgent: UA, locale: 'zh-CN',
  viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
    '--lang=zh-CN', '--disable-blink-features=AutomationControlled'],
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
});

const page = ctx.pages()[0] || (await ctx.newPage());
const isLoggedIn = async () =>
  (await ctx.cookies('https://www.douyin.com/')).some(
    (c) => /^sessionid(_ss)?$/i.test(c.name) && c.value && c.value.length > 10);

// 找二维码：在含“扫码登录”的最小容器里，取最大的近似正方形 img/canvas
async function locateQr() {
  const info = await page.evaluate(() => {
    const cands = [];
    const containers = [...document.querySelectorAll('div,section')].filter((el) => {
      const t = el.innerText || '';
      if (!t.includes('扫码登录')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 200 && r.width < 900 && r.height > 150 && r.bottom > 0;
    });
    // 最内层（面积最小）的就是登录面板
    containers.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const panel = containers[0] || null;
    const scope = panel || document;
    for (const el of scope.querySelectorAll('canvas, img')) {
      const r = el.getBoundingClientRect();
      cands.push({
        tag: el.tagName, cls: String(el.className || '').slice(0, 40),
        x: r.x, y: r.y, w: r.width, h: r.height,
        src: (el.src || '').slice(0, 40),
      });
    }
    return {
      panel: panel ? { w: Math.round(panel.getBoundingClientRect().width), h: Math.round(panel.getBoundingClientRect().height) } : null,
      cands,
    };
  }).catch(() => ({ panel: null, cands: [] }));

  const squares = info.cands.filter((c) => c.w >= 120 && c.w <= 300 && Math.abs(c.w - c.h) < 30);
  squares.sort((a, b) => b.w - a.w);
  return { panel: info.panel, all: info.cands, best: squares[0] || null };
}

async function shootQr() {
  // 没有扫码面板就先点“登录”
  let loc = await locateQr();
  if (!loc.panel) {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button,div,span,a')].find(
        (e) => /^(登录|立即登录|登录\/注册)$/.test((e.textContent || '').trim()) && e.getBoundingClientRect().width < 200);
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(2500);
    loc = await locateQr();
  }
  fs.writeFileSync(path.join(OUT, 'qr-candidates.json'), JSON.stringify(loc, null, 1));
  if (!loc.best) { log('未找到二维码元素', JSON.stringify(loc.panel)); return null; }

  const pad = 14;
  const x = Math.max(0, loc.best.x - pad);
  const y = Math.max(0, loc.best.y - pad);
  const w = Math.min(loc.best.w + pad * 2, 1280 - x);
  const h = Math.min(loc.best.h + pad * 2, 900 - y);
  const file = path.join(OUT, 'qr.png');
  await page.screenshot({ path: file, clip: { x, y, width: w, height: h } });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(file, path.join(ROOT, `qr-${stamp}.png`));
  log(`二维码 ${Math.round(loc.best.w)}x${Math.round(loc.best.h)} → qr-${stamp}.png`);
  return stamp;
}

const deadline = Date.now() + MINUTES * 60 * 1000;
let lastShot = 0;
let logged = false;

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

while (Date.now() < deadline) {
  if (await isLoggedIn()) { logged = true; break; }
  if (Date.now() - lastShot > QR_LIFE_MS) {
    lastShot = Date.now();
    await shootQr();
  }
  await page.waitForTimeout(4000);
}

if (logged) {
  await page.waitForTimeout(2500);
  const st = await ctx.storageState({ path: path.join(ROOT, 'profile-state.json') });
  const names = [...new Set(st.cookies.map((c) => c.name))].filter((n) =>
    /sessionid|ttwid|odin|passport|msToken|sid_guard|uid_tt/i.test(n));
  log('登录成功 ✅ cookie 总数:', st.cookies.length, '| 关键:', names.join(', '));
  await ctx.close();
  process.exit(0);
}
log('会话窗口结束，仍未登录');
await ctx.close();
process.exit(4);
