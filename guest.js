/* 内嵌页面（webview guest）操作层
 * 负责：UA 伪装、弹窗拦截、跨 iframe 注入与执行、元素拾取
 * 被 main.js 与 test/auto-test.js 共用
 */

// 默认统一伪装成 Windows 版 Chrome 138：Windows / macOS 两端行为一致，
// 已针对抖音后台验证过。想在 mac 上用原生 UA 调试时：
//   TP_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ..." npm start
const UA = process.env.TP_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

// 多个内嵌页面：main=界面上给人看的那个；worker=后台工作页（自动任务专用）。
// 拆开以后，自动任务滚列表/开抽屉/打字都只发生在 worker 上，真人看的主界面完全不受影响。
const guests = new Map();
let defaultName = 'main';
let guest = null;          // 兼容旧调用：= guests['main']
let libSrc = null;
let libVer = '';
const events = { popup: [], navigate: [], blocked: [] };

function onPopup(fn) { events.popup.push(fn); }
function onNavigate(fn) { events.navigate.push(fn); }
function onBlocked(fn) { events.blocked.push(fn); }
function emit(list, payload) { list.forEach((fn) => { try { fn(payload); } catch (e) {} }); }

function setLib(src) {
  libSrc = src;
  // 从注入源码里抠出版本号，用来判断页面里的是不是最新的一份（避免重复注入 80KB）
  try {
    const m = String(src || '').match(/version:\s*'([^']+)'/);
    libVer = m ? m[1] : '';
  } catch (e) { libVer = ''; }
  return { ok: true, size: String(src || '').length };
}

// 只在「页面里还没有 / 版本旧了」时注入。以前是无条件 f.executeJavaScript(libSrc)，
// 每次调用都重新编译执行 80KB 脚本，页面越跑越卡（这是"功能突然全失效"的隐形原因）。
async function ensureLib(f) {
  if (!libSrc) return;
  let cur = '';
  try { cur = await withTimeout(f.executeJavaScript('(window.__TP && window.__TP.version) || ""', false), 4000, 'ver'); } catch (e) { cur = ''; }
  if (cur === libVer && libVer) return;
  await withTimeout(f.executeJavaScript(libSrc, false).catch(() => null), 8000, 'inject');
}

// 取某个名字的页面（不传 = 主界面）
function getGuest(name) {
  const k = name || defaultName;
  const c = guests.get(k);
  if (c && !c.isDestroyed()) return c;
  if (c && c.isDestroyed()) guests.delete(k);
  return name ? null : guest;
}
function guestNames() { return Array.from(guests.keys()); }

