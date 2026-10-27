/* 真机验证：后台页刷新时，主界面到底有没有被带着刷？
 *
 * 用法（Windows / macOS 都可）：unset ELECTRON_RUN_AS_NODE && electron test/live-refresh.js
 *
 * 会开一个真实窗口、真实登录态（沿用系统 userData 里的 persist:douyin），
 * 等后台页就绪后主动触发一次「后台页刷新」，全程统计主界面的加载次数与地址。
 * 只观察、不点击业务按钮，不会发券/发评论。
 */
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

let cfgSaved = null;
try { cfgSaved = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}

// 不覆盖 userData：直接沿用真实登录态（persist:douyin 就在系统 userData 下）
ipcMain.handle('config:load', () => cfgSaved);
ipcMain.handle('config:save', (_e, d) => { cfgSaved = d; return { ok: true }; });
ipcMain.handle('config:path', () => path.join(ROOT, 'data', 'config.json'));
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('app:version', () => '0.9.9');
ipcMain.handle('guest:setLib', (_e, s) => guestApi.setLib(s));
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
ipcMain.handle('guest:realType', (_e, x, y, s, t) => guestApi.realType(x, y, s, t));
ipcMain.handle('guest:realMove', (_e, x, y, t) => guestApi.realMove(x, y, t));
ipcMain.handle('guest:realEnter', (_e, t) => guestApi.realEnter(t));
ipcMain.handle('guest:realKey', (_e, k, n, t) => guestApi.realKey(k, n, t));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1580, height: 980, show: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true, spellcheck: false, backgroundThrottling: false
    }
  });
  win.loadFile(SRC);

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 等页面里的 __debug 就位
  for (let i = 0; i < 40; i++) {
    const ok = await js('!!(window.__debug && window.__debug.worker)').catch(() => false);
    if (ok) break;
    await sleep(500);
  }

  // 等后台页就绪（登录态在系统 userData 里；没登录会一直 loading，最多等 90 秒）
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await js('window.__debug.worker()').catch(() => null);
    if (st && st.state === 'ready') break;
    if (i % 10 === 0) console.log(`… 后台页状态：${st && st.state} ${st && st.reason ? '(' + st.reason + ')' : ''}`);
    await sleep(1000);
  }
  log(!!(st && st.state === 'ready'), '后台页就绪', JSON.stringify(st));
  if (!st || st.state !== 'ready') {
    console.log('后台页没起来（多半是没登录/没开播），这次验证中止');
    app.exit(1);
    return;
  }

  const ids0 = await js('window.__debug.pageIds()');
  const urls0 = await js('window.__debug.pageUrls()');
  const mainContents = webContents.fromId(ids0.main);
  const workerContents = webContents.fromId(ids0.worker);
  log(!!mainContents && !!workerContents, '拿到两个 webContents', JSON.stringify(ids0));
  log(ids0.main !== ids0.worker, '主界面与后台页是两个独立 webContents');

  let mainLoads = 0;
  let workerLoads = 0;
  const mainUrlLog = [];
  mainContents.on('did-start-loading', () => { mainLoads++; });
  mainContents.on('did-navigate', (_e, url) => mainUrlLog.push(url));
  workerContents.on('did-start-loading', () => { workerLoads++; });

  await sleep(1200);
  const base = { main: mainLoads, worker: workerLoads };
  console.log(`基线：主界面加载 ${base.main} 次 / 后台页加载 ${base.worker} 次`);

  // 触发一次「后台页刷新」
  await js('window.__debug.workerRefresh()');
  console.log('已触发后台页刷新，等待恢复…');

  // 等后台页回来
  let back = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    back = await js('window.__debug.worker()').catch(() => null);
    if (back && back.state === 'ready') break;
  }
  await sleep(1500);

  const ids1 = await js('window.__debug.pageIds()');
  const urls1 = await js('window.__debug.pageUrls()');

  log(workerLoads - base.worker >= 1, '后台页确实重新加载了', `worker ${base.worker} → ${workerLoads}`);
  log(mainLoads === base.main, '主界面没有跟着重新加载', `main ${base.main} → ${mainLoads}`);
  log((urls0.main || '') === (urls1.main || ''), '主界面地址没变', `${String(urls0.main).slice(0, 60)}`);
  log(ids1.main === ids0.main, '主界面 webContents 没被换掉', `${ids0.main} → ${ids1.main}`);
  log(mainUrlLog.length === 0, '主界面期间没有任何导航', mainUrlLog.slice(-3).join(' | ') || '无');

  const logs = await js('Array.from(document.querySelectorAll("#logBody .log-line")).slice(-14).map(el=>el.textContent)');
  console.log('\n—— 界面日志尾部 ——');
  (logs || []).forEach((l) => console.log('  ' + l));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
});
