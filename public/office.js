// 现代办公室：分区工位 + 真实交接连线。连线在工位卡片之间计算端点，卡片不透明，文字不被线压住。
import { CONSOLE_ROLE, esc, icon, ICONS, num, roleAvatar, roleLabel, roleStatus, status, timeAgo } from './lib.js';
import { mergeOfficeRoutes, routeOfficeConnections } from './office-routing.js';

const ZONES = [
  { id: 'mgmt', title: '管理办公室', note: '玻璃隔间', dept: 'management', glass: true },
  { id: 'hub', title: '公司中枢', note: '任务 · 进度 · 汇报' },
  { id: 'meeting', title: '协作会议室', note: '玻璃会议室', glass: true },
  { id: 'product', title: '产品研发区', note: '开发 · 设计 · 质检', dept: 'product' },
  { id: 'growth', title: '运营与数据区', note: '运营 · 数据 · 知识库', dept: 'growth' },
  { id: 'support', title: '财务与支持', note: '财务 · 电脑运维', dept: 'support' },
  { id: 'hot', title: '共享工位', note: 'AI 岗位', dept: 'workbench' },
  { id: 'lounge', title: '休息区', note: '咖啡 · 交流' },
];
export const RANGES = { '24h': 24, '48h': 48, '7d': 168 };

const kindClass = (kind) => (kind === 'dispatch' ? 'dispatch' : kind === 'report' ? 'report' : 'other');
const officeDept = (role) => role.collaboration?.authority === 'manager' ? 'management' : role.dept || 'workbench';

export function officeEdges(handoffs, roles, runs, rangeKey) {
  const nodes = new Set(['console', ...roles.map((r) => r.key)]);
  const cutoff = Date.now() - (RANGES[rangeKey] || 48) * 3600 * 1000;
  const live = new Set(runs.filter((r) => ['starting', 'running', 'waiting_approval'].includes(r.status)).map((r) => r.id));
  const pairs = new Map();
  for (const e of handoffs) {
    if (!nodes.has(e.fromRole) || !nodes.has(e.toRole) || e.fromRole === e.toRole) continue;
    if (Date.parse(e.at) < cutoff) continue;
    const kind = kindClass(e.kind);
    const key = `${e.fromRole}>${e.toRole}>${kind}>${e.channel}`;
    const prev = pairs.get(key);
    const isLive = Boolean((e.live || (e.runId && live.has(e.runId))) && kind === 'dispatch');
    if (prev) {
      prev.count += 1;
      prev.live ||= isLive;
      if (String(e.at) > String(prev.last)) prev.last = e.at;
    } else pairs.set(key, { from: e.fromRole, to: e.toRole, kind, channel: e.channel, count: 1, live: isLive, last: e.at });
  }
  return [...pairs.values()];
}

function workstation(role, { focusKey, related }) {
  const [label, tone] = roleStatus(role.liveState);
  const dim = focusKey && focusKey !== role.key && !related.has(role.key);
  return `<button type="button" class="ws state-${role.liveState} ${focusKey === role.key ? 'is-focus' : ''} ${dim ? 'is-dim' : ''}" style="--a:${role.appearance.a};--b:${role.appearance.b}" data-node="${esc(role.key)}" data-state="${esc(role.liveState)}" data-label="${esc(`${role.roleTitle}｜${role.name}`)}" data-action="office-focus" data-role="${esc(role.key)}" aria-pressed="${focusKey === role.key}">
    <span class="ws-desk" aria-hidden="true"><span class="ws-monitor tone-${tone}"></span><span class="ws-keyboard"></span></span>
    <span class="ws-person">${roleAvatar(role, { size: 52 })}</span>
    <span class="ws-plate">${roleLabel(role, { size: 'stack' })}<span class="ws-status">${status([label, tone])}</span></span>
  </button>`;
}

function zoneBody(zone, roles, ctx) {
  if (zone.id === 'hub') {
    const c = ctx.counts;
    const dim = ctx.focusKey && !ctx.related.has('console');
    return `<div class="hub ${dim ? 'is-dim' : ''}" data-node="console">
      <div class="hub-wall"><div class="hub-screen">${icon('M4 5h16v11H4zM8 20h8M12 16v4', 18)}<strong>控制台</strong></div>
      <div class="hub-stats"><span><b class="tone-running">${c.active}</b>执行中</span><span><b class="tone-waiting">${c.waitingApproval}</b>待审批</span><span><b class="tone-queued">${c.queued}</b>排队</span></div></div>
      <div class="hub-desk" aria-hidden="true"><span></span><span></span></div>
    </div>`;
  }
  if (zone.id === 'meeting') {
    return `<div class="meeting" aria-hidden="true"><div class="meeting-screen"></div><div class="meeting-table">${'<i></i>'.repeat(8)}</div></div>
      <p class="zone-foot">近 ${ctx.rangeLabel}交接 <b>${num(ctx.edgeTotal)}</b> 次</p>`;
  }
  if (zone.id === 'lounge') {
    return `<div class="lounge" aria-hidden="true"><div class="sofa"></div><div class="coffee"><i></i><i></i></div><div class="plant"></div><div class="plant plant-2"></div><div class="rug"></div></div>`;
  }
  const list = roles.filter((r) => officeDept(r) === zone.dept);
  if (!list.length) return `<p class="zone-empty">${zone.id === 'hot' ? '暂无AI 岗位，可在“岗位”页新增。' : '暂无岗位'}</p>`;
  return `<div class="desks">${list.map((r) => workstation(r, ctx)).join('')}</div>`;
}

