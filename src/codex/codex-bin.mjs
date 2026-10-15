import fs from 'node:fs';
import path from 'node:path';

const APP_BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

/** Resolve the Codex CLI that ships with the desktop app unless CODEX_BIN overrides it. */
export function resolveCodexBin(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'codex');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return APP_BUNDLED;
}
