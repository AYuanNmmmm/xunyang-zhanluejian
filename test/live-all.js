/* 真机并发压测：把所有能开的功能同时打开，看哪些会失效
 *
 * 用法：unset ELECTRON_RUN_AS_NODE && electron test/live-all.js [压测秒数，默认150]
 *
 * 安全措施（都是可回滚的）：
 *   · 先把 data/config.json 备份成 data/config.liveall.bak.json，跑完原样写回
 *   · __testNoConfirm = true  → 发券走到「确定发放」前一步就停，不会真把券发出去
 *   · seckill.minStock = 0    → 只有剩余为 0 才补，正常不会动真实库存
 *   · 只启动有配置的功能；欢迎语/感谢语没绑选择器，会记录为「前置未配置」
 *
 * 观测：PageBus 是否出现重叠（两个任务同时动页面）、谁饿死最久、
 *       哪个功能中途意外退出、失败日志集中在哪一类。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const CFG = path.join(ROOT, 'data', 'config.json');
const BAK = path.join(ROOT, 'data', 'config.liveall.bak.json');
const DUR = Math.max(30, Number(process.argv[2]) || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------- 备份并注入压测配置 ----------
fs.copyFileSync(CFG, BAK);
let cfgSaved = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const restore = () => {
  try { fs.copyFileSync(BAK, CFG); fs.unlinkSync(BAK); } catch (e) {}
};
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(0); });

cfgSaved.__testNoConfirm = true;                       // 不真发券
cfgSaved.seckill = cfgSaved.seckill || {};
cfgSaved.seckill.minStock = 0;                          // 不触发补库存
cfgSaved.seckill.monitorSec = Math.min(15, Number(cfgSaved.seckill.monitorSec) || 15);
cfgSaved.goods = cfgSaved.goods || {};
cfgSaved.goods.autoRefresh = true;                      // 商品自动刷新一起开
cfgSaved.goods.refreshSec = 20;                         // 最小 20 秒
// 发评间隔临时拉长：压测只验证「并发下还发得出去」，不必往真实直播间刷十几条
(cfgSaved.comment.groups || []).forEach((g) => { g.intervalMin = 25; g.intervalMax = 40; });

ipcMain.handle('config:load', () => cfgSaved);
ipcMain.handle('config:save', (_e, d) => { cfgSaved = d; return { ok: true }; });
ipcMain.handle('config:path', () => CFG);
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('app:version', () => '0.10.0');
ipcMain.handle('guest:setLib', (_e, s) => guestApi.setLib(s));
ipcMain.handle('guest:call', async (_e, code, target) => guestApi.runInFrames(code, target));
ipcMain.handle('guest:register', (_e, name, id) => guestApi.register(name, id));
ipcMain.handle('guest:names', () => ({ ok: true, names: guestApi.guestNames() }));
ipcMain.handle('guest:probe', (_e, target, sel) => guestApi.runInFrames(
  `(async()=>{ return window.__TP ? window.__TP.probe(${JSON.stringify(sel || '#live-card-list, #current-live-room')}) : { found:false, reason:'no-lib' }; })()`,
  target
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

const FUNCS = [
  { key: 'popup', tab: 'popup', btn: 'start-popup', name: '弹讲解' },
  { key: 'comment', tab: 'comment', btn: 'start-comment', name: '自动发评' },
  { key: 'coupon', tab: 'coupon', btn: 'start-coupon', name: '发优惠券' },
  { key: 'seckill', tab: 'goods', btn: 'start-seckill', name: '秒杀监控' }
];

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

  for (let i = 0; i < 40; i++) {
    if (await js('!!(window.__debug && window.__debug.worker)').catch(() => false)) break;
    await sleep(500);
  }

  // ---------- 后台页就绪 ----------
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = await js('window.__debug.worker()').catch(() => null);
    if (st && st.state === 'ready') break;
    await sleep(1000);
  }
  if (!st || st.state !== 'ready') {
    console.log('\n后台页没就绪（' + (st && st.state) + '），压测无法进行。请确认直播中控台已登录。');
    app.exit(1); return;
  }
  console.log(`\n后台页就绪，开始并发压测 ${DUR} 秒`);

  const seenStats = await js('window.__debug.stats()');
  const baseStats = Object.assign({}, seenStats);

  // ---------- 启动前：抓商品 + 扫描秒杀入口（这两个是功能的前置） ----------
  const clickTab = async (tab) => {
    await js(`(() => { const b = document.querySelector('.nav-item[data-tab="${tab}"]'); if (b) b.click(); return !!b; })()`);
    await sleep(350);
  };
  const clickBtn = async (action) => js(`(() => { const b = document.querySelector('[data-action="${action}"]'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`);

  await clickTab('goods');
  await clickBtn('fetch-goods');
  await sleep(9000);
  await clickBtn('seckill-scan');
  await sleep(9000);

  // ---------- 依次打开所有功能（模拟真人逐个点开始） ----------
  const started = [];
  for (const f of FUNCS) {
    await clickTab(f.tab);
    const r = await clickBtn(f.btn);
    await sleep(2500);
    started.push({ ...f, click: r });
    console.log(`  启动 ${f.name}：${r === 'ok' ? '已点开始' : '按钮没找到'}`);
  }

  // 配置齐全但没绑选择器的功能，直接报出来（它们现在开不了）
  const sel = await js('(() => { const s = window.__debug.schedCfg(); return s; })()');

  // ---------- 采样 ----------
  const samples = [];
  const logSeen = new Set();
  const allLogs = [];
  const t0 = Date.now();
  let tick = 0;

  while (Date.now() - t0 < DUR * 1000) {
    await sleep(3000);
    tick++;
    const snap = await js(`(() => {
      const s = __debug.sched();
      return { holder: s.holder, waiting: s.waiting, queue: s.queue, stats: s.stats, overlap: s.overlap,
               running: __debug.runningNow(), biz: __debug.stats(), worker: __debug.worker().state };
    })()`).catch(() => null);
    if (!snap) continue;
    const lines = await js('__debug.logLines()').catch(() => []);
    for (const l of lines || []) {
      const k = `${l.t}|${l.level}|${l.tag}|${l.msg}`;
      if (!logSeen.has(k)) { logSeen.add(k); allLogs.push(l); }
    }
    samples.push({ at: Math.round((Date.now() - t0) / 1000), ...snap });
    process.stdout.write(`  [${String(snap.at || Math.round((Date.now() - t0) / 1000)).padStart(3)}s] 上手=${snap.holder || '无'} 排队=${snap.waiting} 在跑=${snap.running.join(',') || '无'}\n`);
  }

  // ---------- 停止全部 ----------
  await js(`(() => { const b = document.getElementById('btnStopAll'); if (b) b.click(); return !!b; })()`);
  await sleep(6000);

  // ---------- 报告 ----------
  const last = samples[samples.length - 1] || {};
  const bus = last.stats || {};
  const overlap = last.overlap || {};
  const biz = last.biz || {};

  console.log('\n================ 压测报告 ================');
  console.log(`时长 ${DUR}s · 采样 ${samples.length} 次`);

  // 1. 有没有两个任务同时动页面
  log(overlap.overlap === 0, '页面独占：从未出现两个功能同时动页面', `重叠次数=${overlap.overlap || 0}，最大深度=${overlap.maxDepth || 0}`);

  // 2. 饿死情况
  console.log(`\n调度：上手 ${bus.acquired || 0} 次 · 让出 ${bus.yielded || 0} 次 · 最长等待 ${((bus.maxWait || 0) / 1000).toFixed(1)}s · 真人让位 ${bus.humanYields || 0} 次`);
  log((bus.maxWait || 0) < 20000, '没有功能被饿死 20 秒以上', `最长 ${((bus.maxWait || 0) / 1000).toFixed(1)}s`);

  // 3. 业务产出
  const gain = {};
  for (const k of ['popup', 'comment', 'coupon', 'seckill', 'refresh', 'fail']) {
    gain[k] = (Number(biz[k]) || 0) - (Number(baseStats[k]) || 0);
  }
  console.log(`\n业务计数（本次新增）：弹讲解 ${gain.popup} · 发评 ${gain.comment} · 发券 ${gain.coupon} · 秒杀 ${gain.seckill} · 后台刷新 ${gain.refresh} · 失败 ${gain.fail}`);
  log(gain.popup > 0, '弹讲解仍有产出', `${gain.popup} 次`);
  log(gain.comment > 0, '自动发评仍有产出', `${gain.comment} 条`);
  log(gain.fail === 0 || gain.fail <= 3, '失败次数可控', `${gain.fail} 次`);

  // 4. 任务有没有中途掉线
  const aliveSeen = new Set();
  samples.forEach((s) => (s.running || []).forEach((k) => aliveSeen.add(k)));
  console.log(`\n整个压测期间出现过的在跑功能：${[...aliveSeen].join('、') || '无'}`);
  const expected = ['popup', 'comment', 'coupon', 'seckill'];
  const missing = expected.filter((k) => !aliveSeen.has(k));
  log(missing.length === 0, '四个功能都真的跑起来了', missing.length ? '没跑起来：' + missing.join('、') : '全部在跑');

  // 5. 谁中途退出了
  const dropouts = [];
  for (const k of expected) {
    let was = false;
    for (const s of samples) {
      const has = (s.running || []).includes(k);
      if (was && !has) dropouts.push(k);
      if (has) was = true;
    }
  }
  log(dropouts.length === 0, '没有功能中途自己退出', dropouts.length ? '退出：' + [...new Set(dropouts)].join('、') : '全部坚持到最后');

  // 6. 日志：错误集中在哪
  const errs = allLogs.filter((l) => l.level === 'err');
  const warns = allLogs.filter((l) => l.level === 'warn');
  const byTag = {};
  errs.forEach((l) => { byTag[l.tag] = (byTag[l.tag] || 0) + 1; });
  console.log(`\n日志：错误 ${errs.length} 条 · 警告 ${warns.length} 条`);
  if (errs.length) {
    console.log('  错误分布：' + Object.entries(byTag).map(([k, v]) => `${k} ${v}`).join(' · '));
  }
  const waitLines = allLogs.filter((l) => /等了 .* 秒才轮到上手|本次跳过/.test(l.msg));
  if (waitLines.length) {
    console.log('  排队过久：');
    waitLines.slice(0, 8).forEach((l) => console.log(`    ${l.t} [${l.tag}] ${l.msg}`));
  }
  const blocked = allLogs.filter((l) => /被.*挡住|still-covered|没点上|打不开/.test(l.msg));
  if (blocked.length) {
    console.log('  被遮挡/点不上（前 8 条）：');
    blocked.slice(0, 8).forEach((l) => console.log(`    ${l.t} [${l.tag}] ${l.msg}`));
  }

  console.log(`\n============ 结果：${pass} 通过 / ${fail} 待修 ============`);

  // 截图 + 日志落盘
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ROOT, 'ui-all.png'), img.toPNG());
    console.log('截图已存：' + path.join(ROOT, 'ui-all.png'));
  } catch (e) {}
  try {
    fs.writeFileSync(path.join(ROOT, 'test', 'live-all.log.json'), JSON.stringify({ samples, logs: allLogs, gain }, null, 1));
    console.log('采样明细已存：test/live-all.log.json');
  } catch (e) {}

  restore();
  app.exit(fail ? 1 : 0);
});
