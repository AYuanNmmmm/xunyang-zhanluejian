/* 选择器真机验证（只读，不点击任何东西）
 *
 * 做法：把 index.html 里的 tp-lib（也就是中控台运行时用的那份注入库）
 * 原样灌进 eos 后台页面，然后用库里的 resolve / probe 验证候选选择器。
 * 这样验证结果和中控台实际运行 100% 同源。
 *
 * 用法：node scripts/verify-selectors.js
 * 产物：data/probe2/verify.json + 控制台报告
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'probe2');
const PROFILE = process.env.TP_PROFILE || path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_LIVE = 'https://eos.douyin.com/livesite/live/current';

const { chromium } = require('playwright-core');

// 从 index.html 抠出 tp-lib
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
if (!m) { console.error('index.html 里找不到 tp-lib'); process.exit(1); }
const LIB = m[1];

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

  await page.evaluate(LIB);

  // 候选选择器清单：label = 要绑定的字段
  const CASES = [
    { field: 'card#1', name: '稳定id容器+序号1', sel: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[1]' },
    { field: 'card#3', name: '稳定id容器+序号3', sel: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[3]' },
    { field: 'card#9', name: '越界序号(应为空)', sel: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[9]' },
    { field: 'card', name: '容器内全部卡片', sel: '#live-card-list div[role="button"][aria-label]' },
    { field: 'cardAction', name: 'talking-btn 模糊类', sel: 'class=talking-btn' },
    { field: 'commentInput', name: 'placeholder 输入评论', sel: 'textarea[placeholder*="输入评论"]' },
    { field: 'commentInput', name: '稳定id内 textarea', sel: '#current-live-room textarea' },
    { field: 'sendButton', name: 'text=发送', sel: 'text=发送' },
    { field: 'sendButton', name: 'button 哈希类兜底', sel: '.button-Wc1yvW' }
  ];

  const results = [];
  for (const c of CASES) {
    const filled = c.sel.replace(/\{\{n\}\}/g, '1').replace(/\{\{name\}\}/g, 'x');
    const r = await page.evaluate((sel) => {
      if (!window.__TP) return null;
      return {
        list: window.__TP.resolveAll(sel).map((el) => ({
          tag: el.tagName,
          cls: String(el.getAttribute('class') || '').slice(0, 60),
          text: window.__TP.norm(el.textContent).slice(0, 40),
          box: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })()
        })),
        probe: window.__TP.probe(sel)
      };
    }, filled).catch((e) => ({ error: String(e.message || e) }));

    results.push({ field: c.field, name: c.name, sel: c.sel, filled, result: r });
    const cnt = Array.isArray(r.list) ? r.list.length : (r.error ? 'ERR' : '?');
    const info = r.probe && r.probe.found ? `tag=${r.probe.tag} cls=${String(r.probe.cls).slice(0, 40)} text=${r.probe.text.slice(0, 30)}` : (r.error || '未命中');
    console.log(`[${c.field}] ${c.name}\n    ${c.sel}\n    → 命中 ${cnt}  ${info}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(results, null, 2));
  console.log('\n结果已存 data/probe2/verify.json');
  console.log('浏览器保持打开（后续可能继续验证）。');

  ctx.on('close', () => process.exit(0));
  const bye = async () => { try { await ctx.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  await new Promise(() => {});
})();
