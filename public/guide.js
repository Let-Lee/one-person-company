import { esc, icon, ICONS, roleAvatar, roleLabel, status } from './lib.js';

const STEPS = [
  ['welcome', '你的公司', '从一个人开始'],
  ['connection', '连接 Codex', '检查本机环境'],
  ['manager', '创建经理', '有人帮你安排工作'],
  ['employees', '添加员工', '按工作需要招人'],
  ['skills', '选择技能', '给岗位配上方法'],
  ['first-task', '交代任务', '由经理安排执行'],
  ['tour', '查看进度', '了解日常怎么用'],
];
const managerResponsibility = '明确目标和范围，安排员工执行，检查结果，再向我汇报。';
const asRole = (role) => ({ ...role, roleTitle: role.title, liveState: 'idle' });
const field = (label, name, key, value, placeholder = '', { multiline = false, required = false } = {}) =>
  '<label class="field"><span>' + label + '</span>' +
  (multiline ? '<textarea rows="4"' : '<input type="text" value="' + esc(value || '') + '"') + ' name="' + name + '" data-guide-draft="' + key + '"' +
  (required ? ' required' : '') + ' maxlength="' + (multiline ? 4000 : 240) + '" placeholder="' + esc(placeholder) + '">' +
  (multiline ? esc(value || '') + '</textarea>' : '') +
  '</label>';
// Input values use attributes, textareas use text content.
function input(label, name, key, value, placeholder, required = false) {
  return '<label class="field"><span>' + label + '</span><input name="' + name + '" data-guide-draft="' + key +
    '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '" maxlength="240"' + (required ? ' required' : '') + '></label>';
}
const next = (step, label = '继续') => '<button class="btn btn-primary" type="button" data-action="guide-step" data-step="' + step + '">' + label + '</button>';
const back = (step) => '<button class="btn btn-ghost" type="button" data-action="guide-step" data-step="' + step + '">上一步</button>';
const foot = (previous, action) => '<footer class="guide-foot">' + (previous ? back(previous) : '<span></span>') + '<span class="spacer"></span>' + action + '</footer>';

function savedRole(role) {
  return '<article class="guide-created">' + roleAvatar(asRole(role), { size: 44 }) + '<div>' + roleLabel(asRole(role), { project: false }) +
    '<p class="muted small">' + esc(role.description) + '</p><div class="guide-role-states">' +
    status(['岗位已保存', 'done']) + status(role.sessionCreated ? ['会话已建立', 'done'] : ['会话尚未建立', 'waiting']) +
    '</div>' + (role.retryRequest ? '<button type="button" class="btn btn-sm" data-action="guide-retry-employee" data-role="' + esc(role.key) + '">重试建立此员工会话</button>' : '') + '</div></article>';
}

function welcome(data, drafts) {
  return '<div class="guide-intro"><div class="guide-orbit" aria-hidden="true"><i></i><span>' +
    roleAvatar({ key: 'guide-manager', appearance: { a: '#c4bbff', b: '#5869dc', emblem: 'briefcase' }, liveState: 'idle' }, { size: 78 }) +
    '</span><b></b></div><div class="eyebrow">YOUR ONE-PERSON COMPANY</div><h2>一个人的公司，从这里开始</h2>' +
    '<p>你定目标，AI 团队负责执行。</p></div>' +
    '<div class="guide-concepts"><div><b>01</b><strong>交代目标</strong></div><div><b>02</b><strong>经理安排</strong></div><div><b>03</b><strong>员工交付</strong></div></div>' +
    '<form data-form="guide-welcome" class="guide-form"><div class="form-row">' +
    input('公司名称', 'workspaceName', 'workspaceName', drafts.workspaceName || data.name, '给你的公司起个名字', true) +
    input('怎么称呼你', 'ownerName', 'ownerName', drafts.ownerName ?? data.ownerName, '可稍后填写') +
    '</div><p class="guide-note"><i class="guide-note-dot"></i>当前有 ' + data.roleCount + ' 个岗位，按需要添加。</p>' +
    foot(null, '<button class="btn btn-primary">创建我的公司</button>') + '</form>';
}

