@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 养基宝数据刷新

echo ============================================
echo   养基宝 持仓同步 + 看板刷新
echo ============================================
echo.

set "NEED_RESTART=0"
set "EDGE_X86=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "EDGE_X64=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

echo [1/2] 同步插件持仓...
node yjb.js

if errorlevel 1 (
    echo.
    echo [!] 直读插件数据库失败，需要回退到浏览器方案。
    tasklist /FI "IMAGENAME eq msedge.exe" /NH 2>nul | find /I "msedge.exe" >nul
    if !errorlevel! equ 0 (
        echo     浏览器方案要求先完全关闭 Edge，刷新后会自动重开。
        echo     请先保存正在编辑的网页内容。
        set /p "ANS=    现在关闭 Edge 并重试？[Y/n] "
        if /I "!ANS:~0,1!"=="n" (
            echo     已跳过，持仓沿用上次数据。
        ) else (
            echo     正在关闭 Edge...
            taskkill /IM msedge.exe >nul 2>&1
            ping -n 4 127.0.0.1 >nul
            tasklist /FI "IMAGENAME eq msedge.exe" /NH 2>nul | find /I "msedge.exe" >nul
            if !errorlevel! equ 0 taskkill /IM msedge.exe /F >nul 2>&1
            set "NEED_RESTART=1"
            node yjb.js
        )
    )
) else (
    echo     持仓同步完成。
)
echo.

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
