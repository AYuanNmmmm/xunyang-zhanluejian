/* 商品列表全量抓取探测（只读 + 滚动，不点击任何东西）
 *
 * 目标：搞清楚
 *   1. 商品列表的滚动容器是谁（懒加载要滚到底才会出更多）
 *   2. 滚动到底能加载多少、有没有上限
 *   3. 每张卡的「商品名」在哪个元素里（用于列表展示与选择）
 *   4. 卡片的稳定标识（aria-label 里的商品 ID）
 *
 * 用法：node scripts/probe-goods.js
 * 产物：data/probe2/goods.json
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
  await page.waitForTimeout(6000);
  console.log('页面：' + page.url());

  // 1) 找滚动容器 + 首次读数
  const probe = await page.evaluate(() => {
    const list = document.querySelector('#live-card-list');
    if (!list) return { error: 'no #live-card-list' };

    // 向上找真正可滚动的祖先
    let scroller = list;
    const chain = [];
    let cur = list;
    for (let i = 0; i < 8 && cur; i++) {
      const cs = getComputedStyle(cur);
      chain.push({
        tag: cur.tagName, id: cur.id, cls: String(cur.className || '').slice(0, 60),
        overflowY: cs.overflowY, scrollH: cur.scrollHeight, clientH: cur.clientHeight
      });
      if (/(auto|scroll)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 4) { scroller = cur; break; }
      cur = cur.parentElement;
    }

    const cards = Array.from(list.querySelectorAll('div[role="button"][aria-label]'));
    const nameOf = (card) => {
      // 取卡片里最长的一行短文本当作商品名（排除价格/销量）
      const cands = [];
      card.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 4 && t.length <= 60 && !/^[¥￥\d]/.test(t) && !/^(已售|曝光|点击|支付|销售)/.test(t)) cands.push(t);
      });
      return cands[0] || '';
    };

    return {
      scrollerChain: chain,
      scroller: (() => { const r = scroller.getBoundingClientRect(); return { tag: scroller.tagName, cls: String(scroller.className || '').slice(0, 60), scrollH: scroller.scrollHeight, clientH: scroller.clientHeight, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }; })(),
      count: cards.length,
      items: cards.map((c, i) => ({
        i: i + 1,
        aria: c.getAttribute('aria-label'),
        name: nameOf(c),
        fullText: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      }))
    };
  });
  console.log(JSON.stringify({ scroller: probe.scroller, count: probe.count }, null, 2));
  console.log('滚动链：');
  (probe.scrollerChain || []).forEach((c, i) => console.log(`  ${i}: <${c.tag}> #${c.id || '-'} .${c.cls} overflowY=${c.overflowY} scrollH=${c.scrollH} clientH=${c.clientH}`));

  // 2) 反复滚到底，看能加载出多少
  let rounds = 0;
  let prev = -1;
  let cur = probe.count;
  while (rounds < 40 && cur !== prev) {
    prev = cur;
    await page.evaluate(() => {
      const list = document.querySelector('#live-card-list');
      let el = list;
      for (let i = 0; i < 8 && el; i++) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) break;
        el = el.parentElement;
      }
      const target = el || list;
      target.scrollTop = target.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(2200);
    cur = await page.evaluate(() => document.querySelectorAll('#live-card-list div[role="button"][aria-label]').length);
    rounds++;
    console.log(`  第 ${rounds} 次滚动后：${cur} 个商品`);
  }

  // 3) 抓全量明细
  const final = await page.evaluate(() => {
    const list = document.querySelector('#live-card-list');
    const cards = Array.from(list.querySelectorAll('div[role="button"][aria-label]'));
    const nameOf = (card) => {
      const cands = [];
      card.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 4 && t.length <= 60 && !/^[¥￥\d]/.test(t) && !/^(已售|曝光|点击|支付|销售)/.test(t)) cands.push(t);
      });
      return cands[0] || '';
    };
    return cards.map((c, i) => ({
      i: i + 1,
      aria: c.getAttribute('aria-label'),
      name: nameOf(c),
      fullText: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    }));
  });

  fs.writeFileSync(path.join(OUT, 'goods.json'), JSON.stringify({ at: new Date().toISOString(), url: page.url(), scroller: probe.scroller, total: final.length, items: final }, null, 2));

  console.log(`\n最终商品数：${final.length}`);
  final.forEach((g) => console.log(`  ${g.i}. ${g.name}  [${g.aria}]`));
  console.log('\n已存 data/probe2/goods.json');

  ctx.on('close', () => process.exit(0));
  const bye = async () => { try { await ctx.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  await new Promise(() => {});
})();
