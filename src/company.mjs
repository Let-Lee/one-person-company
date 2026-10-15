import fs from 'node:fs';
import path from 'node:path';

/**
 * 岗位形象沿用 Paperclip cap-v1 的规则：同一造型、每个岗位一组双色配色、状态决定姿态。
 * 配色值取自 Paperclip ui/src/index.css 的 cap-v1 色板（MIT，见 public/avatar.js 说明）。
 */
export const PALETTES = {
  'bubblegum-sky': ['#8bd4ff', '#ff51bf'],
  'pink-lemonade': ['#ff26a8', '#fff78a'],
  'orchid-peach': ['#e771ff', '#ffd87c'],
  'coral-mint': ['#beffe8', '#ff797b'],
  'lime-lagoon': ['#b4ffa4', '#26dfff'],
  'arctic-blue': ['#97fff3', '#0084ff'],
  'solar-flare': ['#ecca5c', '#fe3c3f'],
  'violet-ember': ['#ff5c43', '#6262ff'],
  'deep-tide': ['#003d60', '#32fffc'],
  'coral-current': ['#26e2ff', '#ff6666'],
  'golden-hour': ['#ffcd4f', '#fde5ba'],
  'tangerine-cobalt': ['#ffad32', '#4169ff'],
  'electric-grove': ['#b4ff32', '#008d58'],
  'flamingo-jade': ['#ff4f9a', '#36edaa'],
  'cherry-pop': ['#ff69db', '#d51c46'],
  'turquoise-cherry': ['#37f0db', '#ff4f64'],
  'ultraviolet-tide': ['#7516cf', '#00e8d1'],
};
export const EMBLEMS = ['award', 'briefcase', 'calculator', 'pen', 'code', 'megaphone', 'book', 'shield', 'wrench', 'database', 'spark'];

const ROLE_PROFILES = {
  chairman: { palette: 'golden-hour', emblem: 'award', dept: 'management' },
  general_manager: { palette: 'deep-tide', emblem: 'briefcase', dept: 'management' },
  finance: { palette: 'electric-grove', emblem: 'calculator', dept: 'support' },
  visual_designer: { palette: 'orchid-peach', emblem: 'pen', dept: 'product' },
  fullstack_developer: { palette: 'arctic-blue', emblem: 'code', dept: 'product' },
  fullstack_developer_2: { palette: 'violet-ember', emblem: 'code', dept: 'product' },
  operations: { palette: 'coral-current', emblem: 'megaphone', dept: 'growth' },
  knowledge_manager: { palette: 'lime-lagoon', emblem: 'book', dept: 'growth' },
  quality_reviewer: { palette: 'turquoise-cherry', emblem: 'shield', dept: 'product' },
  mac_manager: { palette: 'bubblegum-sky', emblem: 'wrench', dept: 'support' },
  data_manager: { palette: 'ultraviolet-tide', emblem: 'database', dept: 'growth' },
};
export const DEPARTMENTS = {
  management: '管理层',
  product: '产品研发',
  growth: '运营与数据',
  support: '财务与支持',
  workbench: 'AI 团队',
};

/** Paperclip legacyAgentAppearance：按 ID 做稳定哈希，不在渲染时随机。 */
function stablePalette(id) {
  const ids = Object.keys(PALETTES);
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) % ids.length;
  return ids[hash];
}

export function appearanceFor(roleKey, choice = {}) {
  const base = ROLE_PROFILES[roleKey] || {};
  const palette = PALETTES[choice.palette] ? choice.palette : base.palette || stablePalette(roleKey);
  const emblem = EMBLEMS.includes(choice.emblem) ? choice.emblem : base.emblem || 'spark';
  const [a, b] = PALETTES[palette];
  return { palette, a, b, emblem };
}

