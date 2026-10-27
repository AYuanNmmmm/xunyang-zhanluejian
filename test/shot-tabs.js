/* 界面截图（每个 tab 一张）
 * 用 mocked IPC 起一个不显示的真实窗口，切到每个 tab 截图，然后退出。
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox test/shot-tabs.js
 * 产物：shots/<tab>.png
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假商品数据，模拟真实后台抓取结果
const GOODS = [
  { i: 1, name: '【抖音直售】LIT NOW 成都说唱之夜', goodsId: '1879006658123804', aria: '1879006658123804--7696418892688313111-7' },
  { i: 2, name: '谭咏麟与您「刻骨铭心」巡回演唱会终极篇-成都站', goodsId: '7688961100972312605', aria: '7688961100972312605--7688972693094992675-7' },
  { i: 3, name: '林忆莲《回响：终章》2026巡回演唱会-成都站', goodsId: '7681555913698543662', aria: '7681555913698543662--7681566779415563042-7' },
  { i: 4, name: '马思唯-乐透人生 The Lottery TOUR 巡回演唱会-成都成就梦想特别场', goodsId: '7686244743092668451', aria: '7686244743092668451--7686375414670854938-7' }
];

let savedCfg = null;
ipcMain.handle('config:load', () => ({
  version: 2,
  site: 'https://eos.douyin.com/livesite/live/current',
  goods: { list: GOODS, pickedAt: '11:07', autoRefresh: true, refreshSec: 90 },
  popup: { selected: [1, 3], mode: 'seq', showSec: 15, hideSec: 4, rounds: 0, timeFrom: '', timeTo: '' },
  coupon: { name: '', count: 5, times: 0, intervalSec: 300, timeFrom: '', timeTo: '' }
}));
ipcMain.handle('config:save', (_e, d) => { savedCfg = d; return { ok: true }; });
ipcMain.handle('app:version', () => '0.9.9');
ipcMain.handle('config:path', () => 'test/config.json');
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', () => ({ ok: true, size: 1 }));
ipcMain.handle('guest:call', () => ({ ok: true }));
ipcMain.handle('guest:pickStart', () => ({ ok: true, frames: 1 }));
ipcMain.handle('guest:pickPoll', () => ({ ok: true, picking: false, picked: null }));
ipcMain.handle('guest:pickStop', () => ({ ok: true }));
ipcMain.handle('guest:frames', () => ({ ok: true, count: 1, frames: [{ index: 0, main: true, url: 'stub' }] }));
ipcMain.handle('guest:scan', () => ({ ok: true, frames: 1, count: 0, items: [] }));

app.setName('巡洋战略舰');
app.setPath('userData', path.join(__dirname, '.ui-test-userdata'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(900);

  const tabs = ['goods', 'popup', 'comment', 'coupon', 'settings'];
  await win.webContents.executeJavaScript(`window.__err = null; window.addEventListener('error', (e) => { window.__err = String(e.message) + ' @' + e.filename + ':' + e.lineno; }); 1`);
  for (const t of tabs) {
    await win.webContents.executeJavaScript(`
      (() => {
        const b = document.querySelector('.nav-item[data-tab="${t}"]');
        if (b) b.click();
        return !!b;
      })()
    `);
    await sleep(450);
    const err = await win.webContents.executeJavaScript('window.__err');
    if (err) console.log('  ⚠️ 页面报错: ' + err);
    const title = await win.webContents.executeJavaScript(
      `(document.querySelector('#panel h3')||{}).textContent || '(no h3)'`
    );
    console.log('  panel h3 = ' + title);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${t}.png`), img.toPNG());
    console.log('已截图 ' + t + '.png');

    // 弹讲解页额外截一张「一直弹（单卡常驻）」形态
    if (t === 'popup') {
      await win.webContents.executeJavaScript(`
        (() => {
          const s = document.querySelector('select[data-bind="popup.mode"]');
          if (!s) return false;
          s.value = 'keep';
          s.dispatchEvent(new Event('input', { bubbles: true }));
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()
      `);
      await sleep(500);
      const img2 = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'popup-keep.png'), img2.toPNG());
      console.log('已截图 popup-keep.png');
    }
  }

  console.log('完成，产物在 shots/');
  app.exit(0);
});
