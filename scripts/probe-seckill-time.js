/* 探针 2：秒杀投放时间控件 + 评论输入区 + 优惠券行按钮
 * 只读，不提交
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

  // ---------- 评论输入区 ----------
  res.comment = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const wrap = document.querySelector('[class*="comment-wrap"]');
    if (!wrap) return { ok: false };
    const inputs = Array.from(wrap.querySelectorAll('input,textarea,[contenteditable="true"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 90),
        ce: el.getAttribute('contenteditable'), ph: el.getAttribute('placeholder') || '',
        html: el.outerHTML.slice(0, 300),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      };
    });
    const btns = Array.from(wrap.querySelectorAll('button,[role="button"],[class*="send"],[class*="btn"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 80), text: norm(el.textContent).slice(0, 20), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    }).filter((b) => b.box[2] > 2);
    const list = document.querySelector('#comment_all_tab_list_container');
    return {
      ok: true, wrapCls: String(wrap.className), inputs, btns,
      listHtml: list ? list.outerHTML.slice(0, 1200) : '',
      itemCount: list ? list.querySelectorAll('[class*="item-jRI"]').length : 0
    };
  });
  res.steps.push('comment inputs=' + ((res.comment.inputs || []).length));

  // ---------- 秒杀 ----------
  try {
    const btn = page.locator('[class*="seckill-btn-container"]').first();
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 8000 });
    res.steps.push('seckill opened');
  } catch (e) { res.steps.push('seckill click failed'); }
  await page.waitForTimeout(5000);
  const fr = page.frames().find((f) => /drop-spike/.test(f.url()));
  if (fr) {
    // 投放时间区域的完整 HTML
    res.timeField = await fr.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      let hit = null;
      document.querySelectorAll('*').forEach((el) => {
        if (hit) return;
        const t = norm(el.textContent);
        if (t.indexOf('投放时间') === 0 && t.length < 80) hit = el;
      });
      const range = document.querySelector('[class*="date-time-range-picker"]') ||
        document.querySelector('[class*="date-time"]');
      const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
        type: el.type, cls: String(el.className || ''), value: el.value,
        readonly: el.readOnly, disabled: el.disabled, ph: el.placeholder || '',
        outer: el.outerHTML.slice(0, 260)
      }));
      return {
        ok: !!hit || !!range,
        labelText: hit ? norm(hit.textContent).slice(0, 120) : '',
        rangeHTML: range ? range.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '[S]').slice(0, 3500) : '',
        inputs
      };
    });
    // 立即投放是否隐藏时间
    await fr.locator('label', { hasText: '立即投放' }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    res.afterNow = await fr.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const body = norm(document.body.textContent);
      const submit = Array.from(document.querySelectorAll('button')).find((b) => norm(b.textContent) === '提交');
      return { hasTime: /投放时间/.test(body), body: body.slice(0, 500), submitDisabled: submit ? submit.disabled : null };
    });
    // 回到定时，尝试直接填时间
    await fr.locator('label', { hasText: '定时投放' }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    res.fillTry = await fr.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const inp = Array.from(document.querySelectorAll('input')).filter((i) => i.type === 'text');
      const out = { count: inp.length, tries: [] };
      const setV = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (d && d.set) d.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      inp.forEach((el, i) => {
        const before = el.value;
        try { setV(el, '2026-10-21 15:00'); } catch (e) {}
        out.tries.push({ i, cls: String(el.className).slice(0, 50), before, after: el.value, readOnly: el.readOnly });
      });
      return out;
    });
    await page.screenshot({ path: path.join(OUT, 'sk-time.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});
    // 点开时间选择器看面板
    await page.waitForTimeout(600);
    const pick = fr.locator('[class*="date-time-range-picker"]').first();
    await pick.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1800);
    res.pickerPanel = await fr.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const panels = Array.from(document.querySelectorAll('[class*="picker-panel"],[class*="dropdown"],[class*="calendar"]'))
        .filter((el) => el.getBoundingClientRect().width > 60)
        .slice(0, 3).map((el) => ({ cls: String(el.getAttribute('class')).slice(0, 90), text: norm(el.textContent).slice(0, 300) }));
      return panels;
    });
    await page.screenshot({ path: path.join(OUT, 'sk-picker.png'), timeout: 8000, animations: 'disabled' }).catch(() => {});
  } else res.steps.push('no frame');

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape').catch(() => {});

  // ---------- 优惠券行按钮坐标 ----------
  await page.waitForTimeout(1000);
  try {
    await page.locator('div.title-njIhu4:text-is("优惠券")').first().click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    res.couponRows = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const dlg = document.querySelector('.okee-current-live-drawer-dialog');
      if (!dlg) return { ok: false };
      const rows = Array.from(dlg.querySelectorAll('tr')).slice(1);
      return {
        ok: true,
        rows: rows.map((tr, i) => {
          const btn = Array.from(tr.querySelectorAll('button')).find((b) => /发放优惠券/.test(norm(b.textContent)));
          const r = btn ? btn.getBoundingClientRect() : null;
          const cells = Array.from(tr.children).map((c) => norm(c.textContent));
          return { i, cells: cells.slice(0, 6), btn: btn ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), cls: String(btn.className).slice(0, 70) } : null };
        })
      };
    });
  } catch (e) { res.steps.push('coupon reopen failed'); }

  fs.writeFileSync(path.join(OUT, 'cs2.json'), JSON.stringify(res, null, 2));
  console.log('steps:', res.steps.join(' | '));
  console.log('--- comment ---');
  console.log('wrap:', (res.comment || {}).wrapCls);
  ((res.comment || {}).inputs || []).forEach((i) => console.log('  in:', i.tag, i.cls, 'ce=' + i.ce, 'ph=' + i.ph, i.box.join(','), i.html.slice(0, 150)));
  ((res.comment || {}).btns || []).forEach((b) => console.log('  btn:', b.tag, b.cls, JSON.stringify(b.text), b.box.join(',')));
  console.log('itemCount:', (res.comment || {}).itemCount);
  console.log('--- seckill time ---');
  console.log('labelText:', (res.timeField || {}).labelText);
  console.log('rangeHTML:', ((res.timeField || {}).rangeHTML || '').slice(0, 1800));
  ((res.timeField || {}).inputs || []).forEach((i) => console.log('  inp:', i.type, i.cls.slice(0, 40), 'v=' + i.value, 'ro=' + i.readonly, i.outer.slice(0, 160)));
  console.log('afterNow:', JSON.stringify(res.afterNow));
  console.log('fillTry:', JSON.stringify(res.fillTry));
  console.log('pickerPanel:', JSON.stringify(res.pickerPanel));
  console.log('--- coupon rows ---');
  console.log(JSON.stringify(res.couponRows));
  try { await ctx.close(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
