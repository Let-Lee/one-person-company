import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer, createWorkbench } from '../src/app.mjs';
import { Store } from '../src/store.mjs';
import { guideHtml } from '../public/guide.js';

class Runtime extends EventEmitter {
  constructor() { super(); this.status = 'stopped'; this.created = []; this.startedTurns = []; this.threads = new Map(); this.failCreate = false; this.needsLogin = false; }
  snapshot() { return { status: this.status }; }
  async ensureStarted() { this.status = 'ready'; return this; }
  async stop() { this.status = 'stopped'; }
  async request(method) { if (method === 'account/read') return { requiresOpenaiAuth: this.needsLogin, account: this.needsLogin ? null : { type: 'apiKey' } }; throw Error('unsupported'); }
  async startThread(params) {
    if (this.failCreate) throw Error('真实会话建立失败');
    const id = 'fixture-thread-' + (this.created.length + 1); this.created.push(params); this.threads.set(id, params);
    return { thread: { id, status: { type: 'idle' } }, cwd: params.cwd };
  }
  async setThreadName() {}
  async resumeThread(id, params) { this.resumed = { id, params }; return { thread: { id } }; }
  isLoaded(id) { return this.threads.has(id); }
  async listSkills(cwds) { return { data: [{ cwd: cwds[0], skills: [{ name: 'fixture-skill', path: '/fixture/skill/SKILL.md', enabled: true, description: '只用于协议测试' }] }] }; }
  async startTurn(params) { this.startedTurns.push(params); return { turn: { id: 'fixture-turn-' + this.startedTurns.length } }; }
}

function fixture(t, envOverride = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-setup-'));
  const company = path.join(root, 'private-company'); fs.mkdirSync(path.join(company, '公司/组织'), { recursive: true });
  fs.writeFileSync(path.join(company, '公司/组织/聊天通讯录.json'), JSON.stringify({ members: [{ role: 'general_manager', name: 'PRIVATE_IMPORT_MARKER', threadId: 'private-manager-thread' }] }));
  const env = { YEWANG_COMPANY_ROOT: company, YEWANG_DATA_DIR: path.join(root, 'data'), YEWANG_WORKSPACES_ROOT: path.join(root, 'workspaces'), ...envOverride };
  const runtime = new Runtime(), ctx = createWorkbench({ env, runtime });
  t.after(async () => { await ctx.workbench.stopRuntime(); if (ctx.store.timer) clearTimeout(ctx.store.timer); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...ctx, root, env, runtime, guide: ctx.workbench.onboarding };
}

const managerBody = { name: '自己的经理', description: '明确目标、派单并核验实际结果。' };
const employeeBody = { requestId: 'employee-request-001', name: '自己的员工', title: '开发', description: '在明确范围内修改文件并回报。' };

test('a fresh workspace has zero roles, no private import or manager target, and reading setup starts no runtime', async (t) => {
  const f = fixture(t); const server = createServer({ workbench: f.workbench, paths: f.paths }); t.after(() => server.close());
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const data = await Promise.all(['/api/setup','/api/roles','/api/sessions','/api/desktop-manager','/api/native-collaboration','/api/overview'].map(p => fetch(base+p).then(r=>r.json())));
  assert.equal(data[0].roleCount, 0); assert.equal(data[0].required, true); assert.equal(data[0].manager, null);
  assert.deepEqual(data[1].roles, []); assert.equal(data[3].target, null); assert.equal(server.nativeCollaboration, null);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_IMPORT_MARKER|private-manager-thread|经理A|创始人|01a125ac/);
  assert.equal(f.runtime.status, 'stopped'); assert.equal(f.runtime.created.length, 0); assert.equal(f.workbench.company.enabled, false);
  assert.ok(!f.paths.allowedRoots.includes(f.paths.companyRoot));
  assert.match(guideHtml(f.guide.snapshot()), /当前有 0 个岗位/);
  await assert.rejects(f.guide.createManager(managerBody), /连接与登录检查/);
  assert.throws(() => f.guide.finish(), /尚未实际建立/);
});

