import { esc, clock, icon, ICONS, roleAvatar, roleLabel, roleStatus, status, timeAgo } from './lib.js';

export const NATIVE_PHASES = {
  submitted: ['派单已提交', 'queued'], received: ['员工已收到', 'queued'], executing: ['执行中', 'running'],
  report_submitted: ['回报已提交', 'queued'], reported: ['经理已收到回报', 'waiting'], manager_processing: ['经理处理中', 'running'], handled: ['经理已处理', 'done'],
  accepted: ['已验收', 'done'], turn_ended: ['本轮结束', 'neutral'], paused: ['已暂停', 'paused'], error: ['执行失败', 'error'],
};
const STAGES = [['dispatched', '派单'], ['received', '收到'], ['executed', '执行'], ['reportReceived', '回报'], ['handled', '处理'], ['accepted', '验收']];
const KIND = { dispatch: '经理派单', report: '员工回报', execution: '执行活动', handling: '经理处理', message: '沟通', management: '管理同步', collaboration: '任务协作' };
const eventLabel = (event) => event.kind === 'execution' ? event.nativeTurnStatus === 'inProgress' ? '执行中' : '本轮结束' :
  event.stage === 'submitted' ? '已提交' : event.stage === 'received' ? '真实收到' : event.stage === 'accepted' ? '已验收' : '已处理';
const roleOf = (roles, key) => roles.find((r) => r.key === key);
const href = (taskId, roleKey) => '#/team?' + new URLSearchParams({ ...(taskId ? { taskId } : {}), ...(roleKey ? { role: roleKey } : {}) });

export function nativePipeline(flow, { compact = false } = {}) {
  return '<ol class="native-pipeline ' + (compact ? 'is-compact' : '') + '" aria-label="实际任务进度">' +
    STAGES.map(([key, label]) => '<li class="' + (flow.stages[key] ? 'reached' : '') +
      (flow.isLive && key === 'executed' ? ' is-live' : '') + '" data-stage="' + key + '"><i aria-hidden="true"></i><span>' + label + '</span></li>').join('') + '</ol>';
}

function flowCard(flow, roles, selectedTask) {
  const role = roleOf(roles, flow.roleKey);
  const primary = flow.events.find((e) => e.kind === 'dispatch' && e.text);
  const label = NATIVE_PHASES[flow.phase] || [flow.phase, 'neutral'];
  return '<article class="native-flow card ' + (flow.isLive ? 'is-live' : '') + '" data-native-task="' + esc(flow.taskId) + '">' +
    '<header><a class="native-flow-who" href="' + href(null, flow.roleKey) + '">' + roleAvatar(role, { size: 42 }) +
    '<div>' + roleLabel(role, { project: false }) + '<span class="mono small muted">' + esc(flow.taskId) + '</span></div></a>' +
    '<span class="spacer"></span>' + status(label) + '</header>' + nativePipeline(flow) +
    '<div class="native-flow-body">' + (flow.progressText ? '<p class="native-progress">' + esc(flow.progressText) + '</p>' :
      '<p class="muted small">' + esc(primary?.text || '真实原生会话的协作记录') + '</p>') +
    (flow.decision ? '<div class="native-decision"><span class="small strong">' + (flow.stages.accepted ? '经理验收' : '经理处理') +
      '</span><p>' + esc(flow.decision.text) + '</p></div>' : '') + '</div>' +
    '<footer><span class="muted small">' + (flow.toolCount ? flow.toolCount + ' 次工具活动 · ' : '') + timeAgo(flow.at) + '</span>' +
    (flow.stages.reportSubmitted && !flow.stages.reportReceived ? '<span class="small muted">回报等待经理收信</span>' : '') +
    '<span class="spacer"></span><a class="btn btn-sm btn-ghost" href="' + (selectedTask ? href(null, flow.roleKey) : href(flow.taskId, flow.roleKey)) + '">' +
    (selectedTask ? '岗位全部记录' : '查看过程') + '</a></footer></article>';
}

export function nativeEventRow(event, roles) {
  const who = roleOf(roles, event.fromRole), to = roleOf(roles, event.toRole);
  return '<li class="native-event kind-' + esc(event.kind) + '" data-native-event="' + esc(event.id) + '">' +
    '<span class="native-event-time mono">' + clock(event.at) + '</span><i class="native-event-dot" aria-hidden="true"></i>' +
    '<div class="native-event-body"><header>' + roleAvatar(who, { size: 22 }) + roleLabel(who, { project: false, size: 'sm' }) +
    (event.fromRole !== event.toRole ? '<i class="connection-line" aria-hidden="true"></i>' + roleLabel(to, { project: false, size: 'sm' }) : '') +
    '<span class="native-event-kind">' + esc(KIND[event.kind] || '沟通') + ' · ' + eventLabel(event) + '</span></header>' +
    (event.kind === 'execution' ? '<p class="muted small">' + (event.toolCount ? event.toolCount + ' 次工具活动' : '已观察到原生回合') +
      (event.text ? ' · ' + esc(event.text) : '') + '</p>' : '<p>' + esc(event.text || '') + '</p>') +
    '<details class="native-evidence"><summary>来源凭据</summary><dl><dt>原生会话</dt><dd class="mono">' + esc(event.sourceThreadId) +
    '</dd>' + (event.turnId || event.sourceTurnId ? '<dt>实际回合</dt><dd class="mono">' + esc(event.turnId || event.sourceTurnId) + '</dd>' : '') +
    (event.inboundMessageId ? '<dt>入站消息</dt><dd class="mono">' + esc(event.inboundMessageId) + '</dd>' : '') +
    (event.evidence ? '<dt>凭据</dt><dd>' + esc(event.evidence) + '</dd>' : '') +
    (event.acceptanceEvidence ? '<dt>验收文件</dt><dd>' + esc(event.acceptanceEvidence) + '</dd>' : '') +
    '<dt>观察时间</dt><dd>' + clock(event.observedAt || event.at) + '</dd></dl></details></div></li>';
}

