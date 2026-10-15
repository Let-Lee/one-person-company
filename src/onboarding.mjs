import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkbenchError } from './workbench.mjs';

export const SETUP_STEPS = ['welcome', 'connection', 'manager', 'employees', 'skills', 'first-task', 'tour', 'done'];
const now = () => new Date().toISOString();
const check = (condition, text, status = 400) => { if (!condition) throw new WorkbenchError(status, text); };
const short = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Setup owns local workspace preferences only. No company directory, native chat storage or model demonstration. */
export class Onboarding {
  constructor({ workbench }) { this.wb = workbench; this.pending = new Set(); }
  get workspace() { return this.wb.state.workspace; }
  get setup() { return this.workspace.setup; }
  save() { this.wb.store.save(); this.wb.emit('event', { type: 'setup.changed', at: now() }); }
  get personal() { return this.workspace.mode === 'personal'; }

  snapshot() {
    const all = this.wb.listRoles();
    const manager = all.find((r) => r.key === this.setup.managerRoleKey);
    const session = manager && this.wb.collaboration.sessionFor(manager.key);
    const employees = manager ? all.filter((r) => r.collaboration?.namespace === manager.collaboration?.namespace && r.collaboration?.authority === 'employee') : [];
    const row = (role) => {
      const stable = this.wb.collaboration.sessionFor(role.key);
      const pending = !stable?.threadId && Object.entries(this.setup.employeeRequests || {}).find(([, request]) => request.roleKey === role.key);
      return { key: role.key, name: role.name, title: role.roleTitle, description: role.description, appearance: role.appearance,
        roleSaved: true, sessionCreated: Boolean(stable?.threadId), sessionId: stable?.id || null,
        retryRequest: pending?.[1]?.payload ? { requestId: pending[0], ...pending[1].payload } : null,
        skillsSaved: (role.skills || []).map((s) => ({ name: s.name, path: s.path })), skillActivation: 'verify_on_next_run' };
    };
    return { mode: this.workspace.mode, name: this.workspace.name, ownerName: this.workspace.ownerName,
      required: this.personal && !this.setup.completed, steps: SETUP_STEPS, step: this.setup.step,
      completed: this.setup.completed, drafts: this.setup.drafts || {}, environment: this.setup.environment || null,
      manager: manager ? row(manager) : null, managerSessionId: session?.id || null,
      employees: employees.map(row), managerChoices: all.filter((r) => r.source === 'local' && r.collaboration?.authority === 'manager' &&
        this.wb.collaboration.sessionFor(r.key)).map(row),
      roleCount: all.length, createdRoleKeys: this.setup.createdRoleKeys || [],
      workspacePath: manager ? this.wb.collaboration.workspace(manager) : this.setup.workspacePath || '',
      firstRun: this.setup.firstRunId ? this.wb.listRuns().find((r) => r.id === this.setup.firstRunId) || null : null,
      lastError: this.setup.lastError || null, nativeCompanyEnabled: this.wb.company.enabled,
      executionMode: this.workspace.executionMode || 'independent', desktopConnection: this.wb.desktopManager?.snapshot() ? { configured: this.wb.desktopManager.snapshot().configured, target: this.wb.desktopManager.snapshot().target } : null,
      managerEntry: this.workspace.executionMode === 'desktop' ? '#/manager' : session ? '#/chat/' + session.id : this.wb.company.enabled ? '#/manager' : '#/guide',
      modelTurnsStartedByGuide: 0 };
  }

  draft(body) {
    check(Object.keys(body).every((k) => ['step', 'name', 'ownerName', 'drafts'].includes(k)), '不接受额外设置');
    if (body.step !== undefined) {
      check(SETUP_STEPS.includes(body.step), '引导步骤无效');
      if (this.personal && !this.setup.completed) {
        const index = SETUP_STEPS.indexOf(body.step), state = this.snapshot();
        if (index >= 2) check(this.setup.environment?.connected && this.setup.environment.authentication !== 'login_required', '请先完成 Codex 连接与登录检查', 409);
        if (index >= 3) check(state.manager?.sessionCreated, '请先建立总经理会话', 409);
        if (index >= 4) check(state.employees.some((employee) => employee.sessionCreated), '请先建立第一位员工会话', 409);
        check(body.step !== 'done', '请完成引导后进入公司', 409);
      }
      this.setup.step = body.step;
    }
    if (body.name !== undefined) { check(short(body.name, 40), '请填写公司名称'); this.workspace.name = short(body.name, 40); }
    if (body.ownerName !== undefined) this.workspace.ownerName = short(body.ownerName, 40);
    if (body.drafts !== undefined) {
      check(body.drafts && typeof body.drafts === 'object' && !Array.isArray(body.drafts), '引导草稿无效');
      const allowed = ['workspaceName', 'ownerName', 'managerName', 'managerDescription', 'employeeName', 'employeeTitle', 'employeeDescription', 'firstPrompt', 'workspacePath'];
      for (const [key, value] of Object.entries(body.drafts)) {
        check(allowed.includes(key) && typeof value === 'string' && value.length <= 6000, '引导草稿字段无效');
        this.setup.drafts[key] = value;
      }
    }
    this.save(); return this.snapshot();
  }