// 渲染进程创建的 webview 会把 webContentsId 发过来登记
function register(name, id, isDefault) {
  try {
    const { webContents } = require('electron');
    const c = webContents.fromId(Number(id));
    if (!c || c.isDestroyed()) return { ok: false, reason: 'no-contents' };
    guests.set(String(name), c);
    c.__tpName = String(name);   // 标记身份：后台页不做 focus()，避免抢用户窗口焦点
    if (isDefault || !guest || guest.isDestroyed()) { guest = c; defaultName = String(name); }
    if (!c.__tpAttached) attach(c);
    return { ok: true, name: String(name), total: guests.size };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

function collectFrames(frame, out = [], depth = 0) {
  if (!frame || depth > 8) return out;
  out.push(frame);
  let kids = [];
  try {
    kids = frame.frames || [];
    if (!kids.length && frame.framesInSubtree) {
      kids = frame.framesInSubtree.filter((f) => f !== frame);
    }
  } catch (e) { kids = []; }
  for (const k of kids) collectFrames(k, out, depth + 1);
  return out;
}

function getFrames(target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return [];
  try { return collectFrames(g.mainFrame); } catch (e) { return []; }
}

// 关键：来客里点按钮会走 window.open，默认会另开窗口，注入不到 → 拾取失效。
// 这里一律拦下来，改在当前内嵌页面导航。
//
// 外部协议（bitbrowser:// / bytedance:// / mailto: ...）必须单独拦：
// 这类地址一旦导航出去，Electron 会把它交给操作系统，而 Windows 上没注册对应程序，
// 就会弹「需要使用新应用以打开此 bitbrowser 链接 / 在 Microsoft Store 中查找应用」。
// 抖音后台页面里这类唤端链接不少（推广位、协作工具按钮），自动化点击时很容易误点到，
// 表现就是「用着用着突然弹一个窗」。这里直接吞掉，只在日志里留痕。
const URL_OK = /^(https?|file|about|data|blob|javascript|devtools|chrome|chrome-extension|chrome-error):/i;

function isExternalScheme(url) {
  if (!url) return false;
  const s = String(url).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;   // 相对地址、锚点不拦
  return !URL_OK.test(s);
}

function guardSchemes(contents, name) {
  const block = (e, url) => {
    if (!isExternalScheme(url)) return;
    try { e.preventDefault(); } catch (err) {}
    const u = String(url).slice(0, 300);
    console.log('[guest] 已拦截外部协议跳转：', u);
    emit(events.blocked, { url: u, name: name || '' });
  };
  contents.on('will-navigate', (e, url) => block(e, url));
  // 子 iframe 里的跳转不会触发 will-navigate，要单独监听
  contents.on('will-frame-navigate', (e) => block(e, e && e.url));
  contents.on('will-redirect', (e, url) => block(e, url));
}

function attach(contents) {
  // 只有第一个 webview（主控栏）成为自动化目标。v0.3.3 起支持多分栏，
  // 后创建的分栏 webview 也会走到这里 —— 如果无条件覆盖，自动化会跑到分栏上去点错地方。
  // UA / 弹窗拦截 / 导航日志对所有 webview 生效。
  if (!guest || guest.isDestroyed()) { guest = contents; if (!guests.has(defaultName)) guests.set(defaultName, contents); }
  contents.__tpAttached = true;

  try { contents.setUserAgent(UA); } catch (e) {}
  try { guardSchemes(contents, contents.__tpName); } catch (e) {}

  contents.setWindowOpenHandler(({ url }) => {
    console.log('[guest] 拦截弹窗，改为内嵌导航：', url);
    emit(events.popup, url);
    if (/^https?:/i.test(url) && !contents.isDestroyed()) {
      try { contents.loadURL(url); } catch (e) {}
    }
    return { action: 'deny' };
  });

  // 兜底：如果仍然创建了子窗口，把地址搬回内嵌页面并关掉子窗口
  contents.on('did-create-window', (child) => {
    try {
      const url = child.webContents.getURL();
      console.log('[guest] 子窗口已创建，搬回内嵌页面：', url);
      emit(events.popup, url);
      if (/^https?:/i.test(url) && !contents.isDestroyed()) contents.loadURL(url);
      child.close();
    } catch (e) {}
  });

  contents.on('did-navigate', (_e, url) => {
    console.log('[guest] 页面导航：', url);
    emit(events.navigate, url);
  });

  contents.on('render-process-gone', (_e, details) => {
    console.log('[guest] 渲染进程崩溃：', details && details.reason);
  });

  contents.on('destroyed', () => { if (guest === contents) guest = null; });

  return contents;
}

// 判断某个 frame 的返回算不算"没找到"，是的话继续往子 frame 找
function isMiss(r) {
  if (r === null || r === undefined) return true;
  if (Array.isArray(r)) return r.length === 0;
  if (typeof r === 'number') return r === 0;
  if (typeof r === 'object') {
    if (r.found === false) return true;
    if (r.ok === false) return true;
    return false;
  }
  return false;
}

// 单次 frame 执行超时：导航中 / 已 detach 的 frame 上 executeJavaScript 可能永不 resolve
function withTimeout(p, ms, tag) {
  let t = null;
  return Promise.race([
    p.finally(() => { if (t) clearTimeout(t); }),
    new Promise((resolve) => { t = setTimeout(() => resolve({ __timeout: true, tag: tag }), ms); })
  ]);
}

// 依次在每个 frame 里尝试执行，主 frame 找不到就下沉到 iframe
async function runInFrames(code, target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready', target: target || 'main' };
  const frames = getFrames(target);
  if (!frames.length) return { ok: false, reason: 'no-frame' };

  let last = null;
  for (const f of frames) {
    try {
      await ensureLib(f);   // 已是最新就跳过，不再每次重灌 80KB
      const r = await withTimeout(f.executeJavaScript(code, true), 15000, 'exec');
      if (r && r.__timeout) { last = { ok: false, reason: 'frame-exec-timeout' }; continue; }
      if (isMiss(r)) { last = r; continue; }
      return r;
    } catch (e) {
      last = { ok: false, reason: String((e && e.message) || e) };
    }
  }
  return last || { ok: false, reason: 'all-frames-failed' };
}

async function pickStart(target) {
  const frames = getFrames(target);
  let n = 0;
  for (const f of frames) {
    try {
      await ensureLib(f).catch(() => {});
      await f.executeJavaScript('window.__TP && window.__TP.startPick()', true);
      n++;
    } catch (e) {}
  }
  console.log(`[guest] 拾取已在 ${n} 个 frame 启动`);
  return { ok: n > 0, frames: n };
}

async function pickPoll(target) {
  const frames = getFrames(target);
  let anyPicking = false;
  for (const f of frames) {
    try {
      const st = await f.executeJavaScript('window.__TP ? window.__TP.pickState() : null', true);
      if (!st) continue;
      if (st.picking) anyPicking = true;
      if (st.picked) {
        const p = await f.executeJavaScript('window.__TP.consumePick()', true);
        return { ok: true, picking: true, picked: p };
      }
    } catch (e) {}
  }
  return { ok: true, picking: anyPicking, picked: null };
}

async function pickStop(target) {
  for (const f of getFrames(target)) {
    try { await f.executeJavaScript('window.__TP && window.__TP.stopPick()', true); } catch (e) {}
  }
  return { ok: true };
}

// 扫描所有框架里的可交互元素（不受"首个命中即返回"限制）
async function scanAll(limit, target) {
  const g0 = getGuest(target);
  if (!g0 || g0.isDestroyed()) return { ok: false, reason: 'guest-not-ready', frames: 0, items: [] };
  const frames = getFrames(target);
  const items = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    try {
      await ensureLib(f).catch(() => {});
      const list = await f.executeJavaScript(`window.__TP ? window.__TP.scan(${Number(limit) || 180}) : []`, true);
      if (Array.isArray(list)) {
        for (const it of list) {
          if (items.length >= 400) break;
          items.push(Object.assign({ frame: i }, it));
        }
      }
    } catch (e) { /* 跨域框架跳过 */ }
  }
  return { ok: items.length > 0, frames: frames.length, count: items.length, items };
}

/* ============================================================
 * 输入注入层
 *
 * 历史：早期用 dispatchEvent 合成事件 → isTrusted=false，抖音 React 只当 hover；
 * 后来改用 webContents.sendInputEvent → 事件可信，但它会「抢鼠标/抢焦点」：
 * 每次点击前 guest.focus() 会把窗口拉到前台，鼠标指针也会跟着跳到页面坐标上，
 * 用户正在别处操作时体验很差。
 *
 * 现在：优先走 CDP（webContents.debugger + Input.dispatchMouseEvent / dispatchKeyEvent）。
 * 事件由浏览器输入管线直接注入，isTrusted=true，完全不动系统光标、不需要聚焦窗口。
 * CDP 不可用（例如开发者工具已经 attach）时自动退回 sendInputEvent。
 * ============================================================ */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

let cdpWarned = false;
let cdpRetryAt = 0;
function ensureDebugger(contents) {
  const g = contents || guest;
  if (!g || g.isDestroyed()) return false;
  if (Date.now() < cdpRetryAt) return false;   // 失败后 10 秒内不反复尝试
  try {
    if (!g.debugger.isAttached()) g.debugger.attach('1.3');
    return true;
  } catch (e) {
    // 开发者工具占用了 debugger：退回 sendInputEvent，等它关掉后再自动恢复 CDP
    cdpRetryAt = Date.now() + 10000;
    if (!cdpWarned) {
      cdpWarned = true;
      console.log('[guest] CDP 不可用（可能开着开发者工具），暂用 sendInputEvent：', (e && e.message) || e);
    }
    return false;
  }
}

async function cdp(method, params, contents) {
  const g = contents || guest;
  if (!ensureDebugger(g)) return { ok: false, reason: 'cdp-unavailable' };
  try {
    await g.debugger.sendCommand(method, params || {});
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function isBadCoord(x, y) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return true;
  return false;
}

// 页面缩放倍率：CDP 用布局像素，sendInputEvent 用视口像素，两者差一个 zoomFactor
function zoomOf(contents) {
  try { return Number((contents || guest).getZoomFactor()) || 1; } catch (e) { return 1; }
}

// 老路：sendInputEvent（会抢鼠标，仅作兜底）。它要的是缩放后的视口坐标。
async function legacyClick(px, py, contents) {
  const g = contents || guest;
  const z = zoomOf(g);
  const vx = Math.round(px * z);
  const vy = Math.round(py * z);
  // 不要在后台页上 focus()：focus 会把整个应用窗口拉到最前、抢走用户焦点
  // （表现为"后台在动、我这边被打断"）。后台页只靠 sendInputEvent 试一下，失败就算了。
  if (g.__tpName !== 'worker') { try { g.focus(); } catch (e) {} }
  g.sendInputEvent({ type: 'mouseMove', x: vx, y: vy });
  await wait(jitter(60, 140));
  g.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'left', clickCount: 1 });
  await wait(jitter(55, 120));
  g.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'left', clickCount: 1 });
  return { ok: true, x: vx, y: vy, how: 'sendInputEvent' };
}

