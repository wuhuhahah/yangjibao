@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 养基宝持仓工作台
echo 正在读取持仓并更新看板...
set "NODE_BIN=node"
if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
"%NODE_BIN%" refresh-job.js
if errorlevel 1 (
  echo 看板生成失败，已保留上次看板。请查看上面的错误信息。
  pause
  exit /b 1
)
start "" "%~dp0持仓看板.html"
echo 完成。
timeout /t 3 >nul
