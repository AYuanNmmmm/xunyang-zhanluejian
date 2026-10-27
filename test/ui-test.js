/* 界面冒烟测试
 * 验证：
 *   1. 应用名 / 标题是「巡洋战略舰」
 *   2. 顶部运行栏存在（空闲态）
 *   3. 每个功能面板都有独立的「开始」+「停止」按钮
 *   4. 评论组支持多条独立评论（添加/删除）
 *   5. 优惠券页有「扫描券」+ 后台档位小圆点（10/50/100/500/1000/全部库存）
 *   6. 秒杀投放方式切换：定时投放出现时间字段，立即投放出现时长
 *   7. 高级页 = 一键分析后台，能应用探测结果
 *   8. 配置落盘、渲染无报错
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/ui-test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DETECT_RESULT = {
  ok: true,
  good: 4,
  items: [
    { key: 'card', label: '商品卡片', found: true, selector: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[{{n}}]', sample: '4 张卡' },
    { key: 'commentInput', label: '评论输入框', found: true, selector: 'textarea[placeholder*="输入评论"]\n[class*="comment-wrap"] textarea', sample: '输入评论，Enter键发送' },
    { key: 'commentItem', label: '评论列表条目', found: false, selector: '', sample: '' },
    { key: 'couponEntry', label: '优惠券入口', found: true, selector: 'text=优惠券', sample: '优惠券' },
    { key: 'seckillEntry', label: '秒杀入口', found: true, selector: '[class*="seckill-btn-container"]', sample: '1 个商品有闪电按钮' }
  ]
};

let savedConfig = null;
let lastCall = '';

// 界面测试不碰真实页面：用「当前页面」模式，免得 boot 去预热后台页（会联网加载抖音）
ipcMain.handle('config:load', () => ({ engine: { mode: 'current', prewarm: false } }));
ipcMain.handle('config:save', (_e, data) => { savedConfig = data; return { ok: true }; });
ipcMain.handle('config:path', () => 'test/config.json');
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('mem:info', () => ({ ok: true, list: [{ type: 'Browser', mb: 120 }, { type: 'Renderer', name: '后台页', mb: 620 }, { type: 'Renderer', name: '主界面', mb: 480 }, { type: 'GPU', mb: 90 }], total: 1310 }));
ipcMain.handle('guest:setLib', () => ({ ok: true, size: 1 }));
ipcMain.handle('guest:probe', () => ({ found: false, reason: 'no-worker-in-ui-test' }));
ipcMain.handle('guest:call', (_e, code) => {
  lastCall = String(code || '');
  if (lastCall.indexOf('autoDetect') >= 0) return DETECT_RESULT;
  // 启动前「回中控台」的探测：stub 里直接当作已就位，别让测试去等真实导航
  if (lastCall.indexOf('.probe(') >= 0) return { found: true, tag: 'DIV', text: 'stub' };
  // 模拟「后台页还没就绪」：这正是会误判成页面故障的那个返回
  if (lastCall.indexOf('apiLiveStatus') >= 0) return { ok: false, reason: 'guest-not-ready' };
  return { ok: false, reason: 'stub' };
});
ipcMain.handle('guest:pickStart', () => ({ ok: true, frames: 1 }));
ipcMain.handle('guest:pickPoll', () => ({ ok: true, picking: true, picked: null }));
ipcMain.handle('guest:pickStop', () => ({ ok: true }));
ipcMain.handle('guest:frames', () => ({ ok: true, count: 1, frames: [{ index: 0, main: true, url: 'stub' }] }));
ipcMain.handle('guest:scan', () => ({ ok: true, frames: 2, count: 0, items: [] }));

app.setName('巡洋战略舰');
app.setPath('userData', path.join(__dirname, '.ui-test-userdata'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true
    }
  });

  const errors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level !== 'error' && e.level !== 3) return;
    // 内嵌页面导航被打断属于网络/环境现象，不算渲染层 bug
    if (/ERR_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|loading 'https?:/.test(String(e.message))) return;
    errors.push(e.message);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await sleep(1800);

  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (e) {
      console.log('SCRIPT-ERR →', String(code).slice(0, 120).replace(/\n/g, ' '), '||', e.message);
      console.log('RENDER-CONSOLE →', errors.slice(-4).join(' || ').slice(0, 600));
      throw e;
    }
  };

  // 1. 名称
  const title = await js('document.title');
  const brand = await js('document.querySelector(".brand").textContent');
  log(title === '巡洋战略舰', '窗口标题是巡洋战略舰', title);
  log(brand.indexOf('巡洋战略舰') === 0, '左上角品牌名', brand);

  // 2. 运行栏
  const runbar = await js('!!document.getElementById("runBar") && document.getElementById("runBar").textContent');
  log(/空闲|未运行/.test(runbar), '顶部运行栏存在（空闲态）', runbar);

  // 2.5 站点下拉默认选第一个预设，而不是「自定义地址」
  const siteInit = await js('document.getElementById("siteSelect").value');
  log(siteInit === 'https://eos.douyin.com/', '站点下拉默认选第一个预设（非自定义）', siteInit);
  await js(`(() => {
    const sel = document.getElementById('siteSelect');
    sel.value = 'https://life.douyin.com/';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(400);
  log(savedConfig && savedConfig.view && savedConfig.view.siteKey === 'https://life.douyin.com/',
    '上次选过的站点会记住', String(savedConfig && savedConfig.view && savedConfig.view.siteKey));

  // 3. 每个面板都有独立的开始+停止按钮
  for (const tab of ['popup', 'comment', 'coupon']) {
    await js(`document.querySelector('.nav-item[data-tab="${tab}"]').click()`);
    await sleep(200);
    const ctl = await js(`(() => {
      const row = document.querySelector('.run-ctl');
      if (!row) return 'none';
      const s = row.querySelector('[data-action^="start-"]');
      const p = row.querySelector('[data-action^="stop-"]');
      return s && p && s.disabled === false && p.disabled === true ? 'ok' : 'bad:' + (s ? 's' : '') + (p ? 'p' : '');
    })()`);
    log(ctl === 'ok', `${tab} 面板有独立开始/停止按钮`, ctl);
  }

  // 4. 评论组多条独立评论
  await js('document.querySelector(\'.nav-item[data-tab="comment"]\').click()');
  await sleep(200);
  await js('document.querySelector(\'[data-action="new-comment-group"]\').click()');
  await sleep(200);
  await js('document.querySelector(\'[data-action="add-comment-item"]\').click()');
  await js('document.querySelector(\'[data-action="add-comment-item"]\').click()');
  await sleep(200);
  let n = await js('document.querySelectorAll("[data-action=\'del-comment-item\']").length');
  log(n === 3, '评论组里可添加多条独立评论', `rows=${n}`);
  await js('document.querySelector(\'[data-action="del-comment-item"]\').click()');
  await sleep(150);
  n = await js('document.querySelectorAll("[data-action=\'del-comment-item\']").length');
  log(n === 2, '单条评论可删除', `rows=${n}`);

  // 5. 优惠券页
  await js('document.querySelector(\'.nav-item[data-tab="coupon"]\').click()');
  await sleep(200);
  const couponUi = await js(`(() => {
    const scan = !!document.querySelector('[data-action="coupon-scan"]');
    const chips = document.querySelectorAll('input[name="coupon-count"]').length;
    const durChips = document.querySelectorAll('input[name="coupon-duration"]').length;
    return { scan, chips, durChips };
  })()`);
  log(couponUi.scan, '优惠券页有「↻ 只扫券」按钮（单项补抓）');
  log(couponUi.chips === 6, '数量档位与后台小圆点一致（10/50/100/500/1000/全部库存）', `chips=${couponUi.chips}`);
  log(couponUi.durChips === 4, '发券时长同为小圆点（1/3/5/10 分钟）', `chips=${couponUi.durChips}`);
  const chipSave = await js(`(() => {
    const c = document.querySelector('input[name="coupon-count"][data-v="100"]');
    if (!c) return 'missing';
    c.click();
    // radio 的监听挂在 input 上（click 只在未选中时有原生事件，重复跑会漏），两个都补一遍
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  log(chipSave && savedConfig && Number(savedConfig.coupon.count) === 100, '点档位即写入配置', String(savedConfig && savedConfig.coupon.count));

  // 6. 秒杀投放方式（默认定时投放：选开始时间档位 + 时长，都由程序在日历上点）
  await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
  await sleep(200);
  const schedDefault = await js(`(() => ({
    startDate: !!document.querySelector('input[type="date"][data-bind="seckill.startDate"]'),
    endDate: !!document.querySelector('input[type="date"][data-bind="seckill.endDate"]'),
    hSelects: document.querySelectorAll('select[data-bind="seckill.startH"],select[data-bind="seckill.endH"]').length,
    mSelects: document.querySelectorAll('select[data-bind="seckill.startM"],select[data-bind="seckill.endM"]').length,
    hOptions: document.querySelector('select[data-bind="seckill.startH"]') ? document.querySelector('select[data-bind="seckill.startH"]').options.length : 0,
    mOptions: document.querySelector('select[data-bind="seckill.startM"]') ? document.querySelector('select[data-bind="seckill.startM"]').options.length : 0,
    dur: !!document.querySelector('[data-bind="seckill.durationMin"]')
  }))()`);
  log(schedDefault.startDate && schedDefault.endDate, '定时投放有「开始/结束」日期选择', JSON.stringify(schedDefault));
  log(schedDefault.hSelects === 2 && schedDefault.mSelects === 2 && schedDefault.hOptions === 24 && schedDefault.mOptions === 60,
    '时/分是固定下拉（24 小时 / 60 分，不循环）', JSON.stringify(schedDefault));
  log(!schedDefault.dur, '定时投放不再显示时长档位（时长由结束时间决定）', JSON.stringify(schedDefault));

  // 整天快捷：今天 / 明天 / 后天
  const dayBtns = await js('document.querySelectorAll(\'[data-action="seckill-day"]\').length');
  log(dayBtns === 3, '有「今天/明天/后天整天」快捷按钮', `count=${dayBtns}`);
  await js('document.querySelector(\'[data-action="seckill-day"][data-offset="1"]\').click()');
  await sleep(400);
  const tmr = await js(`(() => {
    const d = document.querySelector('input[data-bind="seckill.startDate"]').value;
    const h = document.querySelector('select[data-bind="seckill.startH"]').value;
    const m = document.querySelector('select[data-bind="seckill.startM"]').value;
    return d + ' ' + h + ':' + m;
  })()`);
  const d = new Date(); d.setDate(d.getDate() + 1);
  const p2 = (n) => String(n).padStart(2, '0');
  const want = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} 00:00`;
  log(tmr === want, '点「明天整天」把开始时间设为明天 00:00', `${tmr} vs ${want}`);
  await js(`(() => {
    const sel = document.querySelector('[data-bind="seckill.mode"]');
    sel.value = 'now';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const nowMode = await js(`(() => ({
    start: !!document.querySelector('[data-bind="seckill.startAt"]'),
    dur: !!document.querySelector('[data-bind="seckill.durationMin"]')
  }))()`);
  log(!nowMode.start && nowMode.dur, '切到立即投放后隐藏投放时间、显示时长档位', JSON.stringify(nowMode));
  await js(`(() => {
    const sel = document.querySelector('[data-bind="seckill.mode"]');
    sel.value = 'sched';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(250);

  // 7. 高级页一键适配
  await js('document.querySelector(\'.nav-item[data-tab="selectors"]\').click()');
  await sleep(200);
  await js('document.querySelector(\'[data-action="auto-detect"]\').click()');
  await sleep(2600);
  const detectRows = await js('document.querySelectorAll(".detect-row").length');
  log(detectRows === DETECT_RESULT.items.length, '一键分析渲染探测结果', `rows=${detectRows}`);
  await sleep(400);
  // A 档重构：唯一总入口挪到商品页，高级页只留结构分析
  const advSync = await js('!!document.querySelector(\'[data-action="sync-all"]\')');
  log(!advSync, '高级页不再重复放「同步全部」（只留结构分析）', advSync ? '仍然存在' : '已移除');
  const advDetect = await js('!!document.querySelector(\'[data-action="auto-detect"]\')');
  log(advDetect, '高级页只保留「🔍 只分析结构」');

  await js('document.querySelector(\'.nav-item[data-tab="goods"]\').click()');
  await sleep(300);
  const goodsEntry = await js(`(() => {
    const sync = document.querySelector('[data-action="sync-all"]');
    const one = document.querySelector('[data-action="fetch-goods"]');
    const scan = document.querySelector('[data-action="seckill-scan"]');
    const card = document.getElementById('syncBody');
    const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
    return {
      hasSync: !!sync, syncTxt: txt(sync),
      oneTxt: txt(one), scanTxt: txt(scan),
      card: txt(card).slice(0, 30)
    };
  })()`);
  log(goodsEntry.hasSync, '商品页有唯一总入口「⚡ 同步全部」', goodsEntry.syncTxt);
  log(/^(↻|⟳)/.test(goodsEntry.oneTxt) && /^(↻|⟳)/.test(goodsEntry.scanTxt),
    '零散抓取按钮统一成小图标 + 只做单项', `商品=「${goodsEntry.oneTxt}」 秒杀=「${goodsEntry.scanTxt}」`);
  log(/还没同步|上次同步/.test(goodsEntry.card), '结果卡挂在商品页顶部（空态或上次结果）', goodsEntry.card);

  // 内存面板（设置页）：能列出各进程占用，且两个页面有名字
  await js('document.querySelector(\'.nav-item[data-tab="settings"]\').click()');
  await sleep(400);
  const mem = await js(`(() => {
    const box = document.getElementById('memBody');
    const rows = box ? box.querySelectorAll('.kv-row').length : 0;
    const txt = box ? box.innerText.replace(/\\s+/g, ' ') : '';
    return { rows, txt: txt.slice(0, 120), hasClean: !!document.querySelector('[data-action="mem-clean"]'),
             hasRebuild: !!document.querySelector('[data-action="mem-rebuild"]') };
  })()`);
  log(mem.rows >= 4, '设置页内存面板能按进程列出占用', `rows=${mem.rows} · ${mem.txt}`);
  log(/后台页/.test(mem.txt) && /合计/.test(mem.txt), '后台页与主界面分别标注、并给出合计', /后台页/.test(mem.txt) ? '已标注' : '没标注');
  log(mem.hasClean && mem.hasRebuild, '有「清理内存缓存」与「重建后台页」两个回收动作');

  const applied = savedConfig && savedConfig.selectors && savedConfig.selectors.commentInput;
  log(!!applied && applied.indexOf('textarea') === 0, '探测到的选择器已应用', String(applied || '').split('\n')[0]);

  // 8. 配置落盘
  log(!!(savedConfig && savedConfig.comment && savedConfig.comment.groups.length), '配置已提交保存');

  // 9. 多任务调度：两个任务抢同一个页面时，绝不能同时在临界区里
  const sched = await js(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let inside = 0, maxInside = 0, done = 0, order = [];
    const step = (tag) => window.__debug.withPage('T' + tag, async () => {
      inside++; maxInside = Math.max(maxInside, inside);
      order.push(tag);
      await sleep(35);
      inside--; done++;
    });
    const run = async (tag, n) => { for (let i = 0; i < n; i++) await step(tag); };
    await Promise.all([run('A', 6), run('B', 6)]);
    return { maxInside, done, order: order.join(''), stats: window.__debug.sched().stats };
  })()`);
  log(!!sched && sched.maxInside === 1, '两个任务同时开时页面操作严格串行（不会互相抢）',
    sched && `最多同时 ${sched.maxInside} 个 · 完成 ${sched.done} 次 · 顺序 ${sched.order}`);
  log(!!sched && sched.done === 12, '排队中的任务一个都不会丢', sched && `done=${sched.done}`);

  const schedCfg = await js('window.__debug.schedCfg()');
  log(!!schedCfg && schedCfg.humanYield === true, '真人操作自动让位默认开启', JSON.stringify(schedCfg));

  // 10. 止血回归：只读接口抢不到页面时，绝不能把后台页判成故障（否则会一直自刷）
  const quiet = await js(`(async () => {
    __debug.Data.stopAuto();
    __debug.engineMode('background');            // 给后台页判定的那条路径才做故障累计
    const before = __debug.pageFails();
    // ① quiet：模拟实时数据/保活失败
    await __debug.callRaw('apiLiveStatus', [], { quiet: true });
    await __debug.callRaw('apiLiveStatus', [], { quiet: true });
    const afterQuiet = __debug.pageFails();
    // ② 非 quiet：真的任务失败必须还能记账（安全网不能被一起关掉）
    await __debug.callRaw('apiLiveStatus', []);
    const afterLoud = __debug.pageFails();
    // ③ 页没就绪时 Data.pull 直接跳过，不发请求
    const pulled = await __debug.Data.pull();
    const afterPull = __debug.pageFails();
    __debug.engineMode('current');
    return { before, afterQuiet, afterLoud, afterPull, err: (pulled && pulled.err) || '' };
  })()`);
  log(!!quiet && quiet.afterQuiet.calls === quiet.before.calls,
    '只读接口失败不计入「页面故障」（不会触发自刷）',
    quiet && `quiet 两次：故障判定被调用 ${quiet.before.calls}→${quiet.afterQuiet.calls} 次 · task ${quiet.before.task}→${quiet.afterQuiet.task}`);
  log(!!quiet && quiet.afterLoud.calls > quiet.afterQuiet.calls,
    '真任务的失败仍然照常记账（安全网还在）',
    quiet && `普通调用一次：故障判定被调用 ${quiet.afterQuiet.calls}→${quiet.afterLoud.calls} 次`);
  log(!!quiet && /还没就绪/.test(quiet.err), '后台页未就绪时实时数据直接跳过，不敲页面', quiet && quiet.err);
  log(!!quiet && quiet.afterPull.task === quiet.afterLoud.task, '跳过时不产生任何故障记账',
    quiet && `task ${quiet.afterLoud.task}→${quiet.afterPull.task}`);

  // 11. 回归：官方弹层礼让绝不能把调度永久卡死（抖音关掉的抽屉会留下 DOM，容易被误判成"一直开着"）
  const yieldTest = await js(`(async () => {
    const PB = __debug.PageBus;
    const orig = PB.drawerBusy;
    const real = PB.drawerBusy.bind(PB);
    // ① 弹层一直"开着"，但把上限调到 300ms：必须放行，不能无限等
    __debug.setDrawerYieldMax(300);
    PB.drawerBusy = async () => ({ why: 'stub-modal', el: 'x' });
    PB.drawerSince = 0;
    PB.drawerForced = 0;
    let got = false;
    const t0 = Date.now();
    await Promise.race([
      __debug.withPage('礼让测试', async () => { got = true; }, { prio: 9 }),
      new Promise((r) => setTimeout(r, 4000))
    ]);
    const ms = Date.now() - t0;
    // ② 关掉开关 → 应立刻放行，一次都不等
    PB.drawerSince = 0;
    __debug.setDrawerYieldMax(30000);
    const cfgApi = (window.__TP_CFG_API_PROBE__ = null);
    __debug.setDrawerYield(false);
    PB.drawerBusy = async () => ({ why: 'stub-modal', el: 'x' });
    let got2 = false;
    const t1 = Date.now();
    await Promise.race([
      __debug.withPage('礼让关闭测试', async () => { got2 = true; }, { prio: 9 }),
      new Promise((r) => setTimeout(r, 2500))
    ]);
    const ms2 = Date.now() - t1;
    __debug.setDrawerYield(true);
    PB.drawerBusy = real;
    PB.drawerSince = 0;
    return { got, ms, got2, ms2 };
  })()`);
  log(!!yieldTest && yieldTest.got === true,
    '弹层一直"开着"时也会超时放行，不会永久卡死调度',
    yieldTest && `等了 ${yieldTest.ms}ms 后拿到页面锁（上限 300ms）`);
  log(!!yieldTest && yieldTest.got2 === true && yieldTest.ms2 < 800,
    '关掉「官方抽屉打开时让位」后立刻放行',
    yieldTest && `${yieldTest.ms2}ms 拿到锁`);

  // 12. 无渲染报错
  log(errors.length === 0, '渲染进程无报错', errors.slice(0, 3).join(' | '));

  try {
    win.showInactive();
    await sleep(500);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'preview-advanced.png'), img.toPNG());
    console.log('       截图已存：preview-advanced.png');
  } catch (e) {
    console.log('       截图失败：' + e.message);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail === 0 ? 0 : 1);
});
