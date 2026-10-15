import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const active = (run) => run && ['starting', 'running', 'waiting_approval'].includes(run.status);
const closed = (task) => ['accepted', 'cancelled'].includes(task.status);
const fenced = (task) => closed(task) || ['paused', 'interrupted'].includes(task.status);
const within = (dir, file) => file === dir || file.startsWith(`${dir}${path.sep}`);

export class CollaborationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const check = (condition, message, status = 403) => { if (!condition) throw new CollaborationError(status, message); };
const text = (value, field, max = 6000) => {
  check(typeof value === 'string' && value.trim().length && value.length <= max, `${field} 缺失或过长`, 400);
  return value.trim();
};
const stringProp = (description) => ({ type: 'string', description });
const listProp = (description) => ({ type: 'array', items: { type: 'string' }, description });
const tool = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const REQUEST = stringProp('稳定操作编号。重试原操作时沿用原编号，发送结果未知时先查询收件箱或任务，不要改编号重发。');
const nullableString = (description) => ({ type: ['string', 'null'], description });
const PAGE_LIMIT = { type: ['integer', 'null'], minimum: 1, maximum: 20, description: '每页条数，默认10，最多20；只读取当前需要的页。' };

/** Durable, isolated workbench collaboration. Authority comes from the RPC connection and
 * immutable session binding, never from tool arguments, a name, or a console label. */
export class Collaboration {
  constructor({ store, paths, getRole, getSession, enqueue, changed, interrupt }) {
    Object.assign(this, { store, paths, getRole, getSession, enqueue, changed, interrupt });
    this.recover();
  }
  get state() { return this.store.state; }
  get data() { return this.state.collaboration; }

  configureRole(role, input) {
    const previous = this.state.roles[role.key]?.collaboration || null;
    if (!input) { role.collaboration = previous; return; }
    const namespace = text(input.namespace, '测试组', 40);
    const personal = /^team-[a-z0-9][a-z0-9-]{0,31}$/.test(namespace) && this.state.workspace?.mode === 'personal' && this.state.workspace?.setup?.namespace === namespace;
    check(/^test-[a-z0-9][a-z0-9-]{0,31}$/.test(namespace) || personal, '使用本工作台引导建立的团队，或 test- 开头的隔离测试组', 400);
    check(['manager', 'employee'].includes(input.authority), '协作身份必须是总经理或员工', 400);
    const config = { namespace, authority: input.authority, version: 1 };
    const bound = Object.values(this.state.sessions).some((s) => s.roleKey === role.key && s.collaboration);
    check(!bound || fingerprint(previous) === fingerprint(config), '已有协作会话的身份绑定不可更改，请新建岗位', 409);
    let group = this.data.groups[namespace];
    if (!group) {
      check(config.authority === 'manager', '先为测试组创建总经理', 400);
      const cwd = personal && this.state.workspace.setup.workspacePath || path.join(this.paths.workspacesRoot, namespace);
      fs.mkdirSync(cwd, { recursive: true });
      check((personal ? this.paths.allowedRoots : [this.paths.workspacesRoot]).some((root) => within(root, fs.realpathSync(cwd))), '团队工作区越界');
      const agents = path.join(cwd, 'AGENTS.md');
      const hasAgents = fs.existsSync(agents);
      if (!hasAgents) fs.writeFileSync(agents, `# ${namespace} 独立协作测试区\n\n用户已授权此测试组总经理通过工作台内部工具派单给本组员工，员工可在已分配任务允许的范围内协作并主动回报。身份与范围以工具宿主提供的实际会话绑定为准。只在本目录内修改测试文件，不读取公司业务、不接生产、不调用其他正式岗位或子agent。调度和回报必须使用 yewang 内部工具；不要用 shell 或 HTTP 绕过内部权限。未实际执行的动作不声称完成。\n`);
      if (personal && !hasAgents) fs.writeFileSync(agents, `# ${namespace} 工作区\n\n这是用户通过工作台引导建立的团队。只有本组总经理可通过内部工具向本组员工派单，员工按已分配任务执行并主动回报。同项目写入串行；协作身份由宿主实际会话绑定提供，不信任参数自填身份。不调度其他工作台、原生公司岗位或子agent，不用 shell 或 HTTP 绕过内部权限。仅在本工作区执行任务；未实际执行不声称完成。\n`);
      group = this.data.groups[namespace] = { namespace, cwd: fs.realpathSync(cwd), managerRoleKey: role.key, mode: personal ? 'personal' : 'test', createdAt: now() };
    }
    if (config.authority === 'manager') check(group.managerRoleKey === role.key, '同一测试组只能有一位总经理', 409);
    role.collaboration = config;
  }

  workspace(role) { return role.collaboration ? this.data.groups[role.collaboration.namespace]?.cwd : null; }
  sessionFor(roleKey) { return Object.values(this.state.sessions).find((s) => s.roleKey === roleKey && s.collaboration && !s.archived); }

