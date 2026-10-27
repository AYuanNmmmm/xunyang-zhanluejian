/* 隔离实验：后台页刷新时，主界面会不会被带着一起刷？
 *
 * 背景：用户反馈「后台刷新时前台页面也一起刷新」。两种可能：
 *   A) Electron 层面两个 webview 共用渲染进程 / 缩放，worker.reload() 波及 main
 *   B) 应用代码里刷错了页面
 * 本实验只测 A：两个 webview 同 partition、同站点，只 reload worker，数 main 的加载次数。
 *
 * 运行：electron test/two-page-isolation.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const ROOT = path.join(__dirname);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); res.end('nope'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
        res.end(buf);
      });
    });
    srv.listen(8907, '127.0.0.1', () => resolve(srv));
  });
}

app.whenReady().then(async () => {
  const srv = await serve();
  const URL_FIX = 'http://127.0.0.1:8907/fixture.html';

  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: { offscreen: true, webviewTag: true, contextIsolation: false, nodeIntegration: true }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <body style="margin:0">
      <div id="host" style="position:relative;width:1100px;height:700px"></div>
      <script>
        const mk = (id) => {
          const wv = document.createElement('webview');
          wv.id = id;
          wv.setAttribute('partition', 'persist:iso-test');
          wv.setAttribute('webpreferences', 'backgroundThrottling=false');
          wv.setAttribute('src', ${JSON.stringify(URL_FIX)});
          document.getElementById('host').appendChild(wv);
          return wv;
        };
        window.mainWv = mk('mainWv');
        window.workerWv = mk('workerWv');
      </script>
    </body>`));

  const { webContents } = require('electron');
  const mainWv = await win.webContents.executeJavaScript('window.mainWv.id');
  const ids = await win.webContents.executeJavaScript(`(async () => {
    const wait = (wv) => new Promise((r) => wv.addEventListener('dom-ready', () => r(wv.getWebContentsId()), { once: true }));
    const a = await wait(window.mainWv);
    const b = await wait(window.workerWv);
    return { main: a, worker: b };
  })()`);
  log(!!ids.main && !!ids.worker, '两个 webview 都已就绪', JSON.stringify(ids));

  // 计数器挂在主进程侧，统计每个 webContents 的加载次数
  const loads = { main: 0, worker: 0 };
  const mainContents = webContents.fromId(ids.main);
  const workerContents = webContents.fromId(ids.worker);
  mainContents.on('did-start-loading', () => { loads.main++; });
  workerContents.on('did-start-loading', () => { loads.worker++; });

  await sleep(1500);
  const base = { main: loads.main, worker: loads.worker };
  log(loads.main >= 0, '计数基线', `main=${base.main} worker=${base.worker}`);

  // ① 只刷后台页
  workerContents.reload();
  await sleep(2500);
  log(loads.worker - base.worker >= 1, '后台页确实刷新了', `worker ${base.worker} → ${loads.worker}`);
  log(loads.main === base.main, '后台刷新没有带动主界面刷新', `main ${base.main} → ${loads.main}`);

  // ② 后台页设缩放，看主界面缩放会不会被改（zoom 是 per-origin 的，可能串）
  const before = mainContents.getZoomFactor();
  try { workerContents.setZoomFactor(1); } catch (e) {}
  await sleep(600);
  const after = mainContents.getZoomFactor();
  log(Math.abs(before - after) < 0.001, '后台页改缩放到 1.0 不影响主界面缩放', `${before} → ${after}`);

  // ③ 后台页 reload 时，主界面 URL 是否被改写
  const mainUrlBefore = mainContents.getURL();
  workerContents.reload();
  await sleep(2000);
  log(mainContents.getURL() === mainUrlBefore, '后台刷新没有改写主界面地址', mainContents.getURL());

  // ④ 关键：后台页渲染进程崩掉时，主界面会不会被一起带走
  //    （同 partition + 同站点时 Chromium 可能复用渲染进程 —— 这才是「后台刷新，前台也刷」的真凶）
  const mainPid = mainContents.getOSProcessId();
  const workerPid = workerContents.getOSProcessId();
  log(mainPid !== workerPid, '后台页与主界面不在同一个渲染进程', `main pid=${mainPid} worker pid=${workerPid}`);

  const mainCrashed = [];
  mainContents.on('render-process-gone', (_e, d) => mainCrashed.push(d && d.reason));
  const beforeCrash = loads.main;
  try { workerContents.forcefullyCrashRenderer(); } catch (e) { console.log('崩溃注入失败：' + e.message); }
  await sleep(2500);
  log(mainCrashed.length === 0, '后台页崩溃没有波及主界面', mainCrashed.length ? '主界面被带崩：' + JSON.stringify(mainCrashed) : '主界面安然无恙');
  log(loads.main === beforeCrash, '后台页崩溃后主界面没有重新加载', `main ${beforeCrash} → ${loads.main}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  srv.close();
  app.exit(fail ? 1 : 0);
});
