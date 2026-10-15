import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkbench, createServer } from '../src/app.mjs';
import { WeixinChannel } from '../src/weixin-channel.mjs';
import { WeixinApi, WeixinError, parseWeixinJson, weixinBase } from '../src/weixin-api.mjs';
import { weixinSettingsHtml } from '../public/weixin.js';

class Runtime extends EventEmitter {
  constructor() { super(); this.threads = new Map(); this.turns = []; }
  snapshot() { return { status: 'ready' }; }
  async ensureStarted() { return this; }
  async stop() {}
  async request() { return { requiresOpenaiAuth: false }; }
  async startThread(p) { const id = 'thread-' + this.threads.size; this.threads.set(id, p); return { thread: { id }, cwd: p.cwd }; }
  async setThreadName() {}
  isLoaded(id) { return this.threads.has(id); }
  async listSkills(cwds) { return { data: [{ cwd: cwds[0], skills: [] }] }; }
  async startTurn(p) { this.turns.push(p); return { turn: { id: 'turn-' + this.turns.length } }; }
  async interruptTurn(threadId, turnId) { this.interrupted = { threadId, turnId }; }
}
class Api {
  constructor() { this.loginResult = { status: 'confirmed', bot_token: 'PRIVATE_BOT_TOKEN', ilink_user_id: 'PRIVATE_OWNER', ilink_bot_id: 'BOT', baseurl: 'https://ilinkai.weixin.qq.com/' }; this.sent = []; this.qrCalls = 0; }
  async qr() { this.qrCalls++; return { qrcode: 'PRIVATE_QR_VALUE', qrcode_img_content: 'https://example.invalid/scan-fixture' }; }
  async login(_qr, args) { this.verifyCode = args.verifyCode; return this.loginResult; }
  async updates() { if (this.updateError) throw this.updateError; return { msgs: this.messages || [], get_updates_buf: 'cursor-2' }; }
  async send(_credentials, body) { this.sent.push(body); if (this.sendError) throw this.sendError; return { ret: 0 }; }
}
async function fixture(t, desktop) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'company-weixin-'));
  const runtime = new Runtime(), ctx = createWorkbench({ env: { YEWANG_DATA_DIR: path.join(root, 'data'), YEWANG_COMPANY_ROOT: root }, runtime });
  await ctx.workbench.onboarding.checkEnvironment(); await ctx.workbench.onboarding.createManager({ name: '经理', description: '处理目标并回传实际结果' });
  await ctx.workbench.onboarding.createEmployee({ requestId: 'fixture-employee-001', title: '开发', name: '员工', description: '只在隔离测试目录执行' });
  ctx.workbench.onboarding.finish();
  const api = new Api(); if (desktop) ctx.workbench.state.workspace.executionMode = 'desktop';
  const make = () => new WeixinChannel({ workbench: ctx.workbench, desktopManager: desktop, dataDir: ctx.paths.dataDir, api, background: false });
  const channel = make();
  t.after(async () => { channel.close(); await ctx.workbench.stopRuntime(); if (ctx.store.timer) clearTimeout(ctx.store.timer); fs.rmSync(root, { recursive: true, force: true }); });
  const connect = async () => { await channel.beginLogin({ managerKey: desktop ? 'desktop' : ctx.workbench.onboarding.setup.managerRoleKey }); await channel.pollLogin(); };
  return { ...ctx, root, runtime, api, channel, make, connect };
}
const incoming = (id, text = '请检查页面') => ({ message_id: String(id), from_user_id: 'PRIVATE_OWNER', to_user_id: 'BOT', message_type: 1, message_state: 2, context_token: 'PRIVATE_CONTEXT_' + id, item_list: [{ type: 1, text_item: { text } }] });
async function running(f, request) { for (let i = 0; i < 100; i++) { if (f.workbench.state.runs[request.runId]?.turnId) return f.workbench.state.runs[request.runId]; await new Promise(setImmediate); } throw Error('fixture turn did not start'); }
function finish(f, run, text = '真实接口记录中的最终结果') {
  const item = { id: 'answer-' + run.id, type: 'agentMessage', phase: 'final_answer', text };
  f.runtime.emit('notification', { method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId, item } });
  f.runtime.emit('notification', { method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'completed', items: [item] } } });
}