  async checkEnvironment() {
    const result = { checkedAt: now(), connected: false, authentication: 'unknown', message: '' };
    try {
      const runtime = this.wb.runtime;
      if (runtime.codexBin && path.isAbsolute(runtime.codexBin)) fs.accessSync(runtime.codexBin, fs.constants.X_OK);
      await runtime.ensureStarted();
      result.connected = runtime.snapshot().status === 'ready';
      try {
        const account = await runtime.request('account/read', { refreshToken: false }, { timeoutMs: 6000 });
        result.authentication = account.account ? 'configured' : account.requiresOpenaiAuth === false ? 'not_required' : account.requiresOpenaiAuth === true ? 'login_required' : 'unknown';
      } catch { /* connection proof does not fabricate authentication proof */ }
      result.message = result.authentication === 'login_required' ? '已连接 Codex，请先在 Codex 完成登录后再检查。' :
        result.authentication === 'unknown' ? '已连接 Codex，当前版本未提供登录状态；创建会话时会核对实际结果。' : '已连接 Codex，可继续建立自己的岗位。';
    } catch {
      result.message = '暂未连接 Codex。请先安装并打开 Codex、完成登录，再点“重新检查”。';
    }
    this.setup.environment = result; this.setup.lastError = null; this.save(); return this.snapshot();
  }

