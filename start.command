#!/bin/bash
# 巡洋战略舰 · macOS 启动脚本（双击运行）
# 等价于 Windows 的 start.bat：只负责启动，装依赖交给「首次安装.command」

cd "$(dirname "$0")" || exit 1

# 有些终端/IDE 会把 ELECTRON_RUN_AS_NODE 带进环境，那会让 Electron 退化成 node，
# 启动时报 ipcMain undefined，这里一律清掉
unset ELECTRON_RUN_AS_NODE

APP="node_modules/electron/dist/Electron.app"
BIN="$APP/Contents/MacOS/Electron"

if [ ! -x "$BIN" ]; then
  echo "依赖还没装，正在启动「首次安装.command」…"
  sleep 1
  exec "$(dirname "$0")/首次安装.command"
fi

# 从浏览器 / 网盘下载来的 Electron.app 可能带隔离标记，双击会报「已损坏，打不开」，
# 启动前顺手清掉（对本地已有的正常包无副作用）
xattr -dr com.apple.quarantine "$APP" 2>/dev/null

# 后台启动：这样关掉这个终端窗口不会把正在跑的中控一起带走
nohup "$BIN" . > run.log 2>&1 &
sleep 4

# 兜底：个别环境（终端沙箱 / GPU 驱动异常）下默认参数起不来，
# 日志出现「GPU process isn't usable」或「Failed to initialize sandbox」时，
# 自动带 --no-sandbox --disable-gpu 重启一次
if ! pgrep -f "$BIN" >/dev/null 2>&1 || grep -q "GPU process isn't usable\|Failed to initialize sandbox" run.log 2>/dev/null; then
  pkill -f "$BIN" 2>/dev/null
  sleep 1
  nohup "$BIN" . --no-sandbox --disable-gpu > run.log 2>&1 &
  sleep 4
fi

if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "巡洋战略舰已启动（日志：$(pwd)/run.log）"
  echo "这个窗口可以直接关掉。"
  sleep 2
else
  echo "[失败] 启动没起来，最后 20 行日志："
  tail -n 20 run.log
  echo
  read -r -p "按回车关闭窗口…" _
  exit 1
fi
