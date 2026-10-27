#!/bin/bash
# 巡洋战略舰 · macOS 首次安装 / 启动（双击运行）
# 等价于 Windows 的「首次安装.bat」：查 Node → 装依赖 → 补 Electron 二进制 → 启动

cd "$(dirname "$0")" || exit 1
unset ELECTRON_RUN_AS_NODE

echo "=========================================="
echo "   巡洋战略舰  首次安装 / 启动（macOS）"
echo "=========================================="
echo

# ---------- 1. 找 Node（Finder 启动时 PATH 很短，要主动找） ----------
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local c
  for c in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.workbuddy/binaries/node/versions/"*/bin/node \
    "$HOME/.nvm/versions/node/"*/bin/node \
    /usr/bin/node; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

NODE_BIN="$(find_node)" || {
  echo "[错误] 这台 Mac 没找到 Node.js。"
  echo "请先装 Node 22 或更高版本（任选一种）："
  echo "  · 官网安装包：https://nodejs.org/"
  echo "  · Homebrew：brew install node"
  echo "装完后再双击本文件。"
  echo
  read -r -p "按回车关闭窗口…" _
  exit 1
}

export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "Node 版本：$("$NODE_BIN" -v)   （$NODE_BIN）"

# ---------- 2. 装依赖 ----------
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$BIN" ]; then
  echo
  echo "[1/3] 安装依赖（走国内镜像，约 200-400MB，可能要几分钟）…"
  npm install --no-audit --no-fund --registry="${npm_config_registry:-https://registry.npmmirror.com}" || {
    echo
    echo "[失败] npm install 出错。"
    echo "常见原因：网络不通、磁盘空间不足。也可以手动进入目录执行： npm install"
    read -r -p "按回车关闭窗口…" _
    exit 1
  }
fi

# ---------- 3. 补 Electron 二进制 ----------
if [ ! -x "$BIN" ]; then
  echo
  echo "[2/3] 依赖装好了，但 Electron 二进制没下来，补下载…"
  ELECTRON_MIRROR="$ELECTRON_MIRROR" "$NODE_BIN" node_modules/electron/install.js || true
fi

if [ ! -x "$BIN" ]; then
  echo
  echo "[失败] Electron 二进制仍未下载成功。手动执行这两条再试："
  echo "  export ELECTRON_MIRROR=$ELECTRON_MIRROR"
  echo "  node node_modules/electron/install.js"
  read -r -p "按回车关闭窗口…" _
  exit 1
fi

# 清隔离标记，避免「已损坏，打不开」
xattr -dr com.apple.quarantine node_modules/electron/dist/Electron.app 2>/dev/null

# ---------- 4. 启动 ----------
echo
echo "[3/3] 启动巡洋战略舰…"
# 后台启动：关掉终端窗口不会带走正在跑的中控
nohup "$BIN" . > run.log 2>&1 &
sleep 1

if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "已启动，这个窗口可以直接关掉（日志：$(pwd)/run.log）。"
  sleep 2
else
  echo "[失败] 启动没起来，最后 20 行日志："
  tail -n 20 run.log
  echo
  read -r -p "按回车关闭窗口…" _
  exit 1
fi
exit 0