export function nativeTeamHtml(data, roles, { taskId = '', roleKey = '' } = {}) {
  const company = roles.filter((r) => r.source === 'company');
  const active = data.roles.filter((r) => r.busy);
  const selected = roleOf(roles, roleKey);
  const filters = new URLSearchParams();
  if (roleKey) filters.set('roleKey', roleKey);
  const allHref = href(null, roleKey);
  return '<div class="native-summary"><div class="native-signal ' + (data.ready ? 'is-connected' : '') + '"><span class="live-dot ' + (data.ready ? 'on' : '') +
    '"></span><span>桌面员工</span><strong>' + (data.counts.connected || 0) + ' / ' + (data.counts.total || 0) + '</strong><small>会话已连接</small></div>' +
    '<div><span>正在执行</span><strong class="tone-text-running">' + active.length + '</strong><small>实际桌面活动</small></div>' +
    '<div><span>等待经理处理</span><strong class="tone-text-waiting">' + (data.counts.awaitingHandling || 0) + '</strong><small>已收到的回报</small></div>' +
    '<div><span>已验收</span><strong class="tone-text-done">' + (data.counts.accepted || 0) + '</strong><small>经理凭据已核对</small></div></div>' +
    (!data.ready ? '<div class="notice">' + esc(data.lastError || '等待当前桌面会话连接，最近记录仍保留。') + '</div>' : '') +
    '<div class="native-roster" role="group" aria-label="岗位筛选"><a class="native-role-filter ' + (!roleKey ? 'active' : '') + '" href="#/team">全部岗位</a>' +
    company.map((role) => '<a class="native-role-filter ' + (role.key === roleKey ? 'active' : '') + '" href="' + href(null, role.key) + '">' +
      roleAvatar(role, { size: 30 }) + '<span>' + roleLabel(role, { project: false, size: 'stack' }) + '</span><i class="dot tone-' + roleStatus(role.liveState)[1] +
      '" aria-label="' + esc(roleStatus(role.liveState)[0]) + '"></i></a>').join('') + '</div>' +
    '<div class="native-section-head"><h2>' + (selected ? esc(selected.roleTitle) + '的任务' : '任务进程') + '</h2>' +
    '<form data-form="native-filter" class="native-task-filter"><label class="sr-only" for="native-task-filter">任务编号</label><input id="native-task-filter" name="taskId" placeholder="按任务编号筛选" pattern="T[0-9]{8}-[0-9]{3}" value="' + esc(taskId) +
    '"><button class="btn btn-sm">筛选</button>' + (taskId ? '<a class="btn btn-sm btn-ghost" href="' + allHref + '">全部任务</a>' : '') + '</form></div>' +
    '<div class="native-flow-grid">' + (data.flows.length ? data.flows.map((flow) => flowCard(flow, roles, taskId)).join('') :
      '<div class="card native-empty"><p class="muted">此范围内尚无可核对的协作记录。</p></div>') + '</div>' +
    '<section class="card native-timeline"><header class="native-section-head"><h2>沟通与执行</h2><span class="muted small">最新实际事件</span></header>' +
    '<ol>' + data.events.filter((e) => e.taskId || e.kind !== 'execution').slice(0, 30).map((event) => nativeEventRow(event, roles)).join('') + '</ol></section>';
}

export function nativeDashboardHtml(data, roles) {
  const active = data.roles.filter((r) => r.busy);
  const flows = data.flows.filter((f) => f.isLive || (f.stages.reportReceived && !f.stages.handled)).slice(0, 3);
  return '<section class="card native-dashboard"><header class="native-section-head"><h2>桌面协作</h2>' +
    '<span class="chip">' + (data.counts.connected || 0) + ' 个岗位已连接</span><span class="spacer"></span><a class="btn btn-sm btn-ghost" href="#/team">查看全部</a></header>' +
    '<div class="native-dashboard-crew">' + active.map((r) => '<a href="' + href(r.taskId, r.roleKey) + '">' + roleAvatar(roleOf(roles, r.roleKey), { size: 34 }) +
      roleLabel(roleOf(roles, r.roleKey), { project: false }) + status(['执行中', 'running']) + '</a>').join('') + '</div>' +
    (flows.length ? flows.map((f) => '<a class="native-dashboard-task" href="' + href(f.taskId, f.roleKey) + '"><span class="mono small">' +
      esc(f.taskId) + '</span>' + nativePipeline(f, { compact: true }) + status(NATIVE_PHASES[f.phase] || [f.phase, 'neutral']) + '</a>').join('') :
      '<p class="muted small">当前没有正在执行或等待经理处理的已关联任务。</p>') + '</section>';
}

export function nativeRoleTaskHtml(role) {
  const activity = role.nativeActivity;
  if (!activity) return '';
  return '<div class="native-role-task"><header>' + status(roleStatus(role.liveState)) +
    '<span class="muted small">' + (activity.ready ? '桌面实时状态' : '等待连接') + '</span></header>' +
    (activity.taskId ? '<a class="mono" href="' + href(activity.taskId, role.key) + '">' + esc(activity.taskId) + '</a>' : '') +
    (activity.progressText ? '<p>' + esc(activity.progressText) + '</p>' : '') +
    '<p class="muted small">' + (activity.toolCount ? activity.toolCount + ' 次工具活动 · ' : '') + timeAgo(activity.observedAt) + '</p>' +
    '<a class="btn btn-sm" href="' + href(null, role.key) + '">' + icon(ICONS.handoffs, 14) + '协作过程</a></div>';
}