export function roleIdentity(roleKey, title, name) {
  const roleTitle = String(title || '').split('｜')[0] || name;
  const profile = ROLE_PROFILES[roleKey] || {};
  return { roleTitle, project: profile.project || null, dept: profile.dept || 'workbench' };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Minimal TOML reader for the role profile files (string and triple-quoted string keys only). */
export function parseRoleToml(text) {
  const out = {};
  const re = /^([A-Za-z0-9_]+)\s*=\s*("""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/gm;
  let match;
  while ((match = re.exec(text))) {
    out[match[1]] = match[3] !== undefined ? match[3].trim() : JSON.parse(`"${match[4]}"`);
  }
  return out;
}

export class CompanyDirectory {
  constructor(companyRoot, { enabled = true } = {}) {
    this.root = companyRoot;
    this.enabled = enabled;
    this.contactsFile = path.join(companyRoot, '公司/组织/聊天通讯录.json');
    this.agentsDir = path.join(companyRoot, '.codex/agents');
    this.receiptsDir = path.join(companyRoot, '公司/组织/回报发送凭据');
    this.pendingFile = path.join(companyRoot, '公司/组织/待派任务.json');
  }

  contacts() {
    if (!this.enabled) return { members: [] };
    return readJson(this.contactsFile, { members: [] });
  }

  managerThreadId() {
    const managers = (this.contacts().members || []).filter((m) => m.role === 'general_manager');
    return managers.length === 1 ? managers[0].threadId : null;
  }

  /** Company roles: fixed native chat route + long-term role profile. */
  roles() {
    if (!this.enabled) return [];
    const pending = readJson(this.pendingFile, { items: [] });
    const nativeState = new Map((pending.items || []).map((item) => [item.role, item]));
    return (this.contacts().members || []).map((member) => {
      let profile = {};
      try {
        profile = parseRoleToml(fs.readFileSync(path.join(this.agentsDir, `${member.role}.toml`), 'utf8'));
      } catch {
        profile = {};
      }
      const native = nativeState.get(member.role);
      return {
        key: member.role,
        name: member.name,
        title: member.title || member.name,
        ...roleIdentity(member.role, member.title, member.name),
        description: profile.description || '',
        source: 'company',
        nativeThreadId: member.threadId,
        nativeTaskId: member.currentTaskId ?? null,
        nativeStatus: native ? { taskId: native.taskId, status: native.status } : null,
        appearance: appearanceFor(member.role),
      };
    });
  }

  /**
   * Real native handoffs from saved send receipts. Only routing metadata is exposed;
   * message bodies stay in the receipts.
   */
  handoffs(limit = 80) {
    if (!this.enabled) return [];
    const members = this.contacts().members || [];
    const byThread = new Map(members.map((m) => [m.threadId, m]));
    let files = [];
    try {
      files = fs
        .readdirSync(this.receiptsDir)
        .filter((name) => name.startsWith('send-') && name.endsWith('.json'))
        .map((name) => {
          const file = path.join(this.receiptsDir, name);
          return { name, file, mtime: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit);
    } catch {
      return [];
    }
    const edges = [];
    for (const { name, file } of files) {
      const receipt = readJson(file, null);
      if (!receipt?.sourceThreadId || !receipt?.recipientThreadId) continue;
      const from = byThread.get(receipt.sourceThreadId);
      const to = byThread.get(receipt.recipientThreadId);
      edges.push({
        id: name.replace(/\.json$/, ''),
        channel: 'native',
        kind: receipt.messageKind || 'message',
        fromRole: from?.role ?? null,
        fromName: from?.name ?? '未知来源',
        toRole: to?.role ?? null,
        toName: to?.name ?? '未知接收方',
        at: receipt.savedAt || null,
        taskId: receipt.primaryTaskId || receipt.taskIds?.[0] || null,
        submitted: Boolean(receipt.submissionVerified ?? receipt.deliveryVerified),
        outcome: receipt.outcome?.kind ?? null,
        evidence: path.relative(this.root, file),
      });
    }
    return edges.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
}
