/* 可行性验证：能不能再开一个「后台中控台页面」，和主界面互不干扰
 *
 * 背景：现在所有功能共用主界面那一个内嵌页面，所以必须排队、还会滚动画面上真人看到的列表。
 * 如果抖音后台允许同一账号同时开两个中控台标签页（不互踢），就可以做到：
 *   主界面 = 人看的，后台页 = 机器人干活，两边完全隔离。
 *
 * 本脚本只做只读探测，不会点任何按钮、不会提交任何东西。
 *
 * 运行：
 *   ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/.bin/electron --no-sandbox --disable-gpu test/bg-page.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-bg-userdata';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

function prepareUserData() {
  fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
  const src = path.join(REAL_UD, 'Partitions', 'douyin');
  const dst = path.join(TMP_UD, 'Partitions', 'douyin');
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    require('node:child_process').execFileSync('cp', ['-R', src, dst]);
    console.log('[bg] 已复制登录态：', dst);
  } else if (fs.existsSync(dst)) {
    console.log('[bg] 复用已有测试登录态：', dst);
  } else {
    console.log('[bg] 没找到登录态，可能需要先手动登录一次');
  }
}
app.setName('巡洋战略舰');
app.setPath('userData', TMP_UD);
prepareUserData();

// 一个最小的宿主页：两个 webview（主 + 后台），后台那个用 opacity 藏起来但保留真实尺寸
const HOST = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#fff;overflow:hidden}
  #wrap{position:relative;width:100%;height:100%}
  webview{display:inline-flex;background:#fff}
  #main{position:absolute;left:0;top:0;width:1200px;height:820px;border:0}
  /* 后台页：给足 1600x1200 的真实尺寸（中控台是 1600 宽固定布局），
     只是被主界面盖住 + 透明，用户看不见，但渲染/命中测试都正常 */
  #bg{position:absolute;left:0;top:0;width:1600px;height:1200px;border:0;opacity:0.01;pointer-events:none;z-index:0}
  #main{z-index:1}
</style></head><body>
  <div id="wrap">
    <webview id="bg" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
    <webview id="main" src="${URL_LIVE}" partition="persist:douyin" webpreferences="backgroundThrottling=false"></webview>
  </div>
