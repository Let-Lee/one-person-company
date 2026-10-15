import { capFigure, POSE_FOR_STATE } from './avatar.js';

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-yewang-workbench': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = new Error(data?.error || `请求失败（${res.status}）`);
    error.status = res.status;
    error.details = data?.details;
    throw error;
  }
  return data;
}

export function connectEvents(onEvent, onState) {
  let source;
  let retry = 1000;
  const open = () => {
    source = new EventSource('/api/events');
    source.onopen = () => {
      retry = 1000;
      onState?.('open');
    };
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // ignore malformed event
      }
    };
    source.onerror = () => {
      onState?.('closed');
      source.close();
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
  return () => source?.close();
}

const toMs = (value) => (typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value));

export function timeAgo(value) {
  if (!value) return '—';
  const t = toMs(value);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function clock(value) {
  if (!value) return '—';
  return new Date(toMs(value)).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
export const mono = (value, title = value) => `<span class="mono" title="${esc(title ?? '')}">${esc(value ?? '—')}</span>`;
export const shortId = (id) => (id ? `${String(id).slice(0, 8)}…${String(id).slice(-4)}` : '—');

// ---------- 统一状态体系：每个状态只有一种颜色、图标和叫法 ----------

const RUN = {
  queued: ['排队中', 'queued'],
  starting: ['启动中', 'running'],
  running: ['执行中', 'running'],
  waiting_approval: ['等待审批', 'waiting'],
  completed: ['已完成', 'done'],
  interrupted: ['已暂停', 'paused'],
  failed: ['失败', 'error'],
  cancelled: ['已取消', 'neutral'],
};
const ROLE = {
  working: ['执行中', 'running'],
  waiting_approval: ['等待审批', 'waiting'],
  queued: ['排队中', 'queued'],
  paused: ['已暂停', 'paused'],
  error: ['出错', 'error'],
  delivered: ['已回传', 'done'],
  accepted: ['已验收', 'done'],
  report_submitted: ['回报已提交', 'queued'],
  finished: ['本轮结束', 'neutral'],
  unknown: ['未连接', 'neutral'],
  idle: ['空闲', 'neutral'],
};
const SESSION = {
  idle: ['空闲', 'neutral'],
  running: ['执行中', 'running'],
  waiting_approval: ['等待审批', 'waiting'],
  paused: ['已暂停', 'paused'],
  stopped: ['已停止', 'neutral'],
  error: ['出错', 'error'],
  archived: ['已归档', 'neutral'],
  detached: ['已释放', 'paused'],
};
const APPROVAL = {
  pending: ['待处理', 'waiting'],
  accepted: ['已批准', 'done'],
  declined: ['已拒绝', 'neutral'],
  cancelled: ['已拒绝并中断', 'error'],
  expired: ['已失效', 'neutral'],
  resolved_elsewhere: ['已在别处处理', 'neutral'],
};
export const STOP_MODE = { pause: '手动暂停', stop: '手动停止', console_restart: '服务重启', runtime_exit: '运行服务退出', external: '外部中断' };

export function runStatus(run) {
  if (run.status === 'interrupted' && run.stopMode === 'stop') return ['已停止', 'neutral'];
  if (run.status === 'interrupted' && ['console_restart', 'runtime_exit', 'external'].includes(run.stopMode)) return ['已中断', 'paused'];
  return RUN[run.status] || [run.status, 'neutral'];
}
export const roleStatus = (state) => ROLE[state] || ROLE.idle;
export const sessionStatus = (state) => SESSION[state] || [state, 'neutral'];
export const approvalStatus = (state) => APPROVAL[state] || [state, 'neutral'];

export function statusIcon(tone, size = 14) {
  const body = {
    running: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3.6A4.4 4.4 0 0 1 8 12.4z" fill="currentColor"/>',
    waiting: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.8v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="10.9" r=".95" fill="currentColor"/>',
    queued: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 2.2"/>',
    done: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    error: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
    paused: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.4 5.6v4.8M9.6 5.6v4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    neutral: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  }[tone] || '';
  return `<svg class="st-icon tone-${tone}" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

export function status([label, tone], extra = '') {
  return `<span class="status tone-${tone}">${statusIcon(tone)}<span class="status-text">${esc(label)}${extra ? `<span class="status-extra"> · ${esc(extra)}</span>` : ''}</span></span>`;
}

// ---------- 岗位标识：岗位为主、姓名为辅，全站同一写法 ----------

export function roleLabel(role, { project = true, size = 'md' } = {}) {
  if (!role) return '<span class="rl">未知岗位</span>';
  if (role.key === 'console') return `<span class="rl rl-${size}"><span class="rl-title">控制台</span></span>`;
  const title = role.roleTitle || String(role.title || '').split('｜')[0] || role.name;
  const full = `${title}｜${role.name}${role.project ? ` · ${role.project}` : ''}`;
  return `<span class="rl rl-${size}" title="${esc(full)}"><span class="rl-title">${esc(title)}</span><span class="rl-sep">｜</span><span class="rl-name">${esc(role.name)}</span>${project && role.project ? `<span class="rl-proj">${esc(role.project)}</span>` : ''}</span>`;
}

export const CONSOLE_ROLE = { key: 'console', name: '控制台', roleTitle: '控制台' };

export function roleAvatar(role, { size = 24, state, muted = false, emblem } = {}) {
  if (!role) return `<span class="avatar" style="width:${size}px;height:${size}px"></span>`;
  if (role.key === 'console') {
    const g = Math.round(size * 0.58);
    return `<span class="avatar avatar-console" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${g}" height="${g}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h5"/></svg></span>`;
  }
  const pose = POSE_FOR_STATE[state ?? role.liveState] || 'rest';
  const motionKey = [role.key, size, pose, role.appearance?.palette, role.appearance?.emblem, Boolean(muted), emblem ?? size >= 28].join(':');
  return `<span class="avatar" data-avatar-key="${esc(motionKey)}" style="width:${size}px;height:${size}px">${capFigure(role.appearance, { size, pose, muted, emblem: emblem ?? size >= 28, motionKey: role.key || role.name })}</span>`;
}

export function roleChip(role, opts = {}) {
  return `<span class="role-chip">${roleAvatar(role, { size: opts.avatar || 20, state: opts.state })}${roleLabel(role, opts)}</span>`;
}

/** 安全的 Markdown 子集，用于岗位回复。 */
export function md(text) {
  const blocks = String(text || '').split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) return `<pre class="code">${esc(block.replace(/^[^\n]*\n/, ''))}</pre>`;
      return esc(block)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .split(/\n{2,}/)
        .map((p) => {
          const lines = p.split('\n');
          if (lines.every((l) => /^\s*[-*] /.test(l) || !l.trim())) return `<ul>${lines.filter((l) => l.trim()).map((l) => `<li>${l.replace(/^\s*[-*] /, '')}</li>`).join('')}</ul>`;
          return `<p>${lines.join('<br>')}</p>`;
        })
        .join('');
    })
    .join('');
}

