@echo off
rem 每周日 20:00 由 Windows 任务计划调用：同步养基宝持仓 + 重新体检 + 刷新看板
cd /d "%~dp0"
echo ===== %date% %time% ===== >> weekly.log
node yjb.js >> weekly.log 2>&1
if errorlevel 1 echo [提示] 持仓同步失败（Edge 正开着，持仓沿用上次），本次沿用上次持仓数据 >> weekly.log
py -3.13 portfolio.py >> weekly.log 2>&1
