@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 养基宝数据刷新

echo ============================================
echo   养基宝 持仓同步 + 看板刷新
echo ============================================
echo.

set "NEED_RESTART=0"
set "SKIP_SYNC=0"
set "EDGE_X86=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE_X64=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

tasklist /FI "IMAGENAME eq msedge.exe" /NH 2>nul | find /I "msedge.exe" >nul
if !errorlevel! equ 0 (
    echo [!] 检测到 Edge 正在运行。
    echo     同步持仓需要先完全关闭 Edge，脚本会在刷新后自动重开。
    echo     请先保存正在编辑的网页内容。
    echo.
    set /p "ANS=    现在关闭 Edge 并继续？[Y/n] "
    if /I "!ANS:~0,1!"=="n" (
        set "SKIP_SYNC=1"
        echo     已跳过持仓同步，本次只更新市场数据。
    ) else (
        echo     正在关闭 Edge...
        taskkill /IM msedge.exe >nul 2>&1
        ping -n 4 127.0.0.1 >nul
        tasklist /FI "IMAGENAME eq msedge.exe" /NH 2>nul | find /I "msedge.exe" >nul
        if !errorlevel! equ 0 taskkill /IM msedge.exe /F >nul 2>&1
        set "NEED_RESTART=1"
        echo     已关闭。
    )
    echo.
)

if "!SKIP_SYNC!"=="0" (
    echo [1/2] 同步插件持仓...
    node yjb.js
    if !errorlevel! equ 0 (
        echo     持仓同步完成。
    ) else (
        echo [!] 持仓同步失败，沿用上次数据。详情见上方提示。
    )
    echo.
)

echo [2/2] 拉取净值与估值，生成看板（约 1 分钟，请稍候）...
py -3.13 portfolio.py
echo.

if "!NEED_RESTART!"=="1" (
    echo 重新打开 Edge...
    if exist "!EDGE_X86!" (
        start "" "!EDGE_X86!"
    ) else if exist "!EDGE_X64!" (
        start "" "!EDGE_X64!"
    ) else (
        start "" msedge
    )
)

start "" "%~dp0持仓看板.html"
echo 完成。
ping -n 4 127.0.0.1 >nul