test('iLink preserves uint64 IDs without altering JSON-looking user text and confines credential endpoints', async () => {
  const raw = '{"message_id":18446744073709551614,"msg_id":18446744073709551615,"text":"\\\"message_id\\\":123"}';
  const parsed = parseWeixinJson(raw); assert.notEqual(parsed.message_id, parsed.msg_id); assert.equal(parsed.message_id, '18446744073709551614'); assert.equal(parsed.text, '"message_id":123');
  assert.throws(() => weixinBase('https://weixin.qq.com.attacker.invalid/'), /无效/); assert.throws(() => weixinBase('http://ilinkai.weixin.qq.com/'), /无效/);
  const calls = [], api = new WeixinApi({ fetchImpl: async (url, args) => { calls.push({ url, args }); return new Response('{"ret":0}'); } });
  await api.qr(); await api.login('private-value'); await api.send({ token: 'SECRET', ownerId: 'owner' }, { clientId: 'reply-id', contextToken: 'CTX', text: '回复' });
  assert.equal(calls[0].args.method, 'POST'); assert.equal(calls[0].args.headers.Authorization, undefined); assert.deepEqual(JSON.parse(calls[0].args.body), { local_token_list: [] });
  assert.equal(calls[1].args.headers.AuthorizationType, undefined); assert.equal(calls[2].args.headers.Authorization, 'Bearer SECRET');
  assert.equal(JSON.parse(calls[2].args.body).msg.context_token, 'CTX'); assert.equal(calls[2].args.redirect, 'error');
});

test('QR expiry, user-entered verification, authentication failures and disconnect races remain explicit', async t => {
  const f = await fixture(t); f.api.loginResult = { status: 'expired' };
  await f.channel.beginLogin({ managerKey: f.channel.choices()[0].key }); await f.channel.pollLogin(); assert.equal(f.channel.snapshot().status, 'expired');
  f.api.loginResult = { status: 'need_verifycode' }; await f.channel.beginLogin({ managerKey: f.channel.choices()[0].key }); await f.channel.pollLogin();
  assert.match(weixinSettingsHtml(f.channel.snapshot()), /本人操作/); await f.channel.verify({ code: '123456' }); assert.equal(f.api.verifyCode, '123456');
  assert.doesNotMatch(fs.readFileSync(f.channel.secretFile, 'utf8'), /123456/);
  let resolve; f.api.qr = () => new Promise(r => { resolve = r; }); const pending = f.channel.beginLogin({ managerKey: f.channel.choices()[0].key });
  f.channel.disconnect(); resolve({ qrcode: 'late', qrcode_img_content: 'https://example.invalid/late' }); await pending; assert.equal(f.channel.snapshot().status, 'disconnected'); assert.equal(f.channel.snapshot().login, null);
});

test('only QR-verified personal sources enter the queue, duplicate IDs never dispatch twice, and secrets stay private', async t => {
  const f = await fixture(t); await f.connect();
  for (const bad of [{ from_user_id: 'other' }, { group_id: 'group' }, { message_type: 2 }, { to_user_id: 'other' }]) assert.equal(f.channel.receive({ ...incoming(1), ...bad }), null);
  const request = f.channel.receive(incoming('18446744073709551615')); assert.equal(f.channel.receive(incoming('18446744073709551615')).id, request.id);
  await f.channel.tick(); const run = await running(f, request);
  assert.equal(run.sessionId, f.workbench.onboarding.snapshot().managerSessionId); assert.equal(f.runtime.threads.size, 2); assert.equal(f.runtime.turns.length, 1);
  assert.equal(f.runtime.turns[0].threadId, run.threadId); assert.doesNotMatch(JSON.stringify(f.runtime.turns), /PRIVATE_(BOT|CONTEXT|OWNER)/);
  assert.doesNotMatch(JSON.stringify(f.channel.snapshot()), /PRIVATE_(BOT|CONTEXT|OWNER)|PRIVATE_QR_VALUE/);
  assert.doesNotMatch(fs.readFileSync(f.channel.file, 'utf8'), /PRIVATE_(BOT_TOKEN|CONTEXT)/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.channel.secretFile).mode & 0o777, 0o600);
  finish(f, run); await f.channel.tick(); assert.equal(f.api.sent.length, 1); assert.equal(f.api.sent[0].contextToken, 'PRIVATE_CONTEXT_18446744073709551615'); assert.equal(f.channel.snapshot().replies[0].status, 'sent');
  await f.channel.tick(); assert.equal(f.runtime.turns.length, 1); assert.equal(f.api.sent.length, 1);
});

