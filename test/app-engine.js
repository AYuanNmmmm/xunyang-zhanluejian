/* 端到端跑真实引擎（带测试开关：不真提交、不真发券）
 * 目的：复现用户点「一键开启秒杀」「开始发券」时的完整日志
 * 运行：ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *   ./node_modules/.bin/electron --no-sandbox --disable-gpu test/app-engine.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-live-userdata';
const ONLY = String(process.env.ENGINE_ONLY || '').trim();
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
  if (fs.existsSync(src) && !fs.existsSync(dst)) require('node:child_process').execFileSync('cp', ['-R', src, dst]);
}
app.setPath('userData', TMP_UD);
prepareUserData();

let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')); } catch (e) {}
if (cfg) {
  cfg.__testNoSubmit = true;   // 秒杀不点最后一下提交
  if (String(process.env.ENGINE_ONLY || '') === 'smoke') {
    cfg.__testNoConfirm = true;   // 发券：选好数量/时长但不下发
    cfg.popup = { mode: 'seq', selected: [], showSec: 4, hideSec: 3, rounds: 1, timeFrom: '', timeTo: '' };
    cfg.coupon = Object.assign({}, cfg.coupon, { times: 1, intervalSec: 60, count: 10, durationMin: '1' });
    cfg.seckill.monitor = false;
  }
  if (String(process.env.ENGINE_ONLY || '') === 'pinengine') {
    // 一个只有一条「置顶」评论的组，间隔 5-6 秒，置顶间隔 0（每次都试）
    cfg.comment = { activeGroupId: 'g-pin-test', groups: [{
      id: 'g-pin-test', name: '置顶自测', order: 'seq', roundMin: 1,
      intervalMin: 5, intervalMax: 6, restMin: 1, pin: true, pinSec: 0,
      items: [{ id: 'i1', text: '自动置顶测试（请忽略）', pin: true }]
    }] };
  }
  cfg.__testNoConfirm = true;  // 发券不点确定发放
  if (ONLY === 'parallel') {
    // 弹讲解跑 3 轮就停；发评用专门的组（间隔 6~9 秒），发券只发 1 次
    cfg.popup = Object.assign({}, cfg.popup, { mode: 'seq', selected: [], showSec: 5, hideSec: 3, rounds: 3, timeFrom: '', timeTo: '' });
    cfg.coupon = Object.assign({}, cfg.coupon, { times: 1, intervalSec: 60, count: 10, durationMin: '1' });
    cfg.comment = {
      activeGroupId: 'g-parallel',
      groups: [{
        id: 'g-parallel', name: '并行自测', order: 'seq', roundMin: 1,
        intervalMin: 6, intervalMax: 9, restMin: 1, pin: false, pinSec: 300,
        items: [{ id: 'p1', text: '并行测试一（请忽略）' }, { id: 'p2', text: '并行测试二（请忽略）' }]
      }]
    };
    cfg.seckill.monitor = false;
  }
  if (ONLY === 'seckill') cfg.seckill.mode = process.env.ENGINE_SECKILL_MODE || cfg.seckill.mode;
  if (ONLY === 'coupon') { cfg.coupon.times = 2; cfg.coupon.intervalSec = 60; }
}
ipcMain.handle('config:load', () => cfg);
ipcMain.handle('config:save', (_e, d) => { cfg = d; return { ok: true }; });
ipcMain.handle('config:path', () => path.join(TMP_UD, 'config.json'));
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', (_e, s2) => guestApi.setLib(s2));
ipcMain.handle('guest:call', async (_e, code) => guestApi.runInFrames(code));
ipcMain.handle('guest:frames', () => guestApi.frameInfo());
ipcMain.handle('guest:scan', (_e, n) => guestApi.scanAll(n));
ipcMain.handle('guest:pickStart', () => guestApi.pickStart());
ipcMain.handle('guest:pickPoll', () => guestApi.pickPoll());
ipcMain.handle('guest:pickStop', () => guestApi.pickStop());
ipcMain.handle('guest:realClick', (_e, x, y) => guestApi.realClick(x, y));
ipcMain.handle('guest:realType', (_e, x, y, t) => guestApi.realType(x, y, t));
ipcMain.handle('guest:realMove', (_e, x, y) => guestApi.realMove(x, y));
ipcMain.handle('guest:realEnter', () => guestApi.realEnter());
ipcMain.handle('guest:realKey', (_e, k, n) => guestApi.realKey(k, n));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
  guestApi.setLib(loadLibSrc());
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  await win.loadFile(SRC);
  await sleep(1500);
  let t = 0;
  while (!guestApi.getGuest() && t < 60) { await sleep(300); t++; }
  await sleep(10000);

  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => 'ERR:' + e.message);
  const logs = async () => {
    const arr = await js('Array.from(document.querySelectorAll("#logBody .log-line")).map(function(el){return el.className.replace("log-line ","")+" | "+el.textContent;})');
    return Array.isArray(arr) ? arr : [];
  };
  const mark = async (label, n) => {
    const l = await logs();
    console.log(`\n----- ${label} -----`);
    l.slice(-(n || 18)).forEach((x) => console.log('  ' + x));
  };

  await js('window.confirm = () => true; window.alert = () => {};');
  console.log('[engine] 标题:', await js('document.getElementById("pageTitle").textContent'), '| 缩放:', await js('(function(){try{return document.getElementById("view").getZoomFactor()}catch(e){return "?"}})()'));

  // ======== 一键准备：分析 + 抓商品 + 扫券 + 扫秒杀入口 ========
  if (ONLY === 'sync') {
    await js('document.querySelector(\'.nav-item[data-tab="selectors"]\').click()');
    await sleep(700);
    const t0 = Date.now();
    await js('document.querySelector(\'[data-action="sync-all"]\').click()');
    await sleep(20000);
    const card = await js('(document.getElementById("syncBody") || {}).textContent || ""');
    console.log('[sync] 耗时', Math.round((Date.now() - t0) / 1000), 's | 结果卡:', String(card).replace(/\s+/g, ' ').trim().slice(0, 180));
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(800);
    const goodsRows = await js('document.querySelectorAll("[data-action=\\"pick-goods\\"]").length');
    const skRows = await js('document.querySelectorAll("[data-action=\\"pick-seckill\\"]").length');
    const goodsMeta = await js('Array.from(document.querySelectorAll(".section-title b")).map(function(e){return e.textContent}).join("/")');
    await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
    await sleep(800);
    const couponRows = await js('document.querySelectorAll("[data-action=\\"pick-coupon\\"]").length');
    console.log('[sync] 其它板块：商品行', goodsRows, '标题计数', goodsMeta, '| 秒杀入口行', skRows, '| 券行', couponRows);
    await mark('一键准备', 14);
    app.exit(0);
  }

  // ======== 其它功能自测（抓商品 / 弹讲解 / 发券 / 补充库存，均不产生不可逆副作用） ========
  if (ONLY === 'smoke') {
    // ① 抓取商品
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="fetch-goods"]\').click()');
    await sleep(9000);
    const goodsCount = await js('document.querySelectorAll(".goods-row [data-action=\\"pick-goods\\"]").length');
    console.log('[smoke] 抓取商品：', goodsCount, '个');
    await mark('抓取商品', 6);

    // ② 弹讲解（1 个商品 1 轮；会自动点卡片里的「讲解」）
    await js(`(() => { const b = document.querySelector('[data-action="pick-goods"]'); if (b && !b.checked) b.click(); })()`);
    await sleep(500);
    await js('document.querySelector(\'.nav-item[data-tab="popup"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="start-popup"]\').click()');
    await sleep(16000);
    await js('document.querySelector(\'[data-action="stop-popup"]\') && document.querySelector(\'[data-action="stop-popup"]\').click()');
    await sleep(1500);
    await mark('弹讲解', 12);

    // ③ 发券（__testNoConfirm：只选数量/时长，不点「确定发放」）
    await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="coupon-scan"]\').click()');
    await sleep(9000);
    const couponRows = await js('document.querySelectorAll("[data-action=\\"pick-coupon\\"]").length');
    console.log('[smoke] 扫到券：', couponRows, '张');
    await js(`(() => { const b = document.querySelector('[data-action="pick-coupon"]'); if (b && !b.checked) b.click(); })()`);
    await sleep(500);
    await js('document.querySelector(\'[data-action="start-coupon"]\').click()');
    await sleep(30000);
    await js('document.querySelector(\'[data-action="stop-coupon"]\') && document.querySelector(\'[data-action="stop-coupon"]\').click()');
    await sleep(1500);
    await mark('发券（不确认）', 16);

    // ④ 剩余补充（__testNoSubmit：编辑后加量但不提交）
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="seckill-scan"]\').click()');
    await sleep(6000);
    await js(`(() => { const boxes = document.querySelectorAll('[data-action="pick-seckill"]'); boxes.forEach((b) => { if (!b.checked) b.click(); }); })()`);
    await sleep(600);
    await js('document.querySelector(\'[data-action="seckill-replenish"]\').click()');
    await sleep(40000);
    await mark('剩余补充（不提交）', 20);
    app.exit(0);
  }

  // ======== 并行：弹讲解 + 自动发评 + 发券 一起开，验证「不抢页面」 ========
  // 判据：调度轨迹里 in/out 必须严格交替（maxDepth 只能是 1），且各功能都真的跑出了动作。
  if (ONLY === 'parallel') {
    // 准备：抓商品 + 勾选 + 扫券勾选
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="fetch-goods"]\').click()');
    await sleep(9000);
    const goodsN = await js('document.querySelectorAll(".goods-row [data-action=\\"pick-goods\\"]").length');
    console.log('[parallel] 商品数：', goodsN);
    await js(`(() => { const bs = document.querySelectorAll('[data-action="pick-goods"]');
      for (let i = 0; i < Math.min(2, bs.length); i++) if (!bs[i].checked) bs[i].click(); })()`);
    await sleep(600);

    await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="coupon-scan"]\').click()');
    await sleep(9000);
    const couponN = await js('document.querySelectorAll("[data-action=\\"pick-coupon\\"]").length');
    console.log('[parallel] 券数：', couponN);
    await js(`(() => { const b = document.querySelector('[data-action="pick-coupon"]'); if (b && !b.checked) b.click(); })()`);
    await sleep(500);

    // 先把轨迹清空，只统计「一起跑」这段时间
    await js('window.__debug.PageBus.trace.length = 0');

    // 三个功能几乎同时开：先开弹讲解，100ms 后开发评，再 100ms 开发券
    await js('document.querySelector(\'.nav-item[data-tab="popup"]\').click()');
    await sleep(400);
    await js('document.querySelector(\'[data-action="start-popup"]\').click()');
    await sleep(100);
    await js('document.querySelector(\'.nav-item[data-tab="comment"]\').click()');
    await sleep(200);
    const hasComment = await js('!!document.querySelector(\'[data-action="start-comment"]\')');
    if (hasComment) await js('document.querySelector(\'[data-action="start-comment"]\').click()');
    await sleep(100);
    await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
    await sleep(200);
    await js('document.querySelector(\'[data-action="start-coupon"]\').click()');

    console.log('[parallel] 三个功能已同时启动，观察 55 秒…');
    for (let i = 0; i < 11; i++) {
      await sleep(5000);
      const st = await js('window.__debug.sched()');
      console.log(`  t+${(i + 1) * 5}s 占用=${st.holder || '空闲'} 排队=${st.waiting} 重叠=${st.overlap.overlap} 最大并发=${st.overlap.maxDepth}`);
    }

    await js('document.querySelector(\'[data-action="stop-popup"]\') && document.querySelector(\'[data-action="stop-popup"]\').click()');
    await js('document.querySelector(\'[data-action="stop-comment"]\') && document.querySelector(\'[data-action="stop-comment"]\').classList.contains("on") && document.querySelector(\'[data-action="stop-comment"]\').click()');
    await js('document.querySelector(\'[data-action="stop-coupon"]\') && document.querySelector(\'[data-action="stop-coupon"]\').click()');
    await sleep(2000);

    const fin = await js('window.__debug.sched()');
    console.log('\n[parallel] 最终调度统计：', JSON.stringify(fin.stats), ' 重叠：', JSON.stringify(fin.overlap));
    const acts = await logs();
    const kinds = { '弹讲解': 0, '发评': 0, '发券': 0, '聚焦输入框': 0, '输入评论': 0 };
    acts.forEach((l) => { Object.keys(kinds).forEach((k) => { if (l.indexOf(k) >= 0) kinds[k]++; }); });
    console.log('[parallel] 动作计数：', JSON.stringify(kinds));
    console.log('[parallel] 结论：', fin.overlap.maxDepth === 1 ? '✅ 页面严格串行，没有两个功能同时动页面' : '❌ 出现并发重叠');
    await mark('并行 55 秒日志（末 30 条）', 30);
    app.exit(0);
  }

  // ======== 用应用自己的发评引擎跑一遍：发评论 + 自动置顶 ========
  if (ONLY === 'pinengine') {
    await js('document.querySelector(\'.nav-item[data-tab="comment"]\').click()');
    await sleep(600);
    const has = await js('!!document.querySelector(\'[data-action="start-comment"]\')');
    console.log('[pinengine] 开始按钮:', has);
    await js('document.querySelector(\'[data-action="start-comment"]\').click()');
    await sleep(30000);
    await js('document.querySelector(\'[data-action="stop-comment"]\') && document.querySelector(\'[data-action="stop-comment"]\').click()');
    await sleep(1500);
    await mark('自动发评 + 自动置顶', 24);
    app.exit(0);
  }

  // ======== 置顶验证：点完之后面板里出现什么（置顶标签/toast/条目位置） ========
  if (ONLY === 'pinverify') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const TEXT = String(process.env.PIN_TEXT || '测试置顶（请忽略）');
    const panelState = async (label) => {
      const st = await tpCall(`(async()=>{
        const n = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
        const wrap = document.querySelector('[class*="comment-wrap"]');
        const items = Array.from(wrap.querySelectorAll('[class*="item-"]')).filter((el) => el.querySelector('[class*="item-content"]'));
        const pinWords = [];
        document.querySelectorAll('*').forEach((el)=>{
          if (el.children.length) return;
          const t = n(el.textContent);
          if (!/^(置顶|已置顶|取消置顶)$/.test(t)) return;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return;
          pinWords.push({ t, cls: String(el.getAttribute('class')||'').slice(0,40), x: Math.round(r.x), y: Math.round(r.y) });
        });
        return {
          itemCount: items.length,
          items: items.slice(0,5).map((el)=>({ t: n(el.textContent).slice(0,40), cls: String(el.getAttribute('class')||'').slice(0,40) })),
          pinWords: pinWords.slice(0,6)
        };
      })()`);
      console.log(`[verify] ${label}:`, JSON.stringify(st).slice(0, 1000));
      return st;
    };

    // 发一条
    const loc = await tpCall(`(async()=>{ return await window.__TP.locate('textarea[placeholder*="输入评论"]'); })()`);
    if (!loc || !loc.ok) { console.log('[verify] 没有输入框'); app.exit(0); }
    await js(`window.tp.realClick(${loc.x}, ${loc.y})`);
    await sleep(400);
    await js(`window.tp.realType(${loc.x}, ${loc.y}, ${JSON.stringify(TEXT)})`);
    await sleep(300);
    await js('window.tp.realEnter()');
    await sleep(3000);
    await panelState('发送后');

    let found = null;
    for (let i = 0; i < 10; i++) {
      found = await tpCall(`(async()=>{ return await window.__TP.commentItemByText(${JSON.stringify(TEXT.slice(0,8))}); })()`);
      if (found && found.ok) break;
      await sleep(1500);
    }
    console.log('[verify] 定位:', JSON.stringify(found));
    if (!found || !found.ok) { app.exit(0); }

    await js(`window.tp.realMove(${found.x}, ${found.y})`);
    await sleep(1000);
    const icons = await tpCall(`(async()=>{
      const n = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
      const wrap = document.querySelector('[class*="comment-wrap"]');
      const items = Array.from(wrap.querySelectorAll('[class*="item-"]')).filter((el) => el.querySelector('[class*="item-content"]'));
      let el = null;
      for (let i = items.length - 1; i >= 0; i--) { if (n(items[i].textContent).indexOf(${JSON.stringify(TEXT.slice(0,8))}) >= 0) { el = items[i]; break; } }
      if (!el) return { ok:false };
      const box = el.querySelector('[class*="hover-button"]');
      if (!box) return { ok:false, reason:'no-hover-button' };
      return { ok:true, icons: Array.from(box.children).map((c)=>{ const r=c.getBoundingClientRect(); return { cls:String(c.getAttribute('class')||''), cx:Math.round(r.x+r.width/2), cy:Math.round(r.y+r.height/2) }; }) };
    })()`);
    console.log('[verify] 图标:', JSON.stringify(icons));

    if (icons && icons.ok && icons.icons.length) {
      const pin = icons.icons[0];
      console.log('[verify] 点第一个图标:', JSON.stringify(await js(`window.tp.realClick(${pin.cx}, ${pin.cy})`)));
      await sleep(2500);
      await panelState('点完 2.5s');
      const toast = await tpCall('(async()=>{ return await window.__TP.readToast(); })()');
      console.log('[verify] 后台提示:', JSON.stringify(toast));
      await sleep(3000);
      await panelState('点完 5.5s');
      // 再悬停一次看这条上还剩哪些图标（取消置顶通常会变）
      await js(`window.tp.realMove(${found.x}, ${found.y})`);
      await sleep(1200);
      const icons2 = await tpCall(`(async()=>{
        const n = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
        const wrap = document.querySelector('[class*="comment-wrap"]');
        const items = Array.from(wrap.querySelectorAll('[class*="item-"]')).filter((el) => el.querySelector('[class*="item-content"]'));
        let el = null;
        for (let i = items.length - 1; i >= 0; i--) { if (n(items[i].textContent).indexOf(${JSON.stringify(TEXT.slice(0,8))}) >= 0) { el = items[i]; break; } }
        if (!el) return { ok:false };
        const box = el.querySelector('[class*="hover-button"]');
        return { ok:true, html: el.outerHTML.slice(0, 2500), iconCount: box ? box.children.length : 0 };
      })()`);
      console.log('[verify] 置顶后再看:', JSON.stringify(icons2).slice(0, 2200));
    }
    app.exit(0);
  }

  // ======== 置顶图标探针：hover-button 里每个图标 + 悬停后弹出的提示文字 ========
  if (ONLY === 'pindump') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const TEXT = String(process.env.PIN_TEXT || '测试置顶').slice(0, 8);
    const itemInfo = await tpCall(`(async()=>{ return await window.__TP.commentItemByText(${JSON.stringify(TEXT)}); })()`);
    console.log('[pindump] 条目:', JSON.stringify(itemInfo));
    if (!itemInfo || !itemInfo.ok) { app.exit(0); }

    // 1) 悬停整条，让 hover-button 显形
    await js(`window.tp.realMove(${itemInfo.x}, ${itemInfo.y})`);
    await sleep(1000);

    // 2) 列 hover-button 里每个图标：全部属性 + 显隐 + 尺寸
    const icons = await tpCall(`(async()=>{
      const n = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
      const list = document.querySelector('#comment_all_tab_list_container');
      const items = list ? Array.from(list.children) : [];
      let el = null;
      for (let i = items.length - 1; i >= 0; i--) { if (n(items[i].textContent).indexOf(${JSON.stringify(TEXT)}) >= 0) { el = items[i]; break; } }
      if (!el) return { ok:false, reason:'no-item' };
      const box = el.querySelector('[class*="hover-button"]');
      if (!box) return { ok:false, reason:'no-hover-button' };
      const csBox = getComputedStyle(box);
      const out = [];
      Array.from(box.children).forEach((c, i) => {
        const svg = c.querySelector('svg');
        const r = c.getBoundingClientRect();
        const attrs = {};
        [c, c.firstElementChild, svg].forEach((node) => {
          if (!node || !node.attributes) return;
          Array.from(node.attributes).forEach((a) => { attrs[a.name] = String(a.value).slice(0, 40); });
        });
        out.push({
          i,
          cls: String(c.getAttribute('class') || ''),
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
          attrs,
          svgPathHead: svg ? String((svg.querySelector('path') || {}).getAttribute && svg.querySelector('path').getAttribute('d') || '').slice(0, 24) : ''
        });
      });
      return { ok:true, boxCls: String(box.getAttribute('class') || ''), boxStyle: { opacity: csBox.opacity, visibility: csBox.visibility, display: csBox.display }, count: out.length, icons: out };
    })()`);
    console.log('[pindump] 图标:', JSON.stringify(icons).slice(0, 2500));

    // 3) 逐个悬停图标，看弹出的提示文字
    if (icons && icons.ok) {
      for (const ic of icons.icons) {
        await js(`window.tp.realMove(${ic.cx}, ${ic.cy})`);
        await sleep(900);
        const tip = await tpCall(`(async()=>{
          const n = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
          const hits = [];
          document.querySelectorAll('[class*="tooltip"],[class*="Tooltip"],[class*="popper"],[class*="Popper"]').forEach((el)=>{
            const t = n(el.textContent);
            if (!t || t.length > 12) return;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) return;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
            hits.push({ t, cls: String(el.getAttribute('class')||'').slice(0,60) });
          });
          return { hits: hits.slice(0,6) };
        })()`);
        console.log(`[pindump] hover icon#${ic.i} → 提示:`, JSON.stringify(tip));
      }
    }
    app.exit(0);
  }

  // ======== 自测置顶：自己发一条 → 悬停 → 找置顶 → 点（dump 全过程） ========
  if (ONLY === 'pintest') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const TEXT = String(process.env.PIN_TEXT || '测试置顶（请忽略）');
    const dump = async (label) => {
      const info = await tpCall(`(async()=>{
        const n = (s) => String(s||'').replace(/\\s+/g,' ').trim();
        const list = document.querySelector('#comment_all_tab_list_container');
        const items = list ? Array.from(list.children) : [];
        const last = items[items.length - 1];
        if (!last) return { ok:false, itemCount: items.length };
        const leaves = [];
        last.querySelectorAll('*').forEach((el)=>{
          if (el.children.length) return;
          const t = n(el.textContent);
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          leaves.push({ t: t.slice(0,10), tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class')||'').slice(0,50), w: Math.round(r.width), vis: cs.display!=='none' && cs.visibility!=='hidden' && cs.opacity!=='0' });
        });
        const btns = Array.from(last.querySelectorAll('button')).map((b)=>({ t: n(b.textContent).slice(0,10), cls: String(b.getAttribute('class')||'').slice(0,50) }));
        return { ok:true, itemCount: items.length, cls: String(last.getAttribute('class')||''), text: n(last.textContent).slice(0,60), html: last.outerHTML.slice(0, 6000), leaves: leaves.slice(0,40), buttons: btns };
      })()`);
      console.log(`[pin] ${label}:`, JSON.stringify(info).slice(0, 3800));
      return info;
    };

    // 1) 先看评论面板在不在
    const panel = await tpCall(`(async()=>{
      const w = document.querySelector('[class*="comment-wrap"]');
      return { ok: !!w, wrap: w ? String(w.getAttribute('class')) : '', list: !!document.querySelector('#comment_all_tab_list_container') };
    })()`);
    console.log('[pin] 面板:', JSON.stringify(panel));

    // 2) 真实输入并回车发送
    const loc = await tpCall(`(async()=>{ return await window.__TP.locate('textarea[placeholder*="输入评论"]\\n[class*="comment-wrap"] textarea'); })()`);
    console.log('[pin] 输入框:', JSON.stringify(loc));
    if (loc && loc.ok) {
      await js(`window.tp.realClick(${loc.x}, ${loc.y})`);
      await sleep(500);
      console.log('[pin] 输入:', JSON.stringify(await js(`window.tp.realType(${loc.x}, ${loc.y}, ${JSON.stringify(TEXT)})`)));
      await sleep(400);
      console.log('[pin] 发送:', JSON.stringify(await js('window.tp.realEnter()')));
    } else {
      console.log('[pin] 找不到输入框，尝试 text=发送');
    }
    await sleep(2500);
    await dump('发送后');

    // 3) 等它出现在列表里（最多 20 秒）
    let found = null;
    for (let i = 0; i < 12; i++) {
      found = await tpCall(`(async()=>{ return await window.__TP.commentItemByText(${JSON.stringify(TEXT.slice(0, 8))}); })()`);
      if (found && found.ok) break;
      await sleep(1800);
    }
    console.log('[pin] 找回刚发的那条:', JSON.stringify(found));

    // 4) 悬停前 / 悬停后
    await dump('悬停前（最后一条）');
    if (found && found.ok) {
      console.log('[pin] 移指针(CDP):', JSON.stringify(await js(`window.tp.realMove(${found.x}, ${found.y})`)));
      await sleep(1200);
      await dump('悬停后（最后一条）');
      // 悬停后：把 hover-button 里的图标全列出来（含全部属性），并逐个悬停读提示文字
      const icons = await tpCall(`(async()=>{
        const n = (s)=>String(s||'').replace(/\s+/g,' ').trim();
        const list = document.querySelector('#comment_all_tab_list_container');
        const items = list ? Array.from(list.children) : [];
        let el = null;
        for (let i = items.length - 1; i >= 0; i--) { if (n(items[i].textContent).indexOf(${JSON.stringify(TEXT.slice(0, 8))}) >= 0) { el = items[i]; break; } }
        if (!el) return { ok:false, reason:'no-item' };
        const box = el.querySelector('[class*="hover-button"]');
        if (!box) return { ok:false, reason:'no-hover-button' };
        const cs = getComputedStyle(box);
        const out = [];
        Array.from(box.children).forEach((c, i) => {
          const svg = c.querySelector('svg');
          const r = c.getBoundingClientRect();
          const attrs = {};
          [c, c.firstElementChild, svg].forEach((node) => {
            if (!node || !node.attributes) return;
            Array.from(node.attributes).forEach((a) => { attrs[a.name] = String(a.value).slice(0, 30); });
          });
          out.push({ i, cls: String(c.getAttribute('class')||''), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), w: Math.round(r.width), attrs });
        });
        return { ok:true, opacity: cs.opacity, visibility: cs.visibility, count: out.length, icons: out };
      })()`);
      console.log('[pin] hover-button 图标:', JSON.stringify(icons).slice(0, 1800));

      const findTip = async () => {
        return await tpCall(`(async()=>{
          const n = (s)=>String(s||'').replace(/\s+/g,' ').trim();
          const hits = [];
          document.querySelectorAll('[class*="tooltip"],[class*="Tooltip"],[class*="popper"],[class*="Popper"]').forEach((el)=>{
            const t = n(el.textContent);
            if (!t || t.length > 12) return;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) return;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
            hits.push(t);
          });
          return { hits: Array.from(new Set(hits)).slice(0,5) };
        })()`);
      };
      let pinIcon = null;
      if (icons && icons.ok) {
        for (const ic of icons.icons) {
          await js(`window.tp.realMove(${ic.cx}, ${ic.cy})`);
          await sleep(900);
          const tip = await findTip();
          console.log(`[pin] icon#${ic.i} 提示:`, JSON.stringify(tip));
          if (!pinIcon && tip && (tip.hits || []).some((t) => /置顶/.test(t))) pinIcon = ic;
        }
      }
      // 没有提示文字时按结构兜底：hover-button 第一个图标就是置顶（第二个是回复）
      if (!pinIcon && icons && icons.ok && icons.icons.length) {
        pinIcon = icons.icons[0];
        console.log('[pin] 没读到提示文字，按结构取第一个图标（图钉=置顶）');
      }
      const acts = { ok: !!pinIcon, actions: pinIcon ? [{ t: '置顶', cls: pinIcon.cls, x: pinIcon.cx, y: pinIcon.cy }] : [] };
      console.log('[pin] 识别到的置顶入口:', JSON.stringify(acts));

      // 5) 如果找到了就点一下
      const pin = acts && acts.ok && (acts.actions || []).find((a) => /置顶/.test(a.t) || /pin|ding/i.test(a.cls));
      if (pin) {
        console.log('[pin] 点击置顶:', JSON.stringify(await js(`window.tp.realClick(${pin.x}, ${pin.y})`)));
        await sleep(2000);
        const cf = await tpCall('(async()=>{ return await window.__TP.seckillConfirm(); })()');
        console.log('[pin] 二次确认:', JSON.stringify(cf));
        await sleep(1500);
        console.log('[pin] 置顶后文案:', JSON.stringify(await tpCall(`(async()=>{ return await window.__TP.commentItemActions(${JSON.stringify(TEXT.slice(0, 8))}); })()`)));
        await dump('置顶后（最后一条）');
      } else {
        console.log('[pin] 没有找到置顶入口，未点击');
      }
    }
    app.exit(0);
  }

  // ======== 高级页：就地分析（不许跳页）+ 开面板再分析 + 置顶自检 ========
  if (ONLY === 'detect') {
    const url0 = await js('document.getElementById("view").getURL()');
    await js('document.querySelector(\'.nav-item[data-tab="selectors"]\').click()');
    await sleep(600);
    await js('document.querySelector(\'[data-action="auto-detect"]\').click()');
    await sleep(6000);
    const url1 = await js('document.getElementById("view").getURL()');
    const rows1 = await js('document.querySelectorAll(".detect-row").length');
    const sum1 = await js('(document.querySelector(".detect-sum") || {}).textContent || ""');
    console.log('[detect] 就地分析：URL 变化=', url0 !== url1, '| rows=', rows1, '|', sum1);
    await mark('就地分析', 8);

    await js('document.querySelector(\'[data-action="detect-open-coupon"]\').click()');
    await sleep(12000);
    const url2 = await js('document.getElementById("view").getURL()');
    const sum2 = await js('(document.querySelector(".detect-sum") || {}).textContent || ""');
    const couponRows = await js('Array.from(document.querySelectorAll(".detect-row")).filter(function(el){return /券|档位/.test(el.textContent) && /✓/.test(el.textContent)}).map(function(el){return el.textContent.trim()}).join(" / ")');
    console.log('[detect] 开券面板后：URL 变化=', url1 !== url2, '|', sum2);
    console.log('[detect] 券相关命中：', couponRows);

    await js('document.querySelector(\'[data-action="detect-open-seckill"]\').click()');
    await sleep(20000);
    const sum3 = await js('(document.querySelector(".detect-sum") || {}).textContent || ""');
    const skRows = await js('Array.from(document.querySelectorAll(".detect-row")).filter(function(el){return /秒杀/.test(el.textContent)}).map(function(el){return el.textContent.trim().replace(/\\s+/g," ")}).join(" / ")');
    console.log('[detect] 开秒杀抽屉后：', sum3);
    console.log('[detect] 秒杀相关：', skRows);
    await mark('开面板后分析', 10);

    // 置顶自检（只悬停，不点）
    await js('document.querySelector(\'.nav-item[data-tab="comment"]\').click()');
    await sleep(500);
    await js('document.querySelector(\'[data-action="pin-check"]\').click()');
    await sleep(6000);
    await mark('置顶自检', 10);
    app.exit(0);
  }

  // ======== 只读：评论条目 + 悬停后的操作按钮（置顶） ========
  if (ONLY === 'comments') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    // 1) 评论面板概况
    const panel = await tpCall(`(async()=>{
      const w = document.querySelector('[class*="comment-wrap"]');
      if (!w) return { ok:false, reason:'no-comment-wrap' };
      const list = document.querySelector('#comment_all_tab_list_container');
      const items = list ? Array.from(list.children) : [];
      return {
        ok: true,
        wrapCls: w.getAttribute('class'),
        listCls: list ? list.getAttribute('class') : '',
        itemCount: items.length,
        items: items.slice(0,3).map((it) => ({
          cls: it.getAttribute('class'),
          text: (it.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60),
          html: it.outerHTML.slice(0, 3500)
        })),
        // 面板上所有可见按钮/文字按钮
        ctrl: Array.from(w.querySelectorAll('button,[class*="btn"],[class*="Btn"]')).map((b)=>({
          t: (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,12),
          cls: String(b.getAttribute('class')||'').slice(0,60),
          w: Math.round(b.getBoundingClientRect().width)
        })).filter((x)=>x.w>0).slice(0,20)
      };
    })()`);
    console.log('[comments] 面板:', JSON.stringify(panel).slice(0, 2600));

    // 2) 悬停第一条，看是否浮现操作（置顶/删除）
    const box = await tpCall(`(async()=>{
      const list = document.querySelector('#comment_all_tab_list_container');
      const it = list && list.firstElementChild;
      if (!it) return null;
      const r = it.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    console.log('[comments] 首条位置:', JSON.stringify(box));
    if (box && box.x) {
      await js(`window.tp.mouseMove ? window.tp.mouseMove(${box.x}, ${box.y}) : null`).catch(()=>{});
      await sleep(1200);
      const after = await tpCall(`(async()=>{
        const list = document.querySelector('#comment_all_tab_list_container');
        const it = list && list.firstElementChild;
        if (!it) return { ok:false };
        const leaves = [];
        it.querySelectorAll('*').forEach((el)=>{
          if (el.children.length) return;
          const t = (el.textContent||'').replace(/\\s+/g,' ').trim();
          if (!t || t.length > 8) return;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return;
          leaves.push({ t, tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class')||'').slice(0,50) });
        });
        return { ok:true, html: it.outerHTML.slice(0, 5000), leaves: leaves.slice(0, 30) };
      })()`);
      console.log('[comments] 悬停后:', JSON.stringify(after).slice(0, 3200));
    }
    app.exit(0);
  }

  // ======== 只读：逐 frame 直接求值，看清「详情抽屉」里到底有什么 ========
  if (ONLY === 'frames') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]';
    const btnSel = '[class*="seckill-btn-container"]';
    const loc = await tpCall(`(async()=>{ return await window.__TP.locateIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`);
    if (loc && loc.ok) await js(`window.tp.realClick(${loc.x}, ${loc.y})`);
    await sleep(4500);
    const frames = guestApi.getFrames();
    console.log('[frames] 数量:', frames.length);
    for (let i = 0; i < frames.length; i++) {
      const out = await frames[i].executeJavaScript(`(() => {
        const n = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const btn = Array.from(document.querySelectorAll('button')).map((b) => n(b.textContent)).filter(Boolean);
        const leaf = Array.from(document.querySelectorAll('span,div,a')).filter((el) => !el.children.length).map((el) => n(el.textContent)).filter((t) => t && t.length <= 10);
        return {
          url: location.href,
          nums: Array.from(document.querySelectorAll('.byted-input-number-input')).map((e) => e.value),
          text: n(document.body && document.body.textContent).slice(0, 500),
          buttons: btn.slice(0, 14),
          leaves: Array.from(new Set(leaf)).slice(0, 26)
        };
      })()`, true).catch((e) => ({ err: String(e.message || e) }));
      console.log(`[frames] #${i}:`, JSON.stringify(out).slice(0, 1400));
    }
    app.exit(0);
  }

  // ======== 只读：打开 4 号卡秒杀抽屉，dump 到底出现了什么 ========
  if (ONLY === 'drawer') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]';
    const btnSel = '[class*="seckill-btn-container"]';
    const loc = await tpCall(`(async()=>{ return await window.__TP.locateIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`);
    console.log('[drawer] 入口:', JSON.stringify(loc));
    if (loc && loc.ok) console.log('[drawer] 坐标点击:', JSON.stringify(await js(`window.tp.realClick(${loc.x}, ${loc.y})`)));
    await sleep(4000);
    console.log('[drawer] 弹层:', JSON.stringify(await tpCall('(async()=>{ return await window.__TP.probeModals(); })()')).slice(0, 1200));
    const frames = guestApi.frameInfo();
    console.log('[drawer] frames:', JSON.stringify(frames.frames || []).slice(0, 800));
    for (let i = 0; i < (frames.frames || []).length; i++) {
      const txt = await js(`window.tp.call('(async()=>{ return { url: location.href, text: (document.body ? document.body.textContent : "").replace(/\\s+/g," ").slice(0,300), nums: document.querySelectorAll(".byted-input-number-input").length, forms: document.querySelectorAll(".byted-form-item").length, buttons: Array.from(document.querySelectorAll("button")).map(b=>b.textContent.trim()).filter(Boolean).slice(0,8) }; })()')`);
      console.log(`[drawer] frame#${i}:`, JSON.stringify(txt).slice(0, 500));
    }
    // DOM 兜底再点一次
    console.log('[drawer] DOM 点击:', JSON.stringify(await tpCall(`(async()=>{ return await window.__TP.clickIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`)));
    await sleep(4000);
    const f2 = guestApi.frameInfo();
    console.log('[drawer] frames(2):', JSON.stringify(f2.frames || []).slice(0, 800));
    console.log('[drawer] 弹层(2):', JSON.stringify(await tpCall('(async()=>{ return await window.__TP.probeModals(); })()')).slice(0, 1000));
    await js('window.tp.realKey("Escape")');
    app.exit(0);
  }

  // ======== 自动回中控台（离开首页后点功能） ========
  if (ONLY === 'home') {
    console.log('[home] 起始 URL:', await js('document.getElementById("view").getURL()'));
    await js('document.getElementById("view").loadURL("https://eos.douyin.com/livesite/live/data")');
    await sleep(7000);
    console.log('[home] 故意离开到:', await js('document.getElementById("view").getURL()'));
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(400);
    await js('document.querySelector(\'[data-action="seckill-scan"]\').click()');
    await sleep(15000);
    console.log('[home] 点「扫描入口」后 URL:', await js('document.getElementById("view").getURL()'));
    const logsNow = await js('Array.from(document.querySelectorAll("#logBody .log-line")).map(function(el){return el.textContent}).join(" || ")');
    console.log('[home] 日志里是否出现自动回跳:', /自动跳回|自动返回/.test(String(logsNow)) ? '是' : '否');
    await mark('自动回中控台（离开后点功能）', 14);
  }

  // ======== 剩余补充：读状态 + 走一遍「编辑 → 原数量+追加」（不提交） ========
  if (ONLY === 'replenish') {
    const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
    const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]';
    const btnSel = '[class*="seckill-btn-container"]';
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(400);
    await js('document.querySelector(\'[data-action="seckill-scan"]\').click()');
    await sleep(5000);
    await js(`(() => { const boxes = document.querySelectorAll('[data-action="pick-seckill"]'); boxes.forEach((b) => { if (!b.checked) b.click(); }); })()`);
    await sleep(600);

    // ① 只读：打开抽屉看是不是「已投放态」（有编辑 / 剩余）
    const loc = await tpCall(`(async()=>{ return await window.__TP.locateIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`);
    console.log('[replenish] 入口坐标:', JSON.stringify(loc));
    if (loc && loc.ok) await js(`window.tp.realClick(${loc.x}, ${loc.y})`);
    await sleep(3200);
    let f = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
    if (!f || !f.ok) {
      await tpCall(`(async()=>{ return await window.__TP.clickIn(${JSON.stringify(cardSel)}, ${JSON.stringify(btnSel)}); })()`);
      await sleep(3500);
      f = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
    }
    console.log('[replenish] 表单:', JSON.stringify({ ok: f && f.ok, mode: f && f.mode, stock: f && f.stockValue, hasEdit: f && f.hasEdit, editText: f && f.editText, remain: f && f.remain, status: f && f.statusText }));
    const st = await tpCall('(async()=>{ return await window.__TP.seckillStatus(); })()');
    console.log('[replenish] 状态:', JSON.stringify(st).slice(0, 700));
    await js('window.tp.realKey("Escape")');
    await sleep(1200);

    // ② 走引擎：编辑 → 原数量 + 追加 → 到提交前一步（__testNoSubmit）
    await js('document.querySelector(\'[data-action="seckill-replenish"]\').click()');
    await sleep(40000);
    await mark('秒杀：补充库存（编辑 → 原数量+追加，不提交）', 30);
  }

  // ======== 秒杀 ========
  if (!ONLY || ONLY === 'seckill') {
    await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
    await sleep(400);
    await js('document.querySelector(\'[data-action="seckill-scan"]\').click()');
    await sleep(4000);
    await js(`(() => {
      const boxes = document.querySelectorAll('[data-action="pick-seckill"]');
      boxes.forEach((b) => { if (!b.checked) b.click(); });
    })()`);
    await sleep(500);
    // 先手动开一次抽屉，量一下提交按钮在不在 iframe 视口内
    const probe = await (async () => {
      const tpCall = (code) => js('window.tp.call(' + JSON.stringify(code) + ')');
      const loc = await tpCall('(async()=>{ return await window.__TP.locateIn(\'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]\', \'[class*="seckill-btn-container"]\'); })()');
      if (loc && loc.ok) await js(`window.tp.realClick(${loc.x}, ${loc.y})`);
      await sleep(3200);
      const f = await tpCall('(async()=>{ return await window.__TP.seckillForm(); })()');
      const vp = await tpCall('(async()=>({ ih: innerHeight, iw: innerWidth }))()');
      return { submit: f && f.points && f.points.submit, cancel: f && f.points && f.points.cancel, vp, mode: f && f.mode };
    })();
    console.log('[engine] 提交按钮位置:', JSON.stringify(probe));
    await js('window.tp.realKey("Escape")');
    await sleep(1200);

    await js('document.querySelector(\'[data-action="seckill-enable"]\').click()');
    await sleep(45000);
    await mark('秒杀：一键开启（到提交前一步）', 26);
  }

  // ======== 发券 ========
  if (!ONLY || ONLY === 'coupon') {
    await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
    await sleep(400);
    await js('document.querySelector(\'[data-action="coupon-scan"]\').click()');
    await sleep(5000);
    await js(`(() => {
      const b = document.querySelector('[data-action="pick-coupon"]');
      if (b && !b.checked) b.click();
    })()`);
    await sleep(400);
    const t0 = Date.now();
    await js('document.querySelector(\'[data-action="start-coupon"]\').click()');
    await sleep(150000);   // 两轮 + 60 秒间隔，观察间隔是否生效
    await js('document.querySelector(\'[data-action="stop-coupon"]\') && document.querySelector(\'[data-action="stop-coupon"]\').click()');
    await sleep(1500);
    console.log(`[engine] 发券观察时长：${Math.round((Date.now() - t0) / 1000)}s`);
    await mark('发券：两轮 + 间隔', 30);
  }

  console.log('\n[engine] 结束');
  app.exit(0);
});
