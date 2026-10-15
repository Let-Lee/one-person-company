// 前端渲染测试：在最小 DOM 替身里加载 public/app.js，用协议级假 Codex 产生的真实接口数据逐页渲染。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, createWorkbench } from '../src/app.mjs';
import { CodexRuntime } from '../src/codex/codex-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let tmp;
let ctx;
let server;
let base;
const winListeners = {};
const errors = [];
let holdNextSkill = false;
let skillHeld;
let releaseSkill;

class El {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    this.kids = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  querySelector(sel) { return ['.nav-items', '.nav-roles', '.nav-indicator', '.camera-hud'].includes(sel) ? (this.kids[sel] ||= new El(sel)) : null; }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
  insertAdjacentHTML() {}
  appendChild() {}
  remove() {}
  scrollTo() {}
  closest() { return null; }
}
const els = {};

async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-yewang-workbench': '1' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-ui-'));
  const company = path.join(tmp, 'company');
  fs.mkdirSync(path.join(company, '公司/组织'), { recursive: true });
  fs.writeFileSync(path.join(company, '公司/组织/聊天通讯录.json'), JSON.stringify({ members: [
    { name: '经理A', role: 'general_manager', title: '总经理', threadId: 'demo-manager' },
    { name: '开发A', role: 'fullstack_developer_2', title: '全栈开发', threadId: 'demo-developer' },
  ] }));
  const env = { YEWANG_IMPORT_COMPANY: '1', YEWANG_COMPANY_ROOT: company, YEWANG_DATA_DIR: path.join(tmp, 'data'), YEWANG_WORKSPACES_ROOT: path.join(tmp, 'ws'), YEWANG_REPORT_FILE: path.join(tmp, 'none.json') };
  const runtime = new CodexRuntime({ codexBin: process.execPath, args: [path.join(here, 'fake-app-server.mjs')], cwd: tmp });
  ctx = createWorkbench({ env, runtime });
  server = createServer({ workbench: ctx.workbench, paths: ctx.paths, nativeCollaboration: null, desktopManager: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  globalThis.document = {
    getElementById: (id) => (els[id] ||= new El(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new El('x'),
    activeElement: null,
  };
  globalThis.window = { addEventListener: (type, fn) => (winListeners[type] ||= []).push(fn) };
  globalThis.document.addEventListener = () => {};
  globalThis.document.body = new El('body');
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.location = { hash: '' };
  globalThis.CSS = { escape: (s) => s };
  globalThis.EventSource = class { close() {} };
  globalThis.prompt = () => null;
  globalThis.confirm = () => false;
  const realFetch = fetch;
  globalThis.fetch = async (url, opts) => {
    if (holdNextSkill && String(url).startsWith('/api/skills')) {
      holdNextSkill = false;
      const barrier = new Promise((resolve) => { releaseSkill = resolve; });
      skillHeld();
      await barrier;
    }
    return realFetch(String(url).startsWith('/') ? base + url : url, opts);
  };
  const realWarn = console.warn;
  console.warn = (...args) => {
    errors.push(args.join(' '));
    realWarn(...args);
  };
});

after(async () => {
  server.close();
  await ctx.runtime.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function go(hash) {
  location.hash = hash;
  for (const fn of winListeners.hashchange || []) await fn();
  return els.view.innerHTML;
}

test('every console page renders real API data without script errors', async () => {
  await api('POST', '/api/roles', { name: '界面测试', title: '运行测试' });
  const done = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: '写一个测试文件', session: { title: 'UI 测试会话' } });
  for (let i = 0; i < 100; i += 1) {
    const run = await api('GET', `/api/runs/${done.id}`);
    if (run.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const approval = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'APPROVAL 写入', useRoleSkills: false });
  for (let i = 0; i < 100; i += 1) {
    const run = await api('GET', `/api/runs/${approval.id}`);
    if (run.status === 'waiting_approval') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await import(pathToFileURL(path.resolve(here, '../public/app.js')).href);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(els.sidebar.innerHTML, /href="#\/manager".*交代任务/s);
  assert.match(els.sidebar.kids['.nav-roles'].innerHTML, /全栈开发.*开发A/s);
  assert.match(els.sidebar.kids['.nav-items'].innerHTML, /办公室/);

  const pages = [
    ['#/', /岗位动态/],
    ['#/approvals', /批准一次/],
    ['#/runs', /负责岗位/],
    [`#/run/${done.id}`, /结果回传/],
    [`#/run/${approval.id}`, /拒绝并中断/],
    ['#/sessions', /UI 测试会话/],
    ['#/sessions?tab=desktop', /未切换/],
    ['#/sessions?tab=migration', /历史映射/],
    ['#/team', /桌面员工/],
    ['#/team?scope=runner', /先建立一个测试团队/],
    [`#/chat/${done.sessionId}`, /岗位配置/],
    ['#/roles', /新增岗位/],
    ['#/role/fullstack_developer_2', /桌面活动/],
    ['#/office', /控制台/],
    ['#/handoffs', /原生聊天/],
    ['#/usage', /按岗位/],
    ['#/system', /Codex App Server/],
    ['#/dispatch', /派单并开始执行/],
    [`#/dispatch?session=${done.sessionId}`, /旧原生岗位/],
  ];
  for (const [hash, expected] of pages) {
    const html = await go(hash);
    assert.doesNotMatch(html, /出现问题/, `${hash} 渲染出错：${html.slice(0, 200)}`);
    assert.match(html, expected, `${hash} 缺少预期内容`);
    assert.doesNotMatch(html, /undefined|\[object Object\]/, `${hash} 含未处理值`);
  }
  const office = await go('#/office');
  assert.match(office, /class="cap-figure/);
  assert.match(office, /任务与审批/);
  assert.doesNotMatch(office, /pet-/);
  assert.deepEqual(errors, []);
});

test('a late role response cannot overwrite the page the user has switched to', async () => {
  holdNextSkill = true;
  const held = new Promise((resolve) => { skillHeld = resolve; });
  const localRole = ctx.workbench.listRoles().find((r) => r.source === 'local' && r.name === '界面测试');
  const oldPage = go(`#/role/${localRole.key}`);
  await held;
  try {
    const usage = await go('#/usage');
    assert.match(usage, /按岗位/);
  } finally {
    releaseSkill();
  }
  await oldPage;
  assert.match(els.view.innerHTML, /按岗位/);
  assert.doesNotMatch(els.view.innerHTML, /岗位 Skill/);
  assert.deepEqual(errors, []);
});
