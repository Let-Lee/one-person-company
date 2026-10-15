import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkbench } from '../src/app.mjs';

// Controlled protocol fixture, deliberately separate from the real-model acceptance.
class Runtime extends EventEmitter {
  constructor() { super(); this.status = 'ready'; this.threads = new Map(); this.turns = new Map(); this.responses = new Map(); this.seq = 0; this.throwNextResponse = false; }
  snapshot() { return { status: this.status }; }
  async ensureStarted() { this.status = 'ready'; return this; }
  async stop() { this.status = 'stopped'; this.emit('exit', { code: 0 }); }
  async startThread(params) {
    await Promise.resolve();
    const thread = { id: `fixture-thread-${++this.seq}`, status: { type: 'idle' } };
    this.threads.set(thread.id, params);
    return { thread, cwd: params.cwd, model: 'fixture', modelProvider: 'fixture' };
  }
  async setThreadName() {}
  async archiveThread() {}
  async resumeThread(threadId) { this.threads.set(threadId, {}); return { thread: { id: threadId, status: { type: 'idle' } } }; }
  isLoaded(id) { return this.threads.has(id); }
  async listSkills(cwds) { return { data: [{ cwd: cwds[0], skills: [] }] }; }
  async startTurn({ threadId, input }) {
    const turn = { id: `fixture-turn-${++this.seq}`, status: 'inProgress' };
    this.turns.set(threadId, turn.id);
    queueMicrotask(() => {
      this.emit('notification', { method: 'turn/started', params: { threadId, turn } });
      this.emit('notification', { method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'userMessage', id: `input-${turn.id}`, content: input } } });
    });
    return { turn };
  }
  async interruptTurn(threadId, turnId) { this.finish(threadId, 'interrupted', turnId); }
  respond(id, response) { if (this.throwNextResponse) { this.throwNextResponse = false; throw new Error('fixture disconnected before response'); } this.responses.set(id, response); }
  respondError(id, code, message) { this.responses.set(id, { error: { code, message } }); }
  call(session, tool, args, overrides = {}) {
    const rpcId = `rpc-${++this.seq}`;
    const message = { id: rpcId, method: 'item/tool/call', params: { threadId: session.threadId, turnId: this.turns.get(session.threadId), callId: `call-${this.seq}`, namespace: null, tool, arguments: args, ...overrides } };
    this.emit('serverRequest', message);
    const response = this.responses.get(rpcId);
    return { message, response, result: response?.contentItems ? JSON.parse(response.contentItems[0].text) : null };
  }
  command(session, output = 'actual fixture file') {
    this.emit('notification', { method: 'item/completed', params: { threadId: session.threadId, turnId: this.turns.get(session.threadId), item: { type: 'commandExecution', id: `cmd-${++this.seq}`, command: 'read fixture file', cwd: session.cwd, exitCode: 0, status: 'completed', aggregatedOutput: output } } });
  }
  finish(threadId, status = 'completed', turnId = this.turns.get(threadId)) {
    this.emit('notification', { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `final-${turnId}`, text: 'fixture result', phase: 'final_answer' } } });
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [] } } });
  }
}

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }
async function fixture(t, suffix = 'one') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-team-'));
  const env = { YEWANG_DATA_DIR: path.join(root, 'data'), YEWANG_WORKSPACES_ROOT: path.join(root, 'ws'), YEWANG_COMPANY_ROOT: path.join(root, 'company') };
  fs.mkdirSync(env.YEWANG_COMPANY_ROOT);
  const runtime = new Runtime();
  const ctx = createWorkbench({ env, runtime });
  const wb = ctx.workbench;
  const namespace = `test-${suffix}`;
  const manager = wb.saveLocalRole({ name: '管理测试', title: '测试总经理', collaboration: { namespace, authority: 'manager' } });
  const employee = wb.saveLocalRole({ name: '执行测试', title: '测试员工', collaboration: { namespace, authority: 'employee' } });
  const managerSession = await wb.createSession({ roleKey: manager.key });
  const employeeSession = await wb.createSession({ roleKey: employee.key });
  t.after(() => { if (ctx.store.timer) clearTimeout(ctx.store.timer); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...ctx, root, env, runtime, wb, namespace, manager, employee, managerSession, employeeSession };
}
const dispatchArgs = (f, n = 'one') => ({ requestId: `dispatch-${n}`, toRole: f.employee.key, title: `fixture ${n}`, prompt: `Create ${n}.txt in the test workspace`, collaborators: [] });
async function startManager(f, requestId = 'user-one') { await f.wb.dispatch({ sessionId: f.managerSession.id, prompt: 'fixture task', requestId }); await tick(); }
async function assign(f, n = 'one') { await startManager(f, `user-${n}`); const call = f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f, n)); assert.equal(call.response.success, true); return call; }
async function deliver(f, task, n = 'one') {
  fs.writeFileSync(path.join(f.employeeSession.cwd, `${n}.txt`), `fixture content ${n}`);
  f.runtime.command(f.employeeSession);
  const report = f.runtime.call(f.employeeSession, 'yewang_report', { requestId: `report-${n}`, taskId: task.result.taskId, kind: 'completed', summary: `created ${n}.txt`, artifacts: [`${n}.txt`] });
  assert.equal(report.response.success, true, report.result?.error);
  return report;
}