test('web and WeChat share one manager and busy messages remain durable until that session is free', async t => {
  const f = await fixture(t); await f.connect(); const sessionId = f.workbench.onboarding.snapshot().managerSessionId;
  const web = await f.workbench.dispatch({ sessionId, prompt: '网页先发的任务', requestId: 'web-first-0001' }); const webRun = await running(f, { runId: web.id });
  const wx = f.channel.receive(incoming(20)); await f.channel.tick(); assert.equal(wx.status, 'queued'); assert.equal(f.runtime.turns.length, 1);
  const restored = f.make(); t.after(() => restored.close()); assert.equal(restored.receive(incoming(20)).id, wx.id);
  finish(f, webRun); await restored.tick(); const wxRestored = restored.state.requests.find(r => r.id === wx.id); const run = await running(f, wxRestored);
  assert.equal(run.sessionId, sessionId); assert.equal(f.runtime.threads.size, 2); assert.equal(f.runtime.turns.length, 2);
});

test('a crashed submission reconciles committed request IDs, while an unknown submission never silently reruns', async t => {
  const f = await fixture(t); await f.connect(); const request = f.channel.receive(incoming(30)); await f.channel.tick(); await running(f, request);
  const journal = JSON.parse(fs.readFileSync(f.channel.file)); journal.requests[0].status = 'submitting'; fs.writeFileSync(f.channel.file, JSON.stringify(journal));
  const restored = f.make(); t.after(() => restored.close()); await restored.tick(); assert.equal(restored.state.requests[0].runId, request.runId); assert.equal(f.runtime.turns.length, 1);
  journal.requests.push({ ...journal.requests[0], id: 'wx_uncommitted', runId: undefined, status: 'submitting' }); fs.writeFileSync(f.channel.file, JSON.stringify(journal));
  const unknown = f.make(); t.after(() => unknown.close()); await unknown.tick(); assert.equal(unknown.state.requests[1].status, 'unknown'); assert.equal(f.runtime.turns.length, 1);
});

test('failed long-task replies are not retried; /结果 uses the fresh request context without another model turn', async t => {
  const f = await fixture(t); await f.connect(); const request = f.channel.receive(incoming(40)); await f.channel.tick(); const run = await running(f, request); finish(f, run, '长任务最终结果');
  f.api.sendError = new WeixinError('微信上下文失效', { code: 999 }); await f.channel.tick(); assert.equal(f.channel.snapshot().replies[0].status, 'failed');
  await f.channel.tick(); assert.equal(f.api.sent.length, 1);
  f.api.sendError = null; f.channel.receive(incoming(41, '/结果')); await f.channel.tick();
  assert.equal(f.runtime.turns.length, 1); assert.equal(f.api.sent.at(-1).contextToken, 'PRIVATE_CONTEXT_41'); assert.equal(f.api.sent.at(-1).text, '长任务最终结果');
  const journal = JSON.parse(fs.readFileSync(f.channel.file)); journal.replies.at(-1).status = 'sending'; fs.writeFileSync(f.channel.file, JSON.stringify(journal));
  const restored = f.make(); t.after(() => restored.close()); await restored.tick(); assert.equal(restored.state.replies.at(-1).status, 'unknown'); assert.equal(f.api.sent.length, 2);
});

