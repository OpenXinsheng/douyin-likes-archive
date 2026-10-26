// 月份筛选 + 直接播放的画廊服务
// 用法: DOUYIN_ROOT=/path/to/ws node scripts/gallery_server.mjs [端口]
//
// 原理：页面里的 <video> 指向本服务的 /play/<id>，
//       服务端用已登录的浏览器打开该视频页，实时换取可用的 play_addr，
//       再代理转发字节流（支持 Range，可拖动进度）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.DOUYIN_ROOT || SKILL_DIR);
const PORT = Number(process.argv[2] || 8091);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------- 数据 ----------
const JSONL = path.join(ROOT, '.scratch/likes-all.jsonl');
function loadItems() {
  const map = new Map();
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); map.set(d.aweme_id, d); } catch {}
  }
  return [...map.values()];
}
let ITEMS = loadItems();
const order = new Map(ITEMS.map((it, i) => [it.aweme_id, i]));   // 采集顺序 ≈ 点赞时间倒序

function card(it) {
  const ct = it.create_time || 0;
  const dt = ct ? new Date(ct * 1000 + 8 * 3600e3) : null;
  return {
    id: it.aweme_id,
    t: (it.desc || '').replace(/\n/g, ' ').slice(0, 90),
    a: it.author || '',
    y: dt ? dt.getUTCFullYear() : 0,
    m: dt ? dt.getUTCMonth() + 1 : 0,
    d: dt ? dt.toISOString().slice(0, 10) : '',
    s: Math.round((it.duration || 0) / 1000),
    g: it.digg ?? null,
    img: it.is_image ? 1 : 0,
    c: it.cover || '',
    o: order.get(it.aweme_id) ?? 0,
  };
}

// ---------- 浏览器：按需换取新鲜播放地址 ----------
let ctx = null;
let page = null;
let lastDetail = null;
let lock = Promise.resolve();

async function ensureBrowser() {
  if (ctx) return;
  ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
    executablePath: process.env.CHROME_BIN || findChrome(),
    headless: false,
    userAgent: UA, locale: 'zh-CN', viewport: { width: 1100, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
      '--ozone-platform=wayland', '--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  page = ctx.pages()[0] || (await ctx.newPage());
  page.on('response', async (res) => {
    if (!/\/aweme\/v1\/web\/aweme\/detail\//.test(res.url())) return;
    try { const j = await res.json(); if (j?.aweme_detail) lastDetail = j.aweme_detail; } catch {}
  });
  log('浏览器已启动');
}

function findChrome() {
  for (const base of [path.join(ROOT, 'browsers'), path.join(SKILL_DIR, 'browsers')]) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux64', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'chrome';
}

const cache = new Map();          // id -> { url, cover, exp }
const TTL = 20 * 60 * 1000;       // 20 分钟

async function freshUrl(id) {
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  // 串行，避免同时打开多个页面
  lock = lock.then(async () => {
    await ensureBrowser();
    lastDetail = null;
    await page.goto(`https://www.douyin.com/video/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 30 && !lastDetail; i++) await page.waitForTimeout(400);
    if (!lastDetail) throw new Error('拿不到详情（可能未登录或被限流）');
    const v = lastDetail.video || {};
    const url = (v.play_addr?.url_list || [])[0] || (v.play_addr_h264?.url_list || [])[0]
      || (v.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0]?.play_addr?.url_list?.[0];
    if (!url) throw new Error('该视频没有可用播放地址（可能是图集或受限）');
    const cover = (v.cover?.url_list || [])[0] || '';
    const rec = { url, cover, exp: Date.now() + TTL };
    cache.set(id, rec);
    return rec;
  });
  return lock;
}

// ---------- 页面 ----------
const HTML = fs.readFileSync(path.join(SKILL_DIR, 'gallery.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const p = u.pathname;

  if (p === '/' || p === '/gallery.html') {
    const data = ITEMS.map(card);
    const html = HTML.replace('__DATA__', JSON.stringify(data))
      .replace('__TOTAL__', String(data.length));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (p.startsWith('/api/url/')) {
    const id = p.slice('/api/url/'.length);
    try {
      const r = await freshUrl(id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, url: r.url, cover: r.cover }));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (p.startsWith('/play/')) {
    const id = p.slice('/play/'.length);
    try {
      const { url } = await freshUrl(id);
      const headers = { 'user-agent': UA, referer: 'https://www.douyin.com/', accept: '*/*' };
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await fetch(url, { headers, redirect: 'follow' });
      const out = {
        'content-type': upstream.headers.get('content-type') || 'video/mp4',
        'accept-ranges': 'bytes',
      };
      for (const k of ['content-length', 'content-range']) {
        const v = upstream.headers.get(k);
        if (v) out[k] = v;
      }
      res.writeHead(upstream.status, out);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
          }
        };
        pump().catch(() => { try { res.destroy(); } catch {} });
      } else res.end();
    } catch (e) {
      res.writeHead(502); res.end('播放地址获取失败: ' + e.message);
    }
    return;
  }

  if (p === '/reload') { ITEMS = loadItems(); res.writeHead(200); return res.end('ok'); }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  log(`画廊: http://localhost:${PORT}/  （${ITEMS.length} 条）`);
  log('点卡片即可播放；首次播放需 2~5 秒（服务端在实时换取地址）');
});
