import { capFigure, EMBLEM_LABEL, emblemIcon } from './avatar.js';
import {
  api, approvalStatus, clock, connectEvents, CONSOLE_ROLE, duration, esc, icon, ICONS, md, mono, num, roleAvatar, roleChip, roleLabel, roleStatus,
  runStatus, sessionStatus, status, STOP_MODE, themeControl, timeAgo, toast,
} from './lib.js';
import { drawOfficeLines, nodeCenter, officeHtml, officePanelHtml } from './office.js';
import { nativeDashboardHtml, nativeRoleTaskHtml, nativeTeamHtml } from './native-team.js';
import { guideHtml } from './guide.js';
import { shortTaskTitle, organizationHtml, teamRoleCard, employeeDialogHtml } from './company-ui.js';
import { draftScope, captureDrafts, restoreDrafts, rememberForm, forgetDraft } from './drafts.js';
import { weixinSettingsHtml } from './weixin.js';

const S = { overview: null, roles: [], choices: { palettes: [], emblems: [] }, departments: {}, runs: [], sessions: [], approvals: [], collaboration: { groups: [], tasks: [], messages: [] }, runtime: null, sse: 'connecting', models: null, workspaces: null, run: null, office: { focus: '', range: '48h', edges: [] } };
const view = document.getElementById('view');
const sidebar = document.getElementById('sidebar');
const ACTIVE = new Set(['starting', 'running', 'waiting_approval']);
const NATIVE_STATUS = {
  submitted: '已提交',
  completed_accepted: '已验收',
  period_completed_accepted: '本期已验收',
  delivered_awaiting_user_feedback: '已交付 · 等待反馈',
  awaiting_user_interview: '等待本人回答',
  accepted_waiting_next_period: '已验收 · 等待下一期',
  cancelled_by_user: '已按用户要求取消',
  runtime_partial_verified_ui_redesign: '执行端已核对 · 前端改版中',
  dispatched: '派单已登记',
  in_progress: '任务进行中',
};
const nativeLabel = (s) => (s ? NATIVE_STATUS[s.status] || `${s.taskId} 进行中` : '');
const KIND_LABEL = { dispatch: '派单', report: '回传', handling: '经理处理', collaboration: '协作', management: '管理同步', reply: '回复', message: '消息', acceptance: '验收', revision: '修正' };
const DEPT_ORDER = ['management', 'product', 'growth', 'support', 'workbench'];
let avatarObserver = null;

function observeAvatars() {
  if (typeof IntersectionObserver !== 'function') return;
  avatarObserver?.disconnect();
  avatarObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle('motion-offscreen', !entry.isIntersecting);
  }, { rootMargin: '60px' });
  document.querySelectorAll('.avatar, .swatch .cap-figure').forEach((el) => avatarObserver.observe(el));
}
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('motion-paused', document.hidden);
  const network = document.getElementById('floor-lines');
  if (document.hidden) network?.pauseAnimations?.();
  else network?.unpauseAnimations?.();
});

const roleByKey = (key) => (key === 'console' ? CONSOLE_ROLE : S.roles.find((r) => r.key === key));
const sessionById = (id) => S.sessions.find((s) => s.id === id);
const taskTitle = (run) => shortTaskTitle(run, S.collaboration);
const roleActionHref = (role) => role.source === 'company' ? role.key === 'general_manager' ? '#/manager' : `#/team?role=${encodeURIComponent(role.key)}` : role.stableSessionId ? `#/chat/${role.stableSessionId}` : `#/dispatch?role=${encodeURIComponent(role.key)}`;

// ---------------- data ----------------

async function loadCore() {
  const [overview, roles, runs, sessions, approvals, collaboration, native, setup] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/roles'), api('GET', '/api/runs'), api('GET', '/api/sessions'), api('GET', '/api/approvals'), api('GET', '/api/collaboration'), api('GET', '/api/native-collaboration'), api('GET', '/api/setup')]);
  const nativeRoles = new Map(native.roles.map((r) => [r.roleKey, r]));
  const decorated = roles.roles.map((role) => {
    const activity = role.source === 'company' && nativeRoles.get(role.key);
    return activity ? { ...role, nativeActivity: activity, liveState: activity.liveState, currentNativeTask: activity.taskId ? { id: activity.taskId, status: activity.liveState, turnId: activity.turnId, progressText: activity.progressText } : null } : role;
  });
  overview.counts.active = runs.runs.filter((r) => ACTIVE.has(r.status)).length + (native.counts.active || 0);
  overview.nativeCollaboration = { ready: native.ready, counts: native.counts };
  Object.assign(S, { overview, native, setup, runtime: overview.runtime, roles: decorated, choices: roles.appearanceChoices, departments: roles.departments, runs: runs.runs, sessions: sessions.sessions, approvals: approvals.approvals, collaboration });
  draftScope(setup.manager?.key || setup.name);
}

let refreshTimer = null;
function scheduleRefresh(delay = 300) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      await loadCore();
      renderSidebar();
      const page = route().page;
      if (page === 'guide') return;
      if (page === 'office') await renderPage({ quiet: true });
      else if (page === 'role' && roleByKey(route().id)?.source === 'company' && !document.activeElement?.closest?.('[data-form]')) await renderPage({ quiet: true });
      else if (page === 'chat' && !view.querySelector('textarea')?.value) await renderPage({ quiet: true });
      else if (!view.querySelector('[data-stable]') && !['task', 'dispatch'].includes(page)) await renderPage({ quiet: true });
    } catch (error) {
      console.warn(error);
    }
  }, delay);
}

let runTimer = null;
function scheduleRunReload(runId, delay = 200) {
  clearTimeout(runTimer);
  runTimer = setTimeout(async () => {
    const r = route();
    if (r.page !== 'task' || r.id !== runId) return;
    const composer = view.querySelector('[data-form] textarea, [data-form] input[type="text"]');
    if (composer && document.activeElement === composer && composer.value) return scheduleRunReload(runId, 1200);
    const fresh = await api('GET', `/api/runs/${runId}`);
    if (!isCurrentRoute(r)) return;
    const editing = view.querySelector('[data-form] textarea, [data-form] input[type="text"]');
    if (editing && document.activeElement === editing && editing.value) return scheduleRunReload(runId, 1200);
    S.run = fresh;
    const feed = document.getElementById('main');
    const nearBottom = feed ? feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160 : true;
    view.classList.remove('page-enter');
    view.innerHTML = taskDetailHtml(S.run);
    if (feed && nearBottom) feed.scrollTop = feed.scrollHeight;
  }, delay);
}

function onEvent(event) {
  const r = route();
  const viewingRun = (id) => r.page === 'task' && r.id === id;
  switch (event.type) {
    case 'weixin.changed':
      if (r.page === 'system' && !document.activeElement?.closest?.('[data-form="weixin-verify"]')) scheduleRefresh(200);
      break;
    case 'native-collaboration.changed':
    case 'setup.changed':
      scheduleRefresh(300);
      break;
    case 'desktop-manager.changed':
      scheduleManagerReload();
      break;
    case 'hello':
    case 'runtime':
      S.runtime = event.runtime;
      renderRuntime();
      break;
    case 'run.delta': {
      if (r.page === 'chat') { scheduleRefresh(400); break; }
      if (!viewingRun(event.runId)) break;
      let el = view.querySelector(`[data-live="${CSS.escape(event.itemId)}"]`);
      if (!el) {
        const host = view.querySelector('.feed-live');
        if (!host) break;
        const role = roleByKey(S.run?.roleKey);
        host.insertAdjacentHTML(
          'beforeend',
          event.stream === 'output'
            ? `<pre class="code live-output" data-live="${esc(event.itemId)}"></pre>`
            : `<div class="entry entry-agent"><div class="entry-avatar">${roleAvatar(role, { size: 28, state: 'working' })}</div><div class="entry-main"><div class="entry-head">${roleLabel(role, { project: false })}<span class="muted">${event.stream === 'reasoning' ? '思考摘要' : '正在回复'}</span></div><div class="entry-body live-text" data-live="${esc(event.itemId)}"></div></div></div>`,
        );
        el = view.querySelector(`[data-live="${CSS.escape(event.itemId)}"]`);
      }
      el.textContent += event.delta;
      break;
    }
    case 'run.item':
    case 'run.usage':
      if (r.page === 'chat') scheduleRefresh(300);
      if (viewingRun(event.runId)) scheduleRunReload(event.runId, event.type === 'run.usage' ? 600 : 150);
      break;
    case 'run.updated':
      if (viewingRun(event.run?.id)) scheduleRunReload(event.run.id, 100);
      else if (event.run && ['completed', 'failed'].includes(event.run.status)) {
        const role = roleByKey(event.run.roleKey);
        toast(`${role?.roleTitle || event.run.roleName}｜${role?.name || ''}：${event.run.status === 'completed' ? '已回传结果' : '运行失败'}`, event.run.status === 'completed' ? 'done' : 'error');
      }
      scheduleRefresh(250);
      break;
    case 'approval.updated':
      if (event.approval?.status === 'pending' && r.page !== 'approvals' && !viewingRun(event.approval.runId)) {
        const role = roleByKey(event.approval.roleKey);
        toast(`${role?.roleTitle || ''}｜${role?.name || ''} 请求审批`, 'waiting');
      }
      if (viewingRun(event.approval?.runId)) scheduleRunReload(event.approval.runId, 50);
      scheduleRefresh(150);
      break;
    case 'session.updated':
    case 'roles.updated':
    case 'migration.updated':
    case 'collaboration.updated':
      scheduleRefresh(300);
      break;
    case 'report.updated':
      if (viewingRun(event.report?.runId)) scheduleRunReload(event.report.runId, 50);
      scheduleRefresh(300);
      break;
    default:
      break;
  }
}

// ---------------- routing & chrome ----------------

const ALIASES = { runs: 'tasks', run: 'task' };
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = hash.split('?');
  const [rawPage = 'dashboard', id = null] = pathPart.split('/').filter(Boolean);
  const page = ALIASES[rawPage] || rawPage || 'dashboard';
  return { page, id: id ? decodeURIComponent(id) : null, query: new URLSearchParams(query) };
}
let pageVersion = 0;
function isCurrentRoute(r) {
  const now = route();
  return (r.version === undefined || r.version === pageVersion) && now.page === r.page && now.id === r.id && now.query.toString() === r.query.toString();
}

const NAV = [
  { items: [['dashboard', '总览', ICONS.dashboard], ['team', '岗位协作', ICONS.handoffs], ['tasks', '任务', ICONS.tasks], ['approvals', '审批', ICONS.inbox]] },
  { group: '团队', items: [['roles', '岗位', ICONS.roles], ['office', '办公室', ICONS.office]] },
  { group: '记录与设置', secondary: true, items: [['sessions', '会话记录', ICONS.sessions], ['handoffs', '交接链路', ICONS.handoffs], ['usage', '用量统计', ICONS.usage], ['system', '连接设置', ICONS.system], ['guide', '使用引导', ICONS.book || ICONS.overview]] },
];
const PAGE_TITLE = { guide: '使用引导', dashboard: '总览', manager: '桌面经理', team: '岗位协作', chat: '岗位聊天', approvals: '审批', tasks: '任务', task: '任务详情', sessions: '会话', roles: '岗位', role: '岗位详情', office: '办公室', handoffs: '交接链路', usage: '用量', system: '连接设置', dispatch: '交代任务' };
const PARENT = { task: ['tasks', '任务'], chat: ['sessions', '会话'], role: ['roles', '岗位'], dispatch: ['tasks', '任务'] };

function renderSidebar() {
  const r = route();
  const pending = S.approvals.filter((a) => a.status === 'pending').length;
  const active = S.runs.filter((x) => ACTIVE.has(x.status)).length;
  const nav = NAV.map((g) => `${g.secondary ? `<details class="nav-more"${g.items.some(([key]) => key === r.page || PARENT[r.page]?.[0] === key) ? ' open' : ''}><summary>${g.group}</summary>` : g.group ? `<div class="nav-group">${g.group}</div>` : ''}${g.items
    .map(([key, label, d]) => {
      const count = key === 'approvals' ? pending : key === 'tasks' ? active : key === 'team' ? S.native?.counts?.awaitingHandling || 0 : 0;
      const on = r.page === key || PARENT[r.page]?.[0] === key;
      return `<a class="nav-item ${on ? 'active' : ''}" data-nav="${key}" href="#/${key}" ${on ? 'aria-current="page"' : ''}>${icon(d)}<span>${key === 'manager' && S.setup?.mode === 'personal' ? '总经理' : label}</span>${count ? `<em class="count tone-${key === 'approvals' ? 'waiting' : 'running'}">${count}</em>` : ''}</a>`;
    })
    .join('')}${g.secondary ? '</details>' : ''}`).join('');
  const roleSignature = JSON.stringify([r.page === 'role' ? r.id : '', S.roles.map(({ key, name, roleTitle, liveState, appearance, project }) => ({ key, name, roleTitle, liveState, appearance, project }))]);
  const roles = sidebar.dataset.roleSignature === roleSignature ? '' : S.roles
    .map((role) => {
      const [label, tone] = roleStatus(role.liveState);
      return `<a class="nav-role ${r.page === 'role' && r.id === role.key ? 'active' : ''}" href="#/role/${encodeURIComponent(role.key)}" title="${esc(`${role.roleTitle}｜${role.name}${role.project ? ` · ${role.project}` : ''} · ${label}`)}">${roleAvatar(role, { size: 20 })}${roleLabel(role, { size: 'sm' })}${tone === 'neutral' ? '' : `<i class="dot tone-${tone}" aria-label="${esc(label)}"></i>`}</a>`;
    })
    .join('');
  if (!sidebar.dataset.built) {
    sidebar.innerHTML = `
      <div class="company"><div class="company-mark">${esc((S.setup?.name || '我的公司').slice(0, 1))}</div><div class="company-name"><strong data-workspace-name>${esc(S.setup?.name || '我的公司')}</strong><small>一个人的公司</small></div></div>
      <a class="btn btn-primary btn-block" href="#/manager">${icon(ICONS.plus, 15)}交代任务<kbd>N</kbd></a>
      <button class="search-trigger sidebar-search" data-action="palette" type="button">${icon('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', 15)}<span>快速查找</span><kbd>⌘K</kbd></button>
      <div class="sidebar-scroll"><nav class="nav"><span class="nav-indicator" aria-hidden="true"></span><div class="nav-items"></div></nav>
      <div class="nav-group" data-role-shortcuts>岗位快捷入口</div>
      <div class="nav-roles"></div></div>
      <div class="sidebar-bottom"><div class="runtime" id="runtime"></div>${themeControl()}</div>`;
    sidebar.dataset.built = '1';
  }
  sidebar.querySelector('.nav-items').innerHTML = nav;
  const workspaceName = sidebar.querySelector('[data-workspace-name]');
  if (workspaceName) workspaceName.textContent = S.setup?.name || '我的公司';
  if (sidebar.dataset.roleSignature !== roleSignature) {
    sidebar.querySelector('.nav-roles').innerHTML = roles;
    sidebar.dataset.roleSignature = roleSignature;
  }
  sidebar.querySelector('[data-role-shortcuts]')?.classList.toggle('hidden', S.roles.length === 0);
  renderRuntime();
  requestAnimationFrame(moveIndicator);
}

function moveIndicator() {
  const indicator = sidebar.querySelector('.nav-indicator');
  const active = sidebar.querySelector('.nav-item.active');
  if (!indicator) return;
  if (!active) {
    indicator.style.opacity = '0';
    return;
  }
  indicator.style.opacity = '1';
  indicator.style.transform = `translateY(${active.offsetTop}px)`;
}

function renderRuntime() {
  const el = document.getElementById('runtime');
  if (!el) return;
  const rt = S.runtime || {};
  const desktopReady = S.native?.ready;
  const personal = S.setup?.mode === 'personal';
  const map = { ready: [personal ? 'AI 团队已连接' : '独立运行端就绪', 'done'], starting: ['运行端启动中', 'running'], stopped: [personal ? '连接 AI 团队' : desktopReady ? '桌面协作已连接' : '等待桌面连接', desktopReady ? 'done' : 'neutral'], exited: ['运行端已退出', 'error'], error: ['运行端启动失败', 'error'] };
  const [label, tone] = map[rt.status] || ['运行端状态未知', 'neutral'];
  const ver = rt.info?.userAgent?.match(/\/([\d.]+[^ ]*)/)?.[1] || '';
  el.innerHTML = `<a href="#/system">${status([label, tone])}<span class="runtime-meta">${ver ? `Codex ${esc(ver)}` : ''}${S.sse !== 'open' ? ' · 实时连接重连中' : ''}</span></a>`;
}

function updatePageTitle() {
  const r = route();
  let leaf = PAGE_TITLE[r.page] || '总览';
  if (r.page === 'manager' && S.setup?.mode === 'personal') leaf = '总经理';
  if (r.page === 'role') {
    const role = roleByKey(r.id);
    if (role) leaf = `${role.roleTitle}｜${role.name}`;
  }
  if (r.page === 'task' && r.id) leaf = S.runs.find((run) => run.id === r.id) ? taskTitle(S.runs.find((run) => run.id === r.id)) : '任务详情';
  document.title = `${leaf} · ${S.setup?.name || '一个人的公司'}`;
}

