import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_TYPES, addUsage, finalAnswer, normalizeItem } from './items.mjs';
import { appearanceFor, DEPARTMENTS, EMBLEMS, PALETTES, roleIdentity } from './company.mjs';
import { MigrationCoordinator } from './migration.mjs';
import { nativeBridgeReady } from './native-route.mjs';
import { Collaboration, fingerprint } from './collaboration.mjs';

const ACTIVE = new Set(['starting', 'running', 'waiting_approval']);
const APPROVAL_METHODS = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'userInput',
  'mcpServer/elicitation/request': 'elicitation',
  execCommandApproval: 'legacyCommand',
  applyPatchApproval: 'legacyPatch',
};
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const CONTINUE_PROMPT = '继续完成上一轮被暂停或中断的工作。先检查当前目录的实际状态，再从中断处继续；完成后用一两句话说明实际完成的文件、命令和仍未完成的事项。';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const FORMAL_DISPATCH = Symbol('verified-native-dispatch');

export class WorkbenchError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function realDir(dir) {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Orchestrates roles, sessions, runs, approvals and handoffs on top of the Codex runtime adapter.
 */
export class Workbench extends EventEmitter {
  constructor({ store, runtime, company, paths, maxConcurrent = 3, defaults = {}, nativeBridge }) {
    super();
    this.store = store;
    this.runtime = runtime;
    this.company = company;
    this.paths = paths;
    this.maxConcurrent = Math.max(1, Math.min(3, Number(maxConcurrent) || 3));
    this.defaults = { model: null, effort: 'low', sandbox: 'workspace-write', approvalPolicy: 'on-request', ...defaults };
    this.live = new Map(); // runId -> { messages: Map(itemId -> text), outputs: Map(itemId -> text), inflight: Map }
    this.turnUsage = new Map(); // turnId -> { seen: Set(totalTokens), sum }
    this.pumping = false;
    this.runtimeSuspended = false;
    this.dispatchReservations = new Set();
    this.pendingConsoleRequests = new Map();
    this.creatingSessions = new Set();
    this.migrations = new MigrationCoordinator({ store, runtime, company, paths, nativeBridge, emit: (type, payload) => this.#emit(type, payload), resolveCwd: (cwd) => this.resolveCwd(cwd), attachRuntime: (roleRuntime, planId, threadId) => this.#attachRoleRuntime(roleRuntime, planId, threadId) });
    this.migrations.recover();
    runtime.on('notification', (message) => this.#safe(() => this.#onNotification(message)));
    runtime.on('serverRequest', (message) => this.#safe(() => this.#onServerRequest(message)));
    runtime.on('exit', (exit) => this.#safe(() => this.#onRuntimeExit(exit)));
    runtime.on('status', (snapshot) => {
      this.emit('event', { type: 'runtime', runtime: snapshot });
      if (snapshot.status === 'ready' && !this.runtimeSuspended) this.#safe(() => this.collaboration?.flushInboxes());
    });
    this.#recoverAfterRestart();
    this.collaboration = new Collaboration({ store, paths, getRole: (key) => this.getRole(key), getSession: (key) => this.getSession(key), enqueue: (body) => this.#enqueueInternal(body), changed: () => { this.#emit('collaboration.updated', {}); this.#pump(); this.collaboration.interruptPending().catch((error) => this.#emit('workbench.error', { message: error.message })); }, interrupt: (runId, mode, internal) => this.interrupt(runId, mode, internal) });
  }

  get state() {
    return this.store.state;
  }

  #attachRoleRuntime(roleRuntime, planId, threadId) {
    roleRuntime.on('notification', (message) => this.#safe(() => {
      if ((message.params?.threadId || message.params?.thread?.id) === threadId) this.#onNotification(message);
    }));
    roleRuntime.on('serverRequest', (message) => this.#safe(() => this.#onServerRequest(message, roleRuntime)));
    roleRuntime.on('exit', (exit) => this.#safe(() => { this.#onRuntimeExit(exit, threadId); this.migrations.noteRuntimeExit(planId, exit); }));
  }
  #runtimeForSession(session) { return session?.source === 'native-migrated' ? this.migrations.runtimeFor(session) : this.runtime; }
  async stopRuntime() { this.runtimeSuspended = true; await this.migrations.stopAll(); await this.runtime.stop(); return this.runtime.snapshot(); }
  async startRuntime() { this.runtimeSuspended = false; await this.runtime.ensureStarted(); this.collaboration.flushInboxes(); this.#pump(); return this.runtime.snapshot(); }
  async restartRuntime() { await this.stopRuntime(); return this.startRuntime(); }

  #safe(fn) {
    try {
      fn();
    } catch (error) {
      this.emit('event', { type: 'workbench.error', message: error.message });
    }
  }

  #emit(type, payload) {
    this.emit('event', { type, at: now(), ...payload });
  }

  #recoverAfterRestart() {
    let changed = false;
    for (const run of Object.values(this.state.runs)) {
      if (ACTIVE.has(run.status)) {
        Object.assign(run, { status: 'interrupted', stopMode: 'console_restart', completedAt: now(), error: run.error || { message: '工作台重启时该运行仍在进行，已标记为中断，可在同一会话继续。' } });
        changed = true;
      }
    }
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.status === 'pending') {
        approval.status = 'expired';
        changed = true;
      }
    }
    for (const session of Object.values(this.state.sessions)) {
      if (session.activeRunId) {
        session.activeRunId = null;
        session.status = 'paused';
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  // ---------- roles ----------

  listRoles() {
    const company = this.company.roles();
    const local = Object.values(this.state.roles);
    return [...company, ...local].map((role) => this.#decorateRole(role));
  }

  getRole(key) {
    const role = this.listRoles().find((r) => r.key === key);
    if (!role) throw new WorkbenchError(404, `岗位不存在：${key}`);
    return role;
  }

  #decorateRole(role) {
    const nativeActivity = role.source === 'company' ? this.nativeCollaboration?.roleState(role.key) : null;
    const config = this.state.roleConfigs[role.key] || {};
    const sessions = Object.values(this.state.sessions).filter((s) => s.roleKey === role.key && !s.archived && !s.detached);
    const runs = Object.values(this.state.runs).filter((r) => r.roleKey === role.key);
    const active = runs.filter((r) => ACTIVE.has(r.status));
    const lastRun = runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    let liveState = 'idle';
    if (active.some((r) => r.status === 'waiting_approval')) liveState = 'waiting_approval';
    else if (active.length) liveState = 'working';
    else if (runs.some((r) => r.status === 'queued')) liveState = 'queued';
    else if (lastRun?.status === 'failed') liveState = 'error';
    else if (lastRun?.status === 'interrupted') liveState = 'paused';
    else if (lastRun?.status === 'completed') liveState = 'delivered';
    const current = active[0] || lastRun;
    const identity = role.source === 'local' ? { roleTitle: role.roleTitle || String(role.title).split('｜')[0], project: null, dept: 'workbench' } : {};
    return {
      ...role,
      ...identity,
      deptLabel: DEPARTMENTS[identity.dept || role.dept] || DEPARTMENTS.workbench,
      appearance: appearanceFor(role.key, { palette: config.palette || role.palette, emblem: config.emblem || role.emblem }),
      skills: config.skills || [],
      defaults: { ...this.defaults, cwd: this.paths.defaultWorkspace, ...(config.defaults || {}), ...(this.collaboration?.workspace(role) ? { cwd: this.collaboration.workspace(role) } : {}) },
      tools: role.collaboration ? this.collaboration.tools(role).map((t) => t.name) : [],
      stableSessionId: role.collaboration ? this.collaboration.sessionFor(role.key)?.id || null : null,
      sessionCount: sessions.length,
      activeRunIds: active.map((r) => r.id),
      lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, createdAt: lastRun.createdAt, completedAt: lastRun.completedAt } : null,
      currentRun: current ? { id: current.id, status: current.status, prompt: current.prompt.slice(0, 120), at: current.completedAt || current.startedAt || current.createdAt } : null,
      liveState: nativeActivity?.liveState || liveState,
      nativeActivity: nativeActivity || null,
      currentNativeTask: nativeActivity?.taskId ? { id: nativeActivity.taskId, status: nativeActivity.liveState, turnId: nativeActivity.turnId, progressText: nativeActivity.progressText } : null,
      migration: this.migrations.snapshot().plans.find((p) => p.roleKey === role.key && p.state !== 'rolled_back') || null,
    };
  }

  saveLocalRole(body) {
    const name = String(body.name || '').trim();
    const title = String(body.title || '').trim();
    if (!name || !title) throw new WorkbenchError(400, '请填写岗位名称和成员姓名');
    if (name.length > 24 || title.length > 40) throw new WorkbenchError(400, '名称过长');
    const companyKeys = new Set(this.company.roles().map((r) => r.key));
    const key = body.key || `local_${crypto.randomUUID().slice(0, 8)}`;
    if (companyKeys.has(key)) throw new WorkbenchError(400, '公司固定岗位的档案由经理维护，这里只能配置 Skill 与默认运行参数');
    if (!/^local_[a-zA-Z0-9_]{1,64}$/.test(key)) throw new WorkbenchError(400, '工作台岗位 key 格式无效');
    const appearance = appearanceFor(key, { palette: body.palette, emblem: body.emblem });
    const role = {
      key,
      name,
      title: `${title}｜${name}`,
      roleTitle: title,
      ...roleIdentity(key, `${title}｜${name}`, name),
      description: String(body.description || '').slice(0, 400),
      instructions: String(body.instructions || '').slice(0, 4000),
      source: 'local',
      nativeThreadId: null,
      palette: appearance.palette,
      emblem: appearance.emblem,
      createdAt: this.state.roles[key]?.createdAt || now(),
      updatedAt: now(),
    };
    this.collaboration.configureRole(role, body.collaboration);
    this.state.roles[key] = role;
    this.store.save();
    this.#emit('roles.updated', {});
    return this.getRole(key);
  }

  async configureRole(key, body) {
    this.getRole(key);
    const config = { ...(this.state.roleConfigs[key] || {}) };
    if (body.skills) config.skills = await this.#validateSkillRefs(body.skills, body.defaults?.cwd || config.defaults?.cwd || this.paths.defaultWorkspace);
    if (body.defaults) config.defaults = this.#cleanDefaults({ ...(config.defaults || {}), ...body.defaults });
    if (body.palette && PALETTES[body.palette]) config.palette = body.palette;
    if (body.emblem && EMBLEMS.includes(body.emblem)) config.emblem = body.emblem;
    this.state.roleConfigs[key] = config;
    this.store.save();
    this.#emit('roles.updated', {});
    return this.getRole(key);
  }

  #cleanDefaults(input) {
    const out = {};
    if (input.model) out.model = String(input.model);
    if (EFFORTS.has(input.effort)) out.effort = input.effort;
    if (SANDBOXES.has(input.sandbox)) out.sandbox = input.sandbox;
    if (APPROVAL_POLICIES.has(input.approvalPolicy)) out.approvalPolicy = input.approvalPolicy;
    if (input.cwd) out.cwd = this.resolveCwd(input.cwd);
    return out;
  }

  // ---------- workspaces & skills ----------

  resolveCwd(cwd) {
    const real = realDir(cwd);
    if (!real) throw new WorkbenchError(400, `工作目录不存在：${cwd}`);
    const ok = this.paths.allowedRoots.some((root) => {
      const r = realDir(root);
      return r && (real === r || real.startsWith(`${r}${path.sep}`));
    });
    if (!ok) throw new WorkbenchError(400, '工作目录不在允许范围内（测试工作区或公司工作区）');
    return real;
  }

  async listSkills(cwd = this.paths.defaultWorkspace, forceReload = false) {
    const dir = this.resolveCwd(cwd);
    const result = await this.runtime.listSkills([dir], forceReload);
    const entry = (result.data || []).find((e) => e.cwd === dir) || result.data?.[0] || { skills: [], errors: [] };
    return {
      cwd: dir,
      skills: (entry.skills || []).map((s) => ({ name: s.name, description: s.shortDescription || s.description, path: s.path, scope: s.scope, enabled: s.enabled, pluginId: s.pluginId ?? null })),
      errors: entry.errors || [],
    };
  }

  async #validateSkillRefs(refs, cwd) {
    if (!Array.isArray(refs)) throw new WorkbenchError(400, 'skills 必须是数组');
    if (!refs.length) return [];
    const { skills } = await this.listSkills(cwd, true);
    return refs.map((ref) => {
      const name = typeof ref === 'string' ? ref : ref.name;
      const found = skills.find((s) => (ref.path ? s.path === ref.path : s.name === name));
      if (!found) throw new WorkbenchError(400, `Codex 在该工作目录未发现 Skill：${name}`);
      if (!found.enabled) throw new WorkbenchError(400, `Skill 已被禁用：${name}`);
      return { name: found.name, path: found.path };
    });
  }

  async #resolveRunSkills(refs, cwd) {
    const unique = new Map();
    for (const ref of refs) unique.set(ref.path || ref.name, ref);
    if (!unique.size) return [];
    const { skills } = await this.listSkills(cwd, true);
    return [...unique.values()].map((ref) => {
      const found = skills.find((s) => (ref.path ? s.path === ref.path : s.name === ref.name));
      if (!found || !found.enabled) throw new WorkbenchError(400, `派单所需 Skill 未被 Codex 发现或已禁用：${ref.name}`);
      return { name: found.name, path: found.path, scope: found.scope, sha256: sha256File(found.path), listedByCodex: true };
    });
  }

  // ---------- sessions ----------

  listSessions() {
    return Object.values(this.state.sessions).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getSession(sessionId) {
    const session = this.state.sessions[sessionId];
    if (!session) throw new WorkbenchError(404, '会话不存在');
    return session;
  }

  #sessionByThread(threadId) {
    const matches = Object.values(this.state.sessions).filter((s) => s.threadId === threadId);
    return matches.find((s) => s.activeRunId) || matches.find((s) => !s.archived) || matches[0] || null;
  }

  #developerInstructions(role) {
    if (role.source === 'local') {
      return [`你是野望科技工作台的「${role.title}」运行会话。`, role.description && `岗位说明：${role.description}`, role.instructions, '只在当前工作目录内完成派单；未实际执行的动作不要声称已完成，最后用一两句话说明实际改动的文件、执行的命令和未完成事项。']
        .filter(Boolean)
        .join('\n');
    }
    return [
      `你是野望科技工作台为「${role.title}」创建的岗位运行会话。`,
      role.description && `岗位参考：${role.description}`,
      '本会话由工作台直接派单，不是通讯录登记的固定岗位聊天，不代表该岗位身份，也不调度其他岗位或子agent。',
      '按派单在当前工作目录完成工作；未实际执行的动作不要声称已完成，最后用一两句话说明实际改动的文件、执行的命令和未完成事项。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async createSession(body) {
    const role = this.getRole(body.roleKey);
    if (role.collaboration && this.creatingSessions.has(role.key)) throw new WorkbenchError(409, '该岗位正在建立稳定会话');
    if (role.collaboration) this.creatingSessions.add(role.key);
    try { return await this.#createSessionOnce(body); }
    finally { this.creatingSessions.delete(role.key); }
  }

  async #createSessionOnce(body) {
    const role = this.getRole(body.roleKey);
    const defaults = role.defaults;
    const cwd = this.resolveCwd(body.cwd || defaults.cwd);
    const settings = this.#cleanDefaults({ ...defaults, ...body, cwd });
    this.collaboration.validateSession(role, cwd, settings);
    const title = String(body.title || `${role.name} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`).slice(0, 80);
    const params = {
      cwd,
      sandbox: settings.sandbox || this.defaults.sandbox,
      approvalPolicy: settings.approvalPolicy || this.defaults.approvalPolicy,
      developerInstructions: [this.#developerInstructions(role), this.collaboration.instructions(role)].filter(Boolean).join('\n'),
      serviceName: 'yewang_workbench',
    };
    if (this.runtime.contextMode === 'lean') {
      // Preserve the default Codex instructions and permission contract; only the
      // workbench's repeated role prose is condensed.
      params.developerInstructions = [`工作台岗位：${role.roleTitle}｜${role.name}（${role.key}）。`, role.description, role.instructions, this.collaboration.instructions(role)].filter(Boolean).join('\n');
    }
    if (role.collaboration) params.dynamicTools = this.collaboration.tools(role);
    if (settings.model) params.model = settings.model;
    const started = await this.runtime.startThread(params);
    const session = {
      id: id('ses'),
      roleKey: role.key,
      title,
      threadId: started.thread.id,
      source: 'workbench-created',
      collaboration: role.collaboration || null,
      toolNames: (params.dynamicTools || []).map((t) => t.name),
      wakePaused: false,
      contextMode: this.runtime.contextMode || 'inherited',
      cwd: started.cwd || cwd,
      model: started.model,
      modelProvider: started.modelProvider,
      effort: settings.effort || this.defaults.effort,
      sandbox: params.sandbox,
      approvalPolicy: params.approvalPolicy,
      instructionSources: started.instructionSources || [],
      status: 'idle',
      threadStatus: started.thread.status || null,
      activeRunId: null,
      lastRunId: null,
      usageTotal: null,
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.sessions[session.id] = session;
    this.store.save();
    await this.runtime.setThreadName(session.threadId, title).catch(() => {});
    this.#emit('session.updated', { session });
    return session;
  }

  async renameSession(sessionId, title) {
    const session = this.getSession(sessionId);
    if (session.source === 'native-migrated') throw new WorkbenchError(409, '原生岗位聊天名称由经理维护');
    session.title = String(title || '').trim().slice(0, 80) || session.title;
    session.updatedAt = now();
    this.store.save();
    await this.runtime.setThreadName(session.threadId, session.title).catch(() => {});
    this.#emit('session.updated', { session });
    return session;
  }

  async archiveSession(sessionId) {
    const session = this.getSession(sessionId);
    if (session.source === 'native-migrated') throw new WorkbenchError(409, '正式岗位会话请用“撤回接管”，不归档原生聊天');
    if (session.activeRunId) throw new WorkbenchError(409, '会话正在运行，请先暂停或停止');
    if (session.collaboration && this.collaboration.snapshot(session.collaboration.namespace).tasks.some((t) => !['accepted', 'cancelled'].includes(t.status))) throw new WorkbenchError(409, '测试组仍有未结束任务，先处理或取消任务');
    await this.runtime.archiveThread(session.threadId);
    session.archived = true;
    session.status = 'archived';
    session.updatedAt = now();
    this.store.save();
    this.#emit('session.updated', { session });
    return session;
  }

  // ---------- runs ----------

  listRuns({ roleKey, sessionId, limit = 200 } = {}) {
    return Object.values(this.state.runs)
      .filter((r) => (!roleKey || r.roleKey === roleKey) && (!sessionId || r.sessionId === sessionId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map((r) => this.#runSummary(r));
  }

  #runSummary(run) {
    const { items, ...rest } = run;
    return { ...rest, itemCount: items?.length || 0 };
  }

  getRun(runId) {
    const run = this.state.runs[runId];
    if (!run) throw new WorkbenchError(404, '运行不存在');
    const live = this.live.get(runId);
    return {
      ...run,
      live: live ? { messages: Object.fromEntries(live.messages), outputs: Object.fromEntries(live.outputs), inflight: [...live.inflight.values()] } : null,
      approvals: Object.values(this.state.approvals).filter((a) => a.runId === runId),
      nativeReport: run.nativeReportId ? (({ status, submissionVerified, recipientExecutionVerified, sourceThreadId, recipientThreadId, error }) => ({ status, submissionVerified, recipientExecutionVerified, sourceThreadId, recipientThreadId, error }))(this.state.nativeReports[run.nativeReportId]) : null,
    };
  }

  async dispatch(body, authority) {
    const requestId = body.requestId;
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.length || requestId.length > 120)) throw new WorkbenchError(400, '操作编号无效');
    const hash = fingerprint(body);
    if (requestId && this.state.consoleRequests[requestId]) {
      const previous = this.state.consoleRequests[requestId];
      if (previous.hash !== hash) throw new WorkbenchError(409, '重复操作编号的派单内容不同，请查询旧操作');
      return this.#runSummary(this.state.runs[previous.runId]);
    }
    if (requestId && this.pendingConsoleRequests.has(requestId)) {
      const pending = this.pendingConsoleRequests.get(requestId);
      if (pending.hash !== hash) throw new WorkbenchError(409, '重复操作编号的派单内容不同');
      return pending.promise;
    }
    const operation = this.#dispatchOnce(body, authority, hash);
    if (requestId) this.pendingConsoleRequests.set(requestId, { hash, promise: operation });
    try { return await operation; } finally { if (requestId) this.pendingConsoleRequests.delete(requestId); }
  }

  async #dispatchOnce(body, authority, hash) {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new WorkbenchError(400, '派单内容不能为空');
    if (prompt.length > 20000) throw new WorkbenchError(400, '派单内容过长');
    let session;
    let extraSkills;
    const reservation = body.sessionId || (body.roleKey && this.getRole(body.roleKey).collaboration ? `role:${body.roleKey}` : null);
    if (reservation && this.dispatchReservations.has(reservation)) throw new WorkbenchError(409, '该会话正在提交派单，请查询原提交');
    if (reservation) this.dispatchReservations.add(reservation);
    try {
    if (body.sessionId) {
      session = this.getSession(body.sessionId);
      if (session.detached) throw new WorkbenchError(409, '接管已撤回或运行端已释放，需要重新核验后接管');
      if (session.source === 'native-migrated') {
        if (authority !== FORMAL_DISPATCH) throw new WorkbenchError(403, '正式岗位任务必须由原生经理入站核验后执行；控制台正文不授予派单身份');
        this.migrations.assertActive(session);
      }
      if (session.archived) throw new WorkbenchError(409, '会话已归档');
      if (body.roleKey && body.roleKey !== session.roleKey) throw new WorkbenchError(400, '会话不属于该岗位');
      const busy = Object.values(this.state.runs).find((r) => r.sessionId === session.id && (ACTIVE.has(r.status) || r.status === 'queued'));
      if (busy) throw new WorkbenchError(409, '该会话已有运行在进行或排队；可追加指令或等待结束', { runId: busy.id });
      if (session.collaboration?.authority === 'employee') throw new WorkbenchError(403, '协作员工只接收本组总经理的内部派单，请将任务交给测试总经理');
      extraSkills = await this.#validateSkillRefs(body.skills || [], session.cwd);
    } else {
      const role = this.getRole(body.roleKey);
      if (role.collaboration?.authority === 'employee') throw new WorkbenchError(403, '请通过本组测试总经理派单给员工');
      const cwd = this.resolveCwd(body.session?.cwd || role.defaults.cwd);
      extraSkills = await this.#validateSkillRefs(body.skills || [], cwd);
      session = role.collaboration && this.collaboration.sessionFor(role.key) || await this.createSession({ ...(body.session || {}), cwd, roleKey: body.roleKey });
      if (Object.values(this.state.runs).some((r) => r.sessionId === session.id && (ACTIVE.has(r.status) || r.status === 'queued'))) throw new WorkbenchError(409, '该岗位稳定会话正在运行或排队');
    }
    const role = this.getRole(session.roleKey);
    if (session.collaboration?.authority === 'manager') session.wakePaused = false;
    const run = this.#makeRun(session, role, body, extraSkills, authority);
    if (body.requestId) this.state.consoleRequests[body.requestId] = { hash, runId: run.id, committedAt: now() };
    this.store.save();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    this.#pump();
    return this.#runSummary(run);
    } finally { if (reservation) this.dispatchReservations.delete(reservation); }
  }

  #makeRun(session, role, body, extraSkills = [], authority) {
    const useRoleSkills = body.useRoleSkills !== false;
    const run = {
      id: id('run'),
      kind: body.kind || 'dispatch',
      sessionId: session.id,
      roleKey: session.roleKey,
      roleName: role.name,
      threadId: session.threadId,
      turnId: null,
      prompt: String(body.prompt || '').trim(),
      requestedSkills: [...(useRoleSkills ? role.skills : []), ...extraSkills],
      skills: [],
      dispatcher: authority === FORMAL_DISPATCH ? { kind: 'native', label: '总经理', sourceThreadId: body.nativeOrigin.sourceThreadId, inboundMessageId: body.nativeOrigin.inboundMessageId } : { kind: 'console', label: String(body.dispatcherLabel || '控制台').slice(0, 20) },
      nativeOrigin: authority === FORMAL_DISPATCH ? body.nativeOrigin : null,
      effort: EFFORTS.has(body.effort) ? body.effort : session.effort,
      model: body.model || null,
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      items: [],
      counts: { messages: 0, commands: 0, fileChanges: 0, toolCalls: 0 },
      finalText: '',
      usage: null,
      usageBaseline: null,
      threadUsageTotal: null,
      errors: [],
      error: null,
      steers: [],
      stopRequested: null,
      stopMode: null,
      resumedThread: false,
      skillEvidence: null,
      claimCheck: null,
      returnedAt: null,
    };
    this.state.runs[run.id] = run;
    session.lastRunId = run.id;
    session.updatedAt = now();
    return run;
  }

  #enqueueInternal(body) {
    const session = this.getSession(body.sessionId);
    if (!session.collaboration || session.archived) throw new WorkbenchError(403, '内部投递只能使用稳定协作会话');
    const run = this.#makeRun(session, this.getRole(session.roleKey), body);
    Object.assign(run, { dispatcher: body.dispatcher, teamTaskId: body.teamTaskId || null, teamGeneration: body.teamGeneration || null, managerMessageIds: body.managerMessageIds || null });
    return run;
  }

