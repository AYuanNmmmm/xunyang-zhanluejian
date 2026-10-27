/* 真机诊断（只读 / 不提交）
 * DIAG_ONLY=coupon 只跑优惠券；DIAG_ONLY=seckill 只跑秒杀；不传则两段都跑。
 * 运行：ELECTRON_DISABLE_SANDBOX=1 env -u ELECTRON_RUN_AS_NODE \
 *   ./node_modules/.bin/electron --no-sandbox --disable-gpu test/live-diag.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const guestApi = require('../guest');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'index.html');
const REAL_UD = path.join(os.homedir(), 'Library', 'Application Support', '巡洋战略舰');
const TMP_UD = '/tmp/tp-live-userdata';
const ONLY = String(process.env.DIAG_ONLY || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLibSrc() {
  const html = fs.readFileSync(SRC, 'utf8');
  const m = html.match(/<script type="text\/plain" id="tp-lib">([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

function prepareUserData() {
  fs.mkdirSync(path.join(TMP_UD, 'Partitions'), { recursive: true });
  const src = path.join(REAL_UD, 'Partitions', 'douyin');
  const dst = path.join(TMP_UD, 'Partitions', 'douyin');
  if (!fs.existsSync(src)) { console.log('[diag] 找不到登录态目录：', src); return; }
  if (!fs.existsSync(dst)) {
    require('node:child_process').execFileSync('cp', ['-R', src, dst]);
    console.log('[diag] 登录态已复制');
  } else {
    console.log('[diag] 复用已有临时登录态');
  }
}

app.setPath('userData', TMP_UD);
prepareUserData();

ipcMain.handle('config:load', () => null);
ipcMain.handle('config:save', () => ({ ok: true }));
ipcMain.handle('config:path', () => path.join(TMP_UD, 'config.json'));
ipcMain.handle('log:export', () => ({ ok: false }));
ipcMain.handle('power:busy', () => ({ ok: true }));
ipcMain.handle('guest:setLib', (_e, src) => guestApi.setLib(src));
ipcMain.handle('guest:call', async (_e, code) => guestApi.runInFrames(code));
ipcMain.handle('guest:frames', () => guestApi.frameInfo());
ipcMain.handle('guest:scan', (_e, n) => guestApi.scanAll(n));
ipcMain.handle('guest:pickStart', () => guestApi.pickStart());
ipcMain.handle('guest:pickPoll', () => guestApi.pickPoll());
ipcMain.handle('guest:pickStop', () => guestApi.pickStop());
ipcMain.handle('guest:realClick', (_e, x, y) => guestApi.realClick(x, y));
ipcMain.handle('guest:realType', (_e, x, y, t) => guestApi.realType(x, y, t));
ipcMain.handle('guest:realMove', (_e, x, y) => guestApi.realMove(x, y));
ipcMain.handle('guest:realEnter', () => guestApi.realEnter());
ipcMain.handle('guest:realKey', (_e, k, n) => guestApi.realKey(k, n));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  guestApi.attach(contents);
  guestApi.setLib(loadLibSrc());
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true
    }
  });
  await win.loadFile(SRC).catch((e) => console.log('[diag] loadFile 失败：', e.message));
  await sleep(1500);

  let tries = 0;
  while (!guestApi.getGuest() && tries < 60) { await sleep(300); tries++; }
  await sleep(9000);

  const js = (code) => win.webContents.executeJavaScript(code, true).catch(() => null);
  const call = async (method, args = []) => {
    const code = `(async () => { return await window.__TP.${method}(${args.map((a) => JSON.stringify(a)).join(', ')}); })()`;
    return guestApi.runInFrames(code);
  };
  const zoom = Number(await js('(function(){ try { return document.getElementById("view").getZoomFactor(); } catch(e){ return 1; } })()')) || 1;
  console.log('[diag] 标题:', await js('document.getElementById("pageTitle").textContent'), '| 缩放:', zoom);

  // ================= 优惠券 =================
  if (!ONLY || ONLY === 'coupon') {
    console.log('\n===== 优惠券 =====');
    const loc = await call('locate', ['text=优惠券']);
    console.log('入口:', JSON.stringify(loc));
    if (loc && loc.ok) {
      console.log('点入口:', JSON.stringify(await guestApi.realClick(loc.x * zoom, loc.y * zoom)));
      await sleep(3000);
      const rows = await call('couponPanelRows');
      console.log('券列表:', JSON.stringify(rows).slice(0, 400));
      if (rows && rows.ok) {
        const r0 = rows.rows[0];
        console.log('点发放:', JSON.stringify(await guestApi.realClick(r0.btn.x * zoom, r0.btn.y * zoom)));
        await sleep(2500);
        const st = await call('couponModalState');
        console.log('弹窗档位 数量:', (st.qty || []).length, '时长:', (st.dur || []).length);
        console.log('  qty:', (st.qty || []).map((o) => o.text + (o.disabled ? '(禁)' : '')).join(' | '));
        console.log('  dur:', (st.dur || []).map((o) => o.text).join(' | '));
        console.log('  confirm:', JSON.stringify(st.confirm), 'cancel:', JSON.stringify(st.cancel));
        for (const t of ['100张', '3分钟']) {
          const p = await call('couponPick', [t]);
          console.log('  pick', t, '→', JSON.stringify(p));
          if (p && p.ok) { await guestApi.realClick(p.point.x * zoom, p.point.y * zoom); await sleep(400); }
        }
        const after = await call('couponModalState');
        console.log('选完 checked:', (after.qty || []).concat(after.dur || []).filter((o) => o.checked).map((o) => o.text).join(','));
        try { fs.writeFileSync('/tmp/diag-coupon.png', (await win.webContents.capturePage()).toPNG()); } catch (e) {}
        await guestApi.realKey('Escape');
        await sleep(600);
        await guestApi.realKey('Escape');
      }
    }
  }

  // ================= 秒杀 =================
  if (!ONLY || ONLY === 'seckill') {
    console.log('\n===== 秒杀 =====');
    const cardSel = 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[4]';
    const btnSel = '[class*="seckill-btn-container"]';
    console.log('闪电图标:', JSON.stringify(await call('inspectPoint', [btnSel])).slice(0, 200));
    const loc = await call('locateIn', [cardSel, btnSel]);
    console.log('定位入口:', JSON.stringify(loc));
    if (loc && loc.ok) console.log('坐标点击:', JSON.stringify(await guestApi.realClick(loc.x * zoom, loc.y * zoom)));
    await sleep(3000);
    let form = await call('seckillForm');
    if (!form || !form.ok) {
      console.log('坐标点击没开，DOM 点击兜底:', JSON.stringify(await call('clickIn', [cardSel, btnSel])));
      await sleep(3500);
      form = await call('seckillForm');
    }
    console.log('表单:', JSON.stringify({ ok: form && form.ok, mode: form && form.mode, submitDisabled: form && form.submitDisabled }));
    if (form && form.ok) {
      if (form.mode !== 'sched') {
        console.log('切定时投放:', JSON.stringify(await call('click', ['text=定时投放'])));
        await sleep(1200);
        form = await call('seckillForm');
        console.log('切后 mode:', form && form.mode);
      }
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const sd = new Date(Date.now() + 2 * 60000); sd.setSeconds(0, 0);
      const startStr = fmt(sd);
      const endStr = fmt(new Date(sd.getTime() + 30 * 60000));
      console.log('目标时间:', startStr, '~', endStr);
      const pick = await call('seckillPickRange', [startStr, endStr]);
      console.log('日历点选:', JSON.stringify(pick).slice(0, 400));
      await sleep(800);
      const f2 = await call('seckillForm');
      console.log('选完后:', JSON.stringify({ mode: f2 && f2.mode, submitDisabled: f2 && f2.submitDisabled, stock: f2 && f2.stockValue }));
      console.log('时间按钮文案:', JSON.stringify(await call('seckillTimeText')));
      // 填库存/限购，看提交按钮是否解除禁用（不点提交）
      console.log('写库存 50:', JSON.stringify(await call('seckillSetNum', [0, 50])));
      console.log('写限购 2:', JSON.stringify(await call('seckillSetNum', [1, 2])));
      await sleep(900);
      const f3 = await call('seckillForm');
      console.log('填完:', JSON.stringify({ stock: f3 && f3.stockValue, limit: f3 && f3.limitValue, submitDisabled: f3 && f3.submitDisabled }));
      try { fs.writeFileSync('/tmp/diag-seckill.png', (await win.webContents.capturePage()).toPNG()); } catch (e) {}
      await guestApi.realKey('Escape');
    }
  }

  console.log('\n[diag] 结束');
  app.exit(0);
});