const pageHead = (title, sub = '', actions = '') => `<header class="page-head"><div class="page-titles"><h1>${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
const card = (title, body, { actions = '', cls = '' } = {}) => `<section class="card ${cls}">${title ? `<header class="card-head"><h2>${title}</h2>${actions ? `<div class="card-actions">${actions}</div>` : ''}</header>` : ''}${body}</section>`;
const empty = (title, desc = '', action = '') => `<div class="empty"><strong>${title}</strong>${desc ? `<p>${desc}</p>` : ''}${action}</div>`;
const skeleton = (rows = 4) => `<div class="skeleton" aria-busy="true" aria-label="加载中">${'<div class="sk-row"></div>'.repeat(rows)}</div>`;
const errorBox = (message) => `<div class="error-box" role="alert"><strong>页面数据加载失败</strong><p>${esc(message)}</p><button class="btn btn-sm" data-action="retry">${icon(ICONS.refresh, 14)}重试</button></div>`;

async function renderPage({ quiet = false } = {}) {
  captureDrafts(view);
  const r = route();
  document.body.classList.toggle('guide-mode', r.page === 'guide');
  if (S.setup?.required && !['guide', 'system'].includes(r.page)) { location.hash = '#/guide'; return; }
  if (r.page === 'manager' && S.setup?.mode === 'personal' && S.setup.executionMode !== 'desktop' && S.setup.managerSessionId) { location.hash = '#/chat/' + S.setup.managerSessionId; return; }
  r.version = ++pageVersion;
  view.dataset.ready = 'false';
  if (r.page !== 'office') officeObserver?.disconnect();
  updatePageTitle();
  const pages = { guide: pageGuide, dashboard: pageDashboard, manager: pageManager, team: pageTeam, chat: pageChat, approvals: pageApprovals, tasks: pageTasks, task: pageTask, sessions: pageSessions, roles: pageRoles, role: pageRole, office: pageOffice, handoffs: pageHandoffs, usage: pageUsage, system: pageSystem, dispatch: pageDispatch };
  const fn = pages[r.page] || pageDashboard;
  if (!quiet && !(r.page === 'office' && document.getElementById('office-canvas')) && ['task', 'role', 'office', 'handoffs', 'usage', 'system', 'dispatch', 'dashboard'].includes(r.page)) view.innerHTML = `${pageHead(PAGE_TITLE[r.page] || '')}${skeleton(5)}`;
  try {
    await fn(r, { quiet });
  } catch (error) {
    if (!isCurrentRoute(r)) return;
    view.innerHTML = `${pageHead(PAGE_TITLE[r.page] || '页面')}${errorBox(error.message)}`;
  }
  if (!isCurrentRoute(r)) return;
  prepareDraftForms();
  restoreDrafts(view);
  enhance({ animate: !quiet });
}

function prepareDraftForms() {
  const drafts = new Set(['new-employee', 'new-role', 'chat', 'dispatch', 'continue', 'steer', 'role-profile', 'role-skills', 'role-defaults', 'role-appearance', 'desktop-manager', 'desktop-connection']);
  view.querySelectorAll('form[data-form]').forEach((form) => {
    if (drafts.has(form.dataset.form) && !form.dataset.draftKey) form.dataset.draftKey = [form.dataset.form, form.dataset.role || form.dataset.session || form.dataset.run || ''].join(':');
  });
}
for (const type of ['input', 'change']) view.addEventListener(type, (event) => {
  const form = event.target.closest('form[data-draft-key]');
  if (form) { form.dataset.draftDirty = 'true'; rememberForm(form); }
});
view.addEventListener('close', (event) => { const form = event.target.querySelector?.('form[data-draft-key]'); if (form?.dataset.draftDirty !== 'saved') rememberForm(form, { open: false }); }, true);
window.addEventListener('beforeunload', () => captureDrafts(view));

// ---------------- 动效与交互增强 ----------------

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => {
  const floor = document.getElementById('floor');
  if (floor && route().page === 'office') drawOfficeLines(floor, S.office.edges, S.office.focus, { particles: !reduceMotion() });
});

let entranceTimer = null;
function enhance({ animate }) {
  observeAvatars();
  if (!view.children) return;
  clearTimeout(entranceTimer);
  [...view.children].forEach((el, i) => el.style?.setProperty('--i', String(i)));
  view.querySelectorAll?.('.stagger').forEach((list) => [...list.children].forEach((el, i) => el.style.setProperty('--i', String(Math.min(i, 14)))));
  if (animate) {
    view.classList.remove('page-enter');
    void view.offsetWidth;
    view.classList.add('page-enter');
    view.querySelectorAll?.('[data-count]').forEach(countUp);
    entranceTimer = setTimeout(() => {
      view.classList.remove('page-enter');
      view.querySelectorAll('.stagger').forEach((list) => list.classList.remove('stagger'));
      view.dataset.ready = 'true';
    }, reduceMotion() ? 0 : 1250);
  } else {
    view.classList.remove('page-enter');
    view.querySelectorAll?.('.stagger').forEach((list) => list.classList.remove('stagger'));
    view.dataset.ready = 'true';
  }
}

function countUp(el) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target) || reduceMotion()) {
    el.textContent = Number.isFinite(target) ? target.toLocaleString('en-US') : el.textContent;
    return;
  }
  const start = performance.now();
  const dur = 900 + Math.min(target, 50) * 6;
  const tick = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = Math.round(target * eased).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

view.addEventListener('pointermove', (event) => {
  const spot = event.target.closest?.('.card, .metric, .spot, .role-card, .approval');
  if (spot) {
    const r = spot.getBoundingClientRect();
    spot.style.setProperty('--mx', `${event.clientX - r.left}px`);
    spot.style.setProperty('--my', `${event.clientY - r.top}px`);
  }
  const tilt = event.target.closest?.('.role-card');
  if (tilt && !reduceMotion()) {
    const r = tilt.getBoundingClientRect();
    const x = (event.clientX - r.left) / r.width - 0.5;
    const y = (event.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `rotateX(${(-y * 7).toFixed(2)}deg) rotateY(${(x * 9).toFixed(2)}deg) translateY(-4px)`;
  }
});
view.addEventListener('pointerout', (event) => {
  const tilt = event.target.closest?.('.role-card');
  if (tilt && !tilt.contains(event.relatedTarget)) tilt.style.transform = '';
});

// ---------------- ⌘K 命令面板 ----------------

let palette = null;
function paletteItems() {
  const items = [];
  items.push(...[['manager', '交代任务', ICONS.plus, 'N'], ...NAV.flatMap((g) => g.items.map(([k, l, d]) => [k, l, d, '']))].map(([k, l, d, hint]) => ({ group: '页面与操作', label: l, icon: d, hint, href: `#/${k}`, keywords: `${l} ${k}` })));
  for (const role of S.roles) {
    items.push({ group: '岗位', label: `${role.roleTitle}｜${role.name}${role.project ? ` · ${role.project}` : ''}`, role, href: `#/role/${encodeURIComponent(role.key)}`, hint: roleStatus(role.liveState)[0], keywords: `${role.roleTitle} ${role.name} ${role.project || ''} ${role.key}` });
    items.push({ group: '派单给岗位', label: `派单给 ${role.roleTitle}｜${role.name}`, role, href: `#/dispatch?role=${encodeURIComponent(role.key)}`, keywords: `派单 ${role.roleTitle} ${role.name}`, hidden: true });
  }
  for (const run of S.runs.slice(0, 12)) items.push({ group: '最近任务', label: taskTitle(run), icon: ICONS.tasks, href: `#/task/${run.id}`, hint: runStatus(run)[0], keywords: `${run.prompt} ${run.roleName} ${run.id}` });
  return items;
}
function openPalette() {
  if (palette) return;
  const items = paletteItems();
  palette = document.createElement('div');
  palette.className = 'palette-backdrop';
  palette.innerHTML = `<div class="palette" role="dialog" aria-label="命令面板"><div class="palette-input">${icon('M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', 18)}<input type="text" placeholder="跳转到页面、岗位或任务；输入“派单”可直接派给岗位" aria-label="搜索"><kbd>esc</kbd></div><div class="palette-list" role="listbox"></div><div class="palette-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 打开</span><span><kbd>N</kbd> 交代任务</span></div></div>`;
  document.body.appendChild(palette);
  const input = palette.querySelector('input');
  const list = palette.querySelector('.palette-list');
  let active = 0;
  let shown = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const order = ['页面与操作', '岗位', '派单给岗位', '最近任务'];
    shown = items.filter((it) => (q ? it.keywords.toLowerCase().includes(q) || it.label.toLowerCase().includes(q) : !it.hidden)).sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group)).slice(0, 40);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let lastGroup = '';
    list.innerHTML = shown.length
      ? shown.map((it, i) => {
          const head = it.group !== lastGroup ? `<div class="palette-group">${esc(it.group)}</div>` : '';
          lastGroup = it.group;
          const lead = it.role ? roleAvatar(it.role, { size: 22 }) : icon(it.icon || ICONS.focus);
          return `${head}<div class="palette-item ${i === active ? 'active' : ''}" role="option" data-idx="${i}">${lead}<span class="ellipsis">${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</div>`;
        }).join('')
      : '<div class="empty"><strong>没有匹配结果</strong><p>换个关键词试试，例如岗位名称、姓名或任务内容。</p></div>';
    list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const go = (it) => {
    if (!it) return;
    closePalette();
    location.hash = it.href;
  };
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { go(shown[active]); e.preventDefault(); }
    else if (e.key === 'Escape') closePalette();
  });
  list.addEventListener('pointermove', (e) => {
    const item = e.target.closest('.palette-item');
    if (item && Number(item.dataset.idx) !== active) { active = Number(item.dataset.idx); list.querySelectorAll('.palette-item').forEach((n) => n.classList.toggle('active', Number(n.dataset.idx) === active)); }
  });
  list.addEventListener('click', (e) => go(shown[Number(e.target.closest('.palette-item')?.dataset.idx)]));
  palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });
  render();
  input.focus();
}
function closePalette() {
  palette?.remove();
  palette = null;
}
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette ? closePalette() : openPalette();
  } else if (!typing && !palette && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); location.hash = '#/manager'; }
    else if (e.key === '/') { e.preventDefault(); openPalette(); }
  }
});
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="palette"]')) openPalette();
  if (e.target.closest('[data-action="menu"]')) {
    const open = document.body.classList.toggle('nav-open');
    document.querySelector('.mobile-nav-button')?.setAttribute('aria-expanded', String(open));
  }
});
function closeNavigation() {
  document.body.classList.remove('nav-open');
  document.querySelector('.mobile-nav-button')?.setAttribute('aria-expanded', 'false');
}
sidebar.addEventListener('click', (e) => {
  if (e.target.closest('a')) closeNavigation();
});
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('[data-action="menu"]')) closeNavigation();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNavigation(); });

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

function activityBars(runs) {
  const now = Date.now();
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const run of runs) {
    const t = Date.parse(run.createdAt);
    const h = Math.floor((now - t) / 3600000);
    if (h >= 0 && h < 24) buckets[23 - h] += 1;
  }
  const max = Math.max(1, ...buckets);
  return `<div class="activity" aria-label="近 24 小时派单数">${buckets.map((n, i) => `<i class="${n ? '' : 'zero'}" style="height:${Math.max(4, (n / max) * 100)}%;--i:${i}" title="${n} 次"></i>`).join('')}</div><div class="activity-axis"><span>24h 前</span><span>12h</span><span>现在</span></div>`;
}

// ---------------- shared fragments ----------------

function replaceView(html, { preserveAvatars = false } = {}) {
  if (!preserveAvatars || !view.replaceChildren) { view.innerHTML = html; return; }
  const saved = new Map();
  view.querySelectorAll('[data-avatar-key]').forEach((el) => {
    const key = el.dataset.avatarKey;
    if (!saved.has(key)) saved.set(key, []);
    saved.get(key).push(el);
  });
  const template = document.createElement('template'); template.innerHTML = html;
  view.querySelectorAll('[data-form="role-appearance"]').forEach((form) => {
    const replacement = template.content.querySelector(`[data-form="role-appearance"][data-role="${CSS.escape(form.dataset.role)}"]`);
    if (replacement) replacement.replaceWith(form);
  });
  template.content.querySelectorAll('[data-avatar-key]').forEach((el) => {
    const old = saved.get(el.dataset.avatarKey)?.shift();
    if (old) el.replaceWith(old);
  });
  view.replaceChildren(template.content);
}

function taskRow(run) {
  const role = roleByKey(run.roleKey);
  const session = sessionById(run.sessionId);
  const [label, tone] = runStatus(run);
  return `<a class="trow" href="#/task/${run.id}">
    <span class="trow-status" title="${esc(label)}">${statusIcon16(tone)}</span>
    <span class="trow-main"><span class="trow-title">${esc(taskTitle(run))}</span><span class="trow-meta">${status([label, tone])}${session ? `<span class="ellipsis">${esc(session.title)}</span>` : ''}</span></span>
    <span class="trow-role">${roleChip(role, { avatar: 22, state: ACTIVE.has(run.status) ? 'working' : 'idle' })}</span>
    <span class="trow-time">${timeAgo(run.createdAt)}</span>
    <span class="trow-num mono">${run.durationMs != null ? duration(run.durationMs) : ACTIVE.has(run.status) ? '进行中' : '—'}</span>
    <span class="trow-num mono">${run.usage?.totalTokens != null ? num(run.usage.totalTokens) : '—'}</span>
  </a>`;
}
const statusIcon16 = (tone) => status(['', tone]).replace('<span class="status-text"></span>', '');

function taskList(runs, emptyHtml) {
  if (!runs.length) return emptyHtml || empty('还没有任务', '把目标交给经理，从第一项任务开始。', `<a class="btn btn-primary btn-sm" href="#/dispatch">${icon(ICONS.plus, 14)}交代任务</a>`);
  return `<div class="tlist stagger"><div class="thead"><span></span><span>任务</span><span>负责岗位</span><span>创建</span><span class="right">用时</span><span class="right">token</span></div>${runs.map(taskRow).join('')}</div>`;
}

function approvalCard(a) {
  const role = roleByKey(a.roleKey);
  const kindLabel = { command: '执行命令', fileChange: '修改文件', permissions: '追加权限', userInput: '需要回答', elicitation: '工具请求信息', legacyCommand: '执行命令', legacyPatch: '修改文件' }[a.kind] || a.kind;
  const cmd = a.command ? (Array.isArray(a.command) ? a.command.join(' ') : String(a.command).replace(/^\/bin\/zsh -lc /, '')) : '';
  const pending = a.status === 'pending';
  const questions = (a.questions || []).map((q) => `<label class="field"><span>${esc(q.question || q.header || q.id)}</span><input data-answer="${esc(q.id)}" placeholder="输入回答"></label>`).join('');
  return `<article class="approval ${pending ? 'is-pending' : ''}" data-approval="${a.id}">
    <header class="approval-head">${roleAvatar(role, { size: 32, state: pending ? 'waiting_approval' : 'idle' })}<div class="approval-who">${roleLabel(role)}<span class="muted small">${kindLabel} · ${timeAgo(a.createdAt)} · <a href="#/task/${a.runId}">查看任务</a></span></div>${status(approvalStatus(a.status))}</header>
    ${a.reason ? `<p class="approval-reason">${esc(a.reason)}</p>` : ''}${cmd ? `<pre class="code">${esc(cmd)}</pre>` : ''}${a.cwd ? `<p class="small muted">目录 ${mono(a.cwd)}</p>` : ''}${a.grantRoot ? `<p class="small muted">申请写入 ${mono(a.grantRoot)}</p>` : ''}${questions}
    ${pending ? `<footer class="approval-actions"><button class="btn btn-sm btn-danger-ghost" data-action="approve" data-decision="cancel">拒绝并中断</button><span class="spacer"></span><button class="btn btn-sm" data-action="approve" data-decision="decline">拒绝</button><button class="btn btn-sm" data-action="approve" data-decision="acceptForSession">本会话都批准</button><button class="btn btn-sm btn-primary" data-action="approve" data-decision="accept">批准一次</button></footer>` : ''}
  </article>`;
}

function edgeRow(e) {
  const from = roleByKey(e.fromRole) || { key: e.fromRole, name: e.fromName, roleTitle: e.fromName };
  const to = roleByKey(e.toRole) || { key: e.toRole, name: e.toName, roleTitle: e.toName };
  const ref = e.runId ? `<a href="#/task/${e.runId}" class="mono">${esc(e.runId.slice(-8))}</a>` : `<span class="mono ellipsis" title="${esc(e.evidence || '')}">${esc(e.taskId || (e.evidence || '').split('/').pop())}</span>`;
  return `<div class="erow"><span class="mono muted">${timeAgo(e.at)}</span><span class="chip chip-${e.channel}">${e.channel === 'runner' ? '公司团队' : '桌面聊天'}</span><span class="erow-flow">${roleChip(from, { project: false })}<span class="handoff-connection kind-${e.kind === 'dispatch' ? 'dispatch' : e.kind === 'report' ? 'report' : 'other'}"><i class="connection-line" aria-hidden="true"></i>${esc(KIND_LABEL[e.kind] || e.kind)}</span>${roleChip(to, { project: false })}</span>${ref}</div>`;
}

function metric(label, value, tone, href, hint = '') {
  const n = typeof value === 'number' ? value : null;
  const accent = { running: 'var(--st-running)', waiting: 'var(--st-waiting)', done: 'var(--st-done)', error: 'var(--st-error)' }[tone] || 'var(--brand-1)';
  return `<a class="metric" href="${href}"><span class="metric-accent" style="background:linear-gradient(90deg, ${accent}, transparent)"></span><span class="metric-label">${label}</span><strong class="metric-value tone-text-${tone}" ${n != null ? `data-count="${n}"` : ''}>${n != null ? n.toLocaleString('en-US') : esc(value ?? 0)}</strong>${hint ? `<span class="metric-hint">${hint}</span>` : ''}</a>`;
}

// ---------------- pages ----------------

async function pageGuide(r) {
  const data = await api('GET', '/api/setup');
  const skillsData = data.step === 'skills' && data.workspacePath ? await api('GET', `/api/skills?cwd=${encodeURIComponent(data.workspacePath)}`) : null;
  if (!isCurrentRoute(r)) return;
  S.setup = data;
  const previousStep = view.querySelector('[data-guide-step]')?.dataset.guideStep;
  view.innerHTML = guideHtml(data, { drafts: S.guideDraft || {}, skillsData, appearanceControl: themeControl({ compact: true }) });
  const panel = view.querySelector('.guide-panel');
  if (previousStep !== panel?.dataset.guideStep) {
    panel?.classList.add('guide-arrive');
    document.getElementById('main').scrollTo({ top: 0, behavior: 'instant' });
    if (previousStep) panel?.focus({ preventScroll: true });
  }
}

let guideSaveTimer;
async function saveGuideDraft() {
  clearTimeout(guideSaveTimer);
  const drafts = { ...(S.guideDraft || {}) };
  if (Object.keys(drafts).length) await api('PATCH', '/api/setup', { drafts });
}

