const { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const guestApi = require('./guest');

// 任务栏 / 进程名 / 用户数据目录都按这个名字走
app.setName('巡洋战略舰');

// DNS 兼容开关：macOS 27 + Electron 44 下，内置 c-ares 解析抖音后台的
// 多层 CNAME 链（bytedns1.com → cdngslb.com → queniusz.com）会触发
// ares_dns_rr_get_ttl 段错误（SIGTRAP / Trace/BPT trap: 5），整个 NetworkService
// 反复崩溃、应用退出。改用系统 DNS + 关掉异步 DNS 后稳定。
// 必须在 app ready 之前设置才生效。
app.commandLine.appendSwitch('use-system-dns');
app.commandLine.appendSwitch('disable-features', 'AsyncDns');

const IS_MAC = process.platform === 'darwin';

// 配置位置：开发态跟着项目走（data/config.json，换设备带走即可）；
// 打包成 App 后改存用户数据目录（app 包内可能只读 / 重装会丢）。
//
// 判断依据（三种打包形态都要认，缺一种就会把配置写进只读的包内）：
//   macOS 手动打包  .../巡洋战略舰.app/Contents/Resources/app        → 命中 .app/Contents
//   macOS asar 打包 .../巡洋战略舰.app/Contents/Resources/app.asar   → 两个都命中
//   Windows asar     ...\resources\app.asar                          → 命中 app.asar（路径不含 .app/Contents）
// 不用 app.isPackaged：代码直接放 Resources/app、不打 asar 时它返回 false。
const IN_APP = __dirname.includes('.app/Contents') || __dirname.includes('app.asar');
const CONFIG_PATH = IN_APP
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, 'data', 'config.json');
const DATA_DIR = path.dirname(CONFIG_PATH);

