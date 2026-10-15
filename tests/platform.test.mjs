import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopEndpoint, checkDesktopEndpoint } from '../src/codex/platform.mjs';
import { codexInvocation } from '../src/codex/codex-bin.mjs';

test('Windows desktop transport accepts only a local named pipe and never a remote host or regular file', () => {
  const endpoint = desktopEndpoint({}, 'win32');
  assert.equal(endpoint, String.raw`\\.\pipe\codex-ipc`);
  assert.doesNotThrow(() => checkDesktopEndpoint(endpoint, 'win32'));
  for (const invalid of [String.raw`\\remote\pipe\codex-ipc`, '127.0.0.1:4318', String.raw`C:\temp\ipc.sock`, String.raw`\\.\pipe\..\file`]) {
    assert.throws(() => checkDesktopEndpoint(invalid, 'win32'), /本机命名管道/);
  }
});

test('a JavaScript Codex installation launches through Node and preserves arguments with spaces without a shell', () => {
  const file = String.raw`C:\Program Files\Codex\bin\codex.js`, args = ['app-server', '-c', 'value="a b"'];
  assert.deepEqual(codexInvocation(file, args), { command: process.execPath, args: [file, ...args] });
  assert.deepEqual(codexInvocation('codex.exe', args), { command: 'codex.exe', args });
});