test('tools are registered only on immutable test bindings; stable sessions and workspace bounds are enforced', async (t) => {
  const f = await fixture(t);
  assert.ok(f.runtime.threads.get(f.managerSession.threadId).dynamicTools.some((s) => s.name === 'yewang_dispatch'));
  assert.ok(!f.runtime.threads.get(f.employeeSession.threadId).dynamicTools.some((s) => s.name === 'yewang_dispatch'));
  await assert.rejects(f.wb.createSession({ roleKey: f.employee.key }), /稳定会话/);
  assert.throws(() => f.wb.saveLocalRole({ name: '冒名', title: '总经理', collaboration: { namespace: f.namespace, authority: 'manager' } }), /只能有一位/);
  assert.throws(() => f.wb.saveLocalRole({ key: f.employee.key, name: '改权限', title: '经理', collaboration: { namespace: f.namespace, authority: 'manager' } }), /不可更改/);
  assert.throws(() => f.wb.saveLocalRole({ name: '正式经理', title: '经理', collaboration: { namespace: 'production', authority: 'manager' } }), /test-/);
  await assert.rejects(f.wb.dispatch({ sessionId: f.employeeSession.id, prompt: 'console employee', dispatcherLabel: '总经理' }), /只接收/);
  const another = f.wb.saveLocalRole({ name: '第三', title: '员工', collaboration: { namespace: f.namespace, authority: 'employee' } });
  await assert.rejects(f.wb.createSession({ roleKey: another.key, cwd: f.paths.defaultWorkspace }), /所属测试组/);
  await assert.rejects(f.wb.createSession({ roleKey: another.key, sandbox: 'danger-full-access' }), /工作区沙箱/);
  const simultaneous = await Promise.allSettled([f.wb.createSession({ roleKey: another.key }), f.wb.createSession({ roleKey: another.key })]);
  assert.equal(simultaneous.filter((r) => r.status === 'fulfilled').length, 1);
});

test('forged sender fields, old turns, unknown threads and a foreign connection cannot dispatch', async (t) => {
  const f = await fixture(t);
  await startManager(f);
  const fakeName = f.runtime.call(f.managerSession, 'yewang_dispatch', { ...dispatchArgs(f), sourceThreadId: f.managerSession.threadId });
  assert.equal(fakeName.response.success, false);
  assert.match(fakeName.result.error, /自填来源/);
  assert.equal(f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f), { turnId: 'old-turn' }).response.success, false);
  assert.equal(f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f), { threadId: 'unknown-thread' }).response.success, false);
  const message = { params: { threadId: f.managerSession.threadId, turnId: f.runtime.turns.get(f.managerSession.threadId), callId: 'forged-conn', namespace: null, tool: 'yewang_dispatch', arguments: dispatchArgs(f) } };
  assert.throws(() => f.wb.collaboration.handle(message, new Runtime(), f.runtime), /唯一协作会话/);
  assert.equal(Object.keys(f.store.state.collaboration.tasks).length, 0);
});