test('drafts and progress restore; role persistence is not falsely reported as actual session creation', async (t) => {
  const f = fixture(t);
  f.guide.draft({ name: '甲工作台', ownerName: '甲', step: 'connection', drafts: { managerName: '甲经理' } });
  await f.guide.checkEnvironment(); f.runtime.failCreate = true;
  await assert.rejects(f.guide.createManager(managerBody), /会话建立失败/);
  assert.equal(f.guide.snapshot().roleCount, 1); assert.equal(f.guide.snapshot().manager.sessionCreated, false);
  assert.equal(new Store(f.paths.dataDir).state.workspace.name, '甲工作台');
  f.runtime.failCreate = false; const next = await f.guide.createManager(managerBody);
  assert.equal(next.roleCount, 1); assert.equal(next.manager.sessionCreated, true); assert.equal(f.runtime.created.length, 1);
  assert.equal(f.runtime.startedTurns.length, 0);
});

test('the guide creates only chosen roles, retries do not duplicate employees, and completion survives reopening', async (t) => {
  const f = fixture(t); await f.guide.checkEnvironment(); await f.guide.createManager(managerBody);
  const first = await f.guide.createEmployee(employeeBody), second = await f.guide.createEmployee(employeeBody);
  assert.equal(first.roleCount, 2); assert.equal(second.roleCount, 2); assert.equal(f.runtime.created.length, 2);
  assert.equal(second.employees[0].sessionCreated, true);
  await assert.rejects(f.guide.createEmployee({ ...employeeBody, name: '不一致重试' }), /同一请求/);
  const selected = await f.guide.saveSkills({ roleKey: second.employees[0].key, skills: [{ name: 'fixture-skill', path: '/fixture/skill/SKILL.md' }] });
  assert.equal(selected.employees[0].skillsSaved.length, 1); assert.equal(selected.employees[0].skillActivation, 'verify_on_next_run');
  await assert.rejects(f.guide.saveSkills({ roleKey: selected.employees[0].key, skills: [{ name: 'does-not-exist' }] }), /未发现/);
  const finished = f.guide.finish(); assert.equal(finished.required, false);
  f.guide.draft({ step: 'welcome' }); assert.equal(f.guide.snapshot().roleCount, 2); assert.equal(f.guide.snapshot().completed, true);
  const restored = createWorkbench({ env: f.env, runtime: new Runtime() });
  assert.equal(restored.workbench.onboarding.snapshot().roleCount, 2); assert.equal(restored.workbench.onboarding.snapshot().manager.sessionCreated, true);
  assert.equal(restored.workbench.company.enabled, false); assert.equal(f.runtime.startedTurns.length, 0);
});

test('daily hiring stays outside onboarding and retries a failed session without duplicating the employee', async (t) => {
  const f = fixture(t); await f.guide.checkEnvironment(); await f.guide.createManager(managerBody);
  await f.guide.createEmployee(employeeBody); f.guide.finish();
  const before = { step: f.guide.setup.step, manager: f.guide.setup.managerRoleKey, sessions: Object.keys(f.store.state.sessions) };
  const body = { ...employeeBody, requestId: 'daily-hire-001', name: '内容员工', title: '内容策划' };
  f.runtime.failCreate = true;
  await assert.rejects(f.guide.addEmployee(body), /会话建立失败/);
  assert.equal(f.guide.snapshot().roleCount, 3);
  f.runtime.failCreate = false;
  const added = await f.guide.addEmployee(body), repeated = await f.guide.addEmployee(body);
  assert.equal(added.role.key, repeated.role.key);
  assert.equal(added.sessionCreated, true);
  assert.equal(f.guide.snapshot().roleCount, 3);
  assert.equal(Object.keys(f.store.state.sessions).length, 3);
  assert.equal(f.guide.setup.step, before.step);
  assert.equal(f.guide.setup.completed, true);
  assert.equal(f.guide.setup.managerRoleKey, before.manager);
  assert.equal(added.role.collaboration.namespace, f.guide.setup.namespace);
  assert.equal(added.role.collaboration.authority, 'employee');
  assert.equal(f.runtime.startedTurns.length, 0);
});

test('responsibility edits retain the stable thread and reach its next execution through resume overrides', async (t) => {
  const f = fixture(t); await f.guide.checkEnvironment(); await f.guide.createManager(managerBody);
  const key = f.guide.setup.managerRoleKey, session = f.workbench.collaboration.sessionFor(key), original = session.threadId;
  const next = '新版职责：先检查实际文件，按范围派单后核验交付。';
  await f.workbench.configureRole(key, { profile: { name: managerBody.name, title: '总经理', instructions: next } });
  assert.equal(f.runtime.startedTurns.length, 0);
  await f.workbench.dispatch({ sessionId: session.id, prompt: '协议替身检查', requestId: 'profile-check-001' });
  for (let i = 0; i < 50 && !f.runtime.resumed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.runtime.resumed.id, original);
  assert.ok(f.runtime.resumed.params.developerInstructions.includes(next));
  assert.equal(f.workbench.collaboration.sessionFor(key).threadId, original);
  assert.equal(f.runtime.created.length, 1);
});

