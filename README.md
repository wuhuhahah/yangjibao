# 养基宝持仓工作台

Windows本地基金持仓看板：读取本机Edge养基宝插件数据，提供持仓核对、PE/PB、指数历史价格分位、金叉死叉与量能、主题四象限、机构评价、仓位规则、模拟和操作日志。

## 普通用户：不用安装Node

下载Release里的 `yangjibao-windows-x64.zip`，完整解压到自己可以写入的目录（不要直接在ZIP内启动），双击 **启动看板.vbs**。程序在后台启动并打开浏览器。若电脑禁用了VBScript，使用 **启动看板.cmd**。

便携包自带Node运行文件，无需安装Node、Python或npm依赖。当前包适用于Windows x64；其他架构需用对应Node运行文件构建。

第一次使用需要先在Edge安装、登录养基宝插件，并在APP同步自己的支付宝截图。便携包没有预置持仓、账号或示例金额。如果插件安装在多个Edge资料中，在页面的“后台与Edge资料设置”选择使用的资料。

- 默认每30分钟后台刷新，仅在北京时间交易日09:30–11:30、13:00–15:00运行；午休、收盘后、周末与交易所休市日暂停，到下个开盘时段自动恢复。开盘时段启动时先刷新一次。页面可选择关闭、10/30/60/120分钟并保存。
- 内置2026年上交所休市日历（调休上班的周末仍休市）。`trading-calendar.json`记录各年休市日期范围；新年度需按交易所公告补充，缺少该年日历时自动刷新暂停，页面会提示，手动按钮仍可用。
- 页面 **后台刷新数据** 按钮可立即读取插件、更新市场缓存并生成看板；已有任务运行时不会重复启动。
- 成功生成后页面自动更新；正在输入表单或有未保存日志时，提示用户点击“查看更新后的看板”。
- 关闭浏览器页面后后台仍运行；点击“停止后台”结束程序。关机后定时刷新停止，下次双击启动恢复。
- 本轮不设置Windows开机启动，也不额外创建系统计划任务。
- 插件刷新仍取决于APP和插件是否同步了最新截图，后台程序不能直接获取支付宝原始持仓。
- 历史净值成功获取后缓存6小时；行业和指数数据按日缓存。定时刷新不会每次重新请求全部历史数据；失败主机冷却至少30分钟，遵守更长的Retry-After。
- 直接打开HTML可以看保存的结果；要点击按钮执行后台刷新，请使用启动程序打开的本地网页。

已有file://页面里的规则、截图确认日期和操作日志与新本地网址的浏览器存储不同。迁移时先在旧页面“操作复盘”导出设置与日志，再在新页面导入。固定本地端口是8787，占用时使用后续可用端口。

## 数据和运行范围

服务仅监听 `127.0.0.1`，不对局域网或互联网开放。浏览器不能直接读取Edge文件，按钮通过本机后台完成刷新。GitHub Pages不能代替本地程序读取插件文件。

私有数据只在程序目录与当前浏览器中保存。源码仓库和便携包不能包含 `yjb-data.json`、生成的HTML、历史快照、市场缓存、运行设置、日志、登录凭证、Edge资料或个人备份。打包脚本使用明确的源码白名单。

## 开发者与GitHub分发

源码运行需要Node >=22：

```powershell
node local-server.js --open
```

本项目无npm依赖。测试：

```powershell
node --test test-dashboard.js test-market-analysis.js test-local-server.js test-trading-schedule.js
```

构建便携包（需准备与Node版本匹配的官方LICENSE）：

```powershell
.\build-portable.ps1 -NodeLicense .\runtime\NODE-LICENSE.txt
```

`dist/`被Git忽略；上传生成的ZIP到GitHub Release供普通用户下载，不需要把大型node.exe提交到Git源码。提供的手动GitHub Actions工作流在Windows runner上构建并上传便携ZIP为Actions artifact，不自动发布Release。

参考：[Node.js](https://github.com/nodejs/node)、[Electron](https://github.com/electron/electron)、[Tauri](https://github.com/tauri-apps/tauri)。本轮保留已有静态看板，采用自带Node的本地后台，无需引入完整桌面UI框架。
