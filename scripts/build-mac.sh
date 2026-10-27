#!/bin/bash
# 打包 macOS 版本（arm64 + Intel）：产出 release/ 下的 .dmg 与 .zip
# 用法：bash scripts/build-mac.sh        （首次会下载 Electron 两套运行时，比较慢）
#       bash scripts/build-mac.sh --arm64-only
set -e
cd "$(dirname "$0")/.." || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Finder / 精简环境里可能找不到 node，补几个常见位置（含 WorkBuddy 托管运行时）
for c in "$HOME/.workbuddy/binaries/node/versions/"*/bin "$HOME/.nvm/versions/node/"*/bin; do
  [ -x "$c/node" ] && PATH="$c:$PATH"
done
command -v node >/dev/null 2>&1 || { echo "[错误] 找不到 node，请先安装 Node 22+"; exit 1; }

# 国内镜像，避免 electron 二进制下载卡死
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

# 自用工具，不做 Apple 公证签名（装了证书想签名就把这行去掉）
export CSC_IDENTITY_AUTO_DISCOVERY=false

if [ ! -d node_modules/electron-builder ]; then
  echo "先装打包依赖…"
  npm install -D electron-builder --no-audit --no-fund --registry="${npm_config_registry:-https://registry.npmmirror.com}"
fi

# 出厂配置：先重新生成 data/config.default.json 并校验。
# 新机装好不能带任何商品/券/秒杀卡——有残留这里会直接非零退出，打包失败。
npm run predist:mac || { echo "[失败] 出厂配置不干净，已中止打包"; exit 1; }

if [ "$1" = "--arm64-only" ]; then
  ./node_modules/.bin/electron-builder --mac --arm64
else
  ./node_modules/.bin/electron-builder --mac
fi

echo
echo "产物："
ls -lh release/*.dmg release/*.zip 2>/dev/null || true
