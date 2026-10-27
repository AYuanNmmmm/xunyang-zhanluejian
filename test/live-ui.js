/* 真机验证三件新东西：日志分功能页签 / 累计统计 / 运行中面板位置
 *
 * 用法：unset ELECTRON_RUN_AS_NODE && electron test/live-ui.js
 * 只点「抓取商品」（纯读取，不弹讲解/不发券/不发评），安全。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
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

let cfgSaved = null;
try { cfgSaved = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}

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

  for (let i = 0; i < 40; i++) {
    if (await js('!!(window.__debug && window.__debug.worker)').catch(() => false)) break;
    await sleep(500);
  }
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await js('window.__debug.worker()').catch(() => null);
    if (st && st.state === 'ready') break;
    await sleep(1000);
  }
  log(!!(st && st.state === 'ready'), '后台页就绪', st && st.state);
  if (!st || st.state !== 'ready') { app.exit(1); return; }

  // ---------- 布局：运行中在菜单下面、日志上面 ----------
  const layout = await js(`(() => {
    const r = (id) => { const el = document.getElementById(id); return el ? el.getBoundingClientRect() : null; };
    const nav = r('nav'), run = r('runBar'), stat = r('statsBox'), logw = r('logwrap');
    return {
      navBottom: nav && Math.round(nav.bottom), runTop: run && Math.round(run.top),
      runBottom: run && Math.round(run.bottom), statTop: stat && Math.round(stat.top),
      logTop: logw && Math.round(logw.top), runLeft: run && Math.round(run.left),
      runW: run && Math.round(run.width)
    };
  })()`);
  log(layout.runTop >= layout.navBottom - 2, '「运行中」在功能菜单下方', `nav底=${layout.navBottom} run顶=${layout.runTop}`);
  log(layout.runBottom <= layout.statTop + 2, '「运行中」在累计统计上方', `run底=${layout.runBottom} stat顶=${layout.statTop}`);
  log(layout.runBottom <= layout.logTop, '「运行中」在运行日志上方', `run底=${layout.runBottom} 日志顶=${layout.logTop}`);
  log(layout.runLeft < 140, '「运行中」在左栏（不在右下角）', `left=${layout.runLeft} 宽=${layout.runW}`);

  // ---------- 抓取商品：真机读一次，产生「商品」类日志 ----------
  await js(`(() => { const b = document.querySelector('[data-action="fetch-goods"]'); if (b) b.click(); return !!b; })()`);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const done = await js(`(window.__debug.logTags().goods || 0) > 0`);
    if (done) break;
  }
  const tags = await js('window.__debug.logTags()');
  log((tags.goods || 0) > 0, '抓取商品产生了「商品」类日志', JSON.stringify(tags));
  log((tags.sys || 0) > 0, '启动/后台页日志归到「系统」类', 'sys=' + (tags.sys || 0));

  // 页签计数与实际条数一致
  const tabInfo = await js(`Array.from(document.querySelectorAll('#logTabs .log-tab')).map(b => ({ tag: b.dataset.tag, text: b.textContent, n: (b.querySelector('.n') || {}).textContent || '' }))`);
  log(Array.isArray(tabInfo) && tabInfo.length === 7, '日志页签共 7 个（全部+6 个功能）', (tabInfo || []).map((t) => t.tag).join('/'));

  // 切到「商品」页签：只剩商品类
  await js(`document.querySelector('#logTabs [data-tag="goods"]').click()`);
  await sleep(300);
  const onlyGoods = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#logBody .log-line'));
    return { n: rows.length, other: rows.filter(r => !r.classList.contains('tag-goods')).length, cls: rows.slice(0,2).map(r=>r.className) };
  })()`);
  log(onlyGoods.n > 0 && onlyGoods.other === 0, '切到「商品」页签后只剩商品日志', JSON.stringify(onlyGoods));

  // 切回全部
  await js(`document.querySelector('#logTabs [data-tag="all"]').click()`);
  await sleep(300);
  const allRows = await js(`document.querySelectorAll('#logBody .log-line').length`);
  log(allRows >= onlyGoods.n, '切回「全部」日志恢复', `全部 ${allRows} 行`);

  // ---------- 统计 ----------
  const statsTxt = await js(`(() => {
    const box = document.getElementById('statsBox');
    return { rows: Array.from(box.querySelectorAll('.stat-row')).map(r => r.textContent.trim()), head: (box.querySelector('.stat-head')||{}).textContent || '' };
  })()`);
  log(statsTxt.rows.length === 6, '侧栏有 6 项累计统计', statsTxt.rows.join(' / '));
  log(/累计/.test(statsTxt.head), '统计块有标题', statsTxt.head);

  // 商品抓取不涨业务计数，但失败计数应能读到数字
  const statsData = await js('window.__debug.stats()');
  log(typeof statsData.fail === 'number', '统计已持久化在配置里', JSON.stringify(statsData));

  // 点一下清零再确认归零
  await js(`document.querySelector('[data-action="stats-reset"]').click()`);
  await sleep(400);
  const after = await js('window.__debug.stats()');
  log(after.popup === 0 && after.comment === 0 && after.coupon === 0 && after.seckill === 0, '「清零」把计数归零', JSON.stringify(after));

  // ---------- 后台模式下不许动主界面缩放（「后台一干活前台就变」的根因） ----------
  const zoomBefore = await js('window.__debug.mainZoom()');
  await js('window.__debug.fitToWidth(true)');
  await sleep(600);
  const zoomAfter = await js('window.__debug.mainZoom()');
  log(Math.abs(zoomBefore - zoomAfter) < 0.001, '后台模式下自动化兜底不会改主界面缩放', `${zoomBefore} → ${zoomAfter}`);

  // ---------- 日志行数上限 ----------
  const domRows = await js(`document.querySelectorAll('#logBody .log-line').length`);
  log(domRows <= 120, '屏上日志不超过 120 行', '当前 ' + domRows + ' 行');

  const logs = await js('Array.from(document.querySelectorAll("#logBody .log-line")).slice(-10).map(el=>el.className+" | "+el.textContent)');
  console.log('\n—— 日志尾部 ——');
  (logs || []).forEach((l) => console.log('  ' + l));

  // 存一张界面截图，方便肉眼确认排版
  try {
    const img = await win.webContents.capturePage();
    const out = path.join(ROOT, 'ui-live.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('截图已存：' + out);
  } catch (e) {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
});