const DESKTOP_MESSAGE_LABEL = { submitting: ['提交中', 'running'], submitted: ['已提交', 'queued'], received: ['经理已收到 · 回复中', 'running'], completed: ['已收到真实回复', 'done'], completed_empty: ['本轮结束 · 无回复正文', 'neutral'], error: ['本轮失败', 'error'], unknown: ['提交结果待核实', 'waiting'], interrupted: ['本轮已中断', 'paused'] };
let managerTimer;
const desktopRole = (data) => roleByKey('general_manager') || { key: 'desktop_manager', roleTitle: '总经理', name: data.target?.name || '桌面经理', liveState: data.busy ? 'working' : 'idle', appearance: { a: '#c4bbff', b: '#5869dc', emblem: 'briefcase' } };
function scheduleManagerReload() {
  if (route().page !== 'manager') return;
  clearTimeout(managerTimer);
  managerTimer = setTimeout(() => pageManager(route(), { quiet: true }).catch((e) => toast(e.message, 'error')), 180);
}
function managerFeed(data) {
  const role = desktopRole(data);
  if (!data.messages.length) return `<div class="desktop-welcome">${roleAvatar(role, { size: 72, state: 'idle' })}<h2>与总经理对话</h2><p>消息会发送到你选择的 Codex 桌面聊天，回复也会显示在这里。</p></div>`;
  return data.messages.map((m) => `<article class="desktop-exchange" data-desktop-message="${esc(m.id)}">
    <div class="desktop-user"><span class="muted small">${esc(S.setup?.ownerName || '你')} · ${clock(m.createdAt)}</span><div>${md(m.text)}</div></div>
    <div class="desktop-stages" aria-label="消息进度">${[['submittedAt', '已提交'], ['receivedAt', '已收到'], ['completedAt', '本轮结束']].map(([k, label]) => `<span class="${m[k] ? 'reached' : ''}"><i></i>${label}</span>`).join('')}<span class="spacer"></span>${status(DESKTOP_MESSAGE_LABEL[m.status] || [m.status, 'neutral'])}</div>
    <div class="desktop-reply">${roleAvatar(role, { size: 36, state: m.status === 'received' ? 'working' : 'idle' })}<div class="desktop-reply-content"><div class="small">${roleLabel(role, { project: false })}</div>${m.replyText ? `<div class="desktop-reply-body">${md(m.replyText)}</div>` : m.progressText ? `<div class="desktop-reply-body muted">${md(m.progressText)}</div>` : `<p class="muted">${m.status === 'unknown' ? '提交状态还未核实，消息保留在此。' : m.status === 'error' ? esc(m.error?.message || m.submissionError?.message || '本轮未完成') : m.status === 'completed_empty' ? '桌面会话已结束本轮，没有返回回复正文。' : m.status === 'interrupted' ? '桌面会话已中断本轮。' : '等待桌面会话回复'}${['submitting', 'submitted', 'received'].includes(m.status) ? '<span class="typing-dots" aria-label="等待回复"><i></i><i></i><i></i></span>' : ''}</p>`}</div></div>
  </article>`).join('');
}
async function pageManager(r, { quiet = false } = {}) {
  const data = await api('GET', '/api/desktop-manager');
  if (!isCurrentRoute(r)) return;
  const pending = data.messages.some((m) => ['submitting', 'submitted', 'received', 'unknown'].includes(m.status));
  const disabled = !data.ready || data.busy || pending;
  const connection = `${status(data.ready ? ['当前桌面会话已连接', 'done'] : ['桌面连接不可用', 'error'])}<span class="muted small">${data.busy ? '总经理正在工作' : pending ? '等待回复或核实' : '可发送消息'}</span>`;
  if (quiet && document.getElementById('desktop-feed')) {
    const feed = document.getElementById('desktop-feed');
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    feed.innerHTML = managerFeed(data);
    document.getElementById('desktop-connection').innerHTML = connection;
    const button = view.querySelector('[data-form="desktop-manager"] button[type="submit"]');
    if (button) button.disabled = disabled || S.managerSubmitting;
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
    observeAvatars(); return;
  }
  view.innerHTML = `${pageHead('桌面经理', '连接你选择的 Codex 桌面聊天。', '<a class="btn btn-sm" href="#/system?desktop=1">连接设置</a><button class="btn btn-sm" data-action="retry">更新状态</button>')}
    <section class="desktop-conversation card"><header class="desktop-conversation-head">${roleAvatar(desktopRole(data), { size: 42 })}<div>${roleLabel(desktopRole(data), { project: false })}<p class="muted small">${esc(data.target?.name || '等待选择桌面聊天')}</p></div><span class="spacer"></span><div id="desktop-connection">${connection}</div></header>
    ${!data.ready ? `<div class="notice" role="alert">${esc(data.lastError || '请先在连接设置选择聊天，并在 Codex 桌面中打开它。')}</div>` : ''}
    <div id="desktop-feed" class="desktop-feed" aria-live="polite" aria-relevant="additions text">${managerFeed(data)}</div>
    <form data-form="desktop-manager" data-stable class="composer composer-tall desktop-composer"><label class="sr-only" for="desktop-prompt">发送给总经理的消息</label><textarea id="desktop-prompt" name="text" maxlength="6000" rows="3" required placeholder="告诉总经理你的目标…">${esc(S.managerDraft || '')}</textarea><footer><span class="muted small">消息和回复保留在同一桌面会话</span><span class="spacer"></span><button class="btn btn-primary" type="submit" ${disabled ? 'disabled' : ''}>发送消息</button></footer></form></section>`;
  const feed = document.getElementById('desktop-feed'); feed.scrollTop = feed.scrollHeight;
}

async function pageDashboard(r) {
  const c = S.overview?.counts || {};
  const pending = S.approvals.filter((a) => a.status === 'pending');
  const live = S.runs.filter((r) => ACTIVE.has(r.status) || r.status === 'queued');
  const handoffs = (await api('GET', '/api/handoffs')).handoffs.slice(0, 3);
  if (!isCurrentRoute(r)) return;
  const order = { working: 0, waiting_approval: 0, queued: 1, error: 2, paused: 3, delivered: 4, idle: 5 };
  const roles = [...S.roles].sort((a, b) => (order[a.liveState] ?? 9) - (order[b.liveState] ?? 9));
  const today = new Date().toDateString();
  const doneToday = S.runs.filter((r) => r.status === 'completed' && new Date(r.completedAt).toDateString() === today).length;
  const busy = S.roles.filter((r) => ['working', 'waiting_approval', 'queued'].includes(r.liveState)).length;
  const crew = S.setup?.mode === 'personal' ? S.roles : S.roles.filter((r) => r.source === 'company');
  const idleCopy = S.setup?.executionMode === 'desktop' ? '已连接你的 Codex 桌面聊天。' : S.setup?.mode === 'personal' ? (S.roles.length ? '你的 AI 团队已就位。' : '从组建你的 AI 团队开始，') : S.native?.counts.connected ? '当前已连接岗位没有执行活动，' : '等待桌面岗位连接，';
  view.innerHTML = `<section class="hero"><div><div class="eyebrow">公司今日</div><h1>${greeting()}，<span class="grad-text">${esc(S.setup?.ownerName || '欢迎回来')}</span></h1><p class="page-sub">${busy ? `${busy} 个岗位正在工作，` : idleCopy}${pending.length ? `${pending.length} 项审批等你决定。` : '今天想推进什么？'}</p></div>
      <div class="hero-side"><div class="hero-crew">${crew.map((r) => `<a href="#/role/${encodeURIComponent(r.key)}" title="${esc(`${r.roleTitle}｜${r.name}`)}">${roleAvatar(r, { size: 52, emblem: false })}</a>`).join('')}</div><div class="page-actions" style="justify-content:flex-end;margin-top:14px"><a class="btn" href="#/office">${icon(ICONS.office, 15)}进入办公室</a><a class="btn btn-primary" href="#/manager">联系总经理</a></div></div></section>
    ${pending.length ? `<section class="attention"><div class="attention-head">${status(['需要你处理', 'waiting'])}<span>${pending.length} 项审批正在等待决定</span><a class="btn btn-sm" href="#/approvals">全部审批</a></div>${pending.slice(0, 2).map(approvalCard).join('')}</section>` : ''}
    <section class="metrics dashboard-metrics">
      ${metric('执行中', c.active ?? 0, 'running', '#/team', S.setup?.mode === 'personal' ? '查看团队进度' : `桌面 ${S.native?.counts.active || 0} · 独立运行 ${live.length}`)}${metric('待审批', c.waitingApproval ?? 0, 'waiting', '#/approvals', '审批决定直接回到任务')}${metric('今日完成', doneToday, 'done', '#/tasks?status=completed', `累计 ${c.completed ?? 0}`)}${metric('团队岗位', S.roles.length, 'neutral', '#/roles', '查看职责与配置')}
    </section>
    ${S.setup?.nativeCompanyEnabled && S.native ? nativeDashboardHtml(S.native, S.roles) : ''}
    <div class="grid-main">
      ${card('岗位动态', `<div class="agent-list stagger">${roles.map((role) => `<a class="agent-row" href="#/role/${encodeURIComponent(role.key)}">${roleAvatar(role, { size: 38 })}<span class="agent-main">${roleLabel(role)}<span class="agent-task ellipsis">${role.currentNativeTask ? esc(role.currentNativeTask.id + ' · ' + (role.currentNativeTask.progressText || '原生任务')) : role.currentRun ? esc(role.currentRun.prompt) : '暂无任务'}</span></span>${status(roleStatus(role.liveState))}</a>`).join('')}</div>`, { actions: '<a href="#/office" class="link">在办公室查看</a>' })}
      <div class="stack">
        ${card('近 24 小时活动', activityBars(S.runs), { actions: `<span class="muted small mono">${S.runs.filter((x) => Date.now() - Date.parse(x.createdAt) < 86400000).length} 次</span>` })}
        ${handoffs.length ? card('最近交接', `<div class="mini-list stagger">${handoffs.map((e) => { const f = roleByKey(e.fromRole) || { name: e.fromName, roleTitle: e.fromName }; const t = roleByKey(e.toRole) || { name: e.toName, roleTitle: e.toName }; return `<div class="mini-row handoff-row">${roleAvatar(f, { size: 20 })}${roleLabel(f, { project: false, size: 'sm' })}<span class="handoff-connection kind-${e.kind === 'dispatch' ? 'dispatch' : e.kind === 'report' ? 'report' : 'other'}"><i class="connection-line" aria-hidden="true"></i>${esc(KIND_LABEL[e.kind] || e.kind)}</span>${roleLabel(t, { project: false, size: 'sm' })}<span class="spacer"></span><span class="muted small nowrap">${timeAgo(e.at)}</span></div>`; }).join('')}</div>`, { actions: '<a href="#/handoffs" class="link">查看交接链路</a>' }) : ''}
      </div>
    </div>
    ${card('最近任务', taskList(S.runs.slice(0, 6)), { actions: '<a href="#/tasks" class="link">全部任务</a>', cls: 'flush' })}`;
}

async function pageApprovals() {
  const pending = S.approvals.filter((a) => a.status === 'pending');
  const done = S.approvals.filter((a) => a.status !== 'pending').slice(0, 30);
  view.innerHTML = `${pageHead('审批', '处理 AI 员工发来的确认请求。')}
    ${pending.length ? `<div class="stack">${pending.map(approvalCard).join('')}</div>` : card('', empty('没有待处理的审批', '有需要你决定的事项时，会在这里出现。'))}
    ${done.length ? card('已处理', `<div class="tlist simple">${done.map((a) => `<a class="srow" href="#/task/${a.runId}">${roleChip(roleByKey(a.roleKey), { project: false })}<span class="ellipsis mono small">${esc(String(a.command || a.kind).replace(/^\/bin\/zsh -lc /, ''))}</span>${status(approvalStatus(a.status))}<span class="muted small nowrap">${timeAgo(a.decidedAt || a.createdAt)}</span></a>`).join('')}</div>`, { cls: 'flush' }) : ''}`;
}