  validateSession(role, cwd, settings) {
    if (!role.collaboration) return;
    check(!this.sessionFor(role.key), '协作岗位已有稳定会话，请沿用该会话', 409);
    check(cwd === this.workspace(role), '协作岗位仅可在所属测试组工作区运行');
    check(['workspace-write', 'read-only'].includes(settings.sandbox), '协作测试会话需使用工作区沙箱');
  }

  instructions(role) {
    if (!role.collaboration) return '';
    const { namespace, authority } = role.collaboration;
    return [
      `身份由宿主绑定：${namespace} ${authority === 'manager' ? '总经理' : '员工'}。只操作本工作区，不调度其他工作台、正式公司岗位或子agent，不用HTTP绕过内部权限。来源无需自填。`,
      '首次派单用 yewang_team 取本组岗位；员工当前任务也由它提供。同项目写入串行。',
      authority === 'manager'
        ? 'yewang_dispatch 派单成功后立即结束本轮，不等待、轮询或代员工执行。关键回报会事件唤醒；用 yewang_inbox 仅取本轮未处理消息或指定任务，实际读文件后 yewang_review 验收或修正，再向本人简报；空确认不互回。'
        : '实际执行已分配任务，完成必须 yewang_report(completed) 回报实际文件；真实阻碍用blocked，需决定用decision。仅与任务允许人员协作。进度不唤醒经理。',
      '未实际执行不称完成。只有终端、文件和内部工具可用；桌面图像、电脑控制、微信及原生聊天未接入。',
    ].join('\n');
  }