export function officeHtml({ roles, runs, overview, handoffs, focusKey, range }) {
  const edges = officeEdges(handoffs, roles, runs, range);
  const related = new Set();
  if (focusKey) {
    related.add(focusKey);
    for (const e of edges) {
      if (e.from === focusKey) related.add(e.to);
      if (e.to === focusKey) related.add(e.from);
    }
  }
  const ctx = { focusKey, related, counts: overview?.counts || {}, edgeTotal: edges.reduce((n, e) => n + e.count, 0), rangeLabel: { '24h': '24 小时', '48h': '48 小时', '7d': '7 天' }[range] };
  const personal = roles.length > 0 && roles.every((role) => role.source === 'local');
  const visibleZones = personal ? ZONES.filter((zone) => !zone.dept || roles.some((role) => officeDept(role) === zone.dept)) : ZONES;
  const zones = visibleZones.map((zone) => `<section class="zone zone-${zone.id} ${zone.glass ? 'glass' : ''}" aria-label="${esc(zone.title)}"><header class="zone-head"><span>${esc(zone.title)}</span><small>${esc(zone.note)}</small></header>${zoneBody(zone, roles, ctx)}</section>`).join('');
  return { html: `<div class="floor ${personal ? 'is-personal' : ''}" id="floor"><svg class="floor-lines" id="floor-lines" aria-hidden="true"></svg>${zones}</div>`, edges, related };
}