test('dispatch receipts survive unknown responses and duplicate tool calls without repeating work', async (t) => {
  const f = await fixture(t);
  await startManager(f);
  f.runtime.throwNextResponse = true;
  const lost = f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f));
  assert.equal(lost.response, undefined);
  f.runtime.emit('serverRequest', lost.message);
  assert.equal(f.runtime.responses.get(lost.message.id).success, true);
  const repeated = f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f));
  assert.equal(repeated.result.replayed, true);
  assert.equal(Object.keys(f.store.state.collaboration.tasks).length, 1);
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.teamTaskId).length, 1);
  const conflict = f.runtime.call(f.managerSession, 'yewang_dispatch', { ...dispatchArgs(f), prompt: 'different contents' });
  assert.equal(conflict.response.success, false);
  assert.match(conflict.result.error, /重复操作编号/);
  const saved = JSON.parse(fs.readFileSync(f.store.file));
  assert.equal(Object.keys(saved.collaboration.operations).length, 1);
  assert.equal(Object.values(saved.collaboration.operations)[0].origin.threadId, f.managerSession.threadId);
});

test('task delivery, manager wake, actual artifact review and every page reference share one result', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  assert.equal(f.store.state.runs[assigned.result.runId].status, 'queued', 'manager must release the workspace lock');
  f.runtime.finish(f.managerSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.tasks[assigned.result.taskId].status, 'running');
  const report = await deliver(f, assigned);
  assert.equal(report.result.status, 'staged');
  assert.equal(f.store.state.collaboration.tasks[assigned.result.taskId].deliveredAt, null);
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.kind === 'inbox').length, 0);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  const task = f.store.state.collaboration.tasks[assigned.result.taskId];
  assert.equal(task.status, 'delivered');
  assert.equal(task.reportMessageId, report.result.messageId);
  const preview = f.wb.collaboration.readArtifact(report.result.messageId, 0);
  assert.equal(preview.content, 'fixture content one');
  assert.equal(preview.taskId, task.id);
  assert.throws(() => f.wb.collaboration.readArtifact(report.result.messageId, 100), /不存在/);
  const inbox = f.runtime.call(f.managerSession, 'yewang_inbox', {});
  assert.ok(inbox.result.messages.some((m) => m.id === report.result.messageId));
  const premature = f.runtime.call(f.managerSession, 'yewang_review', { requestId: 'review-no-read', taskId: task.id, decision: 'accept', summary: 'done' });
  assert.equal(premature.response.success, false);
  f.runtime.command(f.managerSession, fs.readFileSync(path.join(f.employeeSession.cwd, 'one.txt'), 'utf8'));
  const accepted = f.runtime.call(f.managerSession, 'yewang_review', { requestId: 'review-one', taskId: task.id, decision: 'accept', summary: 'read and checked fixture file' });
  assert.equal(accepted.result.status, 'accepted');
  f.runtime.finish(f.managerSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.messages[report.result.messageId].status, 'handled');
  const edge = f.wb.handoffs().find((h) => h.id === report.result.messageId);
  assert.equal(edge.taskId, task.id);
  assert.equal(edge.runId, report.message.params && f.employeeSession.lastRunId);
  assert.equal(edge.toRole, f.manager.key);
  assert.ok(task.acceptedAt && task.startedAt && task.submittedAt && task.deliveredAt);
});

test('busy managers retain and merge reports after releasing their execution slot', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  const second = f.runtime.call(f.managerSession, 'yewang_dispatch', dispatchArgs(f, 'two'));
  assert.equal(second.response.success, true);
  f.runtime.finish(f.managerSession.threadId); await tick();
  await f.wb.dispatch({ sessionId: f.managerSession.id, prompt: 'another user request', requestId: 'busy-manager' });
  const report = await deliver(f, assigned);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.messages[report.result.messageId].status, 'unread');
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.kind === 'inbox').length, 0);
  const secondReport = await deliver(f, second, 'two');
  f.runtime.finish(f.employeeSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.messages[secondReport.result.messageId].status, 'unread');
  f.runtime.finish(f.managerSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.messages[report.result.messageId].status, 'processing');
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.kind === 'inbox').length, 1);
  const wake = Object.values(f.store.state.runs).find((run) => run.kind === 'inbox');
  assert.equal(wake.managerMessageIds.length, 2);
});

