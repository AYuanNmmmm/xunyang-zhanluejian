/* 生成「出厂默认配置」data/config.default.json
 *
 * 背景：data/config.json 是开发机上的真实配置 —— 里面会有测试时抓到的商品、
 * 扫过的券、勾选的秒杀、累计次数，甚至主播 sec_uid。这些东西一旦被打进安装包，
 * 新机装完就顶着一堆别人的数据，得手动清。
 *
 * 所以打包只带这份干净模板：保留「结构性设置」（选择器、调度、接口开关、节奏参数），
 * 清空全部「业务数据」（商品/券/秒杀卡/评论组/统计/账号标识）。
 *
 * 用法：
 *   node scripts/make-default-config.js          # 从 data/config.json 派生
 *   node scripts/make-default-config.js --check  # 只检查模板里有没有残留业务数据
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'config.json');
const OUT = path.join(ROOT, 'data', 'config.default.json');

const pick = (obj, keys) => {
  const out = {};
  keys.forEach((k) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  });
  return out;
};

// 业务数据一律不继承：这些字段必须清
const BUSINESS_PATHS = [
  'goods.list', 'goods.pickedAt',
  'coupon.list', 'coupon.scannedAt', 'coupon.selected', 'coupon.name',
  'popup.selected',
  'seckill.cards', 'seckill.startDate', 'seckill.endDate', 'seckill.startAt', 'seckill.endAt',
  'comment.groups', 'comment.activeGroupId', 'comment.userId',
  'lastSync', 'data.lastAt',
  'view.siteKey'
];

function cleanPolicy(src) {
  const c = src || {};
  const d = {};

  d.version = 5;   // 与 app.js 里的 DEFAULTS.version 保持一致，避免新机被当成旧配置迁移
  d.site = 'https://eos.douyin.com/livesite/live/current';
  // 试运行必须关：留着的话新机装完全部动作都只记录不执行，看着像坏了
  d.dryRun = false;

  // 累计统计：全部归零
  d.stats = { popup: 0, comment: 0, coupon: 0, seckill: 0, refresh: 0, fail: 0, since: '' };

  d.lastSync = null;

  // 只继承「结构性配置」：适配出来的选择器、调度、防封参数、接口开关。
  // 其余数值（库存/份数/时长/间隔）一律回出厂默认 —— 测试时调过的怪值
  // （比如库存设成 1、间隔设成 5 秒）不该跟着包装到别人机器上。
  d.engine = Object.assign({ mode: 'background', prewarm: true, refreshMin: 30, refreshOnIdle: true },
    pick(c.engine, ['mode', 'prewarm', 'refreshMin', 'refreshOnIdle']));
  d.sched = Object.assign({ humanYield: true, humanYieldSec: 3, stepYieldMs: 260 },
    pick(c.sched, ['humanYield', 'humanYieldSec', 'stepYieldMs']));

  d.view = { zoom: 1, fit: false, favZoom: 0, cols: [], siteKey: '' };

  d.humanize = Object.assign({
    enabled: true, jitterPct: 25, typeMin: 55, typeMax: 175, microPauseChance: 0.06,
    actionFloorMs: 900, longPauseChance: 0.08, longPauseMin: 1500, longPauseMax: 4500
  }, pick(c.humanize, ['enabled', 'jitterPct', 'typeMin', 'typeMax', 'microPauseChance',
    'actionFloorMs', 'longPauseChance', 'longPauseMin', 'longPauseMax']));

  // 选择器是「机器适配」的结果，必须保留 —— 新机装完不用重新拾取
  d.selectors = c.selectors || {};

  d.goods = { list: [], pickedAt: '', autoRefresh: true, refreshSec: 90 };

  d.popup = {
    selected: [], mode: 'seq', showSec: 15, hideSec: 4, rounds: 0,
    timeFrom: '', timeTo: '', keep: { refreshSec: 6, offMs: 600 }
  };

  // 评论：连评论内容一起清（那是业务话术，属于用户自己的资产，不该随包发）
  d.comment = { activeGroupId: null, useApi: true, userId: '', groups: [] };

  d.coupon = {
    list: [], scannedAt: '', selected: [], name: '', count: 10,
    durationMin: '1', times: 0, intervalSec: 300, timeFrom: '', timeTo: ''
  };

  d.seckill = {
    cards: [], mode: 'sched', startOffsetMin: 2, durationMin: 30,
    startDate: '', startH: '00', startM: '00', endDate: '', endH: '23', endM: '59',
    startAt: '', endAt: '', stock: 50, limit: 0, countdown: false,
    monitor: false, monitorSec: 60, minStock: 10, addQty: 50, replenishTo: 50
  };

  // 实时数据面板
  d.data = { autoRefresh: true, refreshSec: 10, lastAt: '', hideZero: false };

  // 接口通道开关（新增，旧配置没有就给默认开）
  d.api = Object.assign({ goods: true, switchCard: true, keepAlive: true, drawerYield: true },
    pick(c.api, ['goods', 'switchCard', 'keepAlive', 'drawerYield']));

  return d;
}

// 沿路径取值，用于检查残留
function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function findLeftovers(obj) {
  const bad = [];
  BUSINESS_PATHS.forEach((p) => {
    const v = getPath(obj, p);
    if (v == null) return;
    if (Array.isArray(v) ? v.length > 0 : (typeof v === 'object' ? Object.keys(v).length > 0 : v !== '')) {
      bad.push(`${p} = ${JSON.stringify(v).slice(0, 80)}`);
    }
  });
  const s = obj.stats || {};
  if (['popup', 'comment', 'coupon', 'seckill', 'refresh', 'fail'].some((k) => Number(s[k]) > 0)) {
    bad.push(`stats 不为零：${JSON.stringify(s)}`);
  }
  if (obj.lastSync) bad.push('lastSync 不为空');
  return bad;
}

function main() {
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    if (!fs.existsSync(OUT)) {
      console.error('✗ 缺少 data/config.default.json，先跑一次 node scripts/make-default-config.js');
      process.exit(1);
    }
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const bad = findLeftovers(cur);
    if (bad.length) {
      console.error('✗ 出厂配置里还有业务数据残留：');
      bad.forEach((x) => console.error('   - ' + x));
      process.exit(1);
    }
    console.log('✓ 出厂配置干净（无商品/券/秒杀卡/评论组/统计残留）');
    return;
  }

  if (!fs.existsSync(SRC)) {
    console.error('✗ 找不到 data/config.json');
    process.exit(1);
  }
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const def = cleanPolicy(src);
  const bad = findLeftovers(def);
  if (bad.length) {
    // 白名单写漏了字段就会走到这里 —— 宁可不生成，也别把脏数据打进包
    console.error('✗ 生成结果仍有残留，检查 cleanPolicy 的白名单：');
    bad.forEach((x) => console.error('   - ' + x));
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(def, null, 2) + '\n');
  console.log('✓ 已生成 data/config.default.json（' + fs.statSync(OUT).size + ' 字节）');
  console.log('  保留：选择器 / 调度 / 节奏参数 / 接口开关');
  console.log('  清空：商品 / 券 / 秒杀卡 / 评论组 / 统计 / 账号标识');
}

main();
