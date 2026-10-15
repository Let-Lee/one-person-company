import { EventEmitter } from 'node:events';
import { JsonRpcProcess } from './jsonrpc-process.mjs';
import { resolveCodexBin, codexInvocation } from './codex-bin.mjs';

const CLIENT_INFO = { name: 'yewang_workbench', title: '野望科技工作台', version: '2.1.1' };

/**
 * Codex App Server runtime adapter.
 *
 * Mirrors the responsibilities of Paperclip's codex-local adapter (environment, session
 * resolution/resume, skill injection, interruption, usage) but talks to the structured
 * App Server protocol so the console receives real item/turn events instead of parsed CLI text.
 */
export class CodexRuntime extends EventEmitter {
  constructor({ codexBin = resolveCodexBin(), cwd, env = process.env, extraSkillRoots = [], args, requestTimeoutMs = 120_000, contextMode = null } = {}) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.env = env;
    this.args = args || ['app-server', '--listen', 'stdio://'];
    this.contextMode = contextMode;
    this.extraSkillRoots = extraSkillRoots;
    this.requestTimeoutMs = requestTimeoutMs;
    this.rpc = null;
    this.status = 'stopped';
    this.info = null;
    this.lastExit = null;
    this.lastError = null;
    this.lastStderr = [];
    this.loadedThreads = new Set();
    this.starting = null;
    this.stopping = false;
  }

  snapshot() {
    return {
      status: this.status,
      contextMode: this.contextMode,
      codexBin: this.codexBin,
      pid: this.rpc?.child?.pid ?? null,
      info: this.info,
      lastExit: this.lastExit,
      lastError: this.lastError,
      loadedThreads: [...this.loadedThreads],
      stderrTail: this.rpc?.stderr?.slice(-12) ?? this.lastStderr,
    };
  }

  async ensureStarted() {
    if (this.status === 'ready' && this.rpc?.running) return this;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    this.#setStatus('starting');
    const rpc = new JsonRpcProcess({ ...codexInvocation(this.codexBin, this.args), cwd: this.cwd, env: this.env, name: 'codex-app-server' });
    this.rpc = rpc;
    rpc.on('notification', (message) => this.emit('notification', message));
    rpc.on('serverRequest', (message) => this.emit('serverRequest', message));
    rpc.on('processError', (error) => {
      this.lastError = error.message;
      this.emit('runtimeError', error);
    });
    rpc.on('exit', (exit) => {
      if (this.rpc !== rpc) return;
      this.lastStderr = rpc.stderr.slice(-12);
      this.lastExit = exit;
      this.loadedThreads.clear();
      this.rpc = null;
      this.#setStatus(this.stopping ? 'stopped' : 'exited');
      this.emit('exit', exit);
    });
    rpc.start();
    try {
      const init = await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, { timeoutMs: 30_000 });
      rpc.notify('initialized');
      this.info = { ...init, startedAt: new Date().toISOString() };
      if (this.extraSkillRoots.length) await rpc.request('skills/extraRoots/set', { extraRoots: this.extraSkillRoots });
      this.lastError = null;
      this.#setStatus('ready');
      return this;
    } catch (error) {
      this.lastError = error.message;
      this.#setStatus('error');
      await rpc.stop().catch(() => {});
      throw error;
    }
  }

  async stop() {
    if (!this.rpc) {
      this.#setStatus('stopped');
      return;
    }
    this.stopping = true;
    try {
      await this.rpc.stop();
    } finally {
      this.stopping = false;
      this.loadedThreads.clear();
      this.#setStatus('stopped');
    }
  }

  async restart() {
    await this.stop();
    return this.ensureStarted();
  }

  async request(method, params, options) {
    await this.ensureStarted();
    return this.rpc.request(method, params, { timeoutMs: this.requestTimeoutMs, ...options });
  }

  respond(id, result) {
    if (!this.rpc) throw new Error('Codex 运行服务未启动，无法回复审批');
    this.rpc.respond(id, result);
  }

  respondError(id, code, message) {
    if (!this.rpc) return;
    this.rpc.respondError(id, code, message);
  }

  async setExtraSkillRoots(roots) {
    this.extraSkillRoots = roots;
    if (this.status === 'ready') await this.request('skills/extraRoots/set', { extraRoots: roots });
  }

  listModels() {
    return this.request('model/list', {});
  }

  listSkills(cwds, forceReload = false) {
    return this.request('skills/list', { cwds, forceReload });
  }

  listThreads(params = {}) {
    return this.request('thread/list', params);
  }

  readThread(threadId, includeTurns = false) {
    return this.request('thread/read', { threadId, includeTurns });
  }

  listTurns(threadId, limit = 3) {
    return this.request('thread/turns/list', { threadId, limit, itemsView: 'summary' });
  }

  async startThread(params) {
    const result = await this.request('thread/start', params);
    this.loadedThreads.add(result.thread.id);
    return result;
  }

  async resumeThread(threadId, params = {}) {
    const result = await this.request('thread/resume', { threadId, excludeTurns: true, ...params });
    this.loadedThreads.add(threadId);
    return result;
  }

  isLoaded(threadId) {
    return this.status === 'ready' && this.loadedThreads.has(threadId);
  }

  startTurn(params) {
    return this.request('turn/start', params);
  }

  steerTurn(params) {
    return this.request('turn/steer', params);
  }

  interruptTurn(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  setThreadName(threadId, name) {
    return this.request('thread/name/set', { threadId, name });
  }

  async archiveThread(threadId) {
    const result = await this.request('thread/archive', { threadId });
    this.loadedThreads.delete(threadId);
    return result;
  }

  async unsubscribe(threadId) {
    const result = await this.request('thread/unsubscribe', { threadId });
    if (!['unsubscribed', 'notLoaded'].includes(result?.status)) throw new Error(`Codex 未确认会话已释放（${result?.status ?? '缺少状态'}）`);
    // Unsubscribe acknowledges the event subscription. This installation may retain the writer
    // until process exit, so it must not be used as proof of ownership release.
    return result;
  }

  fork({ cwd = this.cwd } = {}) {
    return new CodexRuntime({ codexBin: this.codexBin, cwd, env: this.env, extraSkillRoots: this.extraSkillRoots, args: this.args, requestTimeoutMs: this.requestTimeoutMs, contextMode: this.contextMode });
  }

  async probeThreadOwnership(threadId, { cwd = this.cwd } = {}) {
    const probeRuntime = this.fork({ cwd });
    const result = { threadId, at: new Date().toISOString(), method: 'thread/resume', turnStarted: false, ok: false, released: false };
    try {
      const resumed = await probeRuntime.resumeThread(threadId);
      result.runtimePid = probeRuntime.snapshot().pid;
      if (resumed.thread?.id !== threadId) throw new Error('占用探测返回的会话 ID 不匹配');
      result.ok = true; result.status = resumed.thread.status;
    } catch (error) { result.code = error.code ?? null; result.message = error.message; }
    finally {
      await probeRuntime.stop().then(() => {
        result.release = { method: 'isolated-process-stop', status: probeRuntime.status, lastExit: probeRuntime.lastExit };
        result.released = probeRuntime.status === 'stopped';
      }).catch((error) => { result.releaseError = error.message; });
    }
    return result;
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', this.snapshot());
  }
}
