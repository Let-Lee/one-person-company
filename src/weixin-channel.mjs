import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import qrcode from './vendor/qrcode.cjs';
import { WeixinApi, WeixinError, WEIXIN_BASE, weixinBase } from './weixin-api.mjs';
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_approval']);
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new WeixinError('微信本机记录无法读取，请保留文件并检查'); return fallback; } };
const write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); fs.chmodSync(file + '.tmp', 0o600); fs.renameSync(file + '.tmp', file); };

/** A durable message channel, never another model or conversation writer. */
export class WeixinChannel extends EventEmitter {
  constructor({ workbench, desktopManager, dataDir, api = new WeixinApi(), background = true } = {}) {
    super(); this.wb = workbench; this.desktop = desktopManager; this.api = api; this.background = background;
    this.dir = path.join(dataDir, 'channels', 'weixin');
    this.file = path.join(this.dir, 'journal.json'); this.secretFile = path.join(this.dir, 'credentials.json');
    const empty = { version: 1, enabled: false, paused: false, status: 'disconnected', manager: null, requests: [], replies: [], rejected: 0 };
    try {
      this.state = read(this.file, empty); this.secret = read(this.secretFile, {});
      if (!Array.isArray(this.state.requests) || !Array.isArray(this.state.replies) || !this.state.requests.every(r => r && typeof r.id === 'string' && typeof r.text === 'string' && r.target) || !this.secret || typeof this.secret !== 'object') throw new WeixinError('微信本机记录结构无效，请保留原文件并检查');
      if (this.state.enabled && (!this.secret.token || !this.secret.ownerId || !this.secret.botId)) Object.assign(this.state, { enabled: false, status: 'auth_expired', lastError: '微信登录凭据不完整，请重新扫码。' });
    }
    catch (error) { this.storageBlocked = true; this.state = { ...empty, status: 'connection_error', lastError: error.message }; this.secret = {}; }
    this.login = null; this.epoch = 0; this.controller = new AbortController(); this.closed = false;
    this.working = false; this.polling = false; this.failures = 0;
    for (const request of this.state.requests) if (request.status === 'submitting') {
      const runId = this.wb.state.consoleRequests?.[request.id]?.runId;
      const desktop = this.desktop?.messages?.find(m => m.id === request.id);
      if (runId) { request.runId = runId; request.status = 'running'; }
      else if (desktop) request.status = desktop.status === 'unknown' ? 'unknown' : 'running';
      else { request.status = 'unknown'; request.error = '服务在提交时停止，结果待核实；不会自动重派。'; }
    }
    for (const reply of this.state.replies) if (reply.status === 'sending') { reply.status = 'unknown'; reply.error = '发送时服务停止，是否送达不明；可在新来信中查询结果。'; }
    this.onWork = e => { if (['run.updated', 'approval.updated', 'collaboration.updated'].includes(e.type)) this.tick().catch(() => {}); };
    this.onDesktop = () => this.tick().catch(() => {});
  }
  #persist() {
    if (this.storageBlocked) throw new WeixinError('微信本机记录无法安全读取，已保留原文件；请检查后再连接。', { status: 409 });
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); fs.chmodSync(this.dir, 0o700);
    write(this.file, this.state); write(this.secretFile, this.secret);
  }
  #changed() { this.#persist(); this.emit('changed', { status: this.state.status }); }
  choices() {
    if (this.wb.state.workspace.executionMode === 'desktop') {
      const d = this.desktop?.snapshot();
      return d?.configured ? [{ key: 'desktop', name: d.target.name, title: '总经理', mode: 'desktop', threadId: d.target.threadId }] : [];
    }
    return this.wb.listRoles().filter(r => r.source === 'local' && r.collaboration?.authority === 'manager').map(r => {
      const s = this.wb.collaboration.sessionFor(r.key);
      return s && !s.archived ? { key: r.key, name: r.name, title: r.roleTitle, mode: 'independent', sessionId: s.id, threadId: s.threadId } : null;
    }).filter(Boolean);
  }
  #manager(key) {
    const choice = this.choices().find(c => c.key === key);
    if (!choice) throw new WeixinError('请先建立并选择当前模式的总经理会话', { status: 409 });
    return structuredClone(choice);
  }
  #sameManager(target) { return this.choices().some(c => c.key === target?.key && c.mode === target.mode && c.threadId === target.threadId && c.sessionId === target.sessionId); }
  snapshot() {
    const binding = this.secret.ownerId ? hash(this.secret.ownerId) : null;
    const requests = this.state.requests.filter(r => r.binding === binding).slice(-30);
    const mine = new Set(requests.map(r => r.id));
    return { status: this.state.status, enabled: this.state.enabled, paused: this.state.paused, manager: this.state.manager, choices: this.choices(),
      connectedAt: this.state.connectedAt || null, receivedAt: this.state.receivedAt || null, sentAt: this.state.sentAt || null,
      lastError: this.state.lastError || null, peerVerified: Boolean(this.secret.ownerId),
      login: this.login ? { id: this.login.id, status: this.login.status, qrSvg: this.login.svg, expiresAt: this.login.expiresAt } : null,
      requests: requests.map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, runId: r.runId, mode: r.target.mode, error: r.error || null, title: r.text.slice(0, 70) })),
      replies: this.state.replies.filter(r => mine.has(r.requestId)).slice(-40).map(r => ({ id: r.id, requestId: r.requestId, status: r.status, kind: r.kind, sentAt: r.sentAt || null, error: r.error || null })),
      counts: { queued: requests.filter(r => r.status === 'queued').length, running: requests.filter(r => ['submitting', 'running'].includes(r.status)).length,
        failedDelivery: this.state.replies.filter(r => mine.has(r.requestId) && ['failed', 'unknown', 'held'].includes(r.status)).length },
      conditions: '本机公司服务须保持运行。首次支持本人文字私聊；长时回传取决于微信上下文与服务限制，失败结果仍在原任务保留。' };
  }
  start() {
    if (this.started) return; this.started = true; this.closed = false;
    this.wb.on('event', this.onWork); this.desktop?.on('changed', this.onDesktop);
    if (this.background) { this.timer = setInterval(() => this.tick().catch(() => {}), 3000); this.timer.unref(); this.#schedulePoll(0); }
  }
  #abort() {
    this.epoch++; this.controller.abort(); this.controller = new AbortController(); clearTimeout(this.loginTimer); clearTimeout(this.pollTimer);
    for (const reply of this.state.replies) if (reply.status === 'sending') { reply.status = 'unknown'; reply.error = '连接在发送时停止，是否送达待核实；请通过新来信查询。'; }
  }
  close() {
    this.closed = true; this.#abort(); clearInterval(this.timer); this.wb.off('event', this.onWork); this.desktop?.off('changed', this.onDesktop); this.started = false;
  }
  async beginLogin({ managerKey } = {}) {
    if (this.storageBlocked) throw new WeixinError(this.state.lastError, { status: 409 });
    const manager = this.#manager(managerKey);
    if (this.state.requests.some(r => ['queued', 'submitting', 'running', 'unknown'].includes(r.status)) && this.state.manager?.threadId !== manager.threadId) throw new WeixinError('原经理还有待处理消息，请先核对后再切换', { status: 409 });
    this.#abort(); const epoch = this.epoch;
    this.secret = {}; this.login = null; this.state.enabled = false; this.state.manager = manager; this.state.status = 'connecting'; this.state.lastError = null; this.#changed();
    try {
      const data = await this.api.qr(this.controller.signal);
      if (this.closed || epoch !== this.epoch) return this.snapshot();
      if (!data.qrcode || typeof data.qrcode_img_content !== 'string' || data.qrcode_img_content.length > 4096) throw new WeixinError('微信没有返回可展示的二维码，请重新连接');
      const qr = qrcode(0, 'M'); qr.addData(data.qrcode_img_content); qr.make();
      this.login = { id: randomUUID(), value: data.qrcode, svg: qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }), status: 'wait', expiresAt: new Date(Date.now() + 5 * 60000).toISOString(), baseUrl: WEIXIN_BASE };
      this.state.status = 'waiting_scan'; this.#changed(); this.#scheduleLogin(); return this.snapshot();
    } catch (error) { if (epoch !== this.epoch) return this.snapshot(); this.state.status = 'connection_error'; this.state.lastError = this.#error(error); this.#changed(); throw error; }
  }
  #scheduleLogin() {
    if (!this.background || !this.login || this.closed || this.state.status === 'connection_error' || ['need_verifycode', 'expired', 'verify_code_blocked'].includes(this.login.status)) return;
    clearTimeout(this.loginTimer); this.loginTimer = setTimeout(() => this.pollLogin().catch(() => {}), 1000); this.loginTimer.unref();
  }
  async verify({ code } = {}) {
    if (!this.login || this.login.status !== 'need_verifycode' || !/^\d{4,10}$/.test(String(code || ''))) throw new WeixinError('请填写微信提示的验证码', { status: 400 });
    await this.pollLogin(String(code)); return this.snapshot();
  }
  async pollLogin(verifyCode) {
    if (!this.login || this.loginBusy || this.closed) return;
    if (Date.parse(this.login.expiresAt) < Date.now()) { this.login.status = 'expired'; this.state.status = 'expired'; this.#changed(); return; }
    const epoch = this.epoch; this.loginBusy = true;
    try {
      const result = await this.api.login(this.login.value, { baseUrl: this.login.baseUrl, verifyCode, signal: this.controller.signal });
      if (epoch !== this.epoch || this.closed) return;
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_user_id || !result.ilink_bot_id) throw new WeixinError('微信未返回可核验的扫码本人身份，请重新连接');
        this.secret = { token: result.bot_token, ownerId: result.ilink_user_id, botId: result.ilink_bot_id, baseUrl: weixinBase(result.baseurl), contexts: {}, cursor: '' };
        this.state.enabled = true; this.state.status = 'connected'; this.state.connectedAt = now(); this.state.lastError = null; this.failures = 0; this.login = null;
        this.#changed(); this.#schedulePoll(0); return;
      }
      if (result.status === 'scaned_but_redirect' && result.redirect_host) this.login.baseUrl = weixinBase('https://' + result.redirect_host);
      const changed = this.login.status !== result.status;
      this.login.status = result.status || 'wait';
      if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(this.login.status)) {
        this.state.status = this.login.status === 'expired' ? 'expired' : 'connection_error';
        this.state.lastError = this.login.status === 'binded_redirect' ? '该机器人已绑定其他实例，请在微信确认后重新连接。' : this.login.status === 'verify_code_blocked' ? '验证次数受限，请重新生成二维码。' : null;
      }
      if (changed) this.#changed();
    } catch (error) {
      if (epoch !== this.epoch || this.closed) return;
      if (error.code !== 'timeout') { this.state.status = 'connection_error'; this.state.lastError = this.#error(error); this.#changed(); return; }
    } finally { this.loginBusy = false; }
    this.#scheduleLogin();
  }
  disconnect() {
    this.#abort(); this.login = null; this.secret = {}; this.state.enabled = false; this.state.status = 'disconnected'; this.state.lastError = null;
    this.#changed(); return this.snapshot();
  }
  reconnect() {
    if (!this.secret.token || !this.secret.ownerId || this.state.status === 'auth_expired') throw new WeixinError('请重新扫码连接', { status: 409 });
    this.#abort(); this.failures = 0; this.state.enabled = true; this.state.status = 'connected'; this.state.lastError = null; this.#changed(); this.#schedulePoll(0); return this.snapshot();
  }
  #schedulePoll(delay) {
    if (!this.background || this.closed || !this.state.enabled || !this.secret.token) return;
    clearTimeout(this.pollTimer); this.pollTimer = setTimeout(() => this.poll().catch(() => {}), delay); this.pollTimer.unref();
  }
  async poll() {
    if (this.closed || this.polling || !this.state.enabled || !this.secret.token) return;
    this.polling = true; const epoch = this.epoch; let delay = 1000;
    try {
      const data = await this.api.updates(this.secret, this.secret.cursor, this.controller.signal);
      if (this.closed || epoch !== this.epoch) return;
      for (const message of data.msgs || []) this.receive(message);
      if (data.get_updates_buf) this.secret.cursor = data.get_updates_buf;
      this.failures = 0; this.state.status = 'connected'; this.state.lastError = null; this.#persist(); await this.tick();
    } catch (error) {
      if (this.closed || epoch !== this.epoch) return;
      if (error.code === 'timeout') return;
      this.failures++; this.state.lastError = this.#error(error);
      if (error.auth || this.failures >= 5) { this.state.enabled = false; this.state.status = error.auth ? 'auth_expired' : 'connection_error'; }
      delay = Math.min(30000, 1000 * 2 ** this.failures); this.#changed();
    } finally { this.polling = false; this.#schedulePoll(delay); }
  }
  receive(message) {
    if (!this.state.enabled || !this.secret.ownerId || message.from_user_id !== this.secret.ownerId || message.to_user_id !== this.secret.botId || message.group_id || message.message_type !== 1) { this.state.rejected++; return null; }
    const messageId = message.message_id ?? message.msg_id;
    if (messageId === undefined || messageId === null || (typeof messageId === 'number' && !Number.isSafeInteger(messageId))) return null;
    const id = 'wx_' + hash(this.secret.botId + ':' + String(messageId)).slice(0, 48);
    const previous = this.state.requests.find(r => r.id === id); if (previous) return previous;
    const onlyText = message.item_list?.length && message.item_list.every(i => i.type === 1);
    const text = onlyText ? message.item_list.map(i => i.text_item?.text || '').join('\n').trim() : '';
    const request = { id, messageId: String(messageId), binding: hash(this.secret.ownerId), target: structuredClone(this.state.manager), text: text.slice(0, 6000), createdAt: now(), status: 'queued' };
    this.secret.contexts[id] = typeof message.context_token === 'string' ? message.context_token : '';
    this.state.requests.push(request); this.state.receivedAt = now();
    if (!onlyText || !text || text.length > 6000) {
      request.status = 'blocked'; request.error = '当前支持 1 至 6000 字的文字私聊，请把其他内容在网页处理。'; this.#reply(request, 'unsupported', request.error);
    } else if (this.state.requests.filter(r => r.status === 'queued').length > 100 && !['/状态', '/结果', '/暂停', '/停止', '/继续'].includes(text)) {
      request.status = 'blocked'; request.error = '待办消息已满，请稍后重试。'; this.#reply(request, 'queue-full', request.error);
    }
    this.#changed(); return request;
  }
  #reply(request, kind, text) {
    const chars = Array.from(text || '本次处理已结束，请在网页查看详情。');
    if (chars.length > 7200) chars.splice(7200, Infinity, ...Array.from('\n完整结果请在网页原任务查看。'));
    const parts = [];
    while (chars.length) parts.push(chars.splice(0, 1800).join(''));
    parts.forEach((part, index) => {
      const id = 'wxreply_' + hash(request.id + ':' + kind + ':' + index).slice(0, 44);
      if (!this.state.replies.some(r => r.id === id)) this.state.replies.push({ id, requestId: request.id, kind, part: index, text: part, status: 'pending', createdAt: now() });
    });
  }
  #result(request) {
    if (request.target.mode === 'desktop') {
      const message = this.desktop?.messages?.find(m => m.id === request.id);
      if (!message) return null;
      return { status: ({ error: 'failed', completed_empty: 'completed', received: 'running', submitted: 'running' })[message.status] || message.status, text: message.replyText, error: message.submissionError?.message || message.error?.message };
    }
    const run = request.runId && this.wb.state.runs[request.runId];
    return run ? { status: run.status, text: run.finalText, error: run.error?.message, run } : null;
  }
  #roots(runId, seen = new Set()) {
    if (!runId || seen.has(runId)) return new Set(); seen.add(runId);
    const run = this.wb.state.runs[runId];
    if (!run?.managerMessageIds?.length) return new Set([runId]);
    const roots = new Set();
    for (const id of run.managerMessageIds) {
      const message = this.wb.state.collaboration.messages[id], task = this.wb.state.collaboration.tasks[message?.taskId];
      for (const root of this.#roots(task?.origin?.runId, new Set(seen))) roots.add(root);
    }
    return roots;
  }
  #related(request, task) { return task.managerSessionId === request.target.sessionId && this.#roots(task.origin?.runId).has(request.runId); }
  #rememberResult(request, kind, text) {
    if (this.state.replies.some(r => r.requestId === request.id && r.kind === kind)) return;
    request.resultText = text; request.resultAt = now(); this.#reply(request, kind, text);
  }
  #followups(binding) {
    const requests = this.state.requests.filter(r => r.binding === binding && r.runId && r.target.mode === 'independent');
    for (const request of requests) {
      for (const task of Object.values(this.wb.state.collaboration.tasks).filter(t => this.#related(request, t))) {
        for (const message of Object.values(this.wb.state.collaboration.messages)) {
          if (message.taskId !== task.id || !['blocked', 'decision'].includes(message.kind) || !['unread', 'processing', 'handled'].includes(message.status)) continue;
          this.#rememberResult(request, 'team-message:' + message.id, `${task.title} · ${message.kind === 'decision' ? '需要你决定' : '遇到阻碍'}\n${message.summary}\n详情保留在网页同一任务中。`);
        }
        if (task.status === 'accepted' && task.review?.summary) this.#rememberResult(request, 'accepted:' + task.id + ':' + task.generation, `经理已验收｜${task.title}\n${task.review.summary}`);
      }
      for (const run of Object.values(this.wb.state.runs).filter(r => r.sessionId === request.target.sessionId && r.managerMessageIds?.length && ['completed', 'failed', 'waiting_approval'].includes(r.status))) {
        const roots = this.#roots(run.id); if (!roots.has(request.runId)) continue;
        const kind = 'manager-followup:' + run.id + ':' + run.status;
        // A manager inbox can batch unrelated web requests. Never copy a mixed
        // reply into a single WeChat request; per-task reports above stay scoped.
        if (run.status === 'waiting_approval') this.#rememberResult(request, kind, '这项任务的经理处理需要审批，请到网页审批页决定。');
        else if (roots.size === 1) this.#rememberResult(request, kind, run.finalText || (run.status === 'failed' ? '经理后续处理遇到阻碍，请到网页查看同一任务。' : '经理后续处理已结束，请到网页查看同一任务。'));
        else this.#rememberResult(request, kind, '你的任务有新的经理处理记录。该回合合并了多项工作，请到网页查看对应任务；本入口不转发其他任务的混合正文。');
      }
    }
  }
  async #command(request) {
    const command = request.text;
    if (!['/状态', '/结果', '/暂停', '/停止', '/继续'].includes(command)) return false;
    request.status = 'completed';
    let text;
    if (command === '/结果') {
      const previous = this.state.requests.filter(r => r.id !== request.id && r.binding === request.binding && r.resultText).sort((a, b) => String(b.resultAt || b.completedAt || '').localeCompare(String(a.resultAt || a.completedAt || '')))[0];
      text = previous?.resultText || '还没有完成结果。可以发送 /状态，或在网页查看原任务。';
    } else if (command === '/状态') text = `微信待办 ${this.state.requests.filter(r => r.binding === request.binding && r.status === 'queued').length} 条。${this.state.paused ? '微信队列已暂停。' : '微信队列可接收任务。'}结果和审批可在网页查看；/结果 查询最新结果，/暂停、/停止、/继续 管理本入口。`;
    else {
      this.state.paused = command !== '/继续';
      const active = this.state.requests.findLast(r => r.id !== request.id && r.binding === request.binding && r.status === 'running');
      if (command === '/停止') for (const item of this.state.requests) if (item.status === 'queued' && item.binding === request.binding) { item.status = 'cancelled'; this.#reply(item, 'cancelled', '已取消此条待办消息。'); }
      if (active?.runId && command !== '/继续' && ACTIVE.has(this.wb.state.runs[active.runId]?.status)) await this.wb.interrupt(active.runId, command === '/停止' ? 'stop' : 'pause');
      if (command !== '/继续') for (const task of Object.values(this.wb.state.collaboration.tasks)) {
        if (['accepted', 'cancelled'].includes(task.status)) continue;
        if (this.state.requests.some(r => r.binding === request.binding && r.runId && r.target.mode === 'independent' && this.#related(r, task))) await this.wb.collaboration.controlFromConsole(task.id, command === '/停止' ? 'cancel' : 'pause');
      }
      text = command === '/继续' ? '微信队列已恢复。已暂停或停止的原任务，请在网页确认后续办。' : `微信队列已${command === '/停止' ? '停止并取消待办' : '暂停'}。${request.target.mode === 'desktop' ? '桌面当前回合请在 Codex 中暂停或停止；本入口不会接管执行端。' : '本入口关联的独立任务已按原有暂停或停止规则处理。'}发送 /继续 恢复接收待办。`;
    }
    this.#reply(request, 'command', text); return true;
  }
  async tick() {
    if (this.working || this.closed || !this.state.enabled || !this.secret.token) return;
    this.working = true; const epoch = this.epoch, binding = hash(this.secret.ownerId), before = JSON.stringify(this.state);
    try {
      for (const request of this.state.requests.filter(r => r.binding === binding && r.status === 'running')) {
        const result = this.#result(request); if (!result) continue;
        if (result.status === 'waiting_approval') this.#reply(request, 'approval:' + (Object.values(this.wb.state.approvals).find(a => a.runId === request.runId && a.status === 'pending')?.id || 'pending'), '任务需要你决定，请打开公司网页的“审批”页。结果仍保留在同一任务中。');
        if (['completed', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(result.status)) {
          if (['interrupted', 'cancelled'].includes(result.status)) this.state.paused = true;
          request.status = result.status; request.completedAt = now(); request.resultAt = request.completedAt;
          request.resultText = result.text || (result.status === 'completed' ? '经理本轮已结束，详细结果请在网页原任务查看。' : result.status === 'unknown' ? '执行提交结果待核实，请在网页检查；不会自动重派。' : '任务' + ({ failed: '遇到阻碍', interrupted: '已中断', cancelled: '已取消' })[result.status] + '，请在网页原任务查看。');
          this.#reply(request, 'result', request.resultText);
        }
      }
      this.#followups(binding);
      // Commands bypass a paused/busy task queue and never call a model.
      for (const request of this.state.requests.filter(r => r.binding === binding && r.status === 'queued' && r.text.startsWith('/'))) await this.#command(request);
      if (epoch !== this.epoch || this.closed || !this.state.enabled) return;
      const next = !this.state.paused && this.state.requests.find(r => r.binding === binding && r.status === 'queued');
      if (next && !this.state.requests.some(r => r.binding === binding && ['submitting', 'running', 'unknown'].includes(r.status))) {
        if (!this.#sameManager(next.target)) { next.error = '经理或运行模式已改变，请在网页核对原队列后重新连接。'; }
        else {
          const busy = next.target.mode === 'desktop' ? this.desktop.snapshot().busy || this.desktop.messages.some(m => ['submitting', 'submitted', 'received', 'unknown'].includes(m.status)) : Object.values(this.wb.state.runs).some(r => r.sessionId === next.target.sessionId && ACTIVE.has(r.status));
          if (!busy) {
            next.status = 'submitting'; next.error = null; this.#persist();
            try {
              const result = next.target.mode === 'desktop'
                ? await this.desktop.send({ requestId: next.id, text: next.text })
                : await this.wb.dispatch({ sessionId: next.target.sessionId, prompt: next.text, requestId: next.id, dispatcherLabel: '微信 · 本人' });
              if (next.target.mode === 'independent') next.runId = result.id;
              next.status = result.status === 'unknown' ? 'unknown' : 'running'; next.submittedAt = now();
              if (epoch !== this.epoch) { this.#persist(); return; }
            } catch (error) {
              if (epoch !== this.epoch) return;
              const runId = this.wb.state.consoleRequests?.[next.id]?.runId;
              if (runId) { next.runId = runId; next.status = 'running'; }
              else { next.status = error.status === 409 ? 'queued' : 'blocked'; next.error = error.status === 409 ? '经理暂忙，消息保留排队。' : '消息未能提交，请在网页核对后处理。'; if (next.status === 'blocked') this.#reply(next, 'blocked', next.error); }
            }
          }
        }
      }
      if (JSON.stringify(this.state) !== before) this.#persist();
      await this.#deliver(epoch, binding);
      if (JSON.stringify(this.state) !== before) this.emit('changed', { status: this.state.status });
    } finally { this.working = false; }
  }
  async #deliver(epoch, binding) {
    for (const reply of this.state.replies.filter(r => r.status === 'pending')) {
      if (epoch !== this.epoch || this.closed) return;
      const request = this.state.requests.find(r => r.id === reply.requestId);
      if (request?.binding !== binding) continue;
      const prior = this.state.replies.some(r => r.requestId === reply.requestId && r.kind === reply.kind && r.part < reply.part && r.status !== 'sent');
      if (prior) { reply.status = 'held'; reply.error = '前一段未确认送达，后续片段已保留。'; this.#persist(); continue; }
      const contextToken = this.secret.contexts?.[request.id];
      if (!contextToken) { reply.status = 'failed'; reply.error = '原来信缺少回传上下文，请在微信发送 /结果 获取。'; this.#persist(); continue; }
      reply.status = 'sending'; reply.attempts = 1; this.#persist();
      try {
        const result = await this.api.send(this.secret, { clientId: reply.id, contextToken, text: reply.text }, this.controller.signal);
        if (epoch !== this.epoch || this.closed) return;
        reply.status = 'sent'; reply.sentAt = now(); reply.serverMessageId = result.message_id || null; this.state.sentAt = reply.sentAt;
      } catch (error) {
        if (epoch !== this.epoch || this.closed) return;
        reply.status = error.uncertain ? 'unknown' : 'failed'; reply.error = this.#error(error);
        if (error.auth) { this.state.enabled = false; this.state.status = 'auth_expired'; this.state.lastError = reply.error; }
      }
      this.#persist();
      if (!this.state.enabled) return;
    }
  }
  #error(error) { return error instanceof WeixinError ? error.message : '微信连接暂不可用，请检查网络并重新连接。'; }
}