function connection(data) {
  const env = data.environment;
  return '<div class="guide-section-title"><span class="eyebrow">CONNECTION</span><h2>连接你的 AI 团队</h2><p>用这台电脑上的 Codex 运行 AI 员工，先检查连接。</p></div>' +
    '<div class="guide-connection"><span class="guide-connection-icon">' + icon(ICONS.system, 30) + '</span><div><strong>' +
    (env?.connected ? 'Codex 已连接' : '等待连接检查') + '</strong><p>' + esc(env?.message || '安装并打开 Codex，完成登录后，点击下方检查。') +
    '</p></div>' + status(env?.connected ? ['连接通过', 'done'] : ['尚未检查', 'neutral']) + '</div>' +
    '<details class="guide-advanced"><summary>还没安装或登录？</summary><p class="guide-note">先安装并打开 Codex，完成登录，再回来检查。你的填写会保留。</p></details>' +
    '<details class="guide-advanced"><summary>想沿用 Codex 桌面聊天？</summary><p class="guide-note">连接已有聊天，沿用其中的工具和设置。</p><a class="btn" href="#/system?desktop=1">连接桌面聊天</a></details>' +
    '<button class="btn" type="button" data-action="guide-check">' + icon(ICONS.refresh, 15) + (env ? '重新检查' : '检查连接') + '</button>' +
    foot('welcome', env?.connected && env.authentication !== 'login_required' ? next('manager') : '<span class="muted small">连接并登录后继续</span>');
}

function manager(data, drafts) {
  if (data.manager?.sessionCreated) return '<div class="guide-section-title"><span class="eyebrow">YOUR MANAGER</span><h2>总经理已就位</h2><p>以后有任务，直接交给这位经理。</p></div>' + savedRole(data.manager) +
    '<p class="guide-note">返回这一步不会重复创建经理。</p>' + foot('connection', next('employees', '继续添加员工'));
  return '<div class="guide-section-title"><span class="eyebrow">YOUR MANAGER</span><h2>先找一位总经理</h2><p>帮你分配任务、检查结果，向你汇报。</p></div>' +
    (data.manager ? savedRole(data.manager) : '') +
    '<form data-form="guide-manager" class="guide-form">' +
    input('经理名称', 'name', 'managerName', drafts.managerName, '给经理起个名字', true) +
    field('经理负责什么', 'description', 'managerDescription', drafts.managerDescription ?? managerResponsibility, '', { multiline: true, required: true }) +
    '<details class="guide-advanced"><summary>选择工作文件夹（可选）</summary>' +
    input('文件夹完整路径', 'workspacePath', 'workspacePath', drafts.workspacePath, '留空则创建独立工作区') +
    '<p class="muted small">选择团队可以工作的文件夹，已有文件保留。</p></details>' +
    '<p class="guide-note">创建固定对话，此时不会执行任务。</p>' +
    foot('connection', '<button class="btn btn-primary">' + (data.manager ? '重试创建经理' : '创建总经理') + '</button>') + '</form>' +
    (data.managerChoices.length ? '<details class="guide-advanced"><summary>使用已有经理</summary><form data-form="guide-bind"><label class="field"><span>已有经理会话</span><select name="roleKey">' +
      data.managerChoices.map((m) => '<option value="' + esc(m.key) + '">' + esc(m.title + '｜' + m.name) + '</option>').join('') +
      '</select></label><p class="muted small">仅列出你已创建的经理。</p><button class="btn">使用此经理</button></form></details>' : '');
}

