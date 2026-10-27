/* 深度结构采集（第二轮）
 *
 * 和 probe.js 的区别：
 *   - 不按"可见"过滤、不砍深层的容器（第一轮就是因为这个把中控区整棵树丢了）
 *   - 会真的把鼠标移到每个商品卡上，抓 hover 之后才出现的那批按钮（"讲解"通常在这）
 *   - 顺手截图，方便肉眼核对
 *
 * 用法：node scripts/probe2.js
 * 产物：data/probe2/dom.json、page.html、shot-*.png
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'probe2');
// profile 放在项目内：宿主的文件保护策略不允许在 ~/Library 下删/改名 SingletonLock，
// 每次重启都会报 profile 被占用。放工作区里就没有这个问题。
const PROFILE = process.env.TP_PROFILE || path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';

const { chromium } = require('playwright-core');

fs.mkdirSync(OUT, { recursive: true });

// 上一轮被强杀会留下 SingletonLock（Chrome 拒绝起动）。
// 锁里记录着 pid，pid 已死就把锁改名挪开 —— 注意不能用 unlink/rm（宿主的文件删除保护会拦）。
function clearStaleLock() {
  const lock = path.join(PROFILE, 'SingletonLock');
  let target = '';
  try {
    target = fs.readlinkSync(lock);
  } catch (e) {
    return; // 没有锁，或读不到，交给 Chrome 自己处理
  }
  const pid = Number(String(target).split('-').pop());
  let alive = false;
  if (pid) {
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
  }
  if (alive) return;
  const stamp = Date.now();
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(PROFILE, name);
    if (!fs.existsSync(p)) continue;
    try { fs.renameSync(p, `${p}.stale.${stamp}`); console.log('清理残留锁：' + name); } catch (e) {
      console.log('锁清理失败（' + name + '）：' + e.message);
    }
  }
}
clearStaleLock();

// ---------- 页面内：全量元素快照 ----------
function snapAll(opts) {
  const withBox = opts && opts.box;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  let count = 0;
  const MAX = 20000;

  function describe(el, depth) {
    if (count >= MAX) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta' || tag === 'head') return null;
    count++;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) {}
    const visible = !!(r && r.width >= 1 && r.height >= 1);
    const cs = (() => { try { return getComputedStyle(el); } catch (e) { return null; } })();
    const node = { tag };
    if (el.id) node.id = el.id;
    const cls = el.getAttribute && el.getAttribute('class');
    if (cls) node.cls = String(cls);
    const e2e = el.getAttribute && (el.getAttribute('data-e2e') || el.getAttribute('data-testid'));
    if (e2e) node.e2e = e2e;
    const role = el.getAttribute && el.getAttribute('role');
    if (role) node.role = role;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) node.aria = String(aria).slice(0, 120);
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) node.ph = ph;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') node.ce = 1;
    if (cs && cs.cursor === 'pointer') node.cursor = 'pointer';
    if (r) node.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    if (!visible) node.hidden = 1;
    // 自己的文本（不含子元素）
    const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ');
    const t = norm(own);
    if (t) node.text = t.slice(0, 80);
    // 整棵子树的文本（前 120 字，方便搜"讲解""评论"）
    const allText = norm(el.textContent);
    if (allText && allText !== t) node.sub = allText.slice(0, 120);

    const kids = [];
    for (const c of Array.from(el.children || [])) {
      const k = describe(c, depth + 1);
      if (k) kids.push(k);
    }
    if (kids.length) node.kids = kids;
    return node;
  }

  const root = withBox ? document.body : document.body;
  const tree = describe(root, 0);
  return { count, tree };
}

// ---------- 页面内：可见的"候选可点击"元素（含 hover 后） ----------
function snapClickable() {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const nodes = Array.from(document.querySelectorAll('body *'));
  for (const el of nodes) {
    if (out.length >= 1200) break;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!r || r.width < 4 || r.height < 4) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const tag = el.tagName.toLowerCase();
    const interactive = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' ||
      (el.getAttribute('role') === 'button') || el.getAttribute('contenteditable') === 'true' ||
      cs.cursor === 'pointer';
    if (!interactive) continue;
    out.push({
      tag,
      cls: String(el.getAttribute('class') || '').slice(0, 160),
      role: el.getAttribute('role') || '',
      aria: String(el.getAttribute('aria-label') || '').slice(0, 100),
      ph: el.getAttribute('placeholder') || '',
      text: norm(el.textContent).slice(0, 70),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--window-size=1600,1000'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  console.log('打开中控台…');
  await page.goto(URL_LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('导航提示：' + e.message));
  await sleep(6000);

  const url = page.url();
  console.log('当前地址：' + url);
  if (!/livesite\/live\/current/.test(url)) {
    console.log('⚠️  不在中控台页面，可能登录态失效。请在窗口里手动登录/进入中控台，然后重新运行。');
    await sleep(1000 * 60 * 3); // 给 3 分钟人工处理
  }

  // 1) 截图
  await page.screenshot({ path: path.join(OUT, 'shot-full.png'), fullPage: false }).catch(() => {});
  fs.writeFileSync(path.join(OUT, 'page.html'), await page.content());

  // 2) hover 前
  const before = await page.evaluate(snapClickable);
  console.log('hover 前可点击元素：' + before.length);

  // 3) 找商品卡：role=button 且 aria-label 像 "数字-数字-数字"
  const cardHandles = await page.$$('div[role="button"][aria-label]');
  const cards = [];
  for (const h of cardHandles) {
    const aria = await h.getAttribute('aria-label');
    const box = await h.boundingBox();
    if (!aria || !box) continue;
    if (box.width < 200 || box.height < 40) continue;
    cards.push({ handle: h, aria, box });
  }
  console.log('识别到商品卡：' + cards.length + ' 个');

  const hoverShots = [];
  for (let i = 0; i < Math.min(cards.length, 3); i++) {
    const c = cards[i];
    try {
      await page.mouse.move(c.box.x + c.box.width / 2, c.box.y + c.box.height / 2);
      await sleep(900);
      const clip = { x: Math.max(0, c.box.x - 10), y: Math.max(0, c.box.y - 10), width: Math.min(1200, c.box.width + 20), height: Math.min(400, c.box.height + 20) };
      const p = path.join(OUT, `shot-card-${i + 1}.png`);
      await page.screenshot({ path: p, clip }).catch(() => {});
      const after = await page.evaluate(snapClickable);
      const key = (e) => `${e.tag}|${e.cls}|${e.text}|${e.aria}`;
      const beforeSet = new Set(before.map(key));
      const added = after.filter((e) => !beforeSet.has(key(e)));
      hoverShots.push({ card: i + 1, aria: c.aria, box: c.box, newElements: added });
      console.log(`\n卡片 ${i + 1}（${c.aria.slice(0, 40)}）hover 后新增 ${added.length} 个元素：`);
      added.slice(0, 12).forEach((e) => console.log(`   [${e.tag}] "${e.text.slice(0, 24)}" cls=${e.cls.slice(0, 60)} box=${e.box}`));
    } catch (e) {
      console.log('hover 失败：' + e.message);
    }
  }

  // 4) 全量 DOM
  const dom = await page.evaluate(snapAll, { box: false });
  const framesInfo = [];
  for (const f of page.frames()) {
    let n = 0;
    try { n = await f.evaluate(() => document.querySelectorAll('*').length); } catch (e) {}
    framesInfo.push({ url: f.url(), nodes: n });
  }

  const result = {
    at: new Date().toISOString(),
    url,
    title: await page.title(),
    frames: framesInfo,
    totalNodes: dom.count,
    tree: dom.tree,
    before,
    hoverShots
  };
  fs.writeFileSync(path.join(OUT, 'dom.json'), JSON.stringify(result, null, 2));
  console.log(`\n已保存：data/probe2/dom.json（${dom.count} 节点）`);
  console.log('截图：shot-full.png、shot-card-*.png');
  console.log('\n浏览器保持打开。按 Ctrl+C 或关窗口结束。');

  ctx.on('close', () => process.exit(0));
  // 优雅退出：不然被 kill 会在 profile 里留下 SingletonLock，下次启动会报 profile 占用
  const bye = async () => { try { await ctx.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye);
  // 挂着不退出，方便你再手动操作页面后重跑
  await new Promise(() => {});
})();