  tools(role) {
    if (!role.collaboration) return [];
    const base = [tool('yewang_team', '读取本测试组真实岗位、会话准备状态、职责和当前已分配任务。', {})];
    if (role.collaboration.authority === 'manager') return [...base,
      tool('yewang_dispatch', '派单给本组已经建立稳定会话的员工。提交不等于完成；成功后结束本轮，回报由收件箱事件唤醒。', { requestId: REQUEST, toRole: stringProp('员工真实岗位 key，来自 yewang_team。'), title: stringProp('任务名称'), prompt: stringProp('目标、允许修改的文件和验收要求。'), collaborators: listProp('经理明确允许在此任务内协作的其他员工 key；通常为空数组。') }),
      tool('yewang_inbox', '按未处理消息或指定任务分页读取。默认只返回当前唤醒批次或未处理关键回报；不返回全组历史或全部操作凭据。', { taskId: nullableString('指定本组任务 ID；不指定填null。'), messageIds: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20, description: '本轮待处理消息ID；默认从宿主唤醒批次读取，不指定填null。' }, cursor: nullableString('上页返回的游标；第一页填null。'), limit: PAGE_LIMIT }, []),
      tool('yewang_review', '实际核验员工文件后验收，或要求修正。验收需本轮有真实核验命令且产物指纹未变。', { requestId: REQUEST, taskId: stringProp('任务 ID'), decision: { type: 'string', enum: ['accept', 'revise'] }, summary: stringProp('核验结论或具体修正要求。') }),
      tool('yewang_task_control', '暂停、取消或明确恢复本测试组任务。暂停和取消会阻止旧事件自动续办。', { requestId: REQUEST, taskId: stringProp('任务 ID'), action: { type: 'string', enum: ['pause', 'cancel', 'resume'] } }),
    ];
    return [...base,
      tool('yewang_report', '对当前已分配任务主动回报。completed 会核对实际文件与运行动作，随后等本轮结束才投递经理；blocked/decision 唤醒经理，progress 不唤醒。', { requestId: REQUEST, taskId: stringProp('当前任务 ID'), kind: { type: 'string', enum: ['completed', 'blocked', 'decision', 'progress'] }, summary: stringProp('实际结果、阻碍或需要经理决定的内容。'), artifacts: listProp('实际文件路径，相对当前工作目录；没有文件时用空数组。') }),
      tool('yewang_collaborate', '仅在经理已允许的同一任务参与者之间传递必要协作消息，不创建新任务或扩大范围。', { requestId: REQUEST, taskId: stringProp('当前任务 ID'), toRole: stringProp('被允许的员工 key'), message: stringProp('同一任务的具体信息或协作请求。') }),
    ];
  }

  handle(message, sourceRuntime, expectedRuntime) {
    const p = message.params || {};
    const sessions = Object.values(this.state.sessions).filter((s) => s.threadId === p.threadId && s.collaboration && !s.archived);
    check(sessions.length === 1 && sourceRuntime === expectedRuntime, '内部工具请求未来自工作台持有的唯一协作会话');
    const session = sessions[0];
    const role = this.getRole(session.roleKey);
    check(fingerprint(role.collaboration) === fingerprint(session.collaboration), '协作岗位绑定已改变，拒绝旧会话');
    check(p.namespace == null && typeof p.callId === 'string' && typeof p.turnId === 'string', '内部工具原生调用来源不完整');
    const spec = this.tools(role).find((s) => s.name === p.tool);
    check(spec, `该岗位无权调用 ${p.tool}`);
    const args = p.arguments;
    check(args && typeof args === 'object' && !Array.isArray(args), '工具参数格式错误', 400);
    check(Object.keys(args).every((key) => Object.hasOwn(spec.inputSchema.properties, key)), '拒绝未定义参数或自填来源身份', 400);
    for (const key of spec.inputSchema.required) check(Object.hasOwn(args, key), `工具参数缺少 ${key}`, 400);
    const callKey = fingerprint({ threadId: p.threadId, turnId: p.turnId, callId: p.callId });
    const callHash = fingerprint({ tool: p.tool, args });
    const oldCall = this.data.calls[callKey];
    if (oldCall) {
      check(oldCall.hash === callHash, '同一原生调用 ID 的参数不一致', 409);
      return oldCall.response;
    }
    const run = session.activeRunId && this.state.runs[session.activeRunId];
    check(active(run) && !run.stopRequested && run.turnId === p.turnId, '该来源回合未运行、已停止或属于旧事件');
    const origin = { kind: 'app-server', roleKey: role.key, sessionId: session.id, threadId: p.threadId, turnId: p.turnId, callId: p.callId, runId: run.id, receivedAt: now() };
    let result;
    let operationKey;
    if (args.requestId !== undefined) {
      text(args.requestId, '操作编号', 120);
      operationKey = fingerprint({ namespace: role.collaboration.namespace, roleKey: role.key, tool: p.tool, requestId: args.requestId });
      const previous = this.data.operations[operationKey];
      if (previous) {
        check(previous.hash === callHash, '重复操作编号的内容不同，请先查询旧操作', 409);
        result = { ...previous.result, replayed: true };
      }
    }
    if (!result) result = this.#execute(p.tool, args, { session, role, run, origin });
    const response = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    if (operationKey && !this.data.operations[operationKey]) this.data.operations[operationKey] = { hash: callHash, origin, tool: p.tool, requestId: args.requestId, result, committedAt: now() };
    this.data.calls[callKey] = { hash: callHash, origin, response };
    // The task, message, operation receipt and queued run are committed together before
    // the response is sent or any model turn starts. A retry reads this receipt.
    this.store.save();
    this.changed();
    return response;
  }

  #execute(name, args, context) {
    switch (name) {
      case 'yewang_team': return this.team(context.role, context.run);
      case 'yewang_inbox': return this.inbox(context.role, context.run, args);
      case 'yewang_dispatch': return this.#dispatch(args, context);
      case 'yewang_report': return this.#report(args, context);
      case 'yewang_collaborate': return this.#collaborate(args, context);
      case 'yewang_review': return this.#review(args, context);
      case 'yewang_task_control': return this.control(args.taskId, args.action, context);
      default: throw new CollaborationError(403, '内部工具未接入');
    }
  }

  team(role, run) {
    const namespace = role.collaboration.namespace;
    return {
      namespace, ownRoleKey: role.key, authority: role.collaboration.authority,
      roles: Object.values(this.state.roles).filter((r) => r.collaboration?.namespace === namespace).map((r) => ({ key: r.key, role: r.roleTitle, name: r.name, description: r.description, authority: r.collaboration.authority, sessionReady: Boolean(this.sessionFor(r.key)), skills: (this.state.roleConfigs[r.key]?.skills || []).map((s) => s.name) })),
      currentTask: run?.teamTaskId ? this.#taskSummary(this.data.tasks[run.teamTaskId]) : null,
      capabilities: { internalTools: this.tools(role).map((t) => t.name), terminal: 'Codex沙箱', files: '仅测试工作区', imageGeneration: '未接入', computerControl: '未接入', wechat: '未接入', nativeChats: '未接入' },
    };
  }

  #taskSummary(task) {
    return task ? { id: task.id, title: task.title, prompt: task.prompt, status: task.status, generation: task.generation, managerRoleKey: task.managerRoleKey, employeeRoleKey: task.employeeRoleKey, collaborators: task.collaborators, reportMessageId: task.reportMessageId, submittedAt: task.submittedAt, startedAt: task.startedAt, deliveredAt: task.deliveredAt, acceptedAt: task.acceptedAt, reviewSummary: task.review?.summary || null } : null;
  }

  #messageSummary(message) {
    return { id: message.id, taskId: message.taskId, kind: message.kind, fromRole: message.fromRole, status: message.status, summary: message.summary, artifacts: message.artifacts, runId: message.runId, deliveredAt: message.deliveredAt || null, createdAt: message.createdAt };
  }

  inbox(role, run, args = {}) {
    const namespace = role.collaboration.namespace;
    check(role.collaboration.authority === 'manager', '只有本组经理可读取经理收件箱');
    const limit = args.limit == null ? 10 : args.limit;
    check(Number.isInteger(limit) && limit >= 1 && limit <= 20, '收件箱每页条数必须在1到20之间', 400);
    const taskId = args.taskId == null ? null : text(args.taskId, '任务 ID', 80);
    if (taskId) check(this.data.tasks[taskId]?.managerRoleKey === role.key && this.data.tasks[taskId].namespace === namespace, '指定任务不属于该经理');
    const requestedIds = args.messageIds == null ? null : args.messageIds;
    check(!requestedIds || (Array.isArray(requestedIds) && requestedIds.length <= 20 && requestedIds.every((key) => typeof key === 'string')), '收件箱消息ID格式无效', 400);
    const messageIds = requestedIds || (!taskId && run?.managerMessageIds) || null;
    if (messageIds) check(messageIds.every((key) => this.data.messages[key]?.namespace === namespace && this.data.messages[key].toRole === role.key), '指定消息不属于该经理收件箱');
    const scope = fingerprint({ roleKey: role.key, taskId, messageIds });
    const after = this.#decodePageCursor(args.cursor, scope);
    let matches = Object.values(this.data.messages).filter((message) => message.namespace === namespace && message.toRole === role.key && ['completed', 'blocked', 'decision'].includes(message.kind) && (taskId ? message.taskId === taskId : messageIds ? messageIds.includes(message.id) : ['unread', 'processing'].includes(message.status)));
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (after) matches = matches.filter((message) => message.createdAt < after.createdAt || (message.createdAt === after.createdAt && message.id < after.id));
    const selected = []; let byteCount = 0;
    for (const message of matches) {
      const size = Buffer.byteLength(JSON.stringify(this.#messageSummary(message))) + Buffer.byteLength(JSON.stringify(this.#taskSummary(this.data.tasks[message.taskId])));
      if (selected.length && (selected.length >= limit || byteCount + size > 24_000)) break;
      selected.push(message); byteCount += size;
    }
    const last = selected.at(-1);
    if (run) run.inboxReadMessageIds = [...new Set([...(run.inboxReadMessageIds || []), ...selected.map((message) => message.id)])];
    return { namespace, ownRoleKey: role.key, tasks: [...new Set(selected.map((message) => message.taskId)), ...(taskId && !selected.length ? [taskId] : [])].map((key) => this.#taskSummary(this.data.tasks[key])), messages: selected.map((message) => this.#messageSummary(message)), nextCursor: last && matches.length > selected.length ? this.#encodePageCursor(scope, last) : null, note: '只返回本次需要的消息与对应任务；读取不等于验收，文件与权限仍由宿主核验。' };
  }

  #encodePageCursor(scope, item) { return Buffer.from(JSON.stringify({ scope, createdAt: item.createdAt, id: item.id })).toString('base64url'); }
  #decodePageCursor(cursor, scope) {
    if (cursor == null) return null;
    check(typeof cursor === 'string' && cursor.length <= 1000, '分页游标无效', 400);
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new CollaborationError(400, '分页游标无效'); }
    check(decoded.scope === scope && typeof decoded.createdAt === 'string' && typeof decoded.id === 'string', '分页游标不属于本次读取范围', 400);
    return decoded;
  }

  #employee(key, namespace) {
    const role = this.getRole(key);
    check(role.source === 'local' && role.collaboration?.namespace === namespace && role.collaboration.authority === 'employee', '仅可调度所属测试组员工');
    const session = this.sessionFor(key);
    check(session && !session.detached, '员工稳定会话尚未创建，请先在工作台建立会话', 409);
    return { role, session };
  }

  #dispatch(args, { role, origin }) {
    const namespace = role.collaboration.namespace;
    const target = this.#employee(text(args.toRole, '员工 key', 80), namespace);
    check(Array.isArray(args.collaborators) && args.collaborators.length <= 6, '协作名单格式错误', 400);
    const collaborators = [...new Set(args.collaborators)].filter((k) => k !== target.role.key);
    collaborators.forEach((key) => this.#employee(key, namespace));
    const title = text(args.title, '任务名称', 100);
    const prompt = text(args.prompt, '派单内容', 12000);
    const task = { id: id('teamtask'), namespace, managerRoleKey: role.key, employeeRoleKey: target.role.key, managerSessionId: origin.sessionId, employeeSessionId: target.session.id, title, prompt, collaborators, generation: 1, status: 'submitted', createdAt: now(), submittedAt: now(), startedAt: null, deliveredAt: null, acceptedAt: null, origin, runIds: [], reportMessageId: null };
    this.data.tasks[task.id] = task;
    const run = this.#enqueueTask(task, prompt);
    const message = this.#message({ task, kind: 'dispatch', fromRole: role.key, toRole: target.role.key, summary: prompt, origin, runId: run.id, status: 'submitted' });
    return { taskId: task.id, runId: run.id, messageId: message.id, status: 'submitted', note: '已持久提交；员工实际开工、交付和验收分别记录。请结束本轮，关键回报会事件唤醒。' };
  }

  #enqueueTask(task, prompt, roleKey = task.employeeRoleKey, extra = {}) {
    const session = this.sessionFor(roleKey);
    check(session && !session.archived, '目标协作会话不可用', 409);
    const body = `工作台可信任务 ${task.id}（第 ${task.generation} 次执行）\n任务：${task.title}\n经理已授权的协作岗位：${task.collaborators.join('、') || '无'}\n执行范围：仅当前测试工作区。\n\n${prompt}\n\n实际执行后，必须使用 yewang_report 回报本任务。`;
    const run = this.enqueue({ sessionId: session.id, prompt: body, kind: 'team', teamTaskId: task.id, teamGeneration: task.generation, dispatcher: { kind: 'workbench-team', roleKey: task.managerRoleKey, label: this.getRole(task.managerRoleKey).roleTitle, taskId: task.id }, ...extra });
    task.runIds.push(run.id);
    return run;
  }

  #message({ task, kind, fromRole, toRole, summary, origin, runId, status = 'staged', artifacts = [], ...extra }) {
    const message = { id: id('msg'), namespace: task.namespace, taskId: task.id, generation: task.generation, kind, fromRole, toRole, summary, artifacts, origin, runId, status, createdAt: now(), ...extra };
    this.data.messages[message.id] = message;
    return message;
  }

  #currentTask(args, { role, run }) {
    const task = this.data.tasks[text(args.taskId, '任务 ID', 80)];
    check(task && task.namespace === role.collaboration.namespace, '任务不属于该测试组');
    check(run.teamTaskId === task.id && run.teamGeneration === task.generation && !fenced(task), '任务未分配给当前回合，已暂停或属于旧任务事件');
    check([task.employeeRoleKey, ...task.collaborators].includes(role.key), '该岗位未被经理分配到此任务');
    return task;
  }

  #artifacts(task, refs) {
    check(Array.isArray(refs) && refs.length <= 20, '产物路径格式错误', 400);
    const cwd = this.data.groups[task.namespace].cwd;
    return [...new Set(refs)].map((ref) => {
      text(ref, '产物路径', 500);
      let real;
      try { real = fs.realpathSync(path.resolve(cwd, ref)); } catch { throw new CollaborationError(400, `产物不存在：${ref}`); }
      check(within(cwd, real), '产物路径越界或符号链接指向外部');
      const stat = fs.statSync(real);
      check(stat.isFile() && stat.size <= 2_000_000, '只接收不超过 2 MB 的实际文件', 400);
      return { path: path.relative(cwd, real), size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'), verifiedAt: now() };
    });
  }

  #report(args, context) {
    const task = this.#currentTask(args, context);
    check(['completed', 'blocked', 'decision', 'progress'].includes(args.kind), '回报类型无效', 400);
    const summary = text(args.summary, '回报内容');
    const artifacts = this.#artifacts(task, args.artifacts);
    const messages = Object.values(this.data.messages).filter((m) => m.runId === context.run.id && ['completed', 'blocked', 'decision'].includes(m.kind));
    check(args.kind === 'progress' || !messages.length, '本回合已有关键回报，请查询原提交，不重复发送', 409);
    if (args.kind === 'completed') {
      check(artifacts.length > 0, '交付需提供真实文件产物；当前未提供文件', 400);
      check(context.run.items.some((i) => (i.type === 'commandExecution' && i.exitCode === 0) || (i.type === 'fileChange' && i.status === 'completed')), '尚未观察到实际执行动作，不能仅凭完成声明交付', 409);
    }
    const message = this.#message({ task, kind: args.kind, fromRole: context.role.key, toRole: task.managerRoleKey, summary, artifacts, origin: context.origin, runId: context.run.id, status: args.kind === 'progress' ? 'recorded' : 'staged' });
    return { messageId: message.id, taskId: task.id, status: message.status, note: args.kind === 'progress' ? '进度已记录，不唤醒经理。' : '关键回报已持久保存；本轮结束后送入经理收件箱，不把提交当作已验收。' };
  }

  #collaborate(args, context) {
    const task = this.#currentTask(args, context);
    const participants = [task.employeeRoleKey, ...task.collaborators];
    check(args.toRole !== context.role.key && participants.includes(args.toRole), '仅可联系经理明确允许的当前任务参与者');
    const target = this.#employee(args.toRole, task.namespace);
    const summary = text(args.message, '协作内容', 4000);
    check(!Object.values(this.state.runs).some((r) => r.sessionId === target.session.id && (active(r) || r.status === 'queued')), '协作岗位正在处理任务，先保留当前结果，不重复开工', 409);
    const run = this.#enqueueTask(task, `任务内协作消息，来自 ${context.role.key}：\n${summary}\n原任务范围：${task.prompt}`, args.toRole);
    const message = this.#message({ task, kind: 'collaboration', fromRole: context.role.key, toRole: args.toRole, summary, origin: context.origin, runId: run.id, status: 'submitted' });
    return { messageId: message.id, runId: run.id, taskId: task.id, status: 'submitted' };
  }

  #review(args, context) {
    const task = this.data.tasks[text(args.taskId, '任务 ID', 80)];
    check(task && task.managerRoleKey === context.role.key, '只能验收本测试组总经理派发的任务');
    const summary = text(args.summary, '验收结论');
    check(['accept', 'revise'].includes(args.decision), '验收决定无效', 400);
    check(!fenced(task), '任务已暂停、取消或验收，旧回报不能恢复它', 409);
    if (args.decision === 'accept') {
      const report = this.data.messages[task.reportMessageId];
      check(task.status === 'delivered' && report?.kind === 'completed', '任务尚未实际交付，不能验收', 409);
      const artifacts = this.#artifacts(task, report.artifacts.map((a) => a.path));
      check(artifacts.every((a, i) => a.sha256 === report.artifacts[i].sha256), '交付文件已变化，请重新核对并要求修正', 409);
      check(context.run.items.some((i) => i.type === 'commandExecution' && i.exitCode === 0), '请先实际读取并核验文件，再验收', 409);
      Object.assign(task, { status: 'accepted', acceptedAt: now(), review: { summary, origin: context.origin, artifacts } });
    } else {
      check(!task.runIds.some((key) => active(this.state.runs[key]) || this.state.runs[key]?.status === 'queued'), '任务仍有运行，先暂停再处理', 409);
      task.generation += 1;
      Object.assign(task, { status: 'submitted', deliveredAt: null, reportMessageId: null, review: { summary, origin: context.origin } });
      this.#enqueueTask(task, `修正要求：${summary}\n原任务：${task.prompt}`);
    }
    for (const message of Object.values(this.data.messages)) {
      if (message.taskId === task.id && message.toRole === context.role.key && ['unread', 'processing'].includes(message.status)) Object.assign(message, { status: 'handled', handledAt: now(), handledByRunId: context.run.id });
    }
    const message = this.#message({ task, kind: args.decision === 'accept' ? 'acceptance' : 'revision', fromRole: context.role.key, toRole: task.employeeRoleKey, summary, origin: context.origin, runId: context.run.id, status: 'recorded' });
    return { taskId: task.id, status: task.status, messageId: message.id };
  }

  async controlFromConsole(taskId, action) {
    const result = this.control(taskId, action, null);
    this.store.save(); this.changed();
    await this.interruptPending();
    return result;
  }

  control(taskId, action, context) {
    const task = this.data.tasks[text(taskId, '任务 ID', 80)];
    check(task, '内部任务不存在', 404);
    if (context) check(context.role.key === task.managerRoleKey, '只能控制自己派发的测试任务');
    check(['pause', 'cancel', 'resume'].includes(action), '任务控制无效', 400);
    check(!closed(task), '任务已取消或验收，需本人新任务授权', 409);
    if (action === 'resume') {
      check(['paused', 'interrupted', 'blocked', 'needs_decision'].includes(task.status), '该任务没有暂停或阻碍', 409);
      check(!task.runIds.some((key) => active(this.state.runs[key]) || this.state.runs[key]?.status === 'queued'), '旧运行尚未退出，稍后明确恢复', 409);
      task.generation += 1;
      Object.assign(task, { status: 'submitted', reportMessageId: null, deliveredAt: null });
      this.#enqueueTask(task, `本人或本组经理已明确恢复任务；先检查实际目录，从中断处继续，不重复已有成果。\n${task.prompt}`);
    } else {
      task.generation += 1;
      task.status = action === 'pause' ? 'paused' : 'cancelled';
      task.controlledAt = now();
      for (const runId of task.runIds) {
        const run = this.state.runs[runId];
        if (active(run) || run?.status === 'queued') run.teamInterruptPending = action === 'pause' ? 'pause' : 'stop';
      }
      for (const message of Object.values(this.data.messages)) if (message.taskId === task.id && ['staged', 'unread', 'processing'].includes(message.status)) message.status = 'held';
    }
    task.controlOrigin = context?.origin || { kind: 'console', at: now() };
    return { taskId: task.id, status: task.status, generation: task.generation };
  }

  async interruptPending() {
    for (const run of Object.values(this.state.runs)) {
      if (!run.teamInterruptPending) continue;
      const mode = run.teamInterruptPending;
      delete run.teamInterruptPending;
      if (active(run) || run.status === 'queued') await this.interrupt(run.id, mode, true).catch(() => {});
    }
    this.store.save();
  }

  runStarted(run) {
    const task = this.data.tasks[run.teamTaskId];
    if (active(run) && task && task.generation === run.teamGeneration && !fenced(task)) { task.status = 'running'; task.startedAt ||= now(); }
  }

  runStopped(run, mode) {
    const session = this.state.sessions[run.sessionId];
    if (session?.collaboration?.authority === 'manager') session.wakePaused = true;
    const task = this.data.tasks[run.teamTaskId];
    if (task && task.generation === run.teamGeneration && !fenced(task)) this.control(task.id, mode === 'stop' ? 'cancel' : 'pause', null);
  }

  runFinished(run) {
    if (run.managerMessageIds) {
      const successful = run.status === 'completed';
      let unhandled = false;
      for (const key of run.managerMessageIds) {
        const message = this.data.messages[key];
        if (message?.status !== 'processing') continue;
        const read = run.inboxReadMessageIds?.includes(message.id);
        const handled = successful && read && message.kind !== 'completed';
        Object.assign(message, { status: handled ? 'handled' : 'unread', handledByRunId: handled ? run.id : null, handledAt: handled ? now() : null });
        unhandled ||= !handled;
      }
      if (!successful || unhandled) this.state.sessions[run.sessionId].wakePaused = true;
    }
    const task = this.data.tasks[run.teamTaskId];
    if (!task || task.generation !== run.teamGeneration || fenced(task)) return;
    const reports = Object.values(this.data.messages).filter((m) => m.runId === run.id && m.status === 'staged');
    let report = reports.find((m) => ['completed', 'blocked', 'decision'].includes(m.kind));
    if (run.status !== 'completed' || !report) {
      if (report) report.status = 'held';
      report = this.#message({ task, kind: 'blocked', fromRole: run.roleKey, toRole: task.managerRoleKey, summary: run.status === 'completed' ? '运行已结束，但员工未提交可核对的内部回报，请检查工具是否实际可用。' : `运行${run.status}：${run.error?.message || '执行中断，需要明确恢复。'}`, origin: { kind: 'runtime-event', threadId: run.threadId, turnId: run.turnId, runId: run.id }, runId: run.id });
    }
    if (report.kind === 'completed') {
      try {
        const current = this.#artifacts(task, report.artifacts.map((a) => a.path));
        check(current.every((a, i) => a.sha256 === report.artifacts[i].sha256), '回报提交后文件已变化');
      } catch (error) { report.kind = 'blocked'; report.summary = `交付核验失败：${error.message}`; }
    }
    report.status = 'unread'; report.deliveredAt = now();
    if (run.roleKey === task.employeeRoleKey) {
      task.status = run.status === 'interrupted' ? 'interrupted' : { completed: 'delivered', blocked: 'blocked', decision: 'needs_decision' }[report.kind];
      task.reportMessageId = report.id;
      if (task.status === 'delivered') task.deliveredAt = now();
    }
  }

  flushInboxes() {
    let changed = false;
    for (const group of Object.values(this.data.groups)) {
      const session = this.sessionFor(group.managerRoleKey);
      if (!session || session.wakePaused || session.activeRunId || Object.values(this.state.runs).some((r) => r.sessionId === session.id && r.status === 'queued')) continue;
      const messages = Object.values(this.data.messages).filter((m) => m.toRole === group.managerRoleKey && m.status === 'unread' && m.kind !== 'progress' && !['paused', 'cancelled'].includes(this.data.tasks[m.taskId]?.status));
      if (!messages.length) continue;
      const priority = { blocked: 0, decision: 1, completed: 2 };
      messages.sort((a, b) => (priority[a.kind] ?? 3) - (priority[b.kind] ?? 3) || a.createdAt.localeCompare(b.createdAt));
      const batch = messages.slice(0, 20);
      const run = this.enqueue({ sessionId: session.id, kind: 'inbox', prompt: `收件箱有 ${batch.length} 条待处理关键回报，已绑定到本轮。调用 yewang_inbox 读取本轮消息及对应任务，先处理阻碍和需决定，再实际读取交付文件并用 yewang_review 验收；最后简短向本人汇总，不重复派单。`, managerMessageIds: batch.map((m) => m.id), dispatcher: { kind: 'inbox', label: '岗位收件箱' } });
      for (const message of batch) Object.assign(message, { status: 'processing', managerRunId: run.id, awakenedAt: now() });
      changed = true;
    }
    if (changed) { this.store.save(); this.changed(); }
  }

  resumeInbox(sessionId) {
    const session = this.getSession(sessionId);
    check(session.collaboration?.authority === 'manager', '此会话不是测试组总经理', 400);
    session.wakePaused = false;
    this.store.save(); this.flushInboxes();
    return { sessionId, wakePaused: false };
  }

  recover() {
    for (const run of Object.values(this.state.runs)) {
      if ((run.teamTaskId || run.managerMessageIds) && run.status === 'queued') Object.assign(run, { status: 'interrupted', stopMode: 'console_restart', completedAt: now() });
      if (run.managerMessageIds && run.status === 'interrupted') {
        const session = this.state.sessions[run.sessionId];
        if (session) session.wakePaused = true;
      }
    }
    for (const task of Object.values(this.data.tasks)) {
      if (['submitted', 'running'].includes(task.status) && !task.runIds.some((key) => active(this.state.runs[key]) || this.state.runs[key]?.status === 'queued')) { task.status = 'interrupted'; task.generation += 1; }
    }
    for (const message of Object.values(this.data.messages)) {
      if (message.status === 'processing') {
        const run = this.state.runs[message.managerRunId];
        if (run?.status !== 'completed') message.status = 'unread';
      }
      if (message.status === 'staged' && !active(this.state.runs[message.runId])) message.status = 'held';
    }
    this.store.save();
  }

  snapshot(namespace) {
    const filter = (item) => !namespace || item.namespace === namespace;
    return { groups: Object.values(this.data.groups).filter(filter), tasks: Object.values(this.data.tasks).filter(filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), messages: Object.values(this.data.messages).filter(filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), operationReceipts: Object.values(this.data.operations).filter((operation) => !namespace || this.state.roles[operation.origin.roleKey]?.collaboration?.namespace === namespace).map(({ requestId, tool, result, committedAt }) => ({ requestId, tool, result, committedAt })), capabilities: { mode: 'isolated-test', formalOrganizationChanged: false, internalTools: 'app-server dynamicTools', images: '未接入', computerControl: '未接入', wechat: '未接入' } };
  }

  page({ namespace, taskId, cursor, limit = 30 } = {}) {
    check(Number.isInteger(limit) && limit >= 1 && limit <= 50, '页面每页条数必须在1到50之间', 400);
    if (namespace) check(this.data.groups[namespace], '测试组不存在', 404);
    if (taskId) check(this.data.tasks[taskId] && (!namespace || this.data.tasks[taskId].namespace === namespace), '任务不属于该测试组', 403);
    const scope = fingerprint({ channel: 'console', namespace: namespace || null, taskId: taskId || null });
    const after = this.#decodePageCursor(cursor, scope);
    let tasks = Object.values(this.data.tasks).filter((task) => (!namespace || task.namespace === namespace) && (!taskId || task.id === taskId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (after) tasks = tasks.filter((task) => task.createdAt < after.createdAt || (task.createdAt === after.createdAt && task.id < after.id));
    const selected = tasks.slice(0, limit);
    const selectedIds = new Set(selected.map((task) => task.id));
    const last = selected.at(-1);
    return { groups: Object.values(this.data.groups).filter((group) => !namespace || group.namespace === namespace), tasks: selected, messages: Object.values(this.data.messages).filter((message) => selectedIds.has(message.taskId) && ['completed', 'blocked', 'decision', 'progress'].includes(message.kind)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100), nextCursor: last && tasks.length > selected.length ? this.#encodePageCursor(scope, last) : null, capabilities: { mode: 'isolated-test', formalOrganizationChanged: false, internalTools: 'app-server dynamicTools', images: '未接入', computerControl: '未接入', wechat: '未接入' }, counts: { tasks: Object.values(this.data.tasks).filter((task) => !namespace || task.namespace === namespace).length }, note: '有限分页；提交凭据保留在存储，页面不自动返回全部操作记录。' };
  }

  handoffs() {
    return Object.values(this.data.messages).map((m) => ({ id: m.id, channel: 'runner', kind: ['completed', 'blocked', 'decision', 'progress'].includes(m.kind) ? 'report' : m.kind, fromRole: m.fromRole, fromName: this.getRole(m.fromRole).name, toRole: m.toRole, toName: this.getRole(m.toRole).name, at: m.deliveredAt || m.createdAt, taskId: m.taskId, runId: m.runId, messageId: m.id, namespace: m.namespace, status: m.status, sourceThreadId: m.origin?.threadId, sourceTurnId: m.origin?.turnId }));
  }

  readArtifact(messageId, index) {
    const message = this.data.messages[messageId];
    check(message && Number.isInteger(index) && index >= 0 && message.artifacts[index], '回报产物不存在', 404);
    const task = this.data.tasks[message.taskId];
    check(task && task.namespace === message.namespace, '产物所属任务不一致');
    const artifact = message.artifacts[index];
    const verified = this.#artifacts(task, [artifact.path])[0];
    check(verified.sha256 === artifact.sha256, '文件已在回报后变化，不能显示为原交付结果', 409);
    const file = path.join(this.data.groups[task.namespace].cwd, verified.path);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); }
    catch { throw new CollaborationError(422, '当前只支持 UTF-8 文本产物预览'); }
    return { messageId, taskId: task.id, ...verified, content };
  }
}
