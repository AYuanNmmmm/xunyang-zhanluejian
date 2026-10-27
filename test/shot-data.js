// 临时脚本：渲染「实时数据」页的样例，截图确认排版（不依赖真实接口/登录）。
// 用法：npx electron --no-sandbox test/shot-data.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');

const SAMPLE = `
<h3>实时数据</h3>
<p class="hint">直接读抖音直播中控的大屏与单品效果，只读、不点页面，可以和其它功能同时开着。</p>

<div class="section">
  <div class="section-title">直播大屏 <button class="mini-btn">↻ 刷新</button></div>
  <div id="dataBox">
    <div class="dgrid">
      <div class="dcell hot"><b>128</b><span>在线</span></div>
      <div class="dcell"><b>3241</b><span>累计观看</span></div>
      <div class="dcell"><b>17</b><span>新增粉丝</span></div>
      <div class="dcell"><b>43</b><span>成交单数</span></div>
      <div class="dcell"><b>6.82万</b><span>GMV</span></div>
      <div class="dcell"><b>2.47%</b><span>观看→支付</span></div>
    </div>
    <p class="hint">更新于 21:14:03 · 房间 742259</p>
    <div class="dtable-wrap">
      <table class="dtable">
        <thead><tr><th>#</th><th>商品</th><th>曝光</th><th>点击</th><th>成交</th></tr></thead>
        <tbody>
          <tr><td class="dnum">1</td><td class="dname" title="【双人票】水上烟花光影秀+打铁花+河灯">【双人票】水上烟花光影秀+打铁花+河灯</td><td>1431</td><td>142<span class="dsub">10%</span></td><td><b class="dhot">18</b><span class="dsub">3.28万</span></td></tr>
          <tr><td class="dnum">2</td><td class="dname" title="【亲子票】1大1小 夜场通票">【亲子票】1大1小 夜场通票</td><td>855</td><td>63<span class="dsub">7%</span></td><td><b class="dhot">11</b><span class="dsub">1.92万</span></td></tr>
          <tr><td class="dnum">3</td><td class="dname" title="【夜游茶船】双人 含茶点">【夜游茶船】双人 含茶点</td><td>436</td><td>21<span class="dsub">5%</span></td><td>8<span class="dsub">1.12万</span></td></tr>
          <tr><td class="dnum">4</td><td class="dname" title="【单人票】日游 含萌宠互动">【单人票】日游 含萌宠互动</td><td>212</td><td>9<span class="dsub">4%</span></td><td>6<span class="dsub">5020</span></td></tr>
          <tr><td class="dnum">5</td><td class="dname" title="【国庆限定】烟花观景位">【国庆限定】烟花观景位</td><td colspan="3" class="dempty">还没数据</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">刷新</div>
  <div class="field"><label>自动刷新</label><label class="switch-label"><input type="checkbox" checked><span>开启</span></label></div>
  <div class="field"><label>刷新间隔</label><div class="range"><input type="number" value="10"><span>秒</span></div></div>
</div>

<div class="section">
  <div class="section-title">接口通道</div>
  <div class="field"><label>商品列表走货架接口</label><label class="switch-label"><input type="checkbox" checked><span>开启</span></label></div>
  <div class="field"><label>弹讲解走接口（不点画面）</label><label class="switch-label"><input type="checkbox" checked><span>开启</span></label></div>
</div>
`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1580,
    height: 980,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });
  await w.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 3500));

  // 直接替换面板内容并高亮 nav —— 绕过 activeTab 状态机，只验排版。
  // 注意：app 里有若干 setInterval 会重新 paint，注入前先把所有定时器掐掉，
  // 否则截图时面板又被打回「商品」页。
  await w.webContents.executeJavaScript(`
    (() => {
      for (let i = 0; i < 20000; i++) { clearInterval(i); clearTimeout(i); }
      document.getElementById('panel').innerHTML = ${JSON.stringify(SAMPLE)};
      const nav = document.querySelector('[data-tab="data"]');
      if (nav) {
        document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
        nav.classList.add('active');
      }
      return document.getElementById('panel').innerHTML.includes('dtable') ? 'injected' : 'failed';
    })()
  `).then((r) => console.log('注入结果：', r));
  await new Promise((r) => setTimeout(r, 300));

  // 隐藏窗口 + disable-gpu 时 capturePage 会拿到旧帧，必须显式示窗强制重绘
  w.showInactive();
  w.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 700));

  // 面板的实际宽度（判断表格够不够）
  const info = await w.webContents.executeJavaScript(`
    (() => {
      const p = document.getElementById('panel');
      const t = document.querySelector('.dtable');
      const cell = document.querySelector('.dcell');
      return JSON.stringify({
        panelWidth: p ? Math.round(p.getBoundingClientRect().width) : 0,
        tableWidth: t ? Math.round(t.getBoundingClientRect().width) : 0,
        cellWidth: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
        overflowX: t ? (t.scrollWidth > t.clientWidth) : false,
        bodyOverflow: document.body.scrollWidth > document.body.clientWidth
      });
    })()
  `);
  console.log('面板测量：', info);

  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'preview-data.png'), img.toPNG());
  console.log('已生成 preview-data.png');
  app.quit();
});
