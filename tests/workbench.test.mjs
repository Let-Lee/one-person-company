import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, createWorkbench } from '../src/app.mjs';
import { CodexRuntime } from '../src/codex/codex-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let tmp;
let ctx;
let server;
let base;
let events = [];

function fixtureCompany(root) {
  fs.mkdirSync(path.join(root, '公司/组织/回报发送凭据'), { recursive: true });
  fs.mkdirSync(path.join(root, '.codex/agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '公司/组织/聊天通讯录.json'),
    JSON.stringify({ members: [
      { name: '经理A', role: 'general_manager', title: '总经理｜经理A', threadId: 'desktop-gm' },
      { name: '开发A', role: 'fullstack_developer_2', title: '全栈开发｜开发A', threadId: 'desktop-dev2', currentTaskId: 'T1' },
    ] }),
  );
  fs.writeFileSync(path.join(root, '.codex/agents/fullstack_developer_2.toml'), 'name = "fullstack_developer_2"\ndescription = "全栈开发：示例项目"\ndeveloper_instructions = """\n只属于真实聊天\n"""\n');
  fs.writeFileSync(path.join(root, '公司/组织/回报发送凭据/send-abc.json'), JSON.stringify({ sourceThreadId: 'desktop-gm', recipientThreadId: 'desktop-dev2', messageKind: 'dispatch', savedAt: '2026-10-14T02:21:12+08:00', primaryTaskId: 'T1', submissionVerified: true, request: { prompt: '私密正文不应出现在交接接口' } }));
}

async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-yewang-workbench': '1' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  return { status: res.status, data };
}

async function waitFor(fn, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const runStatus = async (id, status) => waitFor(async () => {
  const { data } = await api('GET', `/api/runs/${id}`);
  return data.status === status ? data : null;
}, `run ${id} -> ${status}`);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yewang-wb-'));
  const company = path.join(tmp, 'company');
  fixtureCompany(company);
  const skillRoot = path.join(tmp, 'skills');
  fs.mkdirSync(path.join(skillRoot, 'probe-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'probe-skill/SKILL.md'), '---\nname: probe-skill\ndescription: probe\n---\n');
  const env = { YEWANG_IMPORT_COMPANY: '1', YEWANG_COMPANY_ROOT: company, YEWANG_DATA_DIR: path.join(tmp, 'data'), YEWANG_WORKSPACES_ROOT: path.join(tmp, 'ws'), YEWANG_EXTRA_SKILL_ROOTS: skillRoot, YEWANG_MAX_CONCURRENT: '1' };
  const runtime = new CodexRuntime({ codexBin: process.execPath, args: [path.join(here, 'fake-app-server.mjs')], cwd: tmp, extraSkillRoots: [skillRoot] });
  ctx = createWorkbench({ env, runtime });
  ctx.workbench.on('event', (e) => events.push(e));
  server = createServer({ workbench: ctx.workbench, paths: ctx.paths, nativeCollaboration: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await ctx.runtime.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('rejects cross-site writes and foreign hosts', async () => {
  const noHeader = await fetch(`${base}/api/roles`, { method: 'POST', body: '{}' });
  assert.equal(noHeader.status, 403);
  const foreign = await fetch(`${base}/api/roles`, { method: 'POST', headers: { 'x-yewang-workbench': '1', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(foreign.status, 403);
});

test('lists company roles with character appearance and exposes only handoff metadata', async () => {
  const { data } = await api('GET', '/api/roles');
  const dev = data.roles.find((r) => r.key === 'fullstack_developer_2');
  assert.equal(dev.appearance.palette, 'violet-ember');
  assert.equal(dev.appearance.emblem, 'code');
  assert.equal(dev.roleTitle, '全栈开发');
  assert.equal(dev.project, null);
  assert.equal(dev.deptLabel, '产品研发');
  assert.equal(dev.description, '全栈开发：示例项目');
  const handoffs = await api('GET', '/api/handoffs');
  const native = handoffs.data.handoffs.find((h) => h.channel === 'native');
  assert.equal(native.fromName, '经理A');
  assert.equal(native.toName, '开发A');
  assert.ok(!JSON.stringify(handoffs.data).includes('私密正文'));
});

test('dispatch runs a real turn lifecycle with skill injection, streaming, usage and result return', async () => {
  const cfg = await api('PATCH', '/api/roles/fullstack_developer_2/config', { skills: ['probe-skill'] });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.data.skills.map((s) => s.name), ['probe-skill']);
  const bad = await api('PATCH', '/api/roles/fullstack_developer_2/config', { skills: ['disabled-skill'] });
  assert.equal(bad.status, 400);
  const { status, data } = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: '写文件' });
  assert.equal(status, 200);
  const run = await runStatus(data.id, 'completed');
  assert.equal(run.finalText, '已完成：写文件');
  assert.equal(run.skills[0].name, 'probe-skill');
  assert.ok(run.skills[0].sha256);
  assert.equal(run.skillEvidence.injected[0].name, 'probe-skill');
  assert.equal(run.claimCheck.kind, 'actions_observed');
  assert.equal(run.counts.commands, 1);
  assert.equal(run.counts.fileChanges, 1);
  assert.equal(run.usage.totalTokens, 150);
  assert.ok(run.returnedAt);
  assert.ok(events.some((e) => e.type === 'run.delta' && e.runId === run.id));
  const handoffs = await api('GET', '/api/handoffs');
  assert.ok(handoffs.data.handoffs.some((h) => h.runId === run.id && h.kind === 'report'));
});

test('continuing the same session reuses the thread and counts only the new turn usage', async () => {
  const first = (await api('GET', '/api/runs')).data.runs.at(-1);
  const cont = await api('POST', `/api/sessions/${first.sessionId}/continue`, { prompt: 'NOACTION 继续' });
  const run = await runStatus(cont.data.id, 'completed');
  assert.equal(run.threadId, first.threadId);
  assert.equal(run.kind, 'continue');
  assert.equal(run.usage.totalTokens, 150);
  assert.equal(run.claimCheck.kind, 'no_actions_observed');
});

test('approval requests reach the console and the decision is returned to Codex', async () => {
  const { data } = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'APPROVAL 写入', useRoleSkills: false });
  const waiting = await runStatus(data.id, 'waiting_approval');
  const approval = waiting.approvals.find((a) => a.status === 'pending');
  assert.equal(approval.command, 'touch approved.txt');
  const decided = await api('POST', `/api/approvals/${approval.id}`, { decision: 'accept' });
  assert.equal(decided.data.status, 'accepted');
  const run = await runStatus(data.id, 'completed');
  assert.equal(run.items.find((i) => i.type === 'commandExecution').status, 'completed');
});

test('pause interrupts the turn, queue respects capacity, and continue resumes after a runtime restart', async () => {
  const slow = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'SLOW 任务', useRoleSkills: false });
  await runStatus(slow.data.id, 'running');
  const queued = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'NOACTION 排队', useRoleSkills: false });
  assert.equal(queued.data.status, 'queued');
  const dup = await api('POST', '/api/runs', { sessionId: slow.data.sessionId, prompt: '同会话重复' });
  assert.equal(dup.status, 409);
  const steer = await api('POST', `/api/runs/${slow.data.id}/steer`, { text: '补充：只写测试目录' });
  assert.equal(steer.data.steers.length, 1);
  await api('POST', `/api/runs/${slow.data.id}/interrupt`, { mode: 'pause' });
  const paused = await runStatus(slow.data.id, 'interrupted');
  assert.equal(paused.stopMode, 'pause');
  assert.equal(paused.items.find((i) => i.type === 'commandExecution').status, 'interrupted');
  assert.equal(paused.items.find((i) => i.type === 'commandExecution').output, 'waiting…');
  await runStatus(queued.data.id, 'completed');
  const sessions = (await api('GET', '/api/sessions')).data.sessions;
  assert.equal(sessions.find((s) => s.id === slow.data.sessionId).status, 'paused');
  await api('POST', '/api/runtime/restart');
  const cont = await api('POST', `/api/sessions/${slow.data.sessionId}/continue`, {});
  const resumed = await runStatus(cont.data.id, 'completed');
  assert.equal(resumed.resumedThread, true);
  assert.equal(resumed.usage.totalTokens, 150);
});

