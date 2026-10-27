/* 验证「后台工作页」：自动化在看不见的页面里跑，主界面完全不受影响
 *
 * 判据（硬证据）：
 *   ① 后台页能起来并读到中控台结构
 *   ② 在后台页跑一次最重的「抓商品」（会把整个商品列表滚到底），主界面的滚动位置/URL 一点没变
 *   ③ 主界面此时仍然正常可读（用户能继续用）
 *   ④ 后台页和主界面的滚动的确是各自独立的
 *
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/worker-test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-worker-userdata';
const LOG = '/tmp/tp-worker.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(l);
  try { fs.appendFileSync(LOG, l + '\n'); } catch (e) {}
};
fs.writeFileSync(LOG, '');

let pass = 0; let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; log(`PASS  ${name}${extra ? '  → ' + extra : ''}`); }
  else { fail++; log(`FAIL  ${name}${extra ? '  → ' + extra : ''}`); }
};

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

// 用真实登录态（复制一份，不动原 profile）
app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) { log('[worker] 复制登录态失败：' + (e.message || e)); }

// app 需要的 IPC
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}
cfg = cfg || {};
cfg.engine = { mode: 'background', prewarm: true };
cfg.sched = cfg.sched || { humanYield: true, humanYieldSec: 3, stepYieldMs: 260 };

ipcMain.handle('config:load', () => cfg);
ipcMain.handle('config:save', (_e, d) => { cfg = d; return { ok: true }; });
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
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false }
  });
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message} (${String(src || '').slice(-40)}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer] gone:', JSON.stringify(d)));
  await win.loadFile(SRC);
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => 'ERR:' + e.message);
  await sleep(2500);

  // 诊断：先看主进程里登记了哪些页面
  log('[worker] 已登记页面：' + JSON.stringify(guestApi.guestNames()));

  // 等后台页就绪
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await js('window.__debug ? window.__debug.worker() : null');
    if (st && st.state === 'ready') break;
    if (st && st.state === 'failed') break;
    await sleep(2000);
  }
  // 把界面日志打出来（里面有后台页的启动过程/失败原因）
  const safe = (x) => { try { return JSON.stringify(x === undefined ? null : x); } catch (e) { return String(x); } };
  const uiLogs = await js('Array.from(document.querySelectorAll("#logBody .log-line")).slice(-12).map(function(el){return el.textContent;})');
  if (Array.isArray(uiLogs)) uiLogs.forEach((l) => log('   ui | ' + String(l).slice(0, 150)));
  else log('   ui | (读不到界面日志) ' + String(uiLogs).slice(0, 120));

  log('[worker] 状态：' + safe(st));
  log('[worker] 已登记页面（等待后）：' + safe(guestApi.guestNames()));

  const pDirect = await guestApi.runInFrames("(async()=>{ return window.__TP.probe('#live-card-list, #current-live-room'); })()", 'worker').catch((e) => ({ err: String(e.message) }));
  log('[worker] 主进程直调 probe(worker)：' + safe(pDirect));

  const pLib = await guestApi.runInFrames("(async()=>{ return { ok:true, hasTP: !!window.__TP, ver: window.__TP && window.__TP.version }; })()", 'worker').catch((e) => ({ err: String(e.message) }));
  log('[worker] 后台页 tp-lib：' + safe(pLib));

  const pMain = await guestApi.runInFrames("(async()=>{ return window.__TP.probe('#live-card-list, #current-live-room'); })()", 'main').catch((e) => ({ err: String(e.message) }));
  log('[worker] 主进程直调 probe(main)：' + safe(pMain));

  ok(!!st && st.state === 'ready', '后台工作页能起来', st && (st.url || st.reason));
  ok(!!st && st.target === 'worker', '自动化默认路由到后台页', st && st.target);

  if (!st || st.state !== 'ready') {
    log(`\n结果：${pass} 通过 / ${fail} 失败`);
    app.exit(1); return;
  }

  // 后台页能读到中控台结构
  const wp = await js('window.__debug.workerRun("(async()=>{ return window.__TP.probe(\'#live-card-list, #current-live-room\'); })()")');
  ok(!!(wp && wp.found), '后台页里能读到中控台结构', wp && `${wp.tag} ${wp.rect}`);

  // ④ 两个页面的滚动互相独立：主界面（内嵌 webview）先滚到一个位置，再看后台页干活时它会不会跟着动
  const mainRun = (code) => js(`document.getElementById('view').executeJavaScript(${JSON.stringify(code)}, true)`);
  await mainRun('window.scrollTo(0, 300); ({ y: window.scrollY })');
  await sleep(500);
  const mainBefore = await mainRun('({ y: window.scrollY, url: location.href, cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length })');
  log('[worker] 主界面（前）：' + JSON.stringify(mainBefore));

  // 在后台页跑最重的动作：抓商品（会滚动整个列表）
  const t0 = Date.now();
  const goods = await js('window.__debug.workerRun("(async()=>{ return await window.__TP.goodsList({rounds:5, waitMs:500}); })()")');
  const cost = Date.now() - t0;
  ok(!!(goods && goods.ok) && (goods.items || []).length > 0, '后台页能抓到商品', `${(goods && goods.items || []).length} 个 / ${cost}ms`);

  const workerScroll = await js('window.__debug.workerRun("(async()=>{ return { y: window.scrollY, sy: (document.scrollingElement||{}).scrollTop }; })()")');
  const mainAfter = await mainRun('({ y: window.scrollY, url: location.href, cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length })');
  log('[worker] 主界面（后）：' + JSON.stringify(mainAfter) + ' 后台页滚动：' + JSON.stringify(workerScroll));

  ok(mainAfter && mainBefore && mainAfter.y === mainBefore.y, '主界面的滚动位置一点没变', `${mainBefore.y} → ${mainAfter && mainAfter.y}`);
  ok(mainAfter && mainBefore && mainAfter.url === mainBefore.url, '主界面的地址没变', mainAfter && mainAfter.url);
  ok(!!(mainAfter && mainAfter.cards > 0), '主界面仍能正常读到结构（用户可以继续用）', mainAfter && `${mainAfter.cards} 张卡`);

  // 主界面自己在滚动时，不影响后台页
  await mainRun('window.scrollTo(0, 560); ({ y: window.scrollY })');
  await sleep(500);
  const wp2 = await js('window.__debug.workerRun("(async()=>{ return window.__TP.probe(\'#live-card-list\'); })()")');
  ok(!!(wp2 && wp2.found), '用户在主界面滚动时后台页照常工作', wp2 && wp2.tag);

  // ---- 接口化发评论（不碰画面） ----
  const ids = await js('window.__debug.workerRun("(async()=>{ return await window.__TP.apiIds(); })()")');
  log('[worker] 接口所需的 id：' + JSON.stringify(ids));
  ok(!!(ids && ids.roomId), '能自动识别 room_id', ids && ids.roomId);

  const apiR = await js('window.__debug.workerRun("(async()=>{ return await window.__TP.apiComment(\'接口化测试，请忽略\'); })()")');
  log('[worker] 接口发评结果：' + JSON.stringify(apiR).slice(0, 300));
  ok(!!(apiR && apiR.ok), '能用接口直接发评论（不操作画面）', apiR && (apiR.chatId || apiR.reason));

  const stats = await js('window.__debug.sched()');
  ok(!!stats && stats.overlap && stats.overlap.maxDepth <= 1, '周期内页面操作仍然严格串行', stats && JSON.stringify(stats.overlap));

  // ---- 适宽：路由到后台页时，主界面的「适宽」也必须照常生效 ----
  // 中控台在测试窗口里刚好铺满（1008=1008）看不出缩放，所以先换成一个 1600px 固定宽的页面
  const zf = (sel) => js(`(function(){ try { return document.querySelector(${JSON.stringify(sel)}).getZoomFactor(); } catch(e){ return -1; } })()`);
  await js(`document.getElementById('view').loadURL(${JSON.stringify('file://' + path.join(__dirname, 'wide.html'))})`);
  await sleep(2500);
  await js('document.getElementById("zoomLabel").click()');   // 先归到 100%
  await sleep(800);
  const zBefore = Number(await zf('#view'));
  await js('document.getElementById("zoomFit").click()');
  await sleep(1500);
  const zAfter = Number(await zf('#view'));
  const zWorker = Number(await zf('#workerHost webview'));
  const fitOn = await js('document.getElementById("zoomFit").classList.contains("on")');
  log('[worker] 适宽：' + JSON.stringify({ zBefore, zAfter, zWorker, fitOn }));
  ok(fitOn === true && zAfter > 0 && zAfter < 1 && Math.abs(zAfter - zBefore) > 0.01,
    '路由到后台页时「适宽」仍然生效（主界面真的被缩小到能看全）',
    `${Math.round(zBefore * 100)}% → ${Math.round(zAfter * 100)}%`);
  ok(zWorker === 1 || zWorker === -1, '后台页缩放固定 1.0，不受主界面缩放影响', String(zWorker));

  // ---- 后台页刷新：只动后台页，主界面的 URL / 滚动 / 缩放一点都不能变 ----
  const mainBefore0 = await mainRun('({ url: location.href, y: window.scrollY })');
  const zMainBefore = Number(await zf('#view'));
  await js('(async () => { await window.__debug.workerRestart(); })()');
  for (let i = 0; i < 30; i++) {
    const s = await js('window.__debug.worker()');
    if (s && s.state === 'ready') break;
    await sleep(1500);
  }
  await sleep(1500);
  const mainAfter0 = await mainRun('({ url: location.href, y: window.scrollY })');
  const zMainAfter = Number(await zf('#view'));
  const stAfter = await js('window.__debug.worker()');
  log('[worker] 重建后台页后：' + JSON.stringify({ mainBefore0, mainAfter0, zMainBefore, zMainAfter, st: stAfter && stAfter.state }));
  ok(!!(stAfter && stAfter.state === 'ready'), '后台页能重建并恢复就绪', stAfter && stAfter.state);
  ok(mainAfter0 && mainBefore0 && mainAfter0.url === mainBefore0.url, '重建后台页不会导航主界面', mainAfter0 && mainAfter0.url);
  ok(mainAfter0 && mainBefore0 && mainAfter0.y === mainBefore0.y, '重建后台页不会滚动主界面', `${mainBefore0.y} → ${mainAfter0 && mainAfter0.y}`);
  ok(Math.abs(zMainAfter - zMainBefore) < 0.01, '重建后台页不会把主界面缩放冲回 100%', `${Math.round(zMainBefore * 100)}% → ${Math.round(zMainAfter * 100)}%`);

  log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.log('[worker] FATAL', (e && e.stack) || e);
  app.exit(2);
});
