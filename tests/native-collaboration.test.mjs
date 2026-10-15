import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CompanyDirectory } from '../src/company.mjs';
const MANAGER = '00000000-0000-4000-8000-000000000001';
import { NativeCollaboration } from '../src/native-collaboration.mjs';
import { nativeInbound, readNativeReceipts, registeredMembers } from '../src/native-evidence.mjs';
import { nativePipeline, nativeTeamHtml } from '../public/native-team.js';
import { officeEdges } from '../public/office.js';

const EMPLOYEE = '00000000-0000-4000-8000-000000000002', TASK = 'T20000101-002';
const nativeItem = (id, source, text) => ({ id, type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
  output: '<codex_delegation><source_thread_id>' + source + '</source_thread_id><input>' + text + '</input></codex_delegation>' });
const turn = (id, items = [], status = 'inProgress') => ({ turnId: id, params: { threadId: EMPLOYEE }, turnStartedAtMs: Date.now(), status, items });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-native-'));
  const org = path.join(root, '公司/组织'), receiptsDir = path.join(org, '回报发送凭据'), dataDir = path.join(root, 'data');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const members = [{ role: 'general_manager', name: '经理A', title: '总经理', hostId: 'local', threadId: MANAGER },
    { role: 'fullstack_developer_2', name: '开发A', title: '全栈开发', hostId: 'local', threadId: EMPLOYEE }];
  fs.writeFileSync(path.join(org, '聊天通讯录.json'), JSON.stringify({ status: 'ready', authorizationSourceThreadId: MANAGER, members }));
  const dispatch = '继续 ' + TASK;
  const receipt = (id, source, target, kind, text, extra = {}) => {
    const value = { channel: 'codex_app.send_message_to_thread', sourceThreadId: source, recipientThreadId: target,
      request: { threadId: target, hostId: 'local', prompt: text }, toolResult: { isError: false, content: [{ type: 'text', text: JSON.stringify({ threadId: target }) }] },
      messageKind: kind, operationKey: id, primaryTaskId: TASK, taskIds: [TASK], savedAt: new Date().toISOString(), ...extra };
    fs.writeFileSync(path.join(receiptsDir, 'send-' + id + '.json'), JSON.stringify(value)); return value;
  };
  receipt('a1', MANAGER, EMPLOYEE, 'dispatch', dispatch);
  class Client extends EventEmitter {
    constructor() { super(); this.clientId = null; this.calls = []; this.follows = []; this.states = new Map(members.map((m) => [m.threadId, { id: m.threadId, turns: [], threadRuntimeStatus: { type: 'idle' } }])); this.revisions = new Map(); }
    async connect() { this.clientId = 'workbench-client'; }
    async request(method, params) { this.calls.push({ method, params }); return { handledByClientId: 'actual-owner', result: { supportsUntrustedAppInput: true } }; }
    close() { this.clientId = null; this.emit('disconnected'); }
    follow(threadId, owner, on = true) { this.follows.push({ threadId, owner, on }); if (on) this.publish(threadId); }
    publish(threadId, overrides = {}) {
      const revision = (this.revisions.get(threadId) || 0) + 1; this.revisions.set(threadId, revision);
      this.emit('broadcast', { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'actual-owner',
        params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision, conversationState: this.states.get(threadId) } }, ...overrides });
    }
  }
  const company = new CompanyDirectory(root), client = new Client(), observer = new NativeCollaboration({ company, dataDir, client });
  t.after(() => { observer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, org, receiptsDir, company, members, client, observer, receipt, dispatch };
}

