/* 真机验证：接口直发一条公屏评论，并在公屏里确认它真的出现了
 *
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/live-say.js
 *   第二个参数可自定义内容，例：... test/live-say.js "hello"
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
// 注意：Electron 的 process.argv 里会混入 --disable-gpu 这类开关，只取不是开关的那个
const TEXT = process.argv.slice(2).find((a) => a && a.charAt(0) !== '-') || '巡洋实操：接口发评自测（可忽略）';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}
app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

const HOST_PATH = path.join(TMP_UD, 'say-host.html');
fs.writeFileSync(HOST_PATH, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}webview{display:inline-flex;width:1600px;height:1200px;border:0;opacity:0.01}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`, 'utf8');
const lib = loadLibSrc();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(HOST_PATH);
  await sleep(2500);
  const { webContents } = require('electron');
  let wv = null;
  for (let i = 0; i < 20 && !wv; i++) {
    wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
    if (!wv) await sleep(1000);
  }
  if (!wv) { console.log('no webview'); app.exit(1); return; }
  const run = (code, ms) => Promise.race([
    wv.mainFrame.executeJavaScript(code, true).catch((e) => ({ err: String((e && e.message) || e) })),
    new Promise((r) => setTimeout(() => r({ err: 'timeout' }), ms || 15000))
  ]);

  // 等中控台就绪
  for (let i = 0; i < 30; i++) {
    const p = await run('(async()=>{ return { cards: document.querySelectorAll(\'#live-card-list div[role="button"][aria-label]\').length }; })()', 6000);
    if (p && p.cards > 0) { console.log('[say] 中控台就绪，商品卡', p.cards); break; }
    await sleep(1500);
  }
  // 注入库（并让它把 XHR/fetch 听筒装上）
  await run(lib, 8000);
  await sleep(1200);

  // 抓这条请求实际发出去的 URL（看签名有没有自动补）
  const sent = [];
  try {
    wv.debugger.attach('1.3');
    wv.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent' && /comment\/reply/.test(params.request.url)) {
        sent.push(params.request.method + ' ' + params.request.url);
      }
    });
    await wv.debugger.sendCommand('Network.enable', {});
  } catch (e) { console.log('[say] CDP 附加失败：', String(e.message || e)); }

  const ids = await run('(async()=>{ return await window.__TP.apiIds(); })()', 15000);
  console.log('\n[say] 识别到的 id：', JSON.stringify(ids));

  const t0 = Date.now();
  const r = await run(`(async()=>{ return await window.__TP.apiComment(${JSON.stringify(TEXT)}); })()`, 20000);
  console.log('[say] 发评结果（' + (Date.now() - t0) + 'ms）：', JSON.stringify(r));
  if (sent.length) {
    const u = sent[sent.length - 1];
    console.log('[say] 实际请求：', u.slice(0, 160));
    console.log('[say] 自动补签名：a_bogus=' + /a_bogus=/.test(u) + ' msToken=' + /msToken=/.test(u));
  }
  if (!r || !r.ok) { app.exit(1); return; }

  // 等 3 秒，去公屏里找这条内容
  await sleep(3000);
  const found = await run(`(async()=>{
    const hit = await window.__TP.commentItemByText(${JSON.stringify(TEXT)});
    const last = await window.__TP.commentLastItem();
    return { hit: hit, last: last };
  })()`, 15000);
  console.log('[say] 公屏里能找到这条：', JSON.stringify(found && found.hit));
  console.log('[say] 公屏最后一条：', JSON.stringify(found && found.last && found.last.text));
  app.exit(0);
});
