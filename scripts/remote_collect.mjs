// 远程控制 + 慢速采集：浏览器画面推流到网页，你的鼠标键盘反向注入
// 用法: node scripts/remote_collect.mjs [端口] [每页延迟ms]
// 你在 Windows 浏览器打开 http://localhost:6081/ 就能直接操作画面
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
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
const PORT = Number(process.argv[2] || 6081);
const DELAY = Number(process.argv[3] || 3000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VW = 1280, VH = 900;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const JSONL = path.join(OUT, 'likes-all.jsonl');
const items = new Map();
if (fs.existsSync(JSONL)) {
  for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); items.set(d.aweme_id, d); } catch {}
  }
}
log(`已有 ${items.size} 条`);

// ---------- 浏览器 ----------
const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'profile'), {
  executablePath: CHROME,
  headless: false, userAgent: UA, locale: 'zh-CN',
  viewport: { width: VW, height: VH },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--lang=zh-CN',
    '--ozone-platform=wayland', '--disable-blink-features=AutomationControlled',
    '--window-size=' + VW + ',' + VH],
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const page = ctx.pages()[0] || (await ctx.newPage());

// ---------- 采集状态 ----------
const fh = fs.openSync(JSONL, 'a');
let pages = 0, hasMore = 1, autoScroll = true;
page.on('response', async (res) => {
  if (!/\/aweme\/v1\/web\/aweme\/favorite\//.test(res.url())) return;
  try {
    const txt = await res.text();
    if (!txt) return;
    const j = JSON.parse(txt);
    pages++; hasMore = j.has_more;
    let n = 0;
    for (const a of j.aweme_list || []) {
      if (!a?.aweme_id || items.has(a.aweme_id)) continue;
      const slim = {
        aweme_id: a.aweme_id, desc: a.desc || '', author: a.author?.nickname || '',
        uid: a.author?.sec_uid || '', create_time: a.create_time || 0,
        duration: a.video?.duration || 0,
        digg: a.statistics?.digg_count ?? null, comment: a.statistics?.comment_count ?? null,
        collect: a.statistics?.collect_count ?? null, share: a.statistics?.share_count ?? null,
        is_image: !!(a.images && a.images.length), images: (a.images || []).length,
        url: `https://www.douyin.com/video/${a.aweme_id}`,
        cover: a.video?.cover?.url_list?.[0] || a.images?.[0]?.url_list?.[0] || '',
        play_addr: a.video?.play_addr?.url_list?.[0] || '',
      };
      items.set(a.aweme_id, slim);
      fs.writeSync(fh, JSON.stringify(slim) + '\n');
      n++;
    }
    if (n) log(`页 ${pages}: +${n} 累计 ${items.size} | has_more=${hasMore}`);
  } catch {}
});

const hasCaptcha = async () => {
  if (page.frames().some((f) => /captcha|verify|secsdk|rmc/i.test(f.url()))) return true;
  return page.evaluate(() => /请完成下列验证|拖动滑块|按住左边按钮/.test(document.body.innerText || '')).catch(() => false);
};

// ---------- HTTP + WS ----------
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>抖音采集 · 远程操作</title>
<style>
html,body{margin:0;height:100%;background:#0b0d11;color:#c9d1d9;font-family:system-ui,sans-serif;overflow:hidden}
#bar{height:34px;line-height:34px;background:#151922;padding:0 12px;font-size:13px;border-bottom:1px solid #232936}
#bar b{color:#58a6ff} #st{margin-left:8px;color:#8b949e}
#wrap{position:relative;height:calc(100vh - 34px);display:flex;align-items:center;justify-content:center}
canvas{max-width:100%;max-height:100%;cursor:crosshair;background:#000}
</style></head><body>
<div id="bar"><b>抖音采集</b> · 远程操作窗口<span id="st">连接中…</span></div>
<div id="wrap"><canvas id="cv"></canvas></div>
<script>
const cv=document.getElementById('cv'), g=cv.getContext('2d');
const st=document.getElementById('st');
let ws, scale=1, last=0, frames=0;
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{ st.textContent='已连接 ✅ 可直接操作'; };
  ws.onclose=()=>{ st.textContent='断开，2 秒后重连…'; setTimeout(connect,2000); };
  ws.onmessage=(e)=>{
    const blob=new Blob([e.data],{type:'image/jpeg'});
    const img=new Image();
    img.onload=()=>{
      if(cv.width!==img.width){cv.width=img.width;cv.height=img.height;}
      g.drawImage(img,0,0); frames++;
    };
    img.src=URL.createObjectURL(blob);
  };
}
connect();
// 每 2 秒拉一次服务端统计，让你能直观看到"操作有没有送到"
setInterval(async()=>{
  try{
    const r=await fetch('/diag'); const d=await r.json();
    st.textContent='已连接 ✅ 已送达操作 '+d.events+' 次 · 采集 '+d.total+' 条';
  }catch(e){}
},2000);
function pos(ev){
  const r=cv.getBoundingClientRect();
  const x=(ev.clientX-r.left)/r.width*cv.width;
  const y=(ev.clientY-r.top)/r.height*cv.height;
  return [Math.round(x),Math.round(y)];
}
function send(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); }
let inside=false;
function posWin(ev){
  const r=cv.getBoundingClientRect();
  const x=(ev.clientX-r.left)/r.width*cv.width;
  const y=(ev.clientY-r.top)/r.height*cv.height;
  inside = x>=0&&y>=0&&x<=cv.width&&y<=cv.height;
  return [Math.round(Math.max(0,Math.min(cv.width,x))),Math.round(Math.max(0,Math.min(cv.height,y)))];
}
window.addEventListener('mousemove',e=>{const p=posWin(e); if(inside) send({t:'mousemove',p});});
window.addEventListener('mousedown',e=>{const p=posWin(e); if(inside){cv.focus();send({t:'mousedown',p,b:e.button});}});
window.addEventListener('mouseup',e=>{const p=posWin(e); send({t:'mouseup',p,b:e.button});});
window.addEventListener('contextmenu',e=>e.preventDefault());
cv.addEventListener('wheel',e=>{e.preventDefault();send({t:'wheel',d:[Math.round(e.deltaX),Math.round(e.deltaY)]});},{passive:false});
cv.tabIndex=0;
window.addEventListener('keydown',e=>{send({t:'keydown',k:e.key});if(e.key.length>1||e.ctrlKey)e.preventDefault();});
window.addEventListener('keyup',e=>send({t:'keyup',k:e.key}));
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url?.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  if (req.url === '/diag') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...stats, pages, total: items.size, has_more: hasMore, clients: wss.clients.size }));
  }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ total: items.size, pages, has_more: hasMore, captcha: null }));
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });
let capturing = false;
const stats = { events: 0, lastEvent: null, cursor: null, downs: 0, ups: 0, errors: [] };
// 串行队列：保证鼠标事件按顺序到达，不被截图挤掉
let chain = Promise.resolve();
function enqueue(fn) { chain = chain.then(fn).catch((e) => { stats.errors.push(String(e.message).slice(0, 120)); }); return chain; }

