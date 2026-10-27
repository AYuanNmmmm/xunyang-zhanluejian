/* 优惠券面板结构探测
 *
 * ⚠️ 安全约束：全程只点「优惠券」这个入口，绝不点「发放 / 确认 / 立即发放」等任何会真实发券的按钮。
 * 每次点击后立即 dump 并截图，供人工核对。
 *
 * 用法：node scripts/probe-coupon.js
 * 产物：data/probe2/coupon-*.json / coupon-*.png
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

// 危险词：出现这些文字的按钮一律不点
const DANGER = /发放|立即发|确认发|确定发|领取|立即创建|提交|支付/;

function snapPage() {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const nodes = Array.from(document.querySelectorAll('body *'));
  for (const el of nodes) {
    if (out.length >= 800) break;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
    if (!r || r.width < 4 || r.height < 4) continue;
    let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const tag = el.tagName.toLowerCase();
    const isBtn = tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || cs.cursor === 'pointer';
    const text = norm(el.textContent);
    if (!text || text.length > 80) continue;
    if (!isBtn && !/优惠券|券|数量|库存|间隔|面额|门槛/.test(text)) continue;
    out.push({
      tag,
      cls: String(el.getAttribute('class') || '').slice(0, 120),
      role: el.getAttribute('role') || '',
      text: text.slice(0, 60),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    });
  }
  return out;
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
  await page.waitForTimeout(6000);
  console.log('页面：' + page.url());

  await page.screenshot({ path: path.join(OUT, 'coupon-0-before.png') });
  const before = await page.evaluate(snapPage);
  fs.writeFileSync(path.join(OUT, 'coupon-0-before.json'), JSON.stringify(before, null, 2));

  // 找「优惠券」入口（只看可见的、文字里含"优惠券"且不含危险词）
  const found = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const res = [];
    document.querySelectorAll('body *').forEach((el) => {
      const t = norm(el.textContent);
      if (!t || t.length > 12) return;
      if (!/优惠券/.test(t)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      res.push({ text: t, cls: String(el.getAttribute('class') || '').slice(0, 80), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
    });
    return res;
  });
  console.log('找到「优惠券」相关元素：');
  found.forEach((f, i) => console.log(`  ${i}: "${f.text}" cls=${f.cls} box=${f.box}`));

  if (!found.length) {
    console.log('没找到优惠券入口，可能当前页面没有营销工具区。');
  } else {
    // 选文字最短（最像个按钮）的那个点
    const target = found[0];
    console.log(`\n点击第一个："${target.text}" @ ${target.box}`);
    await page.mouse.click(target.box[0] + target.box[2] / 2, target.box[1] + target.box[3] / 2);
    await sleep(2600);

    const urlAfter = page.url();
    console.log('点击后地址：' + urlAfter);
    await page.screenshot({ path: path.join(OUT, 'coupon-1-after.png') });
    const after = await page.evaluate(snapPage);
    fs.writeFileSync(path.join(OUT, 'coupon-1-after.json'), JSON.stringify({ url: urlAfter, frames: page.frames().map((f) => f.url()), items: after }, null, 2));

    const key = (e) => e.text;
    const beforeSet = new Set(before.map(key));
    const added = after.filter((e) => !beforeSet.has(key(e)));
    console.log(`\n新增元素 ${added.length} 个：`);
    added.slice(0, 40).forEach((e) => {
      const danger = DANGER.test(e.text) ? '  ⚠️危险' : '';
      console.log(`  [${e.tag}] "${e.text}" cls=${e.cls.slice(0, 60)} box=${e.box}${danger}`);
    });
    console.log('\n截图：coupon-0-before.png / coupon-1-after.png');
    console.log('⚠️ 脚本不会点任何发放按钮，请人工在截图里确认面板。');
  }

  ctx.on('close', () => process.exit(0));
  const bye = async () => { try { await ctx.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  await new Promise(() => {});
})();
