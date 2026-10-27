@echo off
chcp 65001 >nul
title 巡洋战略舰
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 依赖还没装，正在启动安装脚本...
  timeout /t 1 >nul
  if exist "%~dp0install.bat" (
    start "" "%~dp0install.bat"
  ) else (
    start "" "%~dp0首次安装.bat"
  )
  exit /b 0
)
start "" "node_modules\electron\dist\electron.exe" .
