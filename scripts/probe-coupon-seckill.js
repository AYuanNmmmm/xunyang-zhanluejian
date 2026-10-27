/* 一次性探针：优惠券列表/发放弹窗 + 秒杀定时投放表单
 * 只读结构，不做任何真实发放/投放（最后 Esc 关闭）
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'probe2');
const PROFILE = path.join(ROOT, 'data', 'chrome-profile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright-core'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1600, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://eos.douyin.com/livesite/live/current', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(10000);
  const res = { at: new Date().toISOString(), steps: [] };

  // ---------- ① 优惠券抽屉 ----------
  try {
    await page.locator('div.title-njIhu4:text-is("优惠券")').first().click({ timeout: 8000 });
    res.steps.push('opened coupon drawer');
  } catch (e) { res.steps.push('coupon drawer click failed: ' + e.message.slice(0, 60)); }
  await page.waitForTimeout(3500);

  res.couponDrawer = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const dlg = document.querySelector('.okee-current-live-drawer-dialog');
    if (!dlg) return { ok: false };
    const rows = Array.from(dlg.querySelectorAll('tr'));
    const table = {
      ok: true,
      rowCount: rows.length,
      header: rows[0] ? Array.from(rows[0].children).map((c) => norm(c.textContent)) : [],
      rows: rows.slice(0, 8).map((tr) => ({
        cls: String(tr.getAttribute('class') || ''),
        cells: Array.from(tr.children).map((c) => norm(c.textContent).slice(0, 60)),
        btns: Array.from(tr.querySelectorAll('button,[role="button"],[class*="btn"]')).map((b) => norm(b.textContent).slice(0, 20)).filter(Boolean)
      })),
      firstRowHTML: rows[1] ? rows[1].outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '[S]').slice(0, 6000) : '',
      bodySample: norm(dlg.textContent).slice(0, 800)
    };
    return table;
  });
  res.steps.push('coupon rows=' + (res.couponDrawer.rowCount || 0));
  await page.screenshot({ path: path.join(OUT, 'cp-list.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});

  // 打开第一行的发放弹窗（不确认）
  try {
    const grant = page.locator('button.okee-current-live-btn', { hasText: '发放优惠券' }).first();
    await grant.click({ timeout: 6000 });
    res.steps.push('clicked 发放优惠券');
    await page.waitForTimeout(2500);
    res.grantModal = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const modal = document.querySelector('.okee-current-live-modal-content-inner');
      if (!modal) return { ok: false };
      const radios = Array.from(modal.querySelectorAll('label.okee-current-live-radio')).map((l) => ({
        text: norm(l.textContent),
        disabled: /disabled/.test(String(l.getAttribute('class') || '')),
        checked: !!(l.querySelector('input') || {}).checked
      }));
      const btns = Array.from(modal.querySelectorAll('button')).map((b) => ({ text: norm(b.textContent), cls: String(b.className).slice(0, 90), disabled: b.disabled }));
      const inputs = Array.from(modal.querySelectorAll('input')).map((i) => ({ type: i.type, cls: String(i.className).slice(0, 80), ph: i.placeholder || '', value: i.value }));
      return { ok: true, radios, btns, inputs, html: modal.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '[S]').slice(0, 4000) };
    });
    await page.screenshot({ path: path.join(OUT, 'cp-modal.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  } catch (e) { res.steps.push('grant click failed: ' + e.message.slice(0, 80)); }
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  await page.mouse.click(300, 500).catch(() => {}); // 点空白关抽屉
  await page.waitForTimeout(1200);

  // ---------- ② 秒杀：定时投放 ----------
  try {
    const btn = page.locator('[class*="seckill-btn-container"]').first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 8000 });
    res.steps.push('opened seckill drawer');
  } catch (e) { res.steps.push('seckill click failed: ' + e.message.slice(0, 60)); }
  await page.waitForTimeout(5000);

  const fr = page.frames().find((f) => /drop-spike/.test(f.url()));
  res.seckillFrame = fr ? fr.url().slice(0, 140) : '';
  if (fr) {
    const dump = async (tag) => fr.evaluate((tag) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const out = { tag, inputs: [], radios: [], buttons: [], labels: [], texts: [] };
      document.querySelectorAll('input').forEach((el) => {
        const r = el.getBoundingClientRect();
        out.inputs.push({
          type: el.type, value: el.value, ph: el.placeholder || '',
          cls: String(el.className || '').slice(0, 90), disabled: el.disabled,
          box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
        });
      });
      document.querySelectorAll('label').forEach((el) => {
        const t = norm(el.textContent);
        const inp = el.querySelector('input');
        if (!inp || !t) return;
        out.radios.push({ text: t.slice(0, 30), type: inp.type, checked: inp.checked, disabled: inp.disabled });
      });
      document.querySelectorAll('button').forEach((el) => {
        out.buttons.push({ text: norm(el.textContent).slice(0, 20), disabled: el.disabled, cls: String(el.className).slice(0, 90) });
      });
      document.querySelectorAll('[class*="picker"],[class*="date"],[class*="time"],[class*="calendar"]').forEach((el) => {
        const t = norm(el.textContent);
        if (!t || t.length > 40) return;
        const r = el.getBoundingClientRect();
        if (r.width < 2) return;
        out.labels.push({ tag: el.tagName.toLowerCase(), cls: String(el.getAttribute('class') || '').slice(0, 90), text: t, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      });
      out.body = norm(document.body.textContent).slice(0, 900);
      return out;
    }, tag).catch((e) => ({ tag, err: String(e.message).slice(0, 120) }));

    res.seckillBefore = await dump('before');
    // 点「定时投放」
    const sched = fr.locator('label', { hasText: '定时投放' }).first();
    try {
      await sched.click({ timeout: 5000 });
      res.steps.push('clicked 定时投放');
    } catch (e) { res.steps.push('sched click failed: ' + e.message.slice(0, 60)); }
    await page.waitForTimeout(2500);
    res.seckillAfter = await dump('after-sched');
    await page.screenshot({ path: path.join(OUT, 'sk-sched.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});
  } else {
    res.steps.push('no drop-spike frame; frames=' + page.frames().map((f) => f.url()).slice(0, 6).join(' | '));
  }

  fs.writeFileSync(path.join(OUT, 'cs.json'), JSON.stringify(res, null, 2));
  console.log('steps:', res.steps.join(' | '));
  console.log('coupon header:', JSON.stringify((res.couponDrawer || {}).header));
  ((res.couponDrawer || {}).rows || []).forEach((r, i) => console.log('  row' + i, r.cls.slice(0, 30), JSON.stringify(r.cells), '| btns:', r.btns.join(',')));
  if (res.grantModal && res.grantModal.ok) {
    console.log('modal radios:', res.grantModal.radios.map((r) => r.text + (r.disabled ? '(禁用)' : '') + (r.checked ? '*' : '')).join(' / '));
    console.log('modal btns:', res.grantModal.btns.map((b) => b.text).join(' / '));
  } else console.log('modal: none');
  console.log('seckill frame:', res.seckillFrame);
  if (res.seckillBefore && !res.seckillBefore.err) {
    console.log('SK before inputs:', res.seckillBefore.inputs.map((i) => i.type + ':' + i.cls.slice(0, 26) + '=' + i.value).join(' | '));
    console.log('SK before radios:', res.seckillBefore.radios.map((r) => r.text + (r.checked ? '*' : '')).join(' / '));
  }
  if (res.seckillAfter && !res.seckillAfter.err) {
    console.log('SK after inputs:', res.seckillAfter.inputs.map((i) => i.type + ':' + i.cls.slice(0, 30) + '=' + i.value + ' ph=' + i.ph).join(' | '));
    console.log('SK after pickers:', res.seckillAfter.labels.map((l) => l.text + '@' + l.cls.slice(0, 24)).join(' / '));
    console.log('SK after body:', res.seckillAfter.body.slice(0, 400));
  }
  await page.keyboard.press('Escape').catch(() => {});
  try { await ctx.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