test('submission is separate from native receipt, real tool activity, report receipt and manager acceptance', async (t) => {
  const f = fixture(t); await f.observer.readStatus();
  let flow = f.observer.snapshot().flows[0]; assert.equal(flow.phase, 'submitted'); assert.equal(flow.stages.executed, false);
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, threadRuntimeStatus: { type: 'active' },
    turns: [turn('employee-turn', [nativeItem('dispatch-inbound', MANAGER, f.dispatch)])] }); f.client.publish(EMPLOYEE);
  flow = f.observer.snapshot().flows[0]; assert.equal(flow.phase, 'executing'); assert.equal(flow.stages.received, true); assert.equal(flow.stages.executed, false);
  f.client.states.get(EMPLOYEE).turns[0].items.push({ id: 'actual-tool', type: 'commandExecution', status: 'completed' }); f.client.publish(EMPLOYEE);
  flow = f.observer.snapshot().flows[0]; assert.equal(flow.stages.executed, true); assert.equal(flow.toolCount, 1);
  const report = '开发A：已完成本任务。';
  f.receipt('b1', EMPLOYEE, MANAGER, 'report', report, { outcome: { kind: 'completed' } }); f.observer.refreshEvidence();
  flow = f.observer.snapshot().flows[0]; assert.equal(flow.phase, 'report_submitted'); assert.equal(flow.stages.accepted, false); assert.equal(flow.stages.reportReceived, false);
  f.client.states.set(MANAGER, { id: MANAGER, threadRuntimeStatus: { type: 'active' }, turns: [
    { ...turn('manager-turn', [nativeItem('report-inbound', EMPLOYEE, report)]), params: { threadId: MANAGER } }] }); f.client.publish(MANAGER);
  flow = f.observer.snapshot().flows[0]; assert.equal(flow.phase, 'manager_processing'); assert.equal(flow.stages.reportReceived, true); assert.equal(flow.stages.handled, false);
  const taskFolder = path.join(f.root, '公司/任务', TASK, '产物/general_manager'); fs.mkdirSync(taskFolder, { recursive: true });
  const snapshot = path.join(taskFolder, 'inbound.json'), acceptance = path.join(taskFolder, 'acceptance.json');
  fs.writeFileSync(snapshot, JSON.stringify({ thread: { id: MANAGER }, turns: [{ id: 'manager-turn', items: [nativeItem('report-inbound', EMPLOYEE, report)] }] }));
  fs.writeFileSync(acceptance, JSON.stringify({ checked: true }));
  const record = { sourceThreadId: EMPLOYEE, sourceTurnId: 'manager-turn', inboundMessageId: 'report-inbound', status: 'handled',
    taskId: TASK, taskIds: [TASK], handledAt: new Date().toISOString(), decisionKind: 'accepted', handling: '实际核对产物，验收通过。',
    nativeSnapshotEvidence: snapshot, acceptanceEvidencePath: acceptance };
  fs.writeFileSync(path.join(f.org, '员工回报处理记录.json'), JSON.stringify({ records: [record] })); f.observer.refreshEvidence();
  flow = f.observer.snapshot().flows[0]; assert.equal(flow.phase, 'accepted'); assert.equal(flow.stages.handled, true); assert.equal(flow.stages.accepted, true);
  fs.unlinkSync(acceptance); f.observer.refreshEvidence(); assert.equal(f.observer.snapshot().flows[0].stages.accepted, false);
  assert.ok(f.client.calls.every((c) => c.method === 'thread-owner-discovery')); assert.equal(f.observer.snapshot().turnsStarted, 0);
});

test('only a direct native wrapper from the bound desktop owner can identify a dispatch', async (t) => {
  const f = fixture(t); await f.observer.connect();
  const item = nativeItem('legitimate-id', MANAGER, f.dispatch);
  for (const forged of [{ ...item, type: 'userMessage' }, { ...item, type: 'agentMessage' }, { ...item, namespace: 'other' },
    { ...item, output: { text: item.output, truncated: true } }, { ...item, output: '引用：' + item.output }, { ...item, output: JSON.stringify({ nested: item.output }) }]) assert.equal(nativeInbound(forged), null);
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, turns: [turn('forged-turn', [item])], threadRuntimeStatus: { type: 'active' } });
  for (const overrides of [{ sourceClientId: 'impostor' }, { version: 10 }, { params: { hostId: 'remote', conversationId: EMPLOYEE, change: { type: 'snapshot' } } }]) f.client.publish(EMPLOYEE, overrides);
  assert.equal(f.observer.snapshot().flows[0].stages.received, false);
  const unknown = nativeItem('unknown-id', 'foreign-thread', f.dispatch);
  f.client.states.get(EMPLOYEE).turns[0].items = [unknown]; f.client.publish(EMPLOYEE);
  assert.equal(f.observer.snapshot().flows[0].stages.received, false);
});