async function pageTasks(r) {
  const filter = r.query.get('status') || 'all';
  const match = (x) => filter === 'all' || (filter === 'active' ? ACTIVE.has(x.status) || x.status === 'queued' : filter === 'interrupted' ? ['interrupted', 'cancelled'].includes(x.status) : x.status === filter);
  const tabs = [['all', '全部'], ['active', '进行中'], ['completed', '已完成'], ['interrupted', '已暂停/停止'], ['failed', '失败']];
  const counts = Object.fromEntries(tabs.map(([k]) => [k, S.runs.filter((x) => k === 'all' || (k === 'active' ? ACTIVE.has(x.status) || x.status === 'queued' : k === 'interrupted' ? ['interrupted', 'cancelled'].includes(x.status) : x.status === k)).length]));
  view.innerHTML = `${pageHead('任务', '交代目标，查看进度和结果。', `<a class="btn btn-primary" href="#/manager">${icon(ICONS.plus, 15)}交代任务</a>`)}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<a role="tab" aria-selected="${filter === k}" class="tab ${filter === k ? 'active' : ''}" href="#/tasks?status=${k}">${l}<span class="tab-count">${counts[k]}</span></a>`).join('')}</div>
    ${card('', taskList(S.runs.filter(match), empty('这个分类下没有任务', '换一个分类，或交代任务。')), { cls: 'flush' })}`;
}

const TEAM_STATE = { submitted: ['已提交', 'queued'], running: ['执行中', 'running'], delivered: ['已交付', 'done'], accepted: ['已验收', 'done'], blocked: ['有阻碍', 'error'], needs_decision: ['需决定', 'waiting'], paused: ['已暂停', 'paused'], cancelled: ['已取消', 'neutral'], interrupted: ['待恢复', 'paused'] };
const MSG_LABEL = { dispatch: '派单', completed: '完成回报', blocked: '阻碍回报', decision: '需要决定', progress: '进度', acceptance: '验收', revision: '修正', collaboration: '任务内协作' };
const MSG_STATE = { staged: '已提交 · 待本轮结束', unread: '待处理', processing: '经理处理中', handled: '经理已处理', held: '已保留 · 等待明确恢复', submitted: '已提交', recorded: '已记录' };

async function pageTeam(r, { quiet = false } = {}) {
  if (S.setup?.mode !== 'personal' && r.query.get('scope') !== 'runner' && !r.query.get('namespace')) {
    const query = new URLSearchParams();
    if (r.query.get('taskId')) query.set('taskId', r.query.get('taskId'));
    if (r.query.get('role') && r.query.get('role') !== 'general_manager') query.set('roleKey', r.query.get('role'));
    const data = await api('GET', `/api/native-collaboration?${query}`);
    if (!isCurrentRoute(r)) return;
    const open = new Set([...view.querySelectorAll('details[open]')].map((el) => el.closest('[data-native-event]')?.dataset.nativeEvent));
    const filter = view.querySelector('[data-form="native-filter"] input');
    const editing = filter && document.activeElement === filter ? { value: filter.value, start: filter.selectionStart, end: filter.selectionEnd } : null;
    const html = `${pageHead('岗位协作', '经理派单、员工执行、沟通回报和经理处理，来自当前桌面会话。', '<a class="btn btn-sm" href="#/team?scope=runner">独立测试组</a><a class="btn btn-primary btn-sm" href="#/manager">联系总经理</a>')}${nativeTeamHtml(data, S.roles, { taskId: r.query.get('taskId') || '', roleKey: r.query.get('role') || '' })}`;
    replaceView(html, { preserveAvatars: quiet });
    if (editing) {
      const input = view.querySelector('[data-form="native-filter"] input');
      input.value = editing.value; input.focus({ preventScroll: true }); input.setSelectionRange(editing.start, editing.end);
    }
    for (const eventId of open) if (eventId) view.querySelector(`[data-native-event="${CSS.escape(eventId)}"] details`)?.setAttribute('open', '');
    return;
  }
  const query = new URLSearchParams();
  const namespace = r.query.get('namespace') || S.collaboration.groups[0]?.namespace;
  if (namespace) query.set('namespace', namespace);
  if (r.query.get('cursor')) query.set('cursor', r.query.get('cursor'));
  if (r.query.get('taskId')) query.set('taskId', r.query.get('taskId'));
  const data = await api('GET', `/api/collaboration?${query}`);
  if (!isCurrentRoute(r)) return;
  const selected = r.query.get('namespace') || data.groups[0]?.namespace || '';
  const group = data.groups.find((g) => g.namespace === selected);
  const roles = S.roles.filter((role) => role.collaboration?.namespace === selected);
  const tasks = data.tasks.filter((t) => t.namespace === selected);
  const messages = data.messages.filter((m) => m.namespace === selected && ['completed', 'blocked', 'decision', 'progress'].includes(m.kind));
  const accepted = tasks.filter((t) => t.status === 'accepted').length;
  const manager = roles.find((role) => role.collaboration.authority === 'manager');
  const managerSession = manager?.stableSessionId ? sessionById(manager.stableSessionId) : null;
  const messageCard = (message) => {
    const role = roleByKey(message.fromRole);
    const task = tasks.find((t) => t.id === message.taskId);
    return `<article class="inbox-item kind-${message.kind}" data-message-id="${esc(message.id)}"><header>${roleAvatar(role, { size: 30 })}<div>${roleLabel(role, { project: false })}<span class="small muted">${esc(MSG_LABEL[message.kind])} · ${timeAgo(message.deliveredAt || message.createdAt)}</span></div><span class="spacer"></span><span class="chip">${esc(MSG_STATE[message.status] || message.status)}</span></header><p>${esc(message.summary)}</p><div class="artifact-list">${message.artifacts.map((a, index) => `<button type="button" class="artifact-tag" data-action="artifact-preview" data-message="${message.id}" data-index="${index}" title="sha256 ${esc(a.sha256)}">${icon(ICONS.tasks, 12)}${esc(a.path)}<small>查看文件</small></button>`).join('')}</div><footer><span class="small muted">${esc(task?.title || message.taskId)}</span>${message.managerRunId ? `<a class="link small" href="#/task/${message.managerRunId}">经理处理记录</a>` : ''}${message.runId ? `<a class="link small" href="#/task/${message.runId}">员工执行记录</a>` : ''}</footer></article>`;
  };
  const taskCard = (task) => {
    const stages = [['submittedAt', '已提交'], ['startedAt', '已开工'], ['deliveredAt', '已交付'], ['acceptedAt', '已验收']];
    return `<article class="team-task" data-team-task="${esc(task.id)}"><header><div><h3>${esc(task.title)}</h3><span class="muted small">${roleLabel(roleByKey(task.employeeRoleKey), { project: false, size: 'sm' })}</span></div><span class="spacer"></span>${status(TEAM_STATE[task.status] || [task.status, 'neutral'])}</header><div class="task-stages">${stages.map(([key, label]) => `<span class="stage ${task[key] ? 'reached' : ''}"><i></i>${label}</span>`).join('')}</div>${task.review?.summary ? `<p class="team-review small"><span class="tone-text-done">验收结论</span> ${esc(task.review.summary)}</p>` : ''}<footer><a class="link small" href="#/chat/${task.employeeSessionId}">员工聊天</a><a class="link small" href="#/chat/${task.managerSessionId}">经理聊天</a><span class="spacer"></span>${['submitted', 'running', 'delivered', 'blocked', 'needs_decision'].includes(task.status) ? `<button class="btn btn-xs" data-action="team-control" data-task="${task.id}" data-op="pause">暂停</button>` : ''}${['paused', 'interrupted', 'blocked', 'needs_decision'].includes(task.status) ? `<button class="btn btn-xs btn-primary" data-action="team-control" data-task="${task.id}" data-op="resume">续办</button>` : ''}${!['accepted', 'cancelled'].includes(task.status) ? `<button class="btn btn-xs btn-danger-ghost" data-action="team-control" data-task="${task.id}" data-op="cancel">取消</button>` : ''}</footer></article>`;
  };
  view.innerHTML = `${pageHead(S.setup?.mode === 'personal' ? '团队协作' : '独立测试组', S.setup?.mode === 'personal' ? '看谁在做、做到哪一步，以及交付了什么。' : '保留已验证的独立岗位试点。', S.setup?.mode === 'personal' ? '<a class="btn btn-primary" href="#/manager">联系总经理</a>' : '<a class="btn btn-sm" href="#/team">桌面员工</a><a class="btn" href="#/roles">建立测试岗位</a>')}
    ${data.groups.length > 1 ? `<div class="tabs" role="tablist">${data.groups.map((g) => `<a class="tab ${g.namespace === selected ? 'active' : ''}" href="#/team?namespace=${encodeURIComponent(g.namespace)}">${esc(S.setup?.mode === 'personal' ? S.setup.name : g.namespace)}<span class="chip">${S.setup?.mode === 'personal' ? '我的团队' : '独立测试'}</span></a>`).join('')}</div>` : ''}
    ${!group ? card('', S.setup?.mode === 'personal' ? empty('先建立你的团队', '从一位总经理和一位员工开始。', '<a class="btn btn-primary btn-sm" href="#/guide">建立团队</a>') : empty('先建立一个测试团队', '在岗位页创建测试总经理，再创建同一测试组的员工。每个岗位有独立、稳定的聊天。', '<a class="btn btn-primary btn-sm" href="#/roles">建立岗位</a>')) : `<section class="team-banner"><div><div class="eyebrow">AI TEAM</div><h2>团队概况</h2><p>本组 ${roles.length} 个岗位 · ${tasks.length} 项任务 · ${accepted} 项已验收</p></div><div class="team-banner-crew">${roles.map((role) => `<a href="#/chat/${role.stableSessionId || ''}" class="team-person">${roleAvatar(role, { size: 58 })}${roleLabel(role, { project: false, size: 'sm' })}<span class="small muted">${role.collaboration.authority === 'manager' ? '调度与验收' : '执行与回报'}</span></a>`).join('')}</div></section>
    ${managerSession?.wakePaused ? `<div class="notice inbox-paused"><strong>经理收件箱已暂停。</strong>已有回报会保留，明确恢复后再处理。<button class="btn btn-xs" data-action="inbox-resume" data-session="${managerSession.id}">恢复收件箱</button></div>` : ''}
    <div class="team-grid"><section>${card('团队任务', tasks.length ? `<div class="team-task-list stagger">${tasks.map(taskCard).join('')}</div>` : empty('等待第一项任务', '在总经理聊天中写明目标和交付要求。'))}</section><section>${card('经理收件箱', messages.length ? `<div class="inbox-list stagger">${messages.map(messageCard).join('')}</div>` : empty('尚未收到关键回报', '员工完成、遇阻或需要决定时主动投递，经理忙时消息保留。'), { actions: manager?.stableSessionId ? `<a class="link small" href="#/chat/${manager.stableSessionId}">经理聊天</a>` : '' })}</section></div>
    ${data.nextCursor ? `<a class="btn btn-sm" href="#/team?namespace=${encodeURIComponent(selected)}&cursor=${encodeURIComponent(data.nextCursor)}">下一页任务</a>` : ''}<div class="team-capabilities"><span class="chip">${S.setup?.mode === 'personal' ? '团队工作区' : '测试工作区'}</span><span class="chip">内部派单与回报</span><span class="chip">最多 3 名员工并发</span><span class="chip">同项目串行写入</span><a class="link" href="#/system">查看连接与能力</a></div>`}`;
}

async function pageChat(r) {
  const data = await api('GET', `/api/sessions/${encodeURIComponent(r.id)}/chat`);
  if (!isCurrentRoute(r)) return;
  const { session, runs } = data;
  const role = roleByKey(session.roleKey);
  const active = runs.find((run) => ACTIVE.has(run.status));
  const isEmployee = session.collaboration?.authority === 'employee';
  const controls = active ? `<button class="btn btn-sm" data-action="interrupt" data-run="${active.id}" data-mode="pause">暂停</button><button class="btn btn-sm btn-danger-ghost" data-action="interrupt" data-run="${active.id}" data-mode="stop">停止</button>` : '';
  const feed = runs.map((run) => `<section class="chat-turn" data-run-id="${run.id}"><div class="chat-turn-meta">${status(runStatus(run))}<span>${run.kind === 'inbox' ? '收件箱事件唤醒' : run.kind === 'team' ? '总经理派单' : '本人指令'} · ${clock(run.createdAt)}</span><a class="link" href="#/task/${run.id}">执行详情</a>${run.usage?.totalTokens ? `<span>${num(run.usage.totalTokens)} token</span>` : ''}</div>${(run.items.length ? run.items : [{ type: 'userMessage', id: run.id, text: run.prompt }]).map((item) => entryHtml(item, role, run.nativeOrigin, run.dispatcher)).join('')}${run.live ? [...Object.entries(run.live.messages || {})].map(([key, content]) => `<div class="entry entry-agent"><div class="entry-avatar">${roleAvatar(role, { size: 28, state: 'working' })}</div><div class="entry-body">${md(content)}</div></div>`).join('') : ''}${run.error ? `<div class="notice">${esc(run.error.message)}</div>` : ''}</section>`).join('');
  const composer = isEmployee ? `<div class="notice">由总经理安排任务，完成后主动汇报。<a class="link" href="#/team?namespace=${encodeURIComponent(session.collaboration.namespace)}">查看团队任务</a></div>` : active || runs.some((run) => run.status === 'queued') ? `<div class="chat-running">${roleAvatar(role, { size: 26, state: 'working' })}<span>正在处理本轮任务</span>${controls}</div>` : `<form class="composer composer-tall chat-composer" data-form="chat" data-session="${session.id}" data-stable><label class="sr-only" for="chat-prompt">交给${esc(role.roleTitle)}的任务</label><textarea id="chat-prompt" name="prompt" rows="3" required placeholder="写下目标、范围和交付要求…"></textarea><button class="btn btn-primary" type="submit">交给${esc(role.roleTitle)}</button></form>`;
  view.innerHTML = `<header class="chat-head"><div>${roleAvatar(role, { size: 48 })}<div>${roleLabel(role, { size: 'lg' })}<p class="muted small">${esc(S.setup?.mode === 'personal' ? S.setup.name : session.collaboration?.namespace || '独立岗位')} · 固定对话</p></div></div><div class="page-actions"><a class="btn btn-sm" href="#/role/${encodeURIComponent(role.key)}">岗位配置</a>${session.collaboration ? `<a class="btn btn-sm" href="#/team?namespace=${encodeURIComponent(session.collaboration.namespace)}">团队与收件箱</a>` : ''}${controls}</div></header><div class="chat-layout"><section class="feed chat-feed">${feed || empty('开始第一项任务', isEmployee ? '等待同组总经理派单。' : '交代目标，经理会安排员工执行。')}${composer}</section><aside class="stack">${card('协作能力', `<div class="chips">${(session.toolNames || []).map((name) => `<span class="chip">${esc({ yewang_team: '团队信息', yewang_dispatch: '真实派单', yewang_report: '主动回报', yewang_inbox: '收件箱', yewang_review: '验收', yewang_task_control: '停止续办', yewang_collaborate: '任务内协作' }[name] || name)}</span>`).join('')}</div><p class="muted small">Skill：${esc(role.skills.map((s) => s.name).join('、') || '未选择')}</p>`)}</aside></div>`;
}

async function pageTask(r) {
  const run = await api('GET', `/api/runs/${r.id}`);
  if (!isCurrentRoute(r)) return;
  S.run = run;
  view.innerHTML = taskDetailHtml(S.run);
}

function entryHtml(item, role, nativeOrigin = null, dispatcher = null) {
  switch (item.type) {
    case 'userMessage':
      return `<div class="entry entry-own"><div class="bubble"><div class="bubble-head">${nativeOrigin ? '原生经理派单' : dispatcher?.kind === 'workbench-team' ? '本组总经理派单' : dispatcher?.kind === 'inbox' ? '岗位收件箱' : '本人指令'}</div><div class="entry-body">${md(item.text)}</div>${item.skills?.length ? `<div class="chips">${item.skills.map((s) => `<span class="chip chip-skill">Skill · ${esc(s.name)}</span>`).join('')}</div>` : ''}</div></div>`;
    case 'agentMessage':
      return `<div class="entry entry-agent ${item.phase === 'final_answer' ? 'is-final' : 'is-commentary'}"><div class="entry-avatar">${roleAvatar(role, { size: 28, state: item.phase === 'final_answer' ? 'delivered' : 'working' })}</div><div class="entry-main"><div class="entry-head">${roleLabel(role, { project: false })}<span class="muted">${item.phase === 'final_answer' ? '最终回复' : '过程说明'}</span></div><div class="entry-body">${md(item.text)}</div></div></div>`;
    case 'reasoning':
      return item.summary ? `<div class="tool"><span class="tool-kind">思考</span><span class="tool-text">${esc(item.summary)}</span></div>` : '';
    case 'commandExecution': {
      const meta = item.status === 'inProgress' ? status(['运行中', 'running']) : item.status === 'interrupted' ? status(['执行中被中断', 'paused']) : item.status === 'declined' ? status(['已拒绝', 'neutral']) : `<span class="mono ${item.exitCode ? 'tone-text-error' : 'muted'}">exit ${item.exitCode ?? '—'}${item.durationMs != null ? ` · ${duration(item.durationMs)}` : ''}</span>`;
      return `<details class="tool" ${item.status === 'inProgress' ? 'open' : ''}><summary><span class="tool-kind">命令</span><code class="tool-code">${esc(String(item.command || '').replace(/^\/bin\/zsh -lc /, ''))}</code>${meta}</summary>${item.output ? `<pre class="code">${esc(item.output)}</pre>` : ''}<p class="small muted">${mono(item.cwd || '')}</p></details>`;
    }
    case 'fileChange':
      return `<details class="tool"><summary><span class="tool-kind kind-file">文件</span><span class="tool-code">${(item.changes || []).map((c) => `${esc({ add: '新增', delete: '删除', update: '修改' }[c.kind] || c.kind)} ${esc(c.path)}`).join('；')}</span><span class="muted small">${esc(item.status || '')}</span></summary>${(item.changes || []).map((c) => (c.diff ? `<pre class="code diff">${esc(c.diff)}</pre>` : '')).join('')}</details>`;
    case 'mcpToolCall':
      return `<div class="tool"><span class="tool-kind">工具</span><code class="tool-code">${esc(item.server)}.${esc(item.tool)}</code><span class="muted small">${esc(item.status || '')}${item.error ? ` · ${esc(item.error)}` : ''}</span></div>`;
    case 'dynamicToolCall':
      return `<div class="tool"><span class="tool-kind kind-file">岗位协作</span><span class="tool-code">${esc({ yewang_team: '读取团队与任务', yewang_dispatch: '提交员工派单', yewang_report: '主动回报', yewang_inbox: '读取经理收件箱', yewang_review: '核验与验收', yewang_task_control: '暂停或续办', yewang_collaborate: '任务内协作' }[item.tool] || item.tool)}</span><span class="muted small">${item.success === false ? '未成功' : esc(item.status || '')}</span></div>`;
    case 'webSearch':
      return `<div class="tool"><span class="tool-kind">搜索</span><span class="tool-code">${esc(item.query)}</span></div>`;
    case 'plan':
      return `<div class="tool"><span class="tool-kind">计划</span><span class="tool-text">${esc(item.text)}</span></div>`;
    default:
      return `<div class="tool"><span class="tool-kind">${esc(item.type)}</span><span class="muted small">${esc(item.status || item.tool || '')}</span></div>`;
  }
}

const seenItems = new Set();
function markFresh(id, html) {
  if (!html || seenItems.has(id)) return html;
  seenItems.add(id);
  return html.replace(/^<(div|details|article) class="/, '<$1 class="fresh ');
}

function taskDetailHtml(run) {
  const role = roleByKey(run.roleKey);
  const session = sessionById(run.sessionId);
  const active = ACTIVE.has(run.status);
  const formal = Boolean(run.nativeOrigin);
  const [label, tone] = runStatus(run);
  const actions = active || run.status === 'queued'
    ? `<button class="btn" data-action="interrupt" data-mode="pause" data-run="${run.id}">${icon(ICONS.pause, 14)}暂停</button><button class="btn btn-danger-ghost" data-action="interrupt" data-mode="stop" data-run="${run.id}">${icon(ICONS.stop, 14)}停止</button>`
    : formal ? '<a class="btn" href="#/sessions?tab=migration">查看原生接管</a>' : `<a class="btn" href="${role?.collaboration?.authority === 'employee' ? '#/manager' : '#/chat/' + run.sessionId}">${role?.collaboration?.authority === 'employee' ? '联系总经理' : '继续对话'}</a>`;
  const live = run.live || { messages: {}, outputs: {}, inflight: [] };
  const inflight = (live.inflight || []).map((item) => entryHtml({ ...item, output: live.outputs?.[item.id] || item.output }, role)).join('');
  const liveMessages = Object.entries(live.messages || {}).map(([itemId, text]) => `<div class="entry entry-agent"><div class="entry-avatar">${roleAvatar(role, { size: 28, state: 'working' })}</div><div class="entry-main"><div class="entry-head">${roleLabel(role, { project: false })}<span class="muted">正在回复</span></div><div class="entry-body live-text" data-live="${esc(itemId)}">${esc(text)}</div></div></div>`).join('');
  const pendingApprovals = (run.approvals || []).filter((a) => a.status === 'pending');
  const claim = run.claimCheck
    ? run.claimCheck.kind === 'actions_observed'
      ? `<p class="verify tone-text-done">${status(['已核验', 'done'])}本轮观察到 ${run.counts.commands} 条命令、${run.counts.fileChanges} 次文件修改、${run.counts.toolCalls} 次工具调用</p>`
      : `<p class="verify tone-text-waiting">${status(['未见实际动作', 'waiting'])}${esc(run.claimCheck.note)}</p>`
    : '';
  let composer = '';
  if (active) composer = `<form class="composer" data-form="steer" data-run="${run.id}"><input type="text" name="text" placeholder="追加指令到正在执行的这一轮…" autocomplete="off" aria-label="追加指令"><button class="btn btn-primary btn-sm">追加</button></form>`;
  else if (run.status === 'interrupted' && run.stopMode !== 'stop') composer = `<div class="takeover"><div><strong>任务已暂停。</strong><span>继续任务后，会在同一 Codex 会话里接着执行。</span></div><button class="btn btn-sm btn-warning" data-action="continue" data-session="${run.sessionId}">${icon(ICONS.play, 13)}继续任务</button></div>`;
  else if (run.status !== 'queued') composer = `<form class="composer composer-tall" data-form="continue" data-session="${run.sessionId}"><textarea name="prompt" rows="2" placeholder="在同一会话继续派单…" aria-label="继续派单"></textarea><button class="btn btn-primary btn-sm">派单</button></form>`;
  if (formal) composer = `<div class="notice">正式岗位的追加或续办由新的原生经理入站核验后执行。<a class="link" href="#/sessions?tab=migration">查看接管准备</a></div>`;
  if (run.teamTaskId) composer = `<div class="notice">本轮属于团队任务，暂停和续办由团队任务控制。<a class="link" href="#/team">查看团队与收件箱</a></div>`;
  const skills = run.skills?.length
    ? run.skills.map((s) => { const echoed = run.skillEvidence?.injected?.some((i) => i.path === s.path); return `<li><span class="skill-name">${esc(s.name)}</span>${echoed ? status(['本轮已接收', 'done']) : active ? status(['等待回显', 'queued']) : status(['未见回显', 'waiting'])}<span class="mono small muted">sha256 ${esc((s.sha256 || '').slice(0, 12))}</span></li>`; }).join('')
    : '<li class="muted small">本轮未选择 Skill</li>';
  return `<header class="task-head ${active ? 'is-live' : ''}">
      <div class="task-titles"><h1 class="task-title">${esc(taskTitle(run))}</h1><div class="task-meta">${status([label, tone], run.status === 'interrupted' && run.stopMode ? STOP_MODE[run.stopMode] : '')}${roleChip(role, { avatar: 20 })}<span class="muted small">${run.kind === 'continue' ? '继续' : '派单'} · ${timeAgo(run.createdAt)}</span></div></div>
      <div class="page-actions">${actions}</div>
    </header>
    <div class="task-layout">
      <section class="feed" aria-label="执行记录">
        ${(run.items || []).map((item) => markFresh(item.id, entryHtml(item, role, run.nativeOrigin, run.dispatcher))).join('')}
        <div class="feed-live">${inflight}${liveMessages}</div>
        ${run.status === 'starting' || run.status === 'queued' ? `<div class="feed-wait">${status([run.status === 'queued' ? '等待运行容量' : '正在连接 Codex 会话', run.status === 'queued' ? 'queued' : 'running'])}</div>` : ''}
        ${pendingApprovals.map(approvalCard).join('')}
        ${run.finalText && !active ? `<article class="result"><header>${roleAvatar(role, { size: 24, state: 'delivered' })}<span>结果回传</span><span class="muted">${roleLabel(role, { project: false, size: 'sm' })}<i class="connection-line" aria-hidden="true"></i> 控制台</span><span class="mono muted small">${clock(run.returnedAt)}</span></header><div class="entry-body">${md(run.finalText)}</div>${claim}</article>` : claim}
        ${formal ? `<div class="notice">原生回传：${run.nativeReport?.submissionVerified ? '已提交总经理，尚未确认经理执行' : run.nativeReport?.status === 'delivery_unknown' ? '发送结果待核对，未自动重发' : run.nativeReport ? '等待原生通道发送' : '等待本轮结果'}${run.nativeReport?.error ? ` · ${esc(run.nativeReport.error.message)}` : ''}</div>` : ''}
        ${run.error ? `<div class="error-box" role="alert"><strong>执行错误</strong><p>${esc(run.error.message)}${run.error.code != null ? `（${esc(run.error.code)}）` : ''}</p></div>` : ''}
        ${(run.errors || []).map((e) => `<div class="notice">${esc(e.message)}${e.willRetry ? '（Codex 将自动重试）' : ''}</div>`).join('')}
        ${composer}
      </section>
      <aside class="props-panel">
        <details class="task-original"><summary>原始需求</summary><pre>${esc(run.prompt || '')}</pre></details>
        <dl class="props">
          <dt>状态</dt><dd>${status([label, tone])}</dd>
          <dt>负责岗位</dt><dd>${roleChip(role, { avatar: 20 })}</dd>
          <dt>任务编号</dt><dd>${mono(run.id)}</dd>${run.teamTaskId ? `<dt>协作任务</dt><dd>${mono(run.teamTaskId)}</dd>` : ''}<dt>派单方</dt><dd>${esc(run.dispatcher?.label || '控制台')}</dd>
          <dt>会话</dt><dd>${session ? `<a href="#/sessions" class="ellipsis">${esc(session.title)}</a>` : '—'}</dd>
          <dt>Codex 会话</dt><dd>${mono(run.threadId ? `${run.threadId.slice(0, 13)}…` : '—', run.threadId)}</dd>
          <dt>本轮 ID</dt><dd>${mono(run.turnId ? `${run.turnId.slice(0, 13)}…` : '—', run.turnId)}</dd>
          <dt>工作目录</dt><dd>${mono(session ? `…/${session.cwd.split('/').slice(-2).join('/')}` : '—', session?.cwd)}</dd>
          <dt>模型</dt><dd>${esc(run.model || session?.model || '默认')} · ${esc(run.effort || '')}</dd>
          <dt>权限</dt><dd>${esc(session?.sandbox || '—')} · 审批 ${esc(session?.approvalPolicy || '—')}</dd>
          <dt>开始</dt><dd>${mono(clock(run.startedAt || run.createdAt))}</dd>
          <dt>用时</dt><dd>${mono(run.durationMs != null ? duration(run.durationMs) : active ? '进行中' : '—')}</dd>
          ${run.resumedThread ? '<dt>续接</dt><dd>本轮先从磁盘续接会话</dd>' : ''}
        </dl>
        <div class="props-section"><h3>token 用量</h3>${run.usage ? `<dl class="props compact"><dt>合计</dt><dd class="mono strong">${num(run.usage.totalTokens)}</dd><dt>输入</dt><dd class="mono">${num(run.usage.inputTokens)}</dd><dt>缓存</dt><dd class="mono">${num(run.usage.cachedInputTokens)}</dd><dt>输出</dt><dd class="mono">${num(run.usage.outputTokens)}</dd><dt>费用</dt><dd class="muted">口径未知，不估算</dd></dl>` : '<p class="muted small">尚未收到用量事件</p>'}</div>
        <div class="props-section"><h3>技能使用记录</h3><ul class="skill-evidence">${skills}</ul></div>
        ${run.steers?.length ? `<div class="props-section"><h3>追加指令</h3>${run.steers.map((s) => `<p class="small">${esc(s.text)}<br><span class="mono muted">${clock(s.at)}</span></p>`).join('')}</div>` : ''}
      </aside>
    </div>`;
}

const MIGRATION_STATUS = {
  prepared: ['已准备映射', 'queued'], writer_ready: ['占用检查通过', 'done'], writer_blocked: ['桌面占用中', 'waiting'],
  bridge_blocked: ['待接通原生通道', 'waiting'], active: ['已接管', 'done'], rolled_back: ['已撤回', 'neutral'],
  runtime_released: ['运行端已释放', 'paused'], release_failed: ['释放失败', 'error'],
};
async function pageMigrations(r, sub, tabs) {
  const data = await api('GET', '/api/migrations');
  if (!isCurrentRoute(r)) return;
  const cards = S.roles.filter((role) => role.source === 'company').map((role) => {
    const plan = data.plans.find((p) => p.roleKey === role.key);
    const state = plan ? MIGRATION_STATUS[plan.state] || [plan.state, 'neutral'] : ['未准备', 'neutral'];
    const writer = plan?.state === 'active' ? '公司团队' : plan?.writerProbe?.ok && plan.writerProbe.released ? '已检查并释放' : plan?.writerProbe?.code === -32600 && plan.writerProbe.message?.includes('active writer') ? '桌面仍在使用此会话' : plan?.writerProbe?.message || '尚未检查';
    const linked = Boolean(plan && plan.state !== 'rolled_back');
    return `<article class="migration-card card"><header class="migration-card-head">${roleAvatar(role, { size: 40 })}<span>${roleLabel(role, { size: 'lg' })}${status(state)}</span></header>
      <dl class="props compact"><dt>原会话</dt><dd>${mono(`${role.nativeThreadId.slice(0, 13)}…`, role.nativeThreadId)}</dd><dt>映射方式</dt><dd>保留同一会话 ID</dd><dt>写入占用</dt><dd class="migration-reason">${esc(writer)}</dd><dt>原生通道</dt><dd>${data.bridge.ready ? '已接入 · 每次校验来源' : '尚未接入'}</dd>${plan?.sessionId ? `<dt>运行会话</dt><dd>${mono(plan.sessionId)}</dd>` : ''}</dl>
      ${plan?.blockedReason ? `<p class="migration-reason muted small" title="${esc(plan.blockedReason)}">${plan.blockedReason.includes('原生宿主') ? '原生聊天通道尚未接入，暂不能核验岗位来源与回传结果。' : esc(plan.blockedReason)}</p>` : ''}
      <footer class="migration-actions"><span class="chip">旧原生岗位 · 未切换</span>${linked ? `<button class="btn btn-sm" data-action="migration-rollback" data-migration="${plan.id}">撤回历史准备${plan.state === 'active' ? '与接管' : ''}</button>` : ''}</footer>
      ${plan?.state === 'active' ? `<form class="native-dispatch-form" data-form="native-dispatch" data-migration="${plan.id}"><label class="field"><span>原生经理入站 ID</span><input name="messageId" required placeholder="使用原生派单条目的 ID"></label><label class="field"><span>任务编号</span><input name="taskId" required placeholder="T20000101-001"></label><button class="btn btn-sm btn-primary">核验原生派单并执行</button></form>` : ''}
    </article>`;
  }).join('');
  view.innerHTML = `${pageHead('会话', '历史岗位记录保留，新的工作从 AI 团队开始。')}${tabs}<div class="migration-intro"><div>${icon(ICONS.sessions, 22)}<strong>历史映射 · 未切换</strong></div><p>旧聊天的历史、ID 和正式组织路由保留。续接探测结果不代表协作工具或主动回报已经接通。</p><p class="muted small">新工作请在岗位协作中建立独立测试组。</p><a class="btn btn-sm" href="#/team">进入岗位协作</a></div><div class="migration-grid">${cards}</div>
    ${card('原生结果回传', data.reports.length ? `<div class="mini-list">${data.reports.map((report) => `<div class="native-report-row">${roleChip(roleByKey(report.roleKey), { project: false })}<span>${{ pending: '待原生发送', sending: '发送中', submitted: '已提交 · 尚未确认经理执行', delivery_unknown: '提交状态未知 · 不自动重发' }[report.status] || report.status}</span><a class="mono link" href="#/task/${report.runId}">${esc(report.runId.slice(-8))}</a></div>`).join('')}</div>` : empty('暂无原生回传记录', '正式接管的运行结束后，在这里保留来源、目标和实际发送凭据。'))}`;
}

async function pageSessions(r) {
  const personal = S.setup?.mode === 'personal';
  const tab = personal ? 'runner' : r.query.get('tab') || 'runner';
  const sub = tab === 'migration' ? '保存原会话映射，单独核对占用与原生回传通道，具备条件后接管；随时可以撤回。' : tab === 'desktop' ? '通讯录登记的固定岗位聊天由桌面端持有：可只读查看；原地接管需桌面端先释放写入。' : '每个岗位的固定对话，可继续、改名或归档。';
  const tabs = `<div class="tabs" role="tablist"><a role="tab" aria-selected="${tab === 'runner'}" class="tab ${tab === 'runner' ? 'active' : ''}" href="#/sessions?tab=runner">员工对话<span class="tab-count">${S.sessions.length}</span></a>${personal ? '' : `<a role="tab" aria-selected="${tab === 'desktop'}" class="tab ${tab === 'desktop' ? 'active' : ''}" href="#/sessions?tab=desktop">桌面固定岗位会话</a><a role="tab" aria-selected="${tab === 'migration'}" class="tab ${tab === 'migration' ? 'active' : ''}" href="#/sessions?tab=migration">接管准备</a>`}</div>`;
  if (tab === 'migration') return pageMigrations(r, sub, tabs);
  if (tab === 'desktop') {
    view.innerHTML = `${pageHead('会话', sub)}${tabs}${card('', skeleton(6), { cls: 'flush' })}`;
    const data = await api('GET', '/api/desktop-sessions');
    if (!isCurrentRoute(r)) return;
    view.innerHTML = `${pageHead('会话', sub)}${tabs}
      ${card('', `<div class="table desk-table"><div class="thead"><span>岗位</span><span>会话 ID</span><span>来源 · 状态</span><span>更新</span><span>原地接管</span><span class="right">操作</span></div>${data.sessions.map((s) => {
        const role = roleByKey(s.roleKey);
        const probe = data.probes?.[s.threadId];
        const probeCell = probe ? (probe.ok ? status(['可接管', 'done']) : `<span class="ellipsis" title="${esc(probe.message)}">${status(['被占用', 'waiting'], probe.code ?? '')}</span>`) : '<span class="muted small">未检查</span>';
        return `<div class="row"><span>${roleChip(role)}</span><span>${mono(s.threadId)}</span><span class="small">${s.readable ? `${esc(s.source || '')} · ${esc(s.status?.type || '')}` : `<span class="tone-text-error">${esc(s.error?.message || '不可读')}</span>`}</span><span class="small muted">${timeAgo(s.updatedAt)}</span><span class="chip">旧原生岗位 · 未切换</span><span class="row-actions"><button class="btn btn-xs" data-action="desk-preview" data-thread="${esc(s.threadId)}">最近记录</button></span></div><div class="desk-preview" data-preview="${esc(s.threadId)}"></div>`;
      }).join('')}</div>`, { cls: 'flush' })}
      <p class="muted small">“检查接管”会向 Codex 发起一次续接：被桌面端占用时返回 active writer；若成功会立即释放，不发送任何消息。</p>`;
    return;
  }
  const rows = S.sessions.map((s) => {
    const role = roleByKey(s.roleKey);
    const ops = s.source === 'native-migrated' ? '<a class="btn btn-xs" href="#/sessions?tab=migration">接管详情</a>' : s.archived ? '' : `<a class="btn btn-xs" href="#/chat/${s.id}">聊天</a>${!s.collaboration ? `<a class="btn btn-xs" href="#/chat/${s.id}">派单</a>` : ''}<button class="btn btn-xs" data-action="rename" data-session="${s.id}">改名</button><button class="btn btn-xs btn-ghost" data-action="archive" data-session="${s.id}">归档</button>`;
    return `<div class="row ${s.archived ? 'is-dim' : ''}"><span class="cell-stack"><a class="strong ellipsis" href="${s.collaboration || !s.lastRunId ? `#/chat/${s.id}` : `#/task/${s.lastRunId}`}">${esc(s.title)}</a>${mono(`${s.threadId.slice(0, 13)}…`, s.threadId)}</span><span>${roleChip(role, { project: false })}</span><span>${status(sessionStatus(s.status))}</span><span>${mono(`…/${s.cwd.split('/').slice(-2).join('/')}`, s.cwd)}</span><span class="mono right">${s.usageTotal ? num(s.usageTotal.totalTokens) : '—'}</span><span class="small muted">${timeAgo(s.updatedAt)}</span><span class="row-actions">${ops}</span></div>`;
  }).join('');
  view.innerHTML = `${pageHead('会话', sub, personal ? '<a class="btn" href="#/roles">管理岗位</a>' : `<a class="btn btn-primary" href="#/dispatch">${icon(ICONS.plus, 15)}新建对话</a>`)}${tabs}
    ${card('', S.sessions.length ? `<div class="table sess-table"><div class="thead"><span>会话</span><span>负责岗位</span><span>状态</span><span>工作目录</span><span class="right">累计 token</span><span>更新</span><span class="right">操作</span></div>${rows}</div>` : empty('还没有员工对话', '交代任务时会自动创建会话。', `<a class="btn btn-primary btn-sm" href="#/dispatch">${icon(ICONS.plus, 14)}交代任务</a>`), { cls: 'flush' })}`;
}

function roleCard(role) { return teamRoleCard(role, roleActionHref(role)); }

function appearanceFields(current = {}) {
  return `<fieldset class="appearance"><legend>岗位形象</legend>
    <div class="appearance-preview"><span class="avatar" data-appearance-preview data-pose="rest">${capFigure({ ...paletteColors(current.palette), emblem: current.emblem }, { size: 64, motionKey: current.palette })}</span><span><strong>岗位人物</strong><small>选择配色与职业标识，立即预览</small></span></div>
    <div class="motion-preview" role="group" aria-label="人物动作预览">${[['rest', '待命'], ['working', '工作'], ['thinking', '思考'], ['loading', '等待'], ['sleepy', '暂停'], ['success', '完成'], ['confused', '出错']].map(([pose, label]) => `<button type="button" class="motion-option ${pose === 'rest' ? 'active' : ''}" data-preview-pose="${pose}" aria-pressed="${pose === 'rest'}">${label}</button>`).join('')}</div>
    <div class="swatches" role="radiogroup" aria-label="配色">${S.choices.palettes.map((p) => `<label class="swatch" title="${esc(p)}"><input type="radio" name="palette" value="${esc(p)}" ${p === current.palette ? 'checked' : ''}><span>${capFigure({ ...paletteColors(p), emblem: current.emblem }, { size: 30, emblem: false })}</span></label>`).join('')}</div>
    <div class="emblems" role="radiogroup" aria-label="职业标识">${S.choices.emblems.map((e) => `<label class="emblem-opt"><input type="radio" name="emblem" value="${esc(e)}" ${e === current.emblem ? 'checked' : ''}><span>${emblemIcon(e, 15)}${esc(EMBLEM_LABEL[e] || e)}</span></label>`).join('')}</div>
  </fieldset>`;
}
const PALETTE_CACHE = {};
function paletteColors(p) {
  if (PALETTE_CACHE[p]) return PALETTE_CACHE[p];
  const role = S.roles.find((r) => r.appearance.palette === p);
  return role ? { a: role.appearance.a, b: role.appearance.b } : PALETTE_FALLBACK[p] || {};
}
const PALETTE_FALLBACK = {
  'bubblegum-sky': { a: '#8bd4ff', b: '#ff51bf' }, 'pink-lemonade': { a: '#ff26a8', b: '#fff78a' }, 'orchid-peach': { a: '#e771ff', b: '#ffd87c' }, 'coral-mint': { a: '#beffe8', b: '#ff797b' },
  'lime-lagoon': { a: '#b4ffa4', b: '#26dfff' }, 'arctic-blue': { a: '#97fff3', b: '#0084ff' }, 'solar-flare': { a: '#ecca5c', b: '#fe3c3f' }, 'violet-ember': { a: '#ff5c43', b: '#6262ff' },
  'deep-tide': { a: '#003d60', b: '#32fffc' }, 'coral-current': { a: '#26e2ff', b: '#ff6666' }, 'golden-hour': { a: '#ffcd4f', b: '#fde5ba' }, 'tangerine-cobalt': { a: '#ffad32', b: '#4169ff' },
  'electric-grove': { a: '#b4ff32', b: '#008d58' }, 'flamingo-jade': { a: '#ff4f9a', b: '#36edaa' }, 'cherry-pop': { a: '#ff69db', b: '#d51c46' }, 'turquoise-cherry': { a: '#37f0db', b: '#ff4f64' }, 'ultraviolet-tide': { a: '#7516cf', b: '#00e8d1' },
};

async function pageRoles() {
  const personal = S.setup?.mode === 'personal';
  const dialog = personal ? employeeDialogHtml(S.setup, appearanceFields({ palette: 'arctic-blue', emblem: 'code' })) : `<dialog id="role-dialog"><form data-form="new-role" class="dialog-form"><h2>新增岗位</h2>
      <div class="form-row"><label class="field"><span>岗位名称</span><input name="title" required maxlength="40" placeholder="例如：测试工程师"></label><label class="field"><span>成员姓名</span><input name="name" required maxlength="24"></label></div>
      <label class="field"><span>岗位说明</span><input name="description" maxlength="400" placeholder="一句话说明负责什么"></label>
      <label class="field"><span>运行指令</span><textarea name="instructions" rows="3" maxlength="4000" placeholder="写给该岗位运行会话的长期工作要求"></textarea></label>
      ${appearanceFields({ palette: S.choices.palettes[11], emblem: 'spark' })}
      <div class="form-row"><label class="field"><span>协作身份</span><select name="authority"><option value="none">独立岗位</option><option value="manager">测试总经理</option><option value="employee">测试员工</option></select></label><label class="field"><span>所属测试组</span><input name="namespace" maxlength="37" placeholder="test-t004"></label></div>
      <p class="muted small">先创建测试总经理，再添加同组员工。协作岗位自动建立稳定聊天，任务由本组总经理派发。</p>
      <footer class="form-foot"><button class="btn" type="button" data-action="close-dialog">取消</button><span class="spacer"></span><button class="btn btn-primary">保存岗位</button></footer></form></dialog>`;
  view.innerHTML = `${pageHead('人员与岗位', '经理安排任务，员工按各自职责执行。', `<button class="btn btn-primary" data-action="new-role">${icon(ICONS.plus, 15)}新增岗位</button>`)}
    <div class="org-summary"><span><b>${S.roles.length}</b> 个岗位</span><span>线路表示已绑定的汇报关系</span><a class="link" href="#/manager">交代任务给经理</a></div>
    ${organizationHtml(S.roles, S.collaboration.groups, roleCard)}${dialog}`;
}

async function loadWorkspaces() {
  if (!S.workspaces) S.workspaces = (await api('GET', '/api/workspaces')).workspaces;
  return S.workspaces;
}
async function loadModels() {
  if (!S.models) S.models = (await api('GET', '/api/models').catch(() => ({ models: [] }))).models;
  return S.models;
}
const select = (name, label, options, value) => `<label class="field"><span>${label}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const workspaceSelect = (list, value) => select('cwd', '工作目录', [...list.map((w) => [w.path, w.label]), ...(value && !list.some((w) => w.path === value) ? [[value, value]] : [])], value);
const modelSelect = (list, value) => select('model', '模型', [['', '账号默认模型'], ...list.map((m) => [m.id, `${m.displayName}${m.isDefault ? '（默认）' : ''}`])], value || '');
const effortSelect = (value) => select('effort', '思考强度', [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']], value);
const sandboxSelect = (value) => select('sandbox', '文件权限', [['workspace-write', '仅工作目录可写'], ['read-only', '只读'], ['danger-full-access', '完全访问（谨慎）']], value);
const approvalSelect = (value) => select('approvalPolicy', '审批', [['on-request', 'Codex 需要时请求'], ['untrusted', '写操作都需审批'], ['never', '不请求审批']], value);
const skillFilter = (count) => `<div class="skill-filter"><input type="search" data-skill-filter aria-label="搜索 Skill" placeholder="搜索名称或用途"><span class="muted small" data-skill-match-count>${count} 个可用</span></div><p class="muted small hidden" data-skill-empty>没有匹配的 Skill，换一个关键词试试。</p>`;

async function pageRole(r, { quiet = false } = {}) {
  const role = roleByKey(r.id);
  if (!role || role.key === 'console') {
    view.innerHTML = `${pageHead('岗位不存在')}${card('', empty('没有找到这个岗位', '它可能已被移除。', '<a class="btn btn-sm" href="#/roles">返回岗位列表</a>'))}`;
    return;
  }
  if (role.source === 'company') {
    const html = `<header class="role-hero" style="--a:${role.appearance.a};--b:${role.appearance.b}">${roleAvatar(role, { size: 88 })}<div class="role-hero-text"><div class="eyebrow">${esc(role.deptLabel)}</div>${roleLabel(role, { size: 'xl' })}<p class="page-sub">${esc(role.description)}</p><div class="role-hero-meta">${status(roleStatus(role.liveState))}<span class="chip">原生桌面岗位</span></div></div><div class="page-actions"><a class="btn btn-primary" href="${roleActionHref(role)}">${role.key === 'general_manager' ? '与经理对话' : '协作过程'}</a></div></header>
      <div class="detail-layout"><section class="stack">${card('桌面活动', nativeRoleTaskHtml(role))}${card('职责与协作', `<p class="small">${esc(role.description)}</p><p class="muted small">正式任务由总经理原生派发；当前桌面会话沿用原有运行配置与 Skill。</p><a class="btn btn-sm" href="#/manager">联系总经理</a>`)}</section><aside class="stack">${card('原生档案', `<dl class="props"><dt>岗位</dt><dd>${esc(role.roleTitle)}</dd><dt>姓名</dt><dd>${esc(role.name)}</dd><dt>聊天</dt><dd>${mono(role.nativeThreadId)}</dd><dt>连接</dt><dd>${role.nativeActivity?.ready ? '桌面会话已连接' : '未取得桌面快照'}</dd></dl>`)}${card('形象', `<form data-form="role-appearance" data-role="${esc(role.key)}">${appearanceFields(role.appearance)}<footer class="form-foot"><span class="spacer"></span><button class="btn btn-sm">保存形象</button></footer></form>`)}</aside></div>`;
    replaceView(html, { preserveAvatars: quiet });
    return;
  }
  const [skills, workspaces, models] = await Promise.all([api('GET', `/api/skills?cwd=${encodeURIComponent(role.defaults.cwd)}`), loadWorkspaces(), loadModels()]);
  if (!isCurrentRoute(r)) return;
  const chosen = new Set(role.skills.map((s) => s.path));
  const runs = S.runs.filter((x) => x.roleKey === role.key).slice(0, 8);
  const sessions = S.sessions.filter((s) => s.roleKey === role.key && !s.archived && !s.detached && s.source !== 'native-migrated');
  view.innerHTML = `<header class="role-hero" style="--a:${role.appearance.a};--b:${role.appearance.b}">${roleAvatar(role, { size: 88 })}<div class="role-hero-text"><div class="eyebrow">${esc(role.deptLabel || 'Crew')}</div>${roleLabel(role, { size: 'xl' })}<p class="page-sub">职责、技能与运行设置</p><div class="role-hero-meta">${status(roleStatus(role.liveState))}<span class="chip">${esc(role.deptLabel || '')}</span><span class="chip">${role.source === 'local' ? 'AI 岗位' : '公司岗位'}</span></div></div><div class="page-actions"><a class="btn btn-primary" href="${roleActionHref(role)}">${icon(ICONS.plus, 15)}${role.source === 'company' ? '协作过程' : role.stableSessionId ? '聊天' : '派单'}</a></div></header>
    <div class="detail-layout" data-stable>
      <div class="stack">
        ${card('岗位职责', `<form data-form="role-profile" data-role="${esc(role.key)}"><div class="form-row"><label class="field"><span>岗位名称</span><input name="title" maxlength="40" required value="${esc(role.roleTitle)}"></label><label class="field"><span>成员姓名</span><input name="name" maxlength="24" required value="${esc(role.name)}"></label></div><label class="field"><span>完整职责与长期要求</span><textarea name="instructions" rows="7" maxlength="4000" required>${esc(role.instructions || role.description)}</textarea></label><footer class="form-foot"><span class="muted small">下次执行时生效，沿用原会话。</span><span class="spacer"></span><button class="btn btn-primary btn-sm">保存职责</button></footer></form>`)}
        ${card('岗位技能（Skill）', `<p class="muted small">为岗位选择工作方法，下次执行任务时使用。</p><form data-form="role-skills" data-role="${esc(role.key)}">${skillFilter(skills.skills.length)}<div class="skill-list skill-list-scroll" data-skill-list>${skills.skills.map((s) => `<label class="skill-item ${s.enabled ? '' : 'is-dim'}"><input type="checkbox" name="skill" value="${esc(s.path)}" data-name="${esc(s.name)}" ${chosen.has(s.path) ? 'checked' : ''} ${s.enabled ? '' : 'disabled'}><span><strong>${esc(s.name)}</strong><small>${esc(s.description || '')}</small></span></label>`).join('')}</div><footer class="form-foot"><span class="muted small" data-skill-selection-count>已选 ${chosen.size} 个</span><span class="spacer"></span><button class="btn btn-primary btn-sm">保存 Skill</button></footer></form>`)}
        ${card('默认运行参数', `<form data-form="role-defaults" data-role="${esc(role.key)}"><div class="form-grid">${workspaceSelect(workspaces, role.defaults.cwd)}${modelSelect(models, role.defaults.model)}${effortSelect(role.defaults.effort)}${sandboxSelect(role.defaults.sandbox)}${approvalSelect(role.defaults.approvalPolicy)}</div><footer class="form-foot"><span class="spacer"></span><button class="btn btn-primary btn-sm">保存参数</button></footer></form>`)}
        ${role.source === 'company' ? card('桌面活动', nativeRoleTaskHtml(role)) : ''}
        ${card(role.source === 'company' ? '独立运行记录' : '最近任务', taskList(runs, empty('这个岗位还没有任务', '', `<a class="btn btn-sm btn-primary" href="${roleActionHref(role)}">${role.source === 'company' ? '协作过程' : role.stableSessionId ? '聊天' : '派单'}</a>`)), { cls: 'flush' })}
      </div>
      <aside class="stack">
        ${card('档案', `<dl class="props"><dt>岗位</dt><dd>${esc(role.roleTitle)}</dd><dt>姓名</dt><dd>${esc(role.name)}</dd>${role.project ? `<dt>负责项目</dt><dd>${esc(role.project)}</dd>` : ''}<dt>来源</dt><dd>${role.source === 'local' ? 'AI 岗位' : '通讯录 + 岗位档案'}</dd>${role.nativeThreadId ? `<dt>固定聊天</dt><dd>${mono(`${role.nativeThreadId.slice(0, 13)}…`, role.nativeThreadId)}</dd>` : ''}${role.nativeStatus ? `<dt>原生任务</dt><dd>${esc(role.nativeStatus.taskId)} · ${esc(NATIVE_STATUS[role.nativeStatus.status] || role.nativeStatus.status)}</dd>` : ''}</dl><p class="muted small">${role.collaboration ? `所属公司： ${S.setup?.mode === 'personal' ? esc(S.setup.name) : esc(role.collaboration.namespace) + ' 独立测试组'}。` : `公司岗位沿用当前原生桌面会话，任务由总经理派发。`}</p>`)}
        ${card('形象', `<form data-form="role-appearance" data-role="${esc(role.key)}">${appearanceFields(role.appearance)}<footer class="form-foot"><span class="spacer"></span><button class="btn btn-sm">保存形象</button></footer></form>`)}
        ${card('岗位聊天', sessions.length ? `<div class="mini-list">${sessions.map((s) => `<a class="mini-row" href="#/chat/${s.id}"><span class="ellipsis">${esc(s.title)}</span>${status(sessionStatus(s.status))}</a>`).join('')}</div>` : empty('暂无会话', '首次派单时会自动创建。'))}
      </aside>
    </div>`;
}

async function pageDispatch(r) {
  const presetSession = r.query.get('session') ? sessionById(r.query.get('session')) : null;
  const roleKey = presetSession?.roleKey || r.query.get('role') || S.roles.find((x) => x.source === 'local')?.key || S.roles[0]?.key;
  const role = roleByKey(roleKey);
  if (role?.source === 'company') {
    view.innerHTML = `${pageHead('交代任务', '旧原生岗位保留历史，本阶段请新建AI 岗位。')}${card('', empty('先添加一位员工', '创建本组测试总经理与员工，再通过总经理聊天派单。', '<a class="btn btn-primary btn-sm" href="#/roles">建立岗位</a>'))}`;
    return;
  }
  const [workspaces, models] = await Promise.all([loadWorkspaces(), loadModels()]);
  if (!isCurrentRoute(r)) return;
  const sessions = S.sessions.filter((s) => s.roleKey === roleKey && !s.archived && !s.detached && s.source !== 'native-migrated');
  const sessionValue = presetSession?.id || (role?.collaboration && sessions[0]?.id) || 'new';
  const cwd = presetSession?.cwd || role?.defaults.cwd;
  view.innerHTML = `${pageHead('交代任务', '说清目标和交付要求，发送后开始执行。')}
    <form class="dispatch" data-form="dispatch" data-stable>
      <div class="dispatch-main card">
        <div class="assignee-pick">${roleAvatar(role, { size: 40 })}<label class="field grow"><span>负责岗位</span><select name="roleKey">${DEPT_ORDER.map((d) => { const list = S.roles.filter((x) => x.source === 'local' && (x.dept || 'workbench') === d); return list.length ? `<optgroup label="${esc(S.departments[d] || d)}">${list.map((x) => `<option value="${esc(x.key)}" ${x.key === roleKey ? 'selected' : ''}>${esc(`${x.roleTitle}｜${x.name}${x.project ? ` · ${x.project}` : ''}`)}</option>`).join('')}</optgroup>` : ''; }).join('')}</select></label></div>
        <label class="field"><span>会话</span><select name="sessionId"><option value="new">新建会话</option>${sessions.map((s) => `<option value="${s.id}" ${s.id === sessionValue ? 'selected' : ''} ${['running', 'waiting_approval'].includes(s.status) ? 'disabled' : ''}>${esc(s.title)}（${esc(sessionStatus(s.status)[0])}）</option>`).join('')}</select></label>
        <label class="field prompt-box"><span>你想做什么</span><textarea name="prompt" rows="8" required placeholder="想完成什么？希望交付什么？有哪些要求？">${esc(S.dispatchDraft || '')}</textarea></label>
        <div class="field"><span>Skill</span><div class="skill-picker" data-skill-picker>${skeleton(2)}</div></div>
      </div>
      <aside class="dispatch-side card">
        <h2>运行设置</h2>
        <div class="new-session ${sessionValue === 'new' ? '' : 'hidden'}"><label class="field"><span>会话名称</span><input name="title" placeholder="可选"></label>${workspaceSelect(workspaces, cwd)}${modelSelect(models, role?.defaults.model)}${sandboxSelect(role?.defaults.sandbox)}${approvalSelect(role?.defaults.approvalPolicy)}</div>
        ${effortSelect(role?.defaults.effort || 'low')}
        <label class="field"><span>任务来自</span><input name="dispatcherLabel" value="我" maxlength="20"></label>
        <p class="muted small">运行容量 ${S.overview?.maxConcurrent ?? 3}，超出会排队。</p>
      </aside>
      <footer class="form-foot dispatch-foot"><a class="btn" href="#/tasks" data-action="dispatch-cancel">取消</a><span class="spacer"></span><button class="btn btn-primary" type="submit">${icon(ICONS.play, 13)}派单并开始执行</button></footer>
    </form>`;
  await refreshSkillPicker();
}

async function refreshSkillPicker() {
  const form = view.querySelector('[data-form="dispatch"]');
  if (!form) return;
  const role = roleByKey(form.roleKey.value);
  const sessionId = form.sessionId.value;
  const cwd = sessionId === 'new' ? form.cwd.value : sessionById(sessionId)?.cwd;
  const picker = form.querySelector('[data-skill-picker]');
  try {
    const { skills } = await api('GET', `/api/skills?cwd=${encodeURIComponent(cwd)}`);
    const roleSkills = new Set((role?.skills || []).map((s) => s.path));
    const extra = skills.filter((s) => s.enabled && !roleSkills.has(s.path));
    picker.innerHTML = `${role?.skills?.length ? `<label class="skill-item is-role"><input type="checkbox" name="useRoleSkills" checked><span><strong>使用岗位技能（Skill）</strong><small>${role.skills.map((s) => esc(s.name)).join('、')}</small></span></label>` : '<p class="muted small">该岗位未配置默认 Skill，可为本次派单选择。</p>'}
      <details ${role?.skills?.length ? '' : 'open'}><summary>本次额外选择（${extra.length} 个可用）</summary>${skillFilter(extra.length)}<div class="skill-list skill-list-scroll" data-skill-list>${extra.map((s) => `<label class="skill-item"><input type="checkbox" name="extraSkill" value="${esc(s.path)}" data-name="${esc(s.name)}"><span><strong>${esc(s.name)}</strong><small>${esc(s.description || '')}</small></span></label>`).join('')}</div></details>`;
  } catch (error) {
    picker.innerHTML = errorBox(error.message);
  }
}

let officeObserver = null;
S.cam = { x: 0, y: 0, s: 1 };
function applyCam(animate = true) {
  const floor = document.getElementById('floor');
  if (!floor) return;
  floor.classList.toggle('no-anim', !animate || reduceMotion());
  floor.style.transform = `translate(${S.cam.x.toFixed(1)}px, ${S.cam.y.toFixed(1)}px) scale(${S.cam.s.toFixed(3)})`;
  const label = document.getElementById('cam-zoom');
  if (label) label.textContent = `${Math.round(S.cam.s * 100)}%`;
}
function constrainCam() {
  const floor = document.getElementById('floor'), canvas = floor?.parentElement;
  if (!canvas) return;
  const w = floor.offsetWidth * S.cam.s, h = floor.offsetHeight * S.cam.s;
  S.cam.x = w <= canvas.clientWidth ? (canvas.clientWidth - w) / 2 : Math.min(0, Math.max(canvas.clientWidth - w, S.cam.x));
  S.cam.y = h <= canvas.clientHeight ? (canvas.clientHeight - h) / 2 : Math.min(0, Math.max(canvas.clientHeight - h, S.cam.y));
}
function fitCam() {
  const floor = document.getElementById('floor');
  const canvas = floor?.parentElement;
  if (!floor || !canvas) return { x: 0, y: 0, s: 1 };
  const cw = canvas.clientWidth;
  const ch = Math.max(120, canvas.clientHeight - 56);
  const fw = floor.offsetWidth;
  const fh = floor.offsetHeight;
  const s = Math.min(1, cw / fw, ch / fh);
  return { s, x: (cw - fw * s) / 2, y: Math.max(0, (ch - fh * s) / 2) };
}
function focusCam(key) {
  const floor = document.getElementById('floor');
  const canvas = floor?.parentElement;
  const center = key ? nodeCenter(floor, key) : null;
  if (!center || !canvas) {
    S.cam = fitCam();
  } else {
    const s = Math.max(fitCam().s * 1.55, 1.05);
    S.cam = { s, x: canvas.clientWidth / 2 - center[0] * s, y: canvas.clientHeight * 0.38 - center[1] * s };
  }
  constrainCam();
  applyCam(true);
}
function bindCamera(canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.camera-hud')) return;
    drag = { x: e.clientX, y: e.clientY, cx: S.cam.x, cy: S.cam.y, moved: false, id: e.pointerId };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      canvas.setPointerCapture(drag.id);
      canvas.classList.add('dragging');
    }
    S.cam.x = drag.cx + dx;
    S.cam.y = drag.cy + dy;
    constrainCam();
    applyCam(false);
  });
  const end = () => {
    if (drag?.moved) {
      canvas.classList.remove('dragging');
      canvas.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const next = Math.min(2.2, Math.max(Math.min(0.3, fitCam().s / 2), S.cam.s * (1 - e.deltaY * 0.0018)));
    S.cam.x = mx - (mx - S.cam.x) * (next / S.cam.s);
    S.cam.y = my - (my - S.cam.y) * (next / S.cam.s);
    S.cam.s = next;
    constrainCam();
    applyCam(false);
  }, { passive: false });
}

