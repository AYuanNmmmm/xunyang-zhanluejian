/* 发一次优惠券（真实点「确定发放」），把接口抓下来
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-coupon.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const LOG = '/tmp/tp-coupon.log';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
};
fs.writeFileSync(LOG, '');

function libSrc() {
  const h = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = h.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

const HOST_PATH = path.join(TMP_UD, 'cp-host.html');
fs.writeFileSync(HOST_PATH, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}webview{display:inline-flex;width:1600px;height:1200px;border:0}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`, 'utf8');
const lib = libSrc();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(HOST_PATH);
  await sleep(2500);
  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { log('no webview'); app.exit(1); return; }

  const reqs = []; const byId = new Map(); let mark = 'start';
  wv.debugger.attach('1.3');
  await wv.debugger.sendCommand('Network.enable', {});
  wv.debugger.on('message', (_e, m, p) => {
    if (m === 'Network.requestWillBeSent') {
      const r = p.request || {};
      const rec = { url: r.url, method: r.method, postData: r.postData || '', mark: mark, status: null, resp: '' };
      reqs.push(rec); byId.set(p.requestId, rec);
    } else if (m === 'Network.responseReceived') {
      const rec = byId.get(p.requestId); if (rec && p.response) rec.status = p.response.status;
    } else if (m === 'Network.loadingFinished') {
      const rec = byId.get(p.requestId);
      if (rec && /\/data\/life\/|life_marketing/.test(rec.url)) {
        wv.debugger.sendCommand('Network.getResponseBody', { requestId: p.requestId }).then((b) => { rec.resp = String((b && b.body) || '').slice(0, 800); }).catch(() => {});
      }
    }
  });

  const frames = () => { const o = []; const w = (f, d) => { if (!f || d > 8) return; o.push(f); let k = []; try { k = f.frames || []; } catch (e) {} ; (k || []).forEach((x) => w(x, d + 1)); }; w(wv.mainFrame, 0); return o; };
  const run = (code, ms) => Promise.race([(async () => {
    let last = null;
    for (const f of frames()) {
      try { await f.executeJavaScript(lib, false); } catch (e) { continue; }
      try {
        const r = await f.executeJavaScript(code, true);
        if (r == null) { last = r; continue; }
        if (typeof r === 'object' && (r.ok === false || r.found === false)) { last = r; continue; }
        return r;
      } catch (e) { last = { ok: false, reason: String(e && e.message || e) }; }
    }
    return last;
  })(), new Promise((r) => setTimeout(() => r({ ok: false, reason: 'timeout' }), ms || 9000))]);

  const click = async (x, y) => {
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, pointerType: 'mouse' }).catch(() => {});
    await sleep(130);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }).catch(() => {});
    await sleep(90);
    await wv.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }).catch(() => {});
  };

  // 等就绪
  for (let i = 0; i < 24; i++) {
    const p = await run('(async()=>{ return { ok:true, cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length }; })()', 5000);
    if (p && p.cards > 0) { log('商品卡：' + p.cards); break; }
    await sleep(1500);
  }
  await sleep(3500);

  mark = '开券面板';
  const entry = await run('(async()=>{ return window.__TP.locate("text=优惠券"); })()');
  log('券入口：' + JSON.stringify(entry).slice(0, 140));
  if (!entry || !entry.ok) { log('❌ 找不到券入口'); app.exit(1); return; }
  await click(entry.x, entry.y);
  await sleep(4500);

  const rows = await run('(async()=>{ return window.__TP.couponPanelRows(); })()', 8000);
  log('券行：' + JSON.stringify(rows && rows.ok ? rows.rows.map((x) => ({ n: x.name, v: x.value, avail: x.avail })) : rows).slice(0, 400));
  if (!rows || !rows.ok) { log('❌ 没读到券行'); app.exit(1); return; }

  const pick = rows.rows[0];
  mark = '点发放';
  // 直接用扫描时拿到的行内按钮坐标（couponPanelRows 已经带 x/y），不再二次查找
  let hit = { ok: true, point: pick.btn };
  log('行内按钮（来自扫描坐标）：' + JSON.stringify(hit.point));
  if (!hit.point || !(hit.point.x > 0) || !(hit.point.y > 0)) {
    hit = await run(`(async()=>{ return window.__TP.couponRowBtn(${JSON.stringify(pick.name)}); })()`, 6000);
    log('二次查找：' + JSON.stringify(hit).slice(0, 200));
  }
  if (!hit || !hit.ok || !hit.point) { log('❌ 找不到行内发放按钮'); app.exit(1); return; }
  // 诊断：直接在主帧里跑，排除多 frame 干扰；并看视口宽度
  await wv.mainFrame.executeJavaScript(lib, false).catch(() => {});
  const raw = await wv.mainFrame.executeJavaScript(`(async()=>{
    const rows = window.__TP.couponRows();
    const target = rows.find((x)=>String(x.cells[0]||'').indexOf(${JSON.stringify(pick.name)})>=0);
    let after = null;
    if (target) { window.__TP.revealEl(target.btn); after = window.__TP.couponRowBtn(${JSON.stringify(pick.name)}); }
    return { href: location.href.slice(0,60), vw: window.innerWidth, vh: window.innerHeight, trs: document.querySelectorAll('tr').length, rows: rows.length, names: rows.map((x)=>x.cells[0]).slice(0,4), after: after };
  })()`, true).catch((e) => ({ err: String(e.message) }));
  log('主帧诊断：' + JSON.stringify(raw).slice(0, 500));
  if (raw && raw.after && raw.after.ok) { hit = raw.after; }
  const chk = await run(`(async()=>{ return window.__TP.pointOk(${hit.point.x}, ${hit.point.y}); })()`, 6000);
  log('坐标校验：' + JSON.stringify(chk).slice(0, 260));
  const around = await run(`(async()=>{ const els=document.elementsFromPoint(${hit.point.x}, ${hit.point.y})||[]; return { ok:true, stack: els.slice(0,5).map((e)=>({tag:e.tagName,cls:String(e.getAttribute('class')||'').slice(0,34),t:(e.textContent||'').trim().slice(0,14)})) }; })()`, 6000);
  log('该点上的元素栈：' + JSON.stringify(around).slice(0, 500));
  await click(hit.point.x, hit.point.y);
  await sleep(2500);
  const afterClick = await run(`(async()=>{
    const body = document.body ? document.body.textContent : '';
    const modals = Array.from(document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')).filter((e)=>{const r=e.getBoundingClientRect();return r.width>120&&r.height>60;});
    return { ok:true, modals: modals.length, texts: modals.slice(0,3).map((m)=>String(m.textContent||'').replace(/\s+/g,' ').slice(0,80)), has发放: /发放数量|发放时长|确定发放/.test(body) };
  })()`, 6000);
  log('点击后：' + JSON.stringify(afterClick).slice(0, 400));

  const modal = await run('(async()=>{ return window.__TP.couponModalState(); })()', 8000);
  log('弹窗：' + JSON.stringify(modal && modal.ok ? { qty: (modal.qty || []).map((q) => q.text + (q.disabled ? '(禁)' : '')), dur: (modal.dur || []).map((d) => d.text), confirm: !!modal.confirm } : modal).slice(0, 400));
  if (!modal || !modal.ok) { log('❌ 没弹出确认框'); app.exit(1); return; }

  mark = '选档位';
  for (const want of ['10张', '1分钟']) {
    const q = await run(`(async()=>{ return window.__TP.couponPick(${JSON.stringify(want)}); })()`, 6000);
    if (q && q.ok) { await click(q.point.x, q.point.y); log('已选 ' + want); await sleep(800); }
    else log('档位 ' + want + ' 不可用：' + JSON.stringify(q).slice(0, 140));
  }

  mark = '确定发放';
  const m2 = await run('(async()=>{ return window.__TP.couponModalState(); })()', 7000);
  if (!m2 || !m2.ok || !m2.confirm) { log('❌ 没有确定按钮'); app.exit(1); return; }
  log('点「确定发放」…');
  await click(m2.confirm.x, m2.confirm.y);
  await sleep(5000);

  const toast = await run('(async()=>{ return window.__TP.readToast(); })()', 6000);
  log('后台提示：' + JSON.stringify(toast).slice(0, 240));

  mark = '收尾';

  const biz = reqs.filter((r) => /\/data\/life\/|life_marketing/.test(r.url));
  const seen = new Set();
  log('\n===== 业务接口 =====');
  for (const r of biz) {
    const k = r.method + ' ' + r.url.split('?')[0];
    if (seen.has(k)) continue;
    seen.add(k);
    log(`${r.mark.padEnd(6)} ${r.method.padEnd(4)} ${r.url.split('?')[0].replace('https://eos.douyin.com', '')} [${r.status || '?'}] signed=${/a_bogus=/.test(r.url)}`);
    if (r.postData) log('        body: ' + String(r.postData).slice(0, 260));
    if (r.resp) log('        resp: ' + String(r.resp).replace(/\s+/g, ' ').slice(0, 200));
  }
  fs.writeFileSync(path.join(TMP_UD, 'api-coupon.json'), JSON.stringify(reqs.filter((r) => /\/data\/life\//.test(r.url)), null, 2));
  log('\n已存 /tmp/tp-api-userdata/api-coupon.json');
  app.exit(0);
});
