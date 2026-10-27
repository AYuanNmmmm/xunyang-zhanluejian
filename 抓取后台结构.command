#!/bin/bash
# 抓取抖音后台真实页面结构（只在开发调试时用，不参与打包）
# 双击运行 → 弹出独立 Chrome → 扫码登录 → 点进直播间中控台 → 自动抓快照

cd "$(dirname "$0")" || exit 1

NODE="/Users/yuan/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  echo "找不到 Node，请先运行「首次安装.command」"
  read -r -p "按回车关闭…" _
  exit 1
fi

export NODE_PATH="/Users/yuan/.workbuddy/binaries/node/workspace/node_modules"

clear
echo "=============================================="
echo "  巡洋战略舰 · 后台结构抓取"
echo "=============================================="
echo
echo "接下来会弹出一个独立 Chrome（不影响你日常用的 Chrome）。"
echo
echo "  1. 在里面扫码登录 eos.douyin.com"
echo "  2. 自己点进「直播间中控台」"
echo "  3. 页面地址一变就会自动抓一份，不用你操作"
echo
echo "抓完直接关掉 Chrome 窗口即可，这个终端会自动退出。"
echo
read -r -p "按回车开始…" _

"$NODE" scripts/probe.js

echo
echo "抓取结束。快照在 data/probe/ 里。"
sleep 1
