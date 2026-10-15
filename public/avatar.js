// 岗位人物形象。
// 造型与配色规则参考 Paperclip cap-v1（https://github.com/paperclipai/paperclip，MIT）：
// 同一圆顶造型、每个岗位一组双色渐变、运行状态决定表情姿态；本文件为独立重绘，并加入职业徽标。

const EMBLEM_PATHS = {
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13 17 22l-5-3-5 3 1.5-9"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  calculator: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h2M14 11h2M8 16h2M14 16h2"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  megaphone: '<path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
  spark: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
  console: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h5"/>',
};
export const EMBLEM_LABEL = { award: '决策', briefcase: '管理', calculator: '财务', pen: '设计', code: '开发', megaphone: '运营', book: '知识', shield: '质检', wrench: '运维', database: '数据', spark: '通用' };

/** 岗位运行状态 → 人物姿态（对应 Paperclip characterStateForAgent 的思路）。 */
export const POSE_FOR_STATE = { working: 'working', waiting_approval: 'thinking', queued: 'loading', paused: 'sleepy', error: 'confused', delivered: 'success', accepted: 'success', report_submitted: 'loading', finished: 'rest', unknown: 'rest', idle: 'rest' };

const INK = '#1d2125';
function face(pose) {
  const dots = (dx = 0, dy = 0, r = 1.9) => `<g class="cap-eyes"><circle cx="${27 + dx}" cy="${30 + dy}" r="${r}" fill="${INK}"/><circle cx="${37 + dx}" cy="${30 + dy}" r="${r}" fill="${INK}"/></g>`;
  switch (pose) {
    case 'working':
      return `${dots(0, 0.4)}<path d="M30.4 35.6h3.2" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`;
    case 'thinking':
      return `${dots(0.9, -0.9)}<circle cx="32.6" cy="35.6" r="1.1" fill="none" stroke="${INK}" stroke-width="1.3"/><text class="cap-glyph" x="56" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#d97706">?</text>`;
    case 'loading':
      return `${dots()}<path d="M30.4 35.6h3.2" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/><g class="cap-glyph" fill="#7c8a99"><circle cx="49" cy="12" r="1.3"/><circle cx="53.5" cy="12" r="1.3"/><circle cx="58" cy="12" r="1.3"/></g>`;
    case 'success':
      return `<g class="cap-eyes"><path d="M25.2 30.6q1.8-2.2 3.6 0M35.2 30.6q1.8-2.2 3.6 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/></g><path d="M28.2 33.8h7.6q0 4.6-3.8 4.6t-3.8-4.6z" fill="${INK}"/><path d="M30 37.4q2-1.6 4 0q-2 1.2-4 0z" fill="#ff8aa0"/>`;
    case 'confused':
      return `<g class="cap-eyes"><circle cx="27" cy="30.4" r="1.4" fill="${INK}"/><circle cx="37" cy="30" r="2.1" fill="${INK}"/></g><path d="M28.4 36.2q1.4-1.5 2.8 0t2.8 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/><text class="cap-glyph" x="56" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">!</text>`;
    case 'sleepy':
      return `<path d="M25.2 30q1.8 1.8 3.6 0M35.2 30q1.8 1.8 3.6 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M30.4 35.6h3.2" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/><text class="cap-glyph" x="54" y="15" font-size="9" font-weight="700" fill="#94a3b8">z</text>`;
    default:
      return `${dots()}<path d="M29 35q3 2.6 6 0" stroke="${INK}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
  }
}

let uid = 0;
/**
 * 岗位人物 SVG。
 * @param {object} appearance {a, b, emblem}
 * @param {object} options {size, pose, muted, emblem:boolean, label}
 */
export function capFigure(appearance = {}, { size = 32, pose = 'rest', muted = false, emblem = size >= 28, label = '', motionKey = '' } = {}) {
  const id = `cap${(uid += 1)}`;
  const a = muted ? '#a6aaad' : appearance.a || '#97fff3';
  const b = muted ? '#44464a' : appearance.b || '#0084ff';
  const showFace = size >= 18;
  const job = EMBLEM_PATHS[appearance.emblem] ? appearance.emblem : 'spark';
  const seed = [...String(motionKey || job)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const phase = -((seed % 580) / 100).toFixed(2);
  const rhythm = (3.4 + (seed % 120) / 100).toFixed(2);
  const shadow = size >= 28 ? '<ellipse class="cap-shadow" cx="32" cy="61" rx="15" ry="2" fill="#000" opacity=".18"/>' : '';
  const hands = size >= 28 ? `<g class="cap-hand cap-hand-left"><path d="M14 41q-7 0-7 7" fill="none" stroke="${b}" stroke-width="4" stroke-linecap="round"/><circle cx="7" cy="48" r="2.8" fill="${a}"/></g><g class="cap-hand cap-hand-right"><path d="M50 41q7 0 7 7" fill="none" stroke="${b}" stroke-width="4" stroke-linecap="round"/><circle cx="57" cy="48" r="2.8" fill="${a}"/></g>` : '';
  const badge = emblem && appearance.emblem
    ? `<g class="cap-emblem"><circle cx="49.5" cy="49.5" r="9" fill="#fff" stroke="rgba(15,23,42,.14)" stroke-width=".9"/><g transform="translate(44.46 44.46) scale(.42)" fill="none" stroke="#262a2e" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${EMBLEM_PATHS[appearance.emblem] || EMBLEM_PATHS.spark}</g></g>`
    : '';
  return `<svg class="cap-figure cap-${pose} cap-job-${job}" data-pose="${pose}" data-profession="${job}" style="--cap-phase:${phase}s;--cap-rhythm:${rhythm}s" viewBox="0 0 64 64" width="${size}" height="${size}" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    ${shadow}
    <g class="cap-body">
      ${hands}
      <path d="M16 55Q12 55 12 51V29A20 20 0 0 1 52 29V51Q52 55 48 55Z" fill="url(#${id})"/>
      <path d="M18 52.6Q15 52.6 15 49.6V29.4A17 17 0 0 1 49 29.4V49.6Q49 52.6 46 52.6Z" fill="none" stroke="#fff" stroke-opacity=".32" stroke-width="1.2"/>
      ${showFace ? `<g class="cap-face">${face(pose)}</g>` : ''}
    </g>
    ${badge}
  </svg>`;
}

export function emblemIcon(name, size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EMBLEM_PATHS[name] || EMBLEM_PATHS.spark}</svg>`;
}
