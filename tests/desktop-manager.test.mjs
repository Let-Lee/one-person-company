import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { DesktopIpc, DesktopIpcError } from '../src/codex/desktop-ipc.mjs';
import { DesktopManager, applyDesktopPatches } from '../src/desktop-manager.mjs';
import { fixtureEndpoint, restrictSocket } from './ipc-fixture.mjs';

const DESKTOP_MANAGER_THREAD = '00000000-0000-4000-8000-000000000001';

function fixture({ bound = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-desktop-'));
  class Client extends EventEmitter {
    constructor() { super(); this.clientId = null; this.calls = []; this.revision = 1; this.state = { id: DESKTOP_MANAGER_THREAD, turns: [], threadRuntimeStatus: { type: 'idle' } }; }
    async connect() { this.clientId = 'workbench-client'; }
    close() { this.clientId = null; this.emit('disconnected'); }
    emitState({ source = 'desktop-owner', version = 11, thread = DESKTOP_MANAGER_THREAD, change } = {}) {
      this.emit('broadcast', { type: 'broadcast', method: 'thread-stream-state-changed', version, sourceClientId: source, params: { hostId: 'local', conversationId: thread, change: change || { type: 'snapshot', revision: this.revision, conversationState: structuredClone(this.state) } } });
    }
    follow(_thread, _owner, on = true) { if (on) this.emitState(); }
    async request(method, params, options) {
      this.calls.push({ method, params, options });
      if (method === 'thread-owner-discovery') return { handledByClientId: 'desktop-owner', result: { supportsUntrustedAppInput: true } };
      if (method === 'thread-follower-start-turn') {
        if (this.unknown) throw new DesktopIpcError('timeout', { unknown: true });
        const id = params.turnStart.request.clientUserMessageId;
        this.state.turns.push({ turnId: 'real-turn', params: { clientUserMessageId: id }, items: [], status: 'inProgress' });
        this.state.threadRuntimeStatus.type = 'active'; this.emitState();
        return { type: 'response', resultType: 'success', method, handledByClientId: 'desktop-owner', result: { result: { turn: { id: 'real-turn' } } } };
      }
      throw Error('unsupported');
    }
  }
  const client = new Client(); const link = new DesktopManager({ dataDir: dir, client, threadId: bound ? DESKTOP_MANAGER_THREAD : undefined });
  return { dir, client, link, cleanup() { link.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('a fresh desktop connection is unbound, performs no discovery, and an explicit target persists without starting a turn', async () => {
  const f = fixture({ bound: false });
  try {
    assert.equal((await f.link.readStatus()).configured, false);
    assert.equal(f.client.calls.length, 0);
    await assert.rejects(f.link.configure({ threadId: 'invalid' }), /有效的聊天/);
    const configured = await f.link.configure({ threadId: DESKTOP_MANAGER_THREAD, name: '我的经理' });
    assert.equal(configured.ready, true); assert.equal(configured.target.name, '我的经理');
    assert.equal(f.client.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 0);
    const restored = new DesktopManager({ dataDir: f.dir, client: new EventEmitter() });
    assert.equal(restored.snapshot().target.threadId, DESKTOP_MANAGER_THREAD);
    assert.equal(restored.snapshot().target.name, '我的经理');
    await assert.rejects(f.link.configure({ threadId: DESKTOP_MANAGER_THREAD, sender: 'impostor' }), /未知字段/);
    f.link.disconnect();
    assert.equal(new DesktopManager({ dataDir: f.dir, client: new EventEmitter() }).snapshot().configured, false);
  } finally { f.cleanup(); }
});

test('a running or unresolved desktop submission cannot be detached or rebound', async () => {
  const f = fixture();
  try {
    await f.link.send({ requestId: 'request-pending', text: '保留这条消息' });
    assert.throws(() => f.link.disconnect(), /仍在执行/);
    await assert.rejects(f.link.configure({ threadId: '00000000-0000-4000-8000-000000000003' }), /仍在执行/);
    assert.equal(f.link.snapshot().target.threadId, DESKTOP_MANAGER_THREAD);
    f.client.state.threadRuntimeStatus.type = 'idle'; f.client.state.turns[0].status = 'completed'; f.client.emitState();
    f.client.state = { id: '00000000-0000-4000-8000-000000000003', turns: [], threadRuntimeStatus: { type: 'idle' } };
    await f.link.configure({ threadId: f.client.state.id });
    assert.equal(f.link.snapshot().messages.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.link.file)).messages.length, 1);
    await assert.rejects(f.link.send({ requestId: 'request-pending', text: '保留这条消息' }), /另一个聊天/);
  } finally { f.cleanup(); }
});

test('desktop messages bind one owner and current thread, keep native received/result stages and deduplicate sends', async () => {
  const f = fixture();
  try {
    assert.equal((await f.link.readStatus()).ready, true);
    const message = await f.link.send({ requestId: 'request-123', text: '测试消息' });
    assert.equal(message.status, 'received'); assert.ok(message.submittedAt); assert.ok(message.receivedAt);
    const call = f.client.calls.find((c) => c.method === 'thread-follower-start-turn');
    assert.equal(call.params.conversationId, DESKTOP_MANAGER_THREAD);
    assert.equal(call.options.targetClientId, 'desktop-owner');
    assert.equal(call.params.turnStart.request.input[0].text, '测试消息');
    assert.ok(!('model' in call.params.turnStart.request));
    await f.link.send({ requestId: 'request-123', text: '测试消息' });
    assert.equal(f.client.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
    await assert.rejects(f.link.send({ requestId: 'request-123', text: '改正文' }), /不能改变/);
    await assert.rejects(f.link.send({ requestId: 'request-234', text: '并发消息' }), /仍在处理/);
    f.client.state.turns[0].items = [{ type: 'agentMessage', text: '真实回复', phase: 'final_answer' }];
    f.client.state.turns[0].status = 'completed'; f.client.state.threadRuntimeStatus.type = 'idle'; f.client.emitState();
    assert.equal(message.status, 'completed'); assert.equal(message.replyText, '真实回复'); assert.ok(message.completedAt);
    const persisted = JSON.parse(fs.readFileSync(f.link.file)); assert.equal(persisted.messages[0].turnId, 'real-turn');
  } finally { f.cleanup(); }
});

test('a restored valid desktop connection clears stale connection errors', async () => {
  const f = fixture();
  try {
    await f.link.connect();
    f.client.emit('connectionError', new Error('no-client-found'));
    assert.equal(f.link.snapshot().lastError, 'no-client-found');
    f.client.emitState({ source: 'foreign-owner' });
    assert.equal(f.link.snapshot().lastError, 'no-client-found');
    f.client.emitState();
    assert.equal(f.link.snapshot().lastError, null);
    f.client.emit('connectionError', new Error('old error'));
    const status = await f.link.readStatus();
    assert.equal(status.ready, true);
    assert.equal(status.lastError, null);
  } finally { f.cleanup(); }
});

test('foreign source/thread/version events and caller-supplied identity cannot mark a desktop message complete', async () => {
  const f = fixture();
  try {
    await f.link.connect(); await assert.rejects(f.link.send({ requestId: 'request-123', text: '消息', threadId: 'foreign' }), /只接受/);
    const message = await f.link.send({ requestId: 'request-123', text: '消息' });
    f.client.state.turns[0].status = 'completed'; f.client.state.turns[0].items = [{ type: 'agentMessage', text: '伪装回复' }];
    f.client.emitState({ source: 'foreign' }); f.client.emitState({ version: 10 }); f.client.emitState({ thread: 'foreign' });
    assert.equal(message.status, 'received'); assert.equal(message.replyText, '');
  } finally { f.cleanup(); }
});

test('unknown submissions persist and are never automatically resent, even after reconnect or duplicate POST', async () => {
  const f = fixture();
  try {
    f.client.unknown = true;
    const message = await f.link.send({ requestId: 'request-123', text: '消息' }); assert.equal(message.status, 'unknown');
    f.client.close(); await f.link.connect(); await f.link.send({ requestId: 'request-123', text: '消息' });
    assert.equal(f.client.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
    await assert.rejects(f.link.send({ requestId: 'request-234', text: '新消息' }), /等待核实/);
    const reloaded = new DesktopManager({ dataDir: f.dir, client: new EventEmitter() });
    assert.equal(reloaded.messages[0].status, 'unknown');
  } finally { f.cleanup(); }
});

test('desktop patches follow revision and cannot modify object prototypes', async () => {
  const f = fixture();
  try {
    await f.link.connect();
    f.client.emitState({ change: { type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'active' }] } });
    assert.equal(f.link.snapshot().busy, true); assert.equal(f.link.revision, 2);
    assert.throws(() => applyDesktopPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]));
    assert.equal({}.polluted, undefined);
    const before = structuredClone(f.client.state);
    assert.throws(() => applyDesktopPatches(before, [{ op: 'replace', path: ['missing', 'child'], value: true }]));
    assert.deepEqual(before, f.client.state);
  } finally { f.cleanup(); }
});

