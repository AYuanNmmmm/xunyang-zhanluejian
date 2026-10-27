/* 抓「写操作」接口：真实操作一遍，把后台发出的请求全部记录下来
 *
 * 操作清单（按顺序，每步之间打时间标记，方便把请求归因到具体动作）：
 *   ① 点第 1 个商品卡的「讲解」
 *   ② 公屏发一条评论
 *   ③ 打开优惠券面板（只看不发，不点「确定发放」）
 *   ④ 打开秒杀抽屉（只看不提交，不点「提交」）
 *
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-capture.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
const srcP = path.join(REAL_UD, 'Partitions', 'douyin');
const dstP = path.join(TMP_UD, 'Partitions', 'douyin');
if (fs.existsSync(srcP) && !fs.existsSync(dstP)) {
  require('node:child_process').execFileSync('cp', ['-R', srcP, dstP]);
  console.log('[cap] 已复制登录态');
} else {
  // 每次都刷新，确保拿到最新 cookie
  try {
    require('node:child_process').execFileSync('rm', ['-rf', dstP]);
    require('node:child_process').execFileSync('cp', ['-R', srcP, dstP]);
    console.log('[cap] 已刷新登录态');
  } catch (e) {}
}

const HOST = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}
webview{width:1600px;height:1200px;display:block}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`;
const HOST_PATH = path.join(TMP_UD, 'cap-host.html');
fs.writeFileSync(HOST_PATH, HOST, 'utf8');
const lib = loadLibSrc();

const SKIP = /\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)(\?|$)/i;
const NOISE = /(monitor|slardar|sentry|tea|abtest|mcs|webcast_|byteimg|passport|mssdk\.bytedance|verify|risk|log\/|report)/i;

function short(u) {
  try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return String(u).slice(0, 120); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await win.loadFile(HOST_PATH);
  await sleep(2500);

  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { console.log('[cap] ❌ 没有 webview'); app.exit(1); return; }

  // ---------- 抓包 ----------
  const reqs = [];
  const byId = new Map();
  const marks = [];
  let currentMark = '启动';
  const mark = (name) => { currentMark = name; marks.push({ name, at: Date.now() }); console.log(`\n[cap] ▶ ${name}`); };

  try {
    wv.debugger.attach('1.3');
    await wv.debugger.sendCommand('Network.enable', {});
    wv.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const r = params.request || {};
        const rec = { id: params.requestId, url: r.url, method: r.method, type: params.type, postData: r.postData || '', headers: r.headers || {}, mark: currentMark, at: Date.now(), status: null, respHead: '' };
        reqs.push(rec); byId.set(params.requestId, rec);
      } else if (method === 'Network.responseReceived') {
        const rec = byId.get(params.requestId);
        if (rec) { rec.status = params.response && params.response.status; }
      } else if (method === 'Network.loadingFinished') {
        const rec = byId.get(params.requestId);
        if (rec && /\/data\/life\//.test(rec.url)) {
          // 取响应体（写操作看返回码最关键）
          wv.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((b) => { rec.respBody = String((b && (b.body || b)) || '').slice(0, 1200); })
            .catch(() => {});
        }
      }
    });
  } catch (e) {
    console.log('[cap] debugger 失败：', e && e.message); app.exit(1); return;
  }

  // ---------- 注入自动化库 ----------
  const frames = () => { const out = []; const walk = (f, d) => { if (!f || d > 8) return; out.push(f); let k = []; try { k = f.frames || []; } catch (e) {} ; k.forEach((x) => walk(x, d + 1)); }; walk(wv.mainFrame, 0); return out; };
  const run = async (code) => {
    let last = null;
    for (const f of frames()) {
      try { await f.executeJavaScript(lib, false); } catch (e) { continue; }
      try {
        const r = await f.executeJavaScript(code, true);
        if (r == null) { last = r; continue; }
        if (typeof r === 'object' && (r.found === false || r.ok === false || r.reason === 'not-found')) { last = r; continue; }
        return r;
      } catch (e) { last = { ok: false, reason: String(e && e.message || e) }; }
    }
    return last;
  };

  // ---------- 输入注入（CDP，不抢鼠标） ----------
  const click = async (x, y) => {
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, pointerType: 'mouse' });
    await sleep(120);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(80);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  };
  const typeText = async (x, y, text) => {
    await click(x, y);
    await sleep(200);
    for (const ch of Array.from(text)) {
      await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
      await sleep(70);
    }
  };
  const enter = async () => {
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(40);
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r', unmodifiedText: '\r' });
    await sleep(40);
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  const esc = async () => {
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(60);
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  };

  // ---------- 等中控台就绪 ----------
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const p = await run('(async()=>{ return window.__TP.probe("#live-card-list, #current-live-room"); })()');
    if (p && p.found) { ready = true; break; }
    await sleep(1500);
  }
  console.log('[cap] 中控台就绪：', ready);
  const info = await run('(async()=>{ const b=(document.body.textContent||""); return { ok:true, live: /直播中|结束直播/.test(b), cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length }; })()');
  console.log('[cap] 页面状态：', JSON.stringify(info));
  await sleep(4000);

  const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[{{n}}]'.replace('{{n}}', '1');
  const actSel = 'class=talking-btn';

  // ① 弹讲解
  mark('① 弹讲解');
  const talk = await run(`(async()=>{ return window.__TP.locateIn(${JSON.stringify(cardSel)}, ${JSON.stringify(actSel)}); })()`);
  console.log('[cap] 讲解按钮定位：', JSON.stringify(talk).slice(0, 160));
  if (talk && talk.ok) { await click(talk.x, talk.y); await sleep(3500); }
  else {
    // 兜底：直接找卡片里第一个可点按钮
    const any = await run('(async()=>{ const c=document.querySelector("#live-card-list"); if(!c) return {ok:false}; const b=c.querySelector("button,[role=button]"); if(!b) return {ok:false}; const r=b.getBoundingClientRect(); return {ok:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),text:(b.textContent||"").slice(0,20)}; })()');
    console.log('[cap] 兜底按钮：', JSON.stringify(any).slice(0, 160));
    if (any && any.ok) { await click(any.x, any.y); await sleep(3500); }
  }

  // ② 发评论
  mark('② 公屏发评论');
  const box = await run('(async()=>{ return window.__TP.locate("textarea[placeholder*=\\"输入评论\\"]"); })()');
  console.log('[cap] 评论框：', JSON.stringify(box).slice(0, 160));
  if (box && box.ok) {
    await typeText(box.x, box.y, '接口探测，请忽略');
    await sleep(600);
    await enter();
    await sleep(3000);
  }

  // ③ 开券面板（不发）
  mark('③ 打开优惠券面板');
  const cEntry = await run('(async()=>{ return window.__TP.locate("text=优惠券"); })()');
  console.log('[cap] 券入口：', JSON.stringify(cEntry).slice(0, 160));
  if (cEntry && cEntry.ok) {
    await click(cEntry.x, cEntry.y);
    await sleep(4000);
    const rows = await run('(async()=>{ return window.__TP.couponPanelRows(); })()');
    console.log('[cap] 券列表：', rows && rows.ok ? `${(rows.rows || []).length} 张 ${(rows.rows || []).map((x) => x.name).join(' / ')}` : JSON.stringify(rows).slice(0, 120));
    await esc();
    await sleep(1500);
  }

  // ④ 开秒杀抽屉（不提交）
  mark('④ 打开秒杀抽屉');
  const sk = await run(`(async()=>{ return window.__TP.locateIn(${JSON.stringify(cardSel)}, '[class*="seckill-btn-container"]'); })()`);
  console.log('[cap] 秒杀入口：', JSON.stringify(sk).slice(0, 160));
  if (sk && sk.ok) {
    await click(sk.x, sk.y);
    await sleep(3500);
    const st = await run('(async()=>{ const f=await window.__TP.seckillForm(); const d=window.__TP.seckillDetail(); return { ok:true, form: !!(f&&f.ok), detail: !!(d&&d.ok), mode: f&&f.mode }; })()');
    console.log('[cap] 秒杀抽屉：', JSON.stringify(st));
    await esc();
    await sleep(1500);
  }

  // 回中控台，收尾
  mark('收尾');
  await esc();
  await sleep(2500);

  // ---------- 汇总 ----------
  const biz = reqs.filter((r) => /\/data\/life\//.test(r.url) || /\/life_marketing\//.test(r.url));
  console.log(`\n[cap] 共抓到 ${reqs.length} 个请求，业务接口 ${biz.length} 个\n`);

  const groups = {};
  for (const r of biz) { (groups[r.mark] = groups[r.mark] || []).push(r); }
  const out = [];
  for (const name of Object.keys(groups)) {
    console.log(`\n=== ${name} ===`);
    const seen = new Set();
    for (const r of groups[name]) {
      const key = r.method + ' ' + short(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mark: name, method: r.method, url: r.url, status: r.status, postData: r.postData, resp: r.respBody || '' });
      console.log(`  ${r.method.padEnd(4)} ${short(r.url)}  [${r.status || '?'}]`);
      if (r.postData) console.log(`       body: ${String(r.postData).replace(/\s+/g, ' ').slice(0, 260)}`);
      if (r.respBody) console.log(`       resp: ${String(r.respBody).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }

  const dumpPath = path.join(TMP_UD, 'api-captured.json');
  fs.writeFileSync(dumpPath, JSON.stringify(out, null, 2));
  console.log('\n[cap] 清单已存：', dumpPath);
  console.log('[cap] 写操作接口数量：', out.filter((x) => x.method === 'POST').length);
  app.exit(0);
});
