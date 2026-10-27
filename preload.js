const { contextBridge, ipcRenderer } = require('electron');

// target：'main'（界面上那个可见页面）或 'worker'（后台工作页）。
// 不传时主进程默认用第一个注册的页面（= main），所以老调用不受影响。
contextBridge.exposeInMainWorld('tp', {
  // 宿主平台：darwin / win32 / linux（界面文案、快捷键提示按它区分）
  platform: process.platform,
  stopKeys: process.platform === 'darwin' ? '⌘+Shift+F12' : 'Ctrl+Shift+F12',

  ready: () => ipcRenderer.send('app:ready'),
  appVersion: () => ipcRenderer.invoke('app:version'),

  // 配置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  configPath: () => ipcRenderer.invoke('config:path'),
  exportLog: (text) => ipcRenderer.invoke('log:export', text),

  // 内嵌页面操作（支持 iframe）
  setLib: (src) => ipcRenderer.invoke('guest:setLib', src),
  call: (code, target) => ipcRenderer.invoke('guest:call', code, target),
  // 把渲染进程创建的 webview 登记到主进程（name + webContentsId）
  registerGuest: (name, id) => ipcRenderer.invoke('guest:register', name, id),
  // 后台页是否已经能读到中控台结构（主进程直探，绕开 JS 封装，最可靠）
  workerReady: (sel) => ipcRenderer.invoke('guest:probe', 'worker', sel || '#live-card-list, #current-live-room'),
  guestNames: () => ipcRenderer.invoke('guest:names'),
  pickStart: (target) => ipcRenderer.invoke('guest:pickStart', target),
  pickPoll: (target) => ipcRenderer.invoke('guest:pickPoll', target),
  pickStop: (target) => ipcRenderer.invoke('guest:pickStop', target),
  frames: (target) => ipcRenderer.invoke('guest:frames', target),
  scan: (limit, target) => ipcRenderer.invoke('guest:scan', limit, target),
  // 真实输入（走浏览器输入管线，isTrusted=true）
  realClick: (x, y, target) => ipcRenderer.invoke('guest:realClick', x, y, target),
  realMove: (x, y, target) => ipcRenderer.invoke('guest:realMove', x, y, target),
  realType: (x, y, text, target) => ipcRenderer.invoke('guest:realType', x, y, text, target),
  realEnter: (target) => ipcRenderer.invoke('guest:realEnter', target),
  realKey: (key, times, target) => ipcRenderer.invoke('guest:realKey', key, times, target),

  // 有任务在跑时通知主进程阻止系统休眠
  powerBusy: (busy) => ipcRenderer.invoke('power:busy', !!busy),

  // 内存占用（按进程，用于设置页「内存」区）
  memInfo: () => ipcRenderer.invoke('mem:info'),

  onEmergencyStop: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('engine:emergency-stop', handler);
    return () => ipcRenderer.removeListener('engine:emergency-stop', handler);
  },

  // 内嵌页面里被拦下的外部协议（bitbrowser:// 等），只用于写日志
  onGuestBlocked: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('guest:blocked', handler);
    return () => ipcRenderer.removeListener('guest:blocked', handler);
  }
});
