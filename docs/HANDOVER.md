# 巡洋战略舰 · 项目交接说明

> 这份文档是给「换一台设备 / 换一个 WorkBuddy 会话继续开发」用的。  
> 只要把这个项目目录（或 `巡洋战略舰-源码.zip`）拿过去，按第三节走一遍就能跑起来。

- 项目名：**巡洋战略舰**（v0.2.2）
- 定位：抖音**本地生活团购直播间**的中控自动化工具，**自用**，不对外售卖
- 技术栈：Electron 44 + 原生 JS（无框架、无构建步骤）+ `<webview>` 内嵌抖音后台
- 开发环境：Windows 11，Node 22.22.2，Python 3.13（仅用于本地测试服务器）
- 代码量：约 2400 行（main/guest/preload + 3 个前端文件）

---

## 一、它到底在做什么

内嵌一个浏览器窗口打开抖音生活服务后台（eos.douyin.com），登录后由程序按设定节律**模拟真人**去点按钮、发评论，实现：

| 模块           | 能力                                                                  |
| ------------ | ------------------------------------------------------------------- |
| ① 弹窗循环       | 团购卡按序号/名称列表循环触发「讲解/弹卡」，显示时长、消失间隔、轮数、随机顺序可配                          |
| ② 自动发评       | 评论组轮发、间隔随机、轮次休息、`[置顶]` 前缀触发置顶                                       |
| ③ 关键词回评      | `关键词1\|关键词2 => 回复内容`，扫描公屏新评论自动回复，支持去重间隔、延迟回复、优先点容器内「回复」按钮否则公屏 `@昵称` |
| ④ 欢迎语 / 成交感谢 | 定时比对观众列表触发欢迎语（`{name}` 占位），监听成交提示条触发感谢语                             |
| ⑤ 选择器系统      | 手填 class / 拾取 / 扫页面元素，三种方式绑定；多候选回退；试运行校验                            |

**核心难点**：抖音后台的 class 是随机哈希且随版本变化，所以**绝不写死选择器**，全部可配置且支持多候选回退。

---

## 二、目录与职责

```
tuanbo-pilot/                 ← 目录名保留旧的，改名只是为了不动 node_modules，可随时重命名
├── start.bat                 双击启动（内含清空 ELECTRON_RUN_AS_NODE）
├── 首次安装.bat              ★新设备用这个：装依赖 + 补二进制 + 启动
├── HANDOVER.md               本文件
├── main.js                   主进程：窗口、全局快捷键、配置读写 IPC、日志导出
├── guest.js                  ★内嵌页面操作层：UA 伪装、弹窗拦截、跨 iframe 注入、拾取、扫描
├── preload.js                contextBridge 安全桥接（window.tp.*）
├── package.json              electron ^44；name=xunyang-zhanluejian
├── src/
│   ├── index.html            界面骨架 + ★注入到网页的自动化库（<script type="text/plain" id="tp-lib">）
│   ├── styles.css            样式（含 .sel-input / .scan-list 等选择器面板样式）
│   └── app.js                ★渲染进程：配置管理、界面渲染、调度引擎、选择器逻辑
├── test/
│   ├── auto-test.js          页面侧冒烟测试（14 项，需本地 http 服务）
│   ├── ui-test.js            界面冒烟测试（9 项，mock IPC，不需要网络）
│   ├── host.html             测试宿主页（内含 webview）
│   ├── fixture.html          模拟来客页面（含 window.open / target=_blank / iframe）
│   ├── inner.html            模拟 iframe 内中控台（含哈希 class 的卡片与按钮）
│   └── popup.html            模拟弹窗目标页
├── data/config.json          ★全部配置（用户资产，换设备时带上它就不用重新绑定选择器）
└── preview-selectors.png     界面截图
```

**关键分层**：页面里跑的逻辑（自动化库）写在 `index.html` 的 `<script type="text/plain" id="tp-lib">` 里，  
由 `guest.js` 用 `executeJavaScript` 注入到每个 frame。**不要把它拆成独立 .js 再用字符串拼接**——当初用  
`type="text/plain"` 就是为了躲开转义地狱。

---

## 三、换设备怎么恢复（重要）

**最省事：双击 `首次安装.bat`。** 它会自动检查 Node、装依赖（走国内镜像）、补下 Electron 二进制、然后启动。  
下面是不用脚本时的手工流程，出问题时对照排查。

```bash
# 1. 装依赖（务必指定镜像，否则 electron 二进制下载会卡死）
npm install --no-audit --no-fund
# 若 electron 二进制没下来（node_modules/electron/dist 不存在）：
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# 2. 启动
start.bat
# 或者：env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe .
```

**必须注意的 3 件事**

1. **`ELECTRON_RUN_AS_NODE=1` 会让 `electron .` 退化成 node 执行 main.js**，报 `ipcMain undefined`。  
   这是当前开发机的环境变量污染，`start.bat` 已用 `set ELECTRON_RUN_AS_NODE=` 处理。
