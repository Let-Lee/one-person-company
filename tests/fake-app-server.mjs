// Protocol-level stand-in for `codex app-server` used by the regression tests.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

let extraRoots = [];
let threadSeq = 0;
let turnSeq = 0;
let serverReqSeq = 0;
const threads = new Map();
const pendingServer = new Map();
const slowTurns = new Map();

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => write({ method, params });
const reply = (id, result) => write({ id, result });
const fail = (id, code, message) => write({ id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listSkills() {
  const out = [];
  for (const root of extraRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, 'SKILL.md');
      if (fs.existsSync(file)) out.push({ name, description: `${name} skill`, path: file, scope: 'user', enabled: true });
    }
  }
  out.push({ name: 'disabled-skill', description: 'off', path: '/nowhere/disabled/SKILL.md', scope: 'user', enabled: false });
  return out;
}

function usage(threadId, turnId, tokens) {
  const t = threads.get(threadId);
  t.total += tokens;
  const breakdown = (n) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: Math.floor(n / 2), cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 });
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: breakdown(t.total), last: breakdown(tokens), modelContextWindow: 1000 } });
}

function askServer(method, params) {
  const id = serverReqSeq++;
  write({ id, method, params });
  return new Promise((resolve) => pendingServer.set(id, resolve));
}

async function runTurn(threadId, turn, input) {
  const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const turnId = turn.id;
  const base = { threadId, turnId };
  notify('turn/started', { threadId, turn: { ...turn, status: 'inProgress', items: [] } });
  notify('item/completed', { ...base, item: { type: 'userMessage', id: `u-${turnId}`, content: input } });
  if (text.includes('SLOW')) {
    notify('item/started', { ...base, item: { type: 'commandExecution', id: `c-${turnId}`, command: 'sleep 40', cwd: '/tmp', status: 'inProgress', commandActions: [] } });
    notify('item/commandExecution/outputDelta', { ...base, itemId: `c-${turnId}`, delta: 'waiting…' });
    await new Promise((resolve) => slowTurns.set(turnId, resolve));
    usage(threadId, turnId, 40);
    notify('turn/completed', { threadId, turn: { ...turn, status: 'interrupted', items: [], durationMs: 5, error: null } });
    return;
  }
  if (text.includes('APPROVAL')) {
    const answer = await askServer('item/commandExecution/requestApproval', { ...base, itemId: `c-${turnId}`, command: 'touch approved.txt', cwd: '/tmp', reason: '需要写文件', startedAtMs: Date.now() });
    notify('serverRequest/resolved', { threadId, requestId: serverReqSeq - 1 });
    const accepted = answer?.decision === 'accept' || answer?.decision === 'acceptForSession';
    notify('item/completed', { ...base, item: { type: 'commandExecution', id: `c-${turnId}`, command: 'touch approved.txt', cwd: '/tmp', status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null, aggregatedOutput: '', commandActions: [] } });
  }
  if (!text.includes('NOACTION') && !text.includes('APPROVAL')) {
    notify('item/started', { ...base, item: { type: 'commandExecution', id: `c-${turnId}`, command: 'printf ok > out.txt', cwd: '/tmp', status: 'inProgress', commandActions: [] } });
    notify('item/completed', { ...base, item: { type: 'commandExecution', id: `c-${turnId}`, command: 'printf ok > out.txt', cwd: '/tmp', status: 'completed', exitCode: 0, durationMs: 3, aggregatedOutput: 'ok', commandActions: [{ type: 'unknown', command: 'printf' }] } });
    notify('item/completed', { ...base, item: { type: 'fileChange', id: `f-${turnId}`, status: 'completed', changes: [{ path: '/tmp/out.txt', kind: { type: 'add' }, diff: '+ok' }] } });
  }
  usage(threadId, turnId, 100);
  const msgId = `m-${turnId}`;
  notify('item/started', { ...base, item: { type: 'agentMessage', id: msgId, text: '', phase: 'final_answer' } });
  for (const part of ['已', '完成']) notify('item/agentMessage/delta', { ...base, itemId: msgId, delta: part });
  await sleep(5);
  usage(threadId, turnId, 50);
  const final = { type: 'agentMessage', id: msgId, text: `已完成：${text.slice(0, 20)}`, phase: 'final_answer' };
  notify('item/completed', { ...base, item: final });
  notify('turn/completed', { threadId, turn: { ...turn, status: 'completed', items: [final], durationMs: 12, error: null } });
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    pendingServer.get(msg.id)?.(msg.result);
    pendingServer.delete(msg.id);
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, { userAgent: 'fake-codex/0', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' });
    case 'initialized':
      return;
    case 'skills/extraRoots/set':
      extraRoots = params.extraRoots;
      return reply(id, {});
    case 'skills/list':
      return reply(id, { data: [{ cwd: params.cwds[0], skills: listSkills(), errors: [] }] });
    case 'model/list':
      return reply(id, { data: [{ id: 'fake-model', displayName: 'Fake', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] });
    case 'thread/start': {
      const threadId = `thr-${process.pid}-${++threadSeq}`;
      threads.set(threadId, { total: 0, cwd: params.cwd });
      return reply(id, { thread: { id: threadId, status: { type: 'idle' } }, cwd: params.cwd, model: 'fake-model', modelProvider: 'fake', instructionSources: [`${params.cwd}/AGENTS.md`], approvalPolicy: params.approvalPolicy, sandbox: {} });
    }
    case 'thread/resume': {
      if (params.threadId.startsWith('desktop-')) return fail(id, -32600, `thread ${params.threadId} already has an active writer`);
      if (!threads.has(params.threadId)) threads.set(params.threadId, { total: 0 });
      const t = threads.get(params.threadId);
      if (t.total) notify('thread/tokenUsage/updated', { threadId: params.threadId, turnId: 'old-turn', tokenUsage: { total: { totalTokens: t.total }, last: { totalTokens: 1 } } });
      return reply(id, { thread: { id: params.threadId, status: { type: 'idle' } }, cwd: t.cwd || process.env.FAKE_NATIVE_CWD, model: 'fake-model', modelProvider: 'fake', approvalPolicy: 'on-request', reasoningEffort: 'low' });
    }
    case 'thread/read':
      if (params.threadId.startsWith('missing')) return fail(id, -32600, 'thread not found');
      return reply(id, { thread: { id: params.threadId, cwd: threads.get(params.threadId)?.cwd || process.env.FAKE_NATIVE_CWD, model: 'fake-model', modelProvider: 'fake', status: { type: 'notLoaded' }, source: 'vscode', updatedAt: 1, name: 'desk' } });
    case 'thread/turns/list':
      return reply(id, { data: [{ id: 't1', status: 'completed', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: '问' }] }, { type: 'agentMessage', id: 'a', text: '答', phase: 'final_answer' }] }] });
    case 'thread/name/set':
    case 'thread/archive':
      return reply(id, {});
    case 'thread/unsubscribe':
      return reply(id, { status: 'unsubscribed' });
    case 'turn/start': {
      const turn = { id: `turn-${process.pid}-${++turnSeq}`, items: [], status: 'inProgress' };
      reply(id, { turn });
      runTurn(params.threadId, turn, params.input);
      return;
    }
    case 'turn/steer':
      return reply(id, { turnId: params.expectedTurnId });
    case 'turn/interrupt':
      slowTurns.get(params.turnId)?.();
      slowTurns.delete(params.turnId);
      return reply(id, {});
    default:
      return fail(id, -32601, `unknown ${method}`);
  }
});
