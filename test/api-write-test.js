/* 验证：在页面上下文里直接 fetch 调用「写」接口，签名（a_bogus）会不会自动补上
 *
 * 背景：抓包发现 POST /data/life/live/comment/reply/ 的 URL 带 a_bogus + msToken 签名。
 * 如果页面自己的 fetch/XHR 被 SDK 包装过，那么在页面里 fetch 就会自动签名 →
 * 那我们就能「不打开可见页面、纯请求」完成发评论/讲解/发券。
 *
 * 只发一条测试评论（内容：接口复放测试，请忽略）
 *
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-write-test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-api-userdata';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
try {
  require('node:child_process').execFileSync('rm', ['-rf', path.join(TMP_UD, 'Partitions', 'douyin')]);
  require('node:child_process').execFileSync('cp', ['-R', path.join(REAL_UD, 'Partitions', 'douyin'), path.join(TMP_UD, 'Partitions', 'douyin')]);
} catch (e) {}

const HOST_PATH = path.join(TMP_UD, 'wr-host.html');
fs.writeFileSync(HOST_PATH, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0}webview{display:inline-flex;width:1600px;height:1200px;border:0}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`, 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await win.loadFile(HOST_PATH);
  await sleep(2500);
  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { console.log('[wr] 没有 webview'); app.exit(1); return; }

  await wv.debugger.attach('1.3').catch(() => {});
  const run = async (code) => {
    try { return await wv.mainFrame.executeJavaScript(code, true); }
    catch (e) { return { err: String(e && e.message || e) }; }
  };

  for (let i = 0; i < 20; i++) {
    const p = await run('(async()=>{ const b=document.body?document.body.textContent:""; return { cards: document.querySelectorAll("#live-card-list div[role=\\"button\\"][aria-label]").length, live: /直播中|结束直播/.test(b), href: location.href }; })()');
    if (p && p.cards > 0) { console.log('[wr] 页面就绪：', JSON.stringify(p)); break; }
    await sleep(1500);
  }
  await sleep(3000);

  // ---- 0. 先看签名函数在不在 ----
  const env = await run(`(async()=>{
    const keys = Object.keys(window).filter((k) => /acrawler|bogus|sign|secsdk|byted|bdms|msToken|csrf/i.test(k));
    const info = {};
    keys.slice(0, 40).forEach((k) => {
      let t = typeof window[k];
      if (t === 'function') t = 'function/' + (window[k].name || '');
      info[k] = String(t).slice(0, 40);
    });
    return {
      fetchPatched: String(window.fetch).indexOf('[native code]') < 0,
      xhrPatched: String(window.XMLHttpRequest.prototype.open).indexOf('[native code]') < 0,
      keys: info,
      hasAcrawler: !!window.byted_acrawler || !!window._$b || !!window.__acrawler,
      cookie: document.cookie.split(';').map((s) => s.trim().split('=')[0]).join(',')
    };
  })()`);
  console.log('\n[wr] 环境探测：');
  console.log('  fetch 被包装：', env && env.fetchPatched);
  console.log('  XHR.open 被包装：', env && env.xhrPatched);
  console.log('  签名相关全局：', JSON.stringify(env && env.keys));
  console.log('  cookie 名：', env && env.cookie);

  // ---- 1. 读 room_id / user_id（从页面接口拿，别写死） ----
  const ids = await run(`(async()=>{
    // room_id 在页面接口里出现过；这里从 config 或 DOM 里兜
    let room = '';
    try {
      const m = (document.documentElement.innerHTML || '').match(/"room_id"\\s*:\\s*"?(\\d{10,})/);
      if (m) room = m[1];
    } catch (e) {}
    if (!room) {
      try {
        const r = await fetch('/data/life/live/data/live_data/v3/', { credentials: 'include' });
        const j = await r.json();
        room = String(j.room_id || (j.data && j.data.room_id) || '');
      } catch (e) {}
    }
    return { room: room };
  })()`);
  console.log('\n[wr] room_id 探测：', JSON.stringify(ids));

  const ROOM = (ids && ids.room) || '7699322213992106786';
  const USER = 'MS4wLjABAAAAPNfbSWM4-Q-ck1BDayGjTvDjFrS4yTUUvrveHpLdEpU';   // 抓包得到的（本账号）

  // ---- 2. 页面内 fetch 发评论（不带任何签名参数，看会不会被自动补上） ----
  const body = { room_id: ROOM, user_id: USER, comment_content: '接口复放测试，请忽略', nickname: '', origin_msg_content: '', origin_msg_id: '' };
  const r1 = await run(`(async () => {
    try {
      const res = await fetch('/data/life/live/comment/reply/', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(body)})
      });
      const txt = await res.text();
      return { ok: true, http: res.status, txt: txt.slice(0, 300) };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  console.log('\n[wr] 页面内 fetch 发评论（不手动加签名）：');
  console.log('  ', JSON.stringify(r1).slice(0, 400));

  // ---- 3. 抓一下这条请求实际发出去的 URL（看有没有自动补 a_bogus） ----
  const captured = [];
  wv.debugger.on('message', (_e, method, params) => {
    if (method === 'Network.requestWillBeSent' && /comment\/reply/.test(params.request.url)) {
      captured.push(params.request.url);
    }
  });
  await wv.debugger.sendCommand('Network.enable', {});

  const r2 = await run(`(async () => {
    try {
      const res = await fetch('/data/life/live/comment/reply/', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(Object.assign({}, body, { comment_content: '接口复放测试二，请忽略' }))})
      });
      const txt = await res.text();
      return { ok: true, http: res.status, txt: txt.slice(0, 300) };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  await sleep(1500);
  console.log('\n[wr] 第二次 fetch：', JSON.stringify(r2).slice(0, 300));
  if (captured.length) {
    const u = captured[captured.length - 1];
    console.log('  实际发出 URL 是否含 a_bogus：', /a_bogus=/.test(u), ' 含 msToken：', /msToken=/.test(u));
    console.log('  URL 片段：', u.slice(0, 180));
  } else {
    console.log('  （没抓到请求，可能被拦截器改写或走了别的通道）');
  }

  // ---- 4. 用 XHR 再试一次（有些 SDK 只包 XHR） ----
  const r3 = await run(`(async () => {
    return await new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open('POST', '/data/life/live/comment/reply/', true);
        x.setRequestHeader('content-type', 'application/json');
        x.withCredentials = true;
        x.onload = () => resolve({ ok: true, http: x.status, txt: String(x.responseText || '').slice(0, 240) });
        x.onerror = () => resolve({ ok: false, err: 'xhr-error' });
        x.send(JSON.stringify(${JSON.stringify(Object.assign({}, body, { comment_content: '接口复放测试三，请忽略' }))}));
      } catch (e) { resolve({ ok: false, err: String(e && e.message || e) }); }
    });
  })()`);
  console.log('\n[wr] XHR 发评论：', JSON.stringify(r3).slice(0, 300));

  console.log('\n[wr] 判读：');
  console.log('  · 返回 code:0 / chat_id 存在 → 页面内请求会自动签名，可以纯接口发评论');
  console.log('  · 返回 verify/签名/风控错误 → 写接口需要专门签名，只能走页面点击（隐藏页兜底）');
  app.exit(0);
});