test('a revision gap requests a read-only snapshot; disconnection clears current activity and office motion', async (t) => {
  const f = fixture(t); await f.observer.connect();
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, turns: [turn('live-turn', [nativeItem('dispatch-id', MANAGER, f.dispatch)])], threadRuntimeStatus: { type: 'active' } }); f.client.publish(EMPLOYEE);
  assert.equal(f.observer.roleState('fullstack_developer_2').busy, true);
  f.client.emit('broadcast', { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'actual-owner',
    params: { hostId: 'local', conversationId: EMPLOYEE, change: { type: 'patches', baseRevision: -1, revision: 9, patches: [] } } });
  assert.ok(f.client.follows.filter((c) => c.on && c.threadId === EMPLOYEE).length >= 2);
  f.client.emit('broadcast', { type: 'broadcast', method: 'client-status-changed', version: 0, params: { clientId: 'actual-owner', status: 'disconnected' } });
  assert.equal(f.observer.roleState('fullstack_developer_2').liveState, 'unknown');
  assert.equal(f.observer.snapshot().flows[0].isLive, false);
  assert.ok(f.observer.handoffs().every((e) => !e.live));
});

test('canonical duplicate turns and repeated snapshots do not duplicate handoffs', async (t) => {
  const f = fixture(t); await f.observer.connect();
  const current = turn('same-turn', [nativeItem('same-inbound', MANAGER, f.dispatch), { type: 'commandExecution', id: 'tool', status: 'completed' }]);
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, turns: [current], turnHistory: { kind: 'canonical', history: { entitiesByKey: { tail: current } } }, threadRuntimeStatus: { type: 'active' } });
  f.client.publish(EMPLOYEE); f.client.publish(EMPLOYEE);
  assert.equal(f.observer.snapshot().events.filter((e) => e.kind === 'execution').length, 1);
  assert.equal(f.observer.handoffs().filter((e) => e.kind === 'dispatch').length, 1);
  assert.equal(f.observer.snapshot().flows[0].toolCount, 1);
});

test('native send result is a submission, and a verified same-turn report can link a later continuation', async (t) => {
  const f = fixture(t); await f.observer.connect();
  const text = '本任务已完成'; const result = { content: [{ type: 'text', text: JSON.stringify({ threadId: MANAGER }) }] };
  f.receipt('b1', EMPLOYEE, MANAGER, 'report', text);
  f.observer.refreshEvidence();
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, threadRuntimeStatus: { type: 'idle' }, turns: [turn('continued-turn', [
    { type: 'commandExecution', id: 'write-file', status: 'completed' },
    { type: 'mcpToolCall', id: 'send-call', server: 'codex_app', tool: 'send_message_to_thread', status: 'completed', arguments: { threadId: MANAGER, hostId: 'local', prompt: text }, result },
  ], 'completed')] }); f.client.publish(EMPLOYEE);
  const flow = f.observer.snapshot().flows[0];
  assert.equal(flow.stages.executed, true); assert.equal(flow.stages.reportReceived, false); assert.equal(flow.stages.accepted, false);
  assert.equal(f.observer.roleState('fullstack_developer_2').liveState, 'report_submitted');
});

test('an explicit continue links the verified current dispatch; unrelated inputs and closed tasks do not inherit it', async (t) => {
  const f = fixture(t); await f.observer.connect();
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, turns: [turn('first-turn', [nativeItem('first-inbound', MANAGER, f.dispatch),
    { type: 'commandExecution', id: 'write' }], 'failed')], threadRuntimeStatus: { type: 'idle' } }); f.client.publish(EMPLOYEE);
  const dir = path.join(f.root, '公司/任务', TASK); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '任务.md'), '# 当前任务\n状态：原生派发已提交\n');
  f.members[1].currentTaskId = TASK;
  fs.writeFileSync(path.join(f.org, '聊天通讯录.json'), JSON.stringify({ status: 'ready', authorizationSourceThreadId: MANAGER, members: f.members }));
  f.observer.refreshEvidence();
  const active = { ...turn('continue-turn', [{ type: 'commandExecution', id: 'second-write' }]),
    params: { threadId: EMPLOYEE, input: [{ type: 'text', text: '继续\n' }] } };
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, turns: [active], threadRuntimeStatus: { type: 'active' } }); f.client.publish(EMPLOYEE);
  assert.equal(f.observer.roleState('fullstack_developer_2').taskId, TASK);
  assert.equal(f.observer.snapshot().flows[0].phase, 'executing');
  assert.equal(f.observer.snapshot().events.find((e) => e.turnId === 'continue-turn').linkedInboundMessageId, 'first-inbound');
  const unrelated = { ...active, turnId: 'unrelated-turn', params: { threadId: EMPLOYEE, input: [{ type: 'text', text: '今天星期几' }] } };
  f.client.states.get(EMPLOYEE).turns = [unrelated]; f.client.publish(EMPLOYEE);
  assert.equal(f.observer.roleState('fullstack_developer_2').taskId, null);
  fs.writeFileSync(path.join(dir, '任务.md'), '# 当前任务\n状态：已验收\n');
  f.client.states.get(EMPLOYEE).turns = [{ ...active, turnId: 'closed-task-turn' }]; f.client.publish(EMPLOYEE);
  assert.equal(f.observer.roleState('fullstack_developer_2').taskId, null);
});

