import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('macOS installation handles Unicode ZIP entries under C.UTF-8 and preserves company data on update', {
  skip: process.platform !== 'darwin' || !fs.existsSync(path.join(root, '.git')) ? 'requires a macOS Git checkout' : false,
  timeout: 45000,
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'company-install-'));
  const archive = path.join(tmp, 'source.zip'), home = path.join(tmp, '示例 company');
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(archive, execFileSync('git', ['archive', '--format=zip', '--prefix=one-person-company/', 'HEAD'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }));
  const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PORT: String(port), ONE_PERSON_COMPANY_HOME: home, ONE_PERSON_COMPANY_ARCHIVE: pathToFileURL(archive).href, ONE_PERSON_COMPANY_NO_OPEN: '1', YEWANG_IMPORT_COMPANY: '0', YEWANG_RUNTIME_DIR: path.join(home, 'data/runtime'), CODEX_HOME: path.join(tmp, 'empty-codex') };
  t.after(async () => {
    try { await exec(process.execPath, [path.join(root, 'scripts/manage.mjs'), 'stop', '--json'], { env: { ...env, YEWANG_DATA_DIR: path.join(home, 'data') }, timeout: 15000 }); } catch { /* preserve failure diagnostics */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const install = () => exec('/bin/bash', [path.join(root, 'install.sh')], { cwd: root, env, timeout: 20000 });
  await install();
  for (const file of ['启动.command', '停止.command', '检查.command', '启动.cmd', '停止.cmd', '检查.cmd']) assert.ok(fs.existsSync(path.join(home, 'current', file)), file);
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => (await fetch(base + route)).json();
  assert.equal((await get('/api/setup')).step, 'welcome');
  assert.deepEqual((await get('/api/roles')).roles, []);
  await fetch(base + '/api/setup', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-yewang-workbench': '1' }, body: JSON.stringify({ name: '安装更新后保留' }) });
  await install();
  assert.equal((await get('/api/setup')).name, '安装更新后保留');
  assert.deepEqual((await get('/api/runs')).runs, []);
  assert.equal(fs.existsSync(path.join(home, 'data/desktop-manager.json')), false);
});
