import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DesktopIpc, DesktopIpcError } from './codex/desktop-ipc.mjs';
import { applyDesktopPatches, desktopTurns } from './desktop-manager.mjs';
import { bodyHash, nativeInbound, readManagerDecisions, readNativeReceipts, registeredMembers, safeFile, submittedTarget, taskIdsIn, TASK_RE } from './native-evidence.mjs';

const now = () => new Date().toISOString();
const at = (turn) => turn.turnStartedAtMs ? new Date(turn.turnStartedAtMs).toISOString() : null;
const TOOLS = new Set(['mcpToolCall', 'commandExecution', 'fileChange', 'webSearch', 'dynamicToolCall']);
const uniqueTurns = (conversation) => [...new Map(desktopTurns(conversation).filter((t) => t.turnId || t.id)
  .map((t) => [t.turnId || t.id, t])).values()].sort((a, b) => (a.turnStartedAtMs || 0) - (b.turnStartedAtMs || 0)).slice(-3);

/** A follower of registered desktop chats. This controller cannot start, steer, stop or dispatch a turn. */
export class NativeCollaboration extends EventEmitter {
  constructor({ company, dataDir, client = new DesktopIpc({ timeoutMs: 6000 }) }) {
    super(); this.company = company; this.client = client; this.routes = new Map(); this.observed = new Map();
    this.file = path.join(dataDir, 'native-collaboration.json'); this.connecting = null; this.closed = false;
    this.lastError = null; this.receipts = []; this.decisions = []; this.watchers = [];
    this.members = registeredMembers(company);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const event of saved.events || []) if (event.channel === 'desktop-native' &&
          this.members.some((m) => m.threadId === event.sourceThreadId) &&
          this.members.some((m) => m.threadId === event.recipientThreadId)) this.observed.set(event.id, event);
    } catch { /* first start, or an invalid cache: rebuild from current native evidence */ }
    this.refreshEvidence(false);
    client.on('broadcast', (message) => this.#broadcast(message));
    client.on('disconnected', () => {
      for (const route of this.routes.values()) { route.state = null; route.ownerClientId = null; }
      this.lastError = '桌面事件连接已断开'; this.#changed(); this.#retryConnection();
    });
    client.on('connectionError', (error) => { this.lastError = error.message; this.#changed(); });
    for (const dir of [company.receiptsDir, path.dirname(company.contactsFile)]) {
      try {
        this.watchers.push(fs.watch(dir, (_type, file) => {
          if (file && !String(file).startsWith('send-') && !['员工回报处理记录.json', '聊天通讯录.json'].includes(String(file))) return;
          clearTimeout(this.evidenceTimer);
          this.evidenceTimer = setTimeout(() => {
            try { this.refreshEvidence(); } catch (error) { this.lastError = error.message; this.#changed(); }
          }, 180);
          this.evidenceTimer.unref();
        }));
      } catch { /* directory may not yet exist in a test fixture */ }
    }
  }

  get managerThreadId() { return this.members.find((m) => m.role === 'general_manager')?.threadId || null; }

  refreshEvidence(emit = true) {
    const members = registeredMembers(this.company);
    const current = new Map(members.map((m) => [m.threadId, m]));
    for (const [threadId, route] of this.routes) if (!current.has(threadId) || current.get(threadId).role !== route.member.role) {
      if (route.ownerClientId && this.client.clientId) this.client.follow(threadId, route.ownerClientId, false);
      this.routes.delete(threadId);
    }
    for (const [threadId, route] of this.routes) route.member = current.get(threadId);
    this.members = members;
    this.receipts = readNativeReceipts(this.company, members);
    this.decisions = readManagerDecisions(this.company, members, this.receipts);
    for (const route of this.routes.values()) if (route.state) this.#observe(route);
    if (emit) this.#changed();
  }

  async connect() {
    if (this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    await this.client.connect();
    const relevant = new Set(this.receipts.filter((r) => r.taskId && r.kind === 'dispatch')
      .flatMap((r) => [r.sourceThreadId, r.recipientThreadId]));
    relevant.add(this.managerThreadId);
    const pending = this.members.filter((m) => {
      const route = this.routes.get(m.threadId);
      return relevant.has(m.threadId) && !route?.state && !route?.subscribing && (!route?.error || Date.now() - (route.lastAttempt || 0) >= 30000);
    });
    if (!pending.length) return;
    const recentEmployee = this.receipts.find((r) => r.kind === 'dispatch')?.recipientThreadId;
    const first = pending.filter((m) => m.threadId === this.managerThreadId || m.threadId === recentEmployee);
    await Promise.allSettled(first.map((member) => this.#subscribe(member)));
    const rest = pending.filter((m) => !first.includes(m));
    // Unopened chats may not have a desktop owner. Discover them in the background without delaying the current task.
    const discover = async () => {
      for (let i = 0; i < rest.length && !this.closed; i += 3) await Promise.allSettled(rest.slice(i, i + 3).map((m) => this.#subscribe(m)));
    };
    discover().catch((error) => { this.lastError = error.message; this.#changed(); });
    this.lastError = null;
    this.#changed();
  }

  async #subscribe(member) {
    const route = this.routes.get(member.threadId) || { member, state: null, revision: null, ownerClientId: null };
    if (route.subscribing || (route.error && Date.now() - (route.lastAttempt || 0) < 30000)) return;
    route.subscribing = true; route.lastAttempt = Date.now();
    route.member = member; this.routes.set(member.threadId, route);
    try {
      const owner = await this.client.request('thread-owner-discovery', { hostId: 'local', conversationId: member.threadId });
      if (!owner.handledByClientId) throw Error('当前会话没有桌面持有端');
      route.ownerClientId = owner.handledByClientId;
      await new Promise((resolve, reject) => {
        const done = () => { if (!route.state) return; clearTimeout(timer); this.off('changed', done); resolve(); };
        const timer = setTimeout(() => { this.off('changed', done); reject(Error('未收到桌面会话状态')); }, 6000);
        this.on('changed', done); this.client.follow(member.threadId, route.ownerClientId);
      });
      route.error = null;
    } catch (error) { route.state = null; route.error = error.message; }
    finally { route.subscribing = false; this.#changed(); }
  }

  #retryConnection() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try { await this.connect(); } catch (error) { this.lastError = error.message; this.#changed(); }
      if (!this.closed && !this.client.clientId) this.#retryConnection();
    }, 2500);
    this.retryTimer.unref();
  }

  #broadcast(message) {
    if (this.closed || message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed' && message.version === 0 && message.params?.status === 'disconnected') {
      for (const route of this.routes.values()) if (route.ownerClientId === message.params.clientId) {
        route.ownerClientId = null; route.state = null; route.error = '会话持有端已断开';
      }
      this.#changed(); this.#retryConnection(); return;
    }
    const route = this.routes.get(message.params?.conversationId);
    if (!route || message.method !== 'thread-stream-state-changed' || message.version !== 11 ||
        message.sourceClientId !== route.ownerClientId || message.params?.hostId !== 'local') return;
    const change = message.params.change;
    try {
      if (change?.type === 'snapshot') {
        if (change.conversationState?.id !== route.member.threadId) throw Error('桌面会话 ID 不匹配');
        route.state = change.conversationState; route.revision = change.revision; route.awaitingSnapshot = false;
      } else if (change?.type === 'patches') {
        if (!route.state || change.baseRevision !== route.revision) throw Error('桌面事件版本有缺口');
        const next = applyDesktopPatches(route.state, change.patches);
        if (next.id !== route.member.threadId) throw Error('桌面会话 ID 不匹配');
        route.state = next; route.revision = change.revision;
      } else return;
      route.error = null; route.observedAt = now(); this.#observe(route); this.#changed();
    } catch (error) {
      route.error = error.message; route.state = null; this.#changed();
      if (!route.awaitingSnapshot && route.ownerClientId) {
        route.awaitingSnapshot = true; this.client.follow(route.member.threadId, route.ownerClientId);
      }
    }
  }

  #observe(route) {
    const member = route.member;
    const byThread = new Map(this.members.map((m) => [m.threadId, m]));
    for (const turn of uniqueTurns(route.state)) {
      if (turn.params?.threadId && turn.params.threadId !== member.threadId) continue;
      const turnId = turn.turnId || turn.id;
      const items = turn.items || [];
      const inboundEvents = [];
      for (const item of items) {
        const incoming = nativeInbound(item);
        const from = incoming && byThread.get(incoming.sourceThreadId);
        if (!from || from.threadId === member.threadId) continue;
        const receipt = this.receipts.find((r) => r.sourceThreadId === from.threadId &&
          r.recipientThreadId === member.threadId && r.bodyHash === bodyHash(incoming.text));
        const tasks = taskIdsIn(incoming.text);
        const kind = receipt?.kind || (from.threadId === this.managerThreadId ? 'dispatch' : member.role === 'general_manager' ? 'report' : 'message');
        const event = { id: 'inbound:' + member.threadId + ':' + item.id, channel: 'desktop-native', kind, stage: 'received',
          fromRole: from.role, toRole: member.role, sourceThreadId: from.threadId, recipientThreadId: member.threadId,
          inboundMessageId: item.id, turnId, ownerClientId: route.ownerClientId, revision: route.revision,
          taskId: receipt?.taskId || (tasks.length === 1 ? tasks[0] : null), linkedReceiptId: receipt?.id || null,
          bodyHash: bodyHash(incoming.text), text: incoming.text.slice(0, 600), at: at(turn) || route.observedAt || now(),
          evidence: receipt?.evidence || null, observedAt: route.observedAt || now() };
        this.#remember(event); inboundEvents.push(event);
      }
      const dispatch = inboundEvents.findLast((e) => e.kind === 'dispatch' && e.sourceThreadId === this.managerThreadId);
      const past = this.observed.get('activity:' + member.threadId + ':' + turnId);
      const reportTasks = new Set(items.flatMap((item) => {
        if (item.type !== 'mcpToolCall' || item.server !== 'codex_app' || item.tool !== 'send_message_to_thread' || item.status !== 'completed' ||
            item.arguments?.threadId !== this.managerThreadId || submittedTarget(item.result) !== this.managerThreadId) return [];
        const receipt = this.receipts.find((r) => r.kind === 'report' && r.sourceThreadId === member.threadId && r.bodyHash === bodyHash(item.arguments.prompt));
        return receipt?.taskId ? [receipt.taskId] : [];
      }));
      const receivedReportTasks = [...new Set(inboundEvents.filter((e) => e.kind === 'report').map((e) => e.taskId).filter(Boolean))];
      const continuation = this.#continuationTask(route, turn);
      const taskId = dispatch?.taskId || past?.taskId || continuation?.taskId || (reportTasks.size === 1 ? [...reportTasks][0] :
        member.role === 'general_manager' && receivedReportTasks.length === 1 ? receivedReportTasks[0] : null);
      const tools = items.filter((i) => TOOLS.has(i.type));
      const progress = taskId ? items.filter((i) => i.type === 'agentMessage' && i.phase === 'commentary').at(-1)?.text : null;
      const activity = { id: 'activity:' + member.threadId + ':' + turnId, channel: 'desktop-native', kind: 'execution',
        stage: turn.status === 'inProgress' ? 'executing' : 'turn_ended', taskId, turnId,
        fromRole: member.role, toRole: member.role, sourceThreadId: member.threadId, recipientThreadId: member.threadId,
        nativeTurnStatus: turn.status, toolCount: Math.max(tools.length, past?.toolCount || 0), lastTool: tools.at(-1)?.tool || tools.at(-1)?.type || past?.lastTool || null,
        attributionSource: dispatch ? 'direct_native_dispatch' : continuation ? 'explicit_user_continuation' : past?.attributionSource ||
          (reportTasks.size === 1 ? 'same_turn_verified_report' : member.role === 'general_manager' ? 'native_report_received' : null),
        linkedInboundMessageId: dispatch?.inboundMessageId || continuation?.inboundMessageId || past?.linkedInboundMessageId || null,
        text: progress?.slice(0, 260) || past?.text || '', at: at(turn) || past?.at || route.observedAt || now(),
        ownerClientId: route.ownerClientId, revision: route.revision, observedAt: route.observedAt || now() };
      this.#remember(activity);
      for (const item of items) {
        if (item.type !== 'mcpToolCall' || item.server !== 'codex_app' || item.tool !== 'send_message_to_thread' ||
            item.status !== 'completed' || item.arguments?.hostId !== 'local') continue;
        const target = byThread.get(item.arguments.threadId);
        if (!target || target === member || submittedTarget(item.result) !== target.threadId ||
            typeof item.arguments.prompt !== 'string') continue;
        const text = item.arguments.prompt.trim();
        const receipt = this.receipts.find((r) => r.sourceThreadId === member.threadId &&
          r.recipientThreadId === target.threadId && r.bodyHash === bodyHash(text));
        const tasks = taskIdsIn(text);
        this.#remember({ id: 'send:' + member.threadId + ':' + item.id, channel: 'desktop-native',
          kind: receipt?.kind || (member.role === 'general_manager' ? 'dispatch' : target.role === 'general_manager' ? 'report' : 'message'),
          stage: 'submitted', taskId: receipt?.taskId || (tasks.length === 1 ? tasks[0] : taskId),
          fromRole: member.role, toRole: target.role, sourceThreadId: member.threadId, recipientThreadId: target.threadId,
          turnId, toolCallId: item.id, ownerClientId: route.ownerClientId, revision: route.revision,
          linkedReceiptId: receipt?.id || null, bodyHash: bodyHash(text), text: text.slice(0, 600),
          at: receipt?.at || at(turn) || now(), evidence: receipt?.evidence || null, observedAt: route.observedAt || now() });
      }
    }
  }

  #continuationTask(route, turn) {
    const member = route.member, taskId = member.currentTaskId;
    if (!TASK_RE.test(taskId) || member.role === 'general_manager') return null;
    const inputs = turn.params?.input || (turn.items || []).filter((i) => i.type === 'userMessage').flatMap((i) => i.content || []);
    const text = inputs.filter((i) => i.type === 'text').map((i) => i.text || '').join('\n').trim();
    if (!/^(?:继续|继续执行|继续完成)(?:[。！!]?|\s*)$/.test(text)) return null;
    const dispatch = [...this.observed.values()].filter((e) => e.kind === 'dispatch' && e.stage === 'received' &&
      e.sourceThreadId === this.managerThreadId && e.recipientThreadId === member.threadId && e.taskId === taskId &&
      this.receipts.some((r) => r.id === e.linkedReceiptId && r.kind === 'dispatch' && r.taskId === taskId))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!dispatch || (turn.turnStartedAtMs && Date.parse(dispatch.at) > turn.turnStartedAtMs) ||
        this.decisions.some((d) => d.taskId === taskId && d.toRole === member.role && d.stage === 'accepted')) return null;
    try {
      const file = safeFile(path.join(this.company.root, '公司/任务'), path.join(taskId, '任务.md'), { json: false });
      const text = fs.readFileSync(file, 'utf8');
      if (/^状态：\s*(?:已完成|已验收|已结项|已关闭|已取消|已暂停|暂停|取消|结项|终止)/m.test(text)) return null;
      return dispatch;
    } catch { return null; }
  }

  #remember(event) {
    const old = this.observed.get(event.id);
    // Stream patches can change progress; the first observation timestamp stays stable.
    this.observed.set(event.id, { ...event, firstObservedAt: old?.firstObservedAt || event.observedAt });
    if (this.observed.size > 400) {
      const oldest = [...this.observed.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
      this.observed.delete(oldest.id);
    }
  }

  #changed() {
    if (this.closed) return;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try {
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          const tmp = this.file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, capturedAt: now(), events: [...this.observed.values()] }), { mode: 0o600 });
          fs.renameSync(tmp, this.file);
        } catch (error) { this.lastError = error.message; }
        this.emit('changed');
      }, 180);
      this.flushTimer.unref();
    }
  }

  #events() {
    const submitted = this.receipts.map((r) => ({ ...r, id: 'receipt:' + r.id, linkedReceiptId: r.id,
      channel: 'native-receipt', stage: 'submitted', submitted: true }));
    const members = new Set(this.members.map((m) => m.threadId));
    const observed = [...this.observed.values()].filter((e) => members.has(e.sourceThreadId) && members.has(e.recipientThreadId) && !(e.stage === 'submitted' && e.linkedReceiptId));
    return [...submitted, ...observed, ...this.decisions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  roleState(key) {
    const member = this.members.find((m) => m.role === key);
    if (!member) return null;
    const route = this.routes.get(member.threadId);
    const ready = Boolean(route?.state && route.ownerClientId && this.client.clientId);
    const turns = uniqueTurns(route?.state);
    const active = turns.findLast((t) => t.status === 'inProgress');
    const last = active || turns.at(-1);
    const event = last && this.observed.get('activity:' + member.threadId + ':' + (last.turnId || last.id));
    const busy = ready && (route.state.threadRuntimeStatus?.type === 'active' || Boolean(active));
    let liveState = !ready ? 'unknown' : busy ? 'working' : last?.status === 'failed' ? 'error' : last?.status === 'interrupted' ? 'paused' : 'idle';
    if (liveState === 'idle' && event?.taskId) {
      const decision = this.decisions.find((d) => d.taskId === event.taskId && d.toRole === key);
      const reportReceived = [...this.observed.values()].some((e) => e.kind === 'report' && e.stage === 'received' && e.taskId === event.taskId && e.fromRole === key);
      if (decision?.stage === 'accepted') liveState = 'accepted';
      else if (reportReceived || decision) liveState = 'delivered';
      else if (this.receipts.some((r) => r.kind === 'report' && r.taskId === event.taskId && r.fromRole === key)) liveState = 'report_submitted';
      else if (last?.status === 'completed') liveState = 'finished';
    }
    return { roleKey: key, threadId: member.threadId, ready, busy, liveState, taskId: event?.taskId || null,
      turnId: last?.turnId || last?.id || null, nativeTurnStatus: last?.status || null, toolCount: event?.toolCount || 0,
      progressText: event?.text || '', lastTool: event?.lastTool || null, ownerClientId: route?.ownerClientId || null,
      revision: ready ? route.revision : null, observedAt: route?.observedAt || null, error: route?.error || null };
  }

  #flows(events) {
    const grouped = new Map();
    for (const e of events) {
      if (!e.taskId || !TASK_RE.test(e.taskId)) continue;
      const roleKey = e.kind === 'dispatch' ? e.toRole : e.kind === 'report' ? e.fromRole : e.kind === 'handling' ? e.toRole : e.fromRole;
      if (!roleKey || roleKey === 'general_manager') continue;
      const key = e.taskId + ':' + roleKey;
      if (!grouped.has(key)) grouped.set(key, { id: key, taskId: e.taskId, roleKey, events: [] });
      grouped.get(key).events.push(e);
    }
    return [...grouped.values()].map((flow) => {
      const e = flow.events, activity = e.filter((x) => x.kind === 'execution').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      const decision = e.find((x) => x.kind === 'handling');
      const role = this.roleState(flow.roleKey);
      const dispatched = e.some((x) => x.kind === 'dispatch' && ['submitted', 'received'].includes(x.stage));
      const received = e.some((x) => x.kind === 'dispatch' && x.stage === 'received');
      const executed = Boolean(activity?.toolCount > 0);
      const reportSubmitted = e.some((x) => x.kind === 'report' && ['submitted', 'received'].includes(x.stage));
      const reportReceived = e.some((x) => x.kind === 'report' && x.stage === 'received') || Boolean(decision);
      const isLive = Boolean(role?.busy && role.taskId === flow.taskId);
      const manager = this.roleState('general_manager');
      const managerProcessing = Boolean(reportReceived && manager?.busy && manager.taskId === flow.taskId);
      const phase = decision?.stage || (managerProcessing ? 'manager_processing' : reportReceived ? 'reported' : reportSubmitted ? 'report_submitted' :
        isLive ? 'executing' : activity?.nativeTurnStatus === 'interrupted' ? 'paused' : activity?.nativeTurnStatus === 'failed' ? 'error' :
          activity ? 'turn_ended' : received ? 'received' : 'submitted');
      return { ...flow, phase, isLive, managerProcessing, at: e[0]?.at, progressText: activity?.text || '', toolCount: activity?.toolCount || 0,
        stages: { dispatched, received, executed, reportSubmitted, reportReceived, handled: Boolean(decision), accepted: decision?.stage === 'accepted' },
        decision: decision || null, events: e.slice(0, 12) };
    }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  snapshot({ taskId, roleKey, limit = 30 } = {}) {
    const allEvents = this.#events();
    const roles = this.members.map((m) => this.roleState(m.role));
    const flows = this.#flows(allEvents);
    const selected = (e) => (!taskId || e.taskId === taskId) && (!roleKey || e.fromRole === roleKey || e.toRole === roleKey);
    return { channel: 'desktop-native-readonly', ready: roles.some((r) => r.ready), lastError: this.lastError,
      managerThreadId: this.managerThreadId, roles, counts: { connected: roles.filter((r) => r.ready).length,
        total: roles.length, active: roles.filter((r) => r.busy).length, awaitingHandling: flows.filter((f) => f.stages.reportReceived && !f.stages.handled).length,
        handled: flows.filter((f) => f.stages.handled).length, accepted: flows.filter((f) => f.stages.accepted).length },
      flows: flows.filter((f) => (!taskId || f.taskId === taskId) && (!roleKey || f.roleKey === roleKey)).slice(0, limit),
      events: allEvents.filter(selected).slice(0, limit * 2), eventWindow: 400, taskCount: flows.length,
      executionProvenBySubmission: false, turnsStarted: 0, messagesSent: 0 };
  }

  async readStatus(options = {}) {
    if ((options.taskId && !TASK_RE.test(options.taskId)) || (options.roleKey && !this.members.some((m) => m.role === options.roleKey))) throw new DesktopIpcError('协作筛选无效', { status: 400 });
    this.refreshEvidence(false);
    try { await this.connect(); } catch (error) { this.lastError = error.message; }
    return this.snapshot(options);
  }

  handoffs() {
    return this.snapshot({ limit: 80 }).flows.flatMap((flow) => {
      const pairs = new Map();
      for (const event of flow.events) {
        if (!['dispatch', 'report', 'handling'].includes(event.kind)) continue;
        const key = event.kind + ':' + event.fromRole + ':' + event.toRole + ':' + (event.linkedReceiptId || event.bodyHash || event.id);
        if (!pairs.has(key) || pairs.get(key).stage === 'submitted') pairs.set(key, event);
      }
      return [...pairs.values()].map((e) => ({ ...e, id: 'native:' + e.id, channel: 'native', taskId: flow.taskId,
        submitted: true, live: e.kind === 'dispatch' && flow.isLive, status: e.kind === 'dispatch' ? flow.phase : e.stage,
        recipientReceivedVerified: e.stage === 'received' || e.kind === 'handling',
        recipientExecutionVerified: e.kind === 'dispatch' ? flow.stages.executed : e.kind === 'handling',
        fromName: this.members.find((m) => m.role === e.fromRole)?.name,
        toName: this.members.find((m) => m.role === e.toRole)?.name }));
    });
  }

  close() {
    this.closed = true; clearTimeout(this.flushTimer); clearTimeout(this.evidenceTimer); clearTimeout(this.retryTimer);
    for (const watcher of this.watchers) watcher.close();
    for (const [threadId, route] of this.routes) if (route.ownerClientId && this.client.clientId) {
      try { this.client.follow(threadId, route.ownerClientId, false); } catch { /* own follower already disconnected */ }
    }
    this.client.close();
  }
}
