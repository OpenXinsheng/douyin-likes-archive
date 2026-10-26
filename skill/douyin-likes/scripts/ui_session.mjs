// 带界面的登录会话：窗口直接显示在 Windows 桌面（WSLg），用户自己操作
// 用法: node scripts/ui_session.mjs [分钟]
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



const MINUTES = Number(process.argv[2] || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
  executablePath: CHROME,
  headless: false,
  userAgent: UA,
  locale: 'zh-CN',
  viewport: { width: 1200, height: 860 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--ozone-platform=wayland',
    '--lang=zh-CN', '--disable-blink-features=AutomationControlled', '--start-maximized'],
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('close', () => log('页面被关闭'));
ctx.on('close', () => log('浏览器被关闭'));

const isLoggedIn = async () =>
  (await ctx.cookies('https://www.douyin.com/')).some(
    (c) => /^sessionid(_ss)?$/i.test(c.name) && c.value && c.value.length > 10);

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log('打开失败', e.message));
log('窗口已打开，等你操作');

const deadline = Date.now() + MINUTES * 60 * 1000;
let logged = false;
while (Date.now() < deadline) {
  try {
    if (await isLoggedIn()) { logged = true; break; }
  } catch { log('浏览器已断开'); break; }
  await new Promise((r) => setTimeout(r, 5000));
}

if (logged) {
  await page.waitForTimeout(2500);
  const st = await ctx.storageState({ path: path.join(ROOT, 'profile-state.json') });
  const names = [...new Set(st.cookies.map((c) => c.name))].filter((n) =>
    /sessionid|ttwid|odin|passport|msToken|sid_guard|uid_tt/i.test(n));
  log('登录成功 ✅ cookie 总数:', st.cookies.length, '| 关键:', names.join(', '));
  fs.writeFileSync(path.join(ROOT, '.scratch', 'LOGIN_OK'), new Date().toISOString());
  await ctx.close();
  process.exit(0);
}
log('窗口关闭或超时，仍未登录');
await ctx.close().catch(() => {});
process.exit(4);
