import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopIpc, DesktopIpcError } from './codex/desktop-ipc.mjs';

// There is deliberately no preselected desktop conversation.
export const DESKTOP_MANAGER_THREAD = null;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const now = () => new Date().toISOString();

export function desktopTurns(conversation) {
  const canonical = conversation?.turnHistory?.kind === 'canonical'
    ? Object.values(conversation.turnHistory.history?.entitiesByKey || {}) : [];
  return [...canonical, ...(conversation?.turns || [])];
}

export function applyDesktopPatches(state, patches) {
  let next = state;
  const copy = (value) => {
    if (!value || typeof value !== 'object') throw new Error('桌面状态路径无效');
    return Array.isArray(value) ? value.slice() : { ...value };
  };
  for (const patch of patches) {
    const parts = patch.path;
    if (!Array.isArray(parts) || parts.some((k) => ['__proto__', 'constructor', 'prototype'].includes(String(k))) || !['add', 'replace', 'remove'].includes(patch.op)) throw new Error('不支持的桌面状态变更');
    if (!parts.length) { if (patch.op === 'remove') throw new Error('不能删除会话'); next = structuredClone(patch.value); continue; }
    const updated = copy(next); let parent = updated, original = next;
    for (const key of parts.slice(0, -1)) {
      if (!original || typeof original !== 'object' || !Object.hasOwn(original, key)) throw new Error('桌面状态版本不一致');
      parent[key] = copy(original[key]); parent = parent[key]; original = original[key];
    }
    const key = parts.at(-1);
    if (!parent || typeof parent !== 'object') throw new Error('桌面状态路径无效');
    if (Array.isArray(parent) && key !== 'length') {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length || (patch.op !== 'add' && index === parent.length)) throw new Error('桌面状态索引无效');
      if (patch.op === 'add') parent.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(patch.value);
    } else if (patch.op === 'remove') delete parent[key];
    else parent[key] = structuredClone(patch.value);
    next = updated;
  }
  return next;
}

