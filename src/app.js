/* 巡洋战略舰 · 渲染进程
 * 职责：配置管理 / 界面渲染 / 调度引擎（弹窗、发评、欢迎语）/ 选择器拾取
 */
(() => {
  'use strict';

  // ============================================================
  // 1. 默认配置
  // ============================================================
  const DEFAULTS = {
    version: 5,
    site: 'https://eos.douyin.com/livesite/live/current',
    dryRun: false,
    // 累计统计（跨会话保存）：弹讲解 / 发评 / 发券 / 秒杀次数，后台刷新与失败次数
    stats: {
      popup: 0, comment: 0, coupon: 0, seckill: 0,
      refresh: 0, fail: 0,
      since: ''
    },
    // 「同步全部」的最后一次结果（商品/券/秒杀入口数量 + 时间），结果卡挂在商品页顶部
    lastSync: null,
    // 运行位置：background=自动化在看不见的后台页里跑（主界面完全不动）；current=旧模式
    engine: {
      mode: 'background',
      prewarm: true,         // 启动就把后台页备好，点功能时不用等
      refreshMin: 30,       // 后台页定时自动刷新间隔（分钟，0=关闭）；卡死时会额外立即刷新
      refreshOnIdle: true   // 只在「没有任务在跑」时才定时刷新，避免打断正在进行的操作
    },
    // 多任务调度：多个功能一起开时，谁先动页面由 PageBus 排队；真人一动就让位
    sched: {
      humanYield: true,     // 真人在操作页面时，机器人自动让位（不跟人抢点击）
      humanYieldSec: 3,     // 让位时长（真人停手后多久恢复）
      stepYieldMs: 260      // 一个任务让出页面的最短空档（给别的任务插队）
    },
    // 内嵌页面缩放：zoom=当前倍率；favZoom=「适宽」记住的常用比例（一键切回它）
    view: {
      zoom: 1,
      fit: false,
      favZoom: 0,       // 常用缩放比例（0=还没记过；点「适宽」若没记过就取一个合理默认）
      cols: [],
      siteKey: ''      // 上次选过的快捷站点（下拉框记忆，避免每次都显示「自定义地址」）
    },
    // 防封控制：所有动作间隔都带随机浮动
    humanize: {
      enabled: true,
      jitterPct: 25,
      typeMin: 55,
      typeMax: 175,
      microPauseChance: 0.06,
      actionFloorMs: 900,
      longPauseChance: 0.08,
      longPauseMin: 1500,
      longPauseMax: 4500
    },
    selectors: {
      card: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[{{n}}]',
      cardAction: 'class=talking-btn',
      // 真机验证（2026-10-21）：公屏输入框是 textarea，placeholder 带「Enter键发送」，回车即发
      commentInput: 'textarea[placeholder*="输入评论"]\n[class*="comment-wrap"] textarea',
      sendButton: '',
      pinButton: '',
      commentItem: '',
      commentText: '',
      commentUser: '',
      viewerItem: '',
      viewerName: '',
      orderToast: '',
      couponEntry: 'text=优惠券',
      couponItem: 'class=okee-current-live-Table-Row',
      couponGrantBtn: 'text=发放优惠券',
      couponCountInput: '',
      couponConfirmBtn: 'text=确定发放',
      couponDurationBtn: 'text=1分钟'
    },
    // ① 商品：自动抓取当前直播间挂的商品
    goods: {
      list: [],
      pickedAt: '',
      autoRefresh: true,
      refreshSec: 90
    },
    // ② 定时弹讲解
    popup: {
      selected: [],
      mode: 'seq',
      showSec: 15,
      hideSec: 4,
      rounds: 0,
      timeFrom: '',
      timeTo: '',
      // 常驻单卡（一直弹）：定时「取消讲解 → 立刻恢复」，让用户端弹窗不消失
      keep: {
        refreshSec: 6,
        offMs: 600
      }
    },
    // ③ 自动发评（每组里放很多条独立评论，items 一条一个输入框）
    comment: {
      activeGroupId: null,
      useApi: true,        // 优先走接口直发（200ms 级，不占输入框）；失败自动回退页面输入
      userId: '',          // 主播自己的 sec_uid（识别一次就记住，接口发评要用）
      groups: []
    },
    // ④ 自动发优惠券（list = 后台扫出来的券，issue = 要发哪几张）
    coupon: {
      list: [],
      scannedAt: '',
      selected: [],          // 勾选要发的券（按 name 匹配）
      name: '',
      count: 10,             // 发放数量（对应后台小圆点档位）
      durationMin: '1',
      times: 0,
      intervalSec: 300,
      timeFrom: '',
      timeTo: ''
    },
    // ⑤ 秒杀投放：批量开启/停止 + 剩余库存监控自动补充
    seckill: {
      cards: [],            // 参与秒杀的商品序号（1 起）
      mode: 'sched',        // sched=定时投放（默认，和常用一致） / now=立即投放
      startOffsetMin: 2,    // 定时投放：多少分钟后开始（程序在日历上点选）
      durationMin: 30,      // 投放时长（10/30/60 分钟）
      // 定时投放的时间：拆成「日期 + 时 + 分」三段下拉，避免原生滚轮无限循环
      startDate: '', startH: '00', startM: '00',
      endDate: '', endH: '23', endM: '59',
      startAt: '',          // 兼容旧配置（YYYY-MM-DDTHH:mm）
      endAt: '',
      stock: 50,            // 每次投放库存
      limit: 0,             // 每人限购（0=不限）
      countdown: false,     // 秒杀倒计时开关
      monitor: false,       // 自动补充监控开关
      monitorSec: 60,       // 扫描间隔
      minStock: 10,         // 剩余低于该值触发补充
      addQty: 50,           // 每次「在原投放库存上追加」多少件（真机流程：编辑 → 原数量 + 追加）
      replenishTo: 50       // 兼容旧配置（v0.6.4 之前是「补充到 N 件」）
    },
    // ⑤ 实时数据：只读拉抖音侧的大屏与单品效果（不点页面、不占页面调度）
    data: {
      autoRefresh: true,
      refreshSec: 10,
      lastAt: '',
      hideZero: false       // 单品表里「曝光为 0」的没挂上的品是否隐藏
    },
    // 接口通道开关：能走接口就不点画面。
    // 点画面必须独占页面（PageBus），所以「多个功能一起开就抢」的根因在这；
    // 走接口不碰 DOM，弹讲解/发评/发券可以真正并行。
    api: {
      goods: true,        // 商品列表走货架接口（失败自动回退滚动 DOM）
      switchCard: true,   // 弹讲解走 card/switch 接口（失败自动回退点卡片）
      keepAlive: true,    // 每分钟一个只读请求当心跳，防长时间挂机被踢
      drawerYield: true   // 官方抽屉/弹窗开着时机器人先让位，关掉再继续
    }
  };

  const SELECTOR_META = [
    { key: 'card', label: '团购卡 / 商品卡片', ph: '默认已适配 eos 后台，{{n}}=第几张卡', tip: '直播商品列表自上而下 1/2/3…' },
    { key: 'cardAction', label: '卡片内「讲解」按钮', ph: '例：text=讲解（在卡片内部查找）', tip: '按文案找最抗改版' },
    { key: 'commentInput', label: '评论输入框', ph: '例：textarea 或 div[contenteditable]', tip: '' },
    { key: 'sendButton', label: '发送按钮', ph: '留空则用回车发送', tip: '' },
    { key: 'pinButton', label: '置顶按钮', ph: '例：text=置顶', tip: '' },
    { key: 'commentItem', label: '单条评论容器', ph: '例：[class*="comment-item"]', tip: '' },
    { key: 'commentText', label: '　└ 评论文本（容器内）', ph: '例：span[class*="content"]', tip: '' },
    { key: 'commentUser', label: '　└ 评论昵称（容器内）', ph: '例：span[class*="nick"]', tip: '' },
    { key: 'viewerItem', label: '在线观众容器', ph: '例：[class*="audience"] li', tip: '' },
    { key: 'viewerName', label: '　└ 观众昵称（容器内）', ph: '', tip: '' },
    { key: 'orderToast', label: '成交/下单提示条', ph: '用于触发「感谢语」，可留空', tip: '' },
    { key: 'couponEntry', label: '优惠券入口', ph: '例：text=优惠券', tip: '点开「本场直播优惠券」面板' },
    { key: 'couponItem', label: '　└ 券列表项', ph: '默认已适配（表格行）', tip: '面板里的一条可发放券' },
    { key: 'couponGrantBtn', label: '　└ 发放按钮', ph: '默认已适配（text=发放优惠券）', tip: '点了会弹出「发放优惠券」确认框' },
    { key: 'couponConfirmBtn', label: '　└ 确认发放按钮', ph: '默认已适配（text=确定发放）', tip: '确认框里真正发放的按钮' },
    { key: 'couponDurationBtn', label: '　└ 发券时长选项', ph: "例：text=1分钟（可填 1/3/5/10 分钟）", tip: '确认框里的时长单选' }
  ];

  // 不用拾取也能先跑起来的常见写法（2026-10-21 在 eos.douyin.com/livesite/live/current 真机验证）
  const SELECTOR_PRESET = {
    card: 'xpath=(//*[@id="live-card-list"]//div[@role="button"][@aria-label])[{{n}}]\ntext={{name}}',
    cardAction: 'class=talking-btn\nclass=talking-word\ntext=讲解',
    commentInput: '[class*="input-wrap"] [class*="text-input"]\ntextarea[placeholder*="输入评论"]',
    sendButton: 'text=发送\n.button-Wc1yvW',
    pinButton: 'text=置顶',
    // 2026-10-21 直播中真机验证：列表有稳定 id，昵称/内容是语义类名
    commentItem: '#comment_all_tab_list_container > div[class*="item-"]\n#comment_all_tab_list_container [class*="item-"]',
    commentUser: '[class*="item-name"]',
    commentText: '[class*="item-content"]',
    couponConfirmBtn: 'text=确定发放'
  };

  // ============================================================
  // 2. 工具
  // ============================================================
  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const deepClone = (o) => JSON.parse(JSON.stringify(o));

  function mergeDefaults(target, def) {
    const out = deepClone(def);
    if (!target || typeof target !== 'object') return out;
    for (const k of Object.keys(target)) {
      if (Array.isArray(target[k])) out[k] = target[k];
      else if (target[k] && typeof target[k] === 'object') out[k] = mergeDefaults(target[k], def[k] || {});
      else out[k] = target[k];
    }
    return out;
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = obj;
    for (const k of keys) {
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[last] = value;
  }

  function fillTemplate(tpl, item) {
    const v = String(item).trim();
    return String(tpl)
      .replace(/\{\{n\}\}/g, v)
      .replace(/\{\{name\}\}/g, v)
      .replace(/\{\{index\}\}/g, v);
  }

  // 防封核心：所有固定间隔都从这里出去，统一加随机浮动
  function humanJitter(baseMs) {
    const h = cfg.humanize || {};
    if (h.enabled === false) return Math.max(0, Math.round(baseMs));
    const pct = Math.min(80, Math.max(0, Number(h.jitterPct == null ? 25 : h.jitterPct))) / 100;
    const factor = 1 - pct + Math.random() * pct * 2;
    return Math.max(120, Math.round(baseMs * factor));
  }

  // 偶尔来一次长停顿，模拟真人走神
  async function maybeLongPause(token) {
    const h = cfg.humanize || {};
    if (h.enabled === false) return;
    const chance = Number(h.longPauseChance || 0);
    if (chance <= 0 || Math.random() >= chance) return;
    const lo = Number(h.longPauseMin || 1500);
    const hi = Math.max(lo, Number(h.longPauseMax || 4500));
    const ms = rand(lo, hi);
    Log.push('info', `防封：插入 ${(ms / 1000).toFixed(1)} 秒随机停顿`);
    if (token) await wait(token, ms);
    else await sleep(ms);
  }

  // 时间段判断：from/to 都是 HH:MM，留空表示不限
  function inTimeWindow(from, to) {
    if (!from || !to) return true;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const p = (s) => {
      const m = String(s).match(/(\d{1,2}):(\d{2})/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const a = p(from);
    const b = p(to);
    if (a == null || b == null) return true;
    // 跨零点（如 22:00-02:00）
    return a <= b ? (cur >= a && cur <= b) : (cur >= a || cur <= b);
  }

  // ============================================================
  // 3. 配置存取
  // ============================================================
  let cfg = deepClone(DEFAULTS);
  let saveTimer = null;

  async function loadConfig() {
    let migrated = false;
    try {
      const raw = await window.tp.loadConfig();
      if (raw && !raw.__error) {
        const oldVer = Number(raw.version) || 1;
        cfg = mergeDefaults(raw, DEFAULTS);

        // v1/v2 的选择器是旧版后台的写法（评论输入框还是 [class*="text-input"] 的 div），
        // 抖音后台早改成 textarea 了，留着会一直"点不进去"。v3 直接换成真机验证过的默认值。
        if (oldVer < 3) {
          const keepCoupon = raw.selectors || {};
          cfg.selectors = deepClone(DEFAULTS.selectors);
          // 券相关字段用户可能自己调过，保留
          ['couponEntry', 'couponItem', 'couponGrantBtn', 'couponConfirmBtn', 'couponDurationBtn'].forEach((k) => {
            if (keepCoupon[k]) cfg.selectors[k] = keepCoupon[k];
          });
          cfg.version = 3;
          migrated = true;
        }

        // v4：中控台是 1600 宽的固定布局，窗口窄时右侧按钮会落在视口外（点了像没反应）。
        // （缩放语义后来已改为「常用比例 + 一键切换」，这里不再强制写 fit，保留占位迁移。）
        if (oldVer < 4) {
          cfg.view = cfg.view || {};
          delete cfg.view.fit;
          cfg.version = 4;
          migrated = true;
        }
      }
    } catch (e) { /* 首次运行 */ }

    // 站点统一钉到直播中控台。老配置存的是根域名（eos.douyin.com/）或抖音来客首页，
    // 打开后落不到中控台，所有选择器都命中不了 —— 这也是"功能全用不了"的原因之一。
    // 这里做成幂等修正，不依赖 version，避免升级过一次后就再也修不回来。
    const LIVE_URL = DEFAULTS.site;
    if (!/livesite\/live\/current/.test(String(cfg.site || ''))) {
      cfg.site = LIVE_URL;
      migrated = true;
    }

    // 清理历史遗留的非法键（旧版在未指定字段时拾取会写入 "null"）
    if (cfg.selectors) {
      delete cfg.selectors.null;
      delete cfg.selectors.undefined;
    }

    // 发评组迁移：旧版是整段文本（一行一条），v0.5 起改成每条一个独立输入框（items）
    for (const g of (cfg.comment.groups || [])) {
      if (!Array.isArray(g.items)) g.items = [];
      if (!g.items.length && String(g.content || '').trim()) {
        g.items = parseCommentItems(g.content).map((it) => ({ id: uid(), text: it.text, pin: it.pin }));
        migrated = true;
      }
    }
    // 秒杀时间字段迁移：旧的 startAt/endAt（YYYY-MM-DDTHH:mm）拆成 date + hh:mm
    if (cfg.seckill) {
      const split = (v) => {
        const m = String(v || '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
        return m ? { d: m[1], hm: m[2] } : null;
      };
      const ss = !cfg.seckill.startDate && split(cfg.seckill.startAt);
      if (ss) { cfg.seckill.startDate = ss.d; cfg.seckill.startH = ss.hm.slice(0, 2); cfg.seckill.startM = ss.hm.slice(3, 5); migrated = true; }
      const ee = !cfg.seckill.endDate && split(cfg.seckill.endAt);
      if (ee) { cfg.seckill.endDate = ee.d; cfg.seckill.endH = ee.hm.slice(0, 2); cfg.seckill.endM = ee.hm.slice(3, 5); migrated = true; }
      if (!cfg.seckill.startH) cfg.seckill.startH = '00';
      if (!cfg.seckill.startM) cfg.seckill.startM = '00';
      if (!cfg.seckill.endH) cfg.seckill.endH = '23';
      if (!cfg.seckill.endM) cfg.seckill.endM = '59';
    }

    // 券列表是临时抓取的，重启后由「扫描券」重新读，不做持久化迁移

    if (migrated) {
      saveConfig();
      Log.push('warn', '配置已升级到 v2：页面选择器换成 eos 后台真机适配版（旧的哈希类已失效）');
    }
  }

  function saveConfig() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const res = await window.tp.saveConfig(cfg);
      if (res && !res.ok) Log.push('err', '配置保存失败：' + res.error);
    }, 350);
  }

  // ============================================================
  // 4. 日志（按功能分板块）
  //
  // 以前所有功能的日志全灌进一个框，多任务一起开时刷得飞快，出了问题根本翻不到。
  // 现在每条日志都带 tag（弹讲解/发评/发券/秒杀/商品/系统），日志区顶部按 tag 筛选；
  // 连续重复的同一条合并成 ×N（不再滚一屏一样的「第N轮没点上」），屏上最多留 120 行。
  // ============================================================
  const LOG_TAGS = [
    { key: 'all', name: '全部' },
    { key: 'popup', name: '弹讲解' },
    { key: 'comment', name: '发评' },
    { key: 'coupon', name: '发券' },
    { key: 'seckill', name: '秒杀' },
    { key: 'goods', name: '商品' },
    { key: 'sys', name: '系统' }
  ];

  // 绝大多数日志以功能名开头，按文案推断归属；特殊位置可以显式传第三个参数覆盖
  const TAG_RULES = [
    [/^弹讲解/, 'popup'],
    [/^发评|^自动发评|^置顶|^接口发评/, 'comment'],
    [/^发券|^优惠券|^扫到 \d+ 张券/, 'coupon'],
    [/秒杀/, 'seckill'],
    [/^抓取商品|^抓到 |^商品/, 'goods']
  ];
  function inferTag(msg) {
    const s = String(msg || '');
    for (const [re, tag] of TAG_RULES) if (re.test(s)) return tag;
    return 'sys';
  }

  const LOG_MAX = 400;       // 内存里最多留多少条（导出用）
  const LOG_DOM_MAX = 120;   // 屏幕上最多显示多少行

  const Log = {
    lines: [],
    tag: 'all',              // 当前筛选项
    push(level, msg, tag) {
      const t = new Date().toTimeString().slice(0, 8);
      const key = tag || inferTag(msg);
      const last = this.lines[this.lines.length - 1];
      // 连续重复：合并成一条 ×N
      if (last && last.msg === msg && last.level === level && last.tag === key) {
        last.n = (last.n || 1) + 1;
        last.t = t;
        if (this.visible(last)) this.bumpLast(last);
        return;
      }
      const line = { t, level, msg, tag: key, n: 1 };
      this.lines.push(line);
      if (this.lines.length > LOG_MAX) this.lines.shift();
      if (this.visible(line)) this.appendRow(line);
      this.renderTabs();
    },
    visible(line) { return this.tag === 'all' || line.tag === this.tag; },
    rowHtml(line) {
      return `<span class="t">${line.t}</span><span class="msg">${escapeHtml(line.msg)}</span>`
        + (line.n > 1 ? `<span class="rep"> ×${line.n}</span>` : '');
    },
    makeRow(line) {
      const row = document.createElement('div');
      row.className = 'log-line ' + line.level + ' tag-' + line.tag;
      row.dataset.msg = line.msg;
      row.dataset.level = line.level;
      row.dataset.n = String(line.n || 1);
      row.innerHTML = this.rowHtml(line);
      return row;
    },
    appendRow(line) {
      const body = $('#logBody');
      if (!body) return;
      body.appendChild(this.makeRow(line));
      while (body.childElementCount > LOG_DOM_MAX) body.firstElementChild.remove();
      this.scrollToEnd();
      this.syncCount();
    },
    bumpLast(line) {
      const body = $('#logBody');
      const row = body && body.lastElementChild;
      if (!row) return;
      row.dataset.n = String(line.n);
      let rep = row.querySelector('.rep');
      if (!rep) { rep = document.createElement('span'); rep.className = 'rep'; row.appendChild(rep); }
      rep.textContent = ' ×' + line.n;
      const t = row.querySelector('.t');
      if (t) t.textContent = line.t;
      this.scrollToEnd();
      this.syncCount();
    },
    scrollToEnd() {
      const box = $('#logAutoScroll');
      if (!box || !box.checked || this._scrollPending) return;
      this._scrollPending = requestAnimationFrame(() => {
        this._scrollPending = null;
        const body = $('#logBody');
        if (body) body.scrollTop = body.scrollHeight;
      });
    },
    syncCount() {
      const el = $('#logCount');
      if (!el) return;
      const n = this.tag === 'all' ? this.lines.length : this.lines.filter((l) => l.tag === this.tag).length;
      el.textContent = String(n);
    },
    // 切换页签后整体重画（只画当前功能，最多 120 行）
    renderAll() {
      const body = $('#logBody');
      if (!body) return;
      body.innerHTML = '';
      const list = this.lines.filter((l) => this.visible(l)).slice(-LOG_DOM_MAX);
      const frag = document.createDocumentFragment();
      for (const line of list) frag.appendChild(this.makeRow(line));
      body.appendChild(frag);
      this.syncCount();
      this.scrollToEnd();
    },
    // 页签重绘用 rAF 合并：并发时日志是成串进来的，每来一条就重算一遍计数 + 重写 7 个按钮，
    // 会把主线程刷满（表现为界面发涩、按钮闪烁）。这里改成「一帧最多画一次」。
    _tabsPending: false,
    renderTabs() {
      if (this._tabsPending) return;
      this._tabsPending = true;
      requestAnimationFrame(() => { this._tabsPending = false; this._drawTabs(); });
    },
    _drawTabs() {
      const bar = $('#logTabs');
      if (!bar) return;
      const counts = {};
      for (const l of this.lines) counts[l.tag] = (counts[l.tag] || 0) + 1;
      bar.querySelectorAll('.log-tab').forEach((b) => {
        const k = b.dataset.tag;
        const n = k === 'all' ? this.lines.length : (counts[k] || 0);
        const name = (LOG_TAGS.find((t) => t.key === k) || {}).name || k;
        b.classList.toggle('active', k === this.tag);
        b.innerHTML = name + (n ? `<span class="n">${n}</span>` : '');
      });
    },
    setTag(tag) {
      if (this.tag === tag) return;
      this.tag = tag;
      this.renderTabs();
      this.renderAll();
    },
    clear() {
      this.lines = [];
      const body = $('#logBody');
      if (body) body.innerHTML = '';
      this.syncCount();
      this.renderTabs();
    },
    text() {
      return this.lines
        .map((l) => `[${l.t}] [${(LOG_TAGS.find((t) => t.key === l.tag) || {}).name || l.tag}] ${l.level.toUpperCase()} ${l.msg}${l.n > 1 ? ' ×' + l.n : ''}`)
        .join('\n');
    }
  };

  // ============================================================
  // 4.1 累计统计（跨会话保存）
  // ============================================================
  const STAT_ITEMS = [
    { key: 'popup', label: '弹讲解', hot: true },
    { key: 'comment', label: '发评', hot: true },
    { key: 'coupon', label: '发券', hot: true },
    { key: 'seckill', label: '秒杀', hot: true },
    { key: 'refresh', label: '后台刷新', hot: false },
    { key: 'fail', label: '失败', hot: false, bad: true }
  ];

  const Stats = {
    get data() {
      if (!cfg.stats || typeof cfg.stats !== 'object') cfg.stats = {};
      return cfg.stats;
    },
    bump(key, n) {
      const d = this.data;
      d[key] = (Number(d[key]) || 0) + (Number(n) || 1);
      this.render();
      saveConfig();
    },
    reset() {
      const d = this.data;
      for (const it of STAT_ITEMS) d[it.key] = 0;
      d.since = new Date().toISOString().slice(0, 10);
      this.render();
      saveConfig();
      Log.push('info', '累计统计已清零', 'sys');
    },
    render() {
      const box = $('#statsBox');
      if (!box) return;
      const d = this.data;
      const since = d.since ? `　自 ${d.since}` : '';
      box.innerHTML = `
        <div class="stat-head">累计<span class="stat-reset" data-action="stats-reset" title="清零累计（不影响正在跑的功能）">清零</span></div>
        ${STAT_ITEMS.map((it) => `
          <div class="stat-row${it.bad ? ' bad' : (it.hot ? ' hot' : '')}">
            <span>${it.label}</span><b>${Number(d[it.key]) || 0}</b>
          </div>`).join('')}
        ${since ? `<div class="stat-since">${since}</div>` : ''}`;
    }
  };


  // ============================================================
  // 5. 与内嵌网页通信（经主进程注入，覆盖页面内所有 frame / iframe）
  // ============================================================
  const view = $('#view');
  let libLoaded = false;

  // 主界面「被导航」的许可窗口：只有用户自己点（前往/刷新/站点切换/后退）才打开。
  // 窗口外主界面被重新加载 = 有东西在动用户正看的页面，必须记下来。
  let mainNavOkAt = 0;
  function markMainNav(ms) { mainNavOkAt = Date.now() + (Number(ms) || 15000); }
  let bootAt = 0;      // 启动完成的时刻（启动时的首次加载不算「被偷袭」）

  async function loadLib() {
    if (libLoaded) return;
    const src = document.getElementById('tp-lib').textContent;
    const res = await window.tp.setLib(src);
    libLoaded = !!(res && res.ok);
    if (libLoaded) Log.push('info', `自动化脚本已装载（${res.size} 字节）`);
    else Log.push('err', '自动化脚本装载失败');
  }

  // opts.quiet = 不把失败计入「后台页故障」
  //   只读接口（实时数据/保活）和接口优先的旁路调用用 quiet，
  //   否则后台页还没就绪时每 10 秒就攒一次「故障」，凑够 2 次就把中控台刷掉，
  //   刷完又没就绪 —— 变成一直刷、永远加载不完。
  async function call(method, args = [], target, opts = {}) {
    await loadLib();
    const argStr = args.map((a) => JSON.stringify(a)).join(', ');
    const code = `(async () => { return await window.__TP.${method}(${argStr}); })()`;
    const t = target || PAGE.target();
    const fatal = /guest-not-ready|no-frame|frame-.*-timeout|all-frames-failed/;
    try {
      const r = await window.tp.call(code, t);
      // 后台页页面级失败监测：frame 超时 / guest 不可用 / 页面卡死 → 累计，达阈值自动刷新后台页。
      // 业务性失败（not-found / covered / out-of-view 等）不算，那些靠各功能自己的重试处理。
      if (!opts.quiet && t === 'worker' && r && r.ok === false && fatal.test(String(r.reason || ''))) {
        Worker.notePageFailure();
      }
      return r;
    } catch (e) {
      if (!opts.quiet && t === 'worker') Worker.notePageFailure();
      return { ok: false, reason: String(e.message || e) };
    }
  }

  // ============================================================
  // 5.1 页面独占调度器（PageBus）—— 解决「多个功能一起开就互相抢」
  //
  // 为什么之前会抢：每个功能都是一个独立的 async 循环，各自直接操作同一个内嵌页面。
  //   发券要拉开抽屉、秒杀要开抽屉、弹讲解要点商品卡、发评要聚焦输入框。
  //   抽屉一拉开就是全屏遮罩，别人的点击全落在遮罩上；发评正在打字时弹讲解又把焦点抢走……
  //   谁先谁后完全随机，所以「单跑都行，一起开就废」。
  //
  // 现在：所有会动页面（点击 / 输入 / 导航 / 开关抽屉）的动作都必须在 PageBus 里领号。
  //   · 同一时刻只有一个任务在动页面，其余按优先级排队（手动操作 > 弹讲解 > 循环任务）
  //   · 每个任务把动作切成尽量小的「原子段」，段与段之间调用 yield 让出，
  //     这样发券的 60 秒间隔、秒杀的 10 秒等待都不会挡住别人
  //   · 交还页面之前必须把抽屉/弹窗收干净（closeOverlays），下一个任务拿到的一定是干净的中控台
  //   · 真人在点页面时（页面侧上报的可信鼠标/键盘事件）机器人主动让位，不和人对抢
  // ============================================================
  const HUMAN_YIELD_MS = () => Math.max(0, Number(cfg.sched && cfg.sched.humanYieldSec) || 0) * 1000;
  const STEP_YIELD_MS = () => Math.max(120, Number(cfg.sched && cfg.sched.stepYieldMs) || 260);
  // 给官方弹层让位的最长时间：超过就强制放行，避免残留节点导致机器人永久停摆
  const DRAWER_YIELD_MAX_MS = () => Math.max(3000, Number(cfg.sched && cfg.sched.drawerYieldMaxMs) || 15000);

  const PageBus = {
    holder: null,        // { name, owner, prio, since, depth }
    inBody: false,       // 正在临界区里执行（只有这时才允许重入）
    queue: [],
    seq: 0,
    humanUntil: 0,
    drawerLogAt: 0,
    drawerSince: 0,   // 连续给官方弹层让位的起始时刻（用于超时放行）
    drawerForced: 0,  // 连续「等到超时才放行」的次数（满 3 次自动关掉这项礼让）
    humanLogAt: 0,
    timer: null,
    stats: { acquired: 0, waited: 0, maxWait: 0, yielded: 0, humanYields: 0 },

    // 进出临界区的轨迹（只留最近 400 条）：出问题时能核对「有没有两个功能同时在动页面」
    trace: [],
    record(kind, name) {
      this.trace.push({ k: kind, n: name, at: Date.now() });
      if (this.trace.length > 400) this.trace.splice(0, this.trace.length - 400);
    },

    current() { return this.holder ? this.holder.name : ''; },
    waiting() { return this.queue.length; },
    queueNames() { return this.queue.map((q) => q.name); },

    // 同一任务在自己的临界区里再次申请 → 直接放行（不重复排队、不重复释放）
    acquire(name, owner, opts) {
      const o = opts || {};
      if (this.holder && owner && this.holder.owner === owner) {
        this.holder.depth++;
        return Promise.resolve(true);
      }
      const item = { name, owner, prio: Number(o.prio) || 0, token: o.token || null, at: Date.now(), prev: this.current(), timer: null };
      return new Promise((resolve) => {
        item.resolve = resolve;
        // 排队超时兜底：万一有任务异常没交还页面，别让后面的任务永远卡住
        item.timer = setTimeout(() => {
          const i = this.queue.indexOf(item);
          if (i < 0) return;
          this.queue.splice(i, 1);
          Log.push('warn', `「${name}」等了 ${Math.round((Date.now() - item.at) / 1000)} 秒还没轮到上手，本次跳过`);
          renderRunBar();
          resolve(false);
        }, 180000);
        // 插队：优先级高的排在前面；同优先级严格 FIFO（不饿死任何任务）
        let idx = this.queue.length;
        for (let i = 0; i < this.queue.length; i++) {
          if (this.queue[i].prio < item.prio) { idx = i; break; }
        }
        this.queue.splice(idx, 0, item);
        renderRunBar();
        this.pump();
      });
    },

    release(owner) {
      if (!this.holder) return;
      if (owner && this.holder.owner !== owner) return;   // 不是自己的锁，绝不乱放
      this.holder.depth--;
      if (this.holder.depth > 0) return;
      this.record('out', this.holder.name);
      this.holder = null;
      this.pump();
      renderRunBar();
    },

    // 让出页面：把锁交出去，喘一口气，再重新排队拿回来。
    // 这是「一起开也能跑」的关键 —— 长任务不会长时间霸占页面。
    async yieldPage(name, owner, minMs) {
      const h = this.holder;
      const wait = Math.max(STEP_YIELD_MS(), Number(minMs) || 0);
      if (!h || h.owner !== owner) { await sleep(wait); return; }
      const prio = h.prio;
      const token = h.token;
      h.depth = 0;              // 让 pump 认为已释放
      this.holder = null;
      this.stats.yielded++;
      this.pump();
      await sleep(wait);
      await this.acquire(name, owner, { prio: prio, token: token });
    },

    // 全员停止：把还在排队的申请直接作废，避免停了以后又被"授予"一次
    purge() {
      const q = this.queue.splice(0, this.queue.length);
      q.forEach((it) => { try { if (it.timer) clearTimeout(it.timer); it.resolve(false); } catch (e) {} });
      renderRunBar();
    },

    // 用轨迹算一次「有没有重叠」：正常应该 in/out 严格交替
    overlap() {
      let depth = 0;
      let bad = 0;
      let maxDepth = 0;
      for (const ev of this.trace) {
        if (ev.k === 'in') { depth++; maxDepth = Math.max(maxDepth, depth); if (depth > 1) bad++; }
        else depth = Math.max(0, depth - 1);
      }
      return { overlap: bad, maxDepth: maxDepth, open: depth };
    },

    // 真人让位：页面侧上报「刚刚有真人在这儿点/打字」
    async humanLeft() {
      if (!cfg.sched || cfg.sched.humanYield === false) return 0;
      const r = await call('humanInfo', []).catch(() => null);
      if (!r || !r.age) return 0;
      const win = HUMAN_YIELD_MS();
      if (win <= 0) return 0;
      const left = win - Number(r.age);
      if (left > 0) this.humanUntil = Math.max(this.humanUntil, Date.now() + left);
      return left > 0 ? left : 0;
    },

    // 授予锁。注意是异步的（要先问一下页面侧真人有没有在操作），
    // 所以必须用 pumping 做单飞：并发调用 pump 会导致同一次让出被授予给两个任务。
    // 官方抽屉/确认弹窗是否正开着（读不到就当没开，不阻塞调度）
    async drawerBusy() {
      try {
        // 这是调度前的探针，读不到就当没开；别让它把页面判成故障
        const r = await call('officialBusy', [], undefined, { quiet: true });
        if (!r || !r.busy) return null;
        return { why: String(r.why || '弹层'), el: String(r.el || '') };
      } catch (e) {
        return null;
      }
    },

    async pump() {
      if (this.holder || !this.queue.length || this.pumping || this.timer) return;
      this.pumping = true;
      try {
        while (!this.holder && this.queue.length) {
          // 真人在操作 → 先别动页面，等 TA 停手
          const left = await this.humanLeft();
          if (left > 0) {
            if (Date.now() - this.humanLogAt > 4000) {
              this.humanLogAt = Date.now();
              this.stats.humanYields++;
              Log.push('info', `检测到真人在操作页面，机器人自动让位 ${(left / 1000).toFixed(1)} 秒`);
            }
            this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.min(left + 120, 3000));
            return;
          }
          if (this.holder || !this.queue.length) return;

          // 官方抽屉/弹窗正开着 → 先让位。
          // 那种时候点下去全是遮罩，动作会"成功但没效果"，甚至把官方弹窗关掉。
          // 等它自己关掉再继续，比硬点一次然后失败重试划算。
          if (cfg.api.drawerYield) {
            const dr = await this.drawerBusy();
            if (dr) {
              const now = Date.now();
              if (!this.drawerSince) this.drawerSince = now;
              // 兜底：抖音关掉的抽屉常常还留着 DOM，容易被认成"一直开着"。
              // 让位超过上限就强制放行一次，绝不能把整个调度卡死。
              if (now - this.drawerSince > DRAWER_YIELD_MAX_MS()) {
                this.drawerSince = 0;
                this.drawerLogAt = 0;
                this.drawerForced += 1;
                Log.push('warn', `官方弹层礼让已等 ${(DRAWER_YIELD_MAX_MS() / 1000).toFixed(0)} 秒（${dr.why}），先放行一次`);
                // 自愈：同一个"弹层"连续等到超时 3 次，基本可以确定是误判
                // （抖音关掉的抽屉会留下 DOM 节点）。再让下去机器人就废了，直接关掉这项。
                if (this.drawerForced >= 3 && cfg.api.drawerYield) {
                  cfg.api.drawerYield = false;
                  this.drawerForced = 0;
                  try { saveConfig(); } catch (e) { /* 存不下也先把这一轮放开 */ }
                  Log.push('warn', '连续 3 次等到超时，已自动关闭「官方抽屉打开时让位」——如需重新开启：设置 → 接口通道');
                }
              } else {
                if (now - this.drawerLogAt > 8000) {
                  this.drawerLogAt = now;
                  Log.push('info', `官方抽屉/弹窗正开着，机器人先等它关掉${dr.why ? '（' + dr.why + '）' : ''}`);
                }
                this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 2000);
                return;
              }
            } else {
              this.drawerSince = 0;
              // 一路顺畅（弹层确实关掉了）→ 清掉误判计数
              if (this.drawerForced) this.drawerForced = 0;
            }
          }

          const item = this.queue.shift();
          if (item.timer) { clearTimeout(item.timer); item.timer = null; }
          const waited = Date.now() - item.at;
          // 申请的时候任务已经被停掉了 → 直接作废，别白占一次
          if (item.token && item.token.alive === false) { item.resolve(false); continue; }

          this.holder = { name: item.name, owner: item.owner, prio: item.prio, token: item.token, since: Date.now(), depth: 1 };
          this.record('in', item.name);
          this.stats.acquired++;
          this.stats.waited += waited;
          this.stats.maxWait = Math.max(this.stats.maxWait, waited);
          // 等太久才轮到 → 写一行日志，方便排查「为什么点了没反应」
          if (waited > 2500) Log.push('info', `「${item.name}」等了 ${(waited / 1000).toFixed(1)} 秒才轮到上手（前一个：${item.prev || '—'}）`);
          item.resolve(true);
          renderRunBar();
        }
      } finally {
        this.pumping = false;
        // 兜底：万一上面的 await 期间又有人排队，保证还有人接着调度
        if (!this.holder && this.queue.length && !this.timer) setTimeout(() => this.pump(), 30);
      }
    }
  };

  // 拿锁执行一段「必须一口气做完」的页面动作
  // · owner：任务令牌（同一令牌可重入，不会自己把自己锁死）
  // · inBody 标记：只有「正在临界区里执行」的代码才允许重入，
  //   避免「刚释放锁的下一个动作」顺手蹭进别人的临界区
  async function withTask(name, token, fn, opts) {
    return runLocked(name, token || manualOwner(), fn, Object.assign({ token: token }, opts || {}));
  }

  // 一次性动作（手动点按钮触发 / 内部工具函数）：没令牌时自建一个，优先级最高
  function manualOwner() { return { manual: true, id: uid() }; }
  async function withPage(name, fn, opts) {
    return runLocked(name, manualOwner(), fn, Object.assign({ prio: 2 }, opts || {}));
  }
  // 一次性动作的清空别名（保留旧调用点可读性）
  async function withPageNow(name, fn) { return withPage(name, fn, { prio: 2 }); }

  async function runLocked(name, owner, fn, opts) {
    const o = opts || {};
    // 重入只认「同一个 owner」：带着同一个任务令牌再进来（第一次调用后又被内部调用），
    // 直接放行不排队。注意不能用「有没有人在临界区里」来判断 —— 别的任务恰好在
    // 临界区里 await 时，它的代码也会看到那个标记，那样就又变成抢了。
    const got = await PageBus.acquire(name, owner, { prio: Number(o.prio) || 0, token: o.token || null });
    if (!got) return { ok: false, reason: 'aborted' };
    if (o.token && o.token.alive === false) { PageBus.release(owner); return { ok: false, reason: 'aborted' }; }
    PageBus.inBody = true;
    try {
      // 临界区开始前先看一眼真人有没有在用
      await PageBus.humanLeft();
      return await fn();
    } finally {
      PageBus.inBody = false;
      PageBus.release(owner);
    }
  }

  // 所有注入输入的**唯一出口**：先告诉页面「接下来的事件是我发的」，
  // 页面侧的真人探测器才不会把机器人自己当成真人（否则会一直自我让位）。
  async function tpTap(x, y, target) {
    await call('markInject', [1600], target).catch(() => {});
    return window.tp.realClick(x, y, target || PAGE.target());
  }
  async function tpMove(x, y, target) {
    await call('markInject', [1200], target).catch(() => {});
    return window.tp.realMove(x, y, target || PAGE.target());
  }
  async function tpType(x, y, text, target) {
    await call('markInject', [Math.max(2500, String(text || '').length * 260)], target).catch(() => {});
    return window.tp.realType(x, y, text, target || PAGE.target());
  }
  async function tpKey(key, times, target) {
    await call('markInject', [1600], target).catch(() => {});
    return window.tp.realKey(key, times, target || PAGE.target());
  }
  async function tpEnter(target) {
    await call('markInject', [1600], target).catch(() => {});
    return window.tp.realEnter(target || PAGE.target());
  }

  // ============================================================
  // 5.05 后台工作页（Worker Pages）
  //
  // 目标：自动任务全部在一个「用户看不见的页面」里跑，主界面（人看的那个）完全不动。
  //
  // 可行性实测（2026-10-22）：
  //   · 同一账号可以同时开两个中控台页面，同一个 partition 共享登录态，互不踢；
  //   · 一个页在后台把商品列表滚到底抓数据，另一个页照常工作，观察 20 秒无异常。
  //
  // 关键实现细节：
  //   · 视口必须给足 1600×1200（中控台是固定宽布局）—— 宽度不够，右侧按钮就"在视口外"点不到；
  //   · 只能靠 opacity + 被主视图盖住来隐藏，绝不能用 display:none，那样不渲染、元素尺寸全 0；
  //   · 后台页不缩放（缩放会让坐标空间和命中测试都不稳），主界面该缩放开着不受影响。
  // ============================================================
  const Worker = {
    el: null,
    state: 'idle',        // idle | loading | ready | failed
    reason: '',
    startedAt: 0,
    waiters: [],
    _refreshTimer: null,  // 定时自动刷新
    _healthTimer: null,   // 卡死探测
    _healthFails: 0,      // 连续探测失败次数

    enabled() { return !(cfg.engine && cfg.engine.mode === 'current'); },

    // 确保后台页可用；返回 true 表示「自动化跑在后台页」
    async ensure(timeoutMs) {
      if (!this.enabled()) return false;
      if (this.state === 'ready' && this.alive()) return true;
      if (this.state === 'loading') return this.waitReady(timeoutMs || 45000);

      this.state = 'loading';
      this.startedAt = Date.now();
      Log.push('info', '正在启动后台工作页（自动任务都在这里跑，主界面不会被占用）…');
      try {
        this.spawn();
      } catch (e) {
        this.fail(e && e.message ? e.message : String(e));
        return false;
      }
      const ok = await this.waitReady(timeoutMs || 45000);
      if (!ok) {
        const lp = this.lastProbe ? JSON.stringify(this.lastProbe).slice(0, 100) : '无探测结果';
        this.fail(`页面没在预期时间内就绪 ${lp}`);
      }
      return overridden();
    },

    // 注意：<webview> 元素没有 isDestroyed()（那是 webContents 的方法），
    // 旧写法调它会抛异常 → 这里恒返回 false → 等待循环空转到超时，后台页永远「起不来」。
    // 用 DOM 的 isConnected 判断元素是否还在文档里。
    alive() {
      const el = this.el;
      if (!el) return false;
      try {
        if (typeof el.isDestroyed === 'function') return !el.isDestroyed();
        return !!el.isConnected;
      } catch (e) { return !!el.isConnected; }
    },

    spawn() {
      const host = document.getElementById('workerHost');
      if (!host) throw new Error('缺少 #workerHost 容器');
      if (this.el) { try { this.el.remove(); } catch (e) {} }
      const wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:douyin');
      wv.setAttribute('webpreferences', 'backgroundThrottling=false');
      wv.setAttribute('src', String(cfg.site || DEFAULTS.site));
      host.appendChild(wv);
      this.el = wv;

      wv.addEventListener('dom-ready', () => {
        try {
          const id = wv.getWebContentsId();
          window.tp.registerGuest('worker', id).then((r) => {
            if (r && r.ok) Log.push('info', `后台页已登记（webContents ${id}）`);
            else Log.push('warn', '后台页登记失败：' + ((r && r.reason) || '未知'));
          }).catch(() => {});
        } catch (e) { /* dom-ready 前拿不到 id，下面 probe 会兜住 */ }
      });
      wv.addEventListener('did-fail-load', (e) => {
        Log.push('warn', '后台页加载失败：' + ((e && (e.errorDescription || e.validatedURL)) || '未知'));
      });
      // 渲染进程崩溃：所有功能一起开时高频 CDP 操作 + 大量 iframe 抽屉，
      // 后台页偶发会崩。崩了之后 Worker.state 仍是 ready、页面却已死，
      // 所有动作（尤其弹讲解）静默失效，只能靠手动「↻ 重建」恢复 —— 这里改成自动重建。
      wv.addEventListener('render-process-gone', (e) => {
        const why = (e && (e.reason || '')) || 'unknown';
        Log.push('err', `后台页渲染进程异常（${why}），自动重建…`);
        this.state = 'idle';
        this.reason = '';
        const dead = this.el;
        this.el = null;
        try { if (dead) dead.remove(); } catch (err) {}
        // 稍等片刻再重建，避免崩溃瞬间反复拉起
        setTimeout(() => { if (!this.el && this.enabled()) this.ensure(60000).catch(() => {}); }, 1500);
      });
    },

    async waitReady(timeoutMs) {
      const deadline = Date.now() + (Number(timeoutMs) || 45000);
      let registered = false;
      this.lastProbe = null;
      while (Date.now() < deadline) {
        if (!this.alive()) { await sleep(400); continue; }
        if (!registered) {
          try {
            const id = this.el.getWebContentsId();
            const r = await window.tp.registerGuest('worker', id);
            registered = !!(r && r.ok);
          } catch (e) { /* 还没 dom-ready */ }
        }
        let p = null;
        try {
          p = await Promise.race([
            window.tp.workerReady('#live-card-list, #current-live-room'),
            new Promise((r) => setTimeout(() => r({ found: false, reason: 'probe-timeout' }), 8000))
          ]);
        } catch (e) { p = { found: false, reason: String(e && e.message || e) }; }
        this.lastProbe = p;
        if (!this.probeLogged && (!p || !p.found)) {
          this.probeLogged = true;
          Log.push('warn', `后台页还在加载：${(p && (p.reason || JSON.stringify(p).slice(0, 60))) || '空返回'}`);
        }
        if (p && p.found) {
          this.state = 'ready';
          this.startHealth();
          // 后台页不缩放：固定 1.0，坐标空间才稳定
          try { this.el.setZoomFactor(1); } catch (e) {}
          const url = PAGE.url('worker');
          Log.push('ok', `后台页就绪（${Math.round((Date.now() - this.startedAt) / 1000)} 秒），自动化不再占用主界面`);
          if (url && url.indexOf('/livesite/live/current') < 0) {
            Log.push('warn', '后台页不在中控台首页，抓到数据可能不对：' + url);
          }
          refreshStatus();
          return true;
        }
        await sleep(1200);
      }
      return false;
    },

    fail(why) {
      this.state = 'failed';
      this.reason = why || 'unknown';
      // 注意：不再"退回主界面执行"。后台模式下退回主界面 = 去点用户正在看的那个页面，
      // 用户明确不要这个行为。所以只报错 + 自动重试。
      Log.push('err', `后台页启动失败（${this.reason}），将在后台自动重试`);
      this._scheduleRetry();
      refreshStatus();
    },

    // 重载后台页（卡住/登录态变了时用）
    async restart() {
      if (!this.enabled()) { Log.push('warn', '当前是「使用当前页面」模式，没有后台页'); return; }
      this.state = 'idle';
      this.reason = '';
      this.stopHealth();
      if (this.el) { try { this.el.remove(); } catch (e) {} }
      this.el = null;
      Log.push('info', '正在重建后台页…');
      const ok = await this.ensure(60000);
      if (ok) Log.push('ok', '后台页已重建');
    },

    // 「功能失败 → 自动刷新后台页试试」的统一入口。
    // 关键规矩：
    //   ① 只 reload 后台页（用户看不见的那个），主界面一像素都不动；
    //   ② 必须等「没有任务在占页面」时才刷 —— 任务跑到一半刷掉页面，会把正在填的表单/打开的抽屉全毁掉，
    //      表现为"所有功能突然失效"（这正是上一版踩的坑）；
    //   ③ 刷完等就绪，起不来才整个重建，重建也只重建后台页。
    _failCount: 0,
    _failSince: 0,
    _refreshing: false,
    _refreshPending: false,
    _refreshTimer: null,
    notePageFailure() {
      // 计数放在最前面：用来验证「quiet 调用根本没走到这里」，
      // 下面的 state/ready 门槛不算在内（那是另一回事）。
      this._pageFailCalls = (this._pageFailCalls || 0) + 1;
      if (!this.enabled() || this.state !== 'ready' || this._refreshing) return;
      const now = Date.now();
      if (now - this._failSince > 30000) { this._failCount = 0; this._failSince = now; }
      this._failCount++;
      if (this._failCount < 3) return;
      this._failCount = 0;
      // 别急着刷：先确认页面是不是「真的没响应」。偶发的单次 frame 超时很常见，
      // 那种刷了只会白打断任务，还会让用户以为功能坏了。
      this._confirmDeadThenRefresh();
    },

    // 功能级失败（不是页面死，而是操作一直被挡/点不上）：连续 2 次也刷一次后台页试试。
    // 场景：抽屉/遮罩卡在后台页上，单人时看不出，多任务一起开时最容易遇到。
    _taskFails: 0,
    _taskFailSince: 0,
    _taskFailTag: '',
    noteTaskFailure(tag) {
      if (!this.enabled() || this.state !== 'ready' || this._refreshing) return;
      const now = Date.now();
      // 自动刷新冷却：多任务一起跑的时候，一次刷新会让所有任务同时报错，
      // 各自再触发一次刷新 —— 就变成一直被刷、什么都没干成（刷新风暴）。
      // 90 秒内已经自动刷过一次的话，这次只记日志，不再刷。
      if (now - (this._lastAutoRefreshAt || 0) < 90000) {
        Log.push('info', `${tag || '功能'} · 最近刚刷过后台页，这次先不刷，继续重试`);
        return;
      }
      if (tag !== this._taskFailTag || now - this._taskFailSince > 180000) {
        this._taskFails = 0; this._taskFailSince = now; this._taskFailTag = tag || '';
      }
      this._taskFails++;
      Log.push('warn', `${tag || '功能'} · 本轮没成功（连续 ${this._taskFails} 次）`);
      if (this._taskFails >= 2) {
        this._taskFails = 0;
        Log.push('warn', `${tag || '功能'}连续失败，刷新后台页试试`);
        this._refreshPending = true;
        this._scheduleIdleRefresh();
      }
    },

    // 自动健康检测：后台页每隔 45 秒自检一次（主进程直探，不动页面、不占锁）。
    // 连续 2 次没响应 → 自动刷新。这样即使没有任务触发失败，卡死也能被发现。
    _healthTimer: null,
    _healthFails: 0,
    startHealth() {
      if (this._healthTimer || !this.enabled()) return;
      this._healthTimer = setInterval(async () => {
        if (!this.enabled() || this.state !== 'ready' || this._refreshing) return;
        // 有任务正占着页面 / 在排队时不做探测：页面忙的时候响应慢是正常的，
        // 这时候判「没响应」会把后台页刷掉，把所有正在跑的功能一起打断。
        // 真死的情况还有另一条路兜底：任务连续失败会 noteTaskFailure 触发刷新。
        if (PageBus.holder || (PageBus.queue && PageBus.queue.length)) return;
        let p = null;
        try {
          // 活体探针：探测「页面是否还活着」（DOM 根元素还在），而不是「是否在直播」。
          // 之前探 #live-card-list/#current-live-room，用户下播后这两个元素不存在，
          // 被误判成「页面卡死」→ 触发 el.reload() → macOS 27 上渲染进程 clean-exit + 底层崩溃。
          p = await Promise.race([
            window.tp.workerReady('body').catch(() => ({ found: false })),
            new Promise((r) => setTimeout(() => r({ found: false, reason: 'timeout' }), 6000))
          ]);
        } catch (e) { p = { found: false }; }
        if (p && p.found) { this._healthFails = 0; return; }
        this._healthFails++;
        Log.push('warn', `后台页自检没响应（${this._healthFails}/2）`);
        if (this._healthFails >= 2) {
          this._healthFails = 0;
          Log.push('warn', '后台页连续没响应，自动刷新');
          this._refreshPending = true;
          this._scheduleIdleRefresh();
        }
      }, 45000);
    },
    stopHealth() {
      if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    },

    _confirming: false,
    async _confirmDeadThenRefresh() {
      if (this._confirming || this._refreshing || this.state !== 'ready') return;
      this._confirming = true;
      try {
        const probeOnce = () => Promise.race([
          window.tp.workerReady('body').catch(() => ({ found: false })),
          new Promise((r) => setTimeout(() => r({ found: false, reason: 'timeout' }), 6000))
        ]);
        const a = await probeOnce();
        if (a && a.found) { Log.push('info', '后台页偶尔超时，但已确认有响应，先不刷新'); return; }
        await sleep(1200);
        const b = await probeOnce();
        if (b && b.found) { Log.push('info', '后台页偶尔超时，但已确认有响应，先不刷新'); return; }
        Log.push('warn', '后台页连续无响应，准备刷新（等当前任务收尾）');
        this._refreshPending = true;
        this._scheduleIdleRefresh();
      } finally {
        this._confirming = false;
      }
    },

    // 每 2 秒看一次：只要「没人正在动页面」，就刷。
    // 注意不能用 pageBusy()（它把"有任务在跑"也算忙）——功能在跑的时候永远不空闲，
    // 刷新就永远等不到（上一版"等 10 轮都没触发刷新"就是这个原因）。
    // 任务手上有页面（PageBus 有持有者/排队）时才算真忙；等太久（25 秒）就强刷。
    _scheduleIdleRefresh() {
      if (this._refreshTimer) return;
      const deadline = Date.now() + 25000;
      const tick = () => {
        if (!this._refreshPending) { this._refreshTimer = null; return; }
        if (!this.enabled() || this.state !== 'ready') { this._refreshTimer = null; return; }
        const touching = (PageBus.holder && PageBus.holder.name) || (PageBus.queue && PageBus.queue.length);
        if (touching && Date.now() < deadline) { this._refreshTimer = setTimeout(tick, 2000); return; }
        this._refreshTimer = null;
        this._refreshPending = false;
        this._doRefresh();
      };
      this._refreshTimer = setTimeout(tick, 800);
    },

    async _doRefresh() {
      if (this._refreshing || !this.enabled() || this.state !== 'ready') return;
      this._refreshing = true;
      this._lastAutoRefreshAt = Date.now();
      this.stopHealth();
      this.state = 'loading';       // 期间所有调用仍然指向后台页（见 PAGE.target）
      Stats.bump('refresh');
      // 诊断：把「刷的是哪个 webContents」和主界面地址一起记下来。
      // 万一又出现「后台刷新带动前台」，这几行能直接指出是谁被刷了。
      let wid = '?';
      try { wid = this.el.getWebContentsId(); } catch (e) {}
      const mainUrlBefore = PAGE.url('main');
      Log.push('warn', `后台页无响应，正在刷新后台页（webContents ${wid}，主界面完全不受影响）…`);
      try {
        try { this.el.reload(); } catch (e) {}
        let ok = await this.waitReady(25000);
        if (!ok) {
          Log.push('warn', '刷新后没起来，改为整个重建后台页…');
          this.state = 'idle';
          if (this.el) { try { this.el.remove(); } catch (e) {} }
          this.el = null;
          ok = await this.ensure(45000);
        }
        const mainUrlAfter = PAGE.url('main');
        if (mainUrlBefore && mainUrlAfter && mainUrlBefore !== mainUrlAfter) {
          Log.push('err', `主界面地址在后台刷新期间被改动了：${mainUrlBefore.slice(0, 60)} → ${mainUrlAfter.slice(0, 60)}`, 'sys');
        }
        if (ok) {
          try { homeOkAt = 0; homeOkUrl = ''; } catch (e) {}   // 清了缓存，任务下次会重新确认"在家"
          Log.push('ok', '后台页已恢复（刷新完成），正在跑的功能会自动继续');
          this._retryDelay = 15000;
        } else {
          // 关键：绝不能假装"就绪"（上一版就是这么骗自己的：状态说好了、页面其实是死的 →
          // 之后所有调用都静默失败，用户看到的就是"刷新后功能失效"）。
          this.state = 'failed';
          this.reason = '刷新后仍未就绪';
          Log.push('err', '后台页刷新失败，将在后台自动重试（主界面不会被占用）');
          this._scheduleRetry();
        }
      } finally {
        this._refreshing = false;
        refreshStatus();
      }
    },

    // 后台页起不来时的自动重试（指数退避，最多 60 秒一次）。
    // 后台模式下永远不会"退回主界面"干活，所以必须有这个，否则一次失败就永久停摆。
    _retryDelay: 15000,
    _retryTimer: null,
    _scheduleRetry() {
      if (this._retryTimer || !this.enabled()) return;
      const delay = Math.max(5000, Math.min(60000, this._retryDelay || 15000));
      this._retryDelay = Math.min(60000, delay * 2);
      this._retryTimer = setTimeout(async () => {
        this._retryTimer = null;
        if (!this.enabled()) return;
        if (this.state === 'ready') return;
        if (pageBusy()) { this._scheduleRetry(); return; }
        Log.push('info', '正在重试启动后台页…');
        this.state = 'idle';
        const ok = await this.ensure(45000).catch(() => false);
        if (ok) { this._retryDelay = 15000; Log.push('ok', '后台页已恢复'); }
        else this._scheduleRetry();
      }, delay);
    },
  };

  // 有个小坑：ensure 里最后要判断「是否真的用上了后台页」，抽出来避免误判
  function overridden() { return Worker.state === 'ready'; }

  // 有没有任务正在占着页面（刷后台页必须等空闲，否则会把跑到一半的任务打断）
  function pageBusy() {
    try {
      if (PageBus.holder || (PageBus.queue && PageBus.queue.length)) return true;
    } catch (e) {}
    try {
      if (typeof running !== 'undefined' && running) {
        for (const k of Object.keys(running)) if (running[k]) return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------- 页面路由 ----------
  // 所有 call / 点击 / 导航默认都发到 PAGE.target()。
  // 重要：后台模式下只允许指向后台页 —— 后台页在刷新/重启（idle/loading）期间也不能临时退回主界面，
  // 否则自动化会去点/滚「用户正在看的那个页面」，还会把它导航走（缩放跟着恢复成 100%）。
  // 只有后台页「彻底起不来」(failed) 或用户显式选了「使用当前页面」时才用主界面。
  const PAGE = {
    target() {
      if (cfg.engine && cfg.engine.mode === 'current') return 'main';
      // 后台模式：永远只指向后台页。起不来就等它自动重试 —— 绝不偷偷退回主界面，
      // 那会去点/滚/导航用户正在看的那个页面（这也是"后台刷新影响前台"的根源）。
      return 'worker';
    },
    el(target) {
      const t = target || this.target();
      // 明确要后台页就只给后台页；没建好返回 null，绝不悄悄换成主界面（那会动到用户正在看的页面）
      if (t === 'worker') return Worker.el || null;
      return view;
    },
    url(target) {
      try { const el = this.el(target); return el && el.getURL ? String(el.getURL() || '') : ''; } catch (e) { return ''; }
    },
    onWorker() { return this.target() === 'worker'; }
  };

  // 统一动作出口：试运行时只记录不执行
  async function act(kind, humanText, fn) {
    const h = cfg.humanize;
    if (cfg.dryRun) {
      Log.push('info', `[试运行] 将执行 ${kind}：${humanText}`);
      return { ok: true, dryRun: true };
    }
    const t0 = Date.now();
    let res;
    try {
      res = await fn();
    } catch (e) {
      Log.push('err', `${kind} 执行异常：${e.message}`);
      return { ok: false, error: e.message };
    }
    if (!res || res.ok === false) {
      Log.push('err', `${kind} 失败（${(res && res.reason) || '未知原因'}）：${humanText}`);
      Stats.bump('fail');
      return res || { ok: false };
    }
    Log.push('ok', `${kind} → ${humanText}`);
    // 动作最小间隔，避免连续高频操作
    const cost = Date.now() - t0;
    const floor = h.actionFloorMs || 0;
    if (floor > cost) await sleep(humanJitter(floor - cost));
    return res;
  }

  // ============================================================
  // 5.5 真实点击
  // 合成事件（dispatchEvent）isTrusted=false，抖音后台只走 hover、不触发点击逻辑，
  // 表现为"鼠标停在了上面"。所以统一改成：页面内算坐标 → 主进程发真实鼠标事件。
  // 注意：页面设置了缩放（zoomFactor≠1）时，页面内 getBoundingClientRect 的坐标
  // 是"缩放后布局像素"，而 sendInputEvent 用的是 webview 视口像素 —— 必须乘回缩放倍率。
  // ============================================================
  function zoomFactorOf() {
    try { return (view && view.getZoomFactor) ? Number(view.getZoomFactor()) || 1 : 1; }
    catch (e) { return 1; }
  }

  // 把页面内坐标换算成注入坐标。
  // 关键：CDP（Input.dispatchMouseEvent）用的是「布局视口 CSS 像素」，和 getBoundingClientRect
  // 完全同一套坐标 —— 页面缩放过也不能再乘 zoomFactor（v0.6.0 乘了，导致缩放到 0.7 时
  // 所有点击都打在错位置上，表现为"全部功能失效"）。缩放后的换算只在退回
  // sendInputEvent 时由 guest.js 内部处理。
  function scaledXY(loc) {
    return { x: loc.x, y: loc.y };
  }

  async function realClickAt(locFactory, opts) {
    const o = opts || {};
    const loc = await locFactory();
    if (!loc || !loc.ok) {
      if (loc && loc.reason === 'covered') {
        Log.push('warn', `目标被「${loc.by || '浮层'}」挡住，先尝试关掉弹窗`);
        const c = await call('closeAnyPopup', []);
        if (c && c.ok) Log.push('info', `已关闭弹窗（${c.target || c.how}）`);
        await sleep(humanJitter(800));
        const again = await locFactory();
        if (!again || !again.ok) return again || { ok: false, reason: 'still-covered' };
        const p2 = scaledXY(again);
        const r2 = await tpTap(p2.x, p2.y);
        return r2 && r2.ok ? { ok: true, text: again.text, tag: again.tag } : r2;
      }
      if (loc && loc.reason === 'out-of-view') {
        // ① 先滚到可见（商品/链接多了以后，靠后的那条本来就在画面外）
        if (o.reveal) {
          const rv = await o.reveal().catch(() => null);
          if (rv && rv.ok && rv.moved) Log.push('info', '目标不在画面里，已滚动到可见位置');
          await sleep(humanJitter(220));
          const again = await locFactory();
          if (again && again.ok) {
            const p1 = scaledXY(again);
            const r1 = await tpTap(p1.x, p1.y);
            if (r1 && r1.ok) return { ok: true, text: again.text, tag: again.tag };
          }
        }
        // ② 还是不行：页面整体比窗口宽（中控台固定 1600 宽），只能缩到能看全
        Log.push('warn', `目标在视口外（元素 x=${loc.x}，窗口宽 ${loc.vw}），自动缩到能看全后重试`);
        await fitToWidth(true);
        await sleep(humanJitter(900));
        const again = await locFactory();
        if (!again || !again.ok) {
          Log.push('err', `缩到能看全后还是点不到（${(again && again.reason) || '未知'}）`);
          return again || { ok: false, reason: 'out-of-view' };
        }
        const p2 = scaledXY(again);
        const r2 = await tpTap(p2.x, p2.y);
        return r2 && r2.ok ? { ok: true, text: again.text, tag: again.tag } : r2;
      }
      return loc || { ok: false, reason: 'locate-failed' };
    }
    const p = scaledXY(loc);
    const r = await tpTap(p.x, p.y);
    if (r && r.ok) return { ok: true, text: loc.text, tag: loc.tag };
    return r || { ok: false, reason: 'real-click-failed' };
  }

  function clickReal(selector) {
    return realClickAt(() => call('locate', [selector]), { reveal: () => call('reveal', [selector]) });
  }

  function clickInReal(containerSel, innerSel) {
    return realClickAt(
      () => call('locateIn', [containerSel, innerSel]),
      { reveal: () => call('revealIn', [containerSel, innerSel]) }
    );
  }

  // 商品/链接很多时，卡片列表是懒加载的：靠后的条目一开始根本不在 DOM 里。
  // 点不到就先滚动列表把所有条目加载出来，再重试一次。
  async function retryWithLoadAll(fn, containerSel) {
    const first = await fn();
    if (first && first.ok) return first;
    const why = String((first && first.reason) || '');
    if (!/not-found|inner-not-found|container-not-found|out-of-view|invisible/.test(why)) return first;
    const cont = containerSel || '#live-card-list';
    Log.push('info', `没找到目标（${why}），先把列表滚动加载完整再试一次`);
    await call('loadAll', [cont, 12, 550]).catch(() => null);
    await sleep(300);
    return fn();
  }

  // 关掉确认弹窗 / 抽屉（点各自的 ✕，点不到再 Esc），让中控台回到干净状态
  // 页面「干净」检测：弹窗/抽屉（含优惠券抽屉）都收起来了才算干净。
  // 用户反馈的"发不了券/点不到讲解，多半是抽屉没关完"——这里把判断做成显式的，
  // 并给一个强制的收尾（连点关闭 → Esc → 再确认），脏就报出来。
  async function pageState() {
    const mod = await call('couponModalState', []).catch(() => null);
    const dr = await call('seckillClose', []).catch(() => null);
    const rows = await call('couponPanelRows', []).catch(() => null);
    const modalOpen = !!(mod && mod.ok && mod.close);
    const drawerBtn = !!(dr && dr.ok && dr.point);
    const couponDrawer = !!(rows && rows.ok && rows.count > 0);
    return {
      modalOpen, drawerBtn, couponDrawer,
      clean: !modalOpen && !drawerBtn && !couponDrawer
    };
  }

  // 强制把页面收回干净状态；返回是否真的干净
  async function forceClean(reason) {
    for (let i = 0; i < 3; i++) {
      const st = await pageState();
      if (st.clean) return true;
      if (i === 0) {
        Log.push('info', `页面还有没关的弹层（${st.modalOpen ? '弹窗 ' : ''}${st.drawerBtn ? '抽屉 ' : ''}${st.couponDrawer ? '券面板 ' : ''}），正在收起${reason ? '：' + reason : ''}`);
      }
      await closeOverlays();
      // closeOverlays 主要管弹窗/抽屉按钮；券抽屉常见关不严，补两下 Esc
      if (st.couponDrawer || st.drawerBtn) {
        await tpKey('Escape').catch(() => {});
        await sleep(350);
        await tpKey('Escape').catch(() => {});
        await sleep(350);
      }
      await sleep(400);
    }
    const fin = await pageState();
    if (!fin.clean) Log.push('warn', `页面仍有残留弹层（弹窗=${fin.modalOpen} 抽屉=${fin.drawerBtn} 券面板=${fin.couponDrawer}）`);
    return fin.clean;
  }

  async function closeOverlays() {
    // 没有弹层时立刻返回：启动前每次都会调它，别在这里白等 0.7 秒
    const modFirst = await call('couponModalState', []);
    const drFirst = await call('seckillClose', []);
    const anyOpen = !!(modFirst && modFirst.ok && modFirst.close) || !!(drFirst && drFirst.ok && drFirst.point);
    if (!anyOpen) return false;
    for (let i = 0; i < 2; i++) {
      const st = await call('couponModalState', []);
      if (st && st.ok && st.close) {
        const p = scaledXY(st.close);
        await tpTap(p.x, p.y).catch(() => {});
        await sleep(450);
        continue;
      }
      const dr = await call('seckillClose', []);
      if (dr && dr.ok && dr.point) {
        const p = scaledXY(dr.point);
        await tpTap(p.x, p.y).catch(() => {});
        await sleep(450);
        continue;
      }
      await tpKey('Escape').catch(() => {});
      await sleep(350);
    }
    return true;
  }

  // 收尾：收起弹层；如果已经离开中控台首页，再把页面载回来
  async function backToHome(reason) {
    try { await closeOverlays(); } catch (e) {}
    const url = PAGE.url();
    if (url && url.indexOf('/livesite/live/current') < 0) {
      const el = PAGE.el();
      if (el) { try { el.loadURL(cfg.site || DEFAULTS.site); } catch (e) {} }
      Log.push('info', `已返回直播中控台首页${reason ? '（' + reason + '）' : ''}`);
      await sleep(1200);
    } else {
      Log.push('info', `已收起面板，回到中控台${reason ? '（' + reason + '）' : ''}`);
    }
  }

  // 启动前统一「回到中控台」：
  // 用户可能停在商品管理、数据页、甚至别的站点，点功能时不用手动回首页 ——
  // 这里自动收起弹层、必要时跳回 /livesite/live/current 并等关键节点就绪。
  const CONSOLE_HINT = '/livesite/live/current';

  function viewUrlSafe(target) {
    return PAGE.url(target);
  }

  async function waitConsoleReady(ms) {
    const deadline = Date.now() + (Number(ms) || 20000);
    while (Date.now() < deadline) {
      const p = await call('probe', ['#live-card-list, #current-live-room']);
      if (p && p.found) return true;
      await sleep(800);
    }
    return false;
  }

  // 缓存：多个任务接连启动时不必每次都重新探一遍中控台
  let homeOkAt = 0;
  let homeOkUrl = '';

  async function ensureHome(reason, opts) {
    const force = !!(opts && opts.force);
    // 后台模式：必须后台页真的就绪才动。没就绪就先拉起来，拉不起来就本次放弃（后台会重试），
    // 绝不退回主界面 —— 那会动到用户正在看的页面。
    if (Worker.enabled() && Worker.state !== 'ready') {
      const ok = await Worker.ensure(45000);
      if (!ok || Worker.state !== 'ready') {
        Log.push('warn', `后台页还没就绪，本次先跳过（会自动重试）：${reason || ''}`);
        if (Worker.state === 'failed') Worker._scheduleRetry();
        return { ok: false, navigated: false, reason: 'worker-not-ready' };
      }
    }
    // 同一个页面刚刚确认过在中控台，2 秒内直接复用（调度器保证期间没人切走页面）
    // 但「自救」场景必须强制重查：刚失败说明页面可能被抽屉/遮罩卡住，不能吃缓存。
    const urlNow = viewUrlSafe();
    if (!force && homeOkAt && Date.now() - homeOkAt < 2000 && urlNow === homeOkUrl) {
      return { ok: true, navigated: false, cached: true };
    }
    try { await forceClean('回到中控台前'); } catch (e) {}
    // ① 已经在控制台主界面（能读到商品卡或直播间）——直接开跑，不折腾页面
    const first = await call('probe', ['#live-card-list, #current-live-room']);
    if (first && first.found) {
      homeOkAt = Date.now();
      homeOkUrl = viewUrlSafe();
      return { ok: true, navigated: false };
    }

    const url = viewUrlSafe();
    if (url.indexOf(CONSOLE_HINT) >= 0) {
      // URL 还在中控台，可能只是子页面/面板没渲染完，给它 5 秒
      if (await waitConsoleReady(5000)) {
        homeOkAt = Date.now();
        homeOkUrl = viewUrlSafe();
        return { ok: true, navigated: false };
      }
      Log.push('warn', `当前不在中控台主界面，自动返回首页（${reason || '启动前'}）`);
    } else if (url) {
      Log.push('info', `当前页面不是直播中控台，先自动跳回首页（${reason || '启动前'}）`);
    }
    const target = String(cfg.site || '').trim() || 'https://eos.douyin.com/livesite/live/current';
    const el = PAGE.el();
    const onWorker = PAGE.onWorker();
    // 后台模式下导航只允许发生在后台页。后台页正在刷新/重建（el 暂时为 null）时，
    // 宁可让这次失败并等下一次重试，也绝不去导航用户正在看的那个页面（会把缩放冲回 100%）。
    if (!el) {
      Log.push('warn', `后台页暂时不可用（正在刷新），稍后重试：${reason || ''}`);
      return { ok: false, navigated: false, reason: 'worker-unavailable' };
    }
    try { el.loadURL(target); } catch (e) {
      Log.push('err', '自动返回中控台失败：' + (e && e.message ? e.message : e));
      return { ok: false, navigated: false, reason: 'navigate-failed' };
    }
    await sleep(1200);
    const ok = await waitConsoleReady(30000);
    if (!ok) Log.push('warn', '中控台还没加载出来，动作可能失败；一直不行就点顶栏 ↻ 刷新一次');
    // 卡片/闪电按钮/评论区是异步渲染的，刚能读到 #live-card-list 时它们往往还没出来，
    // 直接扫会扫空 —— 这里再给它一点渲染时间。
    await sleep(2600);
    // 导航后缩放有时被重置（后台页固定 1.0，不跟随主界面的缩放）
    if (!onWorker) {
      try { view.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cfg.view.zoom) || 1))); } catch (e) {}
    }
    if (ok) { homeOkAt = Date.now(); homeOkUrl = viewUrlSafe(); }
    return { ok, navigated: true };
  }

  // ============================================================
  // 6. 调度引擎
  // ============================================================
  const running = { popup: null, comment: null, coupon: null, seckill: null, welcome: null, thanks: null };

  function makeToken() { return { alive: true }; }

  async function wait(token, ms) {
    const step = 150;
    let left = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 0;
    while (left > 0 && token.alive) {
      await sleep(Math.min(step, left));
      left -= step;
    }
    return token.alive;
  }

  // 等后台页恢复（刷新/重建期间用它，而不是直接失败退出）。
  // 用于「页面出问题」的失败：任务先挂起等待，页面回来就继续，不需要用户手动重开功能。
  async function waitPageReady(token, ms) {
    const deadline = Date.now() + (Number(ms) || 60000);
    let announced = false;
    while (Date.now() < deadline && token.alive) {
      if (!Worker.enabled()) return true;             // 用当前页面模式，没有后台页概念
      if (Worker.state === 'ready') return true;
      if (!announced) {
        announced = true;
        Log.push('info', '后台页正在刷新，等它恢复后自动继续（不用手动重开）…');
      }
      await sleep(1000);
    }
    return false;
  }

  // 顶部运行栏：每个在跑的任务一枚独立「停止」按钮，切到哪个页都看得见
  // 注意：欢迎语/感谢语以前不在这个列表里 —— 它们其实一直在跑（还占输入框），
  // 但界面上完全看不见、也没法单独停，只能按「全部停止」。现在补上。
  const RUN_TASKS = [
    { key: 'popup', name: '弹讲解', stop: () => Popup.stop() },
    { key: 'comment', name: '自动发评', stop: () => Comment.stop() },
    { key: 'coupon', name: '发优惠券', stop: () => Coupon.stop() },
    { key: 'seckill', name: '秒杀监控', stop: () => SecKill.stop() },
    { key: 'welcome', name: '欢迎语', stop: () => Welcome.stop() },
    { key: 'thanks', name: '感谢语', stop: () => Thanks.stop() }
  ];

  // 后台页状态徽标（自动化到底在哪个页面里跑，一眼能看见）
  function workerChip() {
    if (!Worker.enabled()) return '<span class="runbar-worker" title="自动化直接在当前页面里执行（会占用画面）">用当前页面</span>';
    if (Worker.state === 'ready') return `<span class="runbar-worker on" title="自动化在后台页执行，主界面不会被滚动或点击">● 后台页↻</span>`;
    if (Worker.state === 'loading') return '<span class="runbar-worker loading">◌ 启动中…</span>';
    if (Worker.state === 'failed') return `<span class="runbar-worker bad" title="${escapeAttr(Worker.reason || '启动失败')}">⚠ 后台页异常<button class="mini-btn" data-action="worker-reload" title="立即重试">↻</button></span>`;
    return '<span class="runbar-worker">后台页未启动</span>';
  }

  let runBarPending = null;
  function renderRunBar() {
    if (runBarPending) return;
    runBarPending = requestAnimationFrame(() => { runBarPending = null; drawRunBar(); });
  }
  function drawRunBar() {
    const bar = $('#runBar');
    if (!bar) return;
    const on = RUN_TASKS.filter((t) => running[t.key]);
    const cur = PageBus.current();
    const waitN = PageBus.waiting();
    const sched = cur
      ? `<span class="runbar-sched"><i class="dot busy"></i>${escapeHtml(cur)}${waitN ? ` · 排队${waitN}` : ''}</span>`
      : (waitN ? `<span class="runbar-sched">排队 ${waitN}</span>` : '');
    if (!on.length) {
      bar.innerHTML = `<span class="runbar-idle">空闲</span>${workerChip()}`;
      return;
    }
    bar.innerHTML = on.map((t) => `
      <div class="runbar-chip">
        <i class="dot"></i><span class="chip-name">${t.name}</span>
        <button class="mini-btn del" data-action="runbar-stop" data-key="${t.key}" title="停止${t.name}">×</button>
      </div>`).join('') + sched + workerChip();
  }

  function refreshStatus() {
    const names = Object.keys(running).filter((k) => running[k]);
    // 有任务在跑就通知主进程阻止系统休眠，保证最小化后也持续运行
    try { Promise.resolve(window.tp.powerBusy(names.length > 0)).catch(() => {}); } catch (e) {}
    const badge = $('#statusBadge');
    if (names.length) {
      badge.className = 'badge badge-run';
      badge.textContent = `运行中 · ${names.length} 项`;
    } else {
      badge.className = 'badge badge-idle';
      badge.textContent = '空闲';
    }
    renderRunBar();
    // 各面板里的开始/停止按钮状态同步
    document.querySelectorAll('[data-action^="start-"],[data-action^="stop-"]').forEach((b) => {
      const m = b.dataset.action.match(/^(start|stop)-(\w+)$/);
      if (!m) return;
      const isStart = m[1] === 'start';
      const on = !!running[m[2]];
      if (isStart) { b.disabled = on; b.classList.toggle('on', on); }
      else b.disabled = !on;
    });
    const st = document.querySelector('.run-state');
    if (st) { /* 状态文案随面板重渲染更新 */ }
  }

  function stopAll() {
    let n = 0;
    for (const k of Object.keys(running)) {
      if (running[k]) { running[k].alive = false; running[k].hardStop = true; n++; }
    }
    if (n) Log.push('warn', `已停止 ${n} 个任务`);
    // 「全部停止」也要停掉商品自动刷新：以前只停了业务任务，定时器还在每 90 秒抓一次商品
    // （抓商品要滚动整个列表、独占页面），用户以为全停了，其实页面还在被机器人动。
    try {
      if (Goods.timer) { Goods.stopAuto(); Log.push('info', '商品自动刷新已随「全部停止」一起关闭'); }
    } catch (e) { /* Goods 还没初始化就到不了这里 */ }
    PageBus.purge();
    refreshStatus();
  }

  // ---------- 6.0 商品自动抓取 ----------
  const Goods = {
    timer: null,
    // 两条通道：货架接口（不碰画面，不必独占）→ 失败才退回滚动 DOM（必须独占）
    refresh(reason, opts) {
      const label = `抓取商品${reason ? '·' + reason : ''}`;
      if (cfg.api.goods) {
        return this._refreshApi(reason, opts).then((list) => (list
          ? list
          : withPage(label, () => this._refreshDom(reason, opts), { prio: 1 })));
      }
      return withPage(label, () => this._refreshDom(reason, opts), { prio: 1 });
    },
    // 走货架接口：一次拿全量（含 card_id / product_id / 图片 / 门店 / SKU 数）。
    // 不点页面、不滚动，所以自动刷新不会打断正在跑的弹讲解。
    async _refreshApi(reason, opts) {
      try {
        // 纯接口读取：失败就返回 null 交给 DOM 兜底，绝不记成「后台页故障」
        const ids = await call('apiIds', [], undefined, { quiet: true });
        const roomId = ids && ids.roomId;
        if (!roomId) return null;
        const r = await call('apiShelf', [roomId], undefined, { quiet: true });
        if (!r || !r.ok || !Array.isArray(r.items) || !r.items.length) return null;
        const list = this._apply(r.items);
        Log.push('ok', `抓到 ${list.length} 个商品 · 货架接口` + (reason ? ` · ${reason}` : ''));
        return list;
      } catch (e) {
        return null;
      }
    },
    async _refreshDom(reason, opts) {
      const skipEnsure = !!(opts && opts.skipEnsure);
      // 手动抓取才强制回中控台；定时自动刷新/同步全部（已在控制台）不重复跳转
      if (!skipEnsure && reason !== '自动刷新') await ensureHome('抓取商品');
      const r = await call('goodsList', [{ rounds: 8, waitMs: 700 }]);
      if (!r || !r.ok) {
        Log.push('err', '抓取商品失败：' + ((r && r.reason) || '没找到商品列表，先确认已进入直播中控台'));
        return null;
      }
      const list = this._apply(r.items || []);
      Log.push('ok', `抓到 ${list.length} 个商品` + (r.scrolled ? `（列表滚动 ${r.scrolled} 次加载）` : '') + (reason ? ` · ${reason}` : ''));
      return list;
    },
    // 落库：写配置、清掉失效勾选、刷新界面。两条通道共用。
    _apply(raw) {
      const list = (raw || []).map((x, idx) => ({
        i: idx + 1,
        name: x.name || '',
        goodsId: x.goodsId || '',
        aria: x.aria || '',
        cardId: x.cardId || '',   // 弹讲解走接口要用它
        img: x.img || '',
        shop: x.shop || '',
        sku: x.sku == null ? null : x.sku
      }));
      cfg.goods.list = list;
      cfg.goods.pickedAt = new Date().toTimeString().slice(0, 5);

      // 商品可能被下架/换场，清掉已经不存在的勾选
      const alive = new Set(list.map((x) => x.i));
      const before = (cfg.popup.selected || []).length;
      cfg.popup.selected = (cfg.popup.selected || []).filter((n) => alive.has(n));
      const dropped = before - cfg.popup.selected.length;

      saveConfig();
      paintGoods();
      if (dropped > 0) Log.push('warn', `有 ${dropped} 个已勾选的商品不在列表里了，已自动取消勾选`);
      return list;
    },
    startAuto() {
      this.stopAuto();
      if (!cfg.goods.autoRefresh) return;
      const sec = Math.max(20, Number(cfg.goods.refreshSec) || 90);
      this.timer = setInterval(() => {
        if (running.popup) return; // 讲解中不抓，避免抢焦点
        this.refresh('自动刷新');
      }, sec * 1000);
      Log.push('info', `商品自动刷新已开启：每 ${sec} 秒`);
    },
    stopAuto() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  };

  // ============================================================
  // 6.0 实时数据（只读）
  //
  // 过去这里只有「累计」——自己数弹了几次、发了几条，看不到抖音侧的真实效果。
  // 这两条接口是页面自己就在用的，直接读：
  //   /data/life/live/data/live_data/v3   在线/累计观看/涨粉/成交/GMV/转化率
  //   /data/life/live/component/stats     每个商品的曝光/点击/成交/GMV
  // 只读、不点页面、不占 PageBus，所以可以一直开着刷新。
  // ============================================================
  const Data = {
    timer: null,
    busy: false,
    snap: { room: null, cards: {}, at: 0, err: '', roomId: '' },

    async pull() {
      if (this.busy) return this.snap;
      // 后台页没就绪（未开播/刚启动/正在刷新）就别去敲它：
      // 这时候发请求只会拿到 guest-not-ready，既没数据，又会把页面判成故障。
      // 「使用当前页面」模式没有后台页，不能拿这条挡它。
      if (PAGE.target() === 'worker' && (!Worker.enabled() || Worker.state !== 'ready')) {
        this.snap.err = '后台页还没就绪：进中控台并开播后自动开始';
        return this.snap;
      }
      this.busy = true;
      try {
        // 识别 roomId 很贵：要挂在页面自己的请求上等它出现（最多 8 秒）。
        // 每 10 秒来一遍会把后台页拖慢，所以：认到过就一直用，认不到就 60 秒再试一次。
        let roomId = this.snap.roomId || '';
        if (!roomId && Date.now() - (this._idsTryAt || 0) > 60000) {
          this._idsTryAt = Date.now();
          let ids = null;
          try { ids = await call('apiIds', [], undefined, { quiet: true }); } catch (e) { ids = null; }
          roomId = (ids && ids.roomId) || '';
        }
        if (!roomId) {
          this.snap.err = '还没识别到直播间：进中控台并开播后自动可用';
          this.snap.roomId = '';
          return this.snap;
        }
        this.snap.roomId = roomId;

        const r = await call('apiRoomStats', [roomId], undefined, { quiet: true });
        if (r && r.ok) {
          this.snap.room = r.stats;
          this.snap.err = '';
        } else {
          this.snap.err = '大屏接口：' + ((r && r.reason) || '无返回');
        }

        // 单品效果：用货架里的 product_id 当 component_id（两者一致）
        const list = (cfg.goods.list || []).filter((g) => g.goodsId);
        if (list.length) {
          const cs = await call('apiCardStats', [list.map((g) => g.goodsId), roomId], undefined, { quiet: true });
          if (cs && cs.ok) {
            const byId = {};
            list.forEach((g) => { byId[String(g.goodsId)] = g.i; });
            const out = {};
            Object.keys(cs.rows || {}).forEach((gid) => {
              const idx = byId[String(gid)];
              if (idx) out[idx] = cs.rows[gid];
            });
            this.snap.cards = out;
          }
        }
        this.snap.at = Date.now();
        cfg.data.lastAt = new Date().toTimeString().slice(0, 5);
        saveConfig();
        return this.snap;
      } finally {
        this.busy = false;
      }
    },

    async refreshNow() {
      await this.pull();
      if (activeTab === 'data') renderPanel();
    },

    startAuto() {
      this.stopAuto();
      if (!cfg.data.autoRefresh) return;
      const sec = Math.max(5, Number(cfg.data.refreshSec) || 10);
      this.timer = setInterval(() => {
        // 只读接口，不跟任何任务抢页面，所以不判断 running
        this.pull().then(() => { if (activeTab === 'data' && !editingField()) paintData(); });
      }, sec * 1000);
    },
    stopAuto() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  };

  // ---------- 6.0.1 保活 ----------
  // 直播间页面长时间没人动，抖音会把它判成不活跃/心跳断掉，恢复时要重新加载，
  // 中途的任务全废。这里在「没有任何任务在跑」时每分钟发一个只读请求当心跳。
  // 比切 tab / 点按钮温和得多：不发请求以外的事，不碰 DOM。
  const KeepAlive = {
    timer: null,
    lastAt: 0,
    fails: 0,
    start() {
      this.stop();
      if (!cfg.api.keepAlive) return;
      this.timer = setInterval(() => { this.tick(); }, 60000);
    },
    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    },
    async tick() {
      if (!cfg.api.keepAlive) return;
      // 后台页没就绪时发心跳没有意义，还会把页面判成故障
      // （「使用当前页面」模式没有后台页，不受这条限制）
      if (PAGE.target() === 'worker' && (!Worker.enabled() || Worker.state !== 'ready')) return;
      // 有任务在跑时页面本来就在发请求，不必再加
      if (Object.keys(running).some((k) => running[k])) return;
      // 页面上正开着官方抽屉/弹窗时别插一脚
      try {
        const busy = await call('officialBusy', [], undefined, { quiet: true });
        if (busy && busy.busy) return;
      } catch (e) { /* 读不到就照常发心跳 */ }
      try {
        const r = await call('apiLiveStatus', [], undefined, { quiet: true });
        if (r && r.ok) { this.fails = 0; this.lastAt = Date.now(); }
        else this.fails += 1;
      } catch (e) {
        this.fails += 1;
      }
    }
  };

  // 正在输入框里打字时不要重绘（会把输入焦点打断）
  function editingField() {
    const a = document.activeElement;
    if (!a) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable;
  }

  // 数字格式化：大数压缩成「万」，避免面板被长数字撑破
  function fmtNum(v, unit) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    const tail = unit || '';
    if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(2) + '亿' + tail;
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + '万' + tail;
    return String(n) + tail;
  }

  // 单品行：只重绘表格，避免整页重绘丢焦点
  function paintData() {
    const box = document.getElementById('dataBox');
    if (!box) return;
    box.innerHTML = dataBodyHtml();
  }

  function dataBodyHtml() {
    const s = Data.snap;
    const room = s.room || {};
    const fmt = fmtNum;
    const cells = [
      { k: '在线', v: fmt(room.online), hot: true },
      { k: '累计观看', v: fmt(room.watch) },
      { k: '新增粉丝', v: fmt(room.follow) },
      { k: '成交单数', v: fmt(room.order) },
      { k: 'GMV', v: fmt(room.gmv) },
      { k: '观看→支付', v: (room.payRate == null ? '—' : room.payRate + '%') }
    ];
    const grid = cells.map((c) => `
      <div class="dcell${c.hot ? ' hot' : ''}"><b>${escapeHtml(c.v)}</b><span>${c.k}</span></div>`).join('');

    const list = cfg.goods.list || [];
    // 面板只有 ~270px 宽，7 列放不下 —— 压成 5 列，率值和 GMV 挂在小字里
    const rows = list.map((g) => {
      const st = s.cards[g.i] || null;
      if (!st) {
        return `<tr><td class="dnum">${g.i}</td><td class="dname" title="${escapeHtml(g.name || '')}">${escapeHtml(g.name || '(未识别)')}</td>
          <td colspan="3" class="dempty">还没数据</td></tr>`;
      }
      const ctr = st.show > 0 ? ((st.click / st.show) * 100) : 0;
      const cvr = st.click > 0 ? ((st.order / st.click) * 100) : 0;
      return `<tr>
        <td class="dnum">${g.i}</td>
        <td class="dname" title="${escapeHtml(g.name || '')}">${escapeHtml(g.name || '(未识别)')}</td>
        <td>${fmt(st.show)}</td>
        <td>${fmt(st.click)}<span class="dsub">${st.show > 0 ? ctr.toFixed(0) + '%' : ''}</span></td>
        <td>${st.order > 0 ? `<b class="dhot">${st.order}</b>` : '0'}<span class="dsub">${st.gmv > 0 ? fmt(st.gmv) : (st.click > 0 ? cvr.toFixed(0) + '%' : '')}</span></td>
      </tr>`;
    }).join('');

    const empty = list.length
      ? (Object.keys(s.cards).length ? '' : '<p class="hint">单品数据还没回来——先到「商品」页点「↻ 只抓商品」拿到商品 ID。</p>')
      : '<div class="empty">还没有商品 —— 先到「商品」页点「⚡ 同步全部」</div>';

    return `
      <div class="dgrid">${grid}</div>
      ${s.err ? `<p class="hint dwarn">${escapeHtml(s.err)}</p>` : ''}
      ${s.at ? `<p class="hint">更新于 ${new Date(s.at).toTimeString().slice(0, 8)}${s.roomId ? ' · 房间 ' + s.roomId.slice(-6) : ''}</p>` : '<p class="hint">还没拉到数据</p>'}
      <div class="dtable-wrap">
        <table class="dtable">
          <thead><tr><th>#</th><th>商品</th><th>曝光</th><th>点击</th><th>成交</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${empty}`;
  }

  // ---------- 6.1 定时弹讲解 ----------
  // 接口切讲解：拿第 n 个商品的 card_id 直接 POST /data/life/live/card/switch/。
  // 不点卡片、不聚焦、不占 PageBus，所以能和发评/发券真正并行。
  // 返回：
  //   { ok: true }            接口成功（不必再点）
  //   { ok: false, reason }   接口明确失败（调用方回退 DOM）
  //   null                    没有 card_id（老配置/没抓过货架）→ 直接回退 DOM
  let apiExplainLogged = false;
  async function explainByApi(n) {
    const item = (cfg.goods.list || []).find((g) => g.i === n) || {};
    if (!item.cardId) return null;
    let ids = null;
    try {
      // 接口失败统一回退 DOM，DOM 那边才是真的页面故障判定
      ids = await call('apiIds', [], undefined, { quiet: true });
    } catch (e) {
      return null;
    }
    const roomId = ids && ids.roomId;
    if (!roomId) return null;
    try {
      const r = await call('apiSwitchCard', [item.cardId, roomId], undefined, { quiet: true });
      if (r && r.ok) return { ok: true, how: 'api' };
      return { ok: false, reason: '接口:' + ((r && r.reason) || 'fail'), how: 'api' };
    } catch (e) {
      return { ok: false, reason: '接口:' + String(e.message || e), how: 'api' };
    }
  }

  const Popup = {
    async start() {
      if (running.popup) return;
      if (!String(cfg.selectors.card || '').trim()) { Log.push('err', '弹讲解：商品卡选择器为空，去「高级」页检查'); return; }

      // 先建令牌再要页面：等待其它任务让出时，用户可以随时按「停止」
      const token = makeToken();
      running.popup = token;
      refreshStatus();
      const ready = await withTask('弹讲解·就绪', token, () => ensureHome('弹讲解'));
      if (!token.alive) { running.popup = null; refreshStatus(); renderPanel(); return; }
      if (!ready || ready.ok === false) {
        running.popup = null; refreshStatus(); renderPanel();
        Log.push('err', '弹讲解：中控台还没准备好，稍后再试');
        return;
      }

      let sel = (cfg.popup.selected || []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      if (!sel.length) {
        if (!cfg.goods.list.length) {
          running.popup = null; refreshStatus(); renderPanel();
          Log.push('err', '弹讲解：请先到「商品」页点「⚡ 同步全部」或「↻ 只抓商品」，再勾选要讲解的商品');
          return;
        }
        sel = cfg.goods.list.map((g) => g.i);
        Log.push('warn', '弹讲解：没有勾选商品，按全部商品循环');
      }

      if (cfg.popup.mode === 'keep') {
        running.popup = null;
        refreshStatus();
        return Popup.runKeep(sel);
      }

      const p = cfg.popup;

      const modeText = p.mode === 'random' ? '随机' : '顺序';
      Log.push('info', `弹讲解启动：${sel.length} 个商品 · ${modeText} · 单卡 ${p.showSec}s / 间隔 ${p.hideSec}s · ${Number(p.rounds) > 0 ? `共 ${p.rounds} 轮` : '无限轮'}`);
      if (p.timeFrom && p.timeTo) Log.push('info', `时间段限制：${p.timeFrom} - ${p.timeTo}（不在范围内自动等待）`);

      let round = 0;
      let fired = 0;
      let fails = 0;          // 当前「连续」失败次数（成功即清零，用于识别整轮都点不上的死局）
      let selfHealAt = 0;     // 上次自救（回中控台/关遮罩）的时间戳
      let pageFails = 0;      // 连续「页面级」失败次数（防无限等待）
      let apiFails = 0;       // 接口通道连续失败次数（达阈值就本轮不再试接口，省得每次多等一个请求）

      while (token.alive) {
        if (!inTimeWindow(p.timeFrom, p.timeTo)) {
          Log.push('info', '弹讲解 · 当前不在设定时间段，等 60 秒后再检查');
          if (!(await wait(token, 60000))) break;
          continue;
        }

        round++;
        const order = p.mode === 'random' ? shuffle(sel) : sel.slice();

        for (const n of order) {
          if (!token.alive) break;
          const cardSel = fillTemplate(cfg.selectors.card, String(n));

          // ① 接口通道优先：直接 POST card/switch，不点卡片、不聚焦、不占 PageBus。
          //    以前这里必须独占页面点卡片，所以弹讲解一开，发评/发券就只能排队 ——
          //    走接口之后它们可以真正并行。
          let res = (cfg.api.switchCard && apiFails < 5) ? await explainByApi(n) : null;
          if (res && res.ok) {
            apiFails = 0;
            if (!apiExplainLogged) {
              apiExplainLogged = true;
              Log.push('info', '弹讲解走接口通道（不点画面，与发评/发券并行）');
            }
          } else {
            if (res && !res.ok) {
              apiFails++;
              if (apiFails === 5) Log.push('warn', '接口切讲解连续失败 5 次，本次运行改用点卡片');
            }
            // ② 回退：没有 card_id / 接口改版 / 未开播 → 照旧点卡片
            res = await withTask('弹讲解', token, () => retryWithLoadAll(
              () => act('弹讲解', `第${round}轮 · 第 ${n} 个商品`, () => clickInReal(cardSel, cfg.selectors.cardAction))
            ), { prio: 1 });
          }

          if (res && res.ok) { fired++; fails = 0; Stats.bump('popup'); }
          else {
            fails++;
            const why = (res && res.reason) || '未知';
            Log.push('warn', `弹讲解 · 第${round}轮 · 第 ${n} 个商品没点上（${why}）`);
            // 「页面级」问题（后台页正在刷新/被遮住/超时）不算商品下架：
            // 挂起等页面恢复后接着点，别自己退出（否则用户得手动重开弹讲解）。
            const pageProblem = /guest-not-ready|no-frame|frame-.*timeout|worker-not-ready|still-covered|covered|aborted|locate-failed/.test(why);
            if (pageProblem) {
              fails = 0;
              pageFails++;
              Worker.noteTaskFailure('弹讲解');
              if (pageFails > 6) { Log.push('err', '弹讲解 · 后台页长时间不恢复，先停下'); break; }
              const back = await waitPageReady(token, 30000);
              if (!back) Log.push('warn', '弹讲解 · 后台页一直没恢复，这一轮先跳过');
              break;   // 跳过本轮剩余商品，下一轮继续（token 还活着就不会退出）
            }
            // 失败大概率是被别的任务（发券/秒杀）开抽屉时遮住了、或页面被切走了。
            // 别再干等下一轮继续失败 —— 主动「自救」一次：回中控台、关掉残留的遮罩/抽屉。
            if (fails >= order.length) {
              const now = Date.now();
              if (now - selfHealAt < 15000) {
                Log.push('err', `弹讲解 · 连续两轮都没点上，可能商品下架或后台页卡住，自动停止`);
                // 功能级失败也报给后台页健康检查：连续 2 次就刷后台页试试
                Worker.noteTaskFailure('弹讲解');
                break;
              }
              selfHealAt = now;
              fails = 0;   // 这轮清零，给自救后的下一轮一次机会
              Log.push('info', `弹讲解 · 第${round}轮整轮没点上，先回中控台并清掉残留弹层，再继续`);
              Worker.noteTaskFailure('弹讲解');
              try {
                await withTask('弹讲解·自救', token, () => ensureHome('弹讲解自救', { force: true }), { prio: 2 });
              } catch (e) { /* 自救失败不致命，下一轮还有机会 */ }
              break;   // 跳过本轮剩余商品，下一轮从头再点
            }
          }

          await maybeLongPause(token);
          // 讲解展示时长 + 切换前停留，两段都带浮动
          const holdMs = humanJitter(Number(p.showSec) * 1000) + humanJitter(Number(p.hideSec) * 1000);
          if (!(await wait(token, holdMs))) break;
        }

        if (!token.alive) break;
        if (Number(p.rounds) > 0 && round >= Number(p.rounds)) {
          Log.push('ok', `弹讲解 · 已完成 ${p.rounds} 轮，自动结束`);
          break;
        }
        Log.push('info', `弹讲解 · 第${round}轮完成（累计触发 ${fired} 次）`);
      }

      running.popup = null;
      refreshStatus();
      Log.push('info', `弹讲解 · 已停止，本次共触发 ${fired} 次`);
      renderPanel();
    },
    // 常驻单卡：用户端弹窗几秒后会自行收起，中控台这边定时「取消讲解 → 立刻恢复讲解」
    // 让卡片重新弹出，看起来就像一直挂在直播间上。
    async runKeep(sel) {
      const p = cfg.popup;
      const k = p.keep || (p.keep = { refreshSec: 6, offMs: 600 });
      const n = sel[0];
      const cardSel = fillTemplate(cfg.selectors.card, String(n));
      const actSel = cfg.selectors.cardAction;
      const item = (cfg.goods.list || []).find((g) => g.i === n) || {};
      const label = item.name ? `第 ${n} 个「${item.name}」` : `第 ${n} 个商品`;

      const token = makeToken();
      running.popup = token;
      refreshStatus();

      const refreshMs = Math.max(2000, Number(k.refreshSec) * 1000);
      const offMs = Math.min(4000, Math.max(150, Number(k.offMs)));
      Log.push('info', `常驻弹窗启动：锁定 ${label}`);
      Log.push('info', `节奏：每 ${(refreshMs / 1000).toFixed(0)} 秒重置一次（取消 ${offMs}ms 后立刻恢复讲解）`);
      if (sel.length > 1) Log.push('warn', `常驻模式只用勾选的第一个商品，其余 ${sel.length - 1} 个忽略`);
      if (p.timeFrom && p.timeTo) Log.push('info', `时间段限制：${p.timeFrom} - ${p.timeTo}`);

      let cycles = 0;
      let fails = 0;
      let endedByRounds = false;

      try {
        while (token.alive) {
          if (!inTimeWindow(p.timeFrom, p.timeTo)) {
            Log.push('info', '弹讲解 · 当前不在设定时间段，等 60 秒后再检查');
            if (!(await wait(token, 60000))) break;
            continue;
          }

          // 「取消 → 停顿 → 恢复」必须一口气做完：中途被别人插一脚，用户端就会一直空着。
          // 所以整段放在一个临界区里（约 1~2 秒），做完立刻交还页面。
          const step = await withTask('常驻弹窗', token, async () => {
            const st = await readTalking(cardSel, actSel);
            // st === null：读不到状态（选择器失效/卡片不在）→ 按"在讲解中"处理，走取消+恢复
            const isOn = st !== false;
            if (!isOn) {
              const r = await retryWithLoadAll(() => act('开始讲解', label, () => clickInReal(cardSel, actSel)));
              return { mode: 'start', r: r };
            }
            const r1 = await act('取消讲解', label, () => clickInReal(cardSel, actSel));
            if (!r1 || !r1.ok) return { mode: 'cancel-fail', r: r1 };
            // 短暂停留后立刻恢复（停留时间就是用户端看到"空档"的时长，越短越好）
            await sleep(humanJitter(offMs));
            if (!token.alive) return { mode: 'aborted', r: r1 };
            // 等按钮文案回落到「讲解」，避免点到还没切换完的按钮
            await waitTalking(cardSel, actSel, false, 1500);
            const r2 = await act('恢复讲解', label, () => clickInReal(cardSel, actSel));
            return { mode: 'keep', r: r2 };
          }, { prio: 1 });

          if (step.mode === 'start') {
            const r = step.r;
            if (!r || !r.ok) {
              fails++;
              Log.push('warn', `${label} 没能开始讲解（${(r && r.reason) || '未知'}）—— 商品可能已下架，重新抓取商品再看`);
              if (fails >= 3) { Log.push('err', '连续 3 次失败，自动停止'); break; }
            } else { fails = 0; cycles++; }
          } else if (step.mode === 'cancel-fail') {
            fails++;
            Log.push('warn', `${label} 取消讲解没点上（${(step.r && step.r.reason) || '未知'}）`);
            if (fails >= 3) { Log.push('err', '连续 3 次失败，自动停止'); break; }
          } else if (step.mode === 'keep') {
            fails = 0;
            const r2 = step.r;
            if (r2 && r2.ok) {
              cycles++;
              Log.push('info', `已重置 ${cycles} 次，弹窗继续展示`);
            } else {
              Log.push('warn', `${label} 恢复讲解没点上（${(r2 && r2.reason) || '未知'}），下一轮重试`);
            }
          } else {
            break;
          }

          if (Number(p.rounds) > 0 && cycles >= Number(p.rounds)) {
            endedByRounds = true;
            Log.push('ok', `已重置 ${cycles} 次，达到设定次数，自动结束`);
            break;
          }

          if (!(await wait(token, humanJitter(refreshMs)))) break;
        }
      } finally {
        // 停止后尽量让卡停在「讲解中」，别让用户端空着（急停时不补动作）
        if (!token.hardStop) {
          const fixed = await withPage('弹讲解·收尾', async () => {
            const last = await readTalking(cardSel, actSel);
            if (last !== false) return false;
            const fix = await clickInReal(cardSel, actSel).catch(() => null);
            return !!(fix && fix.ok);
          });
          if (fixed) Log.push('info', '停止前已把讲解恢复');
        }
        running.popup = null;
        refreshStatus();
        Log.push('info', `常驻弹窗已停止，本次共重置 ${cycles} 次${endedByRounds ? '（完成设定次数）' : ''}`);
        renderPanel();
      }
    },
    stop() { if (running.popup) running.popup.alive = false; }
  };

  // 读某张卡是否处于「讲解中」：true=讲解中 / false=未讲解 / null=读不到
  async function readTalking(cardSel, actSel) {
    const st = await call('textIn', [cardSel, actSel]);
    if (!st || !st.ok) return null;
    const txt = String(st.text || '');
    if (!txt) return null;
    if (/取消/.test(txt)) return true;
    if (/讲解|弹卡|上架/.test(txt)) return false;
    return null;
  }

  // 轮询等按钮文案切到目标状态（等 React 那边渲染完）
  async function waitTalking(cardSel, actSel, wantOn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await readTalking(cardSel, actSel);
      if (v === wantOn) return true;
      await sleep(180);
    }
    return false;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 6.2 自动发评 ----------
  const Comment = {
    async start() {
      if (running.comment) return;
      const g = activeCommentGroup();
      if (!g) { Log.push('err', '自动发评：请先新建并选中一个评论组'); return; }
      // 组里每条评论一个独立条目（items），不再是整段文本
      const items = (Array.isArray(g.items) ? g.items : [])
        .map((it) => ({ text: String(it && it.text || '').trim(), pin: !!(it && it.pin) }))
        .filter((it) => it.text);
      if (!items.length) { Log.push('err', '自动发评：组里还没有评论，先「+ 添加一条评论」'); return; }
      if (!cfg.selectors.commentInput) { Log.push('err', '自动发评：请先到「高级」页一键适配'); return; }

      const token = makeToken();
      running.comment = token;
      refreshStatus();
      const ready = await withTask('自动发评·就绪', token, () => ensureHome('自动发评'));
      if (!token.alive || !ready || ready.ok === false) {
        running.comment = null; refreshStatus(); renderPanel();
        if (token.alive) Log.push('err', '自动发评：中控台还没准备好，稍后再试');
        return;
      }
      Log.push('info', `自动发评启动：组「${g.name || '未命名'}」，${items.length} 条独立评论，${g.order === 'random' ? '随机' : '顺序'}轮发`);

      let pinIdx = 0;
      let lastPin = 0;
      let round = 0;
      let sentTotal = 0;      // 本次总共发出去多少条（停止时汇报用）
      let failStreak = 0;     // 连续失败条数：连着发不出去说明评论框不可用（下播/被限流）

      while (token.alive) {
        round++;
        const roundMs = Number(g.roundMin || 2) * 60000;
        const roundEnd = Date.now() + roundMs;
        let i = 0;
        let sentThisRound = 0;

        while (token.alive && Date.now() < roundEnd) {
          if (i >= items.length) {
            if (g.loopItems === false) break;
            i = 0;
          }
          const item = items[(g.order === 'random') ? rand(0, items.length - 1) : i];
          i++;

          // 发一条评论 + 置顶 = 一个临界区（要占着输入框，中途不能被别人抢焦点）
          const sendRes = await withTask('发评', token, async () => {
            const res = await sendComment(item.text);
            // 没发出去就直接结束这一条。
            // 以前这里会接着去「置顶」，而置顶要重试 3 次、每次等 1.3 秒，整段仍在独占区里 ——
            // 真机并发压测时发评一失败就占着页面 20 多秒，把弹讲解/发券/秒杀全堵在门外（实测最长 28.1 秒）。
            if (!res || !res.ok) return { res: res, pin: null };
            sentThisRound++; sentTotal++; Stats.bump('comment');
            failStreak = 0;

            // 置顶（真机：悬停这条评论 → 点它浮出来的「置顶」）
            let pr = null;
            if (g.pin && item.pin) {
              const now = Date.now();
              // 注意：置顶间隔填 0 = 每条都置顶，不能用 `0 || 300` 兜底（会变成 5 分钟）
              const raw = Number(g.pinSec);
              const gapSec = Number.isFinite(raw) && raw >= 0 ? raw : 300;
              if (now - lastPin >= gapSec * 1000) {
                pr = await pinComment(item.text);
                lastPin = Date.now();
                if (pr && pr.ok) pinIdx++;
                else lastPin = Date.now() - gapSec * 1000 + 30000; // 失败 30 秒后再试，别每条都硬试
              }
            }
            return { res: res, pin: pr };
          }, { prio: 1 });
          if (sendRes && sendRes.res && sendRes.res.ok === false && String(sendRes.res.reason || '') === 'aborted') break;

          // 连续发不出去（十有八九是下播了/评论框被禁），别按 5~10 秒的节奏空转刷日志
          if (sendRes && sendRes.res && sendRes.res.ok === false) {
            failStreak++;
            if (failStreak >= 3) {
              Log.push('warn', `自动发评 · 连续 ${failStreak} 条没发出去，暂停 60 秒再试（多半是已下播或评论框不可用）`);
              failStreak = 0;
              if (!(await wait(token, 60000))) break;
            }
          }

          const gap = rand(Number(g.intervalMin || 5), Number(g.intervalMax || 9)) * 1000;
          if (!(await wait(token, gap))) break;
        }

        if (!token.alive) break;
        Log.push('info', `自动发评 · 第${round}轮结束（${sentThisRound} 条），休息 ${g.restMin} 分钟`);
        if (!(await wait(token, Number(g.restMin || 5) * 60000))) break;
      }

      running.comment = null;
      refreshStatus();
      Log.push('info', `自动发评 · 已停止（共发 ${sentTotal} 条）`);
      renderPanel();
    },
    stop() { if (running.comment) running.comment.alive = false; }
  };

  function parseCommentItems(content) {
    return String(content || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({
        text: s.replace(/^\[置顶\]\s*/, ''),
        pin: /^\[置顶\]/.test(s)
      }));
  }

  // 发评论：先试接口（不碰画面），不行再走页面输入
  async function sendComment(text) {
    if (!cfg.comment || cfg.comment.useApi !== false) {
      const t0 = Date.now();
      const r = await call('apiComment', [text, (cfg.comment && cfg.comment.userId) || '']);
      if (r && r.ok) {
        // 顺手把识别到的 id 记住，下次不用再探
        if (r.ids && r.ids.userId && !cfg.comment.userId) { cfg.comment.userId = r.ids.userId; saveConfig(); }
        Log.push('ok', `发评（接口 ${Date.now() - t0}ms）→ ${String(text).slice(0, 30)}`);
        return { ok: true, how: 'api', chatId: r.chatId };
      }
      const why = (r && r.reason) || '未知';
      if (r && r.ids && r.ids.userId && !cfg.comment.userId) { cfg.comment.userId = r.ids.userId; saveConfig(); }
      if (!sendComment.apiWarned) {
        sendComment.apiWarned = true;
        Log.push('warn', `接口发评不可用（${why}），改走页面输入（慢一些，但一定能发）`);
      }
    }
    return sendCommentByPage(text);
  }

  async function sendCommentByPage(text) {
    // 先真实点一下输入框拿到焦点，再逐字真实敲进去 —— 合成事件在 React 受控组件里常常被吞
    const focus = await act('聚焦输入框', '点击评论输入框', async () => {
      const loc = await call('locate', [cfg.selectors.commentInput]);
      if (!loc || !loc.ok) return loc || { ok: false, reason: 'locate-failed' };
      const p = scaledXY(loc);
      const r = await tpTap(p.x, p.y);
      if (!r || !r.ok) return r;
      // 清空已有内容（Ctrl/Cmd+A 后删除）
      await call('type', [cfg.selectors.commentInput, '', {}]);
      return { ok: true };
    });
    if (!focus || !focus.ok) return focus;

    const typed = await act('输入评论', text.slice(0, 30) + (text.length > 30 ? '…' : ''), async () => {
      const loc = await call('locate', [cfg.selectors.commentInput]);
      if (!loc || !loc.ok) return loc || { ok: false, reason: 'locate-failed' };
      const p = scaledXY(loc);
      return tpType(p.x, p.y, text);
    });
    if (!typed || !typed.ok) return typed;

    if (cfg.selectors.sendButton) {
      return act('发送', '点击发送按钮', () => clickReal(cfg.selectors.sendButton));
    }
    return act('发送', '回车发送', async () => {
      const loc = await call('locate', [cfg.selectors.commentInput]);
      return window.tp.realEnter ? tpEnter() : call('pressEnter', [cfg.selectors.commentInput]);
    });
  }

  // 置顶刚发的那条评论。
  // 真机结构（2026-10-22 实测）：置顶是「把鼠标移上去才出现」的图标按钮 ——
  //   条目 > div.hover-button > [0]=图钉(置顶) [1]=气泡(回复)，图标没有文字/aria，
  //   点第 1 个后后台提示「置顶审核中，审核通过后将在用户侧展示1分钟」。
  // 之前的实现去点面板顶部的 text=置顶，页面上根本没有那个按钮，所以永远点不到。
  async function pinComment(text, tries) {
    const n = Math.max(1, Number(tries) || 3);
    const snippet = String(text || '').slice(0, 12);
    for (let i = 0; i < n; i++) {
      const found = await call('commentItemByText', [snippet]);
      if (!found || !found.ok) {
        if (i < n - 1) { await sleep(1300); continue; }
        Log.push('warn', `置顶：评论列表里没找到刚发的那条（${(found && found.reason) || '未知'}）—— 可能被限流/还没渲染`);
        return { ok: false, reason: (found && found.reason) || 'not-found' };
      }
      // 悬停这条，让操作图标浮出来（CDP 移指针，不抢鼠标）
      try {
        const p = scaledXY(found);
        if (window.tp.realMove) await tpMove(p.x, p.y);
      } catch (e) {}
      await sleep(humanJitter(900));

      const hover = await call('commentHoverIcons', [snippet]);
      if (!hover || !hover.ok) {
        if (i < n - 1) { await sleep(1000); continue; }
        Log.push('warn', `置顶：悬停后没出现操作图标（${(hover && hover.reason) || '未知'}）—— 这条可能不允许置顶`);
        return { ok: false, reason: (hover && hover.reason) || 'no-icons' };
      }
      // 第一个图标就是置顶（图钉）；第二个是回复，别点错
      const pin = hover.pin || (hover.icons || [])[0];
      if (!pin) {
        if (i < n - 1) { await sleep(1000); continue; }
        Log.push('warn', '置顶：这条上没有可点的操作图标');
        return { ok: false, reason: 'no-icons' };
      }
      if ((hover.icons || []).length > 1) {
        Log.push('info', `置顶：这条上有 ${hover.icons.length} 个操作图标，取第 1 个（图钉=置顶）`);
      }
      const p2 = scaledXY(pin);
      const r = await tpTap(p2.x, p2.y);
      if (!r || !r.ok) {
        if (i < n - 1) { await sleep(1000); continue; }
        return r || { ok: false, reason: 'click-failed' };
      }
      // 判定：读后台提示（成功会带「置顶审核中…」这类文案）。toast 有时 2 秒后才出现，读两次
      let t = '';
      for (let k = 0; k < 2; k++) {
        await sleep(k === 0 ? humanJitter(1300) : humanJitter(1100));
        const toast = await call('readToast', []);
        t = (toast && toast.ok && toast.text) || t;
        if (/置顶[^/]{0,24}(审核中|成功|已置顶|展示)/.test(t)) break;
      }
      const hit = t.match(/置顶[^/]{0,24}(审核中|成功|已置顶|展示)/) || (/置顶/.test(t) ? t.slice(0, 30) : '');
      if (hit) {
        Log.push('ok', `置顶已提交：${String(hit).slice(0, 40)}`);
        return { ok: true, toast: String(hit) };
      }
      // 没有提示也当作点到了（后台不一定每次弹 toast），但日志写清楚
      Log.push('info', `置顶：已点这条的图钉图标（${String(hover.itemText || '').slice(0, 16)}），后台没弹提示，请到用户侧确认`);
      return { ok: true, toast: '' };
    }
    return { ok: false, reason: 'unknown' };
  }

  // 置顶自检：悬停最后一条评论，把能点的操作全列出来（只读，不会真置顶）
  async function pinSelfCheck() {
    await withPage('置顶自检', () => ensureHome('置顶自检'), { prio: 2 });
    const last = await call('commentLastItem', []);
    if (!last || !last.ok) {
      Log.push('warn', '置顶自检：评论列表里还没有评论 —— 先在直播间发一条（或等观众发言）再点');
      return;
    }
    Log.push('info', `置顶自检：最后一条「${String(last.text || '').slice(0, 30)}」（共 ${last.count} 条）`);
    try {
      const p = scaledXY(last);
      if (window.tp.realMove) await tpMove(p.x, p.y);
    } catch (e) {}
    await sleep(900);
    // 真机结构：悬停后出现 hover-button 里的图标，第 1 个=置顶（图钉）、第 2 个=回复（气泡）
    const hover = await call('commentHoverIcons', [String(last.text || '').slice(0, 12)]);
    if (hover && hover.ok) {
      Log.push('ok', `悬停后出现 ${hover.count} 个操作图标：${(hover.icons || []).map((x) => `#${x.i}${x.i === 0 ? '(置顶·图钉)' : x.i === 1 ? '(回复·气泡)' : ''}`).join(' / ')}`);
      Log.push('info', '自动置顶会点第 1 个图标；如果你在页面上看到第 1 个不是图钉，告诉我，我改顺序');
      const toastProbe = await call('readToast', []);
      if (toastProbe && toastProbe.ok && toastProbe.text) Log.push('info', `当前后台提示：${String(toastProbe.text).slice(0, 60)}`);
    } else {
      // 兜底诊断：没读到 hover-button 时，把这条上能点的文字/图标类名都列出来
      Log.push('warn', `悬停后没读到 hover-button 图标（${(hover && hover.reason) || '未知'}）`);
      const acts = await call('commentItemActions', [String(last.text || '').slice(0, 12)]);
      if (acts && acts.ok) {
        Log.push('ok', `悬停后可点文字：${(acts.actions || []).map((a) => a.t || '(图标)').join(' / ')}`);
      }
      if (acts && acts.others && acts.others.length) Log.push('info', `这条上其它可点文字：${acts.others.join(' / ')}`);
      if (acts && acts.icons && acts.icons.length) Log.push('info', `这条上的图标类名：${acts.icons.join(' / ')}`);
      Log.push('info', `条目样本：${JSON.stringify(last).slice(0, 220)}`);
    }
  }

  // ---------- 6.35 自动发优惠券 ----------
  // 真机流程（2026-10-21 验证）：
  //   营销卡「优惠券」→ 抽屉表格（名称/状态/满减额度/可用库存）→ 行内「发放优惠券」
  //   → 弹窗数量小圆点（10/50/100/500/1000张 + 全部库存，库存不足的档位自动禁用）
  //   + 时长（1/3/5/10分钟）→「确定发放」。
  // 数量档位直接抄后台：发放前先读弹窗实际可用的档位，选不中就回退「全部库存」。
  const COUPON_COUNT_OPTIONS = [
    { v: 10, label: '10 张' }, { v: 50, label: '50 张' }, { v: 100, label: '100 张' },
    { v: 500, label: '500 张' }, { v: 1000, label: '1000 张' }, { v: 0, label: '全部库存' }
  ];
  const Coupon = {
    // 扫描后台券列表（打开抽屉 → 读表格行）
    // 要开抽屉，必须独占页面（否则正在弹讲解/发评的动作会点到遮罩上）
    scan() {
      return withPage('扫描优惠券', () => this._scan(), { prio: 2 });
    },
    async _scan() {
      await ensureHome('扫描优惠券');
      const open = await act('扫券', '打开优惠券面板', () => this.openPanel());
      if (!open || !open.ok) { Log.push('err', '打不开优惠券面板'); return; }
      await sleep(humanJitter(800));
      const r = await call('couponPanelRows', []);
      if (!r || !r.ok) {
        Log.push('err', '没读到券列表：' + ((r && r.reason) || '面板里可能还没有可发放的优惠券'));
        return;
      }
      cfg.coupon.list = r.rows;
      cfg.coupon.scannedAt = new Date().toTimeString().slice(0, 5);
      // 清掉已不在列表里的勾选
      const names = new Set(r.rows.map((x) => x.name));
      cfg.coupon.selected = (cfg.coupon.selected || []).filter((n) => names.has(n));
      saveConfig();
      Log.push('ok', `扫到 ${r.rows.length} 张券：` + r.rows.map((x) => `「${x.name}」${x.value}${x.avail ? ' 可用' + x.avail : ''}`).join('、'));
      if (activeTab === 'coupon') renderPanel();
      // 收起抽屉，避免挡住中控台
      await closeOverlays();
    },

    // 打开优惠券面板：多个候选 + 重试（扫券刚关掉抽屉时，页面要缓一下才重新可点）
    async openPanel() {
      const cands = [
        cfg.selectors.couponEntry || 'text=优惠券',
        '[class*="marketing-tool"] [class*="title"]',
        'class=item-F2Ffm7'
      ];
      // 关键：抽屉可能已经开着（上一轮发完没关严）。此时再点「优惠券」会把它点关掉，
      // 于是第二轮起一直"打不开面板" → 用户看到"只能成功发一次"。
      const already = await call('couponPanelRows', []);
      if (already && already.ok) return { ok: true, selector: '(already-open)' };
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const sel of cands) {
          const r = await clickReal(sel);
          if (r && r.ok) {
            await sleep(humanJitter(1600));
            // 面板开没开：能读到表格行就算开了
            const rows = await call('couponPanelRows', []);
            if (rows && rows.ok) return { ok: true, selector: sel };
          }
        }
        await sleep(humanJitter(1200));
      }
      return { ok: false, reason: 'panel-not-open' };
    },

    async start() {
      if (running.coupon) return;
      const s = cfg.selectors;
      if (!s.couponGrantBtn) { Log.push('err', '发券：请先到「高级」页一键适配'); return; }

      const c = cfg.coupon;
      const targets = (c.selected || []).length
        ? (c.list || []).filter((x) => c.selected.includes(x.name))
        : [];
      if ((c.selected || []).length && !targets.length) {
        Log.push('err', '勾选的券已不在后台列表里，请重新点「↻ 只扫券」或「⚡ 同步全部」');
        return;
      }

      const token = makeToken();
      running.coupon = token;
      refreshStatus();
      const ready = await withTask('发券·就绪', token, () => ensureHome('发优惠券'));
      if (!token.alive || !ready || ready.ok === false) {
        running.coupon = null; refreshStatus(); renderPanel();
        if (token.alive) Log.push('err', '发券：中控台还没准备好，稍后再试');
        return;
      }
      const cnt = Number(c.count) || 0;
      // 间隔语义（按用户理解）：券在用户侧的有效期 = durationMin（1/3/5/10 分钟都可能）；
      // 「间隔」= 券到期之后还要等多久才发下一批。
      // 所以两次发放的真实间隔 = 有效期 + 间隔（券 3 分钟 + 间隔 60 秒 → 4 分钟才发下一批）。
      const DUR_OPTS = [1, 3, 5, 10];
      let durMin = Math.max(1, Number(c.durationMin) || 1);
      if (!DUR_OPTS.includes(durMin)) {
        // 后台只有 1/3/5/10 分钟四档，配置里是别的值就取最接近的一档（并写回配置）
        durMin = DUR_OPTS.reduce((a, b) => (Math.abs(b - durMin) < Math.abs(a - durMin) ? b : a), DUR_OPTS[0]);
        Log.push('warn', `发券时长 ${c.durationMin} 分钟后台没有这一档，改用最接近的 ${durMin} 分钟`);
        c.durationMin = durMin; saveConfig();
      }
      const waitSec = Math.max(60, Math.round(Number(c.intervalSec) || 0) || 60);
      const gapSec = durMin * 60 + waitSec;   // 两次发放之间的总间隔
      const hh = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      Log.push('info', `发券 · 节奏：券有效期 ${durMin} 分钟 + 到期后再等 ${waitSec} 秒 → 每 ${Math.round(gapSec / 60 * 10) / 10} 分钟发一批`);
      Log.push('info', `发券启动：${targets.length ? targets.map((t) => `「${t.name}」`).join('、') : '面板第一张券'} · 数量 ${cnt > 0 ? cnt + ' 张' : '全部库存'} · 时长 ${durMin} 分钟 · ${Number(c.times) > 0 ? `共 ${c.times} 次` : '无限次'}`);

      let done = 0;
      let issuedAt = null;
      let round = 0;            // 第几轮
      let pageRetry = 0;        // 页面出问题时的重试次数（防死循环）
      let lastIssueAt = 0;      // 上一次真正发出去的时刻（用于「每次发放之间必须间隔够」）
      while (token.alive) {
        round++;
        let issuedThis = 0;   // 本轮发出去了几张（在临界区外声明，收尾判断要用）
        if (!inTimeWindow(c.timeFrom, c.timeTo)) {
          Log.push('info', `发券 · 第${round}轮：不在发放时段，等 60 秒后再检查`);
          if (!(await wait(token, 60000))) break;
          continue;
        }

        // 两次发放之间要等「券有效期 + 间隔」，默认配置下就是 1 分钟 + 60 秒 = 2 分钟。
        // 这段等待必须放在独占区【外面】：以前是在拿到页面之后才等，等于每 2 分钟就把页面
        // 锁在自己手里 2 分钟，弹讲解/发评/秒杀全被堵在门外（真机压测时最长饿死 28 秒）。
        if (lastIssueAt) {
          const remain = Math.max(0, gapSec * 1000 - (Date.now() - lastIssueAt));
          if (remain > 800) {
            Log.push('info', `发券 · 距上次发放不足 ${gapSec} 秒，再等 ${Math.ceil(remain / 1000)} 秒（${hh(new Date(Date.now() + remain))}）· 期间页面让给其它功能`);
            if (!(await wait(token, remain))) break;
          }
        }

        // === 本轮独占页面：从打开券面板到收起面板，中间不让其它任务插进来 ===
        await PageBus.acquire('发券', token, { prio: 0, token: token });
        PageBus.inBody = true;
        try {
          // ① 先确认页面是干净的（上一轮的抽屉没关严会导致这一轮抓不到行）
          await forceClean('发券前');
          const open = await act('发券', '打开优惠券面板', () => this.openPanel());
          if (!open || !open.ok) {
            const why = (open && open.reason) || '未知';
            Log.push('err', `发券 · 第${round}轮：打不开优惠券面板（${why}）`);
            Worker.noteTaskFailure('发券');
            // 页面正在刷新/被挡 → 等它恢复后继续（continue），别让整个发券任务退出（break）
            if (/guest-not-ready|no-frame|frame-.*timeout|worker-not-ready|still-covered|covered|panel-not-open/.test(why)) {
              await waitPageReady(token, 30000);
              pageRetry = (pageRetry || 0) + 1;
              if (pageRetry <= 3) continue;
              Log.push('err', '发券 · 连续多次打不开面板，先停下');
              break;
            }
            break;
          }
          pageRetry = 0;
          if (!(await wait(token, humanJitter(900)))) break;

          // ② 逐张（或第一张）点行内「发放优惠券」
          const rows = targets.length ? targets : [null];
          for (const t of rows) {
            if (!token.alive) break;
            let point = null;
            if (t) {
              // ① 先用「扫描券」时记下的行内按钮坐标（最稳，不依赖抽屉的类名）
              const cached = (cfg.coupon.list || []).find((x) => x.name === t.name);
              if (cached && cached.btn && Number(cached.btn.x) > 0) {
                const chk = await call('pointOk', [cached.btn.x, cached.btn.y]);
                if (chk && chk.ok) point = cached.btn;
                else Log.push('info', `券「${t.name}」的旧坐标失效（${(chk && chk.reason) || '未知'}），重新定位`);
              }
              // ② 重新定位一遍（表格滚过/换过位置时）
              if (!point) {
                const hit = await call('couponRowBtn', [t.name]);
                if (hit && hit.ok) point = hit.point;
                else { Log.push('warn', `没找到券「${t.name}」的发放按钮（${(hit && hit.reason) || '未知'}），跳过`); continue; }
              }
            } else {
              const loc = await call('locate', [s.couponGrantBtn]);
              if (loc && loc.ok) point = { x: loc.x, y: loc.y };
            }
            if (!point) { Log.push('warn', `发券 · 第${round}轮：没定位到「发放优惠券」按钮，跳过本轮`); continue; }

            // 多张券时，第一张已经发完、第二张还没到间隔 → 本轮到此为止，把页面还回去。
            // 绝不在这里等：现在占着页面，一等就把别的功能一起冻住（间隔在外层已经等过了）。
            if (lastIssueAt) {
              const remain = Math.max(0, gapSec * 1000 - (Date.now() - lastIssueAt));
              if (remain > 800) {
                Log.push('info', `发券 · 本轮已发 1 张，下一张还要等 ${Math.ceil(remain / 1000)} 秒，本轮先收工（页面让给其它功能）`);
                break;
              }
            }

            const grant = await act('发券', `点「发放优惠券」${t ? `（${t.name}）` : ''}`, async () => {
              const p = scaledXY(point);
              return tpTap(p.x, p.y);
            });
            if (!grant || !grant.ok) { Log.push('warn', '发放按钮没点上，跳过这张'); continue; }
            if (!(await wait(token, humanJitter(1300)))) break;

            // ③ 读弹窗档位（数量 + 时长都是后台的小圆点）
            const modal = await call('couponModalState', []);
            if (!modal || !modal.ok) { Log.push('warn', '发放确认弹窗没弹出来，跳过'); continue; }

            // 数量：优先精确档位；档位被禁用（库存不足）时退「全部库存」
            const wantText = cnt > 0 ? `${cnt}张` : '全部库存';
            let qtyText = wantText;
            const hitQty = modal.qty.find((o) => o.text === wantText && !o.disabled);
            if (!hitQty) {
              if (cnt > 0) {
                Log.push('warn', `档位「${wantText}」后台不可用（可用：${modal.qty.filter((o) => !o.disabled).map((o) => o.text).join('/')}），改用「全部库存」`);
              }
              qtyText = '全部库存';
            }
            const pickQty = await call('couponPick', [qtyText]);
            if (pickQty && pickQty.ok) {
              await act('发券', `数量选「${qtyText}」`, async () => {
                const p = scaledXY(pickQty.point);
                return tpTap(p.x, p.y);
              });
              if (!(await wait(token, humanJitter(500)))) break;
            } else {
              Log.push('warn', '数量档位没点上，按默认继续');
            }

            // 时长
            const durText = `${durMin}分钟`;
            const pickDur = await call('couponPick', [durText]);
            if (pickDur && pickDur.ok) {
              await act('发券', `时长选「${durText}」`, async () => {
                const p = scaledXY(pickDur.point);
                return tpTap(p.x, p.y);
              });
              if (!(await wait(token, humanJitter(400)))) break;
            }

            // ④ 确认发放（真正发放的一步）
            if (cfg.__testNoConfirm) {
              Log.push('warn', `[测试] 已选好数量/时长，跳过「确定发放」（不真发券）`);
              done++; issuedThis++;
              // 测试模式也要记发放时刻，否则「券间隔」这条逻辑在压测里永远不触发，
              // 测出来的节奏和真实使用不一致（真发时才会暴露出锁 2 分钟的问题）。
              lastIssueAt = Date.now();
              if (!(await wait(token, humanJitter(600)))) break;
              continue;
            }
            const confirmed = await act('发券', `确认发放${t ? `「${t.name}」` : ''}`, async () => {
              if (!modal.confirm) return { ok: false, reason: 'no-confirm-btn' };
              const p = scaledXY(modal.confirm);
              return tpTap(p.x, p.y);
            });
            if (confirmed && confirmed.ok) {
              done++; issuedThis++;
              Stats.bump('coupon', Number(c.count) || 1);
              const at = new Date();
              lastIssueAt = Date.now();
              Log.push('ok', `发券 · 第${round}轮 · 第${done}次发放完成（${hh(at)}）${Number(c.times) > 0 ? `（共 ${c.times} 次）` : ''}`);
              issuedAt = at;
            } else {
              Log.push('warn', `发券 · 第${round}轮：确认发放没点上，关闭弹窗重试`);
              await tpKey('Escape').catch(() => {});
            }
            if (!(await wait(token, humanJitter(900)))) break;
          }

          // 收起抽屉/弹窗再进下一轮（别把面板一直晾在中控台上）
          await closeOverlays();
        } finally {
          // 兜底收尾必须在【还锁着】的时候做：以前是先 release 再 closeOverlays，
          // 而那一下是异步的 —— 下一个任务可能已经拿到页面、刚拉开自己的抽屉，
          // 结果被这个"迟到的收尾"给关掉了（表现为别人的面板莫名消失、点不到按钮）。
          await closeOverlays().catch(() => {});
          PageBus.inBody = false;
          PageBus.release(token);
        }
        await maybeLongPause(token);
        if (Number(c.times) > 0 && done >= Number(c.times)) {
          Log.push('ok', `发券 · 已发满 ${c.times} 次，自动结束`);
          break;
        }
        if (issuedThis === 0) {
          // 一整轮都没发出去，别空转，拉长间隔
          if (!(await wait(token, humanJitter(Math.max(15000, gapSec * 1000))))) break;
          continue;
        }
        // 轮与轮之间的间隔统一在「下次发放前」按 lastIssueAt 卡（见上面的 remain 判断），
        // 这里只做一次短停顿 + 打点，不再额外 sleep 整段间隔（否则会双倍等待）。
        Log.push('info', `发券 · 第${round}轮结束（${issuedAt ? hh(issuedAt) : '—'}），下次发放间隔 ${gapSec} 秒`);
        if (!(await wait(token, humanJitter(1200)))) break;
      }

      running.coupon = null;
      refreshStatus();
      await withPage('发券·收尾', () => backToHome('发券结束'), { prio: 1 });
      Log.push('info', `发券已停止，本次共发放 ${done} 次`);
      renderPanel();
    },
    stop() { if (running.coupon) running.coupon.alive = false; }
  };

  // ---------- 6.4 秒杀投放：批量开启 / 一键停止 / 剩余监控自动补充 ----------
  // 真机结构（2026-10-21）：商品卡操作区闪电按钮 →「投放秒杀」抽屉（iframe drop-spike）→
  // 立即投放 / 投放库存 / 每人限购 / 秒杀倒计时 → 提交。坐标类操作全部走真实点击。
  const rcAt = async (point) => {
    if (!point || !Number.isFinite(point.x)) return { ok: false, reason: 'no-point' };
    const p = scaledXY(point);
    return tpTap(p.x, p.y);
  };

  const SecKill = {
    entries: [],

    scan() { return withPage('扫描秒杀入口', () => this._scan(), { prio: 2 }); },

    async _scan() {
      await ensureHome('扫描秒杀入口');
      const res = await call('seckillScan', []);
      if (!res || !res.ok) {
        Log.push('err', '扫描秒杀入口失败：' + ((res && res.reason) || '没找到商品列表，先确认已进入中控台'));
        return;
      }
      this.entries = res.items || [];
      if (!this.entries.length) {
        Log.push('info', `扫描完成：${res.cards} 个商品里没有秒杀入口（只有配置过秒杀活动的商品才有闪电按钮）`);
      } else {
        Log.push('ok', `扫描完成：${this.entries.length} 个秒杀入口 —— ` +
          this.entries.map((s) => `#${s.i} ${(s.name || '').slice(0, 12)}`).join('、'));
      }
      paintGoods();
    },

    entryAt(n) { return this.entries.find((e) => e.i === n); },

    // 等秒杀抽屉就绪：可能是「投放表单」（drop-spike 表单），也可能是「秒杀详情」
    // （已投放过的商品点闪电图标看到的是详情页，里面有 活动状态/投放库存/编辑/停止投放）。
    async waitForm(tries) {
      for (let i = 0; i < (tries || 10); i++) {
        await sleep(600);
        const f = await call('seckillForm', []);
        if (f && f.ok) return { ok: true, kind: 'form', form: f };
        const d = await call('seckillDetail', []);
        if (d && d.ok) return { ok: true, kind: 'detail', detail: d };
      }
      return { ok: false, reason: 'drawer-timeout' };
    },

    // 兼容旧调用：只要拿到抽屉（表单或详情）就算 ok
    async openForm(n) {
      const e = this.entryAt(n);
      if (!e) return { ok: false, reason: 'no-entry' };
      // 不直接用扫描时记下的坐标：中控台是 1600 宽固定布局，窗口窄时那个点在视口外。
      const cardSel = fillTemplate(cfg.selectors.card, String(n));
      const btnSel = '[class*="seckill-btn-container"]';

      // ① 真实点击（CDP 注入，不抢鼠标）
      const click = await realClickAt(() => call('locateIn', [cardSel, btnSel]));
      let got = await this.waitForm(8);
      if (got.ok) return got;

      // ② 闪电图标实测只认程序化点击（坐标点击不触发它的 onClick），DOM 点击兜底
      Log.push('info', `#${n} 坐标点击没打开秒杀面板，改用 DOM 点击重试`);
      const dc = await call('clickIn', [cardSel, btnSel]);
      if (dc && dc.ok) {
        got = await this.waitForm(8);
        if (got.ok) return got;
      }
      return { ok: false, reason: (click && click.ok) ? 'drawer-not-open' : ((click && click.reason) || 'click-failed') };
    },

    async closeForm() {
      try {
        const c = await call('seckillClose', []);
        if (c && c.ok && c.point) await rcAt(c.point);
        else await tpKey('Escape');
      } catch (e) {}
      await sleep(humanJitter(700));
    },

    // 详情态 → 点「编辑」进投放表单；返回表单（失败返回 {ok:false}）
    async enterEdit(n, drawer) {
      const d = drawer && drawer.detail ? drawer.detail : null;
      if (!d || !d.hasEdit) return { ok: false, reason: 'no-edit-button' };
      const done = await act('秒杀', `#${n} 点「编辑」进入投放表单`, () => call('seckillClickText', [['编辑', '修改']]));
      if (!done || !done.ok) {
        if (d.points && d.points.edit) await rcAt(d.points.edit);
      }
      await sleep(humanJitter(1600));
      // 编辑后出现的是投放表单（同 drop-spike iframe），等它
      for (let i = 0; i < 10; i++) {
        const f = await call('seckillForm', []);
        if (f && f.ok) return { ok: true, form: f };
        await sleep(700);
      }
      return { ok: false, reason: 'edit-form-timeout' };
    },

    // 单卡开启：投放方式（立即+时长 / 定时+时间）+ 库存/限购/倒计时 + 提交
    async enableOne(n) {
      const sk = cfg.seckill;
      const wantMode = sk.mode === 'sched' ? 'sched' : 'now';
      const got = await this.openForm(n);
      if (!got.ok) return got;

      // 已经有进行中的秒杀 → 这是「详情」态，要补库存请用「立即补充一次」
      if (got.kind === 'detail') {
        const d = got.detail;
        Log.push('warn', `#${n} 已有秒杀（${d.status || '进行中'} · 投放库存 ${d.stock == null ? '—' : d.stock} · 秒杀件数 ${d.sold == null ? '—' : d.sold}），本次跳过；要加量请用「＋ 立即补充一次」`);
        await this.closeForm();
        return { ok: false, reason: 'already-active' };
      }
      let f = got.form;

      // ① 投放方式。
      // 关键：抽屉打开时默认可能是「定时投放」，此时「投放时长」按钮根本没渲染，
      // 切换前读到的坐标全是 null —— 切完必须重新读一遍表单。
      if (f.mode !== wantMode) {
        const modePoint = wantMode === 'sched' ? (f.points && f.points.sched) : (f.points && f.points.now);
        if (modePoint) {
          await rcAt(modePoint);
          await sleep(humanJitter(700));
          const f2 = await call('seckillForm', []);
          if (f2 && f2.ok) f = f2;
          else Log.push('warn', `#${n} 切到「${wantMode === 'sched' ? '定时' : '立即'}投放」后没读到表单`);
        } else {
          Log.push('warn', `#${n} 面板上没找到「${wantMode === 'sched' ? '定时' : '立即'}投放」选项`);
        }
      }
      let pt = f.points || {};

      // ② 时间 / 时长
      if (wantMode === 'sched') {
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const parseTs = (v) => {
          const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
          if (!m) return null;
          const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
          return Number.isNaN(d.getTime()) ? null : d;
        };
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
        const fromParts = (date, h, m) => {
          const mm = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!mm) return null;
          const hh = Math.min(23, Math.max(0, Number(h) || 0));
          const mi = Math.min(59, Math.max(0, Number(m) || 0));
          return new Date(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3]), hh, mi, 0, 0);
        };
        let startDate = fromParts(sk.startDate, sk.startH, sk.startM) || parseTs(sk.startAt) || dayStart;
        let endDate = fromParts(sk.endDate, sk.endH, sk.endM) || parseTs(sk.endAt) || dayEnd;
        if (endDate.getTime() <= startDate.getTime()) endDate = dayEnd;
        const startStr = fmt(startDate);
        const endStr = fmt(endDate);
        if (startDate.getTime() < Date.now() - 60000) {
          Log.push('warn', `#${n} 开始时间 ${startStr} 已过，抖音可能不接受；建议改成当前时间之后`);
        }
        Log.push('info', `#${n} 定时投放：${startStr} ~ ${endStr}（照此在后台日历上点选）`);
        const pick = await call('seckillPickRange', [startStr, endStr]);
        if (!pick || !pick.ok) {
          Log.push('err', `#${n} 投放时间没选上（${(pick && pick.reason) || '未知'}），放弃这张`);
          await this.closeForm();
          return { ok: false, reason: 'time-pick-failed' };
        }
        Log.push('ok', `#${n} 投放时间已选：${pick.start || startStr} ~ ${pick.end || endStr}`);
      } else {
        const dur = Number(sk.durationMin) || 30;
        const durPoint = dur <= 10 ? pt.dur10 : (dur <= 30 ? pt.dur30 : pt.dur60);
        const durText = dur <= 10 ? '10分钟' : (dur <= 30 ? '30分钟' : '60分钟');
        if (durPoint) {
          await act('秒杀', `#${n} 投放时长选「${durText}」`, () => rcAt(durPoint));
          await sleep(humanJitter(400));
        }
        const dc = await call('seckillSetDuration', [durText]);
        if (!dc || !dc.ok) Log.push('warn', `#${n} 没点到「投放时长 ${durText}」（${(dc && dc.reason) || '未知'}）——不选时长抖音不让提交`);
        await sleep(humanJitter(600));
      }

      // ③ 库存 / 限购
      const stock = Number(sk.stock) || 50;
      await call('seckillSetNum', [0, stock]);
      await sleep(500);
      let cur = await call('seckillForm', []);
      if (!cur || !cur.ok) return { ok: false, reason: 'form-gone' };
      pt = cur.points || pt;
      if (String(cur.stockValue) !== String(stock)) {
        Log.push('info', `#${n} 库存合成写入没生效，改用真实键盘输入`);
        if (pt.stock) {
          const p = scaledXY(pt.stock);
          await tpTap(p.x, p.y);
          await tpKey('Backspace', 8);
          await tpType(p.x, p.y, String(stock));
          await sleep(450);
        }
      }
      if (Number(sk.limit) > 0 && pt.limit) {
        await call('seckillSetNum', [1, Number(sk.limit)]);
        await sleep(500);
        const l = await call('seckillForm', []);
        pt = (l && l.ok && l.points) ? l.points : pt;
        if (!l || !l.ok || String(l.limitValue) !== String(Number(sk.limit))) {
          const p = scaledXY(pt.limit);
          await tpTap(p.x, p.y);
          await tpKey('Backspace', 8);
          await tpType(p.x, p.y, String(sk.limit));
          await sleep(450);
        }
      }
      if (sk.countdown && pt.countdownOn) {
        await rcAt(pt.countdownOn);
        await sleep(humanJitter(300));
      }

      // ④ 提交前自检：条件不齐就放弃（关掉抽屉，不点"取消"）
      let f2 = await call('seckillForm', []);
      for (let i = 0; i < 6 && (!f2 || !f2.ok || f2.submitDisabled); i++) {
        await sleep(500);
        const again = await call('seckillForm', []);
        if (again && again.ok) f2 = again;
        if (f2 && !f2.submitDisabled) break;
      }
      if (!f2 || !f2.ok) return { ok: false, reason: 'form-gone' };
      if (f2.submitDisabled || !f2.points.submit) {
        const why = [];
        if (!f2.activeDur && wantMode !== 'sched') why.push('投放时长未选');
        if (String(f2.stockValue) === '0' || String(f2.stockValue) === '') why.push('库存为空');
        Log.push('err', `#${n} 提交按钮仍是禁用（${why.join('、') || '后台校验未通过'}；库存=${f2.stockValue} 限购=${f2.limitValue} 时长=${f2.activeDur || f2.customDurValue || '未选'}），已放弃，未提交`);
        await this.closeForm();
        return { ok: false, reason: 'submit-disabled' };
      }
      if (cfg.__testNoSubmit) {
        Log.push('warn', `[测试] 条件已通过，跳过提交（库存 ${f2.stockValue} · 限购 ${f2.limitValue || '不限'}）`);
        await this.closeForm();
        return { ok: true, test: true };
      }
      const sub = await act('秒杀', `#${n} 提交投放（库存 ${f2.stockValue} · 限购 ${f2.limitValue || '不限'} · ${wantMode === 'sched' ? '定时' : (f2.activeDur || '立即')}）`, () => rcAt(f2.points.submit));
      if (!sub || !sub.ok) return sub || { ok: false, reason: 'submit-failed' };

      await sleep(humanJitter(1400));
      const cf = await call('seckillConfirm', []);
      if (cf && cf.ok) {
        Log.push('info', `#${n} 出现二次确认，已点「${cf.clicked}」`);
        await sleep(humanJitter(1500));
      }
      const toast = await call('readToast', []);
      if (toast && toast.ok && toast.text) {
        const bad = /失败|错误|不能|无法|请选择|请填|超过|不足|异常/.test(toast.text);
        Log.push(bad ? 'err' : 'ok', `#${n} 后台提示：${toast.text}`);
      } else {
        Log.push('info', `#${n} 提交完成（后台没弹提示，请在货架上确认是否生效）`);
      }
      await this.closeForm();
      return { ok: true };
    },

    async enableAll() {
      const ready = await withPage('一键开启秒杀·就绪', () => ensureHome('一键开启秒杀'), { prio: 2 });
      if (!ready || ready.ok === false) { Log.push('err', '一键开启秒杀：中控台还没准备好'); return; }
      const cards = (cfg.seckill.cards || []).filter((n) => this.entryAt(n));
      if (!cards.length) {
        Log.push('err', '一键开启秒杀：请先「扫描入口」并勾选要投放的商品');
        return;
      }
      refreshStatus();
      Log.push('warn', `开始批量秒杀投放：${cards.length} 个商品（库存 ${cfg.seckill.stock} · 限购 ${Number(cfg.seckill.limit) > 0 ? cfg.seckill.limit : '不限'}）`);
      let okN = 0;
      for (const n of cards) {
        // 每张卡单独一段临界区：做完一张就交还页面，别的功能可以趁机插进来
        const r = await withPage(`秒杀投放 #${n}`, () => this.enableOne(n), { prio: 2 });
        if (r && r.ok) { okN++; Stats.bump('seckill'); Log.push('ok', `#${n} 秒杀已提交`); }
        else Log.push('err', `#${n} 投放失败（${(r && r.reason) || '未知'}）`);
        await sleep(humanJitter(1500));
      }
      Log.push(okN === cards.length ? 'ok' : 'warn', `批量投放结束：成功 ${okN}/${cards.length}`);
      await withPage('秒杀投放·收尾', () => backToHome('秒杀投放结束'), { prio: 2 });
      refreshStatus();
    },

    // 一键停止：详情页里点「停止投放」（进行中才有）
    async stopAll() {
      const ready0 = await withPage('一键停止秒杀·就绪', () => ensureHome('一键停止秒杀'), { prio: 2 });
      if (!ready0 || ready0.ok === false) { Log.push('err', '一键停止秒杀：中控台还没准备好'); return; }
      const cards = (cfg.seckill.cards || []).filter((n) => this.entryAt(n));
      if (!cards.length) {
        Log.push('err', '一键停止秒杀：请先「扫描入口」并勾选商品');
        return;
      }
      Log.push('info', `开始批量停止秒杀：${cards.length} 个商品`);
      refreshStatus();
      let stopped = 0, skipped = 0;
      for (const n of cards) {
        const one = await withPage(`停止秒杀 #${n}`, () => this._stopOne(n), { prio: 2 });
        if (one && one.ok) stopped++;
        else skipped++;
        await sleep(humanJitter(1000));
      }
      Log.push('info', `一键停止结束：停止 ${stopped} 个，跳过 ${skipped} 个`);
      await withPage('停止秒杀·收尾', () => backToHome('停止秒杀结束'), { prio: 2 });
      refreshStatus();
      return;
    },
    // 单个商品的停止动作（在临界区里执行）
    // 单个商品的停止动作（在临界区里执行，做完立刻归还页面）
    async _stopOne(n) {
      const got = await this.openForm(n);
      if (!got.ok) {
        Log.push('warn', `#${n} 打不开秒杀面板（${(got && got.reason) || '未知'}）`);
        return { ok: false, reason: got.reason || 'open-failed' };
      }
      const d = got.kind === 'detail' ? got.detail : null;
      let res = { ok: false, reason: 'no-active' };
      if (d && d.points && d.points.stop) {
        const r = await act('秒杀', `#${n} 停止投放`, () => rcAt(d.points.stop));
        if (r && r.ok) {
          await sleep(humanJitter(1200));
          const cf = await call('seckillConfirm', []);
          if (cf && cf.ok) {
            Log.push('info', `#${n} 停止确认已点「${cf.clicked}」`);
            await sleep(humanJitter(1000));
          }
          res = { ok: true };
        }
      } else {
        Log.push('info', `#${n} 没有进行中的秒杀（${d ? d.status || '详情里没有停止按钮' : '投放表单态'}），跳过`);
      }
      await this.closeForm();
      return res;
    },

    // 追加库存（真机流程）：点闪电 → 详情 → 点「编辑」 → 原投放库存 + 追加量 → 提交
    async replenishOne(n, addQty, drawer) {
      const add = Math.max(1, Number(addQty) || Number(cfg.seckill.addQty) || 1);
      let got = drawer || await this.openForm(n);
      if (!got.ok) return got;

      let f = null;
      if (got.kind === 'detail') {
        const d = got.detail;
        Log.push('info', `#${n} 详情：${d.status || '—'} · 投放库存 ${d.stock == null ? '—' : d.stock} · 秒杀件数 ${d.sold == null ? '—' : d.sold} · 剩余 ${d.remain == null ? '—' : d.remain}`);
        const ed = await this.enterEdit(n, got);
        if (!ed.ok) {
          Log.push('err', `#${n} 进不了编辑（${ed.reason}）——该秒杀可能已结束，不能再改库存`);
          await this.closeForm();
          return { ok: false, reason: ed.reason };
        }
        f = ed.form;
      } else {
        f = got.form;
      }

      // 原投放库存 + 追加量
      const cur = Number(String(f.stockValue || '').replace(/[^\d]/g, '')) || 0;
      const next = cur + add;
      Log.push('info', `#${n} 原投放库存 ${cur} 件，追加 ${add} 件 → ${next} 件`);
      await call('seckillSetNum', [0, next]);
      await sleep(450);
      let chk = await call('seckillForm', []);
      if (!chk || !chk.ok) return { ok: false, reason: 'form-gone' };
      if (String(chk.stockValue) !== String(next)) {
        Log.push('info', `#${n} 合成写值没生效，改用真实键盘输入`);
        const q0 = chk.points && chk.points.stock;
        if (q0) {
          const q = scaledXY(q0);
          await tpTap(q.x, q.y);
          await tpKey('Backspace', 8);
          await tpType(q.x, q.y, String(next));
          await sleep(500);
          chk = await call('seckillForm', []);
        }
      }

      let okForm = chk;
      for (let i = 0; i < 6 && (!okForm || !okForm.ok || okForm.submitDisabled); i++) {
        await sleep(500);
        const again = await call('seckillForm', []);
        if (again && again.ok) okForm = again;
        if (okForm && !okForm.submitDisabled) break;
      }
      if (!okForm || !okForm.ok) return { ok: false, reason: 'form-gone' };
      if (okForm.submitDisabled || !okForm.points.submit) {
        Log.push('err', `#${n} 追加后提交按钮仍禁用（库存=${okForm.stockValue}），已放弃 —— 已结束的秒杀通常不能再改库存`);
        await this.closeForm();
        return { ok: false, reason: 'submit-disabled' };
      }
      if (cfg.__testNoSubmit) {
        Log.push('warn', `[测试] 追加到 ${okForm.stockValue} 件，条件已通过，跳过提交`);
        await this.closeForm();
        return { ok: true, test: true, stock: okForm.stockValue };
      }
      const sub = await act('秒杀', `#${n} 提交追加（${cur} → ${okForm.stockValue}）`, () => rcAt(okForm.points.submit));
      if (!sub || !sub.ok) return { ok: false, reason: 'submit-failed' };
      await sleep(humanJitter(1400));
      const cf = await call('seckillConfirm', []);
      if (cf && cf.ok) {
        Log.push('info', `#${n} 出现二次确认，已点「${cf.clicked}」`);
        await sleep(humanJitter(1200));
      }
      const toast = await call('readToast', []);
      if (toast && toast.ok && toast.text) {
        const bad = /失败|错误|不能|无法|超过|不足|异常/.test(toast.text);
        Log.push(bad ? 'err' : 'ok', `#${n} 后台提示：${toast.text}`);
      }
      await this.closeForm();
      return { ok: true, stock: okForm.stockValue };
    },

    // 手动「补充一次」：对勾选的商品各追加一次（不用等监控，随时可测）
    async replenishNow() {
      const ready1 = await withPage('补充秒杀库存·就绪', () => ensureHome('补充秒杀库存'), { prio: 2 });
      if (!ready1 || ready1.ok === false) { Log.push('err', '补充库存：中控台还没准备好'); return; }
      const cards = (cfg.seckill.cards || []).filter((n) => this.entryAt(n));
      if (!cards.length) {
        Log.push('err', '补充库存：请先「扫描入口」并勾选商品');
        return;
      }
      const add = Math.max(1, Number(cfg.seckill.addQty) || 50);
      Log.push('warn', `开始补充库存：${cards.length} 个商品，每个在原数量上追加 ${add} 件`);
      let okN = 0;
      for (const n of cards) {
        const r = await withPage(`补充库存 #${n}`, () => this.replenishOne(n, add), { prio: 2 });
        if (r && r.ok) { okN++; Stats.bump('seckill'); Log.push('ok', `#${n} 已追加到 ${r.stock || '—'} 件`); }
        else Log.push('err', `#${n} 追加失败（${(r && r.reason) || '未知'}）`);
        await sleep(humanJitter(1500));
      }
      Log.push(okN === cards.length ? 'ok' : 'warn', `补充结束：成功 ${okN}/${cards.length}`);
      await withPage('补充库存·收尾', () => backToHome('补充库存结束'), { prio: 2 });
      renderPanel();
    },

    // 监控：定期读详情的「投放库存 - 秒杀件数」，低于阈值就追加
    async start() {
      if (running.seckill) return;
      const cards = (cfg.seckill.cards || []).filter((n) => this.entryAt(n));
      if (!cards.length) {
        Log.push('err', '秒杀监控：请先「扫描入口」并勾选商品');
        return;
      }
      const token = makeToken();
      running.seckill = token;
      refreshStatus();
      const ready2 = await withTask('秒杀监控·就绪', token, () => ensureHome('秒杀监控'));
      if (!token.alive || !ready2 || ready2.ok === false) {
        running.seckill = null; refreshStatus(); renderPanel();
        if (token.alive) Log.push('err', '秒杀监控：中控台还没准备好，稍后再试');
        return;
      }
      const addQty = Math.max(1, Number(cfg.seckill.addQty) || 50);
      Log.push('info', `秒杀监控启动：${cards.length} 个商品 · 每 ${cfg.seckill.monitorSec}s 扫一轮 · 剩余 ≤ ${cfg.seckill.minStock} 时在原数量上追加 ${addQty} 件`);
      let warned = false;
      while (token.alive) {
        for (const n of cards) {
          if (!token.alive) break;
          // 开抽屉 → 读详情 → 需要就追加 → 关抽屉：一整段独占，中途不能被别的任务插进来
          await PageBus.acquire(`秒杀监控 #${n}`, token, { prio: 0, token: token });
          PageBus.inBody = true;
          try {
            const got = await this.openForm(n);
            if (!got.ok) {
              Log.push('warn', `#${n} 打不开秒杀面板（${(got && got.reason) || '未知'}）`);
              await sleep(humanJitter(1200));
              continue;
            }
            if (got.kind !== 'detail') {
              // 还没投放（是新建表单态）——没东西可补
              if (!warned) { Log.push('info', `#${n} 还没投放秒杀（打开的是投放表单），无需补充`); warned = true; }
              await this.closeForm();
              await sleep(humanJitter(1000));
              continue;
            }
            const d = got.detail;
            if (d.remain == null) {
              if (!warned) {
                Log.push('warn', `#${n} 详情里读不到「投放库存/秒杀件数」，暂不自动补充（状态：${d.status || '—'}）`);
                warned = true;
              }
              await this.closeForm();
              await sleep(humanJitter(1000));
              continue;
            }
            Log.push('info', `#${n} 投放库存 ${d.stock} · 已卖 ${d.sold} · 剩余 ${d.remain}（阈值 ${cfg.seckill.minStock}）`);
            if (d.remain <= Number(cfg.seckill.minStock)) {
              Log.push('warn', `#${n} 剩余 ${d.remain} ≤ 阈值 ${cfg.seckill.minStock}，开始追加 ${addQty} 件`);
              const r = await this.replenishOne(n, addQty, got);
              Log.push(r && r.ok ? 'ok' : 'err', `#${n} ${r && r.ok ? `追加完成（→ ${r.stock || '—'} 件）` : `追加失败（${(r && r.reason) || '未知'}）`}`);
            } else {
              await this.closeForm();
            }
            await sleep(humanJitter(1200));
          } finally {
            // openForm 失败/抛异常时可能把秒杀抽屉留在页面上 —— 不关掉的话，
            // 后面所有功能（弹讲解/发评/发券）的点击都会落在遮罩上，看起来"全都失效了"。
            // 同样必须在还锁着时收尾，先 release 再关会误关下一个任务的抽屉。
            await closeOverlays().catch(() => {});
            PageBus.inBody = false;
            PageBus.release(token);
          }
        }
        if (!(await wait(token, Number(cfg.seckill.monitorSec || 60) * 1000))) break;
      }
      running.seckill = null;
      refreshStatus();
      Log.push('info', '秒杀监控已停止');
      renderPanel();
    },

    stop() { if (running.seckill) running.seckill.alive = false; }
  };

  // 商品行渲染：整页渲染、局部重绘、秒杀入口列表三处共用一份。
  // 之前这段 <label class="goods-row"> 被抄了两遍（整页一份、重绘一份），
  // 改样式必有一处漏掉；秒杀入口那张表其实也是同一个结构，只是右列换成标记文字。
  //   opts.checked  是否勾选
  //   opts.action   勾选时写入的动作名（默认 pick-goods）
  //   opts.tag      右列替代文案，不传就显示商品 ID
  //   opts.noRight  右列整列不要（弹讲解的勾选列表只要名字）
  function goodsRowHtml(it, opts) {
    const o = opts || {};
    const right = o.noRight ? '' : (o.tag
      ? `<span class="goods-gid">${escapeHtml(o.tag)}</span>`
      : `<span class="goods-gid">${escapeHtml(it.goodsId || '')}</span>`);
    return `
      <label class="goods-row">
        <input type="checkbox" data-action="${o.action || 'pick-goods'}" data-i="${it.i}" ${o.checked ? 'checked' : ''}>
        <span class="goods-idx">${it.i}</span>
        <span class="goods-name">${escapeHtml(it.name || '(未识别名称)')}</span>
        ${right}
      </label>`;
  }

  // 商品列表局部重绘（抓取后调用，不影响其它输入框焦点）
  function paintGoods() {
    const body = $('#goodsBody');
    if (body) {
      const list = cfg.goods.list || [];
      const sel = new Set(cfg.popup.selected || []);
      body.innerHTML = list.length
        ? list.map((it) => goodsRowHtml(it, { checked: sel.has(it.i) })).join('')
        : '<div class="empty">还没有商品 —— 点上面的「↻ 只抓商品」或「⚡ 同步全部」</div>';
    }
    paintSeckill();
  }

  // 秒杀入口列表局部重绘（扫描后调用）
  function paintSeckill() {
    const body = $('#seckillBody');
    if (!body) return;
    const entries = (SecKill.entries || []);
    const selSet = new Set(cfg.seckill.cards || []);
    body.innerHTML = entries.length
      ? entries.map((e) => goodsRowHtml(e, { checked: selSet.has(e.i), action: 'pick-seckill', tag: '有秒杀入口' })).join('')
      : '<div class="empty">还没扫描 —— 点「↻ 只扫入口」，或确认商品已配置过秒杀活动</div>';
  }

  // ---------- 6.4 欢迎语 / 感谢语 ----------
  const Welcome = {
    known: new Set(),
    async start() {
      if (running.welcome) return;
      if (!cfg.selectors.viewerItem) { Log.push('err', '欢迎语：请先绑定「在线观众容器」'); return; }
      if (!cfg.selectors.commentInput) { Log.push('err', '欢迎语：请先绑定「评论输入框」'); return; }

      const token = makeToken();
      running.welcome = token;
      this.known = new Set();
      refreshStatus();
      Log.push('info', '欢迎语已启动（首次扫描只建立基线，不会刷屏）');

      let firstScan = true;
      while (token.alive) {
        let list = [];
        try {
          list = await call('readList', [cfg.selectors.viewerItem, cfg.selectors.viewerName, null, 80]);
        } catch (e) {
          Log.push('err', '读取观众列表失败：' + e.message);
        }

        const names = (list || []).map((x) => x.text || x.user).filter(Boolean);
        if (firstScan) {
          names.forEach((n) => this.known.add(n));
          firstScan = false;
          Log.push('info', `基线观众 ${this.known.size} 人`);
        } else {
          const fresh = names.filter((n) => !this.known.has(n));
          for (const name of fresh.slice(0, 3)) {
            this.known.add(name);
            const msg = String(cfg.welcome.template || '').replace(/\{name\}/g, name);
            if (!msg) continue;
            // 必须走页面独占：发欢迎语要点输入框、清空、逐字打字再回车。
            // 以前这里是裸调用，观众一进房就可能正好插在发评打字的中途 ——
            // 两边抢同一个输入框，结果是两边都发错或发不出去。
            await withTask('欢迎语', token, () => sendComment(msg), { prio: 0 });
            if (!(await wait(token, rand(1800, 3600)))) break;
          }
          fresh.forEach((n) => this.known.add(n));
        }

        if (!(await wait(token, Number(cfg.welcome.pollSec || 8) * 1000))) break;
      }

      running.welcome = null;
      refreshStatus();
      Log.push('info', '欢迎语已停止');
      renderPanel();
    },
    stop() { if (running.welcome) running.welcome.alive = false; }
  };

  const Thanks = {
    last: '',
    async start() {
      if (running.thanks) return;
      if (!cfg.selectors.orderToast) { Log.push('err', '感谢语：请先绑定「成交/下单提示条」'); return; }
      if (!cfg.selectors.commentInput) { Log.push('err', '感谢语：请先绑定「评论输入框」'); return; }

      const token = makeToken();
      running.thanks = token;
      this.last = '';
      refreshStatus();
      Log.push('info', '成交感谢语已启动（每 ' + cfg.welcome.thanksPollSec + ' 秒检查一次提示条）');

      while (token.alive) {
        try {
          const p = await call('probe', [cfg.selectors.orderToast]);
          const now = p && p.found ? p.text : '';
          if (now && now !== this.last) {
            if (this.last) {
              // 同上：感谢语也占输入框，必须排队，不能和发评/欢迎语抢
              await withTask('感谢语', token, () => sendComment(cfg.welcome.thanksTemplate), { prio: 0 });
            }
            this.last = now;
          } else if (!now) {
            this.last = '';
          }
        } catch (e) {
          Log.push('err', '检查成交提示失败：' + e.message);
        }
        if (!(await wait(token, Number(cfg.welcome.thanksPollSec || 5) * 1000))) break;
      }

      running.thanks = null;
      refreshStatus();
      Log.push('info', '成交感谢语已停止');
      renderPanel();
    },
    stop() { if (running.thanks) running.thanks.alive = false; }
  };

  // ============================================================
  // 7. 选择器：手填 / 拾取 / 扫描
  // ============================================================
  let pickTarget = null;
  let pickPollTimer = null;
  let lastScan = [];
  let lastScanFrames = 0;
  // 高级页「识别名单」：上一次一键分析的结果，切页回来不丢
  let lastDetect = null;

  // 同步全部的结果卡（挂在「商品」页顶部）
  function syncCard() {
    const s = cfg.lastSync;
    if (!s) return '<div class="empty" style="margin-top:8px">还没同步过 —— 点「⚡ 同步全部」，约 10 秒把商品/券/秒杀入口都抓好</div>';
    return `<div class="sync-card">
      <div class="sync-at">上次同步 ${escapeHtml(s.at || '')} · 结构识别 ${s.detectGood || 0}/${s.detectTotal || 0}</div>
      <div class="sync-grid">
        <span>商品<b>${s.goods || 0}</b>个</span>
        <span>秒杀入口<b>${s.seckills || 0}</b>个</span>
        <span>优惠券<b>${s.coupons || 0}</b>张</span>
      </div>
    </div>`;
  }

  // 识别名单渲染：按功能分组，✓=已适配可直接用，×=当前看不到（附什么时候能看到）
  function detectHtml() {
    if (!lastDetect) return '<div class="empty">还没分析 —— 点上面的「🔍 只分析结构」</div>';
    const d = lastDetect;
    // 上次「同步全部」确实抓到过数据的项，即使现在面板关着也标成 ✓ 并写出数量
    const sync = cfg.lastSync;
    const viaSync = {
      card: sync && sync.goods > 0 ? `${sync.goods} 个商品` : '',
      couponItem: sync && sync.coupons > 0 ? `上次抓到 ${sync.coupons} 张券` : '',
      seckillEntry: sync && sync.seckills > 0 ? `${sync.seckills} 个入口` : ''
    };
    const items = (d.items || []).map((it) => {
      if (!it.found && viaSync[it.key]) return Object.assign({}, it, { found: true, sample: viaSync[it.key] });
      return it;
    });
    const groups = [];
    items.forEach((it) => {
      const name = it.group || '其它';
      let bucket = groups.find((x) => x.name === name);
      if (!bucket) { bucket = { name, items: [] }; groups.push(bucket); }
      bucket.items.push(it);
    });
    const good = items.filter((i) => i.found).length;
    return `<div class="detect-sum">共识别 ${good}/${items.length} 项 · 扫描 ${d.frames || 1} 个页面/框架${sync ? ` · 上次准备 ${escapeHtml(sync.at || '')}` : ''}</div>`
      + groups.map((g) => `
      <div class="detect-group">
        <div class="detect-title">${escapeHtml(g.name)}<span>${g.items.filter((i) => i.found).length}/${g.items.length}</span></div>
        ${g.items.map((it) => `
          <div class="goods-row detect-row" title="${escapeAttr(it.found ? String(it.selector || '').replace(/\n/g, ' ｜ ') : (it.sample || '当前页面看不到'))}">
            <span class="goods-idx ${it.found ? 'ok' : 'miss'}">${it.found ? '✓' : '×'}</span>
            <span class="goods-name">${escapeHtml(it.label)}</span>
            <span class="goods-gid">${escapeHtml(it.found ? (it.sample || '已适配') : (it.sample || '当前看不到'))}</span>
          </div>`).join('')}
      </div>`).join('');
  }

  // 分析：最多跑 3 次取命中最多的一次（页面刚加载完常常第一遍扫不全）
  async function runAutoDetect(tries) {
    const n = Math.max(1, Number(tries) || 3);
    let best = null;
    for (let i = 0; i < n; i++) {
      const r = await call('autoDetect', []);
      if (r && r.ok) {
        if (!best || (r.good || 0) > (best.good || 0)) best = r;
        // 正常的中控台一次就能认到 5 项以上；只有页面还没渲染完（命中极少）才值得重扫
        if ((r.good || 0) >= 3) break;
      } else if (!best && i === n - 1) {
        return { ok: false, reason: (r && r.reason) || 'detect-failed' };
      }
      if (i < n - 1) await sleep(900);
    }
    return best || { ok: false, reason: 'detect-failed' };
  }

  // 应用识别结果：只回写真正的选择器键，然后刷新名单
  function applyDetect(r) {
    let applied = 0;
    (r.items || []).forEach((it) => {
      if (!it.found || !it.selector) return;
      if (!(it.key in DEFAULTS.selectors)) return;
      setPath(cfg, 'selectors.' + it.key, it.selector);
      applied++;
    });
    saveConfig();
    lastDetect = r;
    Log.push('ok', `分析完成：${r.good || 0}/${r.total || (r.items || []).length} 项命中，已应用 ${applied} 个选择器`);
    (r.items || []).forEach((it) => Log.push(it.found ? 'ok' : 'warn', `　${it.found ? '✓' : '×'} ${it.label}${it.sample ? '（' + it.sample + '）' : ''}`));
    if ((r.good || 0) < 4) {
      Log.push('warn', '命中偏少：右侧如果不是直播中控台，点「↩ 回中控台后分析」；券/秒杀相关项要先打开对应面板才会出现');
    }
    if (activeTab === 'selectors') renderPanel();
    else { const body = $('#detectBody'); if (body) body.innerHTML = detectHtml(); }
    return applied;
  }

  // 同步全部：结构分析 + 把各板块真正要用的数据抓好（商品 / 优惠券 / 秒杀入口）
  // 这是唯一的「一次性抓全」入口，挂在商品页顶部；
  // 三个零散按钮（商品页 ↻只抓商品、券页 ↻只扫券、秒杀区 ↻只扫入口）只用于单项补抓。
  async function syncAll() {
    const hhmm = () => {
      const d = new Date();
      const p2 = (x) => String(x).padStart(2, '0');
      return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    Log.push('warn', '同步全部开始：识别结构 → 抓商品 → 扫优惠券 → 扫秒杀入口');

    // ① 结构（就地，不跳页）
    const r = await runAutoDetect(3);
    if (r && r.ok) applyDetect(r);

    // ② 商品（各板块的基础，弹讲解/秒杀都依赖它）
    await Goods.refresh('同步全部', { skipEnsure: true });
    const goodsN = (cfg.goods.list || []).length;

    // ③ 秒杀入口（依赖商品卡渲染）
    let seckillN = (SecKill.entries || []).length;
    try {
      await SecKill.scan();
      seckillN = (SecKill.entries || []).length;
    } catch (e) {
      Log.push('warn', '扫秒杀入口失败：' + (e && e.message ? e.message : e));
    }

    // ④ 优惠券（要打开券面板；没券/打不开都不影响其它）
    let couponN = (cfg.coupon.list || []).length;
    try {
      await Coupon.scan();
      couponN = (cfg.coupon.list || []).length;
    } catch (e) {
      Log.push('warn', '扫优惠券失败：' + (e && e.message ? e.message : e));
    }

    cfg.lastSync = {
      at: hhmm(),
      goods: goodsN,
      seckills: seckillN,
      coupons: couponN,
      detectGood: (r && r.good) || 0,
      detectTotal: (r && (r.total || (r.items || []).length)) || 0
    };
    saveConfig();
    Log.push('ok', `同步全部完成：商品 ${goodsN} 个 · 秒杀入口 ${seckillN} 个 · 优惠券 ${couponN} 张 · 结构识别 ${cfg.lastSync.detectGood}/${cfg.lastSync.detectTotal}`);
    if (!goodsN) Log.push('warn', '没抓到商品 —— 确认右侧在中控台、商品已挂上（点「↩ 回中控台后分析」再试一次）');
    else Log.push('info', '现在各板块可以直接用：商品页已列出商品、优惠券页已列出券、秒杀区已列出入口');
    renderPanel();
    return cfg.lastSync;
  }

  function detectReport() {
    const d = lastDetect;
    if (!d) return '还没有识别结果，先点「一键分析」。';
    const lines = [];
    const now = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    lines.push(`巡洋战略舰 识别报告 ${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`);
    lines.push(`页面：${viewUrlSafe() || '（未加载）'}`);
    lines.push(`缩放：${Math.round((Number(cfg.view.zoom) || 1) * 100)}%${favZoomValue() ? `（常用 ${Math.round(favZoomValue() * 100)}%）` : ''}`);
    lines.push(`结果：${d.good || 0}/${d.total || (d.items || []).length} 项 · 扫描 ${d.frames || 1} 个页面/框架`);
    (d.items || []).forEach((it) => {
      lines.push(`${it.found ? '✓' : '×'} [${it.group || '其它'}] ${it.label}` +
        (it.found ? `  ${String(it.selector || '').replace(/\n/g, ' ｜ ')}` : `  —— ${it.sample || ''}`));
    });
    return lines.join('\n');
  }

  const HTML_TAGS = 'a,abbr,article,aside,audio,b,body,br,button,canvas,div,dl,dt,dd,em,fieldset,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,i,iframe,img,input,label,li,main,nav,ol,option,p,pre,s,section,select,small,span,strong,svg,table,tbody,td,textarea,th,thead,tr,u,ul,video'.split(',');

  // 把用户随手写的类名/CSS/文本规则规整成统一写法
  function normalizeSelectorLine(s) {
    let t = String(s || '').trim();
    if (!t) return '';
    const mAttr = t.match(/^class\s*=\s*["']([^"']+)["']$/i);
    if (mAttr) t = 'class=' + mAttr[1];
    if (/^(text|class|css|xpath|id)=/i.test(t)) return t.replace(/^[A-Za-z]+=/, (m) => m.toLowerCase());
    if (t.charAt(0) === '/') return 'xpath=' + t;
    if ('.#[>*:'.indexOf(t.charAt(0)) >= 0) return t;
    if (/^[A-Za-z][\w-]*$/.test(t)) return HTML_TAGS.indexOf(t.toLowerCase()) >= 0 ? t : '.' + t;
    return t;
  }

  function normalizeSelectorText(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach((p) => {
      const n = normalizeSelectorLine(p);
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out.join('\n');
  }

  // 拾取到的元素同时给出多种写法，按稳定性排序，运行时会依次尝试
  function composePickValue(p) {
    const out = [];
    const push = (v) => {
      const s = String(v || '').trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    push(p.attrSelector);
    push(p.textSelector);
    push(p.classSelector);
    push(p.selector);
    return out.slice(0, 4).join('\n');
  }

  async function startPick(key, label) {
    if (!key) { Log.push('warn', '请先指定要绑定的字段'); return; }
    await loadLib();
    pickTarget = key;
    if ($('#pickHint')) $('#pickHint').hidden = false;
    if ($('#pickTargetLabel')) $('#pickTargetLabel').textContent = ` 当前绑定：${label}`;
    if ($('#btnPick')) $('#btnPick').classList.add('on');

    const started = await window.tp.pickStart('main');
    if (!started || !started.ok) {
      Log.push('err', '拾取启动失败：内嵌页面还没加载完成，先等页面加载好再试');
      endPick();
      return;
    }
    Log.push('info', `拾取已开启（覆盖 ${started.frames} 个页面框架），请在右侧页面单击目标元素`);

    clearInterval(pickPollTimer);
    pickPollTimer = setInterval(async () => {
      let st;
      try { st = await window.tp.pickPoll('main'); } catch (e) { return; }

      if (!st || !st.picked) {
        if (st && st.picking === false) endPick();
        return;
      }

      const picked = st.picked;
      const target = pickTarget;
      endPick();
      if (!picked || !picked.selector || !target) return;

      const value = composePickValue(picked);
      setPath(cfg, 'selectors.' + target, value);
      saveConfig();
      Log.push('ok', `已绑定「${label}」`);
      value.split('\n').forEach((line, i) => {
        Log.push('info', `　${i === 0 ? '首选' : '候补' + i}：${line}`);
      });
      renderPanel();
    }, 250);
  }

  function endPick() {
    clearInterval(pickPollTimer);
    pickPollTimer = null;
    pickTarget = null;
    if ($('#pickHint')) $('#pickHint').hidden = true;
    if ($('#btnPick')) $('#btnPick').classList.remove('on');
    window.tp.pickStop('main').catch(() => {});
  }

  async function scanElements() {
    const btn = $('#scanTarget');
    const key = btn ? btn.value : SELECTOR_META[0].key;
    const meta = SELECTOR_META.find((m) => m.key === key);
    Log.push('info', '正在扫描当前页面元素…');
    let r;
    try { r = await window.tp.scan(180, 'main'); } catch (e) { r = { ok: false, reason: String(e.message || e) }; }
    if (!r || !r.ok) {
      lastScan = [];
      lastScanFrames = (r && r.frames) || 0;
      renderScanList();
      Log.push('warn', `没扫到可识别元素（框架数 ${lastScanFrames}）。确认右侧页面已经打开后台并加载完成。`);
      return;
    }
    lastScan = r.items || [];
    lastScanFrames = r.frames || 0;
    renderScanList();
    Log.push('ok', `扫到 ${lastScan.length} 个元素（覆盖 ${lastScanFrames} 个框架），点列表里的项即可绑定到「${meta ? meta.label : key}」`);
    lastScan.slice(0, 8).forEach((it) => Log.push('info', `　<${it.tag}>「${it.text || ''}」class=${(it.cls || '').slice(0, 60)}`));
  }

  function renderScanList() {
    const box = $('#scanList');
    if (!box) return;
    if (!lastScan.length) {
      box.innerHTML = '<div class="empty">点「扫描当前页」列出页面上所有按钮 / 输入框及其 class，点一下就能绑定</div>';
      return;
    }
    box.innerHTML = lastScan.map((it, i) => `
      <button class="scan-item" data-action="bind-scanned" data-idx="${i}">
        <span class="si-tag">${escapeHtml(it.tag)}</span>
        <span class="si-text">${escapeHtml(it.text || (it.field ? '（输入框）' : ''))}</span>
        <span class="si-cls">${escapeHtml((it.cls || '').slice(0, 46))}</span>
      </button>`).join('');
  }

  // ============================================================
  // 8. 界面渲染
  // ============================================================
  let activeTab = 'goods';

  function bindAll() {
    document.querySelectorAll('[data-bind]').forEach((el) => {
      const path = el.dataset.bind;
      const type = el.dataset.type || 'text';
      const cur = getPath(cfg, path);

      // 注意：radio 的 value IDL 属性是 default 模式，el.value = x 会把档位写坏成同一个值，
      // 所以 radio 一律用 data-v 记录自己的档位，只动 checked，不碰 value。
      if (el.type === 'radio') {
        el.checked = String(cur) === String(el.dataset.v != null ? el.dataset.v : el.value);
      } else if (type === 'checkbox') el.checked = !!cur;
      else el.value = cur == null ? '' : cur;

      const isSel = path.indexOf('selectors.') === 0;

      // 选择器输入框随行数自动长高
      const grow = () => {
        if (!isSel || el.tagName !== 'TEXTAREA') return;
        const n = String(el.value || '').split('\n').filter(Boolean).length;
        el.rows = Math.min(4, Math.max(1, n));
      };
      grow();

      // SELECT 只会可靠地触发 change；其余按类型挂 input/change
      const evt = el.tagName === 'SELECT' ? 'change'
        : (type === 'text' || type === 'number' || type === 'range') ? 'input' : 'change';
      el.addEventListener(evt, () => {
        let v;
        if (el.type === 'radio') v = el.dataset.v != null ? Number(el.dataset.v) : el.value;
        else if (type === 'checkbox') v = el.checked;
        else if (type === 'number') v = el.value === '' ? 0 : Number(el.value);
        else v = el.value;
        setPath(cfg, path, v);
        grow();
        saveConfig();
      });

      // 下拉框切换会改变面板里的条件区块（如弹窗模式 → 常驻参数），切完要重渲染
      if (el.tagName === 'SELECT') {
        el.addEventListener('change', () => { saveConfig(); renderPanel(); });
      }

      // 失焦时把随手写的类名规整成标准写法（裸类名自动补点等）
      if (isSel) {
        el.addEventListener('blur', () => {
          const norm = normalizeSelectorText(el.value);
          if (norm !== el.value) {
            el.value = norm;
            setPath(cfg, path, norm);
            saveConfig();
            const key = path.split('.')[1];
            const meta = SELECTOR_META.find((m) => m.key === key);
            Log.push('info', `已规整「${meta ? meta.label : key}」：${norm.replace(/\n/g, ' ／ ')}`);
          }
          grow();
        });
      }
    });
  }

  function activeCommentGroup() {
    return cfg.comment.groups.find((g) => g.id === cfg.comment.activeGroupId) || null;
  }

  function runningBtn(kind, label, obj) {
    const on = !!running[kind];
    // 开始 / 停止各自一个独立按钮，不用一个按钮切换两种状态
    return `<div class="btn-row run-ctl">
      <button class="btn-primary ${on ? 'on' : ''}" data-action="start-${kind}" ${on ? 'disabled' : ''}>▶ 开始${label}</button>
      <button class="btn-danger" data-action="stop-${kind}" ${on ? '' : 'disabled'}>■ 停止</button>
      <span class="run-state ${on ? 'on' : ''}">${on ? '● 运行中' : '○ 未运行'}</span>
    </div>`;
  }

  const RENDER = {
    goods() {
      const g = cfg.goods;
      const list = g.list || [];
      const sel = new Set(cfg.popup.selected || []);
      const rows = list.length
        ? list.map((it) => goodsRowHtml(it, { checked: sel.has(it.i) })).join('')
        : '<div class="empty">还没有商品 —— 点上面的「↻ 只抓商品」或「⚡ 同步全部」</div>';

      return `
        <h3>商品</h3>
        <p class="hint">自动读取本场全部商品；勾选后给「弹讲解」用。</p>

        <div class="section">
          <div class="section-title">当前直播商品（<b>${list.length}</b> 个，已选 <b>${(cfg.popup.selected || []).length}</b>）</div>
          <div class="btn-row">
            <button class="btn-primary" data-action="sync-all">⚡ 同步全部（商品 + 券 + 秒杀入口）</button>
          </div>
          <div class="btn-row" style="margin-top:6px">
            <button class="mini-btn" data-action="fetch-goods" title="只重新抓商品，不动券和秒杀">↻ 只抓商品</button>
            <button class="mini-btn" data-action="goods-all">全选</button>
            <button class="mini-btn" data-action="goods-none">全不选</button>
          </div>
          <div id="syncBody">${syncCard()}</div>
          <div class="goods-list" id="goodsBody">${rows}</div>
          <p class="hint" style="margin:8px 0 0">上次抓取：${escapeHtml(g.pickedAt || '—')}</p>
        </div>

        <div class="section">
          <div class="section-title">自动刷新</div>
          <div class="field">
            <label>定时重新抓取</label>
            <label class="switch-label"><input type="checkbox" data-bind="goods.autoRefresh" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>刷新间隔</label>
            <div class="range"><input type="number" min="20" max="3600" data-bind="goods.refreshSec" data-type="number"><span>秒</span></div>
          </div>
          <p class="hint" style="margin:8px 0 0">上下架/换品会自动同步。</p>
        </div>

        <div class="section">
          <div class="section-title">秒杀投放<button class="mini-btn" data-action="seckill-scan" title="只重扫秒杀入口，不动商品">↻ 只扫入口</button></div>
          <div id="seckillBody"></div>
          <div class="form-block">
            <div class="form-label">投放方式</div>
            <select data-bind="seckill.mode" data-type="text">
              <option value="sched" ${cfg.seckill.mode === 'sched' ? 'selected' : ''}>定时投放（日历选时间）</option>
              <option value="now" ${cfg.seckill.mode !== 'sched' ? 'selected' : ''}>立即投放</option>
            </select>
            <p class="hint">和后台一致：必选，否则不能提交。</p>
          </div>
          ${cfg.seckill.mode === 'sched' ? (() => {
            const p2 = (n) => String(n).padStart(2, '0');
            const d0 = new Date();
            const today = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}`;
            const hours = Array.from({ length: 24 }, (_, i) => p2(i));
            const mins = Array.from({ length: 60 }, (_, i) => p2(i));
            const hmOptions = (cur) => {
              const [ch, cm] = String(cur || '00:00').split(':');
              return hours.map((h) => `<option value="${h}" ${h === ch ? 'selected' : ''}>${h}</option>`).join('')
                + mins.map((m) => `<option value="${m}" ${m === cm ? 'selected' : ''}>${m}</option>`).join('');
            };
            const one = (side, label, dfltDate, dfltH, dfltM) => {
              const curH = String(cfg.seckill[side + 'H'] || dfltH);
              const curM = String(cfg.seckill[side + 'M'] || dfltM);
              return `
              <div class="time-item">
                <span class="ti-label">${label}</span>
                <input type="date" data-bind="seckill.${side}Date" data-type="text" value="${cfg.seckill[side + 'Date'] || dfltDate}">
                <select class="sel-h" data-bind="seckill.${side}H" data-type="text" title="小时 00-23">${hours.map((h) => `<option value="${h}" ${h === curH ? 'selected' : ''}>${h}</option>`).join('')}</select>
                <span class="til">:</span>
                <select class="sel-m" data-bind="seckill.${side}M" data-type="text" title="分钟 00-59">${mins.map((m) => `<option value="${m}" ${m === curM ? 'selected' : ''}>${m}</option>`).join('')}</select>
              </div>`;
            };
            return `
          <div class="form-block">
            <div class="form-label">投放时间</div>
            ${one('start', '开始', today, '00', '00')}
            ${one('end', '结束', today, '23', '59')}
            <div class="btn-row" style="margin-top:8px">
              <button class="mini-btn" data-action="seckill-day" data-offset="0">今天整天</button>
              <button class="mini-btn" data-action="seckill-day" data-offset="1">明天整天</button>
              <button class="mini-btn" data-action="seckill-day" data-offset="2">后天整天</button>
              <button class="mini-btn" data-action="seckill-now">现在起 30 分钟</button>
            </div>
            <p class="hint">默认整天（00:00~23:59）；开始时间需晚于当前。</p>
          </div>`;
          })() : ''}
          ${cfg.seckill.mode === 'sched' ? '' : `
          <div class="form-block">
            <div class="form-label">投放时长</div>
            <div class="chip-group grid">
              ${[10, 30, 60].map((m) => `
              <label class="chip ${Number(cfg.seckill.durationMin) === m ? 'on' : ''}">
                <input type="radio" name="seckill-duration" data-bind="seckill.durationMin" data-type="number" data-v="${m}" value="${m}" ${Number(cfg.seckill.durationMin) === m ? 'checked' : ''}>
                <span>${m} 分钟</span>
              </label>`).join('')}
            </div>
          </div>`}
          <div class="field">
            <label>每次投放库存</label>
            <div class="range"><input type="number" min="1" max="99999" data-bind="seckill.stock" data-type="number"><span>件</span></div>
          </div>
          <div class="field">
            <label>每人限购（0 = 不限）</label>
            <div class="range"><input type="number" min="0" max="999" data-bind="seckill.limit" data-type="number"><span>件</span></div>
          </div>
          <div class="field">
            <label>秒杀前倒计时</label>
            <label class="switch-label"><input type="checkbox" data-bind="seckill.countdown" data-type="checkbox"><span>直播间显示倒计时</span></label>
          </div>
          <div class="btn-row">
            <button class="btn-primary" data-action="seckill-enable">⚡ 一键开启秒杀</button>
            <button class="btn-sm" data-action="seckill-stopall">■ 一键停止秒杀</button>
          </div>
          <p class="hint" style="margin:8px 0 0">点一下直接逐个投放：选方式/时长 → 填库存限购 → 提交；条件不齐自动放弃，全过程在日志留痕。</p>
        </div>

        <div class="section">
          <div class="section-title">剩余自动补充<button class="mini-btn" data-action="seckill-replenish">＋ 立即补充一次</button></div>
          <div class="field">
            <label>自动补充</label>
            <label class="switch-label"><input type="checkbox" data-bind="seckill.monitor" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>扫描间隔</label>
            <div class="range"><input type="number" min="20" max="3600" data-bind="seckill.monitorSec" data-type="number"><span>秒</span></div>
          </div>
          <div class="field">
            <label>剩余低于</label>
            <div class="range"><input type="number" min="1" max="99999" data-bind="seckill.minStock" data-type="number"><span>件时触发</span></div>
          </div>
          <div class="form-block">
            <div class="form-label">每次追加</div>
            <div class="range"><input type="number" min="1" max="99999" data-bind="seckill.addQty" data-type="number"><span>件</span></div>
            <p class="hint">例：原 50 + 追加 30 → 改成 80 再提交。</p>
          </div>
          <p class="hint" style="margin:8px 0 0">剩余低于阈值自动追加；读不到数字只提醒。</p>
        </div>
        ${runningBtn('seckill', '秒杀监控', SecKill)}
      `;
    },

    popup() {
      const p = cfg.popup;
      const k = p.keep || { refreshSec: 6, offMs: 600 };
      const keep = p.mode === 'keep';
      const list = cfg.goods.list || [];
      const sel = new Set(p.selected || []);
      const pick = list.length
        ? list.map((it) => goodsRowHtml(it, { checked: sel.has(it.i), noRight: true })).join('')
        : '<div class="empty">还没抓取商品 —— 先去「商品」页点「⚡ 同步全部」</div>';

      return `
        <h3>定时弹讲解</h3>
        <p class="hint">按节奏轮换讲解勾选的商品，让弹窗一直挂着。</p>

        <div class="section">
          <div class="section-title">选择商品（已选 <b>${(p.selected || []).length}</b> 个）</div>
          <div class="goods-list compact">${pick}</div>
          ${keep ? '<p class="hint" style="margin:8px 0 0">常驻模式只用第一个勾选商品。</p>' : ''}
        </div>

        <div class="section">
          <div class="section-title">弹窗模式</div>
          <div class="field">
            <label>轮换方式</label>
            <select data-bind="popup.mode" data-type="text">
              <option value="seq" ${p.mode === 'seq' ? 'selected' : ''}>顺序循环</option>
              <option value="random" ${p.mode === 'random' ? 'selected' : ''}>每轮随机打乱</option>
              <option value="keep" ${keep ? 'selected' : ''}>一直弹（单卡常驻）</option>
            </select>
          </div>
          ${keep ? `
          <div class="warn-box">
            用户端弹窗几秒后会自动收起。这个模式会定时把卡片<b>取消讲解后立刻恢复</b>，
            让弹窗重新弹出，看起来一直挂着。只锁一张卡。
          </div>
          <div class="field">
            <label>重置间隔</label>
            <div class="range"><input type="number" min="3" max="120" data-bind="popup.keep.refreshSec" data-type="number"><span>秒（用户端弹窗几秒消失就填几秒，建议 5-8）</span></div>
          </div>
          <div class="field">
            <label>取消后停留</label>
            <div class="range"><input type="number" min="150" max="4000" step="50" data-bind="popup.keep.offMs" data-type="number"><span>毫秒（越短越看不出空档，建议 500-800）</span></div>
          </div>
          ` : `
          <div class="field">
            <label>单卡讲解时长</label>
            <div class="range"><input type="number" min="3" max="300" data-bind="popup.showSec" data-type="number"><span>秒</span></div>
          </div>
          <div class="field">
            <label>切换前停留</label>
            <div class="range"><input type="number" min="0" max="120" data-bind="popup.hideSec" data-type="number"><span>秒</span></div>
          </div>
          `}
        </div>

        <div class="section">
          <div class="section-title">范围</div>
          <div class="field">
            <label>${keep ? '重置次数上限' : '循环轮数'}</label>
            <div class="range"><input type="number" min="0" max="9999" data-bind="popup.rounds" data-type="number"><span>${keep ? '次（0 = 无限）' : '轮（0 = 无限）'}</span></div>
          </div>
          <div class="field">
            <label>只在这个时段运行</label>
            <div class="range">
              <input type="time" data-bind="popup.timeFrom" data-type="text">
              <span>~</span>
              <input type="time" data-bind="popup.timeTo" data-type="text">
              <span>留空 = 不限</span>
            </div>
          </div>
        </div>

        <p class="hint">间隔带 ±${Number(cfg.humanize.jitterPct) || 0}% 随机浮动（设置里可调）。</p>
        ${runningBtn('popup', keep ? '常驻弹窗' : '弹讲解', Popup)}
      `;
    },

    comment() {
      const groups = cfg.comment.groups;
      const g = activeCommentGroup();
      const gi = groups.indexOf(g);
      const list = groups.map((x) => {
        const n = (Array.isArray(x.items) ? x.items : []).filter((it) => String(it.text || '').trim()).length;
        return `
        <div class="group-card ${x.id === cfg.comment.activeGroupId ? 'active' : ''}">
          <div class="g-head">
            <div>
              <div class="g-name">${escapeHtml(x.name || '未命名组')}</div>
              <div class="g-meta">${n} 条评论 · 间隔 ${x.intervalMin}-${x.intervalMax}s · 休息 ${x.restMin}min</div>
            </div>
            <div class="g-actions">
              <button class="mini-btn ${x.id === cfg.comment.activeGroupId ? 'on' : ''}" data-action="select-comment-group" data-id="${x.id}">${x.id === cfg.comment.activeGroupId ? '已选' : '编辑'}</button>
              <button class="mini-btn del" data-action="del-comment-group" data-id="${x.id}">删除</button>
            </div>
          </div>
        </div>`;
      }).join('');

      // 每条评论一个独立输入框（勾选 = 发完尝试置顶）
      const items = (g && Array.isArray(g.items)) ? g.items : [];
      const itemRows = items.map((it, i) => `
        <div class="pair-row">
          <span class="pair-idx">${i + 1}</span>
          <input class="pair-a" type="text" maxlength="50" placeholder="评论内容（最长 50 字）"
                 data-bind="comment.groups.${gi}.items.${i}.text" data-type="text" value="${escapeHtml(it.text || '')}">
          <label class="chip ${it.pin ? 'on' : ''}" title="发完这条尝试置顶">
            <input type="checkbox" data-bind="comment.groups.${gi}.items.${i}.pin" data-type="checkbox" ${it.pin ? 'checked' : ''}><span>置顶</span>
          </label>
          <button class="mini-btn del pair-del" data-action="del-comment-item" data-i="${i}" title="删除这条评论">✕</button>
        </div>`).join('');

      return `
        <h3>自动发评</h3>
        <p class="hint">话术放一组，按节奏自动轮发；每条一个输入框。</p>

        <div class="section">
          <div class="section-title">评论组<button class="mini-btn" data-action="new-comment-group">+ 新建组</button></div>
          ${groups.length ? list : '<div class="empty">还没有评论组，点右上角新建</div>'}
        </div>

        ${g ? `
        <div class="section">
          <div class="section-title">编辑「${escapeHtml(g.name || '未命名组')}」</div>
          <div class="field">
            <label>组名称</label>
            <input type="text" style="width:150px" data-bind="comment.groups.${gi}.name" data-type="text">
          </div>
          <div class="field">
            <label>发评顺序</label>
            <select data-bind="comment.groups.${gi}.order" data-type="text">
              <option value="seq" ${g.order === 'seq' ? 'selected' : ''}>顺序</option>
              <option value="random" ${g.order === 'random' ? 'selected' : ''}>随机</option>
            </select>
          </div>
          <div class="field">
            <label>单次轮评时长</label>
            <div class="range"><input type="number" min="1" max="120" data-bind="comment.groups.${gi}.roundMin" data-type="number"><span>分钟</span></div>
          </div>
          <div class="field">
            <label>每条间隔</label>
            <div class="range">
              <input type="number" min="5" max="600" data-bind="comment.groups.${gi}.intervalMin" data-type="number">
              <span>~</span>
              <input type="number" min="5" max="600" data-bind="comment.groups.${gi}.intervalMax" data-type="number">
              <span>秒</span>
            </div>
          </div>
          <div class="field">
            <label>休息时长</label>
            <div class="range"><input type="number" min="1" max="120" data-bind="comment.groups.${gi}.restMin" data-type="number"><span>分钟</span></div>
          </div>
          <div class="field">
            <label>自动置顶</label>
            <label class="switch-label"><input type="checkbox" data-bind="comment.groups.${gi}.pin" data-type="checkbox"><span>勾选「置顶」的评论发完会尝试置顶</span></label>
          </div>
          <div class="field">
            <label>置顶间隔</label>
            <div class="range"><input type="number" min="30" max="99999" data-bind="comment.groups.${gi}.pinSec" data-type="number"><span>秒</span></div>
          </div>
          <div class="field" style="display:block">
            <label style="display:block;margin-bottom:6px">评论列表（${items.length} 条）</label>
            ${itemRows || '<div class="empty">还没有评论，点下面按钮添加</div>'}
            <div style="margin-top:8px">
              <button class="mini-btn" data-action="add-comment-item">+ 添加一条评论</button>
            </div>
          </div>
        </div>` : ''}

        <div class="section">
          <div class="section-title">置顶</div>
          <p class="hint" style="margin:0 0 8px">悬停刚发的那条 → 点浮出的「置顶」。不确定就先自检一次。</p>
          <div class="btn-row">
            <button class="btn-sm" data-action="pin-check">🔎 置顶自检（悬停最后一条）</button>
          </div>
        </div>

        ${runningBtn('comment', '自动发评', Comment)}
      `;
    },

    coupon() {
      const c = cfg.coupon;
      const rows = (c.list || []);
      const sel = new Set(c.selected || []);
      const picked = rows.filter((x) => sel.has(x.name));
      const kindText = (x) => x.kind === 'discount' ? '折扣券' : (x.kind === 'cash' ? '代金券' : '满减券');
      const rowsHtml = rows.length
        ? rows.map((x) => `
          <label class="goods-row">
            <input type="checkbox" data-action="pick-coupon" data-name="${escapeAttr(x.name)}" ${sel.has(x.name) ? 'checked' : ''}>
            <span class="goods-name">${escapeHtml(x.name)}</span>
            <span class="goods-gid">${kindText(x)} · ${escapeHtml(x.value)}${x.avail ? ` · 可用 ${escapeHtml(x.avail)}` : ''}</span>
          </label>`).join('')
        : '<div class="empty">还没扫描 —— 点「↻ 只扫券」读取后台本场可发放的优惠券</div>';

      return `
        <h3>自动发放优惠券</h3>
        <p class="hint">扫描 → 勾券 → 设数量/节奏 → 开始。数量和时长按后台弹窗的档位选。</p>

        <div class="section">
          <div class="section-title">本场优惠券（${rows.length} 张${c.scannedAt ? ' · 扫于 ' + escapeHtml(c.scannedAt) : ''}）
            <span class="title-ops"><button class="mini-btn" data-action="coupon-scan" title="只重扫优惠券，不动商品">↻ 只扫券</button></span>
          </div>
          <div class="goods-list">${rowsHtml}</div>
          <p class="hint" style="margin:6px 0 0">${picked.length ? `已选 ${picked.length} 张，按顺序逐张发` : '不勾选 = 发面板第一张'}</p>
        </div>

        <div class="section">
          <div class="section-title">发放设置</div>

          <div class="form-label" style="margin-top:2px">每次数量</div>
          <div class="chip-group grid">
            ${COUPON_COUNT_OPTIONS.map((o) => `
            <label class="chip ${String(c.count) === String(o.v) ? 'on' : ''}">
              <input type="radio" name="coupon-count" data-bind="coupon.count" data-type="number" data-v="${o.v}" value="${o.v}" ${String(c.count) === String(o.v) ? 'checked' : ''}>
              <span>${o.label}</span>
            </label>`).join('')}
          </div>

          <div class="form-label" style="margin-top:12px">券有效期</div>
          <div class="chip-group grid-4">
            ${[1, 3, 5, 10].map((m) => `
            <label class="chip ${String(Number(c.durationMin)) === String(m) ? 'on' : ''}">
              <input type="radio" name="coupon-duration" data-bind="coupon.durationMin" data-type="number" data-v="${m}" value="${m}" ${String(Number(c.durationMin)) === String(m) ? 'checked' : ''}>
              <span>${m} 分钟</span>
            </label>`).join('')}
          </div>

          <div class="field" style="margin-top:12px">
            <label>次数</label>
            <div class="range"><input type="number" min="0" max="9999" data-bind="coupon.times" data-type="number"><span>次 · 0=不限</span></div>
          </div>
          <div class="field">
            <label>到期后再等</label>
            <div class="range"><input type="number" min="0" max="7200" data-bind="coupon.intervalSec" data-type="number"><span>秒</span></div>
          </div>
          <p class="hint" style="margin:0 0 0 2px">实际间隔 = 有效期 + 这里的秒数（券 1 分钟 + 60 秒 → 每 2 分钟一批）</p>

          <div class="field">
            <label>发送时段</label>
            <div class="range">
              <input type="time" data-bind="coupon.timeFrom" data-type="text">
              <span>~</span>
              <input type="time" data-bind="coupon.timeTo" data-type="text">
              <span>留空=不限</span>
            </div>
          </div>
        </div>

        ${runningBtn('coupon', '发券', Coupon)}
      `;
    },

    // ⑤ 实时数据：抖音侧的大屏 + 单品效果（只读）
    data() {
      const d = cfg.data;
      return `
        <h3>实时数据</h3>
        <p class="hint">直接读抖音直播中控的大屏与单品效果，只读、不点页面，可以和其它功能同时开着。</p>

        <div class="section">
          <div class="section-title">直播大屏
            <button class="mini-btn" data-action="data-refresh">↻ 刷新</button>
          </div>
          <div id="dataBox">${dataBodyHtml()}</div>
        </div>

        <div class="section">
          <div class="section-title">刷新</div>
          <div class="field">
            <label>自动刷新</label>
            <label class="switch-label"><input type="checkbox" data-bind="data.autoRefresh" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>刷新间隔</label>
            <div class="range"><input type="number" min="5" max="600" data-bind="data.refreshSec" data-type="number"><span>秒</span></div>
          </div>
          <p class="hint" style="margin:8px 0 0">口径和抖音后台一致：曝光/点击/成交都是<b>本场累计</b>，讲解换品后会跟着涨。</p>
        </div>

        <div class="section">
          <div class="section-title">接口通道</div>
          <div class="field">
            <label>商品列表走货架接口</label>
            <label class="switch-label"><input type="checkbox" data-bind="api.goods" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>弹讲解走接口（不点画面）</label>
            <label class="switch-label"><input type="checkbox" data-bind="api.switchCard" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>空闲保活（每分钟一次只读请求）</label>
            <label class="switch-label"><input type="checkbox" data-bind="api.keepAlive" data-type="checkbox"><span>开启</span></label>
          </div>
          <div class="field">
            <label>官方抽屉打开时让位</label>
            <label class="switch-label"><input type="checkbox" data-bind="api.drawerYield" data-type="checkbox"><span>开启</span></label>
          </div>
          <p class="hint" style="margin:8px 0 0">前三项关掉就回到原来的「点页面」通道（更慢，但绝对按画面走）。<br>最后一项最多让位 15 秒就会放行；连续误判 3 次会自动关闭，日志里会写明。</p>
        </div>
      `;
    },

    selectors() {
      const url = viewUrlSafe().replace(/^https?:\/\//, '') || '（还没加载）';
      const zoom = Math.round((Number(cfg.view.zoom) || 1) * 100);
      const runningNames = Object.keys(running).filter((k) => running[k]);
      const d = lastDetect;
      const stat = d ? `${d.good || 0}/${d.total || (d.items || []).length} 项 · 扫了 ${d.frames || 1} 个页面/框架` : '还没分析';
      return `
        <h3>高级 · 自动适配与诊断</h3>
        <p class="hint">自动适配选择器 + 诊断问题，就地执行不跳页。</p>

        <div class="section">
          <div class="section-title">当前状态</div>
          <div class="kv-row"><span>页面</span><b>${escapeHtml(url)}</b></div>
          <div class="kv-row"><span>缩放</span><b>${zoom}%${favZoomValue() ? ` · 常用 ${Math.round(favZoomValue() * 100)}%` : ''}</b></div>
          <div class="kv-row"><span>运行中</span><b>${runningNames.length ? runningNames.map((k) => (RUN_TASKS.find((t) => t.key === k) || {}).name || k).join('、') : '无'}</b></div>
          <div class="kv-row"><span>上次识别</span><b>${escapeHtml(stat)}</b></div>
        </div>

        <div class="section">
          <div class="section-title">结构分析<em>只认页面结构，不抓数据</em></div>
          <div class="btn-row">
            <button class="btn-primary" data-action="auto-detect">🔍 只分析结构</button>
          </div>
          <p class="hint" style="margin:8px 0 0">抓数据统一在「商品」页点「⚡ 同步全部」，这里只做诊断。</p>
        </div>

        <div class="section">
          <div class="section-title">自动适配</div>
          <div class="btn-row">
            <button class="btn-sm" data-action="detect-home">↩ 回中控台后分析</button>
          </div>
          <div class="btn-row" style="margin-top:6px">
            <button class="btn-sm" data-action="detect-open-coupon">开券面板再分析</button>
            <button class="btn-sm" data-action="detect-open-seckill">开秒杀抽屉再分析</button>
          </div>
          <p class="hint" style="margin:6px 0 0">券表格/弹窗/秒杀抽屉只有打开时才存在，平时显示 × 正常。</p>
          <div id="detectBody" style="margin-top:10px">${detectHtml()}</div>
        </div>

        <div class="section">
          <div class="section-title">识别报告</div>
          <div class="btn-row">
            <button class="btn-sm" data-action="detect-copy">复制报告</button>
            <button class="btn-sm" data-action="detect-export">把报告写进日志</button>
          </div>
          <p class="hint" style="margin:6px 0 0">含命中项与页面地址，出问题时复制给我。</p>
        </div>

        <div class="section">
          <div class="section-title">诊断</div>
          <div class="btn-row">
            <button class="btn-sm" data-action="test-all">选择器全部测试</button>
            <button class="btn-sm" data-action="sample-comments">读取公屏样本</button>
            <button class="btn-sm" data-action="diag-frames">检查页面结构</button>
          </div>
          <p class="hint" style="margin:6px 0 0">功能不工作时先跑「选择器全部测试」。</p>
        </div>
      `;
    },

    settings() {
      const h = cfg.humanize;
      return `
        <h3>设置</h3>
        <p class="hint">打字速度与动作间隔；太快易触发风控，建议先用默认值。</p>

        <div class="section">
          <div class="section-title">防封控制</div>
          <div class="field">
            <label>总开关</label>
            <label class="switch-label"><input type="checkbox" data-bind="humanize.enabled" data-type="checkbox"><span>开</span></label>
          </div>
          <div class="field">
            <label>间隔随机浮动</label>
            <div class="range"><span>±</span><input type="number" min="0" max="80" data-bind="humanize.jitterPct" data-type="number"><span>%（越大越像真人，也越慢）</span></div>
          </div>
          <div class="field">
            <label>单字输入间隔</label>
            <div class="range">
              <input type="number" min="20" max="400" data-bind="humanize.typeMin" data-type="number">
              <span>~</span>
              <input type="number" min="40" max="600" data-bind="humanize.typeMax" data-type="number">
              <span>毫秒</span>
            </div>
          </div>
          <div class="field">
            <label>动作最小间隔</label>
            <div class="range"><input type="number" min="0" max="5000" data-bind="humanize.actionFloorMs" data-type="number"><span>毫秒</span></div>
          </div>
          <div class="field">
            <label>长停顿概率</label>
            <div class="range"><input type="number" min="0" max="50" step="1" data-bind="humanize.longPauseChance" data-type="number"><span>（模拟走神，会随机停 1.5~4.5 秒）</span></div>
          </div>
          <p class="hint" style="margin:8px 0 0">所有功能的间隔都经过这里，不会形成固定节奏。</p>
        </div>

        <div class="section">
          <div class="section-title">运行模式</div>
          <div class="field">
            <label>试运行（不真点，只记日志）</label>
            <label class="switch-label"><input type="checkbox" data-bind="dryRun" data-type="checkbox"><span>开启</span></label>
          </div>
          <p class="hint" style="margin:8px 0 0">校准时强烈建议先开试运行，确认日志里的动作都对，再关掉。</p>
        </div>

        <div class="section">
          <div class="section-title">运行位置<em>自动任务在哪个页面里操作</em></div>
          <div class="field">
            <label>在哪里执行</label>
            <select data-bind="engine.mode" data-type="text">
              <option value="background" ${(cfg.engine && cfg.engine.mode !== 'current') ? 'selected' : ''}>后台页（推荐：主界面完全不动）</option>
              <option value="current" ${(cfg.engine && cfg.engine.mode === 'current') ? 'selected' : ''}>当前页面（旧模式：会占用画面）</option>
            </select>
          </div>
          <div class="btn-row" style="margin-top:6px">
            <button class="btn-sm" data-action="worker-reload">↻ 重建后台页</button>
          </div>
          <p class="hint" style="margin:8px 0 0">后台页是看不见的第二页面（同登录态），所有自动化在里面跑，你在主界面怎么操作都不受影响。</p>
        </div>

        <div class="section">
          <div class="section-title">多任务并行<em>几个功能一起开时，谁先动页面</em></div>
          <div class="field">
            <label>真人在操作时自动让位</label>
            <label class="switch-label"><input type="checkbox" data-bind="sched.humanYield" data-type="checkbox"><span>开</span></label>
          </div>
          <div class="field">
            <label>让位时长</label>
            <div class="range"><input type="number" min="0" max="30" data-bind="sched.humanYieldSec" data-type="number"><span>秒（你一停手，机器人过这么久才继续）</span></div>
          </div>
          <div class="field">
            <label>任务间空档</label>
            <div class="range"><input type="number" min="120" max="3000" step="20" data-bind="sched.stepYieldMs" data-type="number"><span>毫秒（每个动作之间让出来给别的功能）</span></div>
          </div>
          <p class="hint" style="margin:8px 0 0">同一时刻只有一个功能动页面，其余排队；你一操作机器人就让位。</p>
        </div>

        <div class="section">
          <div class="section-title">数据<em>交接 / 换机前清一遍</em></div>
          <div class="btn-row">
            <button class="btn-sm" data-action="open-data">数据文件位置</button>
            <button class="btn-sm" data-action="clear-data">清空业务数据</button>
            <button class="btn-sm" data-action="reset-config">恢复全部默认</button>
          </div>
          <p class="hint" style="margin:8px 0 0">
            <b>清空业务数据</b>：商品、券、秒杀卡、评论话术、累计次数、账号标识 —— 全部清掉，
            但保留选择器与调度设置（换机后不用重新拾取）。新机装完抓一次商品即可。
          </p>
        </div>

        <div class="section">
          <div class="section-title">内存<button class="mini-btn" data-action="mem-refresh">↻ 刷新</button></div>
          <div id="memBody">${memHint()}</div>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn-sm" data-action="mem-clean">清理内存缓存</button>
            <button class="btn-sm" data-action="mem-rebuild">重建后台页</button>
          </div>
          <p class="hint" style="margin:8px 0 0">
            界面 + 后台页各是一整个抖音直播间（视频 + 弹幕/礼物长连接 + 页面缓存），
            加起来 1GB 上下是正常的。长时间跑会慢慢涨：
            <b>清理内存缓存</b>只清日志与扫描结果，不动直播间；
            <b>重建后台页</b>回收最多，但会中断正在跑的动作。
          </p>
        </div>

        <div class="section">
          <div class="section-title" style="color:#b13a34">风险提示</div>
          <p class="hint" style="margin:0;color:#8a4b46">本工具通过模拟网页操作实现自动化，平台规则不鼓励，存在限流/受限/处罚风险。建议间隔不要压太低、不要长时间高频发评。风险自负。</p>
        </div>
      `;
    }
  };

  // 内存面板（设置页）：按进程列出来，谁吃得多一眼看到
  function memHint() {
    return '<div class="empty">点「↻ 刷新」读取当前占用</div>';
  }

  async function paintMem() {
    const box = document.getElementById('memBody');
    if (!box) return;
    box.innerHTML = '<div class="empty">读取中…</div>';
    let m = null;
    try { m = await window.tp.memInfo(); } catch (e) { m = null; }
    if (!m || !m.ok || !Array.isArray(m.list)) {
      box.innerHTML = '<div class="empty">读不到内存信息：' + escapeHtml((m && m.reason) || '未知') + '</div>';
      return;
    }
    const rows = m.list.slice(0, 8).map((p) => {
      const label = p.name ? p.name : ({ Browser: '浏览器主进程', GPU: 'GPU 进程', Utility: '辅助进程', Renderer: '页面' }[p.type] || p.type || '进程');
      const big = p.mb >= 300 ? ' class="dwarn"' : '';
      return `<div class="kv-row"><span>${escapeHtml(label)}</span><b${big}>${p.mb} MB</b></div>`;
    }).join('');
    box.innerHTML = `<div class="kv-box">${rows}
      <div class="kv-row"><span>合计</span><b>${m.total} MB</b></div>
    </div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function renderPanel() {
    $('#panel').innerHTML = RENDER[activeTab]();
    bindAll();
    if (activeTab === 'goods') paintSeckill();
  }

  // ============================================================
  // 9. 事件绑定
  // ============================================================
  // 秒杀投放时间：每次打开商品页都对齐到「当天」
  // 跨天后还是昨天的时间会让人以为没生效，后台默认也就是当天 00:00 ~ 23:59。
  // 只换日期，不动用户已经设好的时分。
  function syncSeckillDate() {
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    let changed = false;
    if (cfg.seckill.startDate !== today) { cfg.seckill.startDate = today; changed = true; }
    if (cfg.seckill.endDate !== today) { cfg.seckill.endDate = today; changed = true; }
    if (changed) {
      // 旧字段（兼容用）一起清掉，免得又用回上一次的日期
      cfg.seckill.startAt = '';
      cfg.seckill.endAt = '';
      if (!cfg.seckill.startH) cfg.seckill.startH = '00';
      if (!cfg.seckill.startM) cfg.seckill.startM = '00';
      if (!cfg.seckill.endH) cfg.seckill.endH = '23';
      if (!cfg.seckill.endM) cfg.seckill.endM = '59';
      saveConfig();
    }
    return { today: today, changed: changed };
  }

  function initNav() {
    $('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (!btn) return;
      activeTab = btn.dataset.tab;
      if (activeTab === 'goods') {
        const r = syncSeckillDate();
        if (r.changed) Log.push('info', `秒杀投放时间已同步到今天（${r.today}）`);
      }
      // 切到数据页先拉一次，别让人对着空面板等自动刷新
      if (activeTab === 'data') {
        Data.pull().then(() => { if (activeTab === 'data') paintData(); });
      }
      // 切到设置页顺手读一次内存（renderPanel 之后才拿得到 #memBody）
      if (activeTab === 'settings') {
        setTimeout(() => { if (activeTab === 'settings') paintMem(); }, 30);
      }
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      renderPanel();
    });
  }

  function initPanelActions() {
    // 运行位置切换：切到后台页就立刻把它拉起来，切回旧模式要提醒会占用画面
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el || !el.dataset || el.dataset.bind !== 'engine.mode') return;
      if (el.value === 'current') {
        Log.push('warn', '已切到「当前页面」模式：自动化会直接占用你看到的这个中控台');
      } else {
        Log.push('info', '已切到「后台页」模式：正在启动后台页…（主界面不会被占用）');
        Worker.ensure(60000).catch(() => {});
      }
      refreshStatus();
    }, true);

    // 顶部运行栏：每个任务的独立停止按钮
    const runBar = $('#runBar');
    if (runBar) {
      runBar.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="worker-reload"]')) { Worker.restart(); return; }
        const b = e.target.closest('[data-action="runbar-stop"]');
        if (!b) return;
        const t = RUN_TASKS.find((x) => x.key === b.dataset.key);
        if (t) { t.stop(); Log.push('warn', `已停止「${t.name}」`); }
      });
    }

    $('#panel').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'worker-reload') Worker.restart();
      else if (action === 'start-popup') Popup.start();
      else if (action === 'stop-popup') Popup.stop();
      else if (action === 'start-coupon') Coupon.start();
      else if (action === 'stop-coupon') Coupon.stop();

      // ---------- 商品 ----------
      else if (action === 'data-refresh') {
        btn.disabled = true;
        try { await Data.refreshNow(); } finally { btn.disabled = false; }
      } else if (action === 'fetch-goods') {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '抓取中…';
        try { await Goods.refresh('手动'); } finally { btn.disabled = false; btn.textContent = old; }
      } else if (action === 'goods-all') {
        cfg.popup.selected = (cfg.goods.list || []).map((g) => g.i);
        saveConfig(); renderPanel();
      } else if (action === 'goods-none') {
        cfg.popup.selected = [];
        saveConfig(); renderPanel();
      } else if (action === 'pick-goods') {
        const i = Number(btn.dataset.i);
        const set = new Set(cfg.popup.selected || []);
        if (btn.checked) set.add(i); else set.delete(i);
        cfg.popup.selected = Array.from(set).sort((a, b) => a - b);
        saveConfig();
        // 只更新计数，避免整页重绘丢焦点
        const p = btn.closest('.section');
        if (p) {
          const t = p.querySelector('.section-title b');
          if (t) t.textContent = String(cfg.popup.selected.length);
        }
      } else if (action === 'pick-seckill') {
        const i = Number(btn.dataset.i);
        const set = new Set(cfg.seckill.cards || []);
        if (btn.checked) set.add(i); else set.delete(i);
        cfg.seckill.cards = Array.from(set).sort((a, b) => a - b);
        saveConfig();
      } else if (action === 'seckill-scan') {
        const old = btn.textContent;
        btn.textContent = '扫描中…'; btn.disabled = true;
        try { await SecKill.scan(); } finally { btn.disabled = false; btn.textContent = old; }

      // ---------- 优惠券 ----------
      } else if (action === 'coupon-scan') {
        const old = btn.textContent;
        btn.textContent = '扫描中…'; btn.disabled = true;
        try { await Coupon.scan(); } finally { btn.disabled = false; btn.textContent = old; }
      } else if (action === 'pick-coupon') {
        const name = btn.dataset.name;
        const set = new Set(cfg.coupon.selected || []);
        if (btn.checked) set.add(name); else set.delete(name);
        cfg.coupon.selected = Array.from(set);
        saveConfig();

      // ---------- 高级 · 一键适配 ----------
      } else if (action === 'auto-detect') {
        // 就地分析：绝不导航（导航会把用户从当前页面踢走，还会因为页面没渲染完扫不到东西）
        const old = btn.textContent;
        btn.textContent = '分析中…'; btn.disabled = true;
        try {
          const r = await runAutoDetect(3);
          if (!r || !r.ok) {
            Log.push('err', '一键分析失败：' + ((r && r.reason) || '页面还没就绪'));
            const body = $('#detectBody');
            if (body) body.innerHTML = '<div class="empty">分析失败 —— 确认右侧已打开直播中控台，或点「↩ 回中控台后分析」</div>';
            return;
          }
          applyDetect(r);
        } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'sync-all') {
        const old = btn.textContent;
        btn.textContent = '同步中…'; btn.disabled = true;
        try {
          await syncAll();
          const body = $('#syncBody');
          if (body) body.innerHTML = syncCard();
        } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'detect-home') {
        const old = btn.textContent;
        btn.textContent = '回中控台…'; btn.disabled = true;
        try {
          await withPage('一键分析后台', () => ensureHome('一键分析后台'), { prio: 2 });
          const r = await runAutoDetect(3);
          if (r && r.ok) applyDetect(r);
          else Log.push('err', '回到中控台后仍分析失败：' + ((r && r.reason) || '未知'));
        } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'detect-open-coupon') {
        const old = btn.textContent;
        btn.textContent = '开面板…'; btn.disabled = true;
        try {
          const opened = await withPage('开券面板分析', () => Coupon.openPanel(), { prio: 2 });
          if (!opened || !opened.ok) Log.push('warn', '打不开券面板 —— 确认右侧在中控台、且本场已创建优惠券');
          await sleep(900);
          const r = await runAutoDetect(2);
          if (r && r.ok) applyDetect(r);
          await withPage('关券面板', () => closeOverlays(), { prio: 2 });
        } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'detect-open-seckill') {
        const old = btn.textContent;
        btn.textContent = '开抽屉…'; btn.disabled = true;
        try {
          if (!SecKill.entries.length) await SecKill.scan();
          const first = (cfg.seckill.cards || [])[0] || (SecKill.entries[0] && SecKill.entries[0].i);
          if (!first) {
            Log.push('warn', '没识别到秒杀入口 —— 该商品可能还没配秒杀活动（只有配过秒杀的商品才有闪电按钮）');
          } else {
            const got = await SecKill.openForm(first);
            if (!got || !got.ok) Log.push('warn', `打不开 #${first} 的秒杀抽屉（${(got && got.reason) || '未知'}）`);
            await sleep(900);
            const r = await runAutoDetect(2);
            if (r && r.ok) applyDetect(r);
            await SecKill.closeForm();
          }
        } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'detect-copy') {
        const text = detectReport();
        let okCopy = false;
        try { await navigator.clipboard.writeText(text); okCopy = true; } catch (e) {}
        if (!okCopy) {
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            okCopy = true;
          } catch (e) {}
        }
        Log.push(okCopy ? 'ok' : 'warn', okCopy ? '识别报告已复制到剪贴板' : '复制失败（可用右边「把报告写进日志」）');

      } else if (action === 'detect-export') {
        Log.push('info', '===== 识别报告开始 =====');
        detectReport().split('\n').forEach((l) => Log.push('info', l));
        Log.push('info', '===== 识别报告结束 =====');

      } else if (action === 'pin-check') {
        const old = btn.textContent;
        btn.textContent = '自检中…'; btn.disabled = true;
        try { await pinSelfCheck(); } finally { btn.disabled = false; btn.textContent = old; }

      } else if (action === 'seckill-day') {
        // 指定「第 N 天整天」：00:00 ~ 23:59（今天/明天/后天）
        const p2 = (n) => String(n).padStart(2, '0');
        const off = Number(btn.dataset.offset) || 0;
        const d = new Date();
        d.setDate(d.getDate() + off);
        const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        Object.assign(cfg.seckill, { startDate: day, startH: '00', startM: '00', endDate: day, endH: '23', endM: '59' });
        saveConfig();
        renderPanel();
        Log.push('ok', `投放时间已设为 ${day} 00:00 ~ 23:59`);
      } else if (action === 'seckill-now') {
        // 一键设成「现在起 30 分钟」
        const p2 = (n) => String(n).padStart(2, '0');
        const dayOf = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        const st = new Date(Date.now() + 2 * 60000);
        st.setSeconds(0, 0);
        const en = new Date(st.getTime() + 30 * 60000);
        Object.assign(cfg.seckill, {
          startDate: dayOf(st), startH: p2(st.getHours()), startM: p2(st.getMinutes()),
          endDate: dayOf(en), endH: p2(en.getHours()), endM: p2(en.getMinutes())
        });
        saveConfig();
        renderPanel();
        Log.push('ok', `投放时间已设为 ${dayOf(st)} ${p2(st.getHours())}:${p2(st.getMinutes())} ~ ${dayOf(en)} ${p2(en.getHours())}:${p2(en.getMinutes())}`);
      } else if (action === 'seckill-enable') {
        const cards = (cfg.seckill.cards || []).filter((n) => SecKill.entryAt(n));
        if (!cards.length) { Log.push('err', '先「扫描入口」再勾选要投放的商品'); return; }
        // 不弹二次确认：点了就直接干（直播节奏等不起）；全过程在日志里留痕，随时可停
        const old = btn.textContent;
        btn.textContent = '投放中…'; btn.disabled = true;
        try { await SecKill.enableAll(); } finally { btn.disabled = false; btn.textContent = old; }
      } else if (action === 'seckill-stopall') {
        const old = btn.textContent;
        btn.textContent = '停止中…'; btn.disabled = true;
        try { await SecKill.stopAll(); } finally { btn.disabled = false; btn.textContent = old; }
      } else if (action === 'seckill-replenish') {
        const cards = (cfg.seckill.cards || []).filter((n) => SecKill.entryAt(n));
        if (!cards.length) { Log.push('err', '先「扫描入口」再勾选要补充的商品'); return; }
        const add = Math.max(1, Number(cfg.seckill.addQty) || 50);
        const old = btn.textContent;
        btn.textContent = '补充中…'; btn.disabled = true;
        try { await SecKill.replenishNow(); } finally { btn.disabled = false; btn.textContent = old; }
      }
      else if (action === 'start-seckill') SecKill.start();
      else if (action === 'stop-seckill') SecKill.stop();
      else if (action === 'start-comment') Comment.start();
      else if (action === 'stop-comment') Comment.stop();
      else if (action === 'start-welcome') Welcome.start();
      else if (action === 'stop-welcome') Welcome.stop();
      else if (action === 'start-thanks') Thanks.start();
      else if (action === 'stop-thanks') Thanks.stop();

      else if (action === 'new-comment-group') {
        const g = { id: uid(), name: '评论组' + (cfg.comment.groups.length + 1), order: 'seq', roundMin: 2, intervalMin: 5, intervalMax: 9, restMin: 5, pin: false, pinSec: 300, items: [{ id: uid(), text: '', pin: false }] };
        cfg.comment.groups.push(g);
        cfg.comment.activeGroupId = g.id;
        saveConfig(); renderPanel();
      } else if (action === 'add-comment-item') {
        const g = activeCommentGroup();
        if (!g) return;
        if (!Array.isArray(g.items)) g.items = [];
        g.items.push({ id: uid(), text: '', pin: false });
        saveConfig(); renderPanel();
        const rows = document.querySelectorAll('.pair-row .pair-a');
        if (rows.length) rows[rows.length - 1].focus();
      } else if (action === 'del-comment-item') {
        const g = activeCommentGroup();
        if (!g || !Array.isArray(g.items)) return;
        g.items.splice(Number(btn.dataset.i), 1);
        saveConfig(); renderPanel();
      } else if (action === 'del-comment-group') {
        if (!confirm('删除这个评论组？')) return;
        cfg.comment.groups = cfg.comment.groups.filter((x) => x.id !== btn.dataset.id);
        if (cfg.comment.activeGroupId === btn.dataset.id) cfg.comment.activeGroupId = (cfg.comment.groups[0] || {}).id || null;
        saveConfig(); renderPanel();
      } else if (action === 'select-comment-group') {
        cfg.comment.activeGroupId = btn.dataset.id;
        saveConfig(); renderPanel();
      }


      else if (action === 'pick') { startPick(btn.dataset.key, btn.dataset.label); }
      else if (action === 'test-sel') {
        const key = btn.dataset.key;
        const label = btn.dataset.label || key;
        const sel = cfg.selectors[key];
        if (!sel) { Log.push('warn', `「${label}」还没绑定`); return; }
        try {
          const r = await call('probe', [sel]);
          if (r && r.found) {
            const more = r.tried > 1 ? `（第 ${r.matchedIndex + 1}/${r.tried} 个候选）` : '';
            Log.push('ok', `${label}：命中 ${r.matched}${more} → <${r.tag}>${r.visible ? '' : '（不可见）'}「${r.text}」`);
            if (r.cls) Log.push('info', `　该元素 class：${r.cls}`);
          } else {
            const list = (r && r.candidates) || normalizeSelectorText(sel).split('\n');
            Log.push('err', `${label}：${list.length} 个候选都没命中 —— ${list.join(' ／ ')}`);
            Log.push('info', '　排查顺序：页面是否已进到中控台 → 用「扫描当前页」看真实 class → 或改成 text=按钮文案');
          }
        } catch (err) { Log.push('err', '测试失败：' + err.message); }
      } else if (action === 'test-all') {
        for (const m of SELECTOR_META) {
          const sel = cfg.selectors[m.key];
          if (!sel) { Log.push('info', `${m.label}：未绑定`); continue; }
          try {
            const r = await call('probe', [sel]);
            if (r && r.found) {
              Log.push('ok', `${m.label}：命中 ${r.matched}${r.tried > 1 ? `（${r.matchedIndex + 1}/${r.tried}）` : ''} →「${r.text}」`);
            } else {
              Log.push('err', `${m.label}：未命中（${r && r.tried ? r.tried : 1} 个候选）`);
            }
          } catch (err) { Log.push('err', `${m.label}：${err.message}`); }
        }
      } else if (action === 'scan-elements') {
        await scanElements();
      } else if (action === 'bind-scanned') {
        const it = lastScan[Number(btn.dataset.idx)];
        const sel = $('#scanTarget');
        const key = sel ? sel.value : '';
        const meta = SELECTOR_META.find((m) => m.key === key);
        if (!it || !key) return;
        const value = normalizeSelectorText((it.candidates && it.candidates.length ? it.candidates : [it.selector]).join('\n'));
        setPath(cfg, 'selectors.' + key, value);
        saveConfig();
        Log.push('ok', `已绑定「${meta ? meta.label : key}」= ${value.replace(/\n/g, ' ／ ')}`);
        Log.push('info', `　元素：<${it.tag}>「${it.text || ''}」class=${(it.cls || '').slice(0, 60)}`);
        renderPanel();
      } else if (action === 'fill-preset') {
        let n = 0;
        for (const k of Object.keys(SELECTOR_PRESET)) {
          if (String(cfg.selectors[k] || '').trim()) continue;
          cfg.selectors[k] = SELECTOR_PRESET[k];
          n++;
        }
        saveConfig();
        renderPanel();
        Log.push(n ? 'ok' : 'info', n ? `已填入 ${n} 个字段的常用候选，请用「全部测试」逐项确认` : '已有内容的字段不会被覆盖，没有可填的');
      } else if (action === 'mem-refresh') {
        paintMem();
      } else if (action === 'mem-clean') {
        // 只清内存里的缓存，不动直播间、不动配置
        const before = Log.lines.length;
        Log.lines.splice(0, Math.max(0, before - 50));
        lastScan = []; lastScanFrames = 0; lastDetect = null;
        Data.snap.cards = {};
        if (SecKill.entries.length) SecKill.entries = SecKill.entries.slice(0, 40);
        Log.push('ok', `已清理内存缓存（日志 ${before} → ${Log.lines.length} 条，扫描结果与单品数据已释放）`);
        Log.render();
        renderPanel();
        paintMem();
      } else if (action === 'mem-rebuild') {
        if (!confirm('重建后台页？\n\n会重新加载中控台，正在跑的动作会被打断（几秒到十几秒）。\n回收内存最多，一般只在跑了几小时、明显变卡时用。')) return;
        Log.push('warn', '手动重建后台页以释放内存');
        try { await Worker.restart(); } catch (e) { Log.push('err', '重建失败：' + ((e && e.message) || e)); }
        setTimeout(paintMem, 4000);
      } else if (action === 'sel-syntax') {
        Log.push('info', '写法：裸类名 abc-1 → .abc-1；class=abc → 类名片段；text=讲解 → 按文案；xpath=//button[2] → XPath；.a > b:nth-of-type(2) → CSS');
        Log.push('info', '多行 = 多个候选，从上到下依次尝试，第一个命中的生效。抖音改版一般只换 class，所以 text= 最稳。');
      } else if (action === 'sample-comments') {
        if (!cfg.selectors.commentItem) { Log.push('err', '请先绑定「单条评论容器」'); return; }
        try {
          const list = await call('readList', [cfg.selectors.commentItem, cfg.selectors.commentText, cfg.selectors.commentUser, 8]);
          Log.push('info', `读到 ${list.length} 条评论`);
          list.forEach((c) => Log.push('info', `　[${c.user || '?'}] ${c.text}`));
          if (!list.length) Log.push('warn', '没读到内容，容器选择器可能不对，或页面还没加载出评论');
        } catch (err) { Log.push('err', '读取失败：' + err.message); }
      } else if (action === 'diag-frames') {
        try {
          const r = await window.tp.frames('main');
          const rw = await window.tp.frames('worker').catch(() => null);
          if (rw && rw.ok && rw.count) {
            Log.push('info', `后台页 frame：${rw.count} 个 —— ` + (rw.frames || []).map((f) => `#${f.index}${f.main ? '(主)' : ''}`).join(' / '));
          }
          Log.push('info', `当前内嵌页面共 ${r.count} 个框架`);
          (r.frames || []).forEach((f) => {
            Log.push('info', `　#${f.index}${f.main ? '（主页面）' : '（iframe）'} ${String(f.url).slice(0, 110)}`);
          });
          if (r.count <= 1) {
            Log.push('warn', '只有 1 个框架：如果拾取不上，说明页面还停在来客首页，需要先点进直播中控台');
          }
        } catch (err) { Log.push('err', '检查失败：' + err.message); }
      } else if (action === 'pick-all-hint') {
        Log.push('info', '用法：点某个字段的「拾取」→ 鼠标到右侧页面 → 目标元素出现蓝框后单击 → 自动回填');
      } else if (action === 'open-data') {
        const p = await window.tp.configPath();
        Log.push('info', '数据文件：' + p);
      } else if (action === 'clear-data') {
        if (!confirm('清空商品、券、秒杀卡、评论话术和累计次数？\n\n选择器和调度设置会保留，换机后不用重新拾取。')) return;
        const keep = {
          selectors: deepClone(cfg.selectors),
          engine: deepClone(cfg.engine),
          sched: deepClone(cfg.sched),
          humanize: deepClone(cfg.humanize),
          api: deepClone(cfg.api)
        };
        // 回代码里的默认值，再把「结构性配置」装回去 —— 等价于出厂配置
        const fresh = deepClone(DEFAULTS);
        fresh.selectors = keep.selectors;
        fresh.engine = keep.engine;
        fresh.sched = keep.sched;
        fresh.humanize = keep.humanize;
        fresh.api = keep.api;
        cfg = fresh;
        saveConfig();
        // 把还在跑的自动刷新按新开关重挂一遍
        Goods.startAuto();
        Data.startAuto();
        KeepAlive.start();
        renderPanel();
        Stats.render();
        paintGoods();
        Log.push('warn', '已清空业务数据（商品/券/秒杀卡/评论/统计），选择器与调度保留 —— 请重新点「⚡ 同步全部」');
      } else if (action === 'reset-config') {
        if (!confirm('恢复全部默认？\n\n选择器、商品、券、秒杀、评论组、调度设置都会清空，需要重新拾取选择器。\n（只想清业务数据、保留选择器，请用「清空业务数据」）')) return;
        cfg = deepClone(DEFAULTS);
        saveConfig();
        Goods.startAuto();
        Data.startAuto();
        KeepAlive.start();
        renderPanel();
        Stats.render();
        Log.push('warn', '已恢复全部默认配置（选择器需重新拾取）');
      }
    });
  }

  function initBrowser() {
    $('#urlInput').value = cfg.site || '';

    // 下拉框跟当前页面对齐：按「域名」匹配（cfg.site 是 /livesite/live/current 这种深路径，
    // 老逻辑用整串地址比对，永远对不上 → 每次都显示「自定义地址…」）。
    // 匹配不到时优先用上次选过的站点，再不行就默认第一项，绝不再无脑落到「自定义」。
    const syncSiteSelect = () => {
      const sel = $('#siteSelect');
      if (!sel) return;
      const hostOf = (u) => {
        try { return new URL(String(u)).host.toLowerCase(); } catch (e) { return ''; }
      };
      const curUrl = String($('#urlInput').value || cfg.site || '');
      const curHost = hostOf(curUrl);
      const presets = Array.from(sel.options).filter((o) => o.value !== 'custom');
      const hostHit = curHost ? presets.find((o) => hostOf(o.value) === curHost) : null;
      if (hostHit) {
        sel.value = hostHit.value;
        cfg.view.siteKey = hostHit.value;
        return;
      }
      const saved = String(cfg.view.siteKey || '');
      const savedOk = saved && saved !== 'custom' && presets.some((o) => o.value === saved);
      sel.value = savedOk ? saved : (presets[0] ? presets[0].value : '');
    };
    syncSiteSelect();
    // 最近一次选过的快捷站点落盘，下次进来直接用它
    if (cfg.view.siteKey) saveConfig();

    const go = () => {
      let url = $('#urlInput').value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      cfg.site = url;
      saveConfig();
      markMainNav();
      try { view.loadURL(url); } catch (e) { Log.push('warn', '页面还没准备好，稍后重试：' + (e.message || e)); }
      syncSiteSelect();
    };
    $('#btnGo').addEventListener('click', go);
    $('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

    $('#siteSelect').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'custom') { $('#urlInput').focus(); return; }
      cfg.view.siteKey = v;          // 记住上一次选的站点
      $('#urlInput').value = v;
      go();
    });

    $('#btnBack').addEventListener('click', () => { markMainNav(); try { view.goBack(); } catch (e) {} });
    $('#btnReload').addEventListener('click', () => { markMainNav(); try { view.reload(); } catch (e) {} });
    $('#btnDevTools').addEventListener('click', () => { try { view.openDevTools(); } catch (e) {} });
    // 手动绑定已下线（一键适配替代），工具条不再放「拾取」入口

    // 主控 webview 事件（自动化固定作用于这一栏）
    hookView(view, { primary: true, titleEl: $('#colTitle0') });

  }

  // 主视图事件：标题、导航日志、缩放恢复（分栏功能已下线，只剩主控这一栏）
  function hookView(wv, opts) {
    const setTitle = (t) => {
      if (opts.titleEl) opts.titleEl.textContent = t || '未加载';
      if (opts.primary) $('#pageTitle').textContent = t || '未加载';
    };
    wv.addEventListener('dom-ready', async () => {
      if (opts.primary) await loadLib();
      // 每次页面就绪后恢复缩放状态（有些页面加载会重置 zoom）
      try { wv.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cfg.view.zoom) || 1))); } catch (e) {}
      if (opts.primary) applyZoomLabel();
    });
    // 缩放守卫：页面加载完/跳转完再补一次。Chromium 在导航结束时常把 zoom 冲回 100%，
    // 只靠 dom-ready 一次不够，这里在 did-finish-load / did-navigate 各补一次，
    // 保证用户设的比例（如 70%）不会因为任何刷新/跳转被冲掉。
    if (opts.primary) {
      const reapplyZoom = () => {
        const want = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cfg.view.zoom) || 1));
        try {
          if (Math.abs(Number(wv.getZoomFactor()) - want) > 0.005) wv.setZoomFactor(want);
        } catch (e) {}
        applyZoomLabel();
      };
      wv.addEventListener('did-finish-load', () => setTimeout(reapplyZoom, 260));
      wv.addEventListener('did-navigate', () => setTimeout(reapplyZoom, 400));
    }
    if (opts.primary) {
      wv.addEventListener('did-navigate', (e) => {
        Log.push('info', '页面已跳转到：' + String(e.url || '').slice(0, 90));
      });
      wv.addEventListener('did-navigate-in-page', (e) => {
        if (e.isMainFrame) Log.push('info', '页面内跳转：' + String(e.url || '').slice(0, 90));
      });
    }
    wv.addEventListener('page-title-updated', (e) => {
      setTitle(e.title);
    });
    wv.addEventListener('did-start-loading', () => {
      if (opts.primary) $('#pageTitle').textContent = '加载中…';
      else if (opts.titleEl) opts.titleEl.textContent = '加载中…';
      // 守卫：主界面被重新加载，但不是用户点的 —— 说明有代码（或页面自身）在动用户正看的画面。
      // 记一条带上下文的日志，下次「后台刷新带动前台」就能立刻定位是谁干的。
      if (opts.primary && bootAt && Date.now() - bootAt > 5000 && Date.now() > mainNavOkAt) {
        const now = Date.now();
        if (!hookView._lastGuardLog || now - hookView._lastGuardLog > 8000) {
          hookView._lastGuardLog = now;
          const busy = Object.keys(running || {}).filter((k) => running[k]).join('、') || '无';
          Log.push('warn',
            `主界面被重新加载（不是用户点的）· 后台页=${Worker.state}${Worker._refreshing ? '(刷新中)' : ''} · 在跑功能=${busy}`,
            'sys');
        }
      }
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) setTitle('加载失败：' + e.errorDescription);
    });
  }

  // ---------- 内嵌页面缩放（手动 ± / 恢复 100% / 按窗口宽度自动适配） ----------
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;

  function applyZoomLabel() {
    const z = zoomFactorOf();
    const lbl = $('#zoomLabel');
    if (lbl) lbl.textContent = Math.round(z * 100) + '%';
    const fit = $('#zoomFit');
    if (fit) {
      const fav = favZoomValue();
      fit.classList.toggle('on', !!fav && Math.abs(z - fav) < 0.01);
      fit.title = fav ? `一键切到常用比例 ${Math.round(fav * 100)}%（再点回到 100%）` : '记住常用比例，一键切换';
    }
  }

  // 「适宽」记住的常用比例：0 表示还没记过，返回一个默认（0.8，中控台 1600 宽在常见窗口里约正好）
  function favZoomValue() {
    const v = Number(cfg.view && cfg.view.favZoom);
    if (Number.isFinite(v) && v > 0) return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
    return 0;
  }

  function setZoom(z, keepFav) {
    const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    cfg.view.zoom = nz;
    // 手动调缩放（± 或点百分比）时，把「非 100%」的当前值记成常用比例，
    // 这样「适宽」按钮下次一键就能切回它。
    if (keepFav && Math.abs(nz - 1) > 0.005) cfg.view.favZoom = nz;
    // 只缩放主视图。后台工作页必须固定 1.0 —— 缩放会让它的坐标空间和命中测试一起错位
    [view].forEach((wv) => {
      try { wv.setZoomFactor(nz); } catch (e) {}
    });
    saveConfig();
    applyZoomLabel();
  }

  // 自动化的兜底用：目标在视口外时，强制把主界面缩到「能看全页面」。
  // 与「适宽」按钮无关（那个是 toggle 常用比例），这里只做单向缩小，不打扰用户的常用比例记忆。
  //
  // 重要：只允许缩「正在干活的页面」。
  //   后台模式下的目标是后台页（固定 1.0、1600×1200 真实视口），一旦去缩主界面，
  //   用户看到的就是「后台一干活，我正看着的画面突然重排/像被刷了一下」——
  //   而且 setZoom 会把值写进配置，下次启动也跟着变。所以后台模式下直接拒绝。
  async function fitToWidth(silent) {
    if (PAGE.onWorker()) {
      if (!silent) Log.push('warn', '后台页固定 1.0 不缩放（避免动到主界面），改为滚动定位', 'sys');
      return;
    }
    try {
      const dim = await view.executeJavaScript(
        '({ w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) })',
        true
      );
      const box = view.getBoundingClientRect();
      const w = (dim && dim.w) || 1600;
      const bw = (box && box.width) || 0;
      if (!bw || !w) return;
      const z = Math.min(1, Math.max(ZOOM_MIN, Math.round((bw / w) * 100) / 100));
      setZoom(z, false);
    } catch (e) {
      if (!silent) Log.push('warn', '自动缩到能看全失败：' + (e.message || e));
    }
  }

  // 「适宽」：一键在「常用比例」和「100%」之间切换。
  // 没记过常用比例时，第一次点按当前窗口宽度估一个（取一个能看全中控台的合理值），
  // 之后用户手动 ± 调过的值会被记住，成为新的常用比例。
  async function fitZoom(silent) {
    try {
      const cur = zoomFactorOf();
      let fav = favZoomValue();
      if (Math.abs(cur - 1) < 0.005) {
        // 当前是 100% → 切到常用比例（没记过就现算一个）
        if (!fav) {
          const dim = await view.executeJavaScript(
            '({ w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) })',
            true
          );
          const box = view.getBoundingClientRect();
          const w = (dim && dim.w) || 1600;
          const bw = (box && box.width) || 0;
          fav = Math.min(1, Math.max(ZOOM_MIN, Math.round((bw / w) * 100) / 100));
          if (fav <= ZOOM_MIN || fav >= 1) fav = 0.8;
          cfg.view.favZoom = fav;
        }
        setZoom(fav, true);
        if (!silent) Log.push('info', `已切到常用比例 ${Math.round(fav * 100)}%（再点一下回到 100%）`);
      } else {
        // 当前不是 100% → 切回 100%
        setZoom(1, false);
        if (!silent) Log.push('info', '已回到 100%');
      }
    } catch (e) {
      if (!silent) Log.push('warn', '适宽切换失败：' + (e.message || e));
    }
  }

  function initZoom() {
    $('#zoomIn').addEventListener('click', () => setZoom(zoomFactorOf() + 0.1, true));
    $('#zoomOut').addEventListener('click', () => setZoom(zoomFactorOf() - 0.1, true));
    $('#zoomLabel').addEventListener('click', () => setZoom(1, false));
    $('#zoomFit').addEventListener('click', () => fitZoom());

    // 启动时恢复上次的缩放状态
    try { view.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(cfg.view.zoom) || 1))); } catch (e) {}
    applyZoomLabel();
  }

  function initTopbar() {
    $('#dryRun').checked = !!cfg.dryRun;
    $('#dryRun').addEventListener('change', (e) => {
      cfg.dryRun = e.target.checked;
      saveConfig();
      Log.push('warn', cfg.dryRun ? '已开启试运行：只记录动作，不会真正点击' : '已关闭试运行：将真实操作页面');
      if (activeTab === 'settings') renderPanel();
    });

    $('#btnStopAll').addEventListener('click', () => stopAll());

    window.tp.onEmergencyStop(() => {
      stopAll();
      Log.push('warn', '紧急停止（' + ((window.tp && window.tp.stopKeys) || 'Ctrl+Shift+F12') + '）');
    });

    // 页面里的外部协议链接（bitbrowser:// 之类）已在主进程被拦下，不会再弹
    // 「需要使用新应用以打开此链接」的系统窗口。这里只留个痕，方便判断是哪个链接被点到。
    // 同一地址 60 秒内只记一次，避免自动化误点时刷屏。
    let lastBlocked = { url: '', at: 0 };
    if (window.tp.onGuestBlocked) {
      window.tp.onGuestBlocked((info) => {
        const url = (info && info.url) || '';
        const now = Date.now();
        if (url && url === lastBlocked.url && now - lastBlocked.at < 60000) return;
        lastBlocked = { url, at: now };
        Log.push('warn', '已拦下外部协议跳转（不会再弹系统窗口）：' + url, 'sys');
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') stopAll();
    });
  }

  // 日志区高度变化时，同步给右下角浮层（避免遮住日志）
  function syncLogHeight() {
    const w = $('#logwrap');
    if (!w) return;
    const h = w.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--log-h', Math.round(h) + 'px');
  }

  function initLog() {
    $('#btnClearLog').addEventListener('click', () => Log.clear());
    $('#btnExportLog').addEventListener('click', async () => {
      const res = await window.tp.exportLog(Log.text());
      if (res && res.ok) Log.push('ok', '日志已导出：' + res.path, 'sys');
    });
    $('#btnToggleLog').addEventListener('click', () => {
      const w = $('#logwrap');
      w.classList.toggle('collapsed');
      $('#btnToggleLog').textContent = w.classList.contains('collapsed') ? '▴' : '▾';
      syncLogHeight();
    });
    // 分功能页签
    const tabs = $('#logTabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const b = e.target.closest('.log-tab');
        if (b) Log.setTag(b.dataset.tag);
      });
    }
    // 累计统计清零
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action="stats-reset"]');
      if (b) Stats.reset();
    });
    Log.renderTabs();
  }

  // ============================================================
  // 10. 启动
  // ============================================================
  async function boot() {
    await loadConfig();
    initNav();
    initPanelActions();
    initBrowser();
    initTopbar();
    initZoom();
    initLog();
    syncLogHeight();
    renderPanel();

    // 左上角版本号：读 package.json 的 version，一处改动全局生效
    try {
      const v = await window.tp.appVersion();
      const el = $('#appVer');
      if (el && v) el.textContent = 'v' + v;
    } catch (e) {}

    if (cfg.dryRun) $('#dryRun').checked = true;

    syncSeckillDate();
    Stats.render();
    bootAt = Date.now();
    Log.push('info', '巡洋战略舰已启动', 'sys');
    Log.push('info', '默认后台：eos.douyin.com 本地直播专业版');
    // 启动就把后台页备好，点功能时不用等（不阻塞界面）
    if (Worker.enabled() && cfg.engine.prewarm !== false) {
      Worker.ensure(60000).catch(() => {});
    }
    if (cfg.goods.autoRefresh) Goods.startAuto();
    // 实时数据只读、不占页面，启动就开（没开播时自动空转，不会报错）
    if (cfg.data.autoRefresh) Data.startAuto();
    // 保活：长时间挂着不动，抖音会把页面判成不活跃，恢复后要重新加载
    KeepAlive.start();
    refreshStatus();

    try { window.tp.ready(); } catch (e) {}
  }

  // 调度器的只读探针：给自检脚本 / 高级页诊断用（外部不能借它绕过锁）
  window.__debug = {
    PageBus: PageBus,
    withPage: withPage,
    withTask: withTask,
    sched: () => ({
      holder: PageBus.current(),
      waiting: PageBus.waiting(),
      queue: PageBus.queueNames(),
      stats: Object.assign({}, PageBus.stats),
      humanUntil: PageBus.humanUntil,
      trace: PageBus.trace.slice(-200),
      overlap: PageBus.overlap()
    }),
    schedCfg: () => Object.assign({}, cfg.sched || {}),
    // 后台页状态与「在后台页执行任意代码」（自检用）
    worker: () => ({ state: Worker.state, target: PAGE.target(), reason: Worker.reason, url: PAGE.url('worker') }),
    workerEnsure: (ms) => Worker.ensure(ms || 60000),
    workerRun: (code) => window.tp.call(code, 'worker'),
    workerRestart: () => Worker.restart(),
    // 强制走一次「后台页刷新」流程（真机复现「后台刷新会不会带动前台」用）
    workerRefresh: () => Worker._doRefresh(),
    // 两个页面的 webContents id：刷之前刷之后各取一次，就能确认刷的是哪一个
    pageIds: () => ({
      main: (() => { try { return view.getWebContentsId(); } catch (e) { return null; } })(),
      worker: (() => { try { return Worker.el.getWebContentsId(); } catch (e) { return null; } })()
    }),
    pageUrls: () => ({ main: PAGE.url('main'), worker: PAGE.url('worker') }),
    stats: () => Object.assign({}, cfg.stats || {}),
    logTags: () => Log.lines.reduce((m, l) => (m[l.tag] = (m[l.tag] || 0) + 1, m), {}),
    // 真实在跑的功能（压测用来判断「任务有没有自己偷偷退出」）
    runningNow: () => Object.keys(running).filter((k) => running[k]),
    // 只读模块本体（测试要能单独触发一次，验证「抢不到页面不记故障」）
    Data: Data,
    // 测试用：临时开关「官方弹层礼让」
    setDrawerYield: (on) => {
      cfg.api = cfg.api || {};
      cfg.api.drawerYield = !!on;
      return !!cfg.api.drawerYield;
    },
    // 测试用：临时把「弹层礼让上限」调小，验证不会无限等待
    setDrawerYieldMax: (ms) => {
      cfg.sched = cfg.sched || {};
      cfg.sched.drawerYieldMaxMs = Number(ms) || 30000;
      return DRAWER_YIELD_MAX_MS();
    },
    KeepAlive: KeepAlive,
    // 后台页故障计数：quiet 调用不应该让这两个数字变大
    pageFails: () => ({
      task: Worker._taskFails || 0,
      health: Worker._healthFails || 0,
      pending: !!Worker._refreshPending,
      calls: Worker._pageFailCalls || 0
    }),
    // 直接走一次库调用（测试用来对比 quiet / 非 quiet 的记账差异）
    callRaw: (method, args, opts) => call(method, args, undefined, opts || {}),
    // 切换运行位置（测试要能验证「后台模式才有后台页故障判定」这条路径）
    engineMode: (m) => {
      cfg.engine.mode = (m === 'current' ? 'current' : 'background');
      return PAGE.target();
    },
    // 压测取样用：把内存里的日志原样吐出来（含 tag/level），比读 DOM 全
    logLines: () => Log.lines.map((l) => ({ t: l.t, level: l.level, msg: l.msg, tag: l.tag })),
    // 自动化兜底缩放（后台模式下必须拒绝动主界面，测试要能验证这一点）
    fitToWidth: (silent) => fitToWidth(silent),
    mainZoom: () => zoomFactorOf(),
    // 仅供测试/截图：伪造「哪几个功能正在跑」，用来检查运行栏排版
    setRunning: (keys) => {
      for (const k of Object.keys(running)) running[k] = null;
      (keys || []).forEach((k) => { if (k in running) running[k] = { alive: true }; });
      refreshStatus();
      return Object.keys(running).filter((k) => running[k]);
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
