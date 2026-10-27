/* 只读探测：worker 后台页能不能读到评论区条目（自动回复依赖它）
 *   env -u ELECTRON_RUN_AS_NODE ELECTRON_DISABLE_SANDBOX=1 \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/reply-probe.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-reply-probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

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
  `(async()=>{ return window.__TP ? window.__TP.probe(${JSON.stringify(sel || '#live-card-list, #current-live-room')}) : { found:false, reason:'no-lib' }; })()`, target));
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
  await win.loadFile(SRC);
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => 'ERR:' + e.message);
  await sleep(2500);

  // 等后台页就绪
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await js('window.__debug ? window.__debug.worker() : null');
    if (st && (st.state === 'ready' || st.state === 'failed')) break;
    await sleep(2000);
  }
  console.log('[probe] 后台页状态：', JSON.stringify(st));

  const sel = cfg.selectors;
  // 分别探测 main 和 worker 页面能否读到评论条目
  for (const tgt of ['main', 'worker']) {
    const r = await guestApi.runInFrames(`(async()=>{
      try {
        const items = document.querySelectorAll(${JSON.stringify(sel.commentItem)});
        const cont = document.querySelector('#comment_all_tab_list_container');
        const input = document.querySelector(${JSON.stringify(sel.commentInput.split('\n')[0])});
        const arr = Array.from(items).slice(0, 5).map(function(el){ return String(el.textContent||'').replace(/\\s+/g,' ').slice(0,40); });
        return { ok:true, count: items.length, hasContainer: !!cont, hasInput: !!input, sample: arr };
      } catch (e) { return { ok:false, err: String(e&&e.message||e) }; }
    })()`, tgt).catch((e) => ({ err: String(e.message) }));
    console.log(`[probe] ${tgt} 评论区：`, JSON.stringify(r).slice(0, 500));
  }

  // worker 页面 readList 实测
  const list = await guestApi.runInFrames(`(async()=>{
    return await window.__TP.readList(${JSON.stringify(sel.commentItem)}, ${JSON.stringify(sel.commentText)}, ${JSON.stringify(sel.commentUser)}, 30);
  })()`, 'worker').catch((e) => ({ err: String(e.message) }));
  console.log('[probe] worker readList：', JSON.stringify(list).slice(0, 800));

  app.exit(0);
}).catch((e) => { console.log('[probe] FATAL', (e && e.stack) || e); app.exit(2); });