async function pageOffice(r, { quiet = false } = {}) {
  const oldCanvas = document.getElementById('office-canvas');
  const oldCam = oldCanvas ? { ...S.cam } : null;
  const focus = r.query.get('focus') ?? S.office.focus;
  S.office.focus = focus || '';
  S.office.range = r.query.get('range') || S.office.range;
  const handoffs = (await api('GET', '/api/handoffs')).handoffs;
  if (!isCurrentRoute(r)) return;
  S.office.handoffs = handoffs;
  const { html, edges } = officeHtml({ roles: S.roles, runs: S.runs, overview: S.overview, handoffs, approvals: S.approvals, focusKey: S.office.focus, range: S.office.range });
  S.office.edges = edges;
  const focusRole = S.office.focus ? roleByKey(S.office.focus) : null;
  const rangeTabs = [['24h', '24 小时'], ['48h', '48 小时'], ['7d', '7 天']].map(([k, l]) => `<a class="seg ${S.office.range === k ? 'active' : ''}" href="#/office?range=${k}${S.office.focus ? `&focus=${encodeURIComponent(S.office.focus)}` : ''}">${l}</a>`).join('');
  const panel = officePanelHtml({ role: focusRole, roles: S.roles, edges, handoffs, overview: S.overview, range: S.office.range });
  const structure = JSON.stringify([S.office.focus, S.office.range, S.roles.map(({ key, name, roleTitle, appearance, dept }) => ({ key, name, roleTitle, appearance, dept }))]);
  const edgeSignature = JSON.stringify(edges);
  if (quiet && oldCanvas && S.office.structure === structure) {
    for (const role of S.roles) {
      const ws = oldCanvas.querySelector(`[data-node="${CSS.escape(role.key)}"]`);
      if (!ws || ws.dataset.state === role.liveState) continue;
      ws.classList.remove(`state-${ws.dataset.state}`);
      ws.classList.add(`state-${role.liveState}`);
      ws.dataset.state = role.liveState;
      ws.querySelector('.ws-person').innerHTML = roleAvatar(role, { size: 52 });
      ws.querySelector('.ws-status').innerHTML = status(roleStatus(role.liveState));
      ws.querySelector('.ws-monitor').className = `ws-monitor tone-${roleStatus(role.liveState)[1]}`;
    }
    const counts = S.overview?.counts || {};
    const hubCounts = oldCanvas.querySelectorAll('.hub-stats b');
    [counts.active, counts.waitingApproval, counts.queued].forEach((n, i) => { if (hubCounts[i]) hubCounts[i].textContent = n ?? 0; });
    if (!focusRole) {
      const strip = view.querySelector('.office-stats');
      if (strip) strip.innerHTML = panel.stats;
    } else {
      const aside = view.querySelector('.office-panel');
      if (aside) { aside.classList.add('no-enter'); aside.innerHTML = panel; }
    }
    if (S.office.edgeSignature !== edgeSignature) drawOfficeLines(document.getElementById('floor'), edges, S.office.focus, { particles: !reduceMotion() });
    S.office.edgeSignature = edgeSignature;
    return;
  }
  S.office.structure = structure;
  S.office.edgeSignature = edgeSignature;
  view.innerHTML = `${pageHead('办公室', '看团队当前状态与实际交接。点击工位聚焦，点击状态入口处理任务和审批。')}
    <div class="office-toolbar"><div class="segmented" role="group" aria-label="视图"><button class="seg ${focusRole ? '' : 'active'}" data-action="office-focus" data-role="">${icon(ICONS.overview, 14)}整体浏览</button><button class="seg ${focusRole ? 'active' : ''}" ${focusRole ? '' : 'disabled'}>${icon(ICONS.focus, 14)}${focusRole ? `聚焦：${esc(focusRole.roleTitle)}｜${esc(focusRole.name)}` : '聚焦岗位'}</button></div>${focusRole ? '<span class="spacer"></span>' : `<div class="office-stats">${panel.stats}</div>`}<div class="segmented" role="group" aria-label="时间范围">${rangeTabs}</div></div>
    <div class="office-role-picks" role="group" aria-label="岗位快捷聚焦">${S.roles.map((role) => `<button type="button" class="office-role-pick ${role.key === S.office.focus ? 'active' : ''}" data-action="office-focus" data-role="${esc(role.key)}" aria-pressed="${role.key === S.office.focus}">${roleAvatar(role, { size: 30 })}${roleLabel(role, { size: 'stack', project: false })}</button>`).join('')}</div>
    <div class="office-layout ${focusRole ? 'has-focus' : ''}"><div class="office-canvas" id="office-canvas">${html}<p class="office-routing-notice" data-routing-notice role="status" hidden></p><div class="camera-hud" role="group" aria-label="镜头"><button type="button" data-cam="out" aria-label="缩小">−</button><span id="cam-zoom">100%</span><button type="button" data-cam="in" aria-label="放大">+</button><button type="button" data-cam="fit" aria-label="适配视图">${icon(ICONS.focus, 14)}</button></div><div class="camera-hint">拖动平移 · ⌘ 滚轮缩放</div></div>${focusRole ? `<aside class="office-panel card" aria-live="polite">${panel}</aside>` : ''}</div>${officePanelHtml({ roles: S.roles, edges, handoffs, overview: S.overview, range: S.office.range }).legend}`;
  const floor = document.getElementById('floor');
  const canvas = document.getElementById('office-canvas');
  const redraw = () => drawOfficeLines(floor, S.office.edges, S.office.focus, { particles: !reduceMotion() });
  bindCamera(canvas);
  canvas.querySelector('.camera-hud').addEventListener('click', (e) => {
    const op = e.target.closest('[data-cam]')?.dataset.cam;
    if (!op) return;
    if (op === 'fit') S.cam = fitCam();
    else {
      const next = Math.min(2.2, Math.max(Math.min(0.3, fitCam().s / 2), S.cam.s * (op === 'in' ? 1.2 : 1 / 1.2)));
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      S.cam.x = cx - (cx - S.cam.x) * (next / S.cam.s);
      S.cam.y = cy - (cy - S.cam.y) * (next / S.cam.s);
      S.cam.s = next;
      constrainCam();
    }
    applyCam(true);
  });
  S.cam = oldCam || fitCam();
  applyCam(false);
  requestAnimationFrame(() => {
    redraw();
    requestAnimationFrame(() => {
      if (S.office.focus) focusCam(S.office.focus);
      else { S.cam = fitCam(); applyCam(Boolean(oldCam)); }
    });
  });
  officeObserver?.disconnect();
  if (typeof ResizeObserver === 'function' && floor) {
    let lastW = canvas.clientWidth;
    officeObserver = new ResizeObserver(() => requestAnimationFrame(() => {
      redraw();
      if (canvas.clientWidth !== lastW) {
        lastW = canvas.clientWidth;
        if (S.office.focus) focusCam(S.office.focus);
        else {
          S.cam = fitCam();
          applyCam(false);
        }
      }
    }));
    officeObserver.observe(floor);
    officeObserver.observe(canvas);
  }
}

