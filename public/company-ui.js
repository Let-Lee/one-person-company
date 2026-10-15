import { esc, icon, ICONS, roleAvatar, roleLabel, roleStatus, status } from './lib.js';

/** Display only. Original prompts, task IDs and evidence remain untouched. */
export function shortTaskTitle(run, { tasks = [], messages = [] } = {}) {
  const task = tasks.find((t) => t.id === run.teamTaskId);
  let text = task?.title || run.title || '';
  if (run.kind === 'inbox') {
    const message = messages.find((m) => (run.managerMessageIds || []).includes(m.id));
    const reported = tasks.find((t) => t.id === message?.taskId);
    return reported ? `处理回报 · ${compact(reported.title, 22)}` : '处理员工回报';
  }
  if (!text) {
    const prompt = String(run.prompt || '').replace(/<\/?(?:codex_delegation|input)[^>]*>/g, '\n');
    const lines = prompt.split('\n').map((s) => s.trim()).filter(Boolean);
    const named = lines.find((s) => /^(?:任务|任务名称|目标|修正要求)[：:]/.test(s));
    text = named?.replace(/^(?:任务|任务名称|目标|修正要求)[：:]\s*/, '') || lines.find((s) =>
      !/^(?:工作台可信任务|收件箱有|来源|执行范围|经理已授权|实际执行后|<source_thread_id>)/.test(s)) || '查看任务详情';
  }
  text = text.replace(/^(?:请|麻烦|帮我|请帮我|请你)\s*/g, '').split(/[。；\n]/)[0];
  return compact(text, 32);
}
const compact = (text, length) => {
  const chars = Array.from(String(text || '未命名任务').replace(/\s+/g, ' ').trim());
  return chars.length > length ? chars.slice(0, length - 1).join('') + '…' : chars.join('');
};

/** Relationships come exclusively from recorded manager/team bindings. */
export function organization(roles, groups = []) {
  const assigned = new Set();
  const teams = roles.filter((r) => r.collaboration?.authority === 'manager').map((manager) => {
    const namespace = manager.collaboration.namespace;
    const group = groups.find((g) => g.namespace === namespace);
    const employees = group?.managerRoleKey === manager.key ? roles.filter((r) =>
      r.collaboration?.namespace === namespace && r.collaboration.authority === 'employee') : [];
    assigned.add(manager.key); employees.forEach((r) => assigned.add(r.key));
    return { manager, employees, namespace };
  });
  return { teams, unassigned: roles.filter((r) => !assigned.has(r.key)) };
}

export function organizationHtml(roles, groups, renderRole) {
  if (!roles.length) return '<div class="empty org-empty"><strong>公司还没有岗位</strong><p>先建立经理，再按工作需要添加员工。</p><a class="btn btn-primary" href="#/guide">建立团队</a></div>';
  const { teams, unassigned } = organization(roles, groups);
  return `<div class="org-directory" aria-label="公司人员架构">${teams.map(({ manager, employees }) => `<section class="org-team" aria-label="${esc(manager.roleTitle)}的团队">
    <div class="org-lead"><span class="org-caption">任务安排与验收</span>${renderRole(manager)}</div>
    <div class="org-branch ${employees.length ? '' : 'is-empty'}" aria-label="直属员工">${employees.length ? employees.map((r) => `<div class="org-member">${renderRole(r)}</div>`).join('') : '<div class="org-hire"><p>经理已就位，按工作需要添加第一位员工。</p><button class="btn" data-action="new-role">添加员工</button></div>'}</div>
  </section>`).join('')}${unassigned.length ? `<section class="group"><h2 class="group-title">未关联汇报关系<span>${unassigned.length}</span></h2><div class="role-grid">${unassigned.map(renderRole).join('')}</div></section>` : ''}</div>`;
}

export function teamRoleCard(role, actionHref) {
  const skillList = role.skills || [];
  return `<article class="role-card org-card state-${esc(role.liveState)}" data-role-key="${esc(role.key)}" style="--a:${role.appearance.a};--b:${role.appearance.b}">
    <a class="role-card-main" href="#/role/${encodeURIComponent(role.key)}">${roleAvatar(role, { size: 50 })}<span class="role-card-text">${roleLabel(role, { size: 'lg', project: false })}<span class="role-card-context">${role.collaboration?.authority === 'manager' ? '总经理' : role.collaboration?.authority === 'employee' ? '团队员工' : '独立岗位'}</span></span></a>
    <div class="role-card-foot">${status(roleStatus(role.liveState))}<span class="spacer"></span><span class="muted small">${role.stableSessionId ? '固定会话已建立' : '会话待建立'}</span></div>
    ${skillList.length ? `<div class="chips">${skillList.slice(0, 3).map((s) => `<span class="chip chip-skill">${esc(s.name)}</span>`).join('')}${skillList.length > 3 ? `<span class="chip">+${skillList.length - 3}</span>` : ''}</div>` : ''}
    <div class="role-card-actions"><a class="btn btn-sm btn-primary" href="${actionHref}">${role.source === 'company' ? '协作过程' : role.stableSessionId ? '打开对话' : '安排任务'}</a><a class="btn btn-sm" href="#/role/${encodeURIComponent(role.key)}">职责与技能</a></div>
  </article>`;
}

export function employeeDialogHtml(setup, appearance) {
  const manager = setup?.manager;
  return `<dialog id="employee-dialog" aria-labelledby="employee-dialog-title"><form data-form="new-employee" data-draft-key="new-employee" class="dialog-form" data-stable>
    <header class="dialog-heading"><div><span class="eyebrow">BUILD YOUR TEAM</span><h2 id="employee-dialog-title">添加一位员工</h2></div><button class="btn btn-ghost btn-sm" type="button" data-action="close-dialog" aria-label="关闭新增岗位">关闭</button></header>
    ${manager ? `<div class="employee-manager">${roleAvatar({ ...manager, roleTitle: manager.title, liveState: 'idle' }, { size: 34 })}<div><span class="small muted">汇报给</span><strong>${esc(manager.title)}<small>｜${esc(manager.name)}</small></strong></div><span class="chip">加入当前公司</span></div>
    <div class="form-row"><label class="field"><span>岗位名称</span><input name="title" required maxlength="40" placeholder="例如：内容策划"></label><label class="field"><span>成员姓名</span><input name="name" required maxlength="24" placeholder="给员工起个名字"></label></div>
    <label class="field"><span>负责什么</span><textarea name="description" rows="5" maxlength="4000" required placeholder="写明岗位职责、工作范围和交付要求。"></textarea></label>
    <details class="employee-appearance"><summary>选择岗位形象</summary>${appearance}</details>
    <p class="muted small">保存岗位并建立固定会话，不会开始执行任务。之后可在岗位配置中选择 Skill。</p><p class="form-error hidden" role="alert" data-form-error></p>
    <footer class="form-foot"><button class="btn" type="button" data-action="close-dialog">取消</button><span class="spacer"></span><button class="btn btn-primary" type="submit">保存并加入团队</button></footer>` : '<div class="notice">当前没有已绑定的总经理，请先完成团队连接。</div><a class="btn" href="#/system">查看连接设置</a>'}
  </form></dialog>`;
}