2. **electron 的 postinstall 有时不会下载二进制**，需要手动 `install.js`（见上）。
3. **杀进程不能 taskkill 所有 electron.exe**（会连带杀掉 WorkBuddy 自身），要按命令行过滤：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
     Where-Object { $_.CommandLine -like '*tuanbo-pilot*' -and $_.CommandLine -notlike '*test*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```

依赖目录很大（约 380 MB），**不建议跟着代码一起同步**，换设备重新 `npm install` 更快。

### 跨设备怎么带走这个项目

WorkBuddy 的项目目录是**本地文件夹，不会自动同步**；它能跨设备的只有账号内的**资料库**。  
所以换电脑的路径是：**另一台机器登录同一 WorkBuddy 账号 → 资料库 → 下载项目 zip → 解压 → 双击 `首次安装.bat`**。

抖音后台的**登录态存在本机 Electron 的用户数据目录里，不会跟着项目走**，新设备需要重新登录一次抖音。  
`data/config.json` 会跟着项目走，所以选择器绑定不用重新配。

---

## 四、选择器系统（最核心、最容易踩坑的部分）

### 语法

| 写法     | 例子                                       | 行为                                            |
| ------ | ---------------------------------------- | --------------------------------------------- |
| 裸类名    | `live-buy-7Zq`                           | 自动规整为 `.live-buy-7Zq`（用 HTML 标签白名单区分标签名与类名）   |
| 类名精确   | `.a.b`                                   | 直接 querySelector                              |
| 类名片段   | `class=live-buy`                         | 先精确 `.token`，失败退化为 `[class*="live-buy"]` 模糊匹配 |
| 文本     | `text=讲解`                                | 全文本精确 → 退化为包含，取文本最短且可见的元素                     |
| XPath  | `xpath=//button[2]` 或直接 `//div[@id="x"]` | document.evaluate                             |
| 原生 CSS | `.list > button:nth-of-type(3)`          | 支持 `{{n}}`、`{{name}}` 占位符                     |
| 整段属性   | `class="live-btn primary"`               | 自动识别（从 DevTools 复制粘贴友好）                       |

**多候选**：一个字段可写多行（或 `||` 分隔），运行时**从上到下依次尝试，第一个命中的生效**。  
`probe()` 会返回 `matched / matchedIndex / tried`，界面上「测」按钮会把命中第几个候选打到日志。

### 三种绑定方式

1. **手填** —— 没有直播中的房间也能配置，直接粘 class
2. **拾取** —— 页面点元素，一次生成 2~4 种写法（data-e2e/文案/类名/路径）
3. **扫描** —— `guest.js scanAll()` 遍历所有 frame 列出可交互元素及其 class，点一下即绑定

### 硬性约定（改代码前必须知道）

- 页面侧函数**失败时必须返回 `ok:false` 或 `found:false` 或空数组或 0**。  
  `guest.js` 的 `isMiss()` 靠这四种形态判断"这个 frame 没找到"，否则不会下沉到 iframe。  
  早期 bug：`probe()` 返回 `{found:false}` 而 `isMiss` 只判 `ok===false`，导致主框架空结果被当成功、iframe 里的元素永远找不到。
- 拾取/执行一律走 `runInFrames()`，**不要直接对 mainFrame 执行**，来客的中控台常在 iframe 里。
- 选择器输入框必须保持 `<textarea>`（曾是 `<input>`，浏览器会把换行吞掉，多候选直接失效）。

---

## 五、已踩过的坑（按时间）

1. **来客「直播中控」按钮走 `window.open`**，另开原生窗口 → 注入的库不在里面 → 拾取无反应。  
   解决：`guest.js` 用 `setWindowOpenHandler` 拦截，`contents.loadURL(url)` 改为内嵌导航；  
   另有 `did-create-window` 兜底（关子窗口 + 搬地址回来）。
2. **中控台嵌在 iframe 里** → 加了跨 frame 遍历 + 每帧注入。
3. **UA 被识别** → 伪装成 Chrome 138。
4. **`life.douyin.com` 登录后自动跳 `eos.douyin.com/livesite?...`** → 顶部快捷站点已加 eos 入口。
5. **未指定字段时点右上角「拾取」会把结果写进 `selectors.null`** → `startPick()` 拦截空 key，  
   `loadConfig()` 清理 `null/undefined` 键。
6. **ui-test 与正式程序共用 userData** → 缓存目录冲突报错，已用 `app.setPath('userData', test/.ui-test-userdata)` 隔离。
7. Bash 里 `/tmp` 映射到不存在的 `E:\tmp`，临时文件写项目目录内。

---

## 六、配置结构（data/config.json）

```
version / site / dryRun
humanize   { minDelay, maxDelay, microPauseChance, actionFloorMs }   ← 拟人化参数
selectors  { card, cardAction, commentInput, sendButton, pinButton,
             commentItem, commentText, commentUser, replyButton,
             viewerItem, viewerName, orderToast }                     ← 多行字符串
popup      { sequence, order, showSec, hideSec, rounds }
comment    { groups: [{ id, name, items[], ... }], activeGroupId }
reply      { groups: [{ id, name, rules[], ... }], pollSec, maxScan }
welcome    { enabled, template, thanksTemplate, pollSec, thanksPollSec }
```

`{{n}}` = 卡片序号，`{{name}}` = 卡片名称，运行时由 `fillTemplate()` 替换。

---

## 七、安全与合规设计（别删）

- **试运行（dry-run）**：只写日志不真点，用于验证选择器
- **`Ctrl + Shift + F12` 全局急停**，另有「全部停止」和 `Esc`
- **拟人化**：逐字符输入 55~175ms 抖动 + 6% 概率微停顿；动作最小间隔 900ms；弹窗节奏 ±6% 抖动
- **首次扫描只建基线**：回评/欢迎语启动时不会把开播前的历史评论全回一遍
- 这是模拟操作网页后台的第三方工具，**平台规则不鼓励**，有限流/处罚风险，仅自用

---

## 八、待办（下一步可以做）

- [ ] **数据看板 + 场次复盘** —— 在线人数/GMV/券销量/转化率实时看板；复盘可接用户既有的每周票务  
  统计口径（订单 Excel：销量 = 全部订单"购买数量"求和按"下单日期"分组；核销 = 状态为"已核销"的逐张计数）
- [ ] 打包 exe（electron-builder，注意装到 D 盘，别占 C 盘）
- [ ] 一键改价 / 改库存
- [ ] 多直播间集控
- [ ] 扫码枪上品

---

## 九、怎么验证没改坏

```bash
# 页面侧 14 项（需先起本地服务）
python -m http.server 8899 --bind 127.0.0.1 -d test
node_modules\electron\dist\electron.exe test\auto-test.js     # 预期 14 PASS

# 界面侧 9 项（不需要网络和登录）
node_modules\electron\dist\electron.exe test\ui-test.js        # 预期 9 PASS，并生成 preview-selectors.png
```

改任何选择器/注入相关代码，**两套都要跑**。`auto-test.js` 覆盖跨 frame、弹窗拦截、六种选择器写法；  
`ui-test.js` 覆盖界面渲染、类名规整、多行候选、扫描绑定、配置落盘、渲染进程零报错。

---

## 九点五、换到 PC 端继续开发（Windows）

1. 装 Node 20+，在项目根目录执行：
   - `npm install --registry=https://registry.npmmirror.com`
   - `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 然后 `node node_modules/electron/install.js`（electron 的 postinstall 在国内经常不下二进制，要手动补）
2. 启动：`npm start`（或双击 `start.bat` / `首次安装.bat`）。
3. 三套自测（改完必须先跑，全过再交付）：
   - `npx electron test/ui-test.js`（界面，29 项）
   - `npx electron test/auto-test.js`（注入/选择器，42 项）
   - `npx electron test/worker-test.js`（后台页，17 项；**必须开播才有意义**，下播时「抓商品/room_id/评论」会失败，属正常）
4. 铁律（踩过坑，别再犯）：
   - 后台页（worker）只做自动化，**任何时候都不许导航/点击/滚动主界面**（用户正在看的那个）。
   - `PAGE.target()` 在 background 模式下永远返回 worker；起不来就等待重试，不退回 main。
   - 刷新后台页前必须确认没人正在动页面（PageBus 空闲）。
   - tp-lib 不要无条件重复注入（`ensureLib` 已按版本判重），否则 fetch/XHR 会被反复包层导致页面越来越卡。
   - 抖音评论区在隐藏页面会暂停刷新：需要读评论（回评）时要走 main。

## 十、版本记录


| 版本     | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | - | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1   | MVP：四个业务模块 + 拾取器 + 试运行 + 急停                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.2   | 来客弹窗拦截、iframe 支持、改名「巡洋战略舰」；选择器支持手填 class / 多候选 / class= 片段 / XPath；新增扫页面元素                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.2.1 | 顶部快捷站点加 eos.douyin.com；下拉框与当前地址同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.2.2 | 新增 `首次安装.bat` 一键装依赖；目录加 git 版本管理；项目存档到 WorkBuddy 资料库                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.3.0 | **macOS 适配**（Apple Silicon 已验证，23 项测试全过）：新增 `start.command` / `首次安装.command`；应用菜单（⌘C/⌘V 可用）；急停双键 Ctrl/⌘+Shift+F12；打包配置 electron-builder + 应用图标；打包版配置迁到用户数据目录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.3.2 | 回复改独立问答框（content 自动迁移为 pairs，引擎优先 pairs 兜底旧文本）；自动发评回归（补回缺失的 DEFAULTS.comment，之前会渲染报错）；顶栏缩放控件（setZoomFactor，真实点击坐标乘回 zoomFactor）；backgroundThrottling=false + powerSaveBlocker 后台防休眠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.3.3 | 地址栏精简为 2 个团购直播快捷站点 + 自定义（去掉抖店/巨量百应/抖音网页版）；新增**分栏**：browserViews 容器 + 「＋ 分栏」按钮，每栏独立地址/刷新/关闭，最多 4 个，地址持久化在 `cfg.view.cols`；guest.js `attach()` 改为**只绑定第一个 webview 为主控自动化目标**（否则新分栏会抢走 guest 导致自动点击跑错页面）；缩放统一作用于全部分栏                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.4.0 | **直播中真机抓取三件套**：① 评论区稳定 ID `#comment_all_tab_list_container`（`item-name-`/`item-content-` 语义类，输入框是 div 非 textarea `[class*="input-wrap"] [class*="text-input"]`；历史评论不保留，只显示页面打开后新到的，回评引擎基线天然成立）② 优惠券弹窗全流程（数量是预设档位 radio 10/50/100/500/1000 张 + 时长 1/3/5/10 分钟 + 确定发放，非预设数量回退「全部库存」）③ 秒杀模块：卡片闪电按钮 `[class*="seckill-btn-container"]` → 抽屉内容在 iframe `life_marketing/drop-spike`（byted-ui：两个 byted-input-number-input=库存/限购，label 单选 立即/定时，提交在表单合法前 disabled）；tp-lib 新增 seckillScan/seckillForm（iframe 坐标经 absPoint 换算成顶层布局像素，真实点击）/seckillSetNum（setNativeValue+失败回退真实键盘 Backspace+realType）；guest.js 新增 realKey（Esc/Backspace 连按）；DEFAULTS.seckill（cards/stock/limit/countdown/monitor/minStock/replenishTo）；监控「剩余」数量需真实投放一次后核实文案 |   | v0.4.0 | **直播中真机抓取三件套**：① 评论区稳定 ID `#comment_all_tab_list_container`（`item-name-`/`item-content-` 语义类，输入框是 div 非 textarea `[class*="input-wrap"] [class*="text-input"]`；历史评论不保留，只显示页面打开后新到的，回评引擎基线天然成立）② 优惠券弹窗全流程（数量是预设档位 radio 10/50/100/500/1000 张 + 时长 1/3/5/10 分钟 + 确定发放，非预设数量回退「全部库存」）③ 秒杀模块：卡片闪电按钮 `[class*="seckill-btn-container"]` → 抽屉内容在 iframe `life_marketing/drop-spike`（byted-ui：两个 byted-input-number-input=库存/限购，label 单选 立即/定时，提交在表单合法前 disabled）；tp-lib 新增 seckillScan/seckillForm（iframe 坐标经 absPoint 换算成顶层布局像素，真实点击）/seckillSetNum（setNativeValue+失败回退真实键盘 Backspace+realType）；guest.js 新增 realKey（Esc/Backspace 连按）；DEFAULTS.seckill（cards/stock/limit/countdown/monitor/minStock/replenishTo）；监控「剩余」数量需真实投放一次后核实文案 |
| v0.5.0 | 六条反馈一次改齐：①每个功能独立开始/停止按钮+顶部运行栏（runbar-chip）②秒杀补投放时间板块（立即=投放时长 10/30/60 按钮，seckillForm 返回 dur10/30/60/customDur/timeStart/timeEnd；定时=seckillPickRange 点日历选日期+时分列，失败即取消不提交）③评论组改 items 数组（每条一个输入框，content 自动迁移）④回评改真实输入（sendComment @昵称，commentInput 换 textarea[placeholder*="输入评论"]，旧值 v3 迁移强制刷新）⑤优惠券扫列表 couponPanelRows（名称/状态/满减额度/可用库存/类型）+ couponModalState 读弹窗实际档位（禁用档回退全部库存）+ couponRowBtn 按券名定点发放 ⑥高级页=autoDetect 一键分析后台，移除手动绑定/拾取。**关键修复**：v0.4.0 里 iframe 用的 centerOf 覆盖了通用版（locate 依赖 lx/ly 做遮挡检测，被覆盖后 elementFromPoint(undefined) 恒返回"被遮挡"，所有真实点击全灭）；改名 absCenterOf。**bindAll 坑**：radio 的 value IDL 是 default 模式，el.value=x 会改写档位 content attribute，radio 一律走 data-v + checked                                           |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.6.0 | ①**输入注入换 CDP**（guest.debugger + Input.dispatchMouseEvent/dispatchKeyEvent/char），可信事件、不移动系统光标、不抢窗口焦点；CDP 被 DevTools 占用时自动退回 sendInputEvent。②**秒杀定时投放**：默认 sched，UI 改「X 分钟后开始」+「时长」档位（不手输），`seckillPickRange` 在字节范围选择器里选日期格 `.byted-date-item`+时/分/秒列 `.byted-*-select-item`，**点确定后继续在同一面板选结束**（再点结束按钮会重置开始）；提交前自检 submitDisabled。③**视口修复**：中控台 1600 宽固定布局，窄窗口下右侧元素在视口外导致「点了没反应」→ locate/locateIn 返回 out-of-view，realClickAt 自动缩到适宽再点；SecKill.openForm 改为按选择器定位（不用扫描时的旧坐标）+ 坐标点击失败时 **DOM click 兜底**（闪电图标实测只认程序化点击）。④**优惠券弹窗**：页面上有多个 modal 骨架，couponModalState 只认「可见且含 label.radio」的那个（之前读到空弹层→档位全空）。⑤回评不再 @昵称。⑥默认 view.fit=true（配置 version→4 迁移）。⑦新增 test/live-diag.js 真机诊断（DIAG_ONLY=coupon/seckill，只读不提交）。                     |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| v0.7.0 | ①`ensureHome()`：所有引擎/扫描启动前统一回中控台（抓商品/弹讲解/发评/回评/发券/扫券/秒杀扫描·一键开启·一键停止·监控·补充/一键分析）—— 先 probe(#live-card-list,#current-live-room)，不在主界面就 loadURL(cfg.site) 轮询等就绪，再留 2.6s 渲染时间（闪电按钮/评论区异步渲染，早扫会扫空）；closeOverlays 加空转快路径。②秒杀抽屉两种形态（真机）：未投放=投放表单（drop-spike iframe）；已投放=**秒杀详情**（life_marketing/live-detail iframe，文案 活动状态/投放库存 N/秒杀件数 N/投放时间/编辑/停止投放）——新增 `seckillDetail()`（remain=投放库存−秒杀件数）、`seckillFindEl/seckillClickText`；waitForm 同时接受 form/detail，openForm 返回 kind。③剩余补充走真机流程：详情 → 点「编辑」→ 表单里原投放库存 + `seckill.addQty` → 提交；提交禁用则放弃并说明原因。一键开启遇到进行中的商品跳过并提示改用补充；一键停止走详情「停止投放」+二次确认。④高级页「识别名单」分组渲染（商品/评论/优惠券/秒杀，共 20 项，含详情/剩余/编辑/停止/时长/时间），autoDetect 递归扫同源 iframe，只回写 DEFAULTS.selectors 已有键。⑤test/app-engine.js 新增 ENGINE_ONLY=home\|replenish\|frames\|drawer 真机诊断（replenish 实测：详情 投放库存1/已卖0 → 编辑 → 1+50=51，提交可用但未点）。ui 25 + auto 27 = 52 全过。 |
| v0.7.1 | ①高级页重做：`auto-detect` 不再调 ensureHome（上一版会导航回首页把人踢走，且页面没渲染完导致扫空）；`runAutoDetect` 重试（命中<3 才重扫，间隔 900ms）、`applyDetect` 统一回写+刷新、`detectReport` 生成文本报告；面板加「当前状态」卡（URL/缩放/运行中/上次识别）、开券面板/秒杀抽屉后再分析、复制报告/写进日志。②置顶：新增 `guest.realMove`（CDP 只移指针不点击）+ `commentItemEls/commentItemByText/commentItemActions/commentLastItem`；`pinComment()` = 按文本找回刚发的那条 → 悬停 → 点浮出的「置顶」（只认文字恰为置顶的叶子或 pin 类图标，父容器不算）；发评引擎不再依赖空的 `selectors.pinButton`，失败 30 秒后才重试；新增「置顶自检」只读按钮（列 actions/others/icons）。③修误判：评论条目排除 tab（`item-` 也会命中「全部/高选品意向」标签）、`seckillDetail` 必须匹配「投放库存 数字」+ 秒杀详情/秒杀件数，抽屉识别同时接受 drop-spike 表单与 live-detail 详情。④真机验证：就地分析 URL 不变、21 项 7 命中；开券面板后 9 命中；开秒杀抽屉后识别为投放表单且不误报详情。ui 25 + auto 31 = 56 全过。 |
| v0.7.2 | ①**自动置顶**（真机实测通过）：结构 `div.item-* > div.hover-button-* > div.icon-*(第1=图钉置顶 / 第2=气泡回复)`，图标无文字/aria；新增 `guest.realMove`（CDP mouseMoved，只移指针）+ tp-lib `commentItemByText / commentItemEls / commentHoverIcons`；`pinComment()` = 按内容找回刚发那条（重试3次）→ realMove 悬停 → 点第 1 个图标 → 读 toast（命中「置顶审核中…」即成功）。修 `pinSec=0` 被 `0\|\|300` 变成 300 秒。新增「置顶自检」按钮（只悬停，列出图标数与位置）。②**高级页「一键准备」**：`syncAll()` = runAutoDetect + Goods.refresh(skipEnsure) + SecKill.scan + Coupon.scan，写 `cfg.lastSync`；结果卡显示商品/秒杀入口/券数量与时间；`detectHtml` 对已抓到数据的 card/couponItem/seckillEntry 强制标 ✓；ai一键分析不再跳页（v0.7.1 已改）。③实测：一键准备 20s 内 → 商品 5 / 秒杀入口 2 / 券 2，切到商品页 5 行、券页 2 行；自动发评+置顶日志出现「置顶已提交」。ui 27 + auto 33 = 60 全过。 |
| v0.9.0 | **后台工作页**：自动化跑在一个隐藏的第二页面里（`Worker`，1600×1200、opacity .01、固定 1.0 不缩放），同 partition 共享登录态；`PAGE.target()` 统一路由，后台页没好就自动退回主界面。修「webview 无 isDestroyed 导致等待空转」（改用 isConnected）、frame 执行加超时防卡死、券行定位不再依赖抽屉类名。 |
| v0.9.1 | ①**砍掉分栏**（v0.3.3 加的：`MAX_COLS / addColumn / saveCols / restoringCols` 与「＋ 分栏」按钮全删，缩放只作用于主控那一栏）。②**秒杀时间自动同步到当天**：`syncSeckillDate()` 在启动与切到商品页时把 `startDate/endDate` 对齐今天并清掉旧 `startAt/endAt`（只换日期，不动用户设好的时分）。③**接口直发评论**（tp-lib `apiIds/apiComment`）：页面内 fetch 会自动补 `a_bogus`/`msToken`（实测 URL 里两个签名都在），POST `/data/life/live/comment/reply/` 约 300ms 返回 `chat_id`，公屏确认真的出现；`sendComment` 优先走接口，失败才回退页面逐字输入。④**room_id 获取**：中控台轮询走的是 **XHR**，不进 `performance` 资源列表（之前两种取法都落空）→ tp-lib 装载时装 XHR/fetch「听筒」，`sniffMatch` 从页面自己的 URL 上取 `room_id` 与 `sec_uid`。⑤**修适宽失效**：`fitZoom()` 顶上的 `if (PAGE.onWorker()) return` 是给后台页加的守卫，但路由默认就在后台页 → 主界面永远缩不了；删掉（它量的缩的都是 `view`，与后台页无关）。⑥开/停/补充秒杀**去掉 confirm 二次确认**（直播节奏等不起），改为在日志里留痕。⑦新增 `test/live-ops.js`（真机实操 OPS=seckill/coupon/comment/popup/pin/stopseckill，真提交真发放 + 回收界面日志，`untilLog` 按日志关键词等批量任务收尾）、`test/live-say.js`、`test/wide.html`。**真机实测**：后台页就绪 2s → 抓商品 5 个 2s / 扫秒杀入口 2 个 2s（走主界面时要排队 36s）；#4、#5 秒杀真实提交成功并停止成功。ui 30 + auto 42 + worker 13 = 85 全过。 |
| v0.9.2 | ①后台页渲染进程崩溃自动重建（render-process-gone → remove + 1.5s 后 ensure）。②弹讲解失败不再永久退出：连续两轮救不回才停，中间 ensureHome(force) 自救。③发券 finally 兜底 closeOverlays。 |
| v0.9.3 | 「适宽」改成「记住常用比例，一键切换」：新增 cfg.view.favZoom，手动 ± 缩放时记住，按钮在 100% ↔ 常用比例间 toggle；去掉启动自动缩放与 resize 重算；自动化「元素在视口外」的兜底改用独立 fitToWidth()。 |
| v0.9.4 | **自动回复失效真因**：①tp-lib 的 readList 从头读前 N 条，新评论追加在末尾 → 评论超 30 条就读不到，改倒序读最新。②回评读评论走后台页（opacity:0.01 隐藏页评论区暂停刷新）→ 改为显式 target=main。版本号改为读 package.json（main.js app:version + preload + #appVer）。 |
| v0.9.5 | 修「自动刷新把主界面刷了 + 缩放冲回 100% + 功能失效」：刷后台页必须等没人动页面（PageBus）；PAGE.target() 后台模式下只在 failed 才退回 main；PAGE.el(worker) 没建好返回 null 不再偷换主界面；ensureHome/backToHome 遇 null 直接失败等重试；加缩放守卫（dom-ready/did-finish-load/did-navigate 各补一次 setZoomFactor）。 |
| v0.9.6 | ①**tp-lib 每次调用重灌 80KB + 听筒闭包标志每次新建导致 fetch/XHR 被反复包层** → 页面越跑越卡（「跑一阵就全失效」的隐形根因）：guest.ensureLib 按 window.__TP.version 判重、听筒改 window.__TP_SNIFF 幂等。②发券间隔改为「每次发放之间」统一卡。③新增 Worker.noteTaskFailure（功能级失败也刷后台页）。④新增 waitPageReady（页面级失败挂起等待，不退出任务）。⑤日志加「功能 · 第N轮」前缀。 |
| v0.9.7 | ①运行栏去掉换行抖动。②**发券只能成功一次真因**：第二轮起抽屉还开着，再点「优惠券」把它点关 → openPanel 先探 couponPanelRows，已开不再点。③新增 pageState()/forceClean()（弹窗/抽屉/券面板三样都关才算干净，最多清 3 轮）接入 ensureHome 与发券每轮。④发券间隔 = 券有效期 + 到期后等待（1/3/5/10 分钟档，越界取最近档）。⑤刷新触发改用 PageBus 是否被占 + 25s 封顶（原来用 pageBusy 把「任务在跑」算忙，永远等不到）。⑥后台页 45s 自检，连续 2 次无响应自动刷新。 |
| v0.9.8 | ①运行栏整排显示。②降卡顿：renderRunBar 用 rAF 合并、日志 DOM 上限 800→400、自动滚动改 rAF。③**彻底删除自动回复（关键词回评）整块**：导航/面板/引擎/RUN_TASKS/selectors/迁移/action/config 全清，导航重排 ①商品 ②弹讲解 ③自动发评 ④发优惠券 ⑤设置 ⑥高级。④发券面板精简为两段。 |
| v0.9.9 | ①实时运行状态挪到**日志区右下角 168px 窄栏**（圆点+功能名+×），不压直播画面、不占配置面板，日志折叠时隐藏。②各功能区文案全面精简（说明压一行，去掉 em 解释）。③新增 test/shot-runbar.js（伪造任务跑起来截图+量溢出）与 __debug.setRunning()。 |
| v0.10.0 | ①**修「后台刷新把前台也刷了」的真因**：自动化兜底 `fitToWidth()` 在后台模式下会把**主界面**缩到能看全（用户看到的就是画面突然重排/像被刷了一下，且 zoom 会写进配置下次启动还变）→ 后台模式下直接拒绝缩主界面；主界面新增「被非预期加载」守卫（`markMainNav()` 只给用户主动操作放行，其余情况记 warn 日志带后台页状态与在跑功能）；`_doRefresh` 记录目标 webContents id 并校验主界面地址未变。真机验证：`test/live-refresh.js` 8 项全过（后台页加载 +6、主界面加载 0、无导航、webContents 未换）。②**运行日志按功能拆分**：`Log.push(level,msg,tag)` + 文案推断 tag（弹讲解/发评/发券/秒杀/商品/系统），日志区顶部 7 个页签筛选，切页签只画该功能；连续重复行合并 `×N`；屏上上限 400→120 行、内存 800→400。③**累计统计**：`cfg.stats` 持久化弹讲解/发评/发券(张)/秒杀/后台刷新/失败，侧栏渲染，带「清零」。④**「运行中」搬到左栏功能菜单下方**（日志上方），与「累计」一起组成左栏下段。新增 `test/live-ui.js`（16 项真机）、`test/live-refresh.js`、`test/two-page-isolation.js`（验证两个 webview 独立进程、崩溃不互扰）。ui 29 + auto 42 + live-ui 16 + live-refresh 8 全过。⑤**日志区高度压到 4 行**（原 192px≈7 行 → `--log-rows:4` 计算得 137px），改行数只需调 `.logwrap{--log-rows}`，正文顶部留白 2px／底部 8px。 |
| v0.10.1 | ①**并发压测后修掉「一开就互相拖死」**（新增 `test/live-all.js`，真机四功能同开 150 秒）：发评发送失败后仍去「置顶」，而置顶要重试 3 次、每次等 1.3 秒，整段都在页面独占区里 → 一失败就占着页面 20 多秒，把弹讲解/发券/秒杀全堵住（实测最长饿死 28.1 秒）。现在失败即返回、不置顶；连续 3 条发不出去自动暂停 60 秒（下播后不再空转刷屏）。②**发券锁内等券间隔**（默认「券 1 分钟 + 间隔 60 秒」= 120 秒）→ 等待移到独占区外，锁内只做发放；多张券时本轮到点就收工，绝不在锁内等。③**欢迎语/感谢语纳入页面独占**（原来裸调 `sendComment`，观众进房时正好插在发评打字中途，两边抢输入框），并补进「运行中」面板可单独停。④兜底 `closeOverlays()` 从 release 之后移到还锁着时（原来会误关下一个任务刚拉开的抽屉），秒杀监控也补了收尾。⑤「全部停止」现在会一起停掉商品自动刷新（以前定时器还在每 90 秒抓一次，页面仍在被机器人动）。⑥健康检查在有任务占页面时跳过（页面忙时 probe 超时是正常的，误判会刷掉后台页把全部功能一起打断）；自动刷新加 90 秒冷却防「刷新风暴」。⑦日志页签重绘改 rAF 合并（并发时日志成串进来，每条都重算计数会让主线程发涩）。⑧主进程加**单实例锁**：重复双击不再开两个实例抢同一份 config（表现为「设置自己变回去」「评论发两遍」）。⑨恢复 Mac 脚本 `start.command`／`首次安装.command`／`抓取后台结构.command`（此前工作区里被删掉了）。回归：ui 29 + auto 42 全过。 |
| v0.10.2 | ①**修「用着用着弹『需要使用新应用以打开此 bitbrowser 链接』」**：抖音后台页面里带 `bitbrowser://` 这类唤端链接（推广位/协作工具按钮），被点到（自动化误点或手点）后 Electron 会把它交给操作系统，而本机没有注册该协议，Windows 就弹「在 Microsoft Store 中查找应用」。修法：`guest.js` 新增 `guardSchemes()`，在 webview 上同时拦 `will-navigate` / `will-frame-navigate`（子 iframe 不会触发前者）/ `will-redirect`，非 `http(s)/file/about/data/blob/javascript/devtools/chrome*` 一律 `preventDefault`；`main.js` 主窗口加同样守卫（主界面只该停在本地 index.html）；被拦的地址通过 `guest:blocked` → `preload.onGuestBlocked` 回传到界面日志（同一地址 60 秒只记一次，避免误点时刷屏），日志 tag=系统。 ②新增 `test/scheme-guard.js`（8 项）：bitbrowser / bytedance / mailto 全拦、iframe 内也拦、普通链接不误伤、直接 loadURL 未知协议不交给系统。回归：ui 29 + auto 42 + scheme-guard 8 全过。 |
| v0.3.1 | **五模块重构 + 真机打通**：界面精简为 商品/弹讲解/自动回复/优惠券/设置；选择器全部换成真机验证过的稳定值（`#live-card-list` + 序号 XPath、`talking-btn`、评论输入框等，旧哈希类已失效是"功能全用不了"的根因）；点击改走真实鼠标事件（合成事件 isTrusted=false 只触发 hover）；新增**一直弹（单卡常驻）**&#x6A21;式：定时取消讲解→立刻恢复，配合 textIn 状态读取；webview 落地页直连中控台                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |   |        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 十一、macOS 适配说明（v0.3.0）

- **启动**：双击 `首次安装.command`（首次）或 `start.command`（日常）。脚本会自动找 Node（Homebrew / WorkBuddy 托管运行时 / nvm 都认）、清 `ELECTRON_RUN_AS_NODE`、清 Electron.app 的隔离标记（否则报「已损坏」）、后台启动并写 `run.log`。关掉启动终端窗口**不会**带停程序。
- **菜单**：macOS 必须有「编辑」菜单，输入框里 ⌘C/⌘V/⌘A 才能用；main.js 的 `buildMenu()` 管这个，别删。
- **急停**：mac 上 `⌘+Shift+F12` 和 `Ctrl+Shift+F12` 都注册了全局急停。
- **UA**：两端统一伪装 Windows Chrome 138（`guest.js`），保证行为一致；要试原生 UA 用环境变量 `TP_UA` 覆盖。
- **打包**：`bash scripts/build-mac.sh`（或 `npm run dist:mac`），产物在 `release/`（dmg + zip，arm64/x64；未签名，首开需右键 → 打开）。打包版配置存 `~/Library/Application Support/巡洋战略舰/config.json`，首启自动从安装包迁移。
- **图标**：`build/icon.svg` 是源文件；改完后用 `test/render-icon.js` 重新渲染 PNG，再 `sips` + `iconutil` 生成 `icon.icns`。
- **从资料库恢复源码的坑**：资料库页面（kind=web）会把 `data-page-node-id` 属性和 `/page/page_comm/inject.js` 注入进每个 HTML 文件，**直接下载的 index.html 是脏的**。恢复时以 `.git` 里的版本为准：`git checkout -- .` 即可还原干净源码。

---

## 十二、v0.10.3：接口通道 + 实时数据（2026-10-22）

这一版解决两个老问题：**① 看不到抖音侧的真实效果；② 多个功能一起开就抢页面。**

### 12.1 为什么能直接调接口（原理）

在 `src/index.html` 的 `#tp-lib` 里注入的脚本，是通过 `webContents.executeJavaScript` 跑在
**eos.douyin.com 页面自己的上下文**里的。所以：

- `fetch('/data/life/live/...')` 是**同源请求**，自动带 Cookie
- 页面被 secsdk 包过的 `window.fetch` 会自动补 `a_bogus` 签名
- 抖音看到的请求与"用户自己点页面"发出的完全一样，不是伪造

`apiComment`（v0.9 就在用）已经验证过这条路。`/data/life/live/` 下这些接口都是普通 HTTP，
不是长连接——之前注释里写"讲解/发券走长连接抓不到 HTTP"是误判。

### 12.2 新增的接口封装（`__TP` v0.8）

| 方法 | 接口 | 用途 |
| --- | --- | --- |
| `apiRoomStats(roomId)` | `GET /data/life/live/data/live_data/v3/` | 在线/累计观看/涨粉/成交单数/GMV/观看→支付率 |
| `apiCardStats(ids, roomId)` | `GET /data/life/live/component/stats/` | **每个商品的曝光/点击/成交/GMV** |
| `apiShelf(roomId)` | `GET /data/life/live/shelves/anchor/` | 货架全量（card_id/product_id/名称/图片/门店/SKU） |
| `apiSwitchCard(cardId, roomId)` | `POST /data/life/live/card/switch/` | 切讲解 `{card_id, source:7, operation:3, room_id}` |
| `apiLiveStatus()` | `GET /data/life/live/status/` | 心跳 / 顺带当保活 |
| `officialBusy()` | — | 官方抽屉/确认弹窗是否正开着 |

请求体统一走 `apiReq()`：GET 拼 query、POST 发 JSON、`credentials:'include'`，
用 `status_code`（或 `code`）判成败，失败不抛异常只返回 `{ok:false, reason}`。

### 12.3 商品抓取改走货架接口

`Goods.refresh()` 现在分两层：

1. `_refreshApi()` — 先拿 roomId，再 `apiShelf` 一次取全量。**不滚动、不点页面、不占 PageBus**，
   所以「自动刷新商品」不会打断正在跑的弹讲解。
2. `_refreshDom()` — 接口取不到才回退滚动 DOM（老路子，必须独占页面）。

`_apply()` 是两条通道共用的落库逻辑，并新增 `cardId`/`img`/`shop`/`sku` 字段（`cardId` 给弹讲解用）。

### 12.4 弹讲解走接口（并发痛点的主因）

原来弹讲解必须 `clickInReal()` 点商品卡 —— 要点就得独占页面，所以发评/发券只能排队。
现在：

```js
let res = (cfg.api.switchCard && apiFails < 5) ? await explainByApi(n) : null;
if (!res || !res.ok) { /* 回退：照旧点卡片 */ }
```

- `explainByApi(n)`：从 `cfg.goods.list` 找第 n 个的 `cardId` → `POST card/switch`。
  没有 cardId（老配置/没抓过货架）直接返回 `null` → 回退 DOM。
- 连续失败 5 次自动熔断，本次运行不再试接口，避免每次都多等一个请求。
- 日志会写一行「弹讲解走接口通道」，方便确认走的是哪条路。

**常驻弹窗（runKeep）仍走 DOM**：它靠读按钮文案（讲解/取消讲解）判断状态再切换，
接口没有"读当前状态"的能力，改了反而不可靠。

### 12.5 实时数据面板（第 ⑤ 页）

`Data` 模块每 10 秒（可调 5~600）拉一次：

- 大屏 6 格：在线 / 累计观看 / 新增粉丝 / 成交单数 / GMV / 观看→支付
- 单品表：曝光、点击、点击率、成交（附"点→成"转化）、GMV

只读、不占 PageBus，所以可以和所有功能同时开。没开播时只显示一行提示，不报错。
表格只重绘 `#dataBox`，且输入框聚焦时跳过重绘（`editingField()`），不打断打字。

### 12.6 保活 + 抽屉礼让

- **保活** `KeepAlive`：每分钟一次 `apiLiveStatus`，仅在「没有任何任务在跑」时发。
  比切 tab / 点按钮温和得多（光圈智播是每 4 分钟切一次页面 tab），不碰 DOM。
- **抽屉礼让**：`PageBus.pump()` 在授予页面之前先问 `officialBusy()`，
  官方抽屉/确认框开着就等 2 秒再看（日志 8 秒去重）。
  以前那种时候点击全落在遮罩上，表现为"动作成功但没效果"。

### 12.7 出厂配置：新机不带测试数据 ⚠️

**问题**：`data/config.json` 是开发机上的真实配置，含测试抓到的 6 个商品、扫过的券、
勾选的秒杀卡、评论话术、累计次数，甚至主播 `sec_uid`。原 `build.files` 直接把它打进安装包，
新机装完顶着一堆别人的数据。

**现在**：

| 文件 | 作用 | 是否入包 |
| --- | --- | --- |
| `data/config.json` | 开发机当前配置（含测试数据，已 gitignore） | ❌ |
| `data/config.default.json` | 出厂干净模板（脚本生成） | ✅ |

- `scripts/make-default-config.js` 生成模板：**保留** selectors / engine / sched / humanize / api，
  **清空** 商品、券、秒杀卡、评论组、统计、`comment.userId`、`lastSync`，数值类参数一律回默认
  （防止"库存设成 1"这类测试痕迹跟到别人机器上）。
- 脚本自带 `--check`：沿 `BUSINESS_PATHS` 逐项查残留，有残留就 **exit 1**，宁可不打包。
  白名单写漏了也会在这里被拦下。
- `predist:win` / `predist:mac` 会自动先 `cfg:default` 再 `cfg:check`，忘记手动跑也不会漏。
- `main.js` 的 `ensureDataDir()` 首次启动**优先迁移 `config.default.json`**，没有才回退旧的 `config.json`。
- 界面「设置 → 数据」新增 **清空业务数据**：保留选择器与调度、清掉全部业务数据（旧机器升级也能一键清干净）。

**验证方法**（已实测通过）：

```bash
npx electron-builder --win --dir -c.directories.output=dist-check
npx @electron/asar list dist-check/win-unpacked/resources/app.asar   # 只应有 data/config.default.json
"./dist-check/win-unpacked/巡洋战略舰.exe" --user-data-dir="E:/.../_newpc"
# 检查 _newpc/config.json：goods.list=0、coupon.list=0、seckill.cards=0、comment.groups=0、stats 全 0
```

### 12.8 打包踩坑

`electron-builder` 拉 Electron 二进制时走 GitHub，本地网络会 **502**。
本机已有缓存（`%LOCALAPPDATA%\electron\Cache\...\electron-v44.9.1-win32-x64.zip`）但它不认，
加镜像前缀即可：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --win
```

### 12.9 回归结果

- `npm run test:ui` → 29/29
- `npm run test:auto` → 42/42
- 新机首次启动模拟 → 配置全空、选择器保留、`api`/`data` 新字段就位

---

## 十三、v0.10.4：入口去重（A 档重构）

目标是把「抓取」这件事从一层层包装里拔出来，只留一条主路，同时消灭重复的渲染代码。

### 13.1 渲染去重：`goodsRowHtml()`

商品行 `<label class="goods-row">` 原来被抄了 **三份**，字段还各不相同：

| 原来 | 位置 | 差异 |
|---|---|---|
| 整页渲染 `RENDER.goods` | 商品页 | 有 `goods-gid`（商品 ID） |
| 局部重绘 `paintGoods()` | 抓取完成后 | 同上，但另一份拷贝 |
| `RENDER.popup` | 弹讲解页 | 没有右列 |
| `paintSeckill()` | 秒杀入口列表 | 右列换成「有秒杀入口」 |

现在统一走 `goodsRowHtml(it, { checked, action, tag, noRight })`，四处共用。加字段/改样式只改一处。

### 13.2 入口归一：一个「同步全部」+ 三个「只…」

| 位置 | 之前 | 现在 |
|---|---|---|
| 商品页 | `↻ 抓取商品`（主按钮） | `⚡ 同步全部（商品 + 券 + 秒杀入口）` 主按钮 |
| 商品页 | — | `↻ 只抓商品` 小图标（单项补抓） |
| 券页 | `⟳ 扫描券` | `↻ 只扫券` |
| 秒杀区 | `⚡ 扫描入口` | `↻ 只扫入口` |
| 高级页 | `⚡ 一键准备（推荐）` + `🔍 只分析结构` | 只剩 `🔍 只分析结构` |

理由：`syncAll()` 本质就是「分析结构 → 抓商品 → 扫券 → 扫入口」四步。以前它和三个零散按钮是同一套能力的两层包装，用户不知道点哪个；现在总入口只有商品页一个，零散按钮降级成单项补抓，高级页回归「诊断」定位。

结果卡 `syncCard()` 跟着搬到商品页顶部（`#syncBody`），高级页不再重复显示。

### 13.3 顺带改的文案

所有「请先点抓取商品 / 扫描券 / 扫描入口」的提示，统一改成新按钮名，避免指路指向不存在的按钮。

### 13.4 回归结果

- `npm run test:ui` → **32/32**（新增 3 条断言：高级页不再有 sync-all、商品页有唯一总入口、零散按钮统一成 ↻ 前缀）
- `npm run test:auto` → 42/42
- 商品页排版实测：面板 399px、5 行商品、无横向溢出

---

## 十四、v0.10.5：止血（后台页不再被自己判死）

### 14.1 改了什么

`call()` 新增第 4 个参数 `{ quiet: true }` —— 静默调用失败时**不**计入「后台页故障」。

| 调用点 | 之前 | 现在 |
|---|---|---|
| `Data.pull`（实时数据，10 秒一次） | 失败 → `Worker.notePageFailure()` | quiet |
| `KeepAlive.tick`（保活，60 秒一次） | 同上 | quiet |
| `Goods._refreshApi` | 同上 | quiet（失败直接回退 DOM） |
| `explainByApi`（弹讲解接口旁路） | 同上 | quiet（失败直接回退 DOM） |
| `PageBus.drawerBusy` | 同上 | quiet（只是调度前的探针） |

原则：**只有真正动页面（DOM）的操作才允许判定页面故障；纯接口请求失败只记日志。**

### 14.2 另外两道闸

- `Data.pull()`：`PAGE.target() === 'worker'` 且 `Worker.state !== 'ready'` 时直接返回，根本不发请求（未开播/刚启动/正在刷新时不敲页面）。「使用当前页面」模式没有后台页，不受这条限制。
- `KeepAlive.tick()`：同一条判断，没就绪不发心跳。
- `Data.pull()` 的 roomId 识别加节流：认到过就一直复用；认不到时 **60 秒才重试一次**（原来 10 秒一次，每次最多在页面里等 8 秒，会把后台页拖慢）。

### 14.3 复查时发现的一个事实（重要）

`Worker.notePageFailure()` 的第一行是 `if (!enabled || state !== 'ready' || refreshing) return;` —— **后台页处于 loading 时它本来就不会触发刷新**。所以「页面一直 loading 还被反复刷」不是这条路径造成的；quiet 改的是「页面已 ready 但接口拿不到数据」那种场景（那时确实会降到 3 次 → 确认死亡 → 刷新）。

真正让人在开播时看到后台页异常的原因另有其主：**测试脚本和正式 app 共用同一份登录会话**（见下）。

### 14.4 ⚠ 测试脚本与正式 app 会抢会话（务必记住）

`Worker.spawn()` 里后台页用的是 `partition: 'persist:douyin'`，这份 cookie 存在 Electron 的 userData 里。用 `npx electron test/*.js` 跑任何真机脚本时，`app.getName()` 仍取自项目 `package.json`，**userData 就是正式 app 那一套** —— 于是两个进程同时拿着同一个账号打开抖音本地生活中控台，其中一个会被顶掉/失效。

结论：**用户开着正式 app（或已经在 Edge 里操作中控台）时，不要跑 `test/live-*.js`。** 真机验证要么先关掉正式 app，要么改成用 `--remote-debugging-port` 连到已运行的窗口上（只读发 fetch，不开第二个会话）。

### 14.5 回归结果

- `npm run test:ui` → **36/36**（新增 4 条止血断言：quiet 失败不计故障、非 quiet 仍照常记账、未就绪时 Data.pull 直接跳过、跳过时不产生记账）
- `npm run test:auto` → 42/42

---

## 十五、v0.10.6：内存面板 + 两个回收动作

### 15.1 为什么「内存大」基本是设计使然

后台模式下一共三个 Chromium 进程：

| 进程 | 内容 |
|---|---|
| 浏览器主进程 | Electron 壳 |
| **主界面** | 一整个抖音站点（直播页 / 视频 / 长连接 / SW 缓存） |
| **后台页** | 又一份完整的抖音中控台（自动化在这跑） |

两个页面各 300~600MB 是抖音站点本身的量级，**合计 1GB 上下属于正常**。真正要盯的是「跑几小时后持续上涨、不回落」，那才是泄漏迹象。

### 15.2 新增：设置页「内存」区

- 主进程新增 `mem:info`（`app.getAppMetrics()`），按进程列出占用；
- 用 `webContents.getOSProcessId()` 给两个内嵌页面**标名字**（主界面 / 后台页），不再只能看到一堆「Renderer」；
- 超过 300MB 的行标红；底部给合计；
- 切到设置页自动读一次，也可手动 `↻ 刷新`。

### 15.3 新增：两个回收动作

| 按钮 | 做什么 | 影响 |
|---|---|---|
| **清理内存缓存** | 日志只留最近 50 条、清空扫描结果（`lastScan` / `lastDetect` / 秒杀入口超 40 条截断）、释放单品数据 `Data.snap.cards` | 不动直播间、不停任务、不碰配置 |
| **重建后台页** | `Worker.restart()` — 重新加载中控台 | 回收最多；会打断正在跑的动作几秒~十几秒，带确认弹窗 |

### 15.4 回归结果

- `npm run test:ui` → **39/39**（新增 3 条：内存面板能列出进程、后台页/主界面有名字且给合计、两个回收按钮存在）
- `npm run test:auto` → 42/42
- `test/ui-test.js` / `test/auto-test.js` 都加了 `mem:info` 的桩，避免主进程没这个通道时报错

---

## 十六、v0.10.7：官方弹层礼让卡死调度（线上事故修复）

### 16.1 现象

用户开播后日志一直在刷「官方抽屉/弹窗正开着，机器人先等它关掉」，**所有功能都拿不到页面锁**，等于整机停摆。

### 16.2 根因：`officialBusy()` 判定太松

抖音的抽屉**关掉以后 DOM 节点通常还在**，只是被 `transform` 移出屏幕（或留在 `display` 不为 none 的容器里）。
旧实现只看三件事 —— 尺寸 > 2、`display !== none`、`opacity !== '0'` —— 收起的抽屉三条全过，于是被永久认成"还开着"，
`PageBus.pump()` 每次都 `return` 并排 2 秒后重试 → 永不发牌。

### 16.3 修法三道

**① 判定收紧（注入库 `src/index.html`，`__TP` 版本 0.8 → 0.9）**

`officialBusy()` 新增两层过滤：

- **视口判定**：`right < 4 || left > vw-4 || bottom < 4 || top > vh-4` 一律不算（收起的抽屉就是被移出屏幕）
- **命中测试**：用 `elementFromPoint` 打元素中心点，必须命中它自己或它的子节点（排除被别层盖住 / 只剩骨架的残留节点）
- 返回值带 `why`（`drawer-mask` / `modal` / `drawer-body`）与 `el`（class 摘要），日志里能直接看出是谁在报警

**② 超时放行（`PageBus.pump()`）**

- 新增 `drawerSince`（本轮让位起点）；让位超过 `DRAWER_YIELD_MAX_MS()`（默认 **15 秒**，可由 `sched.drawerYieldMaxMs` 调）就强制放行一次
- **绝不允许无限等待** —— 这是兜底，即使判定再次误判也不会停摆

**③ 连续误判自动关停（自愈）**

- 新增 `drawerForced`：连续「等到超时才放行」满 **3 次** → 自动 `cfg.api.drawerYield = false` + `saveConfig()`，并写 warn 日志
- 一路顺畅（弹层确实关掉了）时计数清零
- 用户无需手动干预，最坏 3×15 秒后自己恢复

### 16.4 手动开关

设置 → 接口通道 → **「官方抽屉打开时让位」**。关掉即完全跳过这段判定，回到 v0.10.3 之前的行为。

### 16.5 回归结果

- `npm run test:ui` → **41/41**（新增 2 条：弹层一直"开着"时也会超时放行不卡死；关掉开关后 3ms 立刻放行）
- `npm run test:auto` → 42/42
- 测试用桩：`__debug.setDrawerYieldMax(ms)` / `__debug.setDrawerYield(on)`，可以直接 stub `PageBus.drawerBusy`

### 16.6 教训

**凡是"等待某个外部状态自己消失"的调度逻辑，都必须有超时上限和自愈开关。**
这次的礼让本意是好的（别跟官方弹窗抢），但一旦判定源不可靠，就变成了全局阻塞点——而且是唯一一个能卡住所有功能的点。

---

## 十七、v0.10.7 打包交付（Win 安装包 + Mac zip）

### 17.1 Windows

```bash
npm run predist:win       # 生成 data/config.default.json + 残留校验（有残留直接失败）
npx electron-builder --win -c.directories.output=dist-win4
```

产物：`dist-win4/巡洋战略舰 Setup 0.10.7.exe`（107 MB，NSIS 一键安装）
asar 内容核对（**只有** `data/config.default.json`，无开发档 `config.json`、无 `test/`、无 `HANDOVER.md`）：

```
\data\config.default.json  \guest.js  \main.js  \package.json
\preload.js  \src\app.js  \src\index.html  \src\styles.css
```

### 17.2 macOS：用工程自带的 `scripts/build-mac.sh`（不要自己拼 .app）

```
⨯ Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build
```

electron-builder 26 在 Windows 上直接拒绝 `--mac`，**这台机器出不了 Mac 安装包**。
这是工具限制，不是配置问题 —— **Mac 包必须在 Mac 上打**。

工程里早已备好脚本，**这才是正路**：

```bash
bash scripts/build-mac.sh              # arm64 + x64 两套
bash scripts/build-mac.sh --arm64-only  # 只要 M 系列，快一半
```

脚本内已处理：找 node（Homebrew / nvm / WorkBuddy 运行时）、走 npmmirror 镜像、
`CSC_IDENTITY_AUTO_DISCOVERY=false`（不公证签名）。
本次（v0.10.7）给它补了一条：**打包前先跑 `npm run predist:mac`**，
出厂配置有残留就直接非零退出、中止打包 —— 保证新机不会带上本机的商品/券/秒杀卡。

产物在 `release/`：`巡洋战略舰-0.10.7{,-arm64}.dmg` 与 `.zip`。

**走过的弯路（记下来，别再犯）**：曾试图在 Windows 上手工组装 `.app`
（下载官方 electron darwin zip，在 zip 层面替换 Electron.app→巡洋战略舰.app / icns / Info.plist / app.asar，
symlink 按 unix mode 原样写回）。技术上能做出能解压的包，但：
  ① 工程本来就有 `build-mac.sh`，自己造轮子是重复且偏离约定；
  ② 无 dmg、无签名，跟工程既定交付形态不一致；
  ③ 无法在本机验证能不能跑，风险全丢给测试员。
已全部删除（`dist-mac4/`、`scripts/make-mac-app.py`）。

**教训：动手前先看 `scripts/` 里有什么。** 这个工程的打包/安装脚本早就齐了。

### 17.3 缓存迁移（遵守"不落 C 盘"）

`%LOCALAPPDATA%\electron` 与 `%LOCALAPPDATA%\electron-builder` 已 `Move-Item` 到
`D:\Cache\electron` / `D:\Cache\electron-builder`，原路径建 Junction 指回，electron-builder 无需改配置。

### 17.4 交付清单

| 文件 | 说明 |
|---|---|
| `dist-win4/巡洋战略舰 Setup 0.10.7.exe` | Windows 安装包（108 MB，NSIS） |
| `release/巡洋战略舰-源码-0.10.7.zip` | 干净源码包（1.9 MB）：Mac 解压双击「首次安装.command」即可跑，也可作为在 Mac 上出包的输入 |
| `release/Mac端出包与测试说明.txt` | Mac 出包步骤（`build-mac.sh`）+ 测试员安装/首次抓取说明 |

源码包由 `scripts/pack-src.py` 生成。本次给它加了 `--dev` 开关：
默认只带 `data/config.default.json`（干净、无业务数据），`--dev` 才额外带本机的
`data/config.json`（换设备继续开发用）。自检会校验干净版不含 `data/config.json`。

### 17.5 回归

- `npm run test:ui` → 41/41
- `npm run test:auto` → 42/42
- 出厂配置校验：`cfg:check` 通过（商品 0 / 券 0 / 秒杀卡 0 / 评论组 0，选择器 18 项保留）

---

## 十八、v0.10.8：Windows 安装位置可自选，默认不装 C 盘

### 18.1 改动

`package.json` 新增 `build.nsis` 段：

```json
"nsis": {
  "oneClick": false,                            // 走安装向导，不再是「一键装完」
  "allowToChangeInstallationDirectory": true,   // 允许改目录
  "perMachine": false,                          // 仍是用户级安装，不弹 UAC
  "installerLanguages": ["zh_CN"],              // 向导中文
  "displayLanguageSelector": false,
  "include": "build/installer.nsh"              // 自定义默认目录
}
```

`build/installer.nsh` 里按 D → E → G 的顺序找「存在且当前用户真能写」的盘，
把默认目录改成 `<盘>:\Program Files\巡洋战略舰`。

### 18.2 踩过的两个坑（都实测了）

**坑一：挂载点必须是 `customInit`，不是 `preInit`**

electron-builder 的 `templates/nsis/installer.nsi` 里顺序是：

```
Function .onInit
  !insertmacro preInit
  !insertmacro initMultiUser      ← setInstallModePerUser 会把 $INSTDIR
  !insertmacro customInit         ← 改这里才有效
```

`setInstallModePerUser`（multiUser.nsh）干的事：
① 读上次安装路径 → ② 否则用 `%LOCALAPPDATA%\Programs\<appname>`
→ ③ **最后**才允许 `/D=` 覆盖。

写在 `preInit` 里的 `StrCpy $INSTDIR` 会被 ② 覆盖掉。
**实测**：第一版用 preInit，静默装完落在
`C:\Users\<user>\AppData\Local\Programs\xunyang-zhanluejian`（目录名取的是 package.json 的 name，不是 productName）。

**坑二：custom script 里不能定义 `Function`**

include 的文件最终落在某个 `Section` 范围内，`Function` 会被当成 section 回调，
makensis 报 `warning 6010: install function "XY_CanWrite" not referenced`，
而 electron-builder **把 warning 当 error**，打包直接失败。
放 `customHeader` 里也没用（展开位置同样在范围内）。
**解法**：逻辑全部内联展开，一段都不抽成 Function。

### 18.3 为什么不硬编码 D 盘

写 `\`D:\Program Files\`` 最简单，但机器没有 D 盘就装崩了。
所以用「建目录 → 建临时文件 → 删掉」的方式实测写权限，写不了就换下一个盘，
全都不行才退回 NSIS 自己的默认值（用户目录下的 Programs）——保证一定装得上。

另外只在 `$INSTDIR` 落在 **C 盘**时才挪：
用户显式 `/D=` 指定了（非 C 盘）或升级安装时上次就在 D 盘，都不动。

### 18.4 验证（真装真卸，不是纸上推导）

| 场景 | 命令 | 结果 |
|---|---|---|
| 默认安装 | `Setup 0.10.8.exe /S` | 落在 `D:\Program Files\巡洋战略舰`，74 个文件 ✓ |
| 自选目录 | `Setup 0.10.8.exe /S /D=E:\tuanbo-install-test` | 装到指定目录，74 个文件 ✓ |
| 卸载 | `Uninstall 巡洋战略舰.exe /S` | 目录删除、注册表无残留 ✓ |
| 卸载后又想装 | 再跑一次默认安装 | 仍落 D 盘（不因注册表历史跳到别处）✓ |

### 18.5 交付清单

| 文件 | 说明 |
|---|---|
| `dist-win4/巡洋战略舰 Setup 0.10.8.exe` | Windows 安装包（108 MB，向导可自选位置，默认 D 盘） |
| `release/巡洋战略舰-源码-0.10.8.zip` | 干净源码包（1.9 MB，72 条目，含 build/installer.nsh） |
| `release/Mac端出包与测试说明.txt` | Mac 出包步骤 + 测试员安装/首次抓取说明 |

旧版已清：`dist-win4/Setup 0.10.7.exe`、`release/巡洋战略舰-源码-0.10.7.zip`。