let win = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // 打包版首次启动：把随包内置的「出厂默认配置」迁到用户数据目录，
  // 这样换设备装完 App 不用重新绑定选择器。
  //
  // 注意：优先用 config.default.json（干净模板：选择器保留，商品/券/秒杀卡/
  // 评论组/统计全空），不要用开发机上的 config.json —— 那份带着测试数据。
  if (IN_APP) {
    const bundled = path.join(__dirname, 'data', 'config.default.json');
    const legacy = path.join(__dirname, 'data', 'config.json');
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        const from = fs.existsSync(bundled) ? bundled : (fs.existsSync(legacy) ? legacy : null);
        if (from) {
          fs.copyFileSync(from, CONFIG_PATH);
          console.log('[巡洋战略舰] 已迁移出厂配置：' + from + ' → ' + CONFIG_PATH);
        }
      }
    } catch (e) { /* 迁移失败不影响启动 */ }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 700,
    backgroundColor: '#f4f6f9',
    title: '巡洋战略舰',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      // 关键：最小化/遮挡时不节流定时器与渲染 —— 自动任务在后台也能按原节奏跑
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('console-message', (event) => {
    const level = event.level !== undefined ? event.level : 0;
    const isError = level === 'error' || level === 3;
    const isWarn = level === 'warning' || level === 2;
    if (isError || isWarn) {
      console.log(`[renderer:${level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on('preload-error', (_e, p, error) => {
    console.log('[preload-error]', p, error && error.message);
  });

  // 主界面自身的外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 主界面只该停在本地 index.html：任何外部协议（bitbrowser:// 之类）都不许交给系统，
  // 否则 Windows 会弹「需要使用新应用以打开此链接 / 在 Microsoft Store 中查找应用」。
  win.webContents.on('will-navigate', (e, url) => {
    if (/^(https?|file|about|data|blob|devtools):/i.test(url || '')) return;
    e.preventDefault();
    console.log('[main] 已拦截主界面外部协议跳转：', url);
  });

  win.on('closed', () => { win = null; });
}

// 内嵌页面里被拦下的外部协议跳转，回传给界面日志 —— 不然用户只看到"点了没反应"
guestApi.onBlocked((info) => {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('guest:blocked', info); } catch (e) {}
});

// 内嵌页面（webview）一创建就接管：UA、弹窗、导航日志
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
});

// ---------- IPC ----------

ipcMain.handle('app:version', () => {
  try { return app.getVersion(); } catch (e) { return '0.9.0'; }
});

ipcMain.on('app:ready', () => {
  console.log('[巡洋战略舰] 渲染进程就绪');
});

// 内存占用（设置页「内存」区）：按进程列出来，谁吃得多一眼能看到。
// 两个内嵌页面各自是一整个抖音前台（直播页 + WebSocket + 视频），
// 加起来上 GB 是正常的，重点是要能分清是浏览器进程还是某个页面。
ipcMain.handle('mem:info', () => {
  try {
    const pidOf = (name) => {
      try {
        const wc = guestApi.getGuest(name);
        if (!wc || typeof wc.getOSProcessId !== 'function') return null;
        return wc.getOSProcessId();
      } catch (e) { return null; }
    };
    const pids = { 主界面: pidOf('main'), 后台页: pidOf('worker') };
    const list = app.getAppMetrics().map((p) => {
      const mb = Math.round((((p.memory || {}).workingSetSize) || 0) / 1024);
      let name = '';
      Object.keys(pids).forEach((k) => { if (pids[k] && pids[k] === p.pid) name = k; });
      return { type: p.type || '', name: name, pid: p.pid, mb: mb };
    }).sort((a, b) => b.mb - a.mb);
    return { ok: true, list: list, total: list.reduce((s, p) => s + p.mb, 0) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
});

ipcMain.handle('guest:setLib', (_e, src) => guestApi.setLib(src));
ipcMain.handle('guest:call', async (_e, code, target) => {
  const res = await guestApi.runInFrames(code, target);
  return res == null ? { ok: false, reason: 'empty-result' } : res;
});
// 渲染进程创建 webview 后登记：name（main / worker）+ webContentsId
ipcMain.handle('guest:register', (_e, name, id) => guestApi.register(name, id));
ipcMain.handle('guest:names', () => ({ ok: true, names: guestApi.guestNames() }));
ipcMain.handle('guest:probe', (_e, target, sel) => guestApi.runInFrames(
  `(async()=>{ return window.__TP ? window.__TP.probe(${JSON.stringify(sel || '#live-card-list, #current-live-room')}) : { found:false, reason:'no-lib' }; })()`,
  target
));
ipcMain.handle('guest:pickStart', (_e, target) => guestApi.pickStart(target));
ipcMain.handle('guest:pickPoll', (_e, target) => guestApi.pickPoll(target));
ipcMain.handle('guest:pickStop', (_e, target) => guestApi.pickStop(target));
ipcMain.handle('guest:frames', (_e, target) => guestApi.frameInfo(target));
ipcMain.handle('guest:scan', (_e, limit, target) => guestApi.scanAll(limit, target));
// 真实输入事件（isTrusted=true），合成事件在抖音后台只能触发 hover
ipcMain.handle('guest:realClick', (_e, x, y, target) => guestApi.realClick(x, y, target));
ipcMain.handle('guest:realType', (_e, x, y, text, target) => guestApi.realType(x, y, text, target));
ipcMain.handle('guest:realMove', (_e, x, y, target) => guestApi.realMove(x, y, target));
ipcMain.handle('guest:realEnter', (_e, target) => guestApi.realEnter(target));
ipcMain.handle('guest:realKey', (_e, key, times, target) => guestApi.realKey(key, times, target));

// 有自动任务在跑时阻止系统休眠（空闲时自动解除，正常省电）
const powerSaveBlocker = require('electron').powerSaveBlocker;
let psbId = null;
ipcMain.handle('power:busy', (_e, busy) => {
  if (busy && psbId === null) psbId = powerSaveBlocker.start('prevent-app-suspension');
  else if (!busy && psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null; }
  return { ok: true, blocking: psbId !== null };
});

ipcMain.handle('config:load', () => {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { __error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('config:save', (_e, data) => {
  try {
    ensureDataDir();
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('config:path', () => CONFIG_PATH);

ipcMain.handle('log:export', async (_e, text) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const res = await dialog.showSaveDialog(win, {
    title: '导出运行日志',
    defaultPath: path.join(app.getPath('downloads'), `巡洋战略舰-日志-${stamp}.txt`),
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, text, 'utf8');
  return { ok: true, path: res.filePath };
});

// ---------- 菜单 ----------
// macOS 上没有「编辑」菜单，输入框里的 ⌘C / ⌘V / ⌘A 会失效，所以必须建菜单；
// Windows 上保持无菜单栏（autoHideMenuBar + 置空应用菜单）。
function buildMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }

  const sendStop = () => {
    if (win && !win.isDestroyed()) win.webContents.send('engine:emergency-stop');
  };

  const template = [
    { role: 'appMenu' },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '运行',
      submenu: [
        { label: '全部停止', click: sendStop },
        { label: '重新加载界面', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭窗口' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 急停：Windows 用 Ctrl+Shift+F12；macOS 额外认 ⌘+Shift+F12（更符合 mac 习惯）
function registerStopShortcut() {
  const combos = IS_MAC
    ? ['Control+Shift+F12', 'Command+Shift+F12']
    : ['Control+Shift+F12'];
  const ok = [];
  for (const combo of combos) {
    try {
      const done = globalShortcut.register(combo, () => {
        if (win && !win.isDestroyed()) win.webContents.send('engine:emergency-stop');
      });
      if (done) ok.push(combo);
    } catch (e) { /* 组合键被占用，继续试下一个 */ }
  }
  if (ok.length) console.log('[巡洋战略舰] 急停快捷键：' + ok.join(' / '));
  else console.warn('[巡洋战略舰] 紧急停止快捷键注册失败');
  return ok;
}

// ---------- 生命周期 ----------

// 单实例锁：双击两次（或忘了已经开着）会起两个 App —— 两个窗口各自登录同一个抖音后台、
// 各自读写同一份 config.json，用户看到的就是「刚改的设置自己变回去了」「评论发了两遍」。
// 第二次启动直接把已有窗口叫到前面来，不再开新实例。
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ensureDataDir();
    buildMenu();
    createWindow();
    registerStopShortcut();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
