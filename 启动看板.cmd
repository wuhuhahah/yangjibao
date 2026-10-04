@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0local-server.js" --open
) else (
  node "%~dp0local-server.js" --open
)
if errorlevel 1 pause
