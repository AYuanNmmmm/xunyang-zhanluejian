// 用 Electron 自身把 build/icon.svg 渲染成 1024x1024 PNG（macOS 上 qlmanage 往往不出图）
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SRC = path.join(__dirname, '..', 'build', 'icon.svg');
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:1024px;height:1024px}
  </style></head><body>${svg.replace(/^<\?xml[^>]*>/, '')}</body></html>`;

  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log('已生成 ' + OUT + '  ' + JSON.stringify(img.getSize()));
  app.exit(0);
});