test('pause and stop use existing manager interruption, cancel pending messages, and never auto-resume old work', async t => {
  const f = await fixture(t); await f.connect(); const active = f.channel.receive(incoming(50)); await f.channel.tick(); const run = await running(f, active);
  const queued = f.channel.receive(incoming(51)); f.channel.receive(incoming(52, '/停止')); await f.channel.tick();
  assert.equal(f.channel.state.paused, true); assert.equal(queued.status, 'cancelled'); assert.deepEqual(f.runtime.interrupted, { threadId: run.threadId, turnId: run.turnId });
  f.channel.receive(incoming(53, '/继续')); await f.channel.tick(); assert.equal(f.channel.state.paused, false); assert.equal(f.runtime.turns.length, 1);
});

test('desktop mode queues through its existing holder and returns only the correlated desktop message', async t => {
  class Desktop extends EventEmitter {
    constructor() { super(); this.messages = []; this.busy = true; }
    snapshot() { return { configured: true, target: { threadId: 'existing-desktop-thread', name: '桌面经理' }, busy: this.busy }; }
    async send(body) { const m = { id: body.requestId, text: body.text, status: 'submitted', threadId: 'existing-desktop-thread' }; this.messages.push(m); return m; }
  }
  const desktop = new Desktop(), f = await fixture(t, desktop); await f.connect(); const req = f.channel.receive(incoming(60)); await f.channel.tick(); assert.equal(req.status, 'queued');
  desktop.busy = false; await f.channel.tick(); assert.equal(desktop.messages.length, 1); assert.equal(f.runtime.turns.length, 0);
  Object.assign(desktop.messages[0], { status: 'completed', replyText: '桌面同一聊天的实际回复' }); await f.channel.tick(); assert.equal(f.api.sent[0].text, '桌面同一聊天的实际回复'); assert.equal(f.runtime.turns.length, 0);
});

test('authentication failures suspend polling and API status/QR entry expose no private credentials', async t => {
  const f = await fixture(t); await f.connect(); f.api.updateError = new WeixinError('微信认证已失效', { auth: true, code: -14 }); await f.channel.poll();
  assert.equal(f.channel.snapshot().status, 'auth_expired'); assert.equal(f.channel.state.enabled, false); assert.throws(() => f.channel.reconnect(), /重新扫码/);
  const server = createServer({ workbench: f.workbench, paths: f.paths, desktopManager: null, nativeCollaboration: null, weixinChannel: f.channel });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close()); const base = 'http://127.0.0.1:' + server.address().port;
  const status = await fetch(base + '/api/channels/weixin').then(r => r.json()); assert.equal(status.status, 'auth_expired'); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_BOT_TOKEN/);
  const login = await fetch(base + '/api/channels/weixin/login', { method: 'POST', headers: { 'x-yewang-workbench': '1', 'content-type': 'application/json' }, body: JSON.stringify({ managerKey: f.channel.choices()[0].key }) }).then(r => r.json());
  assert.equal(login.status, 'waiting_scan'); assert.match(login.login.qrSvg, /<svg/); assert.doesNotMatch(JSON.stringify(login), /PRIVATE_QR_VALUE|PRIVATE_BOT_TOKEN/);
});