function employees(data, drafts) {
  return '<div class="guide-section-title"><span class="eyebrow">BUILD YOUR TEAM</span><h2>为公司添加员工</h2><p>先加一位就能开始，之后随时可以增加。</p></div>' +
    '<div class="guide-created-list">' + data.employees.map(savedRole).join('') + '</div>' +
    '<form data-form="guide-employee" class="guide-form"><div class="form-row">' +
    input('岗位', 'title', 'employeeTitle', drafts.employeeTitle, '例如：全栈开发', true) +
    input('姓名', 'name', 'employeeName', drafts.employeeName, '给员工起个名字', true) + '</div>' +
    field('负责什么', 'description', 'employeeDescription', drafts.employeeDescription, '例如：开发网页，完成后交付页面和检查结果。', { multiline: true, required: true }) +
    '<div class="guide-inline-actions"><span class="muted small">每位员工有自己的固定对话。</span><span class="spacer"></span><button class="btn">' +
    icon(ICONS.plus, 14) + '添加员工</button></div></form>' +
    foot('manager', data.employees.some((e) => e.sessionCreated) ? next('skills', '继续') : '<span class="muted small">添加第一位员工后继续</span>');
}

function skills(data, skillsData) {
  const roles = [data.manager, ...data.employees].filter(Boolean);
  return '<div class="guide-section-title"><span class="eyebrow">SKILLS</span><h2>为岗位选择技能</h2><p>技能（Skill）是可复用的工作方法，按职责选择即可。</p></div>' +
    '<p class="guide-note">下次执行任务时使用，在任务记录中查看实际情况。</p>' +
    '<form data-form="guide-skills-all"><div class="guide-skill-grid">' + roles.map((role) => '<section data-skill-role="' + esc(role.key) + '" class="guide-skill-card"><header>' + roleAvatar(asRole(role), { size: 34 }) +
      roleLabel(asRole(role), { project: false }) + '<span class="spacer"></span><span class="muted small">已保存 ' + role.skillsSaved.length + ' 个</span></header>' +
      '<div class="skill-filter"><input type="search" data-skill-filter aria-label="搜索 ' + esc(role.name) + ' 的 Skill" placeholder="搜索名称或用途"><span class="muted small" data-skill-match-count>' +
      (skillsData?.skills?.length || 0) + ' 个可用</span></div><p class="muted small hidden" data-skill-empty>没有匹配的 Skill。</p><div class="skill-list guide-skill-list" data-skill-list>' +
      (skillsData?.skills || []).map((skill) => '<label class="skill-item"><input type="checkbox" name="skill" value="' + esc(skill.path) + '" data-name="' + esc(skill.name) + '"' +
        (role.skillsSaved.some((s) => s.path === skill.path) ? ' checked' : '') + (skill.enabled ? '' : ' disabled') + '><span><strong>' + esc(skill.name) +
        '</strong><small>' + esc(skill.description) + '</small></span></label>').join('') +
      (!skillsData?.skills?.length ? '<p class="muted small">暂无可用技能，可以先跳过。</p>' : '') +
      '</div></section>').join('') + '</div>' +
    '<p class="guide-note">可以先跳过，之后随时调整。</p>' +
    foot('employees', '<button class="btn btn-primary">保存并继续</button>') + '</form>';
}

function firstTask(data, drafts) {
  return '<div class="guide-section-title"><span class="eyebrow">FIRST TASK</span><h2>把目标交给经理</h2><p>说清想做什么，经理会安排员工完成。</p></div>' +
    (data.firstRun ? '<div class="guide-explain"><h3>任务已发送</h3><p>' + esc(data.firstRun.prompt) + '</p><a class="btn" href="#/task/' + esc(data.firstRun.id) +
      '">查看进度</a></div>' : '<form data-form="guide-task" class="guide-form">' +
      field('你的目标', 'prompt', 'firstPrompt', drafts.firstPrompt, '想做什么？希望交付什么？哪些地方可以修改？', { multiline: true, required: true }) +
      '<p class="guide-note">点击发送后，AI 团队会开始执行。</p>' +
      '<button class="btn btn-primary">交给经理</button></form>') +
    foot('skills', next('tour', data.firstRun ? '继续了解进度与回报' : '稍后再说，先看看怎么用'));
}