  continueSession(sessionId, body = {}) {
    return this.dispatch({ ...body, sessionId, kind: 'continue', prompt: body.prompt || CONTINUE_PROMPT, useRoleSkills: body.useRoleSkills });
  }

  dispatchNative(planId, body) {
    return this.migrations.dispatch(planId, body, (verified) => this.dispatch(verified, FORMAL_DISPATCH));
  }

  activeCount() {
    return Object.values(this.state.runs).filter((r) => ACTIVE.has(r.status)).length;
  }

  #pump() {
    if (this.pumping || this.runtimeSuspended) return;
    this.pumping = true;
    try {
      const queued = Object.values(this.state.runs)
        .filter((r) => r.status === 'queued')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const run of queued) {
        if (this.activeCount() >= this.maxConcurrent) break;
        const session = this.state.sessions[run.sessionId];
        if (session.activeRunId) continue;
        const conflicting = Object.values(this.state.runs).some((other) => {
          if (!ACTIVE.has(other.status)) return false;
          const cwd = this.state.sessions[other.sessionId]?.cwd;
          return cwd && (cwd === session.cwd || cwd.startsWith(`${session.cwd}${path.sep}`) || session.cwd.startsWith(`${cwd}${path.sep}`));
        });
        if (conflicting) continue;
        session.activeRunId = run.id;
        run.status = 'starting';
        this.store.save();
        this.#startRun(run, session).catch((error) => this.#failRun(run, error));
      }
    } finally {
      this.pumping = false;
    }
  }

  async #startRun(run, session) {
    this.live.set(run.id, { messages: new Map(), outputs: new Map(), inflight: new Map() });
    session.status = 'running';
    this.#emit('run.updated', { run: this.#runSummary(run) });
    const runtime = this.#runtimeForSession(session);
    await runtime.ensureStarted();
    if (!ACTIVE.has(run.status) || run.stopRequested) {
      run.status = 'interrupted'; run.stopMode = run.stopRequested || 'pause';
      this.#finishRun(run, session, { status: 'interrupted', items: [] });
      return;
    }
    if (session.source === 'native-migrated') this.migrations.assertActive(session);
    if (!runtime.isLoaded(session.threadId)) {
      const params = session.source === 'native-migrated' ? {} : { cwd: session.cwd, sandbox: session.sandbox, approvalPolicy: session.approvalPolicy };
      const resumed = await runtime.resumeThread(session.threadId, params);
      run.resumedThread = true;
      session.threadStatus = resumed.thread?.status || null;
    }
    run.skills = await this.#resolveRunSkills(run.requestedSkills, session.cwd);
    if (run.stopRequested || !ACTIVE.has(run.status)) {
      if (ACTIVE.has(run.status)) this.#finishRun(run, session, { status: 'interrupted', items: [] });
      return;
    }
    run.usageBaseline = session.usageTotal || null;
    const input = [{ type: 'text', text: run.prompt }, ...run.skills.map((s) => ({ type: 'skill', name: s.name, path: s.path }))];
    const params = { threadId: session.threadId, input, clientUserMessageId: run.id };
    if (EFFORTS.has(run.effort)) params.effort = run.effort;
    if (run.model) params.model = run.model;
    const result = await runtime.startTurn(params);
    run.turnId = result.turn.id;
    if (run.status === 'starting') run.status = 'running';
    run.startedAt ||= now();
    this.collaboration.runStarted(run);
    this.store.saveSoon();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    if (run.stopRequested) await runtime.interruptTurn(session.threadId, run.turnId).catch(() => {});
  }

  #failRun(run, error) {
    if (!ACTIVE.has(run.status)) return;
    const session = this.state.sessions[run.sessionId];
    run.status = 'failed';
    run.error = { message: error.message, code: error.code ?? null, data: error.data ?? null };
    run.completedAt = now();
    if (run.nativeOrigin) {
      run.finalText = error.message; run.returnedAt = now();
      this.#queueNativeReport(run);
    }
    if (session && session.activeRunId === run.id) {
      session.activeRunId = null;
      session.status = 'error';
      session.updatedAt = now();
    }
    this.live.delete(run.id);
    this.collaboration.runFinished(run);
    this.store.save();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    if (!this.runtimeSuspended) this.collaboration.flushInboxes();
    this.#pump();
  }

  async interrupt(runId, mode = 'pause', internal = false) {
    const run = this.state.runs[runId];
    if (!run) throw new WorkbenchError(404, '运行不存在');
    if (!ACTIVE.has(run.status) && run.status !== 'queued') throw new WorkbenchError(409, '该运行已经结束');
    const stopMode = mode === 'stop' ? 'stop' : 'pause';
    if (!internal) this.collaboration.runStopped(run, stopMode);
    if (run.status === 'queued') {
      run.status = 'cancelled';
      run.stopMode = stopMode;
      run.completedAt = now();
      if (run.nativeOrigin) { run.returnedAt = now(); this.#queueNativeReport(run); }
      this.store.save();
      this.#emit('run.updated', { run: this.#runSummary(run) });
      this.#pump();
      return this.#runSummary(run);
    }
    if (!ACTIVE.has(run.status)) throw new WorkbenchError(409, '该运行已经结束');
    run.stopRequested = stopMode;
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.runId === run.id && approval.status === 'pending') this.#answerApproval(approval, 'cancel');
    }
    if (run.turnId) await this.#runtimeForSession(this.state.sessions[run.sessionId]).interruptTurn(run.threadId, run.turnId);
    this.store.saveSoon();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    return this.#runSummary(run);
  }

  async steer(runId, text) {
    const run = this.state.runs[runId];
    if (!run) throw new WorkbenchError(404, '运行不存在');
    if (run.nativeOrigin) throw new WorkbenchError(403, '正式岗位的追加或续办指令须先核验新的原生经理入站');
    if (run.teamTaskId) throw new WorkbenchError(403, '协作任务追加请交给本组总经理，保持任务授权一致');
    const clean = String(text || '').trim();
    if (!clean) throw new WorkbenchError(400, '追加内容不能为空');
    if (!ACTIVE.has(run.status) || !run.turnId) throw new WorkbenchError(409, '只有正在运行的派单可以追加指令');
    const result = await this.runtime.steerTurn({ threadId: run.threadId, expectedTurnId: run.turnId, input: [{ type: 'text', text: clean }] });
    run.steers.push({ at: now(), text: clean, turnId: result.turnId });
    this.store.saveSoon();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    return this.#runSummary(run);
  }

  #runForThread(threadId) {
    const session = this.#sessionByThread(threadId);
    if (!session) return { session: null, run: null };
    return { session, run: session.activeRunId ? this.state.runs[session.activeRunId] : null };
  }

  #onNotification({ method, params = {} }) {
    const threadId = params.threadId || params.thread?.id;
    if (!threadId) return;
    const { session, run } = this.#runForThread(threadId);
    if (!session) return;
    if (method === 'thread/status/changed') {
      session.threadStatus = params.status;
      this.#emit('session.updated', { session });
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total;
      if (total && (!session.usageTotal || total.totalTokens >= session.usageTotal.totalTokens)) session.usageTotal = total;
      // Codex re-emits the previous turn's usage when a thread is resumed, so usage is summed per
      // turn id from `last` and repeated totals for the same turn are ignored.
      if (params.turnId && params.tokenUsage?.last) {
        let acc = this.turnUsage.get(params.turnId);
        if (!acc) {
          acc = { seen: new Set(), sum: null };
          this.turnUsage.set(params.turnId, acc);
          if (this.turnUsage.size > 500) this.turnUsage.delete(this.turnUsage.keys().next().value);
        }
        const marker = total?.totalTokens ?? JSON.stringify(params.tokenUsage.last);
        if (!acc.seen.has(marker)) {
          acc.seen.add(marker);
          acc.sum = addUsage(acc.sum, params.tokenUsage.last);
        }
      }
      if (run && params.turnId && params.turnId === run.turnId) {
        run.threadUsageTotal = total;
        run.usage = { ...this.turnUsage.get(run.turnId).sum };
        this.#emit('run.usage', { runId: run.id, usage: run.usage });
      }
      this.store.saveSoon();
      return;
    }
    if (method === 'serverRequest/resolved') {
      const approval = Object.values(this.state.approvals).find((a) => a.threadId === threadId && a.rpcId === params.requestId && a.status === 'pending');
      if (approval) {
        approval.status = 'resolved_elsewhere';
        approval.decidedAt = now();
        this.#emit('approval.updated', { approval });
      }
      return;
    }
    if (!run) return;
    const turnId = params.turnId || params.turn?.id;
    if (run.turnId && turnId && turnId !== run.turnId) return;
    const live = this.live.get(run.id);
    switch (method) {
      case 'turn/started':
        run.turnId ||= params.turn.id;
        run.startedAt ||= now();
        this.collaboration.runStarted(run);
        if (run.status === 'starting') run.status = 'running';
        this.#emit('run.updated', { run: this.#runSummary(run) });
        break;
      case 'item/started': {
        const item = normalizeItem(params.item);
        if (item.type !== 'userMessage' && item.type !== 'agentMessage') live?.inflight.set(item.id, item);
        this.#emit('run.item', { runId: run.id, item, phase: 'started' });
        break;
      }
      case 'item/completed': {
        const item = normalizeItem(params.item);
        live?.inflight.delete(item.id);
        live?.messages.delete(item.id);
        live?.outputs.delete(item.id);
        this.#recordItem(run, item);
        this.#emit('run.item', { runId: run.id, item, phase: 'completed' });
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
        if (live) live.messages.set(params.itemId, (live.messages.get(params.itemId) || '') + params.delta);
        this.#emit('run.delta', { runId: run.id, itemId: params.itemId, stream: method === 'item/agentMessage/delta' ? 'message' : 'reasoning', delta: params.delta });
        break;
      case 'item/commandExecution/outputDelta': {
        if (live) {
          const next = (live.outputs.get(params.itemId) || '') + params.delta;
          live.outputs.set(params.itemId, next.length > 8000 ? next.slice(-8000) : next);
        }
        this.#emit('run.delta', { runId: run.id, itemId: params.itemId, stream: 'output', delta: params.delta });
        break;
      }
      case 'turn/plan/updated':
        run.plan = params.plan || null;
        this.#emit('run.updated', { run: this.#runSummary(run) });
        break;
      case 'error':
        run.errors.push({ at: now(), message: params.error?.message, willRetry: Boolean(params.willRetry) });
        this.#emit('run.updated', { run: this.#runSummary(run) });
        break;
      case 'turn/completed':
        this.#finishRun(run, session, params.turn);
        break;
      default:
        break;
    }
  }

  #recordItem(run, item) {
    run.items.push(item);
    if (run.items.length > 400) run.items.splice(0, run.items.length - 400);
    this.store.appendRunEvent(run.id, { at: now(), item });
    if (item.type === 'agentMessage') run.counts.messages += 1;
    else if (item.type === 'commandExecution') run.counts.commands += 1;
    else if (item.type === 'fileChange') run.counts.fileChanges += 1;
    else if (ACTION_TYPES.has(item.type)) run.counts.toolCalls += 1;
    if (item.type === 'userMessage' && item.skills?.length) {
      run.skillEvidence = {
        injected: item.skills,
        listedByCodex: run.skills.filter((s) => item.skills.some((i) => i.path === s.path)).map((s) => ({ name: s.name, sha256: s.sha256 })),
        note: 'Codex 已在本轮输入中接收结构化 Skill，且该 Skill 由 skills/list 在运行目录发现；效果以本轮实际动作与产物为准。',
      };
    }
    this.store.saveSoon();
  }

  #queueNativeReport(run) {
    const report = this.migrations.queueResult(run);
    if (report && nativeBridgeReady(this.migrations.nativeBridge)) {
      this.migrations.sendReport(report.id).catch((error) => this.#emit('report.error', { reportId: report.id, message: error.message }));
    }
  }

  #finishRun(run, session, turn) {
    const live = this.live.get(run.id);
    for (const item of live?.inflight.values() || []) {
      const output = live.outputs.get(item.id);
      this.#recordItem(run, { ...item, status: item.status === 'inProgress' ? (turn.status === 'interrupted' ? 'interrupted' : 'incomplete') : item.status, output: output ?? item.output ?? null });
    }
    run.status = turn.status === 'inProgress' ? 'failed' : turn.status;
    run.completedAt = now();
    run.durationMs = turn.durationMs ?? null;
    run.error = turn.error || null;
    run.finalText = finalAnswer(run.items) || finalAnswer((turn.items || []).map(normalizeItem));
    if (run.status === 'interrupted') run.stopMode = run.stopRequested || 'external';
    const actions = run.counts.commands + run.counts.fileChanges + run.counts.toolCalls;
    run.claimCheck = actions
      ? { kind: 'actions_observed', actions }
      : { kind: 'no_actions_observed', note: '本轮没有观察到命令、文件修改或工具调用；回复中的完成声明需另行核验。' };
    const acc = run.turnId ? this.turnUsage.get(run.turnId) : null;
    if (acc?.sum) run.usage = { ...acc.sum };
    run.usageSource = run.usage ? 'thread/tokenUsage/updated：按本轮 turnId 汇总 last，重复事件去重' : '本轮未收到用量事件';
    run.threadUsageTotal = session.usageTotal;
    run.returnedAt = run.completedAt;
    for (const approval of Object.values(this.state.approvals)) {
      if (approval.runId === run.id && approval.status === 'pending') approval.status = 'expired';
    }
    session.activeRunId = null;
    session.status = run.status === 'completed' ? 'idle' : run.status === 'interrupted' ? (run.stopMode === 'stop' ? 'stopped' : 'paused') : 'error';
    session.updatedAt = now();
    this.live.delete(run.id);
    this.collaboration.runFinished(run);
    this.store.save();
    this.#emit('run.updated', { run: this.#runSummary(run) });
    this.#emit('session.updated', { session });
    this.#queueNativeReport(run);
    if (!this.runtimeSuspended) this.collaboration.flushInboxes();
    this.#pump();
  }

  #onRuntimeExit(exit, threadId = null) {
    for (const run of Object.values(this.state.runs)) {
      if (!ACTIVE.has(run.status)) continue;
      const session = this.state.sessions[run.sessionId];
      if (threadId ? run.threadId !== threadId : session?.source === 'native-migrated') continue;
      for (const item of this.live.get(run.id)?.inflight.values() || []) this.#recordItem(run, { ...item, status: 'interrupted' });
      run.status = 'interrupted';
      run.stopMode = run.stopRequested || 'runtime_exit';
      run.completedAt = now();
      run.error = run.error || { message: `Codex 运行服务已退出（code=${exit?.code ?? '无'}，signal=${exit?.signal ?? '无'}），可在同一会话继续。` };
      run.finalText = finalAnswer(run.items);
      if (run.nativeOrigin) { run.returnedAt = now(); this.#queueNativeReport(run); }
      if (session) {
        session.activeRunId = null;
        session.status = 'paused';
      }
      this.live.delete(run.id);
      this.collaboration.runFinished(run);
      this.#emit('run.updated', { run: this.#runSummary(run) });
    }
    for (const approval of Object.values(this.state.approvals)) if (approval.status === 'pending' && (threadId ? approval.threadId === threadId : this.state.sessions[approval.sessionId]?.source !== 'native-migrated')) approval.status = 'expired';
    this.store.save();
    this.#emit('collaboration.updated', {});
  }

  // ---------- approvals ----------

  listApprovals(status) {
    return Object.values(this.state.approvals)
      .filter((a) => !status || a.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  #onServerRequest(message, sourceRuntime = this.runtime) {
    if (message.method === 'item/tool/call') {
      let response;
      try { response = this.collaboration.handle(message, sourceRuntime, this.runtime); }
      catch (error) { response = { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error.message, status: error.status || 500 }) }] }; }
      sourceRuntime.respond(message.id, response);
      return;
    }
    const kind = APPROVAL_METHODS[message.method];
    const params = message.params || {};
    const threadId = params.threadId || params.conversationId;
    const { session, run } = threadId ? this.#runForThread(threadId) : { session: null, run: null };
    if (!kind || !run || sourceRuntime !== this.#runtimeForSession(session) || (params.turnId && run.turnId !== params.turnId)) {
      sourceRuntime.respondError(message.id, -32601, `野望科技工作台不处理该请求：${message.method}`);
      return;
    }
    const approval = {
      id: id('apv'),
      rpcId: message.id,
      method: message.method,
      kind,
      runId: run.id,
      sessionId: session.id,
      roleKey: run.roleKey,
      threadId,
      turnId: params.turnId || null,
      itemId: params.itemId || null,
      command: params.command || null,
      cwd: params.cwd || null,
      reason: params.reason || null,
      grantRoot: params.grantRoot || null,
      questions: params.questions || null,
      message: params.message || null,
      permissions: params.permissions || null,
      status: 'pending',
      createdAt: now(),
      decidedAt: null,
      decision: null,
    };
    this.state.approvals[approval.id] = approval;
    run.status = 'waiting_approval';
    session.status = 'waiting_approval';
    this.store.save();
    this.#emit('approval.updated', { approval });
    this.#emit('run.updated', { run: this.#runSummary(run) });
  }

  decideApproval(approvalId, body) {
    const approval = this.state.approvals[approvalId];
    if (!approval) throw new WorkbenchError(404, '审批不存在');
    if (approval.status !== 'pending') throw new WorkbenchError(409, '该审批已处理或已失效');
    const decision = body.decision;
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new WorkbenchError(400, '无效的审批决定');
    this.#answerApproval(approval, decision, body.answers);
    const run = this.state.runs[approval.runId];
    const session = this.state.sessions[approval.sessionId];
    const stillPending = Object.values(this.state.approvals).some((a) => a.runId === approval.runId && a.status === 'pending');
    if (run && run.status === 'waiting_approval' && !stillPending) {
      run.status = 'running';
      if (session) session.status = 'running';
    }
    this.store.save();
    if (run) this.#emit('run.updated', { run: this.#runSummary(run) });
    return approval;
  }

  #answerApproval(approval, decision, answers) {
    let result;
    switch (approval.kind) {
      case 'command':
      case 'fileChange':
        result = { decision };
        break;
      case 'legacyCommand':
      case 'legacyPatch':
        result = { decision: { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' }[decision] };
        break;
      case 'permissions':
        result = decision.startsWith('accept') ? { permissions: approval.permissions || {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' } : { permissions: {} };
        break;
      case 'userInput': {
        const out = {};
        for (const q of approval.questions || []) out[q.id] = { answers: [String(answers?.[q.id] ?? '')] };
        result = { answers: decision.startsWith('accept') ? out : {} };
        break;
      }
      case 'elicitation':
        result = { action: decision.startsWith('accept') ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline', content: null };
        break;
      default:
        result = { decision };
    }
    this.#runtimeForSession(this.state.sessions[approval.sessionId]).respond(approval.rpcId, result);
    approval.status = decision === 'accept' || decision === 'acceptForSession' ? 'accepted' : decision === 'decline' ? 'declined' : 'cancelled';
    approval.decision = decision;
    approval.decidedAt = now();
    this.#emit('approval.updated', { approval });
  }

  // ---------- desktop sessions ----------

  async desktopSessions() {
    const roles = this.company.roles();
    const out = [];
    for (const role of roles) {
      try {
        const read = await this.runtime.readThread(role.nativeThreadId, false);
        out.push({ roleKey: role.key, name: role.name, title: role.title, threadId: role.nativeThreadId, readable: true, status: read.thread.status, source: read.thread.source, updatedAt: read.thread.updatedAt, name2: read.thread.name });
      } catch (error) {
        out.push({ roleKey: role.key, name: role.name, title: role.title, threadId: role.nativeThreadId, readable: false, error: { code: error.code ?? null, message: error.message } });
      }
    }
    return out;
  }

  async desktopPreview(threadId) {
    if (!this.company.roles().some((r) => r.nativeThreadId === threadId)) throw new WorkbenchError(404, '只读取通讯录登记的岗位会话');
    const turns = await this.runtime.listTurns(threadId, 3);
    return (turns.data || []).map((turn) => {
      const items = (turn.items || []).map(normalizeItem);
      return {
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        request: (items.find((i) => i.type === 'userMessage')?.text || '').slice(0, 400),
        result: finalAnswer(items).slice(0, 800),
      };
    });
  }

  /** Explicit takeover probe: attempts thread/resume and releases immediately when it succeeds. */
  async desktopTakeoverProbe(threadId) {
    if (!this.company.roles().some((r) => r.nativeThreadId === threadId)) throw new WorkbenchError(404, '只检查通讯录登记的岗位会话');
    if (this.runtime.isLoaded(threadId) || Object.values(this.state.runs).some((r) => r.threadId === threadId && (ACTIVE.has(r.status) || r.status === 'queued'))) throw new WorkbenchError(409, '工作台已持有该会话，不再重复探测或释放');
    if (Object.values(this.state.migrations).some((p) => p.original.threadId === threadId && p.state === 'active')) throw new WorkbenchError(409, '岗位已由专用进程接管，不再重复探测');
    const result = await this.runtime.probeThreadOwnership(threadId);
    this.state.desktopProbes = { ...(this.state.desktopProbes || {}), [threadId]: result };
    this.store.save();
    return result;
  }

  // ---------- overview, handoffs, usage ----------

  handoffs() {
    const native = this.nativeCollaboration ? this.nativeCollaboration.handoffs() : this.company.handoffs();
    const roles = new Map(this.listRoles().map((r) => [r.key, r]));
    const runner = [];
    for (const run of Object.values(this.state.runs)) {
      if (run.teamTaskId || run.managerMessageIds) continue;
      const role = roles.get(run.roleKey);
      runner.push({ id: `${run.id}:dispatch`, channel: 'runner', kind: 'dispatch', fromRole: run.nativeOrigin ? 'general_manager' : 'console', fromName: run.nativeOrigin ? roles.get('general_manager')?.name || '总经理' : run.dispatcher?.label || '控制台', toRole: run.roleKey, toName: role?.name || run.roleKey, at: run.createdAt, runId: run.id, status: run.status });
      if (run.returnedAt) runner.push({ id: `${run.id}:report`, channel: 'runner', kind: 'report', fromRole: run.roleKey, fromName: role?.name || run.roleKey, toRole: 'console', toName: run.dispatcher?.label || '控制台', at: run.returnedAt, runId: run.id, status: run.status });
    }
    const nativeReturns = Object.values(this.state.nativeReports || {}).filter((r) => r.submissionVerified).map((r) => ({ id: r.id, channel: 'native', kind: 'report', fromRole: r.roleKey, fromName: roles.get(r.roleKey)?.name || r.roleKey, toRole: 'general_manager', toName: roles.get('general_manager')?.name || '总经理', at: r.submittedAt, runId: r.runId, taskId: r.taskId, submitted: true, recipientExecutionVerified: false, evidence: path.relative(this.paths.companyRoot, path.join(this.migrations.evidenceDir, `${r.id}-native-send.json`)) }));
    return [...runner, ...native, ...nativeReturns, ...this.collaboration.handoffs()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 160);
  }

  usage() {
    const runs = Object.values(this.state.runs).filter((r) => r.usage);
    const sum = (list) => list.reduce((acc, r) => {
      for (const [k, v] of Object.entries(r.usage)) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {});
    const byRole = {};
    for (const run of runs) (byRole[run.roleKey] ||= []).push(run);
    return {
      total: sum(runs),
      runs: runs.length,
      costUsd: null,
      costNote: '运行端只拿到真实 token 计数；当前账号/中转的计费口径未知，不估算金额。',
      byRole: Object.fromEntries(Object.entries(byRole).map(([k, list]) => [k, { runs: list.length, usage: sum(list) }])),
    };
  }

  overview() {
    const runs = Object.values(this.state.runs);
    const native = this.nativeCollaboration?.snapshot();
    return {
      runtime: this.runtime.snapshot(),
      maxConcurrent: this.maxConcurrent,
      counts: {
        active: runs.filter((r) => ACTIVE.has(r.status)).length + (native?.counts.active || 0),
        nativeActive: native?.counts.active || 0,
        runnerActive: runs.filter((r) => ACTIVE.has(r.status)).length,
        queued: runs.filter((r) => r.status === 'queued').length,
        waitingApproval: Object.values(this.state.approvals).filter((a) => a.status === 'pending').length,
        completed: runs.filter((r) => r.status === 'completed').length,
        interrupted: runs.filter((r) => r.status === 'interrupted').length,
        failed: runs.filter((r) => r.status === 'failed').length,
        sessions: Object.values(this.state.sessions).filter((s) => !s.archived && !s.detached).length,
      },
      usage: this.usage(),
      nativeCollaboration: native ? { counts: native.counts, ready: native.ready } : null,
      capabilities: this.#capabilityReport(),
      desktopProbes: this.state.desktopProbes || {},
      migrationReadiness: { prepared: Object.values(this.state.migrations || {}).length, active: Object.values(this.state.migrations || {}).filter((p) => p.state === 'active').length, nativeBridgeReady: nativeBridgeReady(this.migrations.nativeBridge) },
      collaboration: { groups: Object.values(this.state.collaboration.groups).length, tasks: Object.values(this.state.collaboration.tasks).length, delivered: Object.values(this.state.collaboration.tasks).filter((t) => t.status === 'delivered').length, accepted: Object.values(this.state.collaboration.tasks).filter((t) => t.status === 'accepted').length, unread: Object.values(this.state.collaboration.messages).filter((m) => m.status === 'unread').length, mode: 'isolated-test' },
    };
  }

  #capabilityReport() {
    try {
      const report = JSON.parse(fs.readFileSync(this.paths.reportFile, 'utf8'));
      return { ...report, checks: (report.checks || []).map((check) => ({ ...check, label: check.label?.replace('宠物状态', '岗位人物状态') })) };
    } catch {
      return null;
    }
  }
}
