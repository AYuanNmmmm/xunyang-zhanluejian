/* 常驻弹窗（一直弹）状态读取验证 —— 只读，不点击任何东西
 *
 * 目的：确认 textIn 能稳定读出每张卡里按钮的当前文案，
 *      中控台靠它判断「这张卡是不是正在讲解中」，判断错了就会连续误点。
 *
 * 用法：node scripts/verify-keep.js
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = process.env.TP_PROFILE || path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';

const { chromium } = require('playwright-core');

const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
if (!m) { console.error('index.html 里找不到 tp-lib'); process.exit(1); }
const LIB = m[1];

const CARD_TPL = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[{{n}}]';
const ACT_SEL = 'class=talking-btn';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL_LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // 商品区是懒加载的，必须等它真的出现再读，否则会误判成「选择器失效」
  const ready = await page.waitForSelector('#live-card-list', { timeout: 45000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);
  console.log('页面：' + page.url() + ' | 商品区就绪：' + ready);
  if (!ready) { console.log('商品列表没出现（可能未开播 / 登录态失效），本次跳过'); await ctx.close(); process.exit(0); }

  await page.evaluate(LIB);
  const has = await page.evaluate(() => !!(window.__TP && window.__TP.textIn));
  console.log('注入库已就位：' + has + '（textIn 存在=' + has + '）');
  if (!has) { await ctx.close(); process.exit(1); }

  // 逐张卡读状态
  for (let n = 1; n <= 6; n++) {
    const cardSel = CARD_TPL.replace('{{n}}', String(n));
    const r = await page.evaluate(({ cardSel, actSel }) => {
      const st = window.__TP.textIn(cardSel, actSel);
      const cardAria = (() => {
        const el = window.__TP.resolve(cardSel);
        return el ? String(el.getAttribute('aria-label') || '').slice(0, 30) : '';
      })();
      return { st, cardAria };
    }, { cardSel, actSel: ACT_SEL });

    if (!r.st || !r.st.ok) {
      console.log(`卡 ${n}: 读不到（${(r.st && r.st.reason) || '未知'}）${n > 1 ? ' —— 可能是末尾' : ''}`);
      if (n > 1 && (r.st && r.st.reason === 'container-not-found')) break;
      continue;
    }
    const talking = /取消/.test(r.st.text || '');
    console.log(`卡 ${n}: 按钮文案「${r.st.text}」 → ${talking ? '讲解中(TRUE)' : '未讲解(false)'} | 卡aria=${r.cardAria}`);
  }

  // 同一张卡连读 3 次，确认读数是稳定的（不是渲染抖动）
  const cardSel1 = CARD_TPL.replace('{{n}}', '1');
  const seq = [];
  for (let i = 0; i < 3; i++) {
    const r = await page.evaluate(({ cardSel, actSel }) => window.__TP.textIn(cardSel, actSel), { cardSel: cardSel1, actSel: ACT_SEL });
    seq.push((r && r.text) || 'ERR');
    await page.waitForTimeout(400);
  }
  console.log('\n卡1 连读 3 次：' + seq.join(' | ') + ' → ' + (new Set(seq).size === 1 ? '稳定 ✓' : '不稳定 ✗'));

  console.log('\n结论：只要能稳定读出「取消讲解 / 讲解」，常驻模式就能正确判断状态。');
  await ctx.close();
})().catch((e) => { console.error('失败：' + (e && e.message)); process.exit(1); });