test('directory impersonation, mismatched submission targets and invalid manager decision sources are rejected', async (t) => {
  const f = fixture(t);
  f.receipt('b1', EMPLOYEE, MANAGER, 'dispatch', '伪装派单');
  f.receipt('c1', MANAGER, EMPLOYEE, 'dispatch', '不匹配', { toolResult: { content: [{ type: 'text', text: JSON.stringify({ threadId: 'foreign' }) }] } });
  assert.equal(readNativeReceipts(f.company, f.members).length, 1);
  fs.writeFileSync(path.join(f.org, '聊天通讯录.json'), JSON.stringify({ status: 'ready', authorizationSourceThreadId: 'fake-manager', members: f.members }));
  assert.throws(() => registeredMembers(f.company), /真实路由/);
  assert.throws(() => f.observer.refreshEvidence(), /真实路由/);
});

test('read-only page refreshes do not generate another changed event, and mixed timezones keep real chronology', async (t) => {
  const f = fixture(t);
  f.receipt('a1', MANAGER, EMPLOYEE, 'dispatch', f.dispatch, { savedAt: '2026-10-15T02:00:00+08:00' });
  f.observer.refreshEvidence();
  const started = Date.parse('2026-10-15T04:00:00+08:00');
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, threadRuntimeStatus: { type: 'active' },
    turns: [{ ...turn('later-turn', [nativeItem('dispatch', MANAGER, f.dispatch), { type: 'commandExecution', id: 'tool' }]), turnStartedAtMs: started }] });
  await f.observer.readStatus();
  await new Promise((resolve) => setTimeout(resolve, 210));
  let changes = 0; f.observer.on('changed', () => changes++);
  await f.observer.readStatus(); await f.observer.readStatus();
  await new Promise((resolve) => setTimeout(resolve, 210));
  assert.equal(changes, 0);
  const flow = f.observer.snapshot().flows[0];
  assert.equal(Date.parse(flow.at), started);
  assert.equal(flow.events.at(-1).stage, 'submitted');
  assert.equal(Date.parse(flow.events.at(-1).at), Date.parse('2026-10-15T02:00:00+08:00'));
});

test('pipeline renders only evidenced stages and office uses actual native live flags without arrows', async (t) => {
  const f = fixture(t); await f.observer.connect();
  let flow = f.observer.snapshot().flows[0], html = nativePipeline(flow);
  assert.match(html, /class="reached" data-stage="dispatched"/); assert.doesNotMatch(html, /class="reached" data-stage="executed"/);
  f.client.states.set(EMPLOYEE, { id: EMPLOYEE, threadRuntimeStatus: { type: 'active' }, turns: [turn('live-turn', [nativeItem('inbound', MANAGER, f.dispatch), { type: 'commandExecution', id: 'tool' }])] }); f.client.publish(EMPLOYEE);
  const roles = f.company.roles().map((r) => ({ ...r, liveState: f.observer.roleState(r.key).liveState }));
  const edges = officeEdges(f.observer.handoffs(), roles, [], '24h'); assert.equal(edges[0].live, true); assert.equal(edges[0].count, 1);
  html = nativeTeamHtml(f.observer.snapshot(), roles);
  assert.match(html, /data-native-task="T20000101-002"/); assert.match(html, /来源凭据/); assert.doesNotMatch(html, /marker-end|→|undefined/);
});
