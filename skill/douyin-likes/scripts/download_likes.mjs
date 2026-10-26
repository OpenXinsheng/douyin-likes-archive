// 批量下载：读 likes-raw.json，逐条下载（幂等、限速、失败分类）
// 用法: node scripts/download_likes.mjs [条数]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
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
const VID = path.join(ROOT, 'videos');
const LIMIT = Number(process.argv[2] || 12);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'likes-raw.json'), 'utf8')).slice(0, LIMIT);
fs.mkdirSync(VID, { recursive: true });

const safeName = (s, max = 40) =>
  (s || 'untitled').replace(/[\\/:*?"<>|\r\n\t#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

function pickUrls(aweme) {
  const v = aweme.video || {};
  const cands = [];
  const push = (label, obj) => { const l = obj?.url_list || []; if (l.length) cands.push({ label, all: l }); };
  push('play_addr', v.play_addr);
  push('play_addr_h264', v.play_addr_h264);
  const br = (v.bit_rate || []).slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  for (const b of br.slice(0, 1)) push(`bit_rate:${b.gear_name || b.bit_rate}`, b.play_addr);
  push('download_addr', v.download_addr);
  return cands;
}

async function fetchTo(url, dest) {
  const part = dest + '.part';
  let start = 0;
  try { start = fs.statSync(part).size; } catch {}
  const headers = { 'user-agent': UA, referer: 'https://www.douyin.com/', accept: '*/*' };
  if (start) headers.range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0) + start;
  const fh = fs.openSync(part, start ? 'a' : 'w');
  let got = start;
  for await (const chunk of res.body) { fs.writeSync(fh, chunk); got += chunk.length; }
  fs.closeSync(fh);
  if (total && got !== total) throw new Error(`大小不符 ${got}/${total}`);
  fs.renameSync(part, dest);
  return got;
}

async function grabCover(aweme, destBase) {
  const url = (aweme.video?.cover?.url_list || [])[0] || (aweme.video?.dynamic_cover?.url_list || [])[0]
    || (aweme.images?.[0]?.url_list || [])[0];
  if (!url) return;
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' } });
    if (!r.ok) return;
    fs.writeFileSync(destBase + '.cover.jpg', Buffer.from(await r.arrayBuffer()));
  } catch {}
}

// 图集
async function grabAlbum(aweme, destBase) {
  const dir = destBase;
  fs.mkdirSync(dir, { recursive: true });
  const imgs = aweme.images || [];
  let ok = 0;
  for (let i = 0; i < imgs.length; i++) {
    const url = (imgs[i].url_list || [])[0];
    if (!url) continue;
    const ext = url.includes('.webp') ? 'webp' : 'jpg';
    const f = path.join(dir, `${String(i + 1).padStart(2, '0')}.${ext}`);
    if (fs.existsSync(f)) { ok++; continue; }
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' } });
      if (!r.ok) continue;
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      ok++;
      await sleep(300);
    } catch {}
  }
  return { ok, total: imgs.length };
}

const stats = { done: 0, skipped: 0, failed: 0, album: 0 };
const results = [];

for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  const author = a.author?.nickname || 'unknown';
  const ymd = new Date((a.create_time || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  const base = `${ymd}_${safeName(author, 12)}_${a.aweme_id}_${safeName(a.desc, 30)}`;
  const dest = path.join(VID, base + '.mp4');
  const meta = path.join(VID, base + '.json');
  const label = `[${i + 1}/${raw.length}] ${author} | ${(a.desc || '(无标题)').slice(0, 30)}`;

  try {
    fs.writeFileSync(meta, JSON.stringify(a, null, 1));
    if (a.images?.length) {
      if (fs.existsSync(path.join(VID, base)) && fs.readdirSync(path.join(VID, base)).length >= a.images.length) {
        log(`${label} → 图集已存在，跳过`); stats.skipped++; results.push({ base, status: 'skip' }); continue;
      }
      const r = await grabAlbum(a, path.join(VID, base));
      log(`${label} → 图集 ${r.ok}/${r.total}`);
      stats.album++; results.push({ base, status: 'album', imgs: r.ok });
      await sleep(1500);
      continue;
    }
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
      log(`${label} → 已存在，跳过`); stats.skipped++; results.push({ base, status: 'skip' }); continue;
    }
    if (!a.video) { log(`${label} → 无视频字段`); stats.failed++; results.push({ base, status: 'no_video' }); continue; }

    let done = false;
    const cands = pickUrls(a);
    for (const c of cands) {
      if (done) break;
      for (const url of c.all) {
        try {
          const bytes = await fetchTo(url, dest);
          log(`${label} → ✅ ${(bytes / 1048576).toFixed(2)} MiB [${c.label}]`);
          stats.done++; results.push({ base, status: 'done', bytes, src: c.label });
          done = true;
          break;
        } catch (e) {
          log(`${label} → [${c.label}] 失败: ${e.message}`);
        }
      }
    }
    if (!done) { stats.failed++; results.push({ base, status: 'failed' }); }
    await grabCover(a, path.join(VID, base));
  } catch (e) {
    log(`${label} → 异常: ${e.message}`);
    stats.failed++; results.push({ base, status: 'error', err: e.message });
  }
  await sleep(1500 + Math.random() * 2000); // 限速，别招风控
}

fs.writeFileSync(path.join(OUT, 'download-report.json'), JSON.stringify({ stats, results }, null, 1));
log('\n=== 汇总 ===');
log(`成功 ${stats.done} | 图集 ${stats.album} | 跳过 ${stats.skipped} | 失败 ${stats.failed}`);
