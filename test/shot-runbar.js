/* 运行栏排版检查：伪造 4 个功能在跑，截图看右下角浮层是否完整显示 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('config:load', () => ({
  version: 5,
  site: 'https://eos.douyin.com/livesite/live/current',
  engine: { mode: 'background', prewarm: false },
  goods: { list: [{ i: 1, name: '测试商品A' }, { i: 2, name: '测试商品B' }], pickedAt: '17:20', autoRefresh: false },
  popup: { selected: [1], mode: 'seq', showSec: 15, hideSec: 4, rounds: 0 },
  coupon: { list: [], selected: [], count: 10, durationMin: 1, times: 3, intervalSec: 60 },
  view: { zoom: 1, favZoom: 0.7, fit: false }
}));
ipcMain.handle('config:save', () => ({ ok: true }));
ipcMain.handle('config:path', () => 'test/config.json');
ipcMain.handle('app:version', () => '0.9.9');
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', () => ({ ok: true, size: 1 }));
ipcMain.handle('guest:call', () => ({ ok: false, reason: 'mock' }));
ipcMain.handle('guest:register', () => ({ ok: true }));
ipcMain.handle('guest:probe', () => ({ found: false }));
ipcMain.handle('guest:names', () => ({ ok: true, names: [] }));
ipcMain.handle('guest:frames', () => ({ ok: true, frames: 1, items: [] }));
ipcMain.handle('guest:scan', () => ({ ok: true, count: 0, items: [] }));
ipcMain.handle('guest:pickStart', () => ({ ok: true }));
ipcMain.handle('guest:pickPoll', () => ({ ok: true, picking: false }));
ipcMain.handle('guest:pickStop', () => ({ ok: true }));
ipcMain.handle('guest:realClick', () => ({ ok: false }));
ipcMain.handle('guest:realType', () => ({ ok: false }));
ipcMain.handle('guest:realMove', () => ({ ok: false }));
ipcMain.handle('guest:realEnter', () => ({ ok: false }));
ipcMain.handle('guest:realKey', () => ({ ok: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await sleep(2500);
  const js = (c) => win.webContents.executeJavaScript(c, true).catch((e) => 'ERR:' + e.message);
  await js(`document.querySelector('.nav-item[data-tab="coupon"]').click()`);
  await sleep(400);
  await js(`window.__debug.setRunning(['popup','comment','coupon','seckill'])`);
  await sleep(600);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'runbar-4on.png'), img.toPNG());
  const box = await js(`(() => { const b = document.getElementById('runBar'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), sw: b.scrollWidth, sh: b.scrollHeight, cw: b.clientWidth, ch: b.clientHeight, overflow: b.scrollHeight > b.clientHeight }; })()`);
  console.log('[shot] 浮层尺寸：', JSON.stringify(box));
  app.exit(0);
}).catch((e) => { console.log('FATAL', e && e.stack); app.exit(2); });
