/* 评论区结构抓取（真实评论存在时跑）
 *
 * 目标：
 *   1. 找到单条评论的容器（旧配置的 #comment_all_tab_list_container 已失效，要重新定位）
 *   2. 每条评论里：昵称 / 内容 / 时间 / 回复按钮 分别在哪个元素
 *   3. 顺带抓在线观众列表（为以后欢迎语留结构）
 *
 * 用法：node scripts/probe-comments.js
 * 产物：data/probe2/comments.json + shot-comments.png
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
  await page.waitForTimeout(7000);
  console.log('页面：' + page.url());

  // 等评论区真的出现内容（中控台是实时推送，评论可能刚发还没到）
  const waitForComments = async (maxSec) => {
    const deadline = Date.now() + maxSec * 1000;
    let last = '';
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const body = norm(document.body.textContent);
        return {
          empty: /暂无用户评论|暂无用户提问/.test(body),
          tail: body.slice(0, 50),
          viewer: (body.match(/累计观众数(\d+)/) || [])[1] || '?',
          online: (body.match(/在线观众数(\d+)/) || [])[1] || '?'
        };
      }).catch(() => null);
      if (snap) {
        const sig = `${snap.empty}|${snap.viewer}|${snap.online}`;
        if (sig !== last) {
          console.log(`  等待中… 空态=${snap.empty} 累计观众=${snap.viewer} 在线=${snap.online}`);
          last = sig;
        }
        if (!snap.empty) {
          console.log('  评论区已出现内容');
          await page.waitForTimeout(1500);
          return true;
        }
      }
      await page.waitForTimeout(4000);
    }
    console.log('  等待超时，评论区仍是空态');
    return false;
  };
  await waitForComments(Number(process.env.WAIT_SEC) || 90);

  // 直播画面一直在动，整页截图容易等不到稳定帧 → 先抓 DOM，截图放最后且限时
  const shot = async (name) => {
    try {
      await page.screenshot({ path: path.join(OUT, name), timeout: 8000, animations: 'disabled' });
      console.log('截图：' + name);
    } catch (e) {
      console.log('截图跳过（' + name + '）：' + String(e.message).slice(0, 60));
    }
  };

  // 完整导出评论面板子树
  const data = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // 先找评论面板容器：包含"评论管理/全部/高频"的那块
    let panel = null;
    document.querySelectorAll('div').forEach((el) => {
      if (panel) return;
      const t = norm(el.textContent);
      if (t.length > 4000) return;
      if (/评论管理/.test(t) && /(全部|高频|选品意向)/.test(t)) panel = el;
    });

    const dump = (el, depth) => {
      if (!el || depth > 12) return null;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!tag || tag === 'script' || tag === 'style') return null;
      const node = { tag };
      const id = el.getAttribute && el.getAttribute('id');
      const cls = el.getAttribute && el.getAttribute('class');
      if (id) node.id = id;
      if (cls) node.cls = String(cls);
      const role = el.getAttribute && el.getAttribute('role');
      if (role) node.role = role;
      const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' ');
      const t = norm(own);
      if (t) node.text = t.slice(0, 120);
      const r = el.getBoundingClientRect();
      node.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      const kids = [];
      for (const c of Array.from(el.children || [])) {
        const k = dump(c, depth + 1);
        if (k) kids.push(k);
      }
      if (kids.length) node.kids = kids;
      return node;
    };

    // 顺便收集：所有含"回复"文案的可见元素
    const replyBtns = [];
    document.querySelectorAll('*').forEach((el) => {
      const t = norm(el.textContent);
      if (t !== '回复' && t !== '回复Ta' && t !== '回复TA') return;
      if (el.children.length) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      replyBtns.push({
        text: t,
        cls: String(el.getAttribute('class') || ''),
        parentCls: String(el.parentElement && el.parentElement.getAttribute('class') || ''),
        grandCls: String(el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.getAttribute('class') || ''),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      });
    });

    // 所有 "item-*" 类节点（评论条通常长这样）
    const itemNodes = [];
    document.querySelectorAll('[class*="item-"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return;
      itemNodes.push({
        cls: String(el.getAttribute('class') || ''),
        text: norm(el.textContent).slice(0, 100),
        childCount: el.children.length,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
      });
    });

    return {
      panelFound: !!panel,
      panelClass: panel ? String(panel.getAttribute('class') || '') : '',
      tree: dump(panel || document.body, 0),
      replyBtns: replyBtns.slice(0, 20),
      itemNodes: itemNodes.slice(0, 60),
      bodyText: norm(document.body.textContent).slice(0, 600)
    };
  });

  fs.writeFileSync(path.join(OUT, 'comments.json'), JSON.stringify({ at: new Date().toISOString(), url: page.url(), ...data }, null, 2));
  console.log('评论面板找到：' + data.panelFound + '  cls=' + data.panelClass);
  console.log('含「回复」的元素：' + data.replyBtns.length);
  data.replyBtns.slice(0, 8).forEach((b) => console.log(`  "${b.text}" cls=${b.cls} parent=${b.parentCls} box=${b.box}`));
  console.log('item-* 节点：' + data.itemNodes.length);
  data.itemNodes.slice(0, 15).forEach((n) => console.log(`  .${n.cls}  ${JSON.stringify(n.text.slice(0, 40))}`));
  console.log('\n已存 data/probe2/comments.json');
  await shot('shot-comments.png');

  ctx.on('close', () => process.exit(0));
  const bye = async () => { try { await ctx.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  await new Promise(() => {});
})();
