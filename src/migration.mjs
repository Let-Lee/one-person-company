import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeBridgeReady, NativeRouteError, verifyNativeBinding, verifyNativeInbound, verifyNativeSubmission } from './native-route.mjs';

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const busyStatuses = new Set(['queued', 'starting', 'running', 'waiting_approval']);

/** Same-ID migration: never copies, edits, archives, or invents native thread storage. */
export class MigrationCoordinator {
  constructor({ store, runtime, company, paths, nativeBridge, emit, resolveCwd, attachRuntime }) {
    Object.assign(this, { store, runtime, company, paths, nativeBridge, emit, resolveCwd, attachRuntime });
    this.locks = new Set();
    this.runtimes = new Map();
    store.state.migrations ||= {};
    store.state.nativeReports ||= {};
    store.state.nativeInboundRuns ||= {};
    for (const plan of Object.values(store.state.migrations)) {
      plan.rollback.method = 'isolated-process-stop';
      plan.runtimeMode = 'isolated-role-process';
    }
    this.evidenceDir = path.join(paths.dataDir, 'migration-evidence');
    fs.mkdirSync(this.evidenceDir, { recursive: true });
  }

  get state() { return this.store.state; }
  #role(key) {
    const roles = this.company.roles();
    const role = roles.find((r) => r.key === key);
    if (!role?.nativeThreadId) throw new NativeRouteError(404, '只能为通讯录登记的正式岗位准备接管');
    if (roles.filter((r) => r.nativeThreadId === role.nativeThreadId).length !== 1) throw new NativeRouteError(409, '同一原生会话存在重复岗位映射，需经理先核对');
    return role;
  }
  #identity(role) {
    return { roleKey: role.key, threadId: role.nativeThreadId, managerThreadId: this.company.managerThreadId() };
  }
  #check(plan) {
    const role = this.#role(plan.roleKey);
    if (digest(this.#identity(role)) !== plan.mappingFingerprint) throw new NativeRouteError(409, '岗位或经理路由已变，原准备记录失效；需重新准备');
    return role;
  }
  #get(planId) {
    const plan = this.state.migrations[planId];
    if (!plan) throw new NativeRouteError(404, '接管准备记录不存在');
    return plan;
  }
  async #lock(key, fn) {
    if (this.locks.has(key)) throw new NativeRouteError(409, '该岗位正在检查或办理接管，请等本次操作结束');
    this.locks.add(key);
    try { return await fn(); } finally { this.locks.delete(key); }
  }
  #save(plan) {
    plan.updatedAt = now();
    this.store.save();
    const file = path.join(this.evidenceDir, `${plan.id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plan, null, 2)); fs.renameSync(tmp, file);
    this.emit('migration.updated', { migration: plan });
    return plan;
  }
  #busy(threadId) {
    return Object.values(this.state.runs).some((r) => r.threadId === threadId && busyStatuses.has(r.status));
  }
  snapshot() {
    return {
      bridge: { ready: nativeBridgeReady(this.nativeBridge), reason: nativeBridgeReady(this.nativeBridge) ? '原生宿主适配器已接入，具体源仍逐次校验' : '当前独立 App Server 没有原生聊天发送宿主；缺少真实源绑定和发送能力' },
      plans: Object.values(this.state.migrations).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      reports: Object.values(this.state.nativeReports).map(({ prompt, receipt, ...r }) => ({ ...r, hasReceipt: Boolean(receipt), promptPreview: prompt.slice(0, 200) })),
    };
  }
  get(planId) { return this.#get(planId); }

  async prepare(roleKey) {
    return this.#lock(roleKey, async () => {
      const role = this.#role(roleKey), identity = this.#identity(role);
      if (!identity.managerThreadId) throw new NativeRouteError(409, '通讯录中没有唯一总经理路由');
      const existing = Object.values(this.state.migrations).find((p) => p.roleKey === roleKey && p.state !== 'rolled_back' && p.mappingFingerprint === digest(identity));
      if (existing) return existing;
      if (Object.values(this.state.migrations).some((p) => p.roleKey === roleKey && p.state === 'active')) throw new NativeRouteError(409, '该岗位已有未回滚的接管，需先处理原记录');
      const read = await this.runtime.readThread(role.nativeThreadId, false);
      if (read.thread?.id !== role.nativeThreadId) throw new NativeRouteError(502, '会话读取返回了其他 ID，停止准备');
      const thread = read.thread;
      const cwd = this.resolveCwd(thread.cwd);
      const plan = {
        id: uid('mig'), roleKey, roleName: role.name, roleTitle: role.roleTitle, state: 'prepared',
        original: { threadId: thread.id, cwd, name: thread.name || null, model: thread.model || null, modelProvider: thread.modelProvider || null, source: thread.source || null, updatedAt: thread.updatedAt || null },
        managerThreadId: identity.managerThreadId, mappingFingerprint: digest(identity),
        mode: 'same_thread_id', sharedDirectoryChanged: false, storageRewritten: false,
        sourceBinding: null, sessionId: null, writerProbe: null, blockedReason: null,
        rollback: { threadId: thread.id, method: 'isolated-process-stop', sharedRecordsToRestore: [], nativeHistoryPreserved: true },
        createdAt: now(), updatedAt: now(),
      };
      this.state.migrations[plan.id] = plan;
      return this.#save(plan);
    });
  }

  /** Resume without setting overrides, then stop only the probe's own isolated process. */
  async probe(planId) {
    const plan = this.#get(planId);
    return this.#lock(plan.roleKey, async () => {
      this.#check(plan);
      const threadId = plan.original.threadId;
      if (plan.state === 'active' || this.runtimes.has(plan.id) || this.runtime.isLoaded(threadId) || this.#busy(threadId)) throw new NativeRouteError(409, '工作台已持有或正在执行该会话，不进行重复占用探测');
      const probe = await this.runtime.probeThreadOwnership(threadId, { cwd: plan.original.cwd });
      plan.writerProbe = probe;
      plan.state = probe.ok && probe.released ? 'writer_ready' : probe.releaseError ? 'release_failed' : 'writer_blocked';
      plan.blockedReason = probe.releaseError || probe.message || null;
      return this.#save(plan);
    });
  }

  async activate(planId) {
    const plan = this.#get(planId);
    return this.#lock(plan.roleKey, async () => {
      this.#check(plan);
      if (plan.state === 'active') return plan;
      if (this.runtimes.has(plan.id)) throw new NativeRouteError(409, '上次进程尚未释放，请先撤回接管');
      if (plan.state === 'rolled_back') throw new NativeRouteError(409, '准备记录已撤回，请重新准备');
      if (!nativeBridgeReady(this.nativeBridge)) {
        plan.blockedReason = '原生宿主通道未接入：尚不能证明源身份或从该岗位原生回传';
        if (plan.state !== 'writer_blocked') plan.state = 'bridge_blocked';
        this.#save(plan);
        throw new NativeRouteError(409, plan.blockedReason, { writerProbe: plan.writerProbe, bridgeReady: false });
      }
      const binding = verifyNativeBinding(await this.nativeBridge.verifyBinding({ threadId: plan.original.threadId, managerThreadId: plan.managerThreadId }), plan.original.threadId, plan.managerThreadId);
      const threadId = plan.original.threadId;
      if (this.runtime.isLoaded(threadId) || this.#busy(threadId)) throw new NativeRouteError(409, '该原生会话已经被本运行器持有');
      if (Object.values(this.state.sessions).some((s) => s.threadId === threadId && !s.detached)) throw new NativeRouteError(409, '已有会话记录绑定该 ID，需先回滚或释放');
      const roleRuntime = this.runtime.fork({ cwd: plan.original.cwd });
      try {
        const resumed = await roleRuntime.resumeThread(threadId);
        if (resumed.thread?.id !== threadId || this.resolveCwd(resumed.cwd || resumed.thread?.cwd) !== plan.original.cwd) throw new NativeRouteError(409, '会话 ID 或工作目录变化，需要重新准备');
        if (resumed.thread.status?.type === 'active') throw new NativeRouteError(409, '续接后会话仍有活动轮次，先结束原轮次再接管');
        this.#check(plan);
        const session = {
          id: uid('ses'), roleKey: plan.roleKey, threadId, title: plan.original.name || `${plan.roleTitle}｜${plan.roleName}`,
          cwd: plan.original.cwd, model: resumed.model, modelProvider: resumed.modelProvider,
          effort: resumed.reasoningEffort ?? null, sandbox: null, approvalPolicy: resumed.approvalPolicy,
          instructionSources: resumed.instructionSources || [], source: 'native-migrated', migrationId: plan.id, runtimeMode: 'isolated-role-process',
          status: 'idle', activeRunId: null, lastRunId: null, usageTotal: null, archived: false, detached: false,
          createdAt: now(), updatedAt: now(),
        };
        this.state.sessions[session.id] = session;
        this.runtimes.set(plan.id, roleRuntime);
        this.attachRuntime(roleRuntime, plan.id, threadId);
        plan.runtimePid = roleRuntime.snapshot().pid;
        plan.sessionId = session.id; plan.state = 'active'; plan.sourceBinding = binding; plan.blockedReason = null;
        this.emit('session.updated', { session });
        return this.#save(plan);
      } catch (error) {
        await roleRuntime.stop().catch((releaseError) => {
          plan.releaseError = releaseError.message;
          plan.runtimePid = roleRuntime.snapshot().pid;
          this.runtimes.set(plan.id, roleRuntime);
        });
        plan.state = plan.releaseError ? 'release_failed' : 'writer_blocked'; plan.blockedReason = error.message;
        this.#save(plan); throw error;
      }
    });
  }

  async rollback(planId) {
    const plan = this.#get(planId);
    return this.#lock(plan.roleKey, async () => {
      if (plan.state === 'rolled_back') return plan;
      const session = plan.sessionId ? this.state.sessions[plan.sessionId] : null;
      if (this.#busy(plan.original.threadId)) throw new NativeRouteError(409, '该会话正在执行或排队；请先暂停或取消，再撤回接管');
      // No mapping check here: even a changed directory must not prevent releasing our own writer.
      const roleRuntime = this.runtimes.get(plan.id);
      if (roleRuntime) {
        try { await roleRuntime.stop(); plan.release = { method: 'isolated-role-process-stop', lastExit: roleRuntime.lastExit, status: roleRuntime.status }; this.runtimes.delete(plan.id); }
        catch (error) { plan.state = 'release_failed'; plan.blockedReason = error.message; this.#save(plan); throw error; }
      }
      if (session) { session.detached = true; session.status = 'detached'; session.activeRunId = null; session.updatedAt = now(); this.emit('session.updated', { session }); }
      plan.state = 'rolled_back'; plan.rolledBackAt = now(); plan.blockedReason = null;
      return this.#save(plan);
    });
  }

  assertActive(session) {
    const plan = this.#get(session.migrationId);
    this.#check(plan);
    if (plan.state !== 'active' || session.detached || plan.sessionId !== session.id || session.threadId !== plan.original.threadId || !this.runtimes.get(plan.id)?.isLoaded(session.threadId)) throw new NativeRouteError(409, '正式会话映射已失效或撤回');
    return plan;
  }

  runtimeFor(session) { this.assertActive(session); return this.runtimes.get(session.migrationId); }
  noteRuntimeExit(planId, exit) {
    const plan = this.#get(planId);
    this.runtimes.delete(planId);
    if (plan.state === 'rolled_back') return;
    plan.state = 'runtime_released'; plan.blockedReason = '岗位运行进程已退出，需重新核验后接管'; plan.lastExit = exit;
    const session = this.state.sessions[plan.sessionId];
    if (session) { session.detached = true; session.status = 'detached'; }
    for (const report of Object.values(this.state.nativeReports)) if (report.migrationId === planId && report.status === 'sending') { report.status = 'delivery_unknown'; report.error = { message: '岗位运行进程退出时发送仍未确认，需查询原操作' }; }
    this.#save(plan);
  }
  async stopAll() {
    for (const roleRuntime of [...this.runtimes.values()]) await roleRuntime.stop();
  }

  async dispatch(planId, { messageId, taskId }, runDispatch) {
    const plan = this.#get(planId);
    return this.#lock(plan.roleKey, async () => {
      const session = this.state.sessions[plan.sessionId];
      if (!session) throw new NativeRouteError(409, '该岗位尚未正式接管');
      this.assertActive(session);
      if (!nativeBridgeReady(this.nativeBridge)) throw new NativeRouteError(409, '原生来源读取通道不可用');
      verifyNativeBinding(await this.nativeBridge.verifyBinding({ threadId: session.threadId, managerThreadId: plan.managerThreadId }), session.threadId, plan.managerThreadId);
      const snapshot = await this.nativeBridge.readInbound({ threadId: session.threadId, messageId });
      const origin = verifyNativeInbound(snapshot, { threadId: session.threadId, managerThreadId: plan.managerThreadId, messageId });
      const authorization = await this.nativeBridge.authorizeTask({ taskId, roleKey: plan.roleKey, origin });
      if (authorization?.allowed !== true || authorization.taskId !== taskId || !authorization.evidenceId) throw new NativeRouteError(403, '原生派单尚无对应任务授权或工作仍在暂停');
      this.assertActive(session);
      const operationKey = digest({ threadId: session.threadId, messageId, source: origin.sourceThreadId });
      const previous = this.state.nativeInboundRuns[operationKey];
      if (previous) return { ...this.state.runs[previous], duplicate: true };
      const run = await runDispatch({ sessionId: session.id, prompt: origin.prompt, kind: 'native-dispatch', nativeOrigin: { ...origin, taskId, authorizationEvidenceId: authorization.evidenceId, operationKey } });
      this.state.nativeInboundRuns[operationKey] = run.id;
      this.store.save();
      return run;
    });
  }

  queueResult(run) {
    const session = this.state.sessions[run.sessionId];
    if (session?.source !== 'native-migrated' || !run.nativeOrigin || !run.returnedAt) return null;
    const plan = this.#get(session.migrationId);
    const operationKey = digest({ migrationId: plan.id, threadId: run.threadId, runId: run.id, turnId: run.turnId || null });
    const existing = Object.values(this.state.nativeReports).find((r) => r.operationKey === operationKey);
    if (existing) return existing;
    const report = {
      id: uid('rpt'), operationKey, migrationId: plan.id, runId: run.id, turnId: run.turnId, roleKey: plan.roleKey,
      sourceThreadId: run.threadId, recipientThreadId: plan.managerThreadId, taskId: run.nativeOrigin?.taskId || null,
      prompt: `${plan.roleName}：${{ completed: '本轮执行已结束', interrupted: '本轮已中断', failed: '本轮执行失败', cancelled: '本轮已取消，未开始执行' }[run.status] || '本轮结果'}。${run.finalText || run.error?.message || '没有最终回复，请核对运行记录。'}`,
      status: 'pending', submissionVerified: false, recipientExecutionVerified: false,
      createdAt: now(), updatedAt: now(), receipt: null, error: null,
    };
    this.state.nativeReports[report.id] = report; run.nativeReportId = report.id; this.store.save();
    this.emit('report.updated', { report: { ...report, prompt: undefined } });
    return report;
  }

  async sendReport(reportId) {
    const report = this.state.nativeReports[reportId];
    if (!report) throw new NativeRouteError(404, '回传记录不存在');
    return this.#lock(`report:${reportId}`, async () => {
      if (report.status === 'submitted') return { ...report, duplicate: true };
      if (['sending', 'delivery_unknown'].includes(report.status)) throw new NativeRouteError(409, '发送结果尚不确定，需原生查询旧操作，不自动重复发送');
      const plan = this.#get(report.migrationId); this.#check(plan);
      if (!nativeBridgeReady(this.nativeBridge)) throw new NativeRouteError(409, '原生回传通道尚未接入，排队不等于已提交');
      verifyNativeBinding(await this.nativeBridge.verifyBinding({ threadId: report.sourceThreadId, managerThreadId: report.recipientThreadId }), report.sourceThreadId, report.recipientThreadId);
      report.status = 'sending'; report.updatedAt = now(); this.store.save();
      try {
        const result = await this.nativeBridge.sendMessage({ sourceThreadId: report.sourceThreadId, request: { threadId: report.recipientThreadId, prompt: report.prompt }, operationKey: report.operationKey });
        // Preserve the actual tool return before interpreting it.
        report.receipt = result;
        fs.writeFileSync(path.join(this.evidenceDir, `${report.id}-native-send.json`), JSON.stringify(result, null, 2));
        verifyNativeSubmission(result, report);
        report.status = 'submitted'; report.submissionVerified = true; report.submittedAt = now(); report.error = null;
      } catch (error) {
        report.status = 'delivery_unknown'; report.error = { message: error.message, code: error.code ?? null };
        throw error;
      } finally {
        report.updatedAt = now(); this.store.save(); this.emit('report.updated', { report: { ...report, prompt: undefined } });
      }
      return report;
    });
  }

  recover() {
    for (const plan of Object.values(this.state.migrations)) if (plan.state === 'active') {
      plan.state = 'runtime_released'; plan.blockedReason = '运行端重启已释放占用，需重新核验原生通道后接管';
      const session = this.state.sessions[plan.sessionId];
      if (session) { session.detached = true; session.status = 'detached'; }
    }
    for (const report of Object.values(this.state.nativeReports)) if (report.status === 'sending') { report.status = 'delivery_unknown'; report.error = { message: '发送过程中重启，原生提交状态需查询后处理' }; }
    this.store.save();
  }
}