wss.on('connection', (ws) => {
  log('控制端已接入');
  ws.on('message', (raw) => {
    let e; try { e = JSON.parse(raw.toString()); } catch { return; }
    stats.events++;
    if (e.t === 'mousedown') { stats.downs++; dragging = true; }
    if (e.t === 'mouseup') { stats.ups++; dragging = false; }
    if (e.p) stats.cursor = e.p;
    if (stats.events % 25 === 0) log(`输入事件 ${stats.events} | 光标 ${stats.cursor} | 按下${stats.downs}/松开${stats.ups}`);
    enqueue(async () => {
      if (e.t === 'mousemove') { await page.mouse.move(e.p[0], e.p[1]); }
      else if (e.t === 'mousedown') { autoScroll = false; await page.mouse.move(e.p[0], e.p[1]); await page.mouse.down({ button: e.b === 2 ? 'right' : 'left' }); }
      else if (e.t === 'mouseup') { await page.mouse.up({ button: e.b === 2 ? 'right' : 'left' }); setTimeout(() => { autoScroll = true; }, 1500); }
      else if (e.t === 'wheel') { await page.mouse.wheel(e.d[0], e.d[1]); }
      else if (e.t === 'keydown') { await page.keyboard.down(e.k === ' ' ? 'Space' : e.k); }
      else if (e.t === 'keyup') { await page.keyboard.up(e.k === ' ' ? 'Space' : e.k); }
    });
  });
  ws.on('close', () => log('控制端断开'));
});

// 截图推流
let dragging = false, lastFrame = 0;
setInterval(async () => {
  if (capturing || wss.clients.size === 0) return;
  // 拖拽时 11fps，空闲时约 2fps，兼顾手感与 CPU
  if (!dragging && Date.now() - lastFrame < 450) return;
  lastFrame = Date.now();
  capturing = true;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: dragging ? 70 : 55, timeout: 8000 });
    for (const c of wss.clients) if (c.readyState === 1) c.send(buf);
  } catch {} finally { capturing = false; }
}, 90);

server.listen(PORT, '0.0.0.0', () => {
  log(`远程操作页: http://localhost:${PORT}/   （Windows 浏览器打开）`);
});

// ---------- 打开页面 ----------
await page.goto('https://www.douyin.com/user/self?showTab=like', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

// ---------- 自动滚动采集（遇验证码自动暂停，交给人处理） ----------
let stall = 0;
const deadline = Date.now() + 3 * 60 * 60 * 1000;
while (Date.now() < deadline && hasMore !== 0) {
  await page.waitForTimeout(1000);
  if (!autoScroll) continue;              // 用户正在操作，暂停
  if (await hasCaptcha()) { stall = 0; continue; }  // 有验证码就不滚，等人
  const before = items.size;
  await page.evaluate(() => {
    const cands = [...document.querySelectorAll('*')].filter(
      (el) => el.scrollHeight - el.clientHeight > 300 && el.clientHeight > 200);
    cands.sort((a, b) =>
      (b.className || '').toString().includes('route-scroll') - (a.className || '').toString().includes('route-scroll'));
    for (const el of cands.slice(0, 3)) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(1500 + Math.random() * 800 + DELAY);
  if (items.size === before) {
    stall++;
    if (stall % 20 === 0) log(`连续 ${stall} 轮无新增`);
    if (stall >= 60) { log('长时间无新增，停止自动滚动'); break; }
  } else stall = 0;
}

fs.closeSync(fh);
fs.writeFileSync(path.join(OUT, 'likes-all.meta.json'), JSON.stringify({
  total: items.size, pages, has_more: hasMore, finished_at: new Date().toISOString(), complete: hasMore === 0,
}, null, 1));
log(`=== 结束：累计 ${items.size} 条 / ${pages} 页 / has_more=${hasMore} ===`);