</body></html>`;

const HOST_PATH = path.join(TMP_UD, 'bg-host.html');
fs.writeFileSync(HOST_PATH, HOST, 'utf8');

const lib = loadLibSrc();

// 直接对某个 webContents 执行注入库 + 代码（主 frame 优先，找不到再下钻 iframe）
async function runIn(contents, code) {
  if (!contents || contents.isDestroyed()) return { ok: false, reason: 'gone' };
  const collect = (frame, out = [], depth = 0) => {
    if (!frame || depth > 8) return out;
    out.push(frame);
    let kids = [];
    try { kids = frame.frames || []; } catch (e) { kids = []; }
    for (const k of kids) collect(k, out, depth + 1);
    return out;
  };
  let frames = [];
  try { frames = collect(contents.mainFrame); } catch (e) { frames = []; }
  let last = null;
  for (const f of frames) {
    try { await f.executeJavaScript(lib, false); } catch (e) { continue; }
    try {
      const r = await f.executeJavaScript(code, true);
      const miss = r == null || (typeof r === 'object' && (r.found === false || r.ok === false));
      if (!miss) return r;
      last = r;
    } catch (e) { last = { ok: false, reason: String(e && e.message || e) }; }
  }
  return last;
}

function findWebviewContents(win, id) {
  const all = require('electron').webContents.getAllWebContents().filter((c) => c.getType() === 'webview');
  return all.find((c) => String(c.getURL() || '').indexOf('//eos.douyin.com') >= 0 && c.__slot === id) || all.find((c) => c.__slot === id);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });

  // 给每个 webview 打标记，方便从 webContents 列表里认出来
  const seen = [];
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    seen.push(contents);
  });

  await win.loadFile(HOST_PATH);
  await sleep(1500);

  // 宿主页里按顺序创建：先 #bg 再 #main
  const { webContents } = require('electron');
  const all = webContents.getAllWebContents().filter((c) => c.getType() === 'webview');
  const bg = all[0] || seen[0];
  const mainC = all[1] || seen[1];
  console.log('[bg] webview 数量：', all.length);
  if (!bg || !mainC) { console.log('[bg] ❌ 没拿到两个 webview'); app.exit(1); return; }

  const waitReady = async (c, label) => {
    for (let i = 0; i < 40; i++) {
      const p = await runIn(c, '(async()=>{ return window.__TP ? window.__TP.probe("#live-card-list, #current-live-room") : {found:false}; })()');
      if (p && p.found) { console.log(`[bg] ${label} 就绪（第 ${i * 2}s）`); return true; }
      await sleep(2000);
    }
    return false;
  };

  const bgOk = await waitReady(bg, '后台页');
  const mainOk = await waitReady(mainC, '主页面');
  console.log(`[bg] 后台页读到中控台结构：${bgOk}；主页面读到：${mainOk}`);

  const urlOf = (c) => { try { return c.getURL(); } catch (e) { return ''; } };
  console.log('[bg] 后台页 URL：', urlOf(bg));
  console.log('[bg] 主页面 URL：', urlOf(mainC));

  // 检查有没有「已在其他设备/页面登录」这类提示
  const kickText = async (c, label) => {
    const r = await runIn(c, `(async()=>{
      const t = (document.body && document.body.textContent || '').replace(/\\s+/g,' ').slice(0, 4000);
      const hit = t.match(/(其他设备|其他页面|其它设备|其它页面|已在别处|下线|重复登录|重新登录)/g) || [];
      return { ok: true, hits: hit, head: t.slice(0, 120) };
    })()`);
    console.log(`[bg] ${label} 互踢提示：`, JSON.stringify(r && r.hits), '|', r && r.head);
    return r;
  };
  await kickText(bg, '后台页');
  await kickText(mainC, '主页面');

  // 后台页跑一次「抓商品」——这是最重的读取动作（会滚动整个商品列表）
  const bgGoods = await runIn(bg, '(async()=>{ return await window.__TP.goodsList({rounds:4, waitMs:600}); })()');
  console.log('[bg] 后台页抓商品：', bgGoods && bgGoods.ok, '数量=', bgGoods && (bgGoods.items || []).length,
    (bgGoods && bgGoods.items || []).slice(0, 3).map((x) => `#${x.i} ${x.name}`).join(' / '));

  // 主页面此时的状态（1）还能不能读到结构 （2）被没被踢
  await sleep(2000);
  const mainAfter = await runIn(mainC, '(async()=>{ return window.__TP.probe("#live-card-list, #current-live-room"); })()');
  console.log('[bg] 后台页干完活后，主页面仍能读到结构：', !!(mainAfter && mainAfter.found));
  await kickText(mainC, '主页面(2)');

  // 反过来：主页面抓一次，后台页是否还在
  const mainGoods = await runIn(mainC, '(async()=>{ return await window.__TP.goodsList({rounds:2, waitMs:400}); })()');
  console.log('[bg] 主页面抓商品：', mainGoods && mainGoods.ok, '数量=', mainGoods && (mainGoods.items || []).length);
  const bgAfter = await runIn(bg, '(async()=>{ return window.__TP.probe("#live-card-list, #current-live-room"); })()');
  console.log('[bg] 主页面干完活后，后台页仍能读到结构：', !!(bgAfter && bgAfter.found));

  // 观察 20 秒，看会不会延迟互踢
  console.log('[bg] 持续观察 20 秒…');
  for (let i = 0; i < 4; i++) {
    await sleep(5000);
    const a = await runIn(bg, '(async()=>{ return window.__TP.probe("#live-card-list, #current-live-room"); })()');
    const b = await runIn(mainC, '(async()=>{ return window.__TP.probe("#live-card-list, #current-live-room"); })()');
    console.log(`  +${(i + 1) * 5}s 后台页=${!!(a && a.found)} 主页面=${!!(b && b.found)}`);
  }

  // 评论/弹幕面板：两个页面是不是各自独立
  const bgComment = await runIn(bg, '(async()=>{ return window.__TP.count("#comment_all_tab_list_container"); })()');
  const mainComment = await runIn(mainC, '(async()=>{ return window.__TP.count("#comment_all_tab_list_container"); })()');
  console.log('[bg] 评论区容器数量 后台页=', bgComment, ' 主页面=', mainComment);

  console.log('\n[bg] 结论：');
  console.log(`  后台页可用：${bgOk ? '是' : '否'}；主页面可用：${mainOk ? '是' : '否'}；两边同时可用：${bgOk && mainOk ? '✅ 是' : '❌ 否'}`);
  app.exit(0);
});
