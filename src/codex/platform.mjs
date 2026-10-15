import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function desktopEndpoint(env = process.env, platform = process.platform) {
  if (env.CODEX_DESKTOP_SOCKET) return env.CODEX_DESKTOP_SOCKET;
  if (platform === 'win32') return String.raw`\\.\pipe\codex-ipc`;
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock');
}

export function checkDesktopEndpoint(endpoint, platform = process.platform) {
  if (platform === 'win32') {
    // Local pipes only. A UNC server, TCP endpoint or ordinary file is not a desktop connection.
    if (!/^\\\\\.\\pipe\\[^\\/]+$/i.test(endpoint)) throw Error('Windows 桌面入口须是本机命名管道，例如 \\\\.\\pipe\\codex-ipc');
    return;
  }
  const uid = process.getuid?.(), dir = fs.lstatSync(path.dirname(endpoint)), socket = fs.lstatSync(endpoint);
  if (uid == null || !dir.isDirectory() || dir.uid !== uid || (dir.mode & 0o022) || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077)) {
    throw Error('桌面本机入口的所有者或访问权限不符');
  }
}