export class DesktopManager extends EventEmitter {
  constructor({ dataDir, client, threadId, name } = {}) {
    super();
    this.file = path.join(dataDir, 'desktop-manager.json');
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.threadId = threadId || saved.target?.threadId || saved.threadId || null;
    this.name = name || saved.target?.name || '桌面经理';
    this.client = client || new DesktopIpc({ socketPath: saved.socketPath || undefined });
    client = this.client; this.ownerClientId = null;
    this.conversation = null; this.revision = null; this.connecting = null;
    this.lastError = null; this.connectedAt = null; this.awaitingSnapshot = false;
    this.messages = saved.messages || [];
    for (const msg of this.messages) if (msg.status === 'submitting') msg.status = 'unknown';
    client.on('broadcast', (message) => this.#broadcast(message));
    client.on('disconnected', () => { this.conversation = null; this.ownerClientId = null; this.#changed(); });
    client.on('connectionError', (error) => { this.lastError = error.message; this.#changed(); });
  }

  async connect() {
    if (!this.threadId) throw new DesktopIpcError('请先选择一个 Codex 桌面聊天', { status: 409 });
    if (this.conversation && this.ownerClientId && this.client.clientId) { this.lastError = null; return; }
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    await this.client.connect();
    const owner = await this.client.request('thread-owner-discovery', { hostId: 'local', conversationId: this.threadId });
    if (!owner.handledByClientId || owner.result?.supportsUntrustedAppInput !== true) throw new DesktopIpcError('当前桌面会话没有可用的持有端');
    this.ownerClientId = owner.handledByClientId;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('changed', done); this.client.off('connectionError', failed); this.client.off('disconnected', disconnected); };
      const done = () => { if (!this.conversation) return; cleanup(); resolve(); };
      const failed = (error) => { cleanup(); reject(error); };
      const disconnected = () => failed(new DesktopIpcError('桌面连接已断开'));
      const timer = setTimeout(() => failed(new DesktopIpcError('未收到当前桌面会话状态')), 15_000);
      this.on('changed', done);
      this.client.on('connectionError', failed); this.client.on('disconnected', disconnected);
      try { this.client.follow(this.threadId, this.ownerClientId); } catch (error) { failed(error); }
    });
    this.connectedAt = now(); this.lastError = null; this.#changed();
  }

  snapshot() {
    const ready = Boolean(this.conversation && this.ownerClientId && this.client.clientId);
    const activeTurn = desktopTurns(this.conversation).findLast((turn) => turn.status === 'inProgress');
    const busy = ready && (this.conversation.threadRuntimeStatus?.type === 'active' || Boolean(activeTurn));
    return { configured: Boolean(this.threadId), target: this.threadId ? { threadId: this.threadId, hostId: 'local', roleTitle: '总经理', name: this.name } : null, ready, busy,
      channel: 'desktop-ipc-follower', connectedAt: this.connectedAt, lastError: this.lastError,
      socketPath: this.client.socketPath || '', ownerClientId: this.ownerClientId, revision: this.revision, messages: this.messages.filter((m) => m.threadId === this.threadId).slice(-30) };
  }

  async readStatus() {
    if (!this.threadId) return this.snapshot();
    try { await this.connect(); } catch (error) { this.lastError = error.message; }
    return this.snapshot();
  }

  async configure({ threadId, name = '桌面经理', socketPath = '', ...extra }) {
    if (Object.keys(extra).length) throw new DesktopIpcError('连接设置包含未知字段', { status: 400 });
    if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new DesktopIpcError('请填写有效的聊天 ID', { status: 400 });
    if (typeof name !== 'string' || name.trim().length > 40 || typeof socketPath !== 'string' || (socketPath && !path.isAbsolute(socketPath))) throw new DesktopIpcError('请核对聊天名称与本机入口路径', { status: 400 });
    this.#canChangeTarget();
    this.close(); this.ownerClientId = null; this.revision = null; this.connectedAt = null; this.lastError = null;
    this.threadId = threadId; this.name = name.trim() || '桌面经理';
    this.client.socketPath = socketPath ? path.normalize(socketPath) : new DesktopIpc().socketPath;
    this.#save(); this.#changed(); return this.readStatus();
  }

  disconnect() {
    this.#canChangeTarget(); this.close(); this.threadId = null; this.ownerClientId = null;
    this.revision = null; this.lastError = null; this.connectedAt = null;
    this.#save(); this.#changed(); return this.snapshot();
  }

  #canChangeTarget() {
    if (this.connecting) throw new DesktopIpcError('正在检查连接，请稍候再更换', { status: 409 });
    if (this.snapshot().busy || this.messages.some((m) => m.threadId === this.threadId && ['submitting', 'submitted', 'received', 'unknown'].includes(m.status))) throw new DesktopIpcError('当前聊天仍在执行或等待核实，请结束后再更换连接', { status: 409 });
  }

  async send({ requestId, text, ...extra }) {
    if (Object.keys(extra).length) throw new DesktopIpcError('只接受消息正文和请求 ID', { status: 400 });
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(requestId || '')) || typeof text !== 'string' || !text.trim() || text.length > 6000) throw new DesktopIpcError('请输入 1 至 6000 字的消息', { status: 400 });
    const previous = this.messages.find((m) => m.id === requestId);
    if (previous) {
      if (previous.threadId !== this.threadId) throw new DesktopIpcError('请求 ID 已属于另一个聊天', { status: 409 });
      if (previous.text !== text.trim()) throw new DesktopIpcError('同一请求 ID 的正文不能改变', { status: 409 });
      return previous; // Unknown submissions also stay recorded; never silently resend them.
    }
    await this.connect();
    const existing = this.messages.find((m) => m.id === requestId);
    if (existing) {
      if (existing.text !== text.trim()) throw new DesktopIpcError('同一请求 ID 的正文不能改变', { status: 409 });
      return existing;
    }
    if (this.snapshot().busy || this.messages.some((m) => m.threadId === this.threadId && ['submitting', 'submitted', 'received', 'unknown'].includes(m.status))) throw new DesktopIpcError('上一条消息仍在处理或等待核实，请先核对状态', { status: 409 });
    const message = { id: requestId, threadId: this.threadId, text: text.trim(), status: 'submitting', createdAt: now(), ownerClientId: this.ownerClientId, replyText: '' };
    this.messages.push(message); this.#save(); this.#changed();
    const request = { conversationId: this.threadId, turnStart: { request: { threadId: this.threadId,
      input: [{ type: 'text', text: message.text, text_elements: [] }], clientUserMessageId: requestId }, context: { inheritThreadSettings: true } } };
    message.request = request; this.#save();
    try {
      const result = await this.client.request('thread-follower-start-turn', request, { targetClientId: this.ownerClientId, requestId, timeoutMs: 45_000 });
      message.submission = result; message.submittedAt = now();
      const turn = result.result?.result?.turn || result.result?.turn;
      if (turn?.id) message.turnId = turn.id;
      if (message.status === 'submitting') message.status = 'submitted';
      this.#reconcile();
    } catch (error) {
      message.submissionError = { message: error.message, result: error.result || null };
      // A rejected transport after dispatch can have an unknown model outcome. Keep receipt.
      if (!message.receivedAt) message.status = error.unknown || /timeout|connection|result unknown|outcome unknown/i.test(error.message) ? 'unknown' : 'error';
      this.lastError = error.message;
    }
    this.#save(); this.#changed(); return message;
  }

  close() {
    if (this.ownerClientId && this.client.clientId) { try { this.client.follow(this.threadId, this.ownerClientId, false); } catch { /* connection already closed */ } }
    this.client.close(); this.conversation = null;
  }

  #broadcast(message) {
    if (message.type === 'broadcast' && message.method === 'client-status-changed' && message.version === 0 && message.params?.clientId === this.ownerClientId && message.params?.status === 'disconnected') {
      this.conversation = null; this.ownerClientId = null; this.lastError = '桌面经理连接已断开'; this.#changed(); return;
    }
    if (message.type !== 'broadcast' || message.method !== 'thread-stream-state-changed' || message.version !== 11 || message.sourceClientId !== this.ownerClientId || message.params?.hostId !== 'local' || message.params?.conversationId !== this.threadId) return;
    const change = message.params.change;
    try {
      if (change?.type === 'snapshot') {
        if (change.conversationState?.id !== this.threadId) throw new Error('桌面会话 ID 不匹配');
        this.conversation = change.conversationState; this.revision = change.revision; this.awaitingSnapshot = false;
      } else if (change?.type === 'patches') {
        if (!this.conversation || change.baseRevision !== this.revision) throw new Error('桌面事件版本有缺口');
        const next = applyDesktopPatches(this.conversation, change.patches);
        if (next.id !== this.threadId) throw new Error('桌面会话 ID 不匹配');
        this.conversation = next; this.revision = change.revision;
      } else return;
      this.lastError = null; this.#reconcile(); this.#changed();
    } catch (error) {
      this.lastError = error.message; this.conversation = null; this.#changed();
      if (!this.awaitingSnapshot && this.ownerClientId) {
        this.awaitingSnapshot = true;
        try { this.client.follow(this.threadId, this.ownerClientId); } catch { /* reconnect on next read */ }
      }
    }
  }

  #reconcile() {
    let changed = false;
    for (const message of this.messages) {
      if (message.threadId !== this.threadId) continue;
      const turn = desktopTurns(this.conversation).find((turn) => turn.params?.clientUserMessageId === message.id || (message.turnId && turn.turnId === message.turnId));
      if (!turn) continue;
      const prior = JSON.stringify(message);
      message.turnId = turn.turnId || turn.id || message.turnId;
      message.receivedAt ||= turn.turnStartedAtMs ? new Date(turn.turnStartedAtMs).toISOString() : now(); message.status = 'received';
      message.receivedObservedAt ||= now();
      const agent = (turn.items || []).filter((item) => item.type === 'agentMessage');
      message.replyText = agent.filter((item) => item.phase !== 'commentary').map((item) => item.text || '').join('\n\n');
      message.progressText = agent.filter((item) => item.phase === 'commentary').map((item) => item.text || '').join('\n\n');
      message.replyItemIds = agent.filter((item) => item.phase !== 'commentary').map((item) => item.id).filter(Boolean);
      message.replySource = { threadId: this.threadId, turnId: message.turnId, ownerClientId: this.ownerClientId, revision: this.revision };
      message.nativeTurnStatus = turn.status;
      if (TERMINAL.has(turn.status)) {
        message.status = turn.status === 'completed' ? (message.replyText ? 'completed' : 'completed_empty') : turn.status === 'interrupted' ? 'interrupted' : 'error';
        message.completedAt ||= turn.turnStartedAtMs && turn.durationMs != null ? new Date(turn.turnStartedAtMs + turn.durationMs).toISOString() : now(); message.error = turn.error || null;
      }
      if (prior !== JSON.stringify(message)) changed = true;
    }
    if (changed) this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 2, target: this.threadId ? { threadId: this.threadId, name: this.name } : null, socketPath: this.client.socketPath || '', messages: this.messages }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  #changed() { this.emit('changed', this.snapshot()); }
}