test('stop on a queued run cancels it without touching Codex', async () => {
  const slow = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'SLOW 再来', useRoleSkills: false });
  await runStatus(slow.data.id, 'running');
  const queued = await api('POST', '/api/runs', { roleKey: 'fullstack_developer_2', prompt: 'NOACTION', useRoleSkills: false });
  const cancelled = await api('POST', `/api/runs/${queued.data.id}/interrupt`, { mode: 'stop' });
  assert.equal(cancelled.data.status, 'cancelled');
  await api('POST', `/api/runs/${slow.data.id}/interrupt`, { mode: 'stop' });
  const stopped = await runStatus(slow.data.id, 'interrupted');
  assert.equal(stopped.stopMode, 'stop');
  const sessions = (await api('GET', '/api/sessions')).data.sessions;
  assert.equal(sessions.find((s) => s.id === slow.data.sessionId).status, 'stopped');
});

test('desktop sessions are readable but takeover reports the active writer conflict', async () => {
  const list = await api('GET', '/api/desktop-sessions');
  assert.equal(list.data.sessions.length, 2);
  assert.ok(list.data.sessions.every((s) => s.readable));
  const unconfirmed = await api('POST', '/api/desktop-sessions/desktop-dev2/takeover-probe', {});
  assert.equal(unconfirmed.status, 400);
  const probe = await api('POST', '/api/desktop-sessions/desktop-dev2/takeover-probe', { confirm: true });
  assert.equal(probe.data.ok, false);
  assert.equal(probe.data.code, -32600);
  const notRegistered = await api('POST', '/api/desktop-sessions/other/takeover-probe', { confirm: true });
  assert.equal(notRegistered.status, 404);
});

test('local roles, workspace limits and archiving', async () => {
  const role = await api('POST', '/api/roles', { name: '测试员', title: '运行测试', description: '只做测试', palette: 'deep-tide', emblem: 'shield' });
  assert.equal(role.data.appearance.palette, 'deep-tide');
  assert.equal(role.data.roleTitle, '运行测试');
  assert.equal(role.data.deptLabel, 'AI 团队');
  const outside = await api('POST', '/api/sessions', { roleKey: role.data.key, cwd: os.homedir() });
  assert.equal(outside.status, 400);
  const session = await api('POST', '/api/sessions', { roleKey: role.data.key, title: '测试会话' });
  assert.equal(session.status, 200);
  assert.ok(session.data.instructionSources[0].endsWith('AGENTS.md'));
  const archived = await api('POST', `/api/sessions/${session.data.id}/archive`);
  assert.equal(archived.data.archived, true);
  const usage = await api('GET', '/api/usage');
  assert.equal(usage.data.costUsd, null);
  assert.ok(usage.data.total.totalTokens >= 600);
});