test('a paused manager inbox survives restart and only wakes after an explicit resume', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  const pending = await f.wb.dispatch({ sessionId: f.managerSession.id, prompt: 'queued manager request', requestId: 'manager-pause' });
  await f.wb.interrupt(pending.id, 'pause');
  const report = await deliver(f, assigned);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  assert.equal(f.managerSession.wakePaused, true);
  assert.equal(f.store.state.collaboration.messages[report.result.messageId].status, 'unread');
  const recovered = createWorkbench({ env: f.env, runtime: new Runtime() });
  t.after(() => { if (recovered.store.timer) clearTimeout(recovered.store.timer); });
  recovered.workbench.collaboration.flushInboxes(); await tick();
  assert.equal(Object.values(recovered.store.state.runs).filter((run) => run.kind === 'inbox').length, 0);
  recovered.workbench.collaboration.resumeInbox(f.managerSession.id); await tick();
  assert.equal(Object.values(recovered.store.state.runs).filter((run) => run.kind === 'inbox').length, 1);
  assert.equal(recovered.store.state.collaboration.tasks[assigned.result.taskId].status, 'delivered');
});

test('project write locks serialize one workspace while the global limit remains capped at three', async (t) => {
  const f = await fixture(t);
  await startManager(f);
  const sessions = [];
  for (let index = 0; index < 4; index++) {
    const role = f.wb.saveLocalRole({ name: `other-${index}`, title: '测试总经理', collaboration: { namespace: `test-limit-${index}`, authority: 'manager' } });
    sessions.push(await f.wb.createSession({ roleKey: role.key }));
  }
  for (const session of sessions) await f.wb.dispatch({ sessionId: session.id, prompt: 'hold project lock' });
  await tick();
  assert.equal(f.wb.activeCount(), 3);
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.status === 'queued').length, 2);
  f.runtime.finish(f.managerSession.threadId); await tick();
  assert.equal(f.wb.activeCount(), 3);
});

test('pause fences late reports and completion events; explicit resume reuses the employee thread', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  const oldTurnId = f.runtime.turns.get(f.employeeSession.threadId);
  const paused = await f.wb.collaboration.controlFromConsole(assigned.result.taskId, 'pause');
  assert.equal(paused.status, 'paused');
  const late = f.runtime.call(f.employeeSession, 'yewang_report', { requestId: 'late', taskId: assigned.result.taskId, kind: 'blocked', summary: 'late message', artifacts: [] }, { turnId: oldTurnId });
  assert.equal(late.response.success, false);
  f.runtime.finish(f.employeeSession.threadId, 'completed', oldTurnId); await tick();
  assert.equal(f.store.state.collaboration.tasks[assigned.result.taskId].status, 'paused');
  assert.equal(Object.values(f.store.state.runs).filter((run) => run.kind === 'inbox').length, 0);
  const resumed = await f.wb.collaboration.controlFromConsole(assigned.result.taskId, 'resume'); await tick();
  assert.equal(resumed.status, 'submitted');
  const task = f.store.state.collaboration.tasks[assigned.result.taskId];
  assert.equal(task.runIds.length, 2);
  assert.equal(f.store.state.runs[task.runIds[1]].threadId, f.employeeSession.threadId);
  f.runtime.finish(f.employeeSession.threadId, 'completed', oldTurnId);
  assert.equal(f.store.state.runs[task.runIds[1]].status, 'running', 'old turn completion cannot finish new execution');
  await f.wb.collaboration.controlFromConsole(task.id, 'cancel');
  await assert.rejects(f.wb.collaboration.controlFromConsole(task.id, 'resume'), /已取消/);
});

test('restarts preserve receipts, interrupt unfinished work and do not mark claims delivered', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  f.store.save();
  const newRuntime = new Runtime();
  const recovered = createWorkbench({ env: f.env, runtime: newRuntime });
  t.after(() => { if (recovered.store.timer) clearTimeout(recovered.store.timer); });
  const task = recovered.store.state.collaboration.tasks[assigned.result.taskId];
  assert.equal(task.status, 'interrupted');
  assert.equal(task.deliveredAt, null);
  assert.equal(recovered.workbench.activeCount(), 0);
  assert.equal(Object.keys(recovered.store.state.collaboration.operations).length, 1);
  recovered.workbench.collaboration.flushInboxes();
  assert.equal(newRuntime.turns.size, 0);
});

