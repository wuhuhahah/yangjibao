#!/usr/bin/env node
/**
 * 养基宝插件数据读取工具（零依赖，Node >= 22）
 *
 * 主路径（默认）：直接解析插件在本地的存储数据库（LevelDB 的 .log 文件）。
 *   持仓、token、账户数据都是明文 JSON，按 LevelDB 的 WriteBatch 格式解出来即可。
 *   ★ 不需要关闭 Edge，不需要启动浏览器，秒级完成。
 *
 * 兜底路径：若直读失败（.log 被清空 / 数据已 compaction 进 .sst / 文件夹不存在），
 *   回退到 CDP 方案 —— 把插件存储拷到独立 profile，另起一个 Edge 用
 *   chrome.storage.local.get(null) 读。这条路要求 Edge 完全退出。
 *
 * 用法：
 *   node yjb.js          读取一次并保存 yjb-data.json
 *   node yjb.js --watch  每 60 秒读一次，持续更新 yjb-data.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
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

// ---------- 主路径：直接解析插件数据库（Edge 开着也照样读）----------
function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) return [null, pos];
  }
  return [null, pos];
}

function parseLogRecords(buf) { // .log → 拼接完整的 WriteBatch 记录
  const BLOCK = 32768;
  const out = [];
  let pos = 0, cur = [];
  while (pos + 7 <= buf.length) {
    const off = pos % BLOCK;
    if (off + 7 > BLOCK) { pos += BLOCK - off; continue; } // 块尾不足 7 字节，跳过填充
    const len = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6]; // 1=FULL 2=FIRST 3=MIDDLE 4=LAST 0=ZERO
    pos += 7;
    if (type === 0) continue;
    const frag = buf.subarray(pos, pos + len);
    pos += len;
    if (type === 1) { out.push(frag); cur = []; }
    else if (type === 2) cur = [frag];
    else if (type === 3) cur.push(frag);
    else if (type === 4) { cur.push(frag); out.push(Buffer.concat(cur)); cur = []; }
  }
  return out;
}

function parseWriteBatch(rec) { // WriteBatch → [[key, value], ...]
  const items = [];
  if (rec.length < 12) return items;
  const count = rec.readUInt32LE(8);
  let p = 12; // 跳过 8 字节 sequence + 4 字节 count
  for (let i = 0; i < count && p < rec.length; i++) {
    if (rec[p++] !== 1) break; // 只处理 kTypeValue
    const [kl, p1] = readVarint(rec, p);
    if (kl === null || p1 + kl > rec.length) break;
    const [vl, p2] = readVarint(rec, p1 + kl);
    if (vl === null || p2 + vl > rec.length) break;
    items.push([rec.subarray(p1, p1 + kl).toString('utf8'),
                rec.subarray(p2, p2 + vl).toString('utf8')]);
    p = p2 + vl;
  }
  return items;
}

function readStorageFromDisk() { // 等价于 chrome.storage.local.get(null)，但不碰浏览器
  if (!fs.existsSync(REAL_STORAGE)) throw new Error('找不到插件数据目录 ' + REAL_STORAGE);
  const logs = fs.readdirSync(REAL_STORAGE)
    .filter((f) => /^\d+\.log$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10)); // 编号升序：后写的覆盖先写的
  if (!logs.length) throw new Error('插件目录里没有 .log 文件（可能刚从 .sst 恢复，重开一次 Edge 即可）');
  const raw = {};
  for (const f of logs) {
    const buf = fs.readFileSync(path.join(REAL_STORAGE, f));
    for (const rec of parseLogRecords(buf))
      for (const [k, v] of parseWriteBatch(rec)) raw[k] = v;
  }
  const data = {};
  for (const [k, v] of Object.entries(raw)) {
    try { data[k] = JSON.parse(v); } catch { data[k] = v; } // 值统一是 JSON 编码
  }
  if (!data.fundList) throw new Error('数据库里没有 fundList（插件可能还没登录或没写过持仓）');
  return data;
}

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
  const watch = process.argv.includes('--watch');
  let fallbackWs = null;
  const syncOnce = async () => {
    try {
      const d = readStorageFromDisk();
      console.log('[直读] 已从插件数据库直接读取（未启动浏览器）');
      return d;
    } catch (e) {
      console.warn('[直读] 失败: ' + e.message);
      console.warn('[直读] 回退浏览器方案，要求 Edge 完全退出…');
      if (!fallbackWs) fallbackWs = await ensureEdge();
      return await dumpOnce(fallbackWs);
    }
  };
  do {
    const data = await syncOnce();
    fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
    summarize(data);
    if (watch) { console.log('\n--- 60 秒后刷新 (Ctrl+C 退出) ---'); await sleep(60000); }
  } while (watch);
  if (OWNED && !watch) { // 用完即关：下次运行必然重新 seed
    await shutdownAuto();
    await sleep(800);
  }
  process.exit(0); // Edge 子进程句柄会挂住事件循环，主动退出
})().catch(async (e) => {
  console.error('失败:', e.message);
  if (OWNED) await shutdownAuto();
  process.exit(1);
});
