/* 第二轮抓包：真实投放，抓「写操作」接口 + 验证页面内 fetch 是否自动签名
 *
 * 用户已授权真实操作。顺序：
 *   0) 环境探测（fetch 是否被包装 / 签名函数 / cookie）
 *   1) 页面内 fetch 直接发评论 → 看签名会不会自动补
 *   2) 点商品卡「讲解」→ 抓讲解接口
 *   3) 开券面板 → 点「发放优惠券」→ 选数量/时长 → 点「确定发放」→ 抓发放接口
 *   4) 开秒杀抽屉 → 填库存 → 点提交（立即投放 10 分钟，库存 5）→ 抓投放接口
 *
 * 每步都有超时保护，输出直接写日志文件。
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-capture2.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const LOG_PATH = '/tmp/tp-cap2.log';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
};
fs.writeFileSync(LOG_PATH, '');

function loadLibSrc() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
  log('[cap2] 登录态已刷新');
} catch (e) { log('[cap2] 复制登录态失败：' + (e.message || e)); }

const HOST_PATH = path.join(TMP_UD, 'cap2-host.html');
fs.writeFileSync(HOST_PATH, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}webview{display:inline-flex;width:1600px;height:1200px;border:0}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`, 'utf8');
const lib = loadLibSrc();

const SKIP = /\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)(\?|$)/i;
const NOISE = /(slardar|sentry|\btea\b|abtest|mcs|webcast_|byteimg|passport|mssdk\.bytedance|log\/|report|monitor)/i;
const short = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return String(u).slice(0, 100); } };

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await win.loadFile(HOST_PATH);
  await sleep(2500);

  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { log('[cap2] ❌ 没拿到 webview'); app.exit(1); return; }

  // ---------- 抓包 ----------
  const reqs = [];
  const byId = new Map();
  let currentMark = '启动';
  const mark = (n) => { currentMark = n; log(`\n[cap2] ▶ ${n}`); };

  try {
    wv.debugger.attach('1.3');
    await wv.debugger.sendCommand('Network.enable', {});
    wv.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const r = params.request || {};
        const rec = { id: params.requestId, url: r.url, method: r.method, type: params.type, postData: r.postData || '', headers: r.headers || {}, mark: currentMark, status: null, respBody: '' };
        reqs.push(rec); byId.set(params.requestId, rec);
      } else if (method === 'Network.responseReceived') {
        const rec = byId.get(params.requestId);
        if (rec && params.response) rec.status = params.response.status;
      } else if (method === 'Network.loadingFinished') {
        const rec = byId.get(params.requestId);
        if (rec && /\/data\/life\//.test(rec.url)) {
          wv.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((b) => { rec.respBody = String((b && b.body) || '').slice(0, 1000); })
            .catch(() => {});
        }
      }
    });
  } catch (e) { log('[cap2] debugger 失败：' + (e.message || e)); app.exit(1); return; }

  // ---------- 工具 ----------
  const withTimeout = (p, ms, tag) => Promise.race([
    p, new Promise((r) => setTimeout(() => r({ err: 'timeout:' + tag }), ms))
  ]);
  const frames = () => { const out = []; const walk = (f, d) => { if (!f || d > 8) return; out.push(f); let k = []; try { k = f.frames || []; } catch (e) {} ; (k || []).forEach((x) => walk(x, d + 1)); }; walk(wv.mainFrame, 0); return out; };
  const run = (code, ms) => withTimeout((async () => {
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
  })(), ms || 9000, 'run');

  const click = async (x, y) => {
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, pointerType: 'mouse' }).catch(() => {});
    await sleep(130);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }).catch(() => {});
    await sleep(90);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }).catch(() => {});
  };
  const key = async (k, vk) => {
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).catch(() => {});
    await sleep(50);
    await wv.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }).catch(() => {});
  };

  // ---------- 等就绪 ----------
  let cards = 0;
  for (let i = 0; i < 24; i++) {
    const p = await run('(async()=>{ return { ok:true, cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length, href: location.href }; })()', 6000);
    if (p && p.cards > 0) { cards = p.cards; break; }
    await sleep(1500);
  }
  log(`[cap2] 商品卡 ${cards} 个`);
  if (!cards) { log('[cap2] 没读到商品卡，放弃'); app.exit(1); return; }
  await sleep(3000);

  // ========== 0. 环境探测 ==========
  mark('0 环境探测');
  const env = await run(`(async()=>{
    const keys = Object.keys(window).filter((k) => /acrawler|bogus|secsdk|bdms|sign/i.test(k)).slice(0, 20);
    const info = {};
    keys.forEach((k) => { info[k] = typeof window[k]; });
    return {
      fetchPatched: String(window.fetch).indexOf('[native code]') < 0,
      xhrPatched: String(window.XMLHttpRequest.prototype.open).indexOf('[native code]') < 0,
      keys: info
    };
  })()`);
  log('[cap2] fetch 被包装=' + (env && env.fetchPatched) + ' XHR 被包装=' + (env && env.xhrPatched) + ' 签名全局=' + JSON.stringify((env && env.keys) || {}));

  // ========== 1. 页面内 fetch 发评论 ==========
  mark('1 页面内 fetch 发评论');
  const ROOM = '7699322213992106786';
  const USER = 'MS4wLjABAAAAPNfbSWM4-Q-ck1BDayGjTvDjFrS4yTUUvrveHpLdEpU';
  const w1 = await run(`(async () => {
    try {
      const res = await fetch('/data/life/live/comment/reply/', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room_id: '${ROOM}', user_id: '${USER}', comment_content: '接口复放测试，请忽略', nickname: '', origin_msg_content: '', origin_msg_id: '' })
      });
      const txt = await res.text();
      return { ok: true, http: res.status, txt: txt.slice(0, 240) };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`, 12000);
  log('[cap2] fetch 发评论 → ' + JSON.stringify(w1).slice(0, 320));
  await sleep(2000);

  // ========== 2. 弹讲解 ==========
  mark('2 弹讲解');
  const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[1]';
  let talk = await run(`(async()=>{ return window.__TP.locateIn(${JSON.stringify(cardSel)}, 'class=talking-btn'); })()`);
  log('[cap2] talking-btn 定位：' + JSON.stringify(talk).slice(0, 140));
  if (!talk || !talk.ok) {
    // 诊断：第 1 张卡里所有可点元素
    const diag = await run(`(async()=>{
      const c = document.querySelector('#live-card-list');
      const card = c && c.querySelector('div[role="button"][aria-label]');
      if (!card) return { ok:false, reason:'no-card' };
      const list = Array.from(card.querySelectorAll('button,[role="button"],span,div')).slice(0, 40).map((e) => {
        const r = e.getBoundingClientRect();
        return { tag: e.tagName, cls: String(e.getAttribute('class')||'').slice(0,40), t: (e.textContent||'').replace(/\\s+/g,'').slice(0,10), w: Math.round(r.width), h: Math.round(r.height) };
      }).filter((x) => x.w > 3 && x.h > 3);
      return { ok:true, list: list.slice(0, 18) };
    })()`);
    log('[cap2] 卡片内可点元素：' + JSON.stringify((diag && diag.list) || diag).slice(0, 800));
    // 兜底：直接点卡里最小的那个可点元素（多半是操作按钮）
    const fb = await run(`(async()=>{ const c=document.querySelector('#live-card-list'); const card=c&&c.querySelector('div[role="button"][aria-label]'); if(!card) return {ok:false};
      const bs=Array.from(card.querySelectorAll('button,[role="button"]')); if(!bs.length) return {ok:false,reason:'no-btn'};
      const b=bs[bs.length-1]; const r=b.getBoundingClientRect(); return {ok:true,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:(b.textContent||'').slice(0,10)}; })()`, 6000);
    log('[cap2] 兜底按钮：' + JSON.stringify(fb).slice(0, 160));
    if (fb && fb.ok) { talk = fb; }
  }
  if (talk && talk.ok) { await click(talk.x, talk.y); await sleep(4000); }
  const talkState = await run(`(async()=>{ return window.__TP.textIn(${JSON.stringify(cardSel)}, 'class=talking-btn'); })()`, 6000);
  log('[cap2] 讲解后按钮文案：' + JSON.stringify(talkState).slice(0, 120));

  // ========== 3. 发券（真实点确定） ==========
  mark('3 发优惠券');
  const cEntry = await run('(async()=>{ return window.__TP.locate("text=优惠券"); })()');
  log('[cap2] 券入口：' + JSON.stringify(cEntry).slice(0, 140));
  if (!cEntry || !cEntry.ok) {
    const diag = await run(`(async()=>{
      const all=Array.from(document.querySelectorAll('div,span,a,button')).filter((e)=>!e.children.length && /优惠券|营销|发券/.test(e.textContent||''));
      return { ok:true, list: all.slice(0,10).map((e)=>{const r=e.getBoundingClientRect();return {t:(e.textContent||'').trim().slice(0,10), cls:String(e.getAttribute('class')||'').slice(0,36), x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width)};}) };
    })()`, 7000);
    log('[cap2] 券相关文字元素：' + JSON.stringify((diag && diag.list) || diag).slice(0, 700));
  }
  if (cEntry && cEntry.ok) {
    await click(cEntry.x, cEntry.y);
    await sleep(4000);
    const rows = await run('(async()=>{ return window.__TP.couponPanelRows(); })()', 8000);
    log('[cap2] 券列表：' + JSON.stringify(rows && rows.ok ? (rows.rows || []).map((x) => ({ n: x.name, v: x.value })) : rows).slice(0, 400));
    if (rows && rows.ok && rows.rows && rows.rows.length) {
      const first = rows.rows[0];
      const hit = await run(`(async()=>{ return window.__TP.couponRowBtn(${JSON.stringify(first.name)}); })()`, 6000);
      log('[cap2] 行内发放按钮：' + JSON.stringify(hit).slice(0, 160));
      if (hit && hit.ok) {
        await click(hit.point.x, hit.point.y);
        await sleep(2500);
        const modal = await run('(async()=>{ return window.__TP.couponModalState(); })()', 8000);
        log('[cap2] 弹窗档位：' + JSON.stringify(modal && modal.ok ? { qty: (modal.qty || []).map((q) => q.text), dur: (modal.dur || []).map((d) => d.text), confirm: !!modal.confirm } : modal).slice(0, 300));
        // 选 10 张 / 1 分钟
        for (const want of ['10张', '1分钟']) {
          const pick = await run(`(async()=>{ return window.__TP.couponPick(${JSON.stringify(want)}); })()`, 6000);
          if (pick && pick.ok) { await click(pick.point.x, pick.point.y); await sleep(700); }
          else log('[cap2] 档位 ' + want + ' 不可选：' + JSON.stringify(pick).slice(0, 120));
        }
        const modal2 = await run('(async()=>{ return window.__TP.couponModalState(); })()', 7000);
        if (modal2 && modal2.ok && modal2.confirm) {
          log('[cap2] 点「确定发放」…');
          await click(modal2.confirm.x, modal2.confirm.y);
          await sleep(4000);
        } else log('[cap2] 没找到确定按钮：' + JSON.stringify(modal2).slice(0, 160));
      }
    }
    await key('Escape', 27);
    await sleep(1500);
  }

  // ========== 4. 秒杀：真实投放 ==========
  mark('4 投放秒杀');
  const skEntry = await run(`(async()=>{ return window.__TP.locateIn(${JSON.stringify(cardSel)}, '[class*="seckill-btn-container"]'); })()`, 8000);
  log('[cap2] 秒杀入口：' + JSON.stringify(skEntry).slice(0, 140));
  if (!skEntry || !skEntry.ok) {
    const scan = await run('(async()=>{ return window.__TP.seckillScan(); })()', 8000);
    log('[cap2] 秒杀入口扫描：' + JSON.stringify(scan && scan.items ? scan.items.map((x) => ({ i: x.i, n: x.name })) : scan).slice(0, 300));
  }
  const skPos = (skEntry && skEntry.ok) ? skEntry : null;
  if (skPos) {
    await click(skPos.x, skPos.y);
    await sleep(3500);
    const f = await run('(async()=>{ const a=window.__TP.seckillForm(); const b=window.__TP.seckillDetail(); return { form: !!a.ok, detail: !!b.ok, mode: a.mode, stock: a.stockValue, submit: !!(a.points&&a.points.submit), submitDisabled: a.submitDisabled }; })()', 8000);
    log('[cap2] 抽屉状态：' + JSON.stringify(f));
    if (f && f.form) {
      // 立即投放 + 时长 10 分钟 + 库存 5
      const nowP = await run('(async()=>{ const a=window.__TP.seckillForm(); return a.ok ? (a.points&&a.points.now) : null; })()', 6000);
      if (nowP && f.mode !== 'now') { await click(nowP.x, nowP.y); await sleep(1200); }
      await run('(async()=>{ return window.__TP.seckillSetDuration("10分钟"); })()', 6000);
      await sleep(800);
      await run('(async()=>{ return window.__TP.seckillSetNum(0, 5); })()', 6000);
      await sleep(1200);
      const f2 = await run('(async()=>{ const a=window.__TP.seckillForm(); return a.ok ? { stock: a.stockValue, dur: a.activeDur, submit: !!(a.points&&a.points.submit), disabled: a.submitDisabled } : a; })()', 7000);
      log('[cap2] 提交前：' + JSON.stringify(f2));
      if (f2 && f2.submit && !f2.disabled) {
        log('[cap2] 点「提交」真实投放…');
        await click(f2.points ? f2.points.submit.x : 0, 0);  // 坐标下面重取
        await sleep(200);
      }
      // 重新取一次再点，避免坐标过期
      const f3 = await run('(async()=>{ const a=window.__TP.seckillForm(); return a.ok ? a : null; })()', 7000);
      if (f3 && f3.points && f3.points.submit && !f3.submitDisabled) {
        await click(f3.points.submit.x, f3.points.submit.y);
        await sleep(4500);
        const cf = await run('(async()=>{ return window.__TP.seckillConfirm(); })()', 7000);
        log('[cap2] 二次确认：' + JSON.stringify(cf).slice(0, 160));
        const toast = await run('(async()=>{ return window.__TP.readToast(); })()', 6000);
        log('[cap2] 后台提示：' + JSON.stringify(toast).slice(0, 200));
      }
      await run('(async()=>{ return window.__TP.seckillClose(); })()', 6000);
      await sleep(1200);
    }
  }

  // ========== 汇总 ==========
  await sleep(2000);
  const biz = reqs.filter((r) => (/\/data\/life\//.test(r.url) || /\/life_marketing\//.test(r.url)) && !NOISE.test(r.url));
  log(`\n[cap2] 总请求 ${reqs.length}，业务接口 ${biz.length}`);
  const dump = [];
  const seen = new Set();
  const groups = {};
  for (const r of biz) {
    const k = r.method + ' ' + short(r.url);
    if (seen.has(k)) continue;
    seen.add(k);
    (groups[r.mark] = groups[r.mark] || []).push(r);
    dump.push({ mark: r.mark, method: r.method, url: r.url, status: r.status, postData: r.postData, resp: r.respBody, headers: r.headers });
  }
  for (const name of Object.keys(groups)) {
    log(`\n=== ${name} ===`);
    for (const r of groups[name]) {
      log(`  ${r.method.padEnd(4)} ${short(r.url)} [${r.status || '?'}]`);
      if (r.postData) log('       body: ' + String(r.postData).replace(/\s+/g, ' ').slice(0, 300));
      if (r.respBody) log('       resp: ' + String(r.respBody).replace(/\s+/g, ' ').slice(0, 200));
      if (r.method === 'POST') log('       signed: a_bogus=' + /a_bogus=/.test(r.url) + ' msToken=' + /msToken=/.test(r.url));
    }
  }
  fs.writeFileSync(path.join(TMP_UD, 'api-captured2.json'), JSON.stringify(dump, null, 2));
  log('\n[cap2] 已存 /tmp/tp-api-userdata/api-captured2.json');
  app.exit(0);
});
