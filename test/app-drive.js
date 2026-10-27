/* 驱动真实应用界面跑功能，回收日志（只读，不真提交/不真发券）
 * 用途：复现「点了没反应」，看清日志里的失败原因
 * 运行：ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *   ./node_modules/.bin/electron --no-sandbox --disable-gpu test/app-drive.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-live-userdata';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}
function prepareUserData() {
  fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
  const src = path.join(REAL_UD, 'Partitions', 'douyin');
  const dst = path.join(TMP_UD, 'Partitions', 'douyin');
  if (fs.existsSync(src) && !fs.existsSync(dst)) require('node:child_process').execFileSync('cp', ['-R', src, dst]);
}
app.setPath('userData', TMP_UD);
prepareUserData();

// 用真实配置（含 zoom=0.7 适宽），才能复现缩放下的坐标问题
let cfgSaved = null;
try { cfgSaved = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}
ipcMain.handle('config:load', () => cfgSaved);
ipcMain.handle('config:save', (_e, d) => { cfgSaved = d; return { ok: true }; });
ipcMain.handle('config:path', () => path.join(TMP_UD, 'config.json'));
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', (_e, src) => guestApi.setLib(src));
ipcMain.handle('guest:call', async (_e, code) => guestApi.runInFrames(code));
ipcMain.handle('guest:frames', () => guestApi.frameInfo());
ipcMain.handle('guest:scan', (_e, n) => guestApi.scanAll(n));
ipcMain.handle('guest:pickStart', () => guestApi.pickStart());
ipcMain.handle('guest:pickPoll', () => guestApi.pickPoll());
ipcMain.handle('guest:pickStop', () => guestApi.pickStop());
ipcMain.handle('guest:realClick', (_e, x, y) => guestApi.realClick(x, y));
ipcMain.handle('guest:realType', (_e, x, y, t) => guestApi.realType(x, y, t));
ipcMain.handle('guest:realMove', (_e, x, y) => guestApi.realMove(x, y));
ipcMain.handle('guest:realEnter', () => guestApi.realEnter());
ipcMain.handle('guest:realKey', (_e, k, n) => guestApi.realKey(k, n));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
  guestApi.setLib(loadLibSrc());
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  await win.loadFile(SRC);
  await sleep(1500);
  let t = 0;
  while (!guestApi.getGuest() && t < 60) { await sleep(300); t++; }
  await sleep(10000);

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => 'ERR:' + e.message);
  const logs = async () => {
    const arr = await js('Array.from(document.querySelectorAll("#logBody .log-line")).map(function(el){return el.className.replace("log-line ","")+" | "+el.textContent;})');
    return Array.isArray(arr) ? arr : [];
  };
  const mark = async (label) => {
    const l = await logs();
    console.log(`\n----- ${label}（累计 ${l.length} 行）-----`);
    l.slice(-14).forEach((x) => console.log('  ' + x));
  };

  console.log('[drive] 标题:', await js('document.getElementById("pageTitle").textContent'));
  console.log('[drive] 缩放:', await js('document.getElementById("view").getZoomFactor ? document.getElementById("view").getZoomFactor() : "?"'));
  console.log('[drive] 页面尺寸:', JSON.stringify(await guestApi.runInFrames('(async()=>({ iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth }))()')));
  await mark('启动');

  // 1) 抓取商品
  await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
  await sleep(300);
  await js('document.querySelector(\'[data-action="fetch-goods"]\').click()');
  await sleep(9000);
  await mark('抓取商品');

  // 2) 弹讲解（选第一个商品，跑几秒就停）
  await js('document.querySelector(\'.nav-item[data-tab="popup"]\').click()');
  await sleep(300);
  await js(`(() => {
    const boxes = document.querySelectorAll('[data-action="pick-goods"]');
    if (boxes.length && !Array.from(boxes).some(b => b.checked)) boxes[0].click();
  })()`);
  await sleep(400);
  await js('document.querySelector(\'[data-action="start-popup"]\').click()');
  await sleep(12000);
  await js('document.querySelector(\'[data-action="stop-popup"]\').click()');
  await sleep(1500);
  await mark('弹讲解');

  // 2.5 秒杀（按配置的投放方式走一遍：开抽屉 → 切方式 → 重读表单 → 选时长/时间 → 填库存，不提交）
  await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
  await sleep(400);
  const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
  const forceMode = String(process.env.DIAG_MODE || '').trim();
  if (forceMode === 'sched' || forceMode === 'now') cfgSaved.seckill.mode = forceMode;
  const wantMode = (cfgSaved && cfgSaved.seckill && cfgSaved.seckill.mode) === 'sched' ? 'sched' : 'now';
  const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]';
  const btnSel = '[class*="seckill-btn-container"]';
  const loc = await tpCall(`(async()=>{ return await window.__TP.locateIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`);
  console.log('\n[drive] 配置投放方式:', wantMode, '| 定位入口:', JSON.stringify(loc));
  if (loc && loc.ok) console.log('[drive] 坐标点击:', JSON.stringify(await js(`window.tp.realClick(${loc.x}, ${loc.y})`)));
  await sleep(3000);
  let form = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
  if (!form || !form.ok) {
    console.log('[drive] 坐标点击没开，DOM 兜底:', JSON.stringify(await tpCall(`(async()=>{ return await window.__TP.clickIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`)));
    await sleep(3500);
    form = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
  }
  console.log('[drive] 打开时:', JSON.stringify({ ok: form && form.ok, mode: form && form.mode }));
  if (form && form.ok) {
    // 切投放方式（照 enableOne：切完必须重读表单拿新坐标）
    if (form.mode !== wantMode) {
      const mp = wantMode === 'sched' ? form.points.sched : form.points.now;
      if (mp) {
        await js(`window.tp.realClick(${mp.x}, ${mp.y})`);
        await sleep(900);
        form = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
      }
    }
    console.log('[drive] 切后:', JSON.stringify({ mode: form && form.mode, hasDur10: !!(form && form.points && form.points.dur10), hasTime: !!(form && form.points && form.points.timeStart) }));
    const dump = await tpCall('(async()=>{ return await window.__TP.seckillDump(); })()');
    fs.writeFileSync('/tmp/skdump.json', JSON.stringify(dump, null, 2));
    console.log('[drive] 抽屉 labels:', (dump && dump.labels || []).map((l) => l.t + (l.checked ? '*' : '')).join(' | '));
    console.log('[drive] 抽屉 spans:', (dump && dump.spans || []).map((x) => x.t).join(' | '));
    // 轮询看时长/时间坐标什么时候出现（判断是不是渲染延迟）
    for (let i = 0; i < 8; i++) {
      const f = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
      console.log(`[drive] 轮询#${i}:`, JSON.stringify({ mode: f && f.mode, dur10: !!(f && f.points && f.points.dur10), time: !!(f && f.points && f.points.timeStart), submit: !!(f && f.points && f.points.submit) }));
      if (f && f.points && (f.points.dur10 || f.points.timeStart)) break;
      await sleep(600);
    }

    if (wantMode === 'sched') {
      const p2 = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const fmt = (x) => `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())} ${p2(x.getHours())}:${p2(x.getMinutes())}`;
      const sTime = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0));
      const eTime = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0));
      const pick = await tpCall(`(async()=>{ return await window.__TP.seckillPickRange(${JSON.stringify(sTime)}, ${JSON.stringify(eTime)}); })()`);
      console.log('[drive] 日历点选（当天 00:00~23:59）:', JSON.stringify(pick).slice(0, 240));
    } else {
      const dp = form.points && form.points.dur10;
      console.log('[drive] 点 10 分钟档:', JSON.stringify(dp ? await js(`window.tp.realClick(${dp.x}, ${dp.y})`) : 'no-point'));
      await sleep(700);
    }
    await tpCall('(async()=>{ return await window.__TP.seckillSetNum(0, 5); })()');
    await sleep(450);
    await tpCall('(async()=>{ return await window.__TP.seckillSetNum(1, 1); })()');
    await sleep(700);
    const f3 = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
    console.log('[drive] 填完:', JSON.stringify({ stock: f3 && f3.stockValue, limit: f3 && f3.limitValue, activeDur: f3 && f3.activeDur, submitDisabled: f3 && f3.submitDisabled }));
    await js('window.tp.realKey("Escape")');
    await sleep(800);
  }
  await mark('秒杀（只到提交前一步）');

  await js('document.querySelector(\'.nav-item[data-tab="selectors"]\').click()');
  await sleep(300);
  await js('document.querySelector(\'[data-action="auto-detect"]\').click()');
  await sleep(3000);
  await mark('一键分析');

  // 4) 扫券
  await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
  await sleep(300);
  await js('document.querySelector(\'[data-action="coupon-scan"]\').click()');
  await sleep(5000);
  await mark('扫券');

  console.log('\n[drive] 结束');
  app.exit(0);
});
