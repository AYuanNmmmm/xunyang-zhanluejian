/* 直播中即时抓取：评论区结构 + 优惠券面板结构
 *
 * 和 probe-comments / probe-coupon 的区别：不傻等、抓完自动退出。
 *  - 评论区：评论已经发出，直接 dump 评论面板子树 + 找评论条目节点
 *  - 优惠券：只点「优惠券」入口打开面板，绝不点发放/确认类按钮，dump 抽屉结构
 *
 * 用法：node scripts/probe-live-now.js
 * 产物：data/probe2/live-now.json / live-now-comments.png / live-now-coupon.png
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'probe2');
const PROFILE = process.env.TP_PROFILE || path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';

const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DANGER = /发放|立即发|确认发|确定发|领取|立即创建|提交|支付/;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function dumpTree(el, depth, budget) {
  if (!el || depth > 14 || budget.n <= 0) return null;
  budget.n -= 1;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (!tag || tag === 'script' || tag === 'style') return null;
  const node = { tag };
  const id = el.getAttribute && el.getAttribute('id');
  const cls = el.getAttribute && el.getAttribute('class');
  if (id) node.id = id;
  if (cls) node.cls = String(cls).slice(0, 160);
  const role = el.getAttribute && el.getAttribute('role');
  if (role) node.role = role;
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) node.aria = aria.slice(0, 60);
  const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ');
  const t = norm(own);
  if (t) node.text = t.slice(0, 120);
  const r = el.getBoundingClientRect();
  node.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  const kids = [];
  for (const c of Array.from(el.children || [])) {
    const k = dumpTree(c, depth + 1, budget);
    if (k) kids.push(k);
  }
  if (kids.length) node.kids = kids;
  return node;
}

// 通用扫描：找出可见的、带候选特征的节点
function scan(page, opts) {
  return page.evaluate((opts) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (out.length >= 600) return;
      let r; try { r = el.getBoundingClientRect(); } catch (e) { return; }
      if (!r || r.width < (opts.minW || 4) || r.height < (opts.minH || 4)) return;
      let cs; try { cs = getComputedStyle(el); } catch (e) { return; }
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
      const text = norm(el.textContent);
      if (opts.exclude && opts.exclude.test(text)) return;
      if (opts.include && !opts.include.test(text)) return;
      if (!opts.leafOnly || el.children.length === 0 || text.length <= 30) {
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.getAttribute('class') || '').slice(0, 140),
          role: el.getAttribute('role') || '',
          text: text.slice(0, 90),
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
        });
      }
    });
    return out;
  }, opts);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL_LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  console.log('页面：' + page.url());

  const result = { at: new Date().toISOString(), url: page.url() };

  // ---------- 1. 评论区 ----------
  // 等到评论区非空（最多 25 秒；正常开播有评论很快就到）
  let commentsReady = false;
  for (let i = 0; i < 6 && !commentsReady; i++) {
    const st = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      return { empty: /暂无用户评论/.test(norm(document.body.textContent)) };
    }).catch(() => ({ empty: true }));
    commentsReady = !st.empty;
    if (!commentsReady) await page.waitForTimeout(4000);
  }
  console.log('评论区非空：' + commentsReady);

  const commentPanel = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let panel = null;
    document.querySelectorAll('div').forEach((el) => {
      if (panel) return;
      const t = norm(el.textContent);
      if (t.length > 6000) return;
      if (/评论管理/.test(t)) panel = el;
    });
    return panel ? { cls: String(panel.getAttribute('class') || ''), html: panel.outerHTML.slice(0, 120000) } : null;
  });
  result.comments = {
    ready: commentsReady,
    panelCls: commentPanel ? commentPanel.cls : '',
    // 评论条候选：看起来像一条评论的叶子/短节点
    candidates: await scan(page, {
      include: null,
      exclude: /首页|直播计划|选品|分佣|带货数据|优惠券|福袋/,
      minW: 60, minH: 14
    })
  };
  // 评论面板子树
  if (commentPanel) {
    result.comments.tree = await page.evaluate((cls) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      let panel = null;
      document.querySelectorAll('div').forEach((el) => {
        if (panel) return;
        const t = norm(el.textContent);
        if (t.length > 6000) return;
        if (/评论管理/.test(t) && String(el.getAttribute('class') || '') === cls) panel = el;
      });
      const budget = { n: 2500 };
      return panel ? dumpTree(panel, 0, budget) : null;
    }, commentPanel.cls).catch(() => null);
  }
  try {
    await page.screenshot({ path: path.join(OUT, 'live-now-comments.png'), timeout: 8000, animations: 'disabled' });
    console.log('截图：live-now-comments.png');
  } catch (e) { console.log('评论区截图失败：' + e.message); }

  // ---------- 2. 优惠券面板（只开面板，不点发放） ----------
  let couponClicked = false;
  const entry = page.locator('text=优惠券').first();
  try {
    const vis = await entry.isVisible({ timeout: 4000 }).catch(() => false);
    if (!vis) {
      // 兜底：找营销工具区带「优惠券」的卡片
      const alt = page.locator('div:has-text("发放优惠券")').last();
      if (await alt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await alt.click({ timeout: 4000 });
        couponClicked = true;
      }
    } else {
      await entry.click({ timeout: 4000 });
      couponClicked = true;
    }
  } catch (e) { console.log('点优惠券入口失败：' + e.message); }
  console.log('优惠券入口已点击：' + couponClicked);
  await page.waitForTimeout(4500);

  if (couponClicked) {
    result.coupon = {
      // 抽屉里的按钮 / 券条目候选（危险按钮只记录不点）
      nodes: await scan(page, { include: /优惠券|券|数量|库存|面额|门槛|张/ || null, minW: 30, minH: 14 })
    };
    result.coupon.buttons = (result.coupon.nodes || []).filter((n) =>
      /button/i.test(n.tag) || n.role === 'button' || /发放/.test(n.text));
    try {
      await page.screenshot({ path: path.join(OUT, 'live-now-coupon.png'), timeout: 8000, animations: 'disabled' });
      console.log('截图：live-now-coupon.png');
    } catch (e) { console.log('优惠券截图失败：' + e.message); }
    // 关闭抽屉（Esc）
    await page.keyboard.press('Escape').catch(() => {});
  }

  fs.writeFileSync(path.join(OUT, 'live-now.json'), JSON.stringify(result, null, 2));
  console.log('已存 data/probe2/live-now.json');

  try { await ctx.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