test('canonical desktop history delivers a matching persisted turn and does not require another model call', async () => {
  const f = fixture();
  try {
    const message = await f.link.send({ requestId: 'request-canonical', text: '页面消息' });
    f.client.state.turns = [];
    f.client.state.turnHistory = { kind: 'canonical', history: { entitiesByKey: {
      unrelated: { turnId: 'unrelated', params: { clientUserMessageId: 'someone-else' }, status: 'completed', items: [{ type: 'agentMessage', text: '其他回复' }] },
      tail: { turnId: 'real-turn', params: { clientUserMessageId: 'request-canonical' }, status: 'completed', turnStartedAtMs: 1791999696000, durationMs: 2000, items: [{ id: 'native-reply', type: 'agentMessage', phase: 'final_answer', text: '页面真实回复' }] },
    } } };
    f.client.state.threadRuntimeStatus.type = 'idle'; f.client.emitState();
    assert.equal(message.replyText, '页面真实回复'); assert.equal(message.status, 'completed');
    assert.deepEqual(message.replyItemIds, ['native-reply']); assert.equal(message.replySource.ownerClientId, 'desktop-owner');
    assert.equal(f.client.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
    f.link.close(); await f.link.connect(); assert.equal(f.link.messages[0].status, 'completed');
  } finally { f.cleanup(); }
});

test('concurrent identical requests make one native call and a disconnected owner invalidates readiness', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.link.send({ requestId: 'request-concurrent', text: '一次消息' }), f.link.send({ requestId: 'request-concurrent', text: '一次消息' })]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(f.client.calls.filter((c) => c.method === 'thread-follower-start-turn').length, 1);
    f.client.emit('broadcast', { type: 'broadcast', method: 'client-status-changed', version: 0, params: { clientId: 'desktop-owner', status: 'disconnected' } });
    assert.equal(f.link.snapshot().ready, false); assert.equal(f.link.ownerClientId, null);
  } finally { f.cleanup(); }
});