function tour(data) {
  const managerHref = data.managerEntry;
  return '<div class="guide-section-title"><span class="eyebrow">YOUR DAILY WORKFLOW</span><h2>日常这样管理公司</h2><p>交代目标后，在这里查看进度和结果。</p></div>' +
    '<ol class="guide-process"><li><i></i><strong>提交</strong><span>任务已提交，等待经理收到。</span></li><li><i></i><strong>开工</strong><span>员工开始执行。</span></li>' +
    '<li><i></i><strong>交付</strong><span>员工交回成果，等待检查。</span></li><li><i></i><strong>验收</strong><span>经理检查结果后汇报。</span></li></ol>' +
    '<div class="guide-map"><article><span>' + icon(ICONS.sessions, 22) + '</span><h3>总经理对话</h3><p>交任务、补充要求、听汇报。</p><a href="' + esc(managerHref) + '">前往对话</a></article>' +
    '<article><span>' + icon(ICONS.roles, 22) + '</span><h3>岗位</h3><p>安排职责、调整技能、添加员工。</p><a href="#/roles">管理岗位</a></article>' +
    '<article><span>' + icon(ICONS.handoffs, 22) + '</span><h3>协作与回报</h3><p>看谁在做、做到了哪一步。</p><a href="#/team">查看协作</a></article>' +
    '<article><span>' + icon(ICONS.office, 22) + '</span><h3>办公室与审批</h3><p>看团队状态，需要决定时处理审批。</p><a href="#/office">进入办公室</a></article></div>' +
    '<p class="guide-note">暂停或停止后，记录会保留。选择续办才会继续。</p>' +
    foot(data.mode === 'personal' && data.executionMode !== 'desktop' ? 'first-task' : null, '<button type="button" class="btn btn-primary" data-action="guide-finish">' + (data.completed ? '返回公司' : '进入我的公司') + '</button>');
}

export function guideHtml(data, { drafts = {}, skillsData = null, appearanceControl = '' } = {}) {
  drafts = { ...(data.drafts || {}), ...drafts };
  const legacy = data.mode !== 'personal';
  const step = legacy ? 'tour' : data.step === 'done' ? 'tour' : data.step || 'welcome';
  const index = STEPS.findIndex(([key]) => key === step);
  const content = legacy ? tour(data) : ({
    welcome: () => welcome(data, drafts), connection: () => connection(data), manager: () => manager(data, drafts),
    employees: () => employees(data, drafts), skills: () => skills(data, skillsData), 'first-task': () => firstTask(data, drafts), tour: () => tour(data),
  }[step] || (() => welcome(data, drafts)))();
  const current = Math.max(0, index) + 1;
  return '<div class="guide-flow"><header class="guide-header"><div class="guide-brand"><span class="guide-brand-mark">' + icon(ICONS.roles, 20) +
    '</span><div><strong>' + esc(data.name || '我的公司') + '</strong><span>' + (legacy ? '使用地图' : '一个人的公司，一支 AI 团队') + '</span></div></div>' +
    '<div class="guide-header-right">' + appearanceControl + (data.completed ? '<a class="guide-return" href="#/dashboard">返回公司</a>' : '') +
    '<span class="guide-page-count">' + (legacy ? '使用引导' : '<b>' + String(current).padStart(2, '0') + '</b><span> / ' + String(STEPS.length).padStart(2, '0') + '</span>') +
    '</span></div></header><div class="guide-progress" role="progressbar" aria-label="引导进度" aria-valuemin="1" aria-valuemax="' + STEPS.length + '" aria-valuenow="' + current +
    '" aria-valuetext="第 ' + current + ' 步，共 ' + STEPS.length + ' 步：' + STEPS[Math.max(0, index)][1] + '">' +
    STEPS.map((_, i) => '<i aria-hidden="true" class="' + (i < index ? 'complete' : i === index ? 'current' : '') + '"></i>').join('') + '</div>' +
    '<div class="guide-stage"><section class="guide-panel" data-guide-step="' + step + '" tabindex="-1">' +
    (data.lastError ? '<div class="notice" role="alert">' + esc(data.lastError) + '</div>' : '') + content +
    '</section></div><footer class="guide-save-status" aria-live="polite" data-guide-save>进度自动保存，下次从这里继续</footer></div>';
}
