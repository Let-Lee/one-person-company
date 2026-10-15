import fs from 'node:fs';
import path from 'node:path';

const APP_BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/** Resolve the Codex CLI that ships with the desktop app unless CODEX_BIN overrides it. */
export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return unwrapCodexShim(env.CODEX_BIN);
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidates = process.platform === 'win32'
      ? [path.join(dir, 'codex.exe'), path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
      : [path.join(dir, 'codex')];
    for (const candidate of candidates) {
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next installation */ }
    }
  }
  return process.platform === 'darwin' ? APP_BUNDLED : 'codex.exe';
}

function unwrapCodexShim(binary) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(binary)) return binary;
  const entry = path.join(path.dirname(binary), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(entry)) return entry;
  throw Error('CODEX_BIN 请指定 codex.exe 或 Codex 的 bin/codex.js，不能直接启动批处理文件。');
}

export function codexInvocation(binary, args = []) {
  return /\.[cm]?js$/i.test(binary) ? { command: process.execPath, args: [binary, ...args] } : { command: binary, args };
}
