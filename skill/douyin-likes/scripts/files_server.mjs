// 文件服务：通过 Cloudflare tunnel 远程浏览/下载视频与清单
// 用法: node scripts/files_server.mjs [端口]
import http from 'node:http';
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


const PORT = Number(process.argv[2] || 8090);

const MIME = {
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip', '.webp': 'image/webp',
};

const INDEX = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>抖音点赞归档</title><style>
body{margin:0;background:#0f1115;color:#e6edf3;font-family:system-ui,"Noto Sans CJK SC",sans-serif;padding:20px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b949e;font-size:13px;margin-bottom:18px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:14px}
.card b{display:block;margin-bottom:6px;font-size:14px}
.card span{color:#8b949e;font-size:12.5px;display:block;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid #21262d;text-align:left}
th{color:#8b949e;font-weight:500}tr:hover{background:#161b22}
</style></head><body>
<h1>抖音点赞归档</h1>
<div class="sub">总计 __TOTAL__ 条点赞 · 已下载 __VIDS__ 个视频</div>
<div class="cards">
  <div class="card"><b><a href="/by-date.html">按发布时间浏览</a></b><span>按视频发布日排序，可正/倒序、按年筛选</span><a href="/by-date.html">打开 →</a></div>
  <div class="card"><b><a href="/links.html">全部链接（可搜索）</a></b><span>__TOTAL__ 条，按年份筛选</span><a href="/links.html">打开 →</a></div>
  <div class="card"><b><a href="/report.html">数据分析报告</a></b><span>分年分布 / 作者 / 时长 / 趋势</span><a href="/report.html">打开 →</a></div>
  <div class="card"><b><a href="/earliest.html">最早点赞的 200 条</a></b><span>按点赞先后排序</span><a href="/earliest.html">打开 →</a></div>
  <div class="card"><b><a href="/likes-all.csv">清单 CSV</a></b><span>Excel 可直接打开</span><a href="/likes-all.csv">下载 →</a></div>
  <div class="card"><b><a href="/douyin-videos.zip">已下载视频打包</a></b><span>__VIDZIP__（含封面、元数据）</span><a href="/douyin-videos.zip">下载 →</a></div>
</div>
<h1 style="font-size:16px;margin:0 0 10px">已下载的视频（__VIDS__ 个）</h1>
<table><thead><tr><th>文件</th><th style="width:90px">大小</th><th style="width:70px">播放</th></tr></thead><tbody>
__ROWS__
</tbody></table></body></html>`;

function listVideos() {
  const dir = path.join(ROOT, 'videos');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
}

function statics(urlPath) {
  // 白名单式映射，避免路径穿越
  const map = {
    '/links.html': path.join(ROOT, 'web/links.html'),
    '/by-date.html': path.join(ROOT, 'web/by-date.html'),
    '/by-publish-date.csv': path.join(ROOT, 'exports/by-publish-date.csv'),
    '/report.html': path.join(ROOT, 'web/report.html'),
    '/report.png': path.join(ROOT, 'web/report.png'),
    '/earliest.html': path.join(ROOT, 'web/earliest.html'),
    '/likes-all.csv': path.join(ROOT, 'exports/likes-all.csv'),
    '/douyin-videos.zip': path.join(ROOT, 'exports/douyin-videos.zip'),
    '/douyin-links.zip': path.join(ROOT, 'exports/douyin-links.zip'),
  };
  if (map[urlPath]) return map[urlPath];
  if (urlPath.startsWith('/videos/')) {
    const name = decodeURIComponent(urlPath.slice('/videos/'.length));
    if (name.includes('/') || name.includes('..')) return null;
    const p = path.join(ROOT, 'videos', name);
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

function sendFile(req, res, file) {
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      res.writeHead(206, {
        'content-type': type, 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') {
    const vids = listVideos();
    let total = 0;
    try {
      total = fs.readFileSync(path.join(ROOT, '.scratch/likes-all.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    } catch {}
    const zip = path.join(ROOT, 'exports/douyin-videos.zip');
    const zsize = fs.existsSync(zip) ? (fs.statSync(zip).size / 1048576).toFixed(0) + ' MB' : '未生成';
    const rows = vids.map((v) => `<tr><td>${v.name}</td><td>${(v.size / 1048576).toFixed(1)} MB</td>
      <td><a href="/videos/${encodeURIComponent(v.name)}" target="_blank">播放</a></td></tr>`).join('');
    const html = INDEX.replaceAll('__TOTAL__', String(total)).replaceAll('__VIDS__', String(vids.length))
      .replaceAll('__VIDZIP__', zsize).replaceAll('__ROWS__', rows);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  const file = statics(url);
  if (!file) { res.writeHead(404); return res.end('not found'); }
  try { sendFile(req, res, file); } catch { res.writeHead(500); res.end('error'); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`文件服务已启动: http://localhost:${PORT}/`);
  console.log(`（在 Cloudflare tunnel 里把域名指到这个端口即可远程浏览）`);
});
