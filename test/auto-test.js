/* 自动化冒烟测试
 * 验证三件事：
 *   1. 能拿到 webview guest 的全部 frame（含 iframe）
 *   2. 注入的自动化库能在 iframe 内找到并读取元素
 *   3. window.open 被拦截，改为在内嵌页面导航，不产生第二个窗口
 *
 * 运行：先起本地服务（python -m http.server 8899 -d test），再
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe test/auto-test.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
  guestApi.setLib(loadLibSrc());
  console.log('[test] guest 已接管');
});

// 自带静态服务（端口被占用就复用外部已起的），测试不再依赖手动 python -m http.server
const TEST_PORT = 8899;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function startStaticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'host.html';
      const file = path.join(__dirname, rel);
      if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.on('error', (e) => resolve({ ok: false, reason: e.code }));
    srv.listen(TEST_PORT, '127.0.0.1', () => resolve({ ok: true, srv }));
  });
}

app.whenReady().then(async () => {
  const srv = await startStaticServer();
  if (!srv.ok) console.log(`[test] 本地服务未启动（${srv.reason}），沿用已有 8899 端口服务`);

  const win = new BrowserWindow({
    width: 1300, height: 900, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false }
  });

  win.loadFile(path.join(__dirname, 'host.html'));

  // 等 guest 起来
  let tries = 0;
  while (!guestApi.getGuest() && tries < 40) { await sleep(250); tries++; }
  const guest = guestApi.getGuest();
  if (!guest) { log(false, '获取 webview guest'); app.exit(1); return; }
  await sleep(2500);

  // ---- 1. frame 列表 ----
  const info = guestApi.frameInfo();
  log(info.count >= 2, '读到多个 frame（含 iframe）', `count=${info.count}`);
  (info.frames || []).forEach((f) => console.log(`        #${f.index} ${f.url}`));

  // ---- 2. iframe 内元素读取 ----
  const probe = await guestApi.runInFrames('(async()=>{ return window.__TP.probe("#comment-list"); })()');
  log(!!(probe && probe.found), '在 iframe 内找到 #comment-list', JSON.stringify(probe && probe.text));

  const list = await guestApi.runInFrames(
    '(async()=>{ return window.__TP.readList("#comment-list .c", ".txt", ".nick", 10); })()'
  );
  const arr = Array.isArray(list) ? list : [];
  log(arr.length === 3, '在 iframe 内读到 3 条评论', arr.map((x) => `${x.user}:${x.text}`).join(' | '));

  // ---- 3. 拾取能在 iframe 内启动 ----
  const pick = await guestApi.pickStart();
  log(pick.ok && pick.frames >= 2, '拾取已注入所有 frame', `frames=${pick.frames}`);
  await guestApi.pickStop();

  // ---- 4. 选择器写法（手填类名 / 多候选 / 文案 / XPath） ----
  const p1 = await guestApi.runInFrames('(async()=>{ return window.__TP.probe("live-buy-7Zq"); })()');
  log(!!(p1 && p1.found), '裸类名自动补点（live-buy-7Zq → .live-buy-7Zq）', p1 && (p1.matched + ' / ' + p1.text));

  const p2 = await guestApi.runInFrames(
    '(async()=>{ return window.__TP.probe(".not-exist-xxx\\n#send"); })()'
  );
  log(!!(p2 && p2.found) && p2.matchedIndex === 1, '多候选依次尝试，第二个命中', p2 && `matched=${p2.matched} idx=${p2.matchedIndex}/${p2.tried}`);

  const p3 = await guestApi.runInFrames('(async()=>{ return window.__TP.probe("class=live-card"); })()');
  log(!!(p3 && p3.found), 'class= 片段匹配（哈希后缀变了也能命中）', p3 && p3.cls);

  const p4 = await guestApi.runInFrames('(async()=>{ return window.__TP.probe("text=讲解"); })()');
  log(!!(p4 && p4.found) && p4.tag === 'BUTTON', 'text= 按文案找按钮', p4 && `<${p4.tag}>${p4.text}`);

  const p5 = await guestApi.runInFrames('(async()=>{ return window.__TP.probe("xpath=//*[@id=\\"send\\"]"); })()');
  log(!!(p5 && p5.found), 'XPath 写法', p5 && p5.matched);

  const p6 = await guestApi.runInFrames('(async()=>{ return window.__TP.count("[data-index]"); })()');
  log(p6 === 2, '带占位符的卡片容器可枚举', `count=${p6}`);

  // ---- 5. 页面元素扫描 ----
  const scan = await guestApi.scanAll(180);
  const hit = (scan.items || []).find((x) => x.tag === 'button' && (x.text || '').indexOf('讲解') >= 0);
  log(!!hit, '扫描能列出「讲解」按钮', hit && `${hit.selector} | ${hit.cls}`);
  log(!!(hit && hit.candidates && hit.candidates.indexOf('text=讲解') >= 0), '扫描结果自带 text= 候选', hit && hit.candidates.join(' / '));

  // ---- 6. 秒杀辅助（seckillScan / seckillForm / seckillSetNum） ----
  const skScan = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillScan(); })()');
  const skHit = skScan && skScan.ok && (skScan.items || []).find((s) => s.i === 4);
  log(!!skHit, 'seckillScan 扫到 4 号卡的秒杀入口', skHit && `#${skHit.i} ${skHit.name} @${skHit.x},${skHit.y}`);

  const skForm = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillForm(); })()');
  log(!!(skForm && skForm.ok) && !!(skForm.points && skForm.points.stock && skForm.points.stock.x > 0),
    'seckillForm 读到秒杀表单与坐标',
    skForm && skForm.ok ? `mode=${skForm.mode} stock=${skForm.stockValue} submitDisabled=${skForm.submitDisabled}` : (skForm && skForm.reason));

  const skSet = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillSetNum(0, 80); })()');
  log(!!(skSet && skSet.ok) && skSet.value === '80', 'seckillSetNum 写入投放库存', skSet && `value=${skSet.value}`);

  // ---- 6.4 剩余补充：状态读取 + 「编辑」入口 ----
  const skStatus = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillStatus(); })()');
  log(!!(skStatus && skStatus.ok) && skStatus.remain === 3,
    'seckillStatus 读到「剩余」数量', skStatus && `remain=${skStatus.remain} nums=${(skStatus.nums || []).join('/')}`);
  log(!!(skStatus && skStatus.hasEdit), 'seckillStatus 认出「编辑」入口（已投放态）', skStatus && `hasEdit=${skStatus.hasEdit}`);

  const skClick = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillClickText(["编辑","修改"]); })()');
  await sleep(200);
  const editClicked = await guestApi.runInFrames('(async()=>{ return document.getElementById("sk-edit").dataset.clicked || ""; })()');
  log(!!(skClick && skClick.ok) && editClicked === '1',
    'seckillClickText 能点中「编辑」（DOM 点击）', `${JSON.stringify(skClick)} → clicked=${editClicked}`);

  // ---- 6.44 置顶：按文本定位评论 + 悬停出操作 ----
  const cFind = await guestApi.runInFrames('(async()=>{ return window.__TP.commentItemByText("今晚双人票"); })()');
  log(!!(cFind && cFind.ok) && cFind.count === 2, 'commentItemByText 按内容找到刚发的那条', JSON.stringify({ ok: cFind && cFind.ok, idx: cFind && cFind.index, count: cFind && cFind.count }));

  // 先把指针挪到左上角，确保没有残留 hover
  await guestApi.realMove(3, 3);
  await sleep(400);
  const beforeHover = await guestApi.runInFrames('(async()=>{ return window.__TP.commentItemActions("今晚双人票"); })()');
  log(!(beforeHover && beforeHover.ok), '未悬停时读不到「置顶」（说明它确实是隐藏的）', JSON.stringify(beforeHover && beforeHover.reason));

  if (cFind && cFind.ok) {
    await guestApi.realMove(cFind.x, cFind.y);
    await sleep(700);
    const afterHover = await guestApi.runInFrames('(async()=>{ return window.__TP.commentItemActions("今晚双人票"); })()');
    const hasPin = !!(afterHover && afterHover.ok && (afterHover.actions || []).some((a) => /置顶/.test(a.t)));
    log(hasPin, '悬停后能读到「置顶」入口（CDP 移指针不抢鼠标）', JSON.stringify(afterHover && afterHover.actions && afterHover.actions[0]));
  } else {
    log(false, '悬停后能读到「置顶」入口（CDP 移指针不抢鼠标）', '上一步没找到条目');
  }

  const cLast = await guestApi.runInFrames('(async()=>{ return window.__TP.commentLastItem(); })()');
  log(!!(cLast && cLast.ok) && /今晚双人票/.test(String(cLast.text || '')), 'commentLastItem 取到最后一条评论', JSON.stringify(cLast && cLast.text));

  // ---- 6.46 置顶图标：hover-button 里第 1 个就是置顶 ----
  const hoverIcons = await guestApi.runInFrames('(async()=>{ return window.__TP.commentHoverIcons("今晚双人票"); })()');
  log(!!(hoverIcons && hoverIcons.ok) && hoverIcons.count === 2,
    'commentHoverIcons 读到悬停操作图标', JSON.stringify({ count: hoverIcons && hoverIcons.count, icons: hoverIcons && hoverIcons.icons }));
  log(!!(hoverIcons && hoverIcons.pin) && hoverIcons.pin.i === 0 && hoverIcons.pin.w > 2,
    '默认把第 1 个图标当作「置顶」', JSON.stringify(hoverIcons && hoverIcons.pin));

  // ---- 6.45 一键适配：分组识别名单（含今天新增的结构） ----
  const det = await guestApi.runInFrames('(async()=>{ return window.__TP.autoDetect(); })()');
  const detItems = (det && det.items) || [];
  const groups = Array.from(new Set(detItems.map((x) => x.group)));
  log(detItems.length >= 12 && groups.indexOf('秒杀') >= 0 && groups.indexOf('评论') >= 0,
    'autoDetect 输出分组识别名单', `groups=${groups.join('/')} items=${detItems.length}`);
  const detKeys = detItems.map((x) => x.key);
  log(['seckillEntry', 'seckillStock', 'seckillEdit', 'seckillDuration'].every((k) => detKeys.indexOf(k) >= 0),
    '识别名单包含今天新增的秒杀结构（入口/库存/编辑/时长）', detKeys.join(','));
  log(detItems.some((x) => x.key === 'seckillRemain' && x.found), '识别名单能认出「剩余」（投放库存−已卖）',
    JSON.stringify((detItems.find((x) => x.key === 'seckillRemain') || {}).sample || ''));
  const detDetail = await guestApi.runInFrames('(async()=>{ return window.__TP.seckillDetail(); })()');
  log(!!(detDetail && detDetail.ok) && detDetail.stock === 5 && detDetail.sold === 2 && detDetail.remain === 3,
    'seckillDetail 读出投放库存/已卖/剩余', JSON.stringify({ stock: detDetail && detDetail.stock, sold: detDetail && detDetail.sold, remain: detDetail && detDetail.remain, hasEdit: detDetail && detDetail.hasEdit }));

  // ---- 6.5 输入注入（CDP：可信事件，且不抢鼠标 / 不抢窗口焦点） ----
  const clickLoc = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#clickMe"); })()');
  if (clickLoc && clickLoc.ok) {
    const cr = await guestApi.realClick(clickLoc.x, clickLoc.y);
    await sleep(350);
    const n1 = await guestApi.runInFrames('(async()=>{ return document.getElementById("clickOut").textContent; })()');
    log(String(n1) === '1', 'CDP 注入点击能触发 onclick', `how=${cr && cr.how} → ${n1}`);
  } else {
    log(false, 'CDP 注入点击能触发 onclick', 'locate 失败');
  }

  const typeLoc = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#typeBox"); })()');
  if (typeLoc && typeLoc.ok) {
    const tr = await guestApi.realType(typeLoc.x, typeLoc.y, '测试abc');
    await sleep(400);
    const v = await guestApi.runInFrames('(async()=>{ return document.getElementById("typeBox").value; })()');
    log(String(v) === '测试abc', 'CDP 注入逐字输入（含中文）', `how=${tr && tr.how} → ${JSON.stringify(v)}`);
    const sub = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#submitBox"); })()');
    if (sub && sub.ok) {
      await guestApi.realClick(sub.x, sub.y);
      await sleep(300);
      const out = await guestApi.runInFrames('(async()=>{ return document.getElementById("submitOut").textContent; })()');
      log(String(out) === '测试abc', '点按钮后页面能读到输入值', JSON.stringify(out));
    }
  } else {
    log(false, 'CDP 注入逐字输入（含中文）', 'locate 失败');
  }

  // ---- 6.6 视口外元素：滚动到可见再操作（链接/商品多了以后的关键能力） ----
  // ① 先滚回顶部，确认底部按钮真的在画面外
  await guestApi.runInFrames('(async()=>{ window.scrollTo(0,0); document.getElementById("longlist").scrollTop = 0; return {ok:true}; })()');
  await sleep(300);
  const geo0 = await guestApi.runInFrames(
    '(async()=>{ const r = document.getElementById("deepBtn").getBoundingClientRect(); return { top: Math.round(r.top), vh: window.innerHeight }; })()'
  );
  log(!!(geo0 && geo0.top > geo0.vh), '未滚动时底部按钮确实在视口外', geo0 && `top=${geo0.top} vh=${geo0.vh}`);

  // ② locate 会先滚动再量坐标 —— 这是「不在画面里也能点」的核心
  const deepAfter = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#deepBtn"); })()');
  log(!!(deepAfter && deepAfter.ok), 'locate 自动滚动后能定位到页面最底部的按钮',
    deepAfter && `x=${deepAfter.x} y=${deepAfter.y}`);
  const geo1 = await guestApi.runInFrames(
    '(async()=>{ const r = document.getElementById("deepBtn").getBoundingClientRect(); return { top: Math.round(r.top), vh: window.innerHeight }; })()'
  );
  log(!!(geo1 && geo1.top >= 0 && geo1.top < geo1.vh), '定位后元素已经滚进视口', geo1 && `top=${geo1.top} vh=${geo1.vh}`);

  if (deepAfter && deepAfter.ok) {
    await guestApi.realClick(deepAfter.x, deepAfter.y);
    await sleep(350);
    const out = await guestApi.runInFrames('(async()=>{ return document.getElementById("deepOut").textContent; })()');
    log(String(out) === 'clicked', '滚出画面外的按钮也能真实点中', JSON.stringify(out));
  }

  // ③ 内部滚动容器（商品列表就是这种）：最后一行在容器外
  const rowLoc = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#rowBtn60"); })()');
  log(!!(rowLoc && rowLoc.ok), '内部滚动容器的最后一行也能定位（先滚容器再量）', rowLoc && `x=${rowLoc.x} y=${rowLoc.y}`);

  const revealIn = await guestApi.runInFrames('(async()=>{ return window.__TP.revealIn("#longlist", "#rowBtn1"); })()');
  log(!!(revealIn && revealIn.ok) && revealIn.inView, 'revealIn 能把容器内元素滚回可见',
    JSON.stringify(revealIn && { moved: revealIn.moved, inView: revealIn.inView }));

  const loadAll = await guestApi.runInFrames('(async()=>{ return await window.__TP.loadAll("#longlist", 3, 150); })()');
  log(!!(loadAll && loadAll.ok), 'loadAll 能滚动列表把条目都加载出来',
    JSON.stringify(loadAll && { steps: loadAll.steps, nodes: loadAll.nodes }));

  // ---- 6.7 真人操作探测（PageBus 靠它让位） ----
  // 页面侧只能看到「可信事件」，CDP 注入的也是可信事件，所以注入前会 markInject 打时间窗，
  // 窗口内的事件算自己发的。下面分别验证：打了标记的不算、没打标记的算真人。
  await sleep(2600);   // 等之前的注入效果过期
  const humanA = await guestApi.runInFrames('(async()=>{ return window.__TP.humanInfo(); })()');
  const ageA = Number(humanA && humanA.age);

  const btnLoc = await guestApi.runInFrames('(async()=>{ return window.__TP.locate("#deepBtn"); })()');
  if (btnLoc && btnLoc.ok) {
    await guestApi.runInFrames('(async()=>{ window.__TP.markInject(2500); return {ok:true}; })()');
    await guestApi.realClick(btnLoc.x, btnLoc.y);
    await sleep(250);
    const a1 = await guestApi.runInFrames('(async()=>{ return window.__TP.humanInfo(); })()');
    log(Number(a1 && a1.age) >= ageA, '打了注入标记的点击不会被当成真人操作',
      `age ${ageA} → ${a1 && a1.age}`);

    await sleep(2600);   // 注入窗口过期
    await guestApi.realClick(btnLoc.x, btnLoc.y);
    await sleep(250);
    const a2 = await guestApi.runInFrames('(async()=>{ return window.__TP.humanInfo(); })()');
    log(Number(a2 && a2.age) < 1200, '没打标记的可信点击会被认成真人操作',
      `age=${a2 && a2.age} kind=${a2 && a2.kind}`);
  }


  // ---- 7. 弹窗拦截 ----
  const winCountBefore = BrowserWindow.getAllWindows().length;
  await guestApi.runInFrames('(async()=>{ window.open("popup.html","_blank"); return {ok:true}; })()');
  await sleep(2000);
  const urlAfter = guestApi.getGuest().getURL();
  const winCountAfter = BrowserWindow.getAllWindows().length;
  log(urlAfter.indexOf('popup.html') >= 0, 'window.open 被改写成内嵌导航', urlAfter);
  log(winCountAfter === winCountBefore, '没有产生额外的浏览器窗口', `${winCountBefore} → ${winCountAfter}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail === 0 ? 0 : 1);
});