/** 元素相对平面图的位置（不受镜头缩放平移影响）。 */
function floorRect(el, floor) {
  let x = 0;
  let y = 0;
  let node = el;
  while (node && node !== floor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
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
  const headers = [...floor.querySelectorAll('.zone-head')].map((el) => floorRect(el, floor));
  const zones = [...floor.querySelectorAll('.zone')].map((el) => floorRect(el, floor));
  const routes = routeOfficeConnections(mergeOfficeRoutes(edges), nodes, headers, zones, W, H);
  let packets = 0;
  const paths = routes
    .map((e) => {
      const faded = focusKey && e.from !== focusKey && e.to !== focusKey;
      const width = (1.25 + Math.min(2.5, Math.log2(e.count + 1) * 0.48)).toFixed(2);
      const cls = `edge ${e.channels.has('native') ? 'edge-native' : 'edge-runner'} ${e.live ? 'edge-live' : ''} ${faded ? 'is-faded' : focusKey ? 'is-hot' : ''}`;
      const [p1, p2] = [e.points[0], e.points.at(-1)];
      let pkt = '';
      if (particles && !faded && (e.live || focusKey) && packets < 8) {
        packets += 1;
        const dur = Math.max(2.5, Math.min(7, e.length / 95)).toFixed(2);
        const direction = e.flowFrom === e.from ? '0;1' : '1;0';
        pkt = `<circle r="${e.live ? 3 : 2}" class="pkt ${e.live ? 'pkt-live' : 'pkt-focus'}"><animateMotion dur="${dur}s" begin="-${packets * 0.7}s" repeatCount="indefinite" path="${e.d}" keyPoints="${direction}" keyTimes="0;1" calcMode="linear"/></circle>`;
      }
      return `<path class="${cls}" data-route="${esc(e.key)}" data-count="${e.count}" d="${e.d}" stroke-width="${width}"><title>${esc(`${labels[e.from]} 与 ${labels[e.to]} · ${e.count} 次交接`)}</title></path><g class="route-ports ${faded ? 'is-faded' : ''}"><circle cx="${p1[0]}" cy="${p1[1]}" r="2.3"/><circle cx="${p2[0]}" cy="${p2[1]}" r="2.3"/></g>${pkt}`;
    })
    .join('');
  svg.innerHTML = `<g class="route-network">${paths}</g>`;
  svg.dataset.routeCount = String(routes.length);
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
    const report = edges.filter((e) => e.kind === 'report').reduce((n, e) => n + e.count, 0);
    const busy = roles.filter((r) => ['working', 'waiting_approval', 'queued'].includes(r.liveState));
    return {
      stats: `<div class="strip-stats"><span><b>${roles.length}</b>岗位</span><span><b class="tone-text-running">${c.active ?? 0}</b>执行中</span><span><b class="tone-text-waiting">${c.waitingApproval ?? 0}</b>待审批</span><span><b>${num(dispatch)}</b>派单</span><span><b>${num(report)}</b>回传</span></div>${busy.length ? `<div class="strip-busy">${busy.map((r) => `<a class="role-chip" href="#/office?focus=${encodeURIComponent(r.key)}">${roleAvatar(r, { size: 20 })}${roleLabel(r, { project: false, size: 'sm' })}</a>`).join('')}</div>` : ''}`,
      legend: `<ul class="legend office-legend"><li><i class="lg lg-native"></i>线路 · 有交接</li><li><i class="lg lg-count"></i>粗细 · 交接次数</li><li><i class="lg lg-live"></i>光点 · 执行或聚焦</li><li><i class="lg lg-runner"></i>虚线 · 公司团队</li></ul>`,
    };
  }
  const mine = handoffs.filter((h) => (h.fromRole === role.key || h.toRole === role.key) && Date.parse(h.at) > Date.now() - (RANGES[range] || 48) * 3600 * 1000).slice(0, 8);
  const inbound = edges.filter((e) => e.to === role.key);
  const outbound = edges.filter((e) => e.from === role.key);
  const flow = (list, dir) =>
    list.length
      ? list.map((e) => `<li>${roleAvatar(byKey(dir === 'in' ? e.from : e.to), { size: 20 })}${roleLabel(byKey(dir === 'in' ? e.from : e.to), { project: false, size: 'sm' })}<span class="flow-kind kind-${e.kind}">${{ dispatch: '派单', report: '回传', other: '协作' }[e.kind]}</span><span class="mono">×${e.count}</span></li>`).join('')
      : '<li class="muted small">无</li>';
  const current = role.currentRun;
  const native = role.currentNativeTask;
  return `<div class="panel-block panel-hero">${roleAvatar(role, { size: 64 })}<div>${roleLabel(role, { size: 'lg' })}<div class="panel-sub">${esc(role.deptLabel || '')}</div>${status(roleStatus(role.liveState))}</div></div>
    ${native ? `<div class="panel-block"><h3>当前原生任务</h3><a class="panel-task mono" href="#/team?taskId=${encodeURIComponent(native.id)}&role=${encodeURIComponent(role.key)}">${esc(native.id)}</a><p class="small">${esc(native.progressText || '已关联真实原生派单')}</p><p class="muted small">${role.nativeActivity?.toolCount || 0} 次工具活动 · ${timeAgo(role.nativeActivity?.observedAt)}</p></div>` : ''}
    ${current ? `<div class="panel-block"><h3>当前任务</h3><a class="panel-task" href="#/task/${current.id}">${esc(current.prompt)}</a><p class="muted small">${timeAgo(current.at)}</p></div>` : ''}
    <div class="panel-block"><h3>收到</h3><ul class="flow">${flow(inbound, 'in')}</ul><h3>发出</h3><ul class="flow">${flow(outbound, 'out')}</ul></div>
    <div class="panel-block"><h3>最近交接</h3>${mine.length ? mine.map((h) => `<div class="panel-edge"><span class="flow-kind kind-${kindClass(h.kind)}">${{ dispatch: '派单', report: '回传' }[h.kind] || '协作'}</span><span class="panel-edge-roles"><span class="ellipsis">${esc(byKey(h.fromRole) ? `${byKey(h.fromRole).roleTitle}｜${byKey(h.fromRole).name}` : h.fromName)}</span><i class="connection-line" aria-label="交接"></i><span class="ellipsis">${esc(byKey(h.toRole) ? `${byKey(h.toRole).roleTitle}｜${byKey(h.toRole).name}` : h.toName)}</span></span><span class="muted small">${timeAgo(h.at)}</span></div>`).join('') : '<p class="muted small">所选时间范围内没有交接。</p>'}</div>
    <div class="panel-actions"><a class="btn btn-primary btn-sm" href="${role.source === 'company' ? `#/team?role=${encodeURIComponent(role.key)}` : `#/dispatch?role=${encodeURIComponent(role.key)}`}">${icon(role.source === 'company' ? ICONS.handoffs : ICONS.plus, 14)}${role.source === 'company' ? '协作过程' : '派单'}</a><a class="btn btn-sm" href="#/role/${encodeURIComponent(role.key)}">岗位详情</a><button class="btn btn-sm btn-ghost" data-action="office-focus" data-role="">退出聚焦</button></div>`;
}