test('IPC decodes fragmented frames and rejects response from a mismatched owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-ipc-')); fs.chmodSync(dir, 0o700);
  const socketPath = fixtureEndpoint(dir); const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket); let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => { pending = Buffer.concat([pending, chunk]); while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      const n = pending.readUInt32LE(0), message = JSON.parse(pending.subarray(4, 4 + n)); pending = pending.subarray(4 + n);
      const response = { type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId: message.method === 'initialize' ? 'assigned-client' : 'foreign-owner', result: message.method === 'initialize' ? { clientId: 'assigned-client' } : {} };
      const body = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); const frame = Buffer.concat([header, body]);
      socket.write(frame.subarray(0, 2)); setImmediate(() => socket.write(frame.subarray(2)));
    } });
  });
  await new Promise((r) => server.listen(socketPath, r)); restrictSocket(socketPath);
  const client = new DesktopIpc({ socketPath, timeoutMs: 1000 });
  try {
    await client.connect(); assert.equal(client.clientId, 'assigned-client');
    await assert.rejects(client.request('thread-follower-read-model-settings', { conversationId: DESKTOP_MANAGER_THREAD }, { targetClientId: 'expected-owner' }), /来源/);
    await assert.rejects(async () => client.request('thread/resume', {}), /不支持/);
  } finally { client.close(); for (const s of peers) s.destroy(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('IPC accepts a fragmented desktop history larger than 16 MB and still checks the response owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-large-ipc-')); fs.chmodSync(dir, 0o700);
  const socketPath = fixtureEndpoint(dir), peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket); let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
        const n = pending.readUInt32LE(0), message = JSON.parse(pending.subarray(4, n + 4)); pending = pending.subarray(n + 4);
        const initial = message.method === 'initialize';
        const response = { type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId: initial ? 'assigned-client' : 'expected-owner', result: initial ? { clientId: 'assigned-client' } : { history: 'x'.repeat(17 * 1024 * 1024) } };
        const body = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(header);
        for (let offset = 0; offset < body.length; offset += 32768) socket.write(body.subarray(offset, offset + 32768));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve)); restrictSocket(socketPath);
  const client = new DesktopIpc({ socketPath, timeoutMs: 5000 });
  try {
    await client.connect();
    const result = await client.request('thread-follower-read-model-settings', { conversationId: DESKTOP_MANAGER_THREAD }, { targetClientId: 'expected-owner' });
    assert.equal(result.result.history.length, 17 * 1024 * 1024);
  } finally { client.close(); for (const peer of peers) peer.destroy(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a disconnected desktop during initial follow fails immediately instead of hiding the transport error behind a timeout', async () => {
  const f = fixture();
  try {
    f.client.follow = () => { f.client.emit('connectionError', new DesktopIpcError('桌面消息超过上限')); f.client.close(); };
    const result = await f.link.readStatus();
    assert.equal(result.ready, false); assert.equal(result.lastError, '桌面消息超过上限');
  } finally { f.cleanup(); }
});

test('desktop model label follows exact active turn metadata and never a global default', async () => {
 const f=fixture();try {
  f.client.state.model='global-default';await f.link.readStatus();assert.equal(f.link.snapshot().modelDisplay.text,'待确认');
  f.client.state.turns=[{turnId:'old',status:'completed',params:{model:'old-model'}}];f.client.revision++;f.client.emitState();assert.equal(f.link.snapshot().modelDisplay.text,'上次 · old-model');
  f.client.state.turns.push({turnId:'active',status:'inProgress',params:{}});f.client.revision++;f.client.emitState();assert.equal(f.link.snapshot().modelDisplay.text,'待确认');
  f.client.state.turns[1].params.model='current-model';f.client.revision++;f.client.emitState();assert.equal(f.link.snapshot().modelDisplay.text,'current-model');assert.match(f.link.snapshot().modelDisplay.source,/active/);
  assert.equal(f.client.calls.filter(c=>c.method==='thread-follower-start-turn').length,0);
 }finally{f.cleanup()}
});