test('employee decisions and the manager follow-up remain tied to the original WeChat request after the first turn ends', async t => {
  const f = await fixture(t); await f.connect(); const request = f.channel.receive(incoming(70)); await f.channel.tick(); const managerRun = await running(f, request);
  const call = (run, tool, args) => f.workbench.collaboration.handle({ params: { threadId: run.threadId, turnId: run.turnId, callId: 'test-' + tool, namespace: null, tool, arguments: args } }, f.runtime, f.runtime);
  const employee = f.workbench.listRoles().find(r => r.collaboration?.authority === 'employee');
  const response = call(managerRun, 'yewang_dispatch', { requestId: 'wechat-child-task', toRole: employee.key, title: '微信原任务', prompt: '先提出一个需本人决定的问题', collaborators: [] });
  assert.equal(response.success, true); const task = JSON.parse(response.contentItems[0].text);
  finish(f, managerRun, '已交给员工处理'); await f.channel.tick();
  const employeeRun = await running(f, { runId: task.runId }); const report = call(employeeRun, 'yewang_report', { requestId: 'wechat-child-report', taskId: task.taskId, kind: 'decision', summary: '请确认交付格式', artifacts: [] }); assert.equal(report.success, true);
  finish(f, employeeRun, '等待本人决定'); await f.channel.tick(); assert.ok(f.api.sent.some(s => s.text.includes('请确认交付格式')));
  const followup = Object.values(f.workbench.state.runs).find(r => r.managerMessageIds?.length); assert.ok(followup); await running(f, { runId: followup.id });
  finish(f, followup, '经理后续汇总：需要本人选择交付格式'); await f.channel.tick(); assert.ok(f.api.sent.some(s => s.text === '经理后续汇总：需要本人选择交付格式'));
  assert.ok(f.api.sent.every(s => s.contextToken === 'PRIVATE_CONTEXT_70'));
  const turns = f.runtime.turns.length, sent = f.api.sent.length; await f.channel.tick(); assert.equal(f.runtime.turns.length, turns); assert.equal(f.api.sent.length, sent);
  f.channel.receive(incoming(71, '/停止')); await f.channel.tick(); assert.equal(f.workbench.state.collaboration.tasks[task.taskId].status, 'cancelled');
});

test('unsupported media cannot start a turn, and damaged channel records never overwrite existing files or break other work', async t => {
  const f = await fixture(t); await f.connect();
  const media = f.channel.receive({ ...incoming(90), item_list: [{ type: 2, image_item: { url: 'https://example.invalid/not-fetched' } }] });
  await f.channel.tick(); assert.equal(media.status, 'blocked'); assert.equal(f.runtime.turns.length, 0); assert.ok(f.api.sent[0].text.includes('文字私聊'));
  f.channel.close(); fs.writeFileSync(f.channel.file, '{broken-private-record');
  const broken = f.make(); t.after(() => broken.close()); assert.equal(broken.snapshot().status, 'connection_error');
  await assert.rejects(broken.beginLogin({ managerKey: broken.choices()[0].key }), /无法读取/); assert.equal(fs.readFileSync(f.channel.file, 'utf8'), '{broken-private-record');
  assert.equal(f.workbench.onboarding.snapshot().managerSessionId, f.workbench.collaboration.sessionFor(f.workbench.onboarding.setup.managerRoleKey).id);
});

test('mixed inbox batches never copy another web task body into a WeChat return', async t => {
  const f = await fixture(t); await f.connect(); const request = f.channel.receive(incoming(80)); await f.channel.tick(); const run = await running(f, request); finish(f, run, '微信原消息已处理'); await f.channel.tick();
  const data = f.workbench.state.collaboration;
  data.tasks.wx = { id: 'wx', title: '本人微信任务', managerSessionId: run.sessionId, origin: { runId: run.id }, status: 'running' };
  data.tasks.web = { id: 'web', title: '另外的网页任务', managerSessionId: run.sessionId, origin: { runId: 'other-web-root' }, status: 'running' };
  data.messages.wx = { id: 'wx', taskId: 'wx' }; data.messages.web = { id: 'web', taskId: 'web' };
  f.workbench.state.runs.mixed = { id: 'mixed', sessionId: run.sessionId, managerMessageIds: ['wx', 'web'], status: 'completed', finalText: 'OTHER_WEB_PRIVATE_CONTENT' };
  await f.channel.tick(); assert.ok(f.api.sent.some(s => s.text.includes('合并了多项工作'))); assert.ok(f.api.sent.every(s => !s.text.includes('OTHER_WEB_PRIVATE_CONTENT')));
});
