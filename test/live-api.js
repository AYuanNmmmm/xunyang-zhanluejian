/* 真机验证 v0.10.3 的接口通道（全部只读，不改直播间状态）
 *
 * 用法：unset ELECTRON_RUN_AS_NODE && electron test/live-api.js
 *
 * 验的是这五件事：
 *   1. 注入库是不是 0.8，接口方法在不在
 *   2. apiIds 能不能拿到 roomId / userId
 *   3. live_data/v3 的字段名跟我猜的对不对（这是实时大屏的地基）
 *   4. component/stats 的 component_conversion_data 结构对不对（单品数据）
 *   5. shelves/anchor 能不能拿到 cardId（没有 cardId 弹讲解就走不了接口）
 * 外加 apiLiveStatus（保活）和 officialBusy（抽屉礼让）。
 *
 * 不做的：不调 apiSwitchCard —— 那会真的切讲解、观众看得见，要单独确认。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const CFG = path.join(ROOT, 'data', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const brief = (o, n = 240) => {
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// 只读验证：配置只在内存里过一遍，绝不回写磁盘
let cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
ipcMain.handle('config:load', () => cfg);
ipcMain.handle('config:save', (_e, d) => { cfg = d; return { ok: true }; });
ipcMain.handle('config:path', () => CFG);
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('app:version', () => '0.10.3');
ipcMain.handle('guest:setLib', (_e, s) => guestApi.setLib(s));
ipcMain.handle('guest:call', async (_e, code, target) => {
  const r = await guestApi.runInFrames(code, target);
  return r == null ? { ok: false, reason: 'empty-result' } : r;
});
ipcMain.handle('guest:register', (_e, name, id) => guestApi.register(name, id));
ipcMain.handle('guest:names', () => ({ ok: true, names: guestApi.guestNames() }));
ipcMain.handle('guest:probe', () => guestApi.runInFrames(
  `(async()=>{ return window.__TP ? window.__TP.probe() : { found:false, reason:'no-lib' }; })()`
));
ipcMain.handle('guest:pickStart', (_e, t) => guestApi.pickStart(t));
ipcMain.handle('guest:pickPoll', (_e, t) => guestApi.pickPoll(t));
ipcMain.handle('guest:pickStop', (_e, t) => guestApi.pickStop(t));
ipcMain.handle('guest:frames', (_e, t) => guestApi.frameInfo(t));
ipcMain.handle('guest:scan', (_e, n, t) => guestApi.scanAll(n, t));
ipcMain.handle('guest:realClick', (_e, x, y, t) => guestApi.realClick(x, y, t));
ipcMain.handle('guest:realType', (_e, x, y, s, t) => guestApi.realType(x, y, s, t));
ipcMain.handle('guest:realMove', (_e, x, y, t) => guestApi.realMove(x, y, t));
ipcMain.handle('guest:realEnter', (_e, t) => guestApi.realEnter(t));
ipcMain.handle('guest:realKey', (_e, k, n, t) => guestApi.realKey(k, n, t));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
});

const RUN = `(async (code) => { try { return await (0, eval)(code); } catch (e) { return { ok: false, reason: 'eval:' + String(e && e.message || e) }; } })`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1580, height: 980, show: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true, spellcheck: false, backgroundThrottling: false
    }
  });
  win.loadFile(SRC);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // 界面起来
  for (let i = 0; i < 40; i++) {
    if (await js('!!(window.__debug && window.__debug.worker)').catch(() => false)) break;
    await sleep(500);
  }
  // 后台直播页就绪
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await js('window.__debug.worker()').catch(() => null);
    if (st && st.state === 'ready') break;
    await sleep(1000);
  }
  if (!st || st.state !== 'ready') {
    console.log('\n后台页没就绪（' + (st && st.state) + '）。请确认直播中控台已登录、直播间已开播。');
    app.exit(1); return;
  }
  console.log('\n后台页就绪，开始真机接口验证\n');

  // 在 guest 里跑一段代码
  const g = async (code, target) => {
    const r = await guestApi.runInFrames(`(async()=>{ ${code} })()`, target);
    return r;
  };
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  // ---------- 1. 注入库版本 ----------
  const ver = await g(`const T = window.__TP; return T ? { v: T.version, url: location.href,
      fns: ['apiIds','apiReq','apiRoomStats','apiCardStats','apiShelf','apiLiveStatus','apiSwitchCard','officialBusy']
        .filter((k) => typeof T[k] === 'function') } : { v: null };`, 'worker');
  log(!!ver && ver.v === '0.8', '注入库已是 0.8 且接口方法齐全',
    ver ? `v=${ver.v} · ${(ver.fns || []).join(',')}` : brief(ver));
  if (!ver || !ver.v) { console.log('\n注入库没进页面，后面的接口无从谈起。'); app.exit(1); return; }
  console.log(`  页面：${brief(ver.url, 120)}`);

  // ---------- 2. roomId / userId ----------
  const ids = await g(`return await window.__TP.apiIds();`, 'worker');
  const rid = ids && ids.roomId;
  log(!!rid, 'apiIds 拿到 roomId', brief(ids));
  if (!rid) {
    console.log('\n没有 roomId，后面所有房间级接口都调不了 —— 先看直播中控台是不是真的在这一页。');
    app.exit(1); return;
  }

  // ---------- 3. 保活 + 抽屉 ----------
  const status = await g(`return await window.__TP.apiLiveStatus();`, 'worker');
  log(!!(status && status.ok), 'live/status 可用（保活心跳）',
    brief({ ok: status && status.ok, code: status && status.code, reason: status && status.reason,
      keys: status && status.data ? Object.keys(status.data).slice(0, 8) : null }));

  const busy = await g(`return window.__TP.officialBusy();`, 'worker');
  log(!!busy && typeof busy.busy === 'boolean', 'officialBusy 可读', brief(busy));

  // ---------- 4. 实时大屏：先看原始字段名 ----------
  const raw = await g(`return await window.__TP.apiReq('/data/life/live/data/live_data/v3/', { query: { room_id: ${JSON.stringify(rid)} } });`, 'worker');
  const rawKeys = raw && raw.data ? Object.keys(raw.data) : [];
  log(!!(raw && raw.ok), 'live_data/v3 通',
    brief({ ok: raw && raw.ok, code: raw && raw.code, reason: raw && raw.reason, keys: rawKeys.length }));
  if (rawKeys.length) console.log(`  原始字段：${rawKeys.join(' · ')}`);

  const room = await g(`return await window.__TP.apiRoomStats(${JSON.stringify(rid)});`, 'worker');
  const s = (room && room.stats) || {};
  const hit = ['online', 'watch', 'follow', 'order', 'gmv', 'payRate'].filter((k) => s[k] != null && s[k] !== 0);
  log(!!(room && room.ok), 'apiRoomStats 解析成功', brief(room));
  log(hit.length >= 3, '大屏关键字段有真实值（不是全 null/0）', `命中 ${hit.length}/6：${hit.join(',') || '无'} · ${brief(s, 160)}`);

  // ---------- 5. 货架 ----------
  const shelf = await g(`return await window.__TP.apiShelf(${JSON.stringify(rid)});`, 'worker');
  const items = (shelf && shelf.items) || [];
  log(!!(shelf && shelf.ok) && items.length > 0, 'shelves/anchor 拿到商品', `count=${shelf && shelf.count} reason=${(shelf && shelf.reason) || ''}`);
  const withCard = items.filter((x) => x.cardId);
  log(withCard.length === items.length && items.length > 0, '每个商品都有 cardId（弹讲解走接口的前提）',
    `${withCard.length}/${items.length}`);
  items.slice(0, 6).forEach((x) => console.log(`    #${x.i} ${brief(x.name, 26)} · card=${x.cardId} · goods=${x.goodsId} · 图=${x.img ? '有' : '无'}`));

  // ---------- 6. 单品数据 ----------
  const gids = items.map((x) => x.goodsId).filter(Boolean).slice(0, 8);
  if (!gids.length) {
    log(false, 'apiCardStats', '货架没商品，跳过');
  } else {
    const rawc = await g(`return await window.__TP.apiReq('/data/life/live/component/stats/', { query: { component_ids: ${JSON.stringify(gids.join(','))}, room_id: ${JSON.stringify(rid)} } });`, 'worker');
    log(!!(rawc && rawc.ok), 'component/stats 通',
      brief({ ok: rawc && rawc.ok, code: rawc && rawc.code, reason: rawc && rawc.reason,
        keys: rawc && rawc.data ? Object.keys(rawc.data) : null }));
    const cards = await g(`return await window.__TP.apiCardStats(${JSON.stringify(gids)}, ${JSON.stringify(rid)});`, 'worker');
    const rows = (cards && cards.rows) || {};
    const ks = Object.keys(rows);
    log(!!(cards && cards.ok) && ks.length > 0, 'apiCardStats 解析出单品行', `命中 ${ks.length}/${gids.length}`);
    ks.slice(0, 6).forEach((k) => console.log(`    商品 ${k} → ${brief(rows[k], 90)}`));
    const anyShow = ks.some((k) => rows[k].show > 0);
    console.log(`  曝光>0 的商品：${anyShow ? '有（数据在跑）' : '暂时都是 0（可能刚切过去，还没来得及累计）'}`);
    log(true, 'apiCardStats 端到端走通（数据是否非 0 取决于开播时长）', anyShow ? '有曝光' : '曝光暂为 0');
  }

  // ---------- 7. 面板是否真的用了接口 ----------
  await js(`(() => { const b = document.querySelector('.nav-item[data-tab="data"]'); if (b) b.click(); return !!b; })()`);
  await sleep(2500);
  const ui = await js(`(() => {
    const box = document.getElementById('dataBox');
    return { has: !!box, text: box ? (box.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : '' };
  })()`);
  log(!!ui && ui.has && ui.text.length > 10, '界面「实时数据」页真的拉到并渲染了', brief(ui.text, 160));

  console.log(`\n用时 ${stamp()} · 结果：${pass} 通过 / ${fail} 待修`);

  try { fs.writeFileSync(path.join(__dirname, 'live-api.log.json'), JSON.stringify({ ids, status, busy, raw, room, shelf, items }, null, 1)); } catch (e) {}

  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, 'ui-data-live.png'), img.toPNG());
    console.log('截图已存：ui-data-live.png');
  } catch (e) {}

  app.exit(fail ? 1 : 0);
});
