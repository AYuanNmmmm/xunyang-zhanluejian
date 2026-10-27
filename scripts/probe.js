/* 巡洋战略舰 · 真实页面结构抓取（抓取用，不参与打包）
 *
 * 用法：
 *   node scripts/probe.js                      # 默认打开 eos.douyin.com
 *   TARGET_URL=https://... node scripts/probe.js
 *
 * 行为：
 *   1. 用本机 Chrome + 独立 profile 启动（不影响你日常用的 Chrome）
 *   2. 你扫码登录、自己点进直播间中控台
 *   3. 每当页面地址变化 / 每 25 秒，自动 dump 一份 DOM 快照到 data/probe/
 *   4. latest.json 永远是最新一份；日志里会打印每份快照的概览
 *
 * 关闭：Ctrl+C，或直接关掉浏览器窗口。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'probe');
const PROFILE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'xunyang-probe');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const START_URL = process.env.TARGET_URL || 'https://eos.douyin.com/';

const { chromium } = require('playwright-core');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- 页面内执行：采集可交互元素 + 简化 DOM 树 ----------
function collectInFrame() {
  const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
      return true;
    } catch (e) { return false; }
  };
  const rectOf = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    } catch (e) { return null; }
  };
  const attrsOf = (el) => {
    const o = {};
    for (const a of Array.from(el.attributes || [])) {
      const n = a.name;
      if (n === 'style' || n === 'd' || n === 'srcset') continue;
      let v = a.value;
      if (n === 'class') v = String(v).slice(0, 200);
      else if (n === 'src' || n === 'href') v = String(v).slice(0, 120);
      else v = String(v).slice(0, 120);
      o[n] = v;
    }
    return o;
  };

  // 1) 可交互元素
  const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], [tabindex="0"], [data-e2e]';
  const interactive = [];
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll(INTERACTIVE)); } catch (e) { nodes = []; }
  for (const el of nodes) {
    if (interactive.length >= 500) break;
    if (!vis(el)) continue;
    const r = rectOf(el);
    if (!r || r[2] * r[3] < 40) continue; // 过滤极小节点
    interactive.push({
      tag: el.tagName.toLowerCase(),
      text: normText(el.textContent).slice(0, 80),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      attrs: attrsOf(el),
      rect: r
    });
  }

  // 2) 简化 DOM 树（保留结构 + 文本，砍掉噪音）
  let count = 0;
  const MAX = 5000;
  function walk(el, depth) {
    if (count >= MAX || depth > 14) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'link' || tag === 'meta') return null;
    if (!vis(el)) return null;
    count++;
    const kids = [];
    for (const c of Array.from(el.children || [])) {
      const k = walk(c, depth + 1);
      if (k) kids.push(k);
    }
    const ownText = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.nodeValue)
      .join(' ');
    const t = normText(ownText).slice(0, 60);
    const node = { tag };
    const id = el.getAttribute && el.getAttribute('id');
    const cls = el.getAttribute && el.getAttribute('class');
    const e2e = el.getAttribute && (el.getAttribute('data-e2e') || el.getAttribute('data-testid'));
    if (id) node.id = id;
    if (cls) node.cls = String(cls).slice(0, 160);
    if (e2e) node.e2e = e2e;
    const role = el.getAttribute && el.getAttribute('role');
    if (role) node.role = role;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') node.ce = 1;
    if (t) node.text = t;
    if (kids.length) node.kids = kids;
    return node;
  }
  let tree = null;
  try { tree = walk(document.body || document.documentElement, 0); } catch (e) { tree = null; }

  return {
    url: location.href,
    title: document.title,
    interactive,
    tree,
    counts: { interactive: interactive.length, treeNodes: count }
  };
}

// ---------- 抓取主流程 ----------
let seq = 0;
const seenUrls = new Set();

async function dump(page, reason) {
  const frames = page.frames();
  const out = {
    at: new Date().toISOString(),
    reason,
    pageUrl: page.url(),
    pageTitle: '',
    frameCount: frames.length,
    frames: []
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let info = { index: i, url: '', ok: false };
    try { info.url = f.url(); } catch (e) { info.url = ''; }
    if (!/^https?:/i.test(info.url)) { out.frames.push(info); continue; }
    try {
      const data = await f.evaluate(collectInFrame);
      Object.assign(info, { ok: true }, data);
      if (i === 0) out.pageTitle = data.title;
    } catch (e) {
      info.error = String((e && e.message) || e).slice(0, 200);
    }
    out.frames.push(info);
  }

  seq++;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const file = path.join(OUT_DIR, `${String(seq).padStart(2, '0')}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'latest.json'), JSON.stringify(out, null, 2));

  const ok = out.frames.filter((f) => f.ok);
  const total = ok.reduce((s, f) => s + (f.counts ? f.counts.interactive : 0), 0);
  console.log(`\n[快照 ${seq}] ${out.pageUrl}`);
  console.log(`  触发=${reason}  frame=${out.frameCount}  可交互元素=${total}`);
  ok.forEach((f) => {
    const c = f.counts || {};
    console.log(`   #${f.index} ${f.url.slice(0, 90)}  交互${c.interactive || 0} 节点${c.treeNodes || 0}`);
  });
  console.log(`  → ${path.relative(ROOT, file)}`);
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error('找不到 Chrome：' + CHROME);
    process.exit(1);
  }

  console.log('启动独立 Chrome（profile：' + PROFILE_DIR + '）');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });

  // 反自动化痕迹（风控层面更稳）
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (e) {}
  });

  const pages = ctx.pages();
  const page = pages.length ? pages[0] : await ctx.newPage();

  // 接管用户手动开的新标签
  ctx.on('page', async (p) => {
    console.log('[新标签] ' + p.url());
    p.on('framenavigated', () => {});
  });

  try {
    const cur = page.url();
    if (!/^https?:/i.test(cur) || cur === 'about:blank') {
      console.log('打开 ' + START_URL);
      await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
        console.log('打开失败（继续，你可以手动输地址）：' + e.message);
      });
    }
  } catch (e) {}

  console.log('\n请在这个 Chrome 里扫码登录，并点进直播间中控台。');
  console.log('页面地址一变我就自动抓一份，你也可以随时回来问我。\n');

  // 每 2 秒看一次所有标签的地址
  let lastSig = '';
  let lastDump = 0;
  setInterval(async () => {
    try {
      const all = ctx.pages().filter((p) => !p.isClosed());
      if (!all.length) return;
      // 选"最像后台"的那个：优先非空白、非登录页
      const active = all[all.length - 1];
      const sig = all.map((p) => p.url()).join(' | ');
      const now = Date.now();
      if (sig !== lastSig) {
        lastSig = sig;
        await dump(active, 'url-change');
        lastDump = now;
      } else if (now - lastDump > 25000) {
        await dump(active, 'interval');
        lastDump = now;
      }
    } catch (e) {}
  }, 2000);

  ctx.on('close', () => {
    console.log('浏览器已关闭，抓取结束。快照在 ' + OUT_DIR);
    process.exit(0);
  });
})();