async function pageHandoffs(r) {
  const channel = S.setup?.mode === 'personal' ? 'all' : r.query.get('channel') || 'all';
  const all = (await api('GET', '/api/handoffs')).handoffs;
  if (!isCurrentRoute(r)) return;
  const list = all.filter((e) => channel === 'all' || e.channel === channel);
  const count = (c) => all.filter((e) => c === 'all' || e.channel === c).length;
    view.innerHTML = `${pageHead('交接链路', '按时间查看派单、回报与处理记录。')}
    ${S.setup?.mode === 'personal' ? '' : `<div class="tabs" role="tablist">${[['all', '全部'], ['runner', 'AI 团队'], ['native', '原生聊天']].map(([k, l]) => `<a role="tab" aria-selected="${channel === k}" class="tab ${channel === k ? 'active' : ''}" href="#/handoffs?channel=${k}">${l}<span class="tab-count">${count(k)}</span></a>`).join('')}</div>`}
    ${card('', list.length ? `<div class="elist stagger">${list.map(edgeRow).join('')}</div>` : empty('暂无交接记录'), { cls: 'flush' })}`;
}

async function pageUsage(r) {
  const usage = await api('GET', '/api/usage');
  if (!isCurrentRoute(r)) return;
  const entries = Object.entries(usage.byRole).sort((a, b) => (b[1].usage.totalTokens || 0) - (a[1].usage.totalTokens || 0));
  const max = Math.max(1, ...entries.map(([, x]) => x.usage.totalTokens || 0));
  const runs = S.runs.filter((x) => x.usage).slice(0, 12);
  view.innerHTML = `${pageHead('用量统计', '查看团队的实际消耗，按岗位和任务追溯。')}
    <section class="metrics">${metric('累计 token', usage.total.totalTokens || 0, 'neutral', '#/usage', '真实事件计数')}${metric('缓存输入', usage.total.cachedInputTokens || 0, 'neutral', '#/usage')}${metric('输出', usage.total.outputTokens || 0, 'neutral', '#/usage')}${metric('计量任务', usage.runs, 'neutral', '#/tasks')}${metric('费用', '未知', 'waiting', '#/usage', '口径未知，不估算')}</section>
    <div class="grid-main">
      ${card('按岗位', entries.length ? `<div class="bars">${entries.map(([key, x]) => `<div class="bar-row">${roleChip(roleByKey(key), { project: false })}<div class="bar"><i style="width:${((x.usage.totalTokens || 0) / max) * 100}%"></i></div><span class="mono right">${num(x.usage.totalTokens)}</span><span class="muted small right">${x.runs} 次</span></div>`).join('')}</div>` : empty('暂无用量', '执行任务后显示。'))}
      ${card('说明', `<p class="small">${esc(usage.costNote)}</p><details class="detail-note"><summary>计量方式</summary><p>按实际回合累计 token，续接时去除重复事件。费用未知时不估算金额。</p></details>`)}
    </div>
    ${card('最近计量任务', taskList(runs), { cls: 'flush' })}`;
}

