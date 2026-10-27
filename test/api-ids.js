/* 探测 room_id / user_id 的可靠来源（接口化发评论需要它们）
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-ids.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const LOG = '/tmp/tp-ids.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch (e) {} };
fs.writeFileSync(LOG, '');

function libSrc() {
  const h = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = h.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

const HOST_PATH = path.join(TMP_UD, 'ids-host.html');
fs.writeFileSync(HOST_PATH, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}webview{display:inline-flex;width:1600px;height:1200px;border:0}</style></head><body>
<webview id="v" src="https://eos.douyin.com/livesite/live/current" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`, 'utf8');
const lib = libSrc();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(HOST_PATH);
  await sleep(2500);
  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { log('no webview'); app.exit(1); return; }
  const run = (code, ms) => Promise.race([wv.mainFrame.executeJavaScript(code, true).catch((e) => ({ err: String(e.message) })), new Promise((r) => setTimeout(() => r({ err: 'timeout' }), ms || 9000))]);

  for (let i = 0; i < 24; i++) {
    const p = await run('(async()=>{ return { ok:true, cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length }; })()', 5000);
    if (p && p.cards > 0) { log('商品卡 ' + p.cards); break; }
    await sleep(1500);
  }
  await sleep(3000);

  // ⑥ 先装监听（短任务），回 Node 侧等 10 秒再取，避开页面跳转打断长任务
  await run(`(() => {
    window.__CAP = [];
    const push = (u) => { if (window.__CAP.length < 600) window.__CAP.push(String(u)); };
    const rawFetch = window.fetch;
    window.fetch = function (a) { push(typeof a === 'string' ? a : (a && a.url)); return rawFetch.apply(this, arguments); };
    const rawWS = window.WebSocket;
    const WS = function (u, p) { push('WSS ' + u); return new rawWS(u, p); };
    WS.prototype = rawWS.prototype;
    Object.defineProperty(window, 'WebSocket', { value: WS, configurable: true, writable: true });
    const rawOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { push('XHR ' + u); return rawOpen.apply(this, arguments); };
    const rawSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (b) { push('BODY ' + String(b).slice(0, 300)); return rawSend.apply(this, arguments); };
    return true;
  })()`, 8000);
  log('监听已装，采集 10 秒…');
  await sleep(10000);
  const cap = await run(`(() => {
    const urls = window.__CAP || [];
    const hit = (re) => urls.filter((s) => re.test(s)).slice(0, 6).map((s) => s.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 220));
    const all = urls.join('|');
    const mr = all.match(/room_?id[=:"']+(\\d{10,})/i);
    const mr2 = all.match(/(\\d{15,})/);
    return {
      total: urls.length,
      roomId: mr ? mr[1] : '',
      roomIdUrls: hit(/room_?id/i),
      wsUrls: hit(/^WSS /),
      bigNum: mr2 ? mr2[1] : '',
      sample: urls.slice(0, 30).map((s) => s.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0])
    };
  })()`, 8000);
  log('\n===== 请求监听 =====');
  log(JSON.stringify(cap, null, 2).slice(0, 4000));

  const out = await run(`(async () => {
    const res = {};
    // ① 从 localStorage / sessionStorage 里找 room_id
    const scanStore = (st, name) => {
      const hits = [];
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i);
          const v = String(st.getItem(k) || '');
          if (/room_?id/i.test(k) || /"room_?id"\\s*:/.test(v)) hits.push({ store: name, key: k, val: v.slice(0, 160) });
        }
      } catch (e) {}
      return hits.slice(0, 8);
    };
    res.store = scanStore(localStorage, 'local').concat(scanStore(sessionStorage, 'session'));

    // ② 常见全局状态
    const globals = ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__NEXT_DATA__', '__APP_STATE__'];
    res.globals = globals.map((g) => ({ name: g, exists: !!window[g] })).filter((x) => x.exists);

    // ③ 从接口拿：live_data / notify / flash_sale
    const tryApi = async (u, pick) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const j = await r.json();
        return pick(j);
      } catch (e) { return { err: String(e && e.message || e) }; }
    };
    res.liveData = await tryApi('/data/life/live/data/live_data/v3/', (j) => {
      const keys = Object.keys(j || {});
      return { keys: keys.slice(0, 24), room: j.room_id || (j.data && j.data.room_id) || (j.base_info && j.base_info.room_id) || '' };
    });
    res.flash = await tryApi('/data/life/live/flash_sale/config/', (j) => {
      const m = JSON.stringify(j || {}).match(/room_id=?(\\d{10,})/);
      const map = (j && j.groupon_url_map) || {};
      const first = Object.values(map)[0] || '';
      const m2 = String(first).match(/room_id=(\\d{10,})/);
      return { room: (m && m[1]) || (m2 && m2[1]) || '', sample: String(first).slice(0, 140) };
    });

    // ④ DOM 里搜 room_id 字样
    const html = document.documentElement.innerHTML || '';
    const m = html.match(/"room_?id"\\s*:\\s*"?(\\d{12,})/);
    res.dom = m ? m[1] : '';

    // ⑤ user_id：从 cookie 或 localStorage
    const ck = document.cookie;
    res.cookieUser = (ck.match(/has_biz_token=([^;]+)/) || [])[1] || '';
    const uid = html.match(/"(?:user_?id|sec_?uid)"\\s*:\\s*"([A-Za-z0-9_\\-]{10,})"/);
    res.domUser = uid ? uid[1] : '';

    // ⑦ DOM 里的直播间链接
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).filter((h) => /live\.douyin\.com\/\d{6,}/.test(h));
    res.links = links.slice(0, 5);

    return res;
  })()`, 20000);

  log('\n===== 探测结果 =====');
  log(JSON.stringify(out, null, 2).slice(0, 4000));
  app.exit(0);
});
