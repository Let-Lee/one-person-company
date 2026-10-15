import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createWorkbench, createServer } from '../src/app.mjs';
import { DesktopManager } from '../src/desktop-manager.mjs';
import { DesktopIpc } from '../src/codex/desktop-ipc.mjs';
import { fixtureEndpoint, restrictSocket } from './ipc-fixture.mjs';

test('a personal company can bind a desktop chat through HTTP and enter desktop mode with zero independent roles or turns', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-company-desktop-')); fs.chmodSync(tmp, 0o700);
  const socketPath = fixtureEndpoint(tmp), peers = new Set(), requests = [];
  const desktop = net.createServer((socket) => {
    peers.add(socket); let buffer = Buffer.alloc(0);
    const send = (value) => { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body])); };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const n = buffer.readUInt32LE(0), m = JSON.parse(buffer.subarray(4, n + 4)); buffer = buffer.subarray(n + 4); requests.push(m);
        if (m.type === 'request') send({ type: 'response', requestId: m.requestId, method: m.method, resultType: 'success', handledByClientId: m.method === 'initialize' ? 'local-client' : 'desktop-owner', result: m.method === 'initialize' ? { clientId: 'local-client' } : { supportsUntrustedAppInput: true } });
        else if (m.method === 'thread-stream-following-changed' && m.params.following) send({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop-owner', params: { hostId: 'local', conversationId: m.params.conversationId, change: { type: 'snapshot', revision: 1, conversationState: { id: m.params.conversationId, turns: [], threadRuntimeStatus: { type: 'idle' } } } } });
      }
    });
  });
  await new Promise((resolve) => desktop.listen(socketPath, resolve)); restrictSocket(socketPath);
  const env = { YEWANG_DATA_DIR: path.join(tmp, 'data'), YEWANG_WORKSPACES_ROOT: path.join(tmp, 'workspaces') };
  const ctx = createWorkbench({ env });
  const manager = new DesktopManager({ dataDir: env.YEWANG_DATA_DIR, client: new DesktopIpc({ socketPath, timeoutMs: 1000 }) });
  const server = createServer({ workbench: ctx.workbench, paths: ctx.paths, desktopManager: manager, nativeCollaboration: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); manager.close(); await ctx.runtime.stop(); for (const peer of peers) peer.destroy(); await new Promise((resolve) => desktop.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body) => { const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', 'x-yewang-workbench': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  assert.equal((await api('POST', '/api/setup/desktop', {})).status, 409);
  assert.equal(requests.length, 0);
  assert.equal((await api('PUT', '/api/desktop-connection', { threadId: 'invalid' })).status, 400);
  const linked = await api('PUT', '/api/desktop-connection', { threadId: '00000000-0000-4000-8000-000000000001', socketPath, name: '我的桌面经理' });
  assert.equal(linked.data.ready, true); assert.equal(linked.data.configured, true);
  const setup = (await api('POST', '/api/setup/desktop', {})).data;
  assert.equal(setup.executionMode, 'desktop'); assert.equal(setup.required, false); assert.equal(setup.managerEntry, '#/manager');
  assert.equal(setup.roleCount, 0); assert.deepEqual((await api('GET', '/api/sessions')).data.sessions, []); assert.deepEqual((await api('GET', '/api/runs')).data.runs, []);
  assert.equal(ctx.runtime.snapshot().status, 'stopped'); assert.ok(!requests.some((r) => r.method === 'thread-follower-start-turn'));
  const independent = (await api('POST', '/api/setup/independent', {})).data;
  assert.equal(independent.executionMode, 'independent'); assert.equal(independent.required, true); assert.equal(independent.step, 'connection');
  assert.equal(independent.desktopConnection.configured, true); assert.equal(independent.roleCount, 0);
});