function desktopSettingsHtml(data) {
  return card('沿用 Codex 桌面聊天', `<div class="page-actions"><span class="muted small">当前使用：${S.setup?.executionMode === 'desktop' ? '桌面聊天' : '独立 AI 团队'}</span><button class="btn btn-sm" data-action="desktop-independent">使用独立团队</button></div><p class="page-sub">在原来的聊天中执行，沿用它的工具与设置。</p>
    <form data-form="desktop-connection" class="stack desktop-connect-form"><label class="field"><span>聊天 ID</span><input name="threadId" required value="${esc(data.target?.threadId || '')}" placeholder="粘贴 Codex 聊天 ID，或从本机选择"></label>
    <div data-desktop-threads></div><div class="page-actions"><button type="button" class="btn btn-sm" data-action="desktop-threads">从本机选择聊天</button><span class="muted small">仅列出标题，不读取聊天正文。</span></div>
    <details class="detail-note"><summary>更多设置</summary><div class="form-row"><label class="field"><span>显示名称</span><input name="name" maxlength="40" value="${esc(data.target?.name || '桌面经理')}"></label><label class="field"><span>本机入口（可留空）</span><input name="socketPath" value="${esc(data.socketPath || '')}" placeholder="默认使用 Codex 的本机入口"></label></div></details>
    <div class="page-actions"><button class="btn btn-primary">保存并检查连接</button>${data.configured ? '<button type="button" class="btn btn-danger-ghost" data-action="desktop-disconnect">解除绑定</button>' : ''}</div></form>
    ${data.configured ? `<div class="desktop-connect-state">${status(data.ready ? ['桌面聊天已连接', 'done'] : ['等待桌面连接', 'waiting'])}${data.ready ? '<button class="btn btn-primary btn-sm" data-action="desktop-use">使用桌面模式</button>' : '<button class="btn btn-sm" data-action="retry">重新检查</button>'}</div>` : ''}
    ${data.lastError ? `<p class="notice" role="alert">${esc(data.lastError)}</p>` : ''}<details class="detail-note"><summary>两种模式有什么区别？</summary><p>独立团队可在这里创建经理和员工，管理任务、技能与审批。桌面模式连接已有 Codex 聊天；可用工具和权限沿用该聊天，其他桌面成员仍在 Codex 中管理。桌面连接使用本机协议，桌面版更新后可能需要适配。</p></details>`, { cls: 'desktop-settings' });
}

view.addEventListener('change', (event) => {
  if (!event.target.matches?.('[data-desktop-thread-choice]') || !event.target.value) return;
  const form = event.target.closest('[data-form="desktop-connection"]');
  if (form) form.elements.threadId.value = event.target.value;
});

async function pageSystem(r) {
  const [rt, desktop, weixin] = await Promise.all([api('GET', '/api/runtime'), api('GET', '/api/desktop-manager'), api('GET', '/api/channels/weixin')]);
  S.runtime = rt;
  if (!isCurrentRoute(r)) return;
  const caps = S.overview?.capabilities;
  const rtStatus = { ready: ['就绪', 'done'], starting: ['启动中', 'running'], stopped: ['未启动', 'neutral'], exited: ['已退出', 'error'], error: ['启动失败', 'error'] }[rt.status] || [rt.status, 'neutral'];
  const desktopFirst = r.query.get('desktop') === '1' || S.setup?.executionMode === 'desktop';
  const runtimeActions = `<button class="btn btn-sm" data-action="runtime" data-op="start">启动独立连接</button><button class="btn btn-sm" data-action="runtime" data-op="restart">${icon(ICONS.refresh, 14)}重启</button><button class="btn btn-sm btn-danger-ghost" data-action="runtime" data-op="stop">停止独立连接</button>`;
  view.innerHTML = `${pageHead('连接设置', '连接你的 AI 团队，以及日常交代任务的入口。')}
    ${weixinSettingsHtml(weixin)}
    ${desktopFirst ? desktopSettingsHtml(desktop) : ''}
    <div class="grid-main">
      ${card('AI 团队连接', `<dl class="props"><dt>状态</dt><dd>${status(rtStatus)}</dd><dt>版本</dt><dd>${mono(rt.info?.userAgent?.split(' (')[0] || '—', rt.info?.userAgent)}</dd><dt>已连接对话</dt><dd>${mono(rt.loadedThreads?.length ?? 0)}</dd></dl><div class="page-actions desktop-connect-state">${runtimeActions}</div>${rt.lastError ? `<div class="notice" role="alert">${esc(rt.lastError)}</div>` : ''}<details class="detail-note"><summary>技术信息</summary><p>Codex App Server</p><dl class="props"><dt>进程</dt><dd>${mono(rt.pid ?? '—')}</dd><dt>程序</dt><dd>${mono(rt.codexBin)}</dd><dt>CODEX_HOME</dt><dd>${mono(rt.info?.codexHome || '—')}</dd><dt>启动于</dt><dd>${mono(clock(rt.info?.startedAt))}</dd>${rt.lastExit ? `<dt>上次退出</dt><dd>${mono(`code ${rt.lastExit.code} · ${clock(rt.lastExit.at)}`)}</dd>` : ''}</dl>${rt.stderrTail?.length ? `<details class="log"><summary>运行日志</summary><pre class="code">${esc(rt.stderrTail.join('\n'))}</pre></details>` : ''}</details>`)}
      ${card('团队如何工作', S.setup?.mode === 'personal' ? `<ul class="plain"><li>经理安排工作，员工执行并交付。</li><li>每位员工有自己的 Codex 对话。</li><li>技能随任务提供，使用记录可查看。</li><li>暂停后可续办，停止后保留记录。</li></ul><details class="detail-note"><summary>可用能力</summary><p>当前连接提供文件与代码任务。微信作为同一经理的消息入口；电脑控制和图像生成工具尚未接入。</p></details>` : `<ul class="plain"><li>员工对话支持新建、续接、中断和归档。</li><li>桌面端持有的原生会话保留原连接。</li><li>经理通过原生聊天派单，交接页保留记录。</li></ul>`)}
    </div>
    ${desktopFirst ? '' : desktopSettingsHtml(desktop)}
    ${caps ? card('能力验证', `<div class="table cap-table"><div class="thead"><span>能力</span><span>结果</span><span>证据</span></div>${caps.checks.map((x) => `<div class="row"><span class="strong">${esc(x.label)}</span><span>${status([{ pass: '通过', limited: '受限', fail: '未通过' }[x.result] || x.result, x.result === 'pass' ? 'done' : x.result === 'limited' ? 'waiting' : 'error'])}</span><span class="small">${esc(x.evidence)}${x.runId ? ` · ${mono(x.runId.slice(-8))}` : ''}</span></div>`).join('')}</div><p class="muted small card-foot-note">${mono(`${clock(caps.startedAt)} – ${clock(caps.finishedAt)}`)} · ${esc(caps.codexVersion?.split(' (')[0] || '')}</p>`, { cls: 'flush' }) : ''}`;
}

// ---------------- interactions ----------------