test('missing reporting tools and completion claims produce a concrete blocker rather than fake delivery', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  f.runtime.command(f.employeeSession);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  const task = f.store.state.collaboration.tasks[assigned.result.taskId];
  assert.equal(task.status, 'blocked');
  assert.equal(task.deliveredAt, null);
  assert.match(f.store.state.collaboration.messages[task.reportMessageId].summary, /未提交.*工具/);
  const denied = f.runtime.call(f.managerSession, 'yewang_review', { requestId: 'accept-claim', taskId: task.id, decision: 'accept', summary: 'believe claim' });
  assert.equal(denied.response.success, false);
});

test('artifact symlinks, changed delivered files and cross-task cooperation are denied', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  const file = path.join(f.root, 'outside.txt'); fs.writeFileSync(file, 'private fixture');
  fs.symlinkSync(file, path.join(f.employeeSession.cwd, 'outside.txt'));
  f.runtime.command(f.employeeSession);
  const outside = f.runtime.call(f.employeeSession, 'yewang_report', { requestId: 'outside', taskId: assigned.result.taskId, kind: 'completed', summary: 'outside', artifacts: ['outside.txt'] });
  assert.equal(outside.response.success, false);
  const collab = f.runtime.call(f.employeeSession, 'yewang_collaborate', { requestId: 'unauthorized', taskId: assigned.result.taskId, toRole: f.manager.key, message: 'try to order manager' });
  assert.equal(collab.response.success, false);
  await deliver(f, assigned);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  fs.writeFileSync(path.join(f.employeeSession.cwd, 'one.txt'), 'changed after delivery');
  assert.throws(() => f.wb.collaboration.readArtifact(f.store.state.collaboration.tasks[assigned.result.taskId].reportMessageId, 0), /文件已.*变化/);
  f.runtime.command(f.managerSession);
  const denied = f.runtime.call(f.managerSession, 'yewang_review', { requestId: 'accept-changed', taskId: assigned.result.taskId, decision: 'accept', summary: 'accept' });
  assert.equal(denied.response.success, false);
  assert.match(denied.result.error, /文件已变化/);
});

test('console request replay is persistent; parallel same-session submissions only start one turn', async (t) => {
  const f = await fixture(t);
  const body = { requestId: 'same-user-request', sessionId: f.managerSession.id, prompt: 'same contents' };
  const [a, b] = await Promise.all([f.wb.dispatch(body), f.wb.dispatch({ ...body })]);
  assert.equal(a.id, b.id);
  const replay = await f.wb.dispatch(body);
  assert.equal(replay.id, a.id);
  await assert.rejects(f.wb.dispatch({ ...body, prompt: 'changed' }), /重复操作编号/);
  await assert.rejects(f.wb.dispatch({ sessionId: f.managerSession.id, prompt: 'different request' }), /已有运行/);
  assert.equal(Object.keys(f.store.state.runs).length, 1);
});

