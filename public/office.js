// 现代办公室：开放工位与真实交接。成对线路沿工位间的水平通道排列。
import { CONSOLE_ROLE, esc, icon, ICONS, num, roleAvatar, roleLabel, roleStatus, status, timeAgo } from './lib.js';
import { mergeOfficeRoutes, routeOfficeConnections } from './office-routing.js';

export const RANGES = { '24h': 24, '48h': 48, '7d': 168 };
export const FLOW_LABELS = { dispatch: '任务下发', report: '完成回传', approval: '需要审批', error: '错误或阻碍' };
const isOfficeManager = role => role.collaboration?.authority === 'manager' || role.key === 'general_manager';

export function officeEventKind(event) {
  if (event.kind === 'dispatch' || event.kind === 'revision') return 'dispatch';
  if (event.kind === 'error' || event.kind === 'blocked' || event.reportKind === 'blocked') return 'error';
  if (event.kind === 'approval' || event.kind === 'decision' || event.reportKind === 'decision') return 'approval';
  if (event.reportKind === 'progress') return null;
  if (event.kind === 'report' && ['failed', 'error'].includes(event.status)) return 'error';
  return ['report', 'completed', 'acceptance'].includes(event.kind) ? 'report' : null;
}

export function officeEdges(handoffs, roles, runs, rangeKey, approvals = []) {
  const nodes = new Set(['console', ...roles.map((r) => r.key)]);
  const cutoff = Date.now() - (RANGES[rangeKey] || 48) * 3600 * 1000;
  const live = new Set(runs.filter((r) => ['starting', 'running', 'waiting_approval'].includes(r.status)).map((r) => r.id));
  const events = [...handoffs];
  const errors = new Set(handoffs.filter((e) => officeEventKind(e) === 'error').map((e) => e.runId));
  for (const run of runs) if (['failed', 'error'].includes(run.status) && !errors.has(run.id)) events.push({ id: run.id + ':error', fromRole: run.roleKey, toRole: run.dispatcher?.roleKey || 'console', kind: 'error', channel: 'runner', runId: run.id, at: run.completedAt || run.createdAt });
  for (const approval of approvals) if (approval.status === 'pending') {
    const run = runs.find(r => r.id === approval.runId);
    if (run && !['starting', 'running', 'waiting_approval'].includes(run.status)) continue;
    const dispatch = handoffs.find(e => e.runId === approval.runId && officeEventKind(e) === 'dispatch');
    events.push({ id: approval.id, fromRole: approval.roleKey, toRole: run?.dispatcher?.roleKey || dispatch?.fromRole || 'console', kind: 'approval', channel: 'runner', at: approval.createdAt, live: true });
  }
  const pairs = new Map();
  for (const e of events) {
    const kind = officeEventKind(e), at = Date.parse(e.at);
    if (!kind || !nodes.has(e.fromRole) || !nodes.has(e.toRole) || e.fromRole === e.toRole || !Number.isFinite(at) || at < cutoff) continue;
    if (e.kind === 'report' && ['staged', 'held'].includes(e.status)) continue;
    const key = `${e.fromRole}>${e.toRole}>${kind}>${e.channel}`;
    const prev = pairs.get(key), isLive = Boolean(e.live || (kind === 'dispatch' && e.runId && live.has(e.runId)));
    if (prev) { prev.count += 1; prev.live ||= isLive; if (at > Date.parse(prev.last)) prev.last = e.at; }
    else pairs.set(key, { from: e.fromRole, to: e.toRole, kind, channel: e.channel, count: 1, live: isLive, last: e.at });
  }
  return currentOfficeChannels([...pairs.values()]);
}

/** Each relationship has one blue dispatch lane and one return lane whose color
 * reflects its latest evidenced state. Historical states stay in the handoffs. */
export function currentOfficeChannels(edges) {
  const relationships = new Map(), result = [];
  for (const edge of edges) {
    const key = [edge.from, edge.to].sort().join('|');
    if (!relationships.has(key)) relationships.set(key, []);
    relationships.get(key).push(edge);
  }
  const latest = (a, b) => Number(b.live) - Number(a.live) || Date.parse(b.last) - Date.parse(a.last) || ({ error: 3, approval: 2, report: 1 }[b.kind] || 0) - ({ error: 3, approval: 2, report: 1 }[a.kind] || 0);
  for (const list of relationships.values()) {
    const dispatches = list.filter(e => e.kind === 'dispatch').sort(latest);
    const dispatch = dispatches[0];
    const reportCount = list.filter(e => e.kind === 'report').reduce((n, e) => n + e.count, 0);
    if (dispatch) result.push({ ...dispatch, lane: 'dispatch', count: dispatches.reduce((n, e) => n + e.count, 0), reportCount });
    const returns = list.filter(e => e.kind !== 'dispatch' && (!dispatch || e.live || Date.parse(e.last) >= Date.parse(dispatch.last))).sort(latest);
    const current = returns[0];
    if (current) result.push({ ...current, lane: 'return', from: dispatch?.to || current.from, to: dispatch?.from || current.to, count: returns.filter(e => e.kind === current.kind).reduce((n, e) => n + e.count, 0), reportCount: dispatch ? 0 : reportCount });
  }
  return result;
}

