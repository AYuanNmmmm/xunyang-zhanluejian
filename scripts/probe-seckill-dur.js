/* 探针 3：秒杀「投放时长」与提交可用性 + 定时投放日历面板
 * 不提交，只读
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'probe2');
const PROFILE = path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: false, viewport: { width: 1600, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://eos.douyin.com/livesite/live/current', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(10000);
  const res = { at: new Date().toISOString(), steps: [] };

  const btn = page.locator('[class*="seckill-btn-container"]').first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const fr = page.frames().find((f) => /drop-spike/.test(f.url()));
  if (!fr) { console.log('no frame'); process.exit(0); }

  const state = async (tag) => fr.evaluate((tag) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const submit = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent) === '提交');
    const radios = Array.from(document.querySelectorAll('label')).map((l) => {
      const inp = l.querySelector('input');
      return inp ? { t: norm(l.textContent).slice(0, 12), on: inp.checked, dis: inp.disabled } : null;
    }).filter(Boolean);
    const nums = Array.from(document.querySelectorAll('.byted-input-number-input')).map((i) => i.value);
    return { tag, submitDisabled: submit ? submit.disabled : null, radios, nums, body: norm(document.body.textContent).slice(120, 520) };
  }, tag).catch((e) => ({ tag, err: String(e.message) }));

  // 立即投放 + 10 分钟
  await fr.locator('label', { hasText: '立即投放' }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  res.nowMode = await state('now-mode');
  await fr.locator('label', { hasText: '10分钟' }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  res.afterDur = await state('after-10min');
  // 填库存 50
  await fr.evaluate(() => {
    const el = document.querySelectorAll('.byted-input-number-input')[0];
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(el, '50'); else el.value = '50';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  res.afterStock = await state('after-stock');
  await page.screenshot({ path: path.join(OUT, 'sk-dur.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});

  // 定时投放 → 点开始时间按钮，看日历面板
  await fr.locator('label', { hasText: '定时投放' }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const item = fr.locator('.byted-date-time-range-picker-item').first();
  await item.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  res.picker = await fr.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const panels = Array.from(document.querySelectorAll('div')).filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return r.width > 200 && /date|picker|calendar|panel/i.test(String(el.getAttribute('class') || '')) && cs.display !== 'none';
    }).slice(0, 4);
    const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }).map((el) => ({ cls: String(el.className).slice(0, 60), ph: el.placeholder, value: el.value, ro: el.readOnly, box: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() }));
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.getBoundingClientRect().width > 2).map((b) => norm(b.textContent).slice(0, 14));
    return {
      panels: panels.map((p) => ({ cls: String(p.getAttribute('class')).slice(0, 90), text: norm(p.textContent).slice(0, 260) })),
      inputs, btns
    };
  });
  await page.screenshot({ path: path.join(OUT, 'sk-cal.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});

  fs.writeFileSync(path.join(OUT, 'cs3.json'), JSON.stringify(res, null, 2));
  console.log('nowMode:', JSON.stringify(res.nowMode && { dis: res.nowMode.submitDisabled, nums: res.nowMode.nums }));
  console.log('nowMode radios:', (res.nowMode.radios || []).map((r) => r.t + (r.on ? '*' : '') + (r.dis ? '(禁)' : '')).join(' / '));
  console.log('nowMode body:', (res.nowMode.body || '').slice(0, 300));
  console.log('afterDur dis:', res.afterDur && res.afterDur.submitDisabled, 'radios:', (res.afterDur.radios || []).map((r) => r.t + (r.on ? '*' : '')).join(' / '));
  console.log('afterStock dis:', res.afterStock && res.afterStock.submitDisabled, 'nums:', res.afterStock && res.afterStock.nums);
  console.log('--- picker ---');
  console.log('panels:', JSON.stringify((res.picker || {}).panels || []));
  console.log('inputs:', JSON.stringify(((res.picker || {}).inputs || []).filter((i) => i.ph || i.value)));
  console.log('btns:', ((res.picker || {}).btns || []).join(' | '));
  await page.keyboard.press('Escape').catch(() => {});
  try { await ctx.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