  async #lock(key, fn) {
    check(!this.pending.has(key), '该步骤正在处理，请稍候', 409);
    this.pending.add(key);
    try { this.setup.lastError = null; return await fn(); }
    catch (error) { this.setup.lastError = error.message; this.save(); throw error; }
    finally { this.pending.delete(key); }
  }

  async createManager(body) {
    check(this.personal, '已有公司保持原绑定，可查看使用说明', 409);
    return this.#lock('manager', async () => {
      check(this.setup.environment?.connected && this.setup.environment.authentication !== 'login_required', '请先完成 Codex 连接与登录检查', 409);
      const name = short(body.name, 24), description = short(body.description, 4000);
      check(name && description, '请填写经理名称与职责');
      let role = this.setup.managerRoleKey && this.wb.listRoles().find((r) => r.key === this.setup.managerRoleKey);
      if (!role) {
        this.setup.namespace ||= 'team-' + crypto.randomUUID().slice(0, 12);
        if (body.workspacePath) {
          check(typeof body.workspacePath === 'string' && path.isAbsolute(body.workspacePath), '请填写已有文件夹的完整路径');
          const cwd = fs.realpathSync(body.workspacePath);
          check(fs.statSync(cwd).isDirectory(), '请选择已有文件夹');
          check(!fs.existsSync(path.join(cwd, 'AGENTS.md')) || fs.statSync(path.join(cwd, 'AGENTS.md')).isFile(), '该工作区规则文件无效');
          this.setup.workspacePath = cwd;
          if (!this.wb.paths.allowedRoots.includes(cwd)) this.wb.paths.allowedRoots.push(cwd);
        }
        role = this.wb.saveLocalRole({ name, title: '总经理', description: description.slice(0, 400),
          instructions: description, palette: 'deep-tide', emblem: 'briefcase',
          collaboration: { namespace: this.setup.namespace, authority: 'manager' } });
        this.setup.managerRoleKey = role.key; this.setup.createdRoleKeys.push(role.key); this.save();
      }
      if (!this.wb.collaboration.sessionFor(role.key)) await this.wb.createSession({ roleKey: role.key, title: role.roleTitle + ' · ' + role.name });
      this.setup.step = 'employees'; this.save(); return this.snapshot();
    });
  }

  bindManager({ roleKey }) {
    check(this.personal, '当前公司经理绑定保持不变', 409);
    const role = this.wb.getRole(roleKey);
    check(role.source === 'local' && role.collaboration?.authority === 'manager' && this.wb.collaboration.sessionFor(role.key), '只能绑定本公司已建立会话的总经理');
    check(!this.setup.createdRoleKeys.length || this.setup.managerRoleKey === role.key, '本引导已建立岗位，请沿用当前经理', 409);
    this.setup.managerRoleKey = role.key; this.setup.namespace = role.collaboration.namespace;
    this.setup.step = 'employees'; this.save(); return this.snapshot();
  }

  async createEmployee(body) {
    check(this.personal, '请在现有岗位入口管理员工', 409);
    return this.#lock('employee', async () => {
      const manager = this.wb.getRole(this.setup.managerRoleKey);
      check(this.wb.collaboration.sessionFor(manager.key), '请先实际建立经理会话', 409);
      check(/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId || ''), '缺少稳定的创建请求编号');
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ name: body.name, title: body.title, description: body.description })).digest('hex');
      const previous = this.setup.employeeRequests[body.requestId];
      check(!previous || previous.hash === requestHash, '同一请求的岗位内容不能改变', 409);
      let role = previous && this.wb.getRole(previous.roleKey);
      if (!role) {
        const description = short(body.description, 4000);
        check(short(body.name, 24) && short(body.title, 40) && description, '请填写岗位、姓名与经理规定的职责');
        role = this.wb.saveLocalRole({ name: short(body.name, 24), title: short(body.title, 40), description: description.slice(0, 400),
          instructions: description, emblem: body.emblem || 'code', palette: body.palette || 'arctic-blue',
          collaboration: { namespace: manager.collaboration.namespace, authority: 'employee' } });
        this.setup.employeeRequests[body.requestId] = { hash: requestHash, roleKey: role.key, payload: { name: body.name, title: body.title, description: body.description } };
        this.setup.createdRoleKeys.push(role.key); this.save();
      }
      if (!this.wb.collaboration.sessionFor(role.key)) await this.wb.createSession({ roleKey: role.key, title: role.roleTitle + ' · ' + role.name });
      this.setup.step = 'skills'; this.save(); return this.snapshot();
    });
  }

  async saveSkills({ roleKey, skills }) {
    const role = this.wb.getRole(roleKey);
    check(this.personal && role.source === 'local' && role.collaboration?.namespace === this.setup.namespace, '请配置当前团队的岗位');
    await this.wb.configureRole(roleKey, { skills });
    this.save(); return this.snapshot();
  }

  async firstTask({ requestId, prompt }) {
    const manager = this.setup.managerRoleKey && this.wb.getRole(this.setup.managerRoleKey);
    check(this.personal && manager && this.wb.collaboration.sessionFor(manager.key), '请先建立自己的总经理', 409);
    check(short(prompt, 6000), '请写下实际目标、工作范围和验收要求');
    const run = await this.wb.dispatch({ sessionId: this.wb.collaboration.sessionFor(manager.key).id, prompt, requestId });
    this.setup.firstRunId = run.id; this.setup.step = 'tour'; this.save(); return { ...this.snapshot(), run };
  }

  async useDesktop() {
    const connection = await this.wb.desktopManager?.readStatus();
    check(connection?.ready, '先连接一个已在 Codex 桌面打开的聊天', 409);
    this.workspace.executionMode = 'desktop';
    this.setup.completed = true; this.setup.step = 'done'; this.setup.completedAt = now(); this.save();
    return this.snapshot();
  }

  useIndependent() {
    const state = this.snapshot();
    this.workspace.executionMode = 'independent';
    const ready = Boolean(state.manager?.sessionCreated && state.employees.some((role) => role.sessionCreated));
    this.setup.completed = ready; this.setup.step = ready ? 'done' : 'connection';
    this.save(); return this.snapshot();
  }

  finish() {
    if (this.personal && this.workspace.executionMode !== 'desktop') {
      const state = this.snapshot();
      check(state.manager?.sessionCreated, '经理会话尚未实际建立', 409);
      check(state.employees.some((e) => e.sessionCreated), '请至少实际建立一位员工会话', 409);
    }
    this.setup.completed = true; this.setup.step = 'done'; this.setup.completedAt = now(); this.save(); return this.snapshot();
  }
}