function workstation(role, { focusKey, related, degrees }) {
  const [label, tone] = roleStatus(role.liveState);
  const dim = focusKey && focusKey !== role.key && !related.has(role.key);
  const width = Math.max(144, Math.min(360, (degrees.get(role.key) || 0) * 20 + 40));
  return `<button type="button" class="ws state-${role.liveState} ${focusKey === role.key ? 'is-focus' : ''} ${dim ? 'is-dim' : ''}" style="--a:${role.appearance.a};--b:${role.appearance.b};--ws-width:${width}px" data-node="${esc(role.key)}" data-state="${esc(role.liveState)}" data-label="${esc(`${role.roleTitle}｜${role.name}`)}" data-action="office-focus" data-role="${esc(role.key)}" aria-pressed="${focusKey === role.key}">
    <span class="ws-desk" aria-hidden="true"><span class="ws-monitor tone-${tone}"></span><span class="ws-keyboard"></span></span>
    <span class="ws-person">${roleAvatar(role, { size: 52 })}</span>
    <span class="ws-plate">${roleLabel(role, { size: 'stack' })}<span class="ws-status">${status([label, tone])}</span></span>
  </button>`;
}

function commandHub(ctx) {
  const c = ctx.counts;
  const dim = ctx.focusKey && !ctx.related.has('console');
  return `<div class="hub ${dim ? 'is-dim' : ''}"><div class="hub-wall" data-node="console">
    <div class="hub-screen">${icon('M4 5h16v11H4zM8 20h8M12 16v4', 18)}<strong>控制台</strong><a class="link" href="#/manager">交代任务</a></div>
    <div class="hub-stats"><a href="#/tasks?status=active"><b class="tone-running">${c.active ?? 0}</b>执行中</a><a href="#/approvals"><b class="tone-waiting">${c.waitingApproval ?? 0}</b>待审批</a><a href="#/tasks"><b class="tone-queued">${c.queued ?? 0}</b>排队</a></div>
  </div></div>`;
}

export function officeHtml({ roles, runs, overview, handoffs, approvals = [], focusKey, range }) {
  const edges = officeEdges(handoffs, roles, runs, range, approvals);
  const related = new Set();
  if (focusKey) {
    related.add(focusKey);
    for (const e of edges) {
      if (e.from === focusKey) related.add(e.to);
      if (e.to === focusKey) related.add(e.from);
    }
  }
  const degrees = new Map();
  for (const e of mergeOfficeRoutes(edges)) for (const key of [e.from, e.to]) degrees.set(key, (degrees.get(key) || 0) + 1);
  const ctx = { focusKey, related, degrees, counts: overview?.counts || {}, edgeTotal: edges.reduce((n, e) => n + e.count, 0), rangeLabel: { '24h': '24 小时', '48h': '48 小时', '7d': '7 天' }[range] };
  const managers = roles.filter(isOfficeManager);
  const employees = roles.filter(role => !managers.includes(role));
  const rowWidth = list => list.reduce((n, role) => n + Math.max(144, Math.min(360, (degrees.get(role.key) || 0) * 20 + 40)), 0) + Math.max(0, list.length - 1) * 64 + 64;
  const width = Math.max(820, rowWidth(managers), rowWidth(employees));
  const corridor = Math.max(40, Math.ceil(employees.length / 2) * 32 - 16);
  const row = (list, cls, label) => list.length ? `<section class="office-row ${cls}" aria-label="${label}">${list.map(role => workstation(role, ctx)).join('')}</section>` : '';
  return { html: `<div class="floor office-open-plan" id="floor" style="--office-width:${width}px;--office-corridor:${corridor}px"><svg class="floor-lines" id="floor-lines" aria-hidden="true"></svg><section class="office-hub" aria-label="任务与审批">${commandHub(ctx)}</section>${row(managers, 'office-managers', '经理工位')}${row(employees, 'office-employees', '员工工位')}</div>`, edges, related };
}