test('manager inbox defaults to unread current work, omits receipts and pages only within the bound scope', async (t) => {
  const f = await fixture(t);
  await startManager(f);
  const taskId = 'task-inbox';
  f.store.state.collaboration.tasks[taskId] = { id: taskId, namespace: f.namespace, managerRoleKey: f.manager.key, employeeRoleKey: f.employee.key, title: 'inbox fixture', prompt: 'current task', collaborators: [], status: 'delivered', createdAt: '2026-10-14T01:00:00Z', generation: 1, origin: { privateFixture: 'must not repeat raw receipt' }, runIds: [] };
  for (let i = 0; i < 47; i++) {
    const id = `history-${String(i).padStart(3, '0')}`;
    f.store.state.collaboration.messages[id] = { id, namespace: f.namespace, taskId, toRole: f.manager.key, fromRole: f.employee.key, kind: 'completed', status: i < 45 ? 'handled' : 'unread', summary: `fixture report ${i}`, artifacts: [], createdAt: `2026-10-14T01:00:${String(i).padStart(2, '0')}Z`, origin: { callId: 'private-fixture-origin' } };
  }
  f.store.state.collaboration.operations['receipt-history'] = { origin: { roleKey: f.manager.key }, requestId: 'private-receipt', result: { raw: 'never return by default' } };
  const defaults = f.runtime.call(f.managerSession, 'yewang_inbox', {}).result;
  assert.equal(defaults.messages.length, 2);
  assert.ok(defaults.messages.every((m) => m.status === 'unread'));
  assert.ok(!('operationReceipts' in defaults));
  assert.ok(!('origin' in defaults.tasks[0]));
  assert.doesNotMatch(JSON.stringify(defaults), /private-fixture|private-receipt|must not repeat/);
  const first = f.runtime.call(f.managerSession, 'yewang_inbox', { taskId, limit: 3 }).result;
  assert.equal(first.messages.length, 3);
  assert.ok(first.nextCursor);
  const second = f.runtime.call(f.managerSession, 'yewang_inbox', { taskId, limit: 3, cursor: first.nextCursor }).result;
  assert.equal(second.messages.length, 3);
  assert.ok(first.messages.every((m) => !second.messages.some((other) => other.id === m.id)));
  const crossCursor = f.runtime.call(f.managerSession, 'yewang_inbox', { cursor: first.nextCursor });
  assert.equal(crossCursor.response.success, false);
  assert.equal(f.runtime.call(f.managerSession, 'yewang_inbox', { taskId: 'foreign-task' }).response.success, false);
  assert.equal(f.runtime.call(f.managerSession, 'yewang_inbox', { messageIds: ['foreign-message'] }).response.success, false);
  assert.equal(f.runtime.call(f.managerSession, 'yewang_inbox', { limit: 21 }).response.success, false);
  const page = f.wb.collaboration.page({ namespace: f.namespace, limit: 1 });
  assert.ok(!('operationReceipts' in page));
  assert.equal(Object.keys(f.store.state.collaboration.operations).length, 1, 'receipts remain stored');
});

test('a partial inbox read cannot silently handle reports that were not read or reviewed', async (t) => {
  const f = await fixture(t);
  const assigned = await assign(f);
  f.runtime.finish(f.managerSession.threadId); await tick();
  const report = await deliver(f, assigned);
  f.runtime.finish(f.employeeSession.threadId); await tick();
  f.runtime.call(f.managerSession, 'yewang_inbox', { limit: 1 });
  f.runtime.finish(f.managerSession.threadId); await tick();
  assert.equal(f.store.state.collaboration.messages[report.result.messageId].status, 'unread');
  assert.equal(f.managerSession.wakePaused, true);
  assert.equal(f.store.state.collaboration.tasks[assigned.result.taskId].status, 'delivered');
  assert.equal(Object.values(f.store.state.runs).filter((r) => r.kind === 'inbox').length, 1, 'no automatic endless wake');
});

test('explicit inbox pagination does not depend on whole-group history or operation count', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) {
    const id = `task-${String(i).padStart(3, '0')}`;
    f.store.state.collaboration.tasks[id] = { id, namespace: f.namespace, status: 'accepted', managerRoleKey: f.manager.key, createdAt: `2026-10-14T01:${String(i).padStart(2, '0')}:00Z`, runIds: [] };
  }
  const first = f.wb.collaboration.page({ namespace: f.namespace, limit: 20 });
  const next = f.wb.collaboration.page({ namespace: f.namespace, limit: 20, cursor: first.nextCursor });
  assert.equal(first.tasks.length, 20);
  assert.equal(next.tasks.length, 20);
  assert.ok(first.tasks.every((t) => !next.tasks.some((other) => other.id === t.id)));
  assert.equal(first.counts.tasks, 65);
  assert.throws(() => f.wb.collaboration.page({ namespace: 'test-foreign', cursor: first.nextCursor }), /不存在/);
  assert.throws(() => f.wb.collaboration.page({ namespace: f.namespace, limit: 10000 }), /1到50/);
});
