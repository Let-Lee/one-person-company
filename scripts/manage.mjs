#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { resolveCodexBin } from '../src/codex/codex-bin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.YEWANG_DATA_DIR || path.join(root, '.data'));
const runtimeDir = path.resolve(process.env.YEWANG_RUNTIME_DIR || path.join(dataDir, 'runtime'));
const file = path.join(runtimeDir, 'server.json');
const port = Number(process.env.PORT || 4318);
const url = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = process.argv[2] || 'start';
const json = process.argv.includes('--json');
const print = (value, message) => console.log(json ? JSON.stringify(value) : message);
function record() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
async function health() {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    return response.ok && value.app === 'one-person-company' ? value : null;
  } catch { return null; }
}
const same = (saved, live) => Boolean(saved && live && saved.instanceId === live.instanceId && saved.port === port);
function alive(pid) { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } }
function openPage() {
  if (!process.argv.includes('--open') || process.env.ONE_PERSON_COMPANY_NO_OPEN === '1') return;
  if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}
async function start() {
  const previous = record(), live = await health();
  if (!live && previous && alive(previous.pid)) throw Error('已有进程尚未通过状态检查，保留原启动记录，请先核对日志。');
  if (live) {
    if (!same(previous, live)) throw Error(`端口 ${port} 已有另一个公司实例，请先停止它，或用 PORT 指定其他端口。`);
    print({ running: true, reused: true, pid: previous.pid, url }, `公司已经运行：${url}`); openPage(); return;
  }
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const instanceId = randomUUID();
  const logFile = path.join(runtimeDir, 'server.log');
  const fd = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], {
    cwd: root, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port), YEWANG_DATA_DIR: dataDir, YEWANG_NO_AUTOSTART: '1', ONE_PERSON_COMPANY_INSTANCE: instanceId },
  });
  fs.closeSync(fd); child.unref();
  let startupError; child.on('error', (error) => { startupError = error; });
  const saved = { pid: child.pid, port, instanceId, startedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await health();
    if (same(saved, current)) { print({ running: true, reused: false, pid: child.pid, url }, `你的公司已启动：${url}`); openPage(); return; }
    if (startupError || child.exitCode != null) break;
    await delay(150);
  }
  if (record()?.instanceId === instanceId) fs.unlinkSync(file);
  throw Error(`启动未完成，请检查端口 ${port} 和日志：${logFile}${startupError ? '。' + startupError.message : ''}`);
}
async function stop() {
  const saved = record(), live = await health();
  if (!saved) { print({ running: Boolean(live), stopped: false }, live ? '此目录没有该实例的启动记录，不会停止其他公司。' : '公司当前未运行。'); return; }
  if (!same(saved, live)) {
    if (!live) { if (alive(saved.pid)) throw Error('原进程仍存在但无法确认连接，已保留记录，没有强制停止。'); fs.unlinkSync(file); print({ running: false, stopped: false }, '公司已停止，清理了过期启动记录。'); return; }
    throw Error('当前端口与启动记录不匹配，不会停止其他进程。');
  }
  process.kill(saved.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!same(saved, await health())) {
      if (record()?.instanceId === saved.instanceId) fs.unlinkSync(file);
      print({ running: false, stopped: true }, '公司已停止，岗位、任务与设置已保留。'); return;
    }
    await delay(150);
  }
  throw Error('服务尚未退出，请稍后检查；没有强制终止其他进程。');
}
function doctor() {
  const node = Number(process.versions.node.split('.')[0]) >= 20;
  const codex = resolveCodexBin(); let codexVersion = null;
  try { fs.accessSync(codex, fs.constants.X_OK); codexVersion = execFileSync(codex, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* report only */ }
  const socketPath = process.env.CODEX_DESKTOP_SOCKET || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc/ipc.sock');
  let desktopAvailable = false;
  try { desktopAvailable = fs.lstatSync(socketPath).isSocket(); } catch { /* desktop may be closed */ }
  const result = { node, nodeVersion: process.versions.node, platform: process.platform, codexAvailable: Boolean(codexVersion), codexVersion, desktopAvailable };
  print(result, `Node.js：${process.versions.node}${node ? '' : '（需要 20 或以上）'}\nCodex：${codexVersion || '未找到，请安装 Codex 或设置 CODEX_BIN'}\n桌面入口：${desktopAvailable ? '已找到，实际连接请在页面中检查' : '尚未找到，桌面模式请先打开 Codex'}\n检查不会登录账号或运行模型任务。`);
  if (!node || !codexVersion) process.exitCode = 1;
}

try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw Error('需要 Node.js 20 或以上版本。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须是 1 至 65535 的整数。');
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'status') { const live = await health(); print({ running: same(record(), live), portOccupiedByCompany: Boolean(live), url }, same(record(), live) ? `公司正在运行：${url}` : '此目录的公司未运行。'); }
  else if (command === 'doctor') doctor();
  else throw Error('用法：node scripts/manage.mjs start|stop|status|doctor [--open] [--json]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
