/* 外部协议拦截测试
 * 解决的现象：用着用着突然弹
 *   「需要使用新应用以打开此 bitbrowser 链接 / 在 Microsoft Store 中查找应用」
 * 原因：抖音后台页面里带 bitbrowser:// 这类唤端链接，被点到后 Electron 交给系统，
 *       Windows 没注册对应程序就弹这个框。
 *
 * 验证：
 *   1. 页面里点 bitbrowser:// 链接 → 被拦下，页面不导航、不弹系统窗口
 *   2. iframe 里的同类链接 → 同样被拦
 *   3. bytedance:// / mailto: 等其它外部协议 → 被拦
 *   4. 普通 http(s) 链接 → 不误伤（不触发拦截）
 *
 * 运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron test/scheme-guard.js
 */
const { app, BrowserWindow } = require('electron');
const guestApi = require('../guest');

let pass = 0, fail = 0;
const log = (ok, name, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const blocked = [];
guestApi.onBlocked((info) => blocked.push(info));

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!doctype html><html><body>
  <a id="bb" href="bitbrowser://open?groupId=1&url=https%3A%2F%2Feos.douyin.com">打开比特浏览器</a>
  <a id="bd" href="bytedance://open?x=1">bytedance</a>
  <a id="mail" href="mailto:a@b.com">邮件</a>
  <a id="http" href="about:blank">普通链接</a>
  <iframe id="fr" srcdoc="<a id='ibs' href='bitbrowser://from-frame'>frame 里的链接</a>"></iframe>
</body></html>`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600 });
  const c = win.webContents;
  guestApi.attach(c);

  await c.loadURL(PAGE);
  await sleep(400);
  const baseUrl = c.getURL();

  // ① 主 frame 里点 bitbrowser 链接
  blocked.length = 0;
  await c.executeJavaScript('document.getElementById("bb").click()', true).catch(() => {});
  await sleep(700);
  log(blocked.some((b) => /^bitbrowser:/i.test(b.url)), 'bitbrowser:// 链接已被拦截', blocked.map((b) => b.url).join(', ') || '无事件');
  log(c.getURL() === baseUrl, '页面没有被跳到 bitbrowser（导航已阻止）', c.getURL().slice(0, 60));

  // ② iframe 里的同类链接
  blocked.length = 0;
  await c.executeJavaScript(`(() => {
    const d = document.getElementById('fr').contentDocument;
    d.getElementById('ibs').click();
  })()`, true).catch(() => {});
  await sleep(700);
  log(blocked.some((b) => /from-frame/.test(b.url)), 'iframe 内的 bitbrowser 链接也被拦截', blocked.map((b) => b.url).join(', ') || '无事件');

  // ③ 其它外部协议
  blocked.length = 0;
  await c.executeJavaScript('document.getElementById("bd").click(); document.getElementById("mail").click();', true).catch(() => {});
  await sleep(700);
  const kinds = blocked.map((b) => String(b.url).split(':')[0]);
  log(kinds.includes('bytedance'), 'bytedance:// 被拦截', kinds.join(','));
  log(kinds.includes('mailto'), 'mailto: 被拦截', kinds.join(','));

  // ④ 不误伤普通链接
  blocked.length = 0;
  await c.executeJavaScript('document.getElementById("http").click()', true).catch(() => {});
  await sleep(800);
  log(blocked.length === 0, '普通链接不触发拦截（没误伤）', `${blocked.length} 条拦截事件`);
  log(c.getURL() === 'about:blank', '普通链接照常导航', c.getURL().slice(0, 40));

  // ⑤ 直接 loadURL 未知协议也不会把系统窗口叫出来
  blocked.length = 0;
  let threw = '';
  try { await c.loadURL('bitbrowser://direct-call'); } catch (e) { threw = String(e && e.message || e); }
  await sleep(600);
  log(blocked.some((b) => /direct-call/.test(b.url)) || /ERR_|Failed|not allowed/i.test(threw),
    '直接导航到 bitbrowser:// 同样被挡（未交给系统）', threw.slice(0, 70) || '已被守卫拦下');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => { app.exit(fail ? 1 : 0); }, 300);
}).catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  app.exit(1);
});