export function toast(message, tone = 'neutral') {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast tone-${tone}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4100);
}

export const icon = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="ico" aria-hidden="true"><path d="${d}"/></svg>`;
export const ICONS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  sessions: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  roles: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  office: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4',
  handoffs: 'M7 5h10a4 4 0 0 1 0 8H7a3 3 0 0 0 0 6h10M5 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0M23 19a2 2 0 1 0-4 0 2 2 0 0 0 4 0',
  usage: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  system: 'M4 4h16v10H4zM8 20h8M12 14v6',
  plus: 'M12 5v14M5 12h14',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  play: 'M7 4l13 8-13 8z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  focus: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  overview: 'M3 3h18v18H3zM3 9h18M9 21V9',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};
export function themeControl({ compact = false } = {}) {
  const selected = document.documentElement?.dataset.themeMode || 'system';
  const choices = [
    ['light', '亮色', 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
    ['dark', '暗色', 'M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z'],
    ['system', '跟随系统', 'M4 4h16v12H4zM8 20h8m-4-4v4'],
  ];
  return `<div class="theme-control ${compact ? 'is-compact' : ''}" role="group" aria-label="外观模式">${choices.map(([mode, label, path]) => `<button type="button" data-color-mode="${mode}" aria-label="${label}${mode === 'system' ? '' : '模式'}" aria-pressed="${mode === selected}" title="${label}">${icon(path, 15)}<span>${label}</span></button>`).join('')}</div>`;
}