/* 真实点击：只注入到页面，不动系统光标。target 可指定在哪个页面点（main / worker） */
async function realClick(x, y, target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready' };
  if (isBadCoord(x, y)) return { ok: false, reason: 'bad-coord' };
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));

  // 移动 → 按下 → 抬起，和真人节奏一致（移动分两步，让 hover 态先出来）
  const mv = await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, pointerType: 'mouse' }, g);
  if (!mv.ok) return legacyClick(px, py, g);
  await wait(jitter(70, 160));
  const dn = await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }, g);
  await wait(jitter(55, 120));
  const up = await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }, g);
  if (!dn.ok || !up.ok) return legacyClick(px, py, g);
  return { ok: true, x: px, y: py, how: 'cdp', target: target || 'main' };
}

// 只移动指针（CDP）：用于触发「悬停才出现」的操作按钮，不点击、不抢鼠标
async function realMove(x, y, target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready' };
  if (isBadCoord(x, y)) return { ok: false, reason: 'bad-coord' };
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  const mv = await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0, pointerType: 'mouse' }, g);
  if (!mv.ok) return { ok: false, reason: mv.reason || 'cdp-failed' };
  return { ok: true, x: px, y: py, how: 'cdp' };
}

// 真实键盘输入：逐字注入 char 事件（React 受控组件也认），不发系统键盘事件
async function realType(x, y, text, target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready' };
  if (isBadCoord(x, y)) return { ok: false, reason: 'bad-coord' };

  // 先把焦点落到输入框（点击本身也走 CDP，不抢鼠标）
  const click = await realClick(x, y, target);
  if (!click.ok) return click;
  await wait(jitter(90, 160));

  const chars = Array.from(String(text || ''));
  if (!chars.length) return { ok: true, typed: 0, how: 'cdp' };

  let how = 'cdp';
  for (const ch of chars) {
    const r = await cdp('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch }, g);
    if (!r.ok) {
      // CDP 不可用：退出 CDP 通道，剩下的一次性用 sendInputEvent 打完
      how = 'sendInputEvent';
      if (g.__tpName !== 'worker') { try { g.focus(); } catch (e) {} }
      for (const c of chars) {
        g.sendInputEvent({ type: 'char', keyCode: c });
        await wait(jitter(45, 130));
      }
      return { ok: true, typed: chars.length, how };
    }
    await wait(jitter(45, 130));
    if (Math.random() < 0.06) await wait(jitter(150, 320));
  }
  return { ok: true, typed: chars.length, how };
}

// 真实回车（发评论用）
async function realEnter(target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready' };
  const r1 = await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, g);
  if (!r1.ok) {
    if (g.__tpName !== 'worker') { try { g.focus(); } catch (e) {} }
    g.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await wait(40);
    g.sendInputEvent({ type: 'char', keyCode: '\r' });
    await wait(40);
    g.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    return { ok: true, how: 'sendInputEvent' };
  }
  await wait(jitter(20, 50));
  await cdp('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r', unmodifiedText: '\r' }, g);
  await wait(jitter(20, 50));
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, g);
  return { ok: true, how: 'cdp' };
}

