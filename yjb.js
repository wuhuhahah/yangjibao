#!/usr/bin/env node
/**
 * 养基宝插件数据实时读取工具（零依赖，Node >= 22）
 *
 * 原理：Edge 自带 CDP 调试协议。带 --remote-debugging-port 启动 Edge 后，
 * 打开插件 popup 页面作为标签页，在其上下文里执行 chrome.storage.local.get(null)
 * 拿到全量数据 —— 比 LevelDB 离线解析可靠，且是运行时实时数据。
 *
 * 用法：
 *   node yjb.js          读取一次并保存 yjb-data.json
 *   node yjb.js --watch  每 60 秒读一次，持续更新 yjb-data.json
 *
 * 前置条件（很重要）：运行前 Edge 必须完全退出。
 *   新版 Edge 禁止在默认资料目录上开调试端口，所以本脚本的做法是
 *   「把真实 profile 里的插件存储拷到独立目录 → 另起一个 Edge 读」。
 *   这一步是快照式的，不是实时同步：Edge 开着就拷不到，脚本会直接退出。
 *   Edge 开着时请改跑「刷新数据.bat」，它会负责关掉再重开。
 *
 * 生命周期：读完后自己启动的实例会被 Browser.close 关闭，
 *   否则残留实例占着 9222 端口会让下次运行跳过 seed、一直返回旧快照。
 */
'use strict';
const fs = require('fs');
const { execFile, execSync } = require('child_process');

const EXT_ID = 'lkfljjeajaekfbjfbbipopenjjebcphb'; // 养基宝
const POPUP = `chrome-extension://${EXT_ID}/src/entries/popup/index.html`;
const PORT = 9222;
const OUT = __dirname + '/yjb-data.json';
const PROFILE = __dirname + '\\edge-auto-profile'; // 独立资料目录：Edge M136+ 禁止在默认资料上开调试端口
const REAL_BASE = process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\User Data\\Default';
const REAL_STORAGE = `${REAL_BASE}\\Local Extension Settings\\${EXT_ID}`;
const EXT_DIR = (() => { // 插件磁盘目录，供 --load-extension 注入自动化 profile
  try {
    const base = `${REAL_BASE}\\Extensions\\${EXT_ID}`;
    const vers = fs.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return `${base}\\${vers[vers.length - 1]}`; // 插件更新后会并存多个版本，取最高版本
  } catch { return null; }
})();
let OWNED = false; // 自动化实例是否由本脚本启动（决定用完是否关闭）
function seed() { // 真实 Edge 的插件存储 → 自动化 profile（持仓是手动的，启动时同步足够新）
  if (!fs.existsSync(REAL_STORAGE)) { console.error('找不到养基宝数据: ' + REAL_STORAGE); process.exit(1); }
  const dst = `${PROFILE}\\Default\\Local Extension Settings\\${EXT_ID}`;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(REAL_STORAGE, dst, { recursive: true });
  console.log('已从真实 Edge 同步养基宝数据');
}
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getBrowserWs() {
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch {
      if (i > 0) await sleep(1000);
    }
  }
  return null;
}

function edgeRunning() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq msedge.exe" /NH', { encoding: 'utf8' })
      .toLowerCase().includes('msedge.exe');
  } catch { return false; }
}

function killStaleAuto() { // 清掉上次残留的自动化实例，否则 9222 被占、seed 被跳过、永远读到旧快照
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*edge-auto-profile*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`,
      { stdio: 'ignore' });
  } catch { /* 没有残留就是最好的情况 */ }
}

async function shutdownAuto() { // 读完数据立刻关掉自己开的实例，释放 9222 并让下次必然重新 seed
  try {
    const wsUrl = await getBrowserWs();
    if (!wsUrl) return;
    const cdp = await connect(wsUrl);
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
  } catch { /* 关不掉也无妨，下次启动前 killStaleAuto 会兜底 */ }
}

async function ensureEdge() {
  killStaleAuto(); // 必须先清，否则残留实例会让下面的探测误判为"可复用"
  let ws = await getBrowserWs();
  if (ws) { OWNED = false; return ws; } // 复用他人已开的调试端口时不接管生命周期
  if (edgeRunning()) {
    console.error('Edge 正在运行但没有开调试端口。请先完全退出 Edge（含后台进程）后重试，');
    console.error('或运行: taskkill /IM msedge.exe /F  （会关闭所有 Edge 窗口）');
    process.exit(1);
  }
  const exe = EDGE_PATHS.find((p) => fs.existsSync(p));
  if (!exe) { console.error('未找到 msedge.exe'); process.exit(1); }
  if (!EXT_DIR || !fs.existsSync(EXT_DIR)) { console.error('未找到养基宝插件目录'); process.exit(1); }
  seed();
  execFile(exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    `--load-extension=${EXT_DIR}`,
  ], () => {});
  ws = await getBrowserWs();
  if (!ws) { console.error('Edge 调试端口启动失败'); process.exit(1); }
  OWNED = true;
  console.log('Edge 自动化实例已启动（独立 profile + 养基宝插件）');
  return ws;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) =>
        new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
        }),
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  });
}

async function dumpOnce(wsUrl) {
  const cdp = await connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: POPUP });
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // 等 popup 页面初始化完成，storage API 才可用
    await sleep(1500);
    const res = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.storage.local.get(null)',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    cdp.close();
  }
}

function summarize(data) {
  console.log(`\n存储键：${Object.keys(data).length} 个，已保存到 ${OUT}\n`);
  for (const [k, v] of Object.entries(data)) {
    const s = JSON.stringify(v);
    const preview = s.length > 120 ? s.slice(0, 120) + '…' : s;
    console.log(`[key] ${k}  (${s.length} 字符)\n      ${preview}`);
  }
}

(async () => {
  const wsUrl = await ensureEdge();
  const watch = process.argv.includes('--watch');
  do {
    const data = await dumpOnce(wsUrl);
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    summarize(data);
    if (watch) { console.log('\n--- 60 秒后刷新 (Ctrl+C 退出) ---'); await sleep(60000); }
  } while (watch);
  if (OWNED && !watch) { // 用完即关：下次运行必然重新 seed，持仓才会真正更新
    await shutdownAuto();
    await sleep(800);
  }
  process.exit(0); // Edge 子进程句柄会挂住事件循环，主动退出
})().catch(async (e) => {
  console.error('失败:', e.message);
  if (OWNED) await shutdownAuto();
  process.exit(1);
});
