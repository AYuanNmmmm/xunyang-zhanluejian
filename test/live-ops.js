/* 真机实操：在真实直播间里逐个跑功能，真提交、真发放，并回收界面日志
 *
 *   OPS=seckill  env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox test/live-ops.js
 *   OPS=coupon,seckill,comment,popup,pin   （逗号分隔，按顺序跑）
 *
 * 与 app-drive 的区别：app-drive 只读、不提交；这个会真的投放/发放，跑完自己收尾（停止）。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-ops-userdata';
const OPS = String(process.env.OPS || 'seckill').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}
let cfgSaved = null;
try { cfgSaved = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

ipcMain.handle('config:load', () => cfgSaved);
ipcMain.handle('config:save', (_e, d) => { cfgSaved = d; return { ok: true }; });
ipcMain.handle('config:path', () => path.join(TMP_UD, 'config.json'));
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', (_e, s2) => guestApi.setLib(s2));
ipcMain.handle('guest:call', async (_e, code, target) => guestApi.runInFrames(code, target));
ipcMain.handle('guest:register', (_e, name, id) => guestApi.register(name, id));
ipcMain.handle('guest:names', () => ({ ok: true, names: guestApi.guestNames() }));
ipcMain.handle('guest:probe', (_e, target, sel) => guestApi.runInFrames(
  `(async()=>{ return window.__TP ? window.__TP.probe(${JSON.stringify(sel || '#live-card-list, #current-live-room')}) : { found:false, reason:'no-lib' }; })()`,
  target
));
ipcMain.handle('guest:pickStart', (_e, t) => guestApi.pickStart(t));
ipcMain.handle('guest:pickPoll', (_e, t) => guestApi.pickPoll(t));
ipcMain.handle('guest:pickStop', (_e, t) => guestApi.pickStop(t));
ipcMain.handle('guest:frames', (_e, t) => guestApi.frameInfo(t));
ipcMain.handle('guest:scan', (_e, n, t) => guestApi.scanAll(n, t));
ipcMain.handle('guest:realClick', (_e, x, y, t) => guestApi.realClick(x, y, t));
ipcMain.handle('guest:realType', (_e, x, y, s2, t) => guestApi.realType(x, y, s2, t));
ipcMain.handle('guest:realMove', (_e, x, y, t) => guestApi.realMove(x, y, t));
ipcMain.handle('guest:realEnter', (_e, t) => guestApi.realEnter(t));
ipcMain.handle('guest:realKey', (_e, k, n, t) => guestApi.realKey(k, n, t));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
  guestApi.setLib(loadLibSrc());
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false }
  });
  await win.loadFile(SRC);
  await sleep(2000);

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => 'ERR:' + e.message);
  const click = (sel) => js(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'no-el'; e.click(); return 'clicked'; })()`);
  const nav = (tab) => js(`(function(){ var e=document.querySelector('.nav-item[data-tab="${tab}"]'); if(!e) return 'no-tab'; e.click(); return 'ok'; })()`);
  const logs = async (n) => {
    const arr = await js(`Array.from(document.querySelectorAll("#logBody .log-line")).slice(${-(n || 12)}).map(function(el){return el.className.replace("log-line ","")+" | "+el.textContent;})`);
    return Array.isArray(arr) ? arr : [];
  };
  const mark = async (label, n) => {
    const l = await logs(n || 14);
    console.log(`\n----- ${label} -----`);
    l.forEach((x) => console.log('  ' + String(x).slice(0, 160)));
  };
  const tp = (code) => js('window.__debug.workerRun(' + JSON.stringify(code) + ')');
  // 等某个条件成立（避免写死 sleep：任务排队时耗时可能翻几倍）
  const until = async (label, fn, ms) => {
    const t0 = Date.now();
    for (;;) {
      let r = null;
      try { r = await fn(); } catch (e) { r = null; }
      if (r) { console.log(`[ops] ${label}：${typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200)}（${Math.round((Date.now() - t0) / 1000)}s）`); return r; }
      if (Date.now() - t0 > (ms || 60000)) { console.log(`[ops] ${label}：等 ${Math.round((ms || 60000) / 1000)}s 没等到`); return null; }
      await sleep(1500);
    }
  };
  // 等界面日志里出现某一句话（批量任务是一段一段做的，按"空闲"判断会误判）
  const untilLog = async (label, kw, ms) => {
    const t0 = Date.now();
    let last = 0;
    let beat = 0;
    for (;;) {
      const arr = await logs(40);
      if (Array.isArray(arr)) {
        const hit = arr.slice(last).filter((l) => l.indexOf(kw) >= 0);
        if (hit.length) {
          console.log(`[ops] ${label}：${hit[hit.length - 1].slice(0, 160)}（${Math.round((Date.now() - t0) / 1000)}s）`);
          return true;
        }
        last = Math.max(0, arr.length - 6);
        const sec = Math.round((Date.now() - t0) / 1000);
        if (sec - beat >= 20) {
          beat = sec;
          console.log(`[ops] …${label} ${sec}s，最新日志：${String(arr[arr.length - 1] || '').slice(0, 120)}`);
        }
      } else {
        console.log(`[ops] ${label} 读不到日志：${String(arr).slice(0, 160)}`);
      }
      if (Date.now() - t0 > (ms || 120000)) { console.log(`[ops] ${label}：等 ${Math.round((ms || 120000) / 1000)}s 没出现「${kw}」`); return false; }
      await sleep(2000);
    }
  };

  // 等后台页就绪
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await js('window.__debug ? window.__debug.worker() : null');
    if (st && (st.state === 'ready' || st.state === 'failed')) break;
    await sleep(2000);
  }
  console.log('[ops] 后台页状态：', JSON.stringify(st), '| 页面：', JSON.stringify(guestApi.guestNames()));
  console.log('[ops] 本次实操：', OPS.join(' → '));

  for (const op of OPS) {
    if (op === 'seckill') {
      await nav('goods'); await sleep(400);
      await click('[data-action="fetch-goods"]');
      await until('抓商品', async () => {
        const s = await js('window.__debug.sched()');
        const n = await js(`document.querySelectorAll('#goodsBody input[data-action="pick-goods"]').length`);
        return (n > 0 && !(s && s.queue && s.queue.length)) ? n + ' 个商品' : null;
      }, 90000);
      await click('[data-action="seckill-scan"]');
      await until('扫秒杀入口', async () => {
        const n = await js(`document.querySelectorAll('#seckillBody input[data-action="pick-seckill"]').length`);
        return n > 0 ? n + ' 个入口' : null;
      }, 90000);
      // 勾选有秒杀入口的商品
      const picked = await js(`(function(){
        var bs = Array.from(document.querySelectorAll('#seckillBody input[data-action="pick-seckill"]'));
        bs.forEach(function(b){ if(!b.checked) b.click(); });
        return { total: bs.length, on: bs.filter(function(b){return b.checked;}).length };
      })()`);
      console.log('[ops] 勾选秒杀商品：', JSON.stringify(picked));
      console.log('[ops] 一键开启秒杀：', await click('[data-action="seckill-enable"]'));
      await untilLog('秒杀投放', '批量投放结束', 180000);
      await mark('秒杀 · 开启结果', 18);
      console.log('[ops] 一键停止秒杀：', await click('[data-action="seckill-stopall"]'));
      await untilLog('停止秒杀', '一键停止结束', 180000);
      await mark('秒杀 · 停止结果', 18);
    }

    // 只收尾：把还挂着的秒杀都停掉（不重新投放）
    if (op === 'stopseckill') {
      await nav('goods'); await sleep(400);
      await click('[data-action="fetch-goods"]');
      await until('抓商品', async () => {
        const n = await js(`document.querySelectorAll('#goodsBody input[data-action="pick-goods"]').length`);
        return n > 0 ? n + ' 个商品' : null;
      }, 90000);
      await click('[data-action="seckill-scan"]');
      await until('扫秒杀入口', async () => {
        const n = await js(`document.querySelectorAll('#seckillBody input[data-action="pick-seckill"]').length`);
        return n > 0 ? n + ' 个入口' : null;
      }, 90000);
      const picked = await js(`(function(){
        var bs = Array.from(document.querySelectorAll('#seckillBody input[data-action="pick-seckill"]'));
        bs.forEach(function(b){ if(!b.checked) b.click(); });
        return { total: bs.length, on: bs.filter(function(b){return b.checked;}).length };
      })()`);
      console.log('[ops] 勾选秒杀商品：', JSON.stringify(picked));
      console.log('[ops] 一键停止秒杀：', await click('[data-action="seckill-stopall"]'));
      await untilLog('停止秒杀', '一键停止结束', 180000);
      await mark('秒杀 · 停止结果', 20);
    }

    if (op === 'replenish') {
      await nav('goods'); await sleep(400);
      console.log('[ops] 立即补充一次：', await click('[data-action="seckill-replenish"]'));
      await sleep(20000);
      await mark('剩余自动补充');
    }

    if (op === 'coupon') {
      await nav('coupon'); await sleep(400);
      await click('[data-action="coupon-scan"]');
      await until('扫描券', async () => {
        const n = await js(`document.querySelectorAll('input[data-action="pick-coupon"]').length`);
        return n > 0 ? n + ' 张券' : null;
      }, 90000);
      const rows = await tp('(async()=>{ return await window.__TP.couponPanelRows(); })()');
      console.log('[ops] 扫到的券：', JSON.stringify(rows).slice(0, 300));
      const pick = await js(`(function(){
        var bs = Array.from(document.querySelectorAll('input[data-action="pick-coupon"]'));
        if(!bs.length) return { total: 0 };
        bs.slice(0,1).forEach(function(b){ if(!b.checked) b.click(); });
        return { total: bs.length, picked: bs.filter(function(b){return b.checked;}).length };
      })()`);
      console.log('[ops] 勾选券：', JSON.stringify(pick));
      console.log('[ops] 开始发券：', await click('[data-action="start-coupon"]'));
      // 多轮观察：一直跟到日志出现「已发满 N 次」或超时（默认 7 分钟）
      const t0 = Date.now();
      let done = false;
      while (Date.now() - t0 < 7 * 60000) {
        await sleep(10000);
        const arr = await logs(60);
        const last = Array.isArray(arr) ? arr : [];
        const hits = last.filter((l) => /发券 ·/.test(l));
        if (hits.length) console.log('[ops] ' + hits[hits.length - 1].slice(0, 150));
        if (last.some((l) => /已发满 .* 次，自动结束/.test(l))) { done = true; break; }
      }
      console.log('[ops] 发券观察结束，是否发满：', done, '用时', Math.round((Date.now() - t0) / 1000) + 's');
      await mark('发券结果', 30);
      console.log('[ops] 停止发券：', await click('[data-action="stop-coupon"]'));
      await sleep(3000);
    }

    if (op === 'comment') {
      await nav('comment'); await sleep(400);
      // 保证有一个组、一条评论
      const has = await js(`(function(){ return document.querySelectorAll('.group-card').length; })()`);
      if (!has) { await click('[data-action="new-comment-group"]'); await sleep(800); }
      await js(`(function(){
        var b = document.querySelector('[data-action="select-comment-group"]');
        if (b && !/已选/.test(b.textContent)) b.click();
      })()`);
      await sleep(600);
      await js(`(function(){
        var inputs = document.querySelectorAll('.pair-row input.pair-a');
        if (!inputs.length) { var a = document.querySelector('[data-action="add-comment-item"]'); if (a) a.click(); }
      })()`);
      await sleep(600);
      await js(`(function(){
        var inputs = document.querySelectorAll('.pair-row input.pair-a');
        if (inputs.length) {
          var el = inputs[inputs.length - 1];
          var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(el, '巡洋实操：自动发评自测（可忽略）');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`);
      await sleep(800);
      console.log('[ops] 开始自动发评：', await click('[data-action="start-comment"]'));
      await sleep(25000);
      await mark('自动发评');
      const seen = await tp(`(async()=>{ return await window.__TP.commentItemByText('巡洋实操：自动发评自测（可忽略）'); })()`);
      console.log('[ops] 公屏里能找到这条：', JSON.stringify(seen));
      console.log('[ops] 停止自动发评：', await click('[data-action="stop-comment"]'));
      await sleep(2000);
    }

    if (op === 'popup') {
      await nav('popup'); await sleep(400);
      await js(`(function(){
        var bs = document.querySelectorAll('input[data-action="pick-goods"]');
        if (bs.length && !Array.from(bs).some(function(b){return b.checked;})) bs[0].click();
      })()`);
      await sleep(500);
      console.log('[ops] 开始弹讲解：', await click('[data-action="start-popup"]'));
      await sleep(14000);
      await mark('弹讲解');
      console.log('[ops] 停止弹讲解：', await click('[data-action="stop-popup"]'));
      await sleep(2000);
    }

    if (op === 'pin') {
      await nav('comment'); await sleep(400);
      console.log('[ops] 置顶自检：', await click('[data-action="pin-check"]'));
      await sleep(6000);
      await mark('置顶自检');
    }
  }

  console.log('\n[ops] 全部结束');
  app.exit(0);
}).catch((e) => {
  console.log('[ops] FATAL', (e && e.stack) || e);
  app.exit(2);
});