// 真实按键：Esc 关抽屉、Backspace 清输入框等（times>1 时连按）
const KEY_CODES = {
  Escape: { code: 'Escape', vk: 27, key: 'Escape' },
  Backspace: { code: 'Backspace', vk: 8, key: 'Backspace' },
  Delete: { code: 'Delete', vk: 46, key: 'Delete' },
  Tab: { code: 'Tab', vk: 9, key: 'Tab' },
  Enter: { code: 'Enter', vk: 13, key: 'Enter' },
  ArrowDown: { code: 'ArrowDown', vk: 40, key: 'ArrowDown' }
};

async function realKey(key, times, target) {
  const g = getGuest(target);
  if (!g || g.isDestroyed()) return { ok: false, reason: 'guest-not-ready' };
  const n = Math.max(1, Math.min(30, Number(times) || 1));
  const k = KEY_CODES[key] || { code: key, vk: 0, key };
  let how = 'cdp';
  for (let i = 0; i < n; i++) {
    const d = await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, g);
    if (!d.ok) {
      how = 'sendInputEvent';
      if (g.__tpName !== 'worker') { try { g.focus(); } catch (e) {} }
      g.sendInputEvent({ type: 'keyDown', keyCode: key });
      await wait(30);
      g.sendInputEvent({ type: 'keyUp', keyCode: key });
    } else {
      await wait(jitter(20, 45));
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, g);
    }
    await wait(jitter(40, 90));
  }
  return { ok: true, key, times: n, how };
}

function frameInfo(target) {  const frames = getFrames(target);
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    let url = '';
    try { url = frames[i].url; } catch (e) {}
    out.push({ index: i, main: i === 0, url });
  }
  return { ok: true, count: frames.length, frames: out };
}

module.exports = {
  attach, setLib, getGuest, guestNames, register, getFrames, runInFrames,
  pickStart, pickPoll, pickStop, frameInfo, scanAll, onPopup, onNavigate, onBlocked,
  realClick, realMove, realType, realEnter, realKey, UA
};
