// 单条下载：解析分享链接 → 浏览器拿详情 JSON → 取无水印地址 → 流式下载
// 用法: node scripts/fetch_one.mjs <分享链接或视频ID>
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



const STATE = path.join(ROOT, 'profile-state.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const input = process.argv[2];
if (!input) { console.error('用法: node scripts/fetch_one.mjs <链接或ID>'); process.exit(1); }
const log = (...a) => console.log(...a);

async function resolveId(arg) {
  const m = arg.match(/(\d{15,25})/);
  if (m && !/v\.douyin\.com/.test(arg)) return m[1];
  if (!/v\.douyin\.com/.test(arg)) throw new Error('无法识别的链接: ' + arg);
  const r = await fetch(arg, { redirect: 'manual', headers: { 'user-agent': UA } });
  const loc = r.headers.get('location') || '';
  const mm = loc.match(/\/(?:share\/)?video\/(\d+)/);
  if (!mm) throw new Error('短链未解析出 ID: ' + loc);
  return mm[1];
}

function pickUrls(aweme) {
  const v = aweme.video || {};
  const cands = [];
  const push = (label, obj) => {
    const list = obj?.url_list || [];
    if (list.length) cands.push({ label, all: list });
  };
  push('play_addr(无水印)', v.play_addr);
  push('play_addr_h264', v.play_addr_h264);
  const br = (v.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  for (const b of br.slice(0, 2)) push(`bit_rate:${b.gear_name || b.bit_rate}`, b.play_addr);
  push('download_addr(带水印)', v.download_addr);
  return cands;
}

const safeName = (s, max = 40) =>
  (s || 'untitled').replace(/[\\/:*?"<>|\r\n\t#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

async function download(url, dest, referer) {
  const part = dest + '.part';
  let start = 0;
  try { start = fs.statSync(part).size; } catch {}
  const headers = { 'user-agent': UA, referer, accept: '*/*' };
  if (start > 0) headers.range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0) + start;
  const fh = fs.openSync(part, start > 0 ? 'a' : 'w');
  let got = start;
  let lastLog = Date.now();
  for await (const chunk of res.body) {
    fs.writeSync(fh, chunk);
    got += chunk.length;
    if (Date.now() - lastLog > 1000) {
      log(`  ${total ? ((got / total) * 100).toFixed(1) + '%' : ''}  ${(got / 1048576).toFixed(1)}${total ? '/' + (total / 1048576).toFixed(1) : ''} MiB`);
      lastLog = Date.now();
    }
  }
  fs.closeSync(fh);
  if (total && got !== total) throw new Error(`大小不符 ${got}/${total}`);
  fs.renameSync(part, dest);
  return { bytes: got, total };
}

const id = await resolveId(input);
log('视频 ID:', id);

const browser = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
  executablePath: CHROME,
  headless: false,
  userAgent: UA,
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--lang=zh-CN',
    '--ozone-platform=wayland', '--disable-blink-features=AutomationControlled'],
});
const ctx = browser;

// 在页面内 hook fetch/XHR —— response 对象读不到 body 时靠它兜底
await ctx.addInitScript(() => {
  window.__CAP__ = [];
  const of = window.fetch;
  window.fetch = async (...args) => {
    const res = await of.apply(window, args);
    try {
      const u = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (u && /aweme\/detail|aweme\/favorite|aweme\/post/.test(u)) {
        const txt = await res.clone().text();
        if (txt) window.__CAP__.push({ url: u, body: txt });
      }
    } catch {}
    return res;
  };
});

const page = await ctx.newPage();
let detail = null;
page.on('response', async (res) => {
  if (!/\/aweme\/v1\/web\/aweme\/detail\//.test(res.url())) return;
  try {
    const j = await res.json();
    if (j?.aweme_detail) detail = j.aweme_detail;
  } catch {}
});

await page.goto(`https://www.douyin.com/video/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
for (let i = 0; i < 30 && !detail; i++) {
  await page.waitForTimeout(500);
  if (i === 12 && !detail) {
    const caps = await page.evaluate(() => (window.__CAP__ || []).map((x) => x.body).filter((b) => b && b.length > 200));
    for (const b of caps) {
      try { const j = JSON.parse(b); if (j?.aweme_detail) { detail = j.aweme_detail; break; } } catch {}
    }
  }
}
await browser.close();

if (!detail) {
  console.error('没拿到详情数据（可能未登录或触发风控）');
  process.exit(2);
}

const desc = detail.desc || '';
const author = detail.author?.nickname || 'unknown';
const dur = (detail.video?.duration || 0) / 1000;
log('标题:', desc.slice(0, 70));
log('作者:', author, '| 时长:', dur.toFixed(1) + 's');
log('点赞:', detail.statistics?.digg_count, '| 评论:', detail.statistics?.comment_count, '| 收藏:', detail.statistics?.collect_count);

const outDir = path.join(ROOT, 'videos');
fs.mkdirSync(outDir, { recursive: true });
const ymd = new Date((detail.create_time || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
const base = `${ymd}_${safeName(author, 12)}_${id}_${safeName(desc, 30)}`;
const dest = path.join(outDir, base + '.mp4');
fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify(detail, null, 1));

const cands = pickUrls(detail);
log('\n候选地址:', cands.length);
for (const c of cands) log(' -', c.label, c.all[0].slice(0, 88));

let ok = false;
for (const c of cands) {
  if (ok) break;
  for (const url of c.all) {
    try {
      log(`\n尝试 [${c.label}] …`);
      const r = await download(url, dest, 'https://www.douyin.com/');
      log(`成功 ${(r.bytes / 1048576).toFixed(2)} MiB`);
      log('文件:', dest);
      ok = true;
      break;
    } catch (e) {
      log('  失败:', e.message);
    }
  }
}
if (!ok) { console.error('所有候选地址都失败'); process.exit(3); }