view.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  try {
    if (action === 'weixin-disconnect' || action === 'weixin-reconnect') {
      el.disabled = true;
      await api(action === 'weixin-disconnect' ? 'DELETE' : 'POST', action === 'weixin-disconnect' ? '/api/channels/weixin' : '/api/channels/weixin/reconnect', {});
      await pageSystem(route());
    } else if (action === 'desktop-threads') {
      const current = route(); el.disabled = true;
      const data = await api('GET', '/api/desktop-connection/candidates');
      if (!isCurrentRoute(current)) return;
      const box = view.querySelector('[data-desktop-threads]');
      if (box) box.innerHTML = data.threads.length ? `<label class="field"><span>选择要连接的聊天</span><select data-desktop-thread-choice><option value="">请选择</option>${data.threads.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></label>` : '<p class="muted small">暂无候选聊天，请先在 Codex 打开一个聊天，或直接粘贴聊天 ID。</p>';
    } else if (action === 'desktop-disconnect') {
      await api('DELETE', '/api/desktop-connection'); await loadCore(); await renderPage();
    } else if (action === 'desktop-independent') {
      await api('POST', '/api/setup/independent', {}); await loadCore(); renderSidebar(); location.hash = S.setup.required ? '#/guide' : '#/dashboard';
    } else if (action === 'desktop-use') {
      await api('POST', '/api/setup/desktop', {}); await loadCore(); renderSidebar(); location.hash = '#/manager';
    } else if (action === 'guide-step') {
      el.disabled = true; await saveGuideDraft();
      await api('PATCH', '/api/setup', { step: el.dataset.step });
      await loadCore(); await renderPage({ quiet: true });
    } else if (action === 'guide-check') {
      el.disabled = true; el.textContent = '正在检查连接…';
      await api('POST', '/api/setup/check', {}); await loadCore(); await renderPage({ quiet: true });
    } else if (action === 'guide-retry-employee') {
      const employee = S.setup.employees.find((role) => role.key === el.dataset.role);
      if (!employee?.retryRequest) throw new Error('请刷新引导后核对这个岗位');
      el.disabled = true;
      await api('POST', '/api/setup/employees', employee.retryRequest);
      await loadCore(); await renderPage({ quiet: true });
    } else if (action === 'guide-finish') {
      el.disabled = true; await api('POST', '/api/setup/finish', {}); await loadCore(); renderSidebar(); location.hash = '#/dashboard';
    } else if (action === 'artifact-preview') {
      const data = await api('GET', `/api/collaboration/messages/${el.dataset.message}/artifacts/${el.dataset.index}`);
      view.querySelector('#artifact-dialog')?.remove();
      view.insertAdjacentHTML('beforeend', `<dialog id="artifact-dialog"><div class="dialog-form"><div class="artifact-preview-head"><h2>${esc(data.path)}</h2><button class="btn btn-sm" type="button" data-action="close-dialog">关闭</button></div><span class="chip">实际文件 · 指纹与回报一致</span><pre class="code artifact-content">${esc(data.content)}</pre><p class="muted small">${data.content.split('\n').filter(Boolean).length} 行 · ${data.size} 字节</p><p class="muted small mono">SHA-256 ${esc(data.sha256)}</p></div></dialog>`);
      view.querySelector('#artifact-dialog').showModal();
    } else if (action === 'team-control') {
      el.disabled = true;
      await api('POST', `/api/collaboration/tasks/${el.dataset.task}/control`, { action: el.dataset.op });
      await loadCore(); await renderPage({ quiet: true });
    } else if (action === 'inbox-resume') {
      el.disabled = true;
      await api('POST', `/api/sessions/${el.dataset.session}/inbox/resume`, {});
      scheduleRefresh(50);
    } else if (action === 'approve') {
      const box = el.closest('[data-approval]');
      const answers = Object.fromEntries([...box.querySelectorAll('[data-answer]')].map((i) => [i.dataset.answer, i.value]));
      box.querySelectorAll('button').forEach((b) => (b.disabled = true));
      await api('POST', `/api/approvals/${box.dataset.approval}`, { decision: el.dataset.decision, answers });
      scheduleRefresh(50);
    } else if (action === 'interrupt') {
      el.disabled = true;
      await api('POST', `/api/runs/${el.dataset.run}/interrupt`, { mode: el.dataset.mode });
    } else if (action === 'continue') {
      el.disabled = true;
      const run = await api('POST', `/api/sessions/${el.dataset.session}/continue`, {});
      await loadCore();
      location.hash = `#/task/${run.id}`;
    } else if (action === 'rename') {
      const session = sessionById(el.dataset.session);
      const title = prompt('新的会话名称', session?.title || '');
      if (title) {
        await api('PATCH', `/api/sessions/${el.dataset.session}`, { title });
        scheduleRefresh(50);
      }
    } else if (action === 'archive') {
      if (confirm('归档后该 Codex 会话会移出列表（可在 Codex 中恢复）。确定归档？')) {
        await api('POST', `/api/sessions/${el.dataset.session}/archive`);
        scheduleRefresh(50);
      }
    } else if (action === 'desk-preview') {
      const box = view.querySelector(`[data-preview="${CSS.escape(el.dataset.thread)}"]`);
      box.innerHTML = skeleton(2);
      const { turns } = await api('GET', `/api/desktop-sessions/${encodeURIComponent(el.dataset.thread)}/preview`);
      box.innerHTML = turns.map((t) => `<div class="preview-turn"><span class="mono muted small">${clock(t.startedAt)} · ${esc(t.status)}</span><p><b>请求</b> ${esc(t.request || '—')}</p><p><b>结果</b> ${esc(t.result || '—')}</p></div>`).join('') || '<p class="muted small">没有可显示的记录</p>';
    } else if (action === 'desk-probe') {
      if (!confirm('将对该桌面会话发起一次续接检查：被占用会被拒绝；若成功会立即释放，不发送消息。继续？')) return;
      await api('POST', `/api/desktop-sessions/${encodeURIComponent(el.dataset.thread)}/takeover-probe`, { confirm: true });
      await renderPage({ quiet: true });
    } else if (action === 'new-role') {
      const dialog = view.querySelector(S.setup?.mode === 'personal' ? '#employee-dialog' : '#role-dialog');
      dialog.showModal();
      const form = dialog.querySelector('form');
      form.dataset.draftDirty = 'true'; form.dataset.requestId ||= crypto.randomUUID();
      rememberForm(form, { open: true });
    } else if (action === 'close-dialog') {
      const dialog = el.closest('dialog');
      rememberForm(dialog.querySelector('form'), { open: false }); dialog.close();
    } else if (action.startsWith('migration-')) {
      el.disabled = true;
      const op = action.slice('migration-'.length);
      const result = op === 'prepare' ? await api('POST', '/api/migrations', { roleKey: el.dataset.role }) : await api('POST', `/api/migrations/${el.dataset.migration}/${op}`, { confirm: true });
      await loadCore();
      await renderPage({ quiet: true });
      toast(op === 'probe' && result.blockedReason ? result.blockedReason : { prepare: '会话映射已准备', probe: '占用检查完成，已释放', activate: '原生会话已接管', rollback: '已撤回准备与接管' }[op], result.blockedReason ? 'waiting' : 'done');
    } else if (action === 'runtime') {
      el.disabled = true;
      await api('POST', `/api/runtime/${el.dataset.op}`);
      await renderPage({ quiet: true });
    } else if (action === 'office-focus') {
      const key = el.dataset.role || '';
      const next = key && S.office.focus === key ? '' : key;
      location.hash = `#/office?range=${S.office.range}${next ? `&focus=${encodeURIComponent(next)}` : '&focus='}`;
    } else if (action === 'dispatch-cancel') {
      S.dispatchDraft = '';
    } else if (action === 'retry') {
      await loadCore();
      await renderPage();
    }
  } catch (error) {
    toast(error.message, 'error');
    el.disabled = false;
    el.closest('[data-approval]')?.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
});

view.addEventListener('change', async (event) => {
  const skillForm = event.target.closest('[data-form="role-skills"]');
  if (skillForm) skillForm.querySelector('[data-skill-selection-count]').textContent = `已选 ${skillForm.querySelectorAll('input[name="skill"]:checked').length} 个`;
  const appearance = event.target.closest('.appearance');
  if (appearance) {
    const palette = appearance.querySelector('input[name="palette"]:checked')?.value;
    const emblem = appearance.querySelector('input[name="emblem"]:checked')?.value;
    const preview = appearance.querySelector('[data-appearance-preview]');
    preview.innerHTML = capFigure({ ...paletteColors(palette), emblem }, { size: 64, motionKey: palette, pose: preview.dataset.pose || 'rest' });
  }
  const form = event.target.closest('[data-form="dispatch"]');
  if (!form) return;
  if (event.target.name === 'roleKey') {
    S.dispatchDraft = form.prompt.value;
    location.hash = `#/dispatch?role=${encodeURIComponent(event.target.value)}`;
    return;
  }
  if (event.target.name === 'sessionId') {
    form.querySelector('.new-session').classList.toggle('hidden', event.target.value !== 'new');
    await refreshSkillPicker();
  }
  if (event.target.name === 'cwd') await refreshSkillPicker();
});

view.addEventListener('input', (event) => {
  if (event.target.dataset.guideDraft) {
    S.guideDraft ||= {};
    S.guideDraft[event.target.dataset.guideDraft] = event.target.value;
    clearTimeout(guideSaveTimer);
    const saved = view.querySelector('[data-guide-save]');
    if (saved) saved.textContent = '正在保存草稿…';
    guideSaveTimer = setTimeout(() => saveGuideDraft().then(() => { if (saved?.isConnected) saved.textContent = '草稿已保存，可随时继续'; }).catch(() => { if (saved?.isConnected) saved.textContent = '草稿暂未保存，请保持页面并重试'; }), 400);
  }
  if (event.target.name === 'text' && event.target.closest('[data-form="desktop-manager"]')) S.managerDraft = event.target.value;
  if (event.target.name === 'prompt' && event.target.closest('[data-form="dispatch"]')) S.dispatchDraft = event.target.value;
  if (!event.target.matches('[data-skill-filter]')) return;
  const scope = event.target.closest('.guide-skill-card, form, details');
  const query = event.target.value.trim().toLowerCase();
  let matches = 0;
  scope.querySelectorAll('[data-skill-list] .skill-item').forEach((el) => {
    const found = el.textContent.toLowerCase().includes(query);
    el.classList.toggle('hidden', !found);
    if (found) matches += 1;
  });
  scope.querySelector('[data-skill-match-count]').textContent = query ? `${matches} 个匹配` : `${matches} 个可用`;
  scope.querySelector('[data-skill-empty]').classList.toggle('hidden', matches !== 0);
});

view.addEventListener('click', (event) => {
  const button = event.target.closest('[data-preview-pose]');
  if (!button) return;
  const appearance = button.closest('.appearance');
  const preview = appearance.querySelector('[data-appearance-preview]');
  const palette = appearance.querySelector('input[name="palette"]:checked')?.value;
  const emblem = appearance.querySelector('input[name="emblem"]:checked')?.value;
  preview.dataset.pose = button.dataset.previewPose;
  preview.innerHTML = capFigure({ ...paletteColors(palette), emblem }, { size: 64, motionKey: palette, pose: preview.dataset.pose });
  appearance.querySelectorAll('[data-preview-pose]').forEach((el) => {
    const on = el === button;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
  });
});

view.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const button = event.submitter || form.querySelector('button[type="submit"], button:not([type])');
  if (button) button.disabled = true;
  const done = (msg) => {
    forgetDraft(form);
    if (!button) return;
    const original = button.innerHTML;
    button.innerHTML = msg;
    setTimeout(() => (button.innerHTML = original), 1600);
  };
  try {
    const f = form.elements;
    if (kind.startsWith('guide-')) {
      await saveGuideDraft();
      if (kind === 'guide-welcome') await api('PATCH', '/api/setup', { name: f.workspaceName.value.trim(), ownerName: f.ownerName.value.trim(), step: 'connection' });
      else if (kind === 'guide-manager') await api('POST', '/api/setup/manager', { name: f.name.value.trim(), description: f.description.value.trim(), workspacePath: f.workspacePath.value.trim() || undefined });
      else if (kind === 'guide-bind') await api('POST', '/api/setup/manager/bind', { roleKey: f.roleKey.value });
      else if (kind === 'guide-employee') {
        S.guideEmployeeRequestId ||= crypto.randomUUID();
        await api('POST', '/api/setup/employees', { requestId: S.guideEmployeeRequestId, title: f.title.value.trim(), name: f.name.value.trim(), description: f.description.value.trim() });
        S.guideEmployeeRequestId = null;
        S.guideDraft = { ...(S.guideDraft || {}), employeeTitle: '', employeeName: '', employeeDescription: '' };
        await saveGuideDraft();
      } else if (kind === 'guide-skills-all') {
        for (const card of form.querySelectorAll('[data-skill-role]')) {
          const skills = [...card.querySelectorAll('input[name="skill"]:checked')].map((input) => ({ name: input.dataset.name, path: input.value }));
          await api('POST', '/api/setup/skills', { roleKey: card.dataset.skillRole, skills });
        }
        await api('PATCH', '/api/setup', { step: 'first-task' });
      } else if (kind === 'guide-skills') {
        const skills = [...form.querySelectorAll('input[name="skill"]:checked')].map((input) => ({ name: input.dataset.name, path: input.value }));
        await api('POST', '/api/setup/skills', { roleKey: form.dataset.role, skills });
        toast('选择已保存，发送任务时注入', 'done');
      } else if (kind === 'guide-task') {
        S.guideTaskRequestId ||= crypto.randomUUID();
        await api('POST', '/api/setup/first-task', { requestId: S.guideTaskRequestId, prompt: f.prompt.value.trim() });
        S.guideTaskRequestId = null;
      }
      await loadCore(); renderSidebar(); await renderPage({ quiet: true });
      return;
    }
    if (kind === 'native-filter') {
      const query = new URLSearchParams();
      const taskId = String(f.taskId.value || '').trim();
      if (taskId) query.set('taskId', taskId);
      if (route().query.get('role')) query.set('role', route().query.get('role'));
      location.hash = `#/team?${query}`;
      return;
    }
    if (kind === 'weixin-connect' || kind === 'weixin-verify') {
      await api('POST', kind === 'weixin-connect' ? '/api/channels/weixin/login' : '/api/channels/weixin/verify', kind === 'weixin-connect' ? { managerKey: f.managerKey.value } : { code: f.code.value });
      await pageSystem(route());
    } else if (kind === 'desktop-connection') {
      const result = await api('PUT', '/api/desktop-connection', { threadId: f.threadId.value.trim(), name: f.name.value.trim(), socketPath: f.socketPath.value.trim() });
      forgetDraft(form);
      toast(result.ready ? '桌面聊天已连接' : '设置已保存，请核对连接提示', result.ready ? 'done' : 'waiting');
      await loadCore(); await renderPage();
    } else if (kind === 'desktop-manager') {
      S.managerDraft = f.text.value;
      S.managerRequestId ||= crypto.randomUUID();
      S.managerSubmitting = true;
      const message = await api('POST', '/api/desktop-manager/messages', { requestId: S.managerRequestId, text: S.managerDraft });
      forgetDraft(form);
      S.managerDraft = ''; S.managerRequestId = null;
      f.text.value = '';
      if (message.status === 'unknown' || message.status === 'error') toast(DESKTOP_MESSAGE_LABEL[message.status][0], message.status === 'error' ? 'error' : 'waiting');
      S.managerSubmitting = false;
      await pageManager(route(), { quiet: true });
    } else if (kind === 'chat') {
      const body = { sessionId: form.dataset.session, prompt: f.prompt.value.trim(), requestId: form.dataset.requestId ||= crypto.randomUUID() };
      form._submission = body;
      await api('POST', '/api/runs', body);
      forgetDraft(form);
      f.prompt.value = '';
      delete form.dataset.requestId;
      await loadCore(); await renderPage({ quiet: true });
    } else if (kind === 'native-dispatch') {
      const run = await api('POST', `/api/migrations/${form.dataset.migration}/dispatch`, { messageId: f.messageId.value.trim(), taskId: f.taskId.value.trim() });
      await loadCore();
      location.hash = `#/task/${run.id}`;
    } else if (kind === 'dispatch') {
      const extra = [...form.querySelectorAll('input[name="extraSkill"]:checked')].map((i) => ({ name: i.dataset.name, path: i.value }));
      const useRole = form.querySelector('input[name="useRoleSkills"]');
      const body = { requestId: form.dataset.requestId ||= crypto.randomUUID(), roleKey: f.roleKey.value, prompt: f.prompt.value, skills: extra, useRoleSkills: useRole ? useRole.checked : true, effort: f.effort.value, dispatcherLabel: f.dispatcherLabel.value };
      if (f.sessionId.value === 'new') body.session = { title: f.title.value || undefined, cwd: f.cwd.value, model: f.model.value || undefined, sandbox: f.sandbox.value, approvalPolicy: f.approvalPolicy.value };
      else body.sessionId = f.sessionId.value;
      const run = await api('POST', '/api/runs', body);
      forgetDraft(form);
      S.dispatchDraft = '';
      await loadCore();
      location.hash = `#/task/${run.id}`;
    } else if (kind === 'steer') {
      await api('POST', `/api/runs/${form.dataset.run}/steer`, { text: f.text.value });
      f.text.value = '';
      done('已追加');
    } else if (kind === 'continue') {
      const run = await api('POST', `/api/sessions/${form.dataset.session}/continue`, { prompt: f.prompt.value.trim() || undefined });
      forgetDraft(form);
      await loadCore();
      location.hash = `#/task/${run.id}`;
    } else if (kind === 'role-skills') {
      const skills = [...form.querySelectorAll('input[name="skill"]:checked')].map((i) => ({ name: i.dataset.name, path: i.value }));
      await api('PATCH', `/api/roles/${encodeURIComponent(form.dataset.role)}/config`, { skills });
      await loadCore();
      renderSidebar();
      done('已保存');
    } else if (kind === 'role-defaults') {
      await api('PATCH', `/api/roles/${encodeURIComponent(form.dataset.role)}/config`, { defaults: { cwd: f.cwd.value, model: f.model.value || '', effort: f.effort.value, sandbox: f.sandbox.value, approvalPolicy: f.approvalPolicy.value } });
      await loadCore();
      done('已保存');
    } else if (kind === 'role-appearance') {
      await api('PATCH', `/api/roles/${encodeURIComponent(form.dataset.role)}/config`, { palette: f.palette.value, emblem: f.emblem.value });
      forgetDraft(form);
      await loadCore();
      renderSidebar();
      await renderPage({ quiet: true });
    } else if (kind === 'role-profile') {
      await api('PATCH', `/api/roles/${encodeURIComponent(form.dataset.role)}/config`, { profile: { name: f.name.value.trim(), title: f.title.value.trim(), instructions: f.instructions.value.trim() } });
      forgetDraft(form); await loadCore(); renderSidebar(); updatePageTitle(); done('职责已保存');
      toast('职责已保存，下次执行时生效', 'done');
    } else if (kind === 'new-employee') {
      form.dataset.requestId ||= crypto.randomUUID(); rememberForm(form);
      const result = await api('POST', '/api/team/employees', { requestId: form.dataset.requestId, name: f.name.value.trim(), title: f.title.value.trim(), description: f.description.value.trim(), palette: f.palette.value, emblem: f.emblem.value });
      forgetDraft(form); form.closest('dialog').close();
      S.workspaces = null; await loadCore(); renderSidebar(); await renderPage({ quiet: true });
      const added = view.querySelector(`[data-role-key="${CSS.escape(result.role.key)}"]`);
      added?.setAttribute('tabindex', '-1'); added?.focus({ preventScroll: true }); added?.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'instant' : 'smooth' });
      toast('员工已加入团队，固定会话已建立', 'done');
    } else if (kind === 'new-role') {
      const collaboration = f.authority.value === 'none' ? undefined : { namespace: f.namespace.value.trim(), authority: f.authority.value };
      const role = await api('POST', '/api/roles', { name: f.name.value, title: f.title.value, description: f.description.value, instructions: f.instructions.value, palette: f.palette.value, emblem: f.emblem.value, collaboration });
      if (collaboration) await api('POST', '/api/sessions', { roleKey: role.key, title: `${role.roleTitle} · ${role.name}` });
      S.workspaces = null;
      forgetDraft(form);
      form.closest('dialog').close();
      await loadCore();
      renderSidebar(); await renderPage({ quiet: true });
    }
  } catch (error) {
    const fieldError = form.querySelector('[data-form-error]');
    if (fieldError) { fieldError.textContent = error.message; fieldError.classList.remove('hidden'); }
    toast(error.message, 'error');
  } finally {
    if (kind === 'desktop-manager') { S.managerSubmitting = false; scheduleManagerReload(); }
    if (button) button.disabled = false;
  }
});

window.addEventListener('hashchange', async () => {
  renderSidebar();
  await renderPage();
  if (route().page !== 'office') document.getElementById('main')?.scrollTo(0, 0);
});

(async function boot() {
  try {
    await loadCore();
  } catch (error) {
    view.innerHTML = errorBox(`暂时无法连接公司：${error.message}`);
  }
  renderSidebar();
  await renderPage();
  connectEvents(onEvent, (state) => {
    S.sse = state;
    renderRuntime();
    updatePageTitle();
    if (state === 'open') scheduleRefresh(50);
  });
})();
