@echo off
chcp 65001 >nul
title 巡洋战略舰 - 首次安装
cd /d "%~dp0"

echo ==========================================
echo    巡洋战略舰  首次安装 / 启动
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "delims=" %%v in ('node -v') do echo Node 版本：%%v
echo.

if exist "node_modules\electron\dist\electron.exe" goto run

echo [1/3] 安装依赖（走国内镜像，约 200-400MB，可能要几分钟）...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if exist "D:/Cache" set "npm_config_cache=D:/Cache/npm-cache"
call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
if errorlevel 1 goto npmfail

:checkbin
if exist "node_modules\electron\dist\electron.exe" goto run

echo.
echo [2/3] 依赖装好了，但 Electron 二进制没下来，补下载...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call node "node_modules\electron\install.js"
if exist "node_modules\electron\dist\electron.exe" goto run
goto binfail

:run
echo.
echo [3/3] 启动巡洋战略舰...
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
echo 已启动，这个黑窗口可以关掉。
timeout /t 2 >nul
exit /b 0

:nonode
echo [错误] 这台电脑没装 Node.js。
echo 请先安装 Node 22 或更高版本： https://nodejs.org/
echo 装完后重新双击本文件。
echo.
pause
exit /b 1

:npmfail
echo.
echo [失败] npm install 出错。
echo 常见原因：网络不通、npm 源不可用、磁盘空间不足。
echo 也可以进入项目目录手动执行： npm install
echo.
pause
exit /b 1

:binfail
echo.
echo [失败] Electron 二进制仍未下载成功。
echo 手动执行这两条命令再试：
echo   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo   node node_modules\electron\install.js
echo.
pause
exit /b 1