/** 元素相对平面图的位置（不受镜头缩放平移影响）。 */
function floorRect(el, floor) {
  const base = floor.getBoundingClientRect(), rect = el.getBoundingClientRect();
  const sx = base.width / floor.offsetWidth || 1, sy = base.height / floor.offsetHeight || 1;
  return { x: (rect.left - base.left) / sx, y: (rect.top - base.top) / sy, w: rect.width / sx, h: rect.height / sy };
}

/** 根据当前布局计算连线与流动数据点；视口变化后重新调用。 */
export function drawOfficeLines(floor, edges, focusKey, { particles = true } = {}) {
  const svg = floor?.querySelector('#floor-lines');
  if (!svg) return;
  const W = floor.offsetWidth;
  const H = floor.offsetHeight;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const nodes = {}, labels = {};
  floor.querySelectorAll('[data-node]').forEach((el) => {
    nodes[el.dataset.node] = floorRect(el, floor);
    labels[el.dataset.node] = el.dataset.label || '控制台';
  });
  const headers = [], zones = [];
  const routes = routeOfficeConnections(mergeOfficeRoutes(edges), nodes, headers, zones, W, H);
  const missing = mergeOfficeRoutes(edges).length - routes.length;
  const notice = floor.parentElement?.querySelector('[data-routing-notice]');
  if (notice) {
    notice.hidden = missing === 0;
    notice.innerHTML = missing ? `${missing} 条往来暂未排入线路，<a href="#/handoffs">查看完整交接</a>` : '';
  }
  let packets = 0;
  const paths = routes
    .map((e) => {
      const faded = focusKey && e.from !== focusKey && e.to !== focusKey;
      const width = (1.25 + Math.min(2.5, Math.log2(e.count + 1) * 0.48)).toFixed(2);
      const cls = `edge edge-${e.kind} ${e.live ? 'edge-live' : ''} ${faded ? 'is-faded' : focusKey ? 'is-hot' : ''}`;
      const [p1, p2] = [e.points[0], e.points.at(-1)];
      let pkt = '';
      if (particles && !faded && packets < 24) {
        packets += 1;
        const dur = Math.max(2.5, Math.min(7, e.length / 95)).toFixed(2);
        const direction = e.flowFrom === e.from ? '0;1' : '1;0';
        pkt = `<circle r="${e.live ? 3 : 2}" class="pkt"><animateMotion dur="${dur}s" begin="-${packets * 0.7}s" repeatCount="indefinite" path="${e.d}" keyPoints="${direction}" keyTimes="0;1" calcMode="linear"/></circle>`;
      }
      return `<g class="office-route ${faded ? 'is-faded' : ''}" data-kind="${e.kind}" data-bundle="${esc(e.bundleKey)}" style="--route-color:var(--edge-${e.kind})"><path class="edge-clearance" d="${e.d}"/><path class="${cls}" data-route="${esc(e.key)}" data-count="${e.count}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" data-points="${esc(JSON.stringify(e.points))}" d="${e.d}" stroke-width="${width}"><title>${esc(`${labels[e.from]} → ${labels[e.to]} · ${FLOW_LABELS[e.kind]} · ${e.count} 次`)}</title></path><g class="route-ports ${faded ? 'is-faded' : ''}"><circle cx="${p1[0]}" cy="${p1[1]}" r="2.3"/><circle cx="${p2[0]}" cy="${p2[1]}" r="2.3"/></g>${pkt}</g>`;
    })
    .join('');
  svg.innerHTML = `<g class="route-network">${paths}</g>`;
  svg.dataset.routeCount = String(routes.length);
  svg.dataset.connectionCount = String(mergeOfficeRoutes(edges).length);
}

/** 某个节点在平面图中的中心点，用于镜头聚焦。 */
export function nodeCenter(floor, key) {
  const el = floor?.querySelector(`[data-node="${CSS.escape(key)}"]`);
  if (!el) return null;
  const r = floorRect(el, floor);
  return [r.x + r.w / 2, r.y + r.h / 2];
}