test('onboarding advances only after actual prerequisites, and an employee session failure survives refresh without duplicate roles', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.guide.draft({ step: 'tour' }), /连接与登录检查/);
  await f.guide.checkEnvironment();
  assert.throws(() => f.guide.draft({ step: 'employees' }), /总经理会话/);
  await f.guide.createManager(managerBody);
  assert.throws(() => f.guide.draft({ step: 'skills' }), /第一位员工会话/);
  f.runtime.failCreate = true;
  await assert.rejects(f.guide.createEmployee(employeeBody), /会话建立失败/);
  const restored = createWorkbench({ env: f.env, runtime: new Runtime() });
  const pending = restored.workbench.onboarding.snapshot().employees[0];
  assert.equal(pending.sessionCreated, false);
  assert.deepEqual(pending.retryRequest, employeeBody);
  const retried = await restored.workbench.onboarding.createEmployee(pending.retryRequest);
  assert.equal(retried.roleCount, 2);
  assert.equal(retried.employees[0].sessionCreated, true);
  assert.equal(retried.step, 'skills');
  assert.equal(restored.runtime.created.length, 1);
});

test('existing workspace rules are preserved, and manager binding accepts only an already established local manager', async (t) => {
  const f = fixture(t), existing = path.join(f.root, 'chosen-folder'); fs.mkdirSync(existing);
  const rules = '# 用户已有规则\n保留此内容\n'; fs.writeFileSync(path.join(existing, 'AGENTS.md'), rules);
  await f.guide.checkEnvironment(); await f.guide.createManager({ ...managerBody, workspacePath: existing });
  assert.equal(fs.readFileSync(path.join(existing, 'AGENTS.md'), 'utf8'), rules);
  const setup = f.guide.snapshot(); assert.equal(setup.workspacePath, fs.realpathSync(existing));
  const bound = f.guide.bindManager({ roleKey: setup.manager.key }); assert.equal(bound.manager.sessionCreated, true);
  await f.guide.createEmployee(employeeBody);
  assert.throws(() => f.guide.bindManager({ roleKey: f.guide.snapshot().employees[0].key }), /只能绑定/);
  assert.equal(f.runtime.created.length, 2);
});

test('different data directories never share roles, setup choices, or existing native company identities', async (t) => {
  const a = fixture(t), b = fixture(t); await a.guide.checkEnvironment(); await a.guide.createManager(managerBody);
  a.guide.draft({ name: '甲', drafts: { firstPrompt: '只属于甲的目标' } });
  assert.equal(b.guide.snapshot().roleCount, 0); assert.equal(b.guide.snapshot().manager, null);
  assert.equal(b.guide.snapshot().name, '我的公司'); assert.doesNotMatch(JSON.stringify(b.guide.snapshot()), /只属于甲|自己的经理/);
});

test('authentication is not inferred from a connected runtime; login-required cannot create a manager', async (t) => {
  const f = fixture(t); f.runtime.needsLogin = true;
  const result = await f.guide.checkEnvironment(); assert.equal(result.environment.connected, true); assert.equal(result.environment.authentication, 'login_required');
  await assert.rejects(f.guide.createManager(managerBody), /登录检查/); assert.equal(f.workbench.listRoles().length, 0);
});

test('legacy state is retained when adding workspace metadata, with no destructive reset', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-legacy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { schemaVersion: 3, roles: { local_existing: { name: '已有员工', key: 'local_existing' } }, sessions: { preserved: { threadId: 'existing-thread' } },
    runs: { done: { status: 'completed', finalText: '已有成果' } }, roleConfigs: { local_existing: { skills: [{ name: 'old' }] } } };
  fs.writeFileSync(path.join(dir,'state.json'), JSON.stringify(old));
  const store = new Store(dir);
  for (const key of ['roles','sessions','runs','roleConfigs']) assert.deepEqual(store.state[key], old[key]);
  assert.equal(store.state.workspace.mode, 'legacy-company'); assert.equal(store.state.workspace.setup.completed, true);
  store.save(); assert.deepEqual(new Store(dir).state.roles, old.roles);
});
