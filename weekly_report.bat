@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ===== %date% %time% ===== >> weekly.log
set "NODE_BIN=node"
if exist "%~dp0runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
"%NODE_BIN%" refresh-job.js >> weekly.log 2>&1
exit /b %errorlevel%
