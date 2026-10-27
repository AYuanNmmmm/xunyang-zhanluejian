// 临时脚本：用假商品渲染「商品」页，截图确认 A 档重构后的按钮布局（不连直播间）
// 用法：unset ELECTRON_RUN_AS_NODE && npx electron --no-sandbox test/shot-goods.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');

const goods = [
  { i: 1, name: '【双人票】水上烟花光影秀+打铁花+河灯', goodsId: '371928847102', cardId: '7720' },
  { i: 2, name: '【亲子票】1大1小 夜场通票', goodsId: '371928847103', cardId: '7721' },
  { i: 3, name: '【夜游茶船】双人 含茶点', goodsId: '371928847104', cardId: '7722' },
  { i: 4, name: '【单人票】日游 含萌宠互动', goodsId: '371928847105', cardId: '7723' },
  { i: 5, name: '【国庆限定】烟花观景位', goodsId: '371928847106', cardId: '7724' }
];

const cfg = {
  version: 5,
  goods: { list: goods, autoRefresh: true, refreshSec: 300, pickedAt: '21:40' },
  popup: { selected: [1, 2, 3], mode: 'keep', keep: { refreshSec: 6, offMs: 600 } },
  coupon: { list: [] },
  seckill: { cards: [1, 2], mode: 'sched' },
  comment: { groups: [] },
  stats: { popup: 3, comment: 0, coupon: 0, seckill: 0, refresh: 1, fail: 0 },
  lastSync: { at: '21:39', goods: 5, seckills: 2, coupons: 4, detectGood: 12, detectTotal: 14 },
  selectors: {}, engine: { mode: 'background' }, sched: {}, humanize: {},
  api: { goods: true, switchCard: true, keepAlive: true, drawerYield: true },
  data: { autoRefresh: true, refreshSec: 10, lastAt: '', hideZero: false },
  account: {}, sites: []
};

ipcMain.handle('config:load', () => cfg);
ipcMain.handle('config:save', () => ({ ok: true }));
ipcMain.handle('config:path', () => '');
ipcMain.handle('app:version', () => '0.10.3');
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: false }));
ipcMain.handle('guest:names', () => ({ ok: true, names: [] }));
ipcMain.handle('guest:frames', () => ({ ok: true, frames: 0 }));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1580, height: 980, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true, backgroundThrottling: false
    }
  });
  await w.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 3200));

  const info = await w.webContents.executeJavaScript(`
    (() => {
      for (let i = 0; i < 20000; i++) { clearInterval(i); clearTimeout(i); }
      const nav = document.querySelector('.nav-item[data-tab="goods"]');
      if (nav) nav.click();
      const rows = document.querySelectorAll('#goodsBody .goods-row').length;
      const wrap = document.querySelector('#panel');
      return JSON.stringify({
        rows,
        panelW: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
        overflowX: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
        btns: Array.from(document.querySelectorAll('.nav-item')).length
      });
    })()
  `);
  console.log('商品页测量：', info);

  w.showInactive();
  w.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 800));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'preview-goods.png'), img.toPNG());
  console.log('已生成 preview-goods.png');
  app.quit();
});