export function officePanelHtml({ role, roles, edges, handoffs, overview, range }) {
  const byKey = (k) => (k === 'console' ? CONSOLE_ROLE : roles.find((r) => r.key === k));
  if (!role) {
    const c = overview?.counts || {};
    const dispatch = edges.filter((e) => e.kind === 'dispatch').reduce((n, e) => n + e.count, 0);
    const report = edges.reduce((n, e) => n + (e.reportCount ?? (e.kind === 'report' ? e.count : 0)), 0);
    return {
      stats: `<div class="strip-stats"><span><b>${roles.length}</b>岗位</span><span><b class="tone-text-running">${c.active ?? 0}</b>执行中</span><span><b class="tone-text-waiting">${c.waitingApproval ?? 0}</b>待审批</span><span><b>${num(dispatch)}</b>派单</span><span><b>${num(report)}</b>回传</span></div>`,
      legend: `<ul class="legend office-legend" aria-label="协作线路图例">${Object.entries(FLOW_LABELS).map(([kind, label]) => `<li><i class="lg" style="border-color:var(--edge-${kind})"></i>${label}</li>`).join('')}<li class="muted">蓝线下发 · 回传线随状态变色</li></ul>`,
    };
  }
  const mine = handoffs.filter((h) => (h.fromRole === role.key || h.toRole === role.key) && Date.parse(h.at) > Date.now() - (RANGES[range] || 48) * 3600 * 1000).slice(0, 8);
  const inbound = edges.filter((e) => e.to === role.key);
  const outbound = edges.filter((e) => e.from === role.key);
  const flow = (list, dir) =>
    list.length
      ? list.map((e) => `<li>${roleAvatar(byKey(dir === 'in' ? e.from : e.to), { size: 20 })}${roleLabel(byKey(dir === 'in' ? e.from : e.to), { project: false, size: 'sm' })}<span class="flow-kind kind-${e.kind}">${FLOW_LABELS[e.kind] || '协作'}</span><span class="mono">×${e.count}</span></li>`).join('')
      : '<li class="muted small">无</li>';
  const current = role.currentRun;
  const native = role.currentNativeTask;
  return `<div class="panel-block panel-hero">${roleAvatar(role, { size: 64 })}<div>${roleLabel(role, { size: 'lg' })}<div class="panel-sub">${esc(role.deptLabel || '')}</div>${status(roleStatus(role.liveState))}</div></div>
    ${native ? `<div class="panel-block"><h3>当前原生任务</h3><a class="panel-task mono" href="#/team?taskId=${encodeURIComponent(native.id)}&role=${encodeURIComponent(role.key)}">${esc(native.id)}</a><p class="small">${esc(native.progressText || '已关联真实原生派单')}</p><p class="muted small">${role.nativeActivity?.toolCount || 0} 次工具活动 · ${timeAgo(role.nativeActivity?.observedAt)}</p></div>` : ''}
    ${current ? `<div class="panel-block"><h3>当前任务</h3><a class="panel-task" href="#/task/${current.id}">${esc(String(current.prompt || '当前任务').split('\n').find((line) => !line.startsWith('工作台可信任务'))?.slice(0, 48))}</a><p class="muted small">${timeAgo(current.at)}</p></div>` : ''}
    <div class="panel-block"><h3>收到</h3><ul class="flow">${flow(inbound, 'in')}</ul><h3>发出</h3><ul class="flow">${flow(outbound, 'out')}</ul></div>
    <div class="panel-block"><h3>最近交接</h3>${mine.length ? mine.map((h) => `<div class="panel-edge"><span class="flow-kind kind-${officeEventKind(h) || 'other'}">${FLOW_LABELS[officeEventKind(h)] || '协作'}</span><span class="panel-edge-roles"><span class="ellipsis">${esc(byKey(h.fromRole) ? `${byKey(h.fromRole).roleTitle}｜${byKey(h.fromRole).name}` : h.fromName)}</span><i class="connection-line" aria-label="交接"></i><span class="ellipsis">${esc(byKey(h.toRole) ? `${byKey(h.toRole).roleTitle}｜${byKey(h.toRole).name}` : h.toName)}</span></span><span class="muted small">${timeAgo(h.at)}</span></div>`).join('') : '<p class="muted small">所选时间范围内没有交接。</p>'}</div>
    <div class="panel-actions"><a class="btn btn-primary btn-sm" href="${role.source === 'company' ? `#/team?role=${encodeURIComponent(role.key)}` : `#/dispatch?role=${encodeURIComponent(role.key)}`}">${icon(role.source === 'company' ? ICONS.handoffs : ICONS.plus, 14)}${role.source === 'company' ? '协作过程' : '派单'}</a><a class="btn btn-sm" href="#/role/${encodeURIComponent(role.key)}">岗位详情</a><button class="btn btn-sm btn-ghost" data-action="office-focus" data-role="">退出聚焦</button></div>`;
}
