/* 抓抖音本地生活后台（eos.douyin.com 直播中控台）的真实接口
 *
 * 目的：判断能不能像「光圈」那样——不开页面、直接调接口完成讲解/发评/发券/秒杀。
 * 做法：开一个隐藏页面（复用登录态）→ CDP 打开 Network 域 → 记录页面自己发出的所有请求
 *       → 再用页面内 fetch 复放其中一个查询接口，验证「不靠签名也能调用」。
 *
 * 只读，不点任何按钮、不提交任何写操作。
 *
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/api-probe.js
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
// 复用登录态
fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
const srcP = path.join(REAL_UD, 'Partitions', 'douyin');
const dstP = path.join(TMP_UD, 'Partitions', 'douyin');
if (fs.existsSync(srcP) && !fs.existsSync(dstP)) {
  require('node:child_process').execFileSync('cp', ['-R', srcP, dstP]);
  console.log('[api] 已复制登录态');
}

const HOST = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}
webview{display:inline-flex;width:1600px;height:1200px;border:0}</style></head><body>
<webview id="v" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
</body></html>`;
const HOST_PATH = path.join(TMP_UD, 'api-host.html');
fs.writeFileSync(HOST_PATH, HOST, 'utf8');

const SKIP = /\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)(\?|$)/i;
const NOISE = /(monitor|log|report|track|collect|metrics|sentry|slardar|tea|abtest|mcs|webcast_|byteimg|bytedance\.com\/api\/v1\/|verify|risk|passport)/i;

function short(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch (e) { return String(u).slice(0, 120); }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  await win.loadFile(HOST_PATH);
  await sleep(2500);

  const { webContents } = require('electron');
  const wv = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')[0];
  if (!wv) { console.log('[api] ❌ 没有 webview'); app.exit(1); return; }

  const reqs = [];
  try {
    wv.debugger.attach('1.3');
    await wv.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024 });
    wv.debugger.on('message', (_e, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const r = params.request || {};
        reqs.push({
          id: params.requestId,
          url: r.url,
          method: r.method,
          type: params.type,
          postData: r.postData || '',
          headers: r.headers || {},
          t: Date.now()
        });
      }
    });
    console.log('[api] Network 已开启，等待页面把请求发完…');
  } catch (e) {
    console.log('[api] debugger attach 失败：', e && e.message);
    app.exit(1); return;
  }

  // 等页面加载+首屏接口发完
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const probe = await wv.mainFrame.executeJavaScript(
      '({ has: !!document.querySelector("#live-card-list, #current-live-room"), href: location.href })', true
    ).catch(() => null);
    if (probe && probe.has) { console.log('[api] 中控台已就绪'); break; }
  }
  await sleep(6000);   // 再等一轮懒加载接口

  // 汇总
  const api = reqs.filter((r) => (r.type === 'XHR' || r.type === 'Fetch') && !SKIP.test(r.url) && !NOISE.test(r.url));
  console.log(`\n[api] 抓到 ${reqs.length} 个请求，其中业务接口 ${api.length} 个\n`);

  // 按 path 归并，打印 GET/POST 与 body 摘要
  const seenKey = new Set();
  const rows = [];
  for (const r of api) {
    const key = r.method + ' ' + short(r.url);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    rows.push(r);
  }
  rows.sort((a, b) => a.url.localeCompare(b.url));
  rows.forEach((r) => {
    const body = String(r.postData || '').replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ${r.method.padEnd(4)} ${short(r.url)}`);
    if (body) console.log(`       body: ${body}`);
  });

  fs.writeFileSync(path.join(TMP_UD, 'api-requests.json'), JSON.stringify(api, null, 2));
  console.log('\n[api] 完整清单已存：', path.join(TMP_UD, 'api-requests.json'));

  // ---- 复放验证：把 /data/life/live/ 下的接口全部用页面内 fetch 再打一遍 ----
  // 目的：确认「只要登录态（cookie）就能调通」，不需要 X-Bogus / a_bogus 之类的签名参数。
  const cands = rows.filter((r) => /\/data\/life\/live\//.test(r.url) || /\/data\/life\//.test(r.url));
  console.log(`\n[api] 开始复放 ${cands.length} 个业务接口…\n`);
  const results = [];
  for (const r of cands) {
    const code = `(async () => {
      const init = { method: ${JSON.stringify(r.method)}, credentials: 'include', headers: { 'accept': 'application/json, text/plain, */*' } };
      ${r.postData ? `init.headers['content-type'] = 'application/json'; init.body = ${JSON.stringify(r.postData)};` : ''}
      try {
        const res = await fetch(${JSON.stringify(r.url)}, init);
        const txt = await res.text();
        let json = null;
        try { json = JSON.parse(txt); } catch (e) {}
        let msg = '';
        if (json) msg = String(json.msg || json.message || (json.data && (json.data.msg || json.data.message)) || '');
        const sc = json ? (json.status_code != null ? json.status_code : (json.code != null ? json.code : '')) : '';
        return { ok: true, http: res.status, code: sc, msg: msg, len: txt.length, head: txt.slice(0, 160) };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    })()`;
    const out = await wv.mainFrame.executeJavaScript(code, true).catch((e) => ({ ok: false, reason: String(e.message) }));
    results.push({ req: r, out: out });
    const okSign = out && out.ok && out.http === 200 && !/(签名|sign|denied|forbidden|登录|not login|unauthorized|token)/i.test(String(out.msg || ''));
    console.log(`  ${okSign ? '✅' : '⚠️ '} ${r.method} ${short(r.url)}  HTTP=${out && out.http} code=${out && out.code} ${out && out.msg ? 'msg=' + out.msg : ''}`);
    if (out && out.head) console.log(`       ${String(out.head).replace(/\s+/g, ' ').slice(0, 130)}`);
  }
  const good = results.filter((x) => x.out && x.out.ok && x.out.http === 200).length;
  console.log(`\n[api] 复放结果：${good}/${results.length} 个接口只靠 cookie 就能调通`);

  // ---- 看 CSRF / 签名相关的 cookie ----
  const cookies = await wv.session.cookies.get({ domain: '.douyin.com' }).catch(() => []);
  const names = cookies.map((c) => c.name);
  const interesting = names.filter((n) => /csrf|xsrf|token|sid|session|passport|ttwid|msToken|s_v_web/i.test(n));
  console.log('\n[api] 关键 cookie：', interesting.join(', ') || '(无)');
  console.log('[api] cookie 总数：', cookies.length);

  console.log('\n[api] 结论要点：');
  console.log('  1) 上面列出的接口 = 后台真实调用的地址；写操作（讲解/发评/发券/秒杀）会在你点一次按钮时出现');
  console.log('  2) 复放测试 status=200 且返回 JSON → 说明可以完全不打开页面直接调接口');
  app.exit(0);
});
