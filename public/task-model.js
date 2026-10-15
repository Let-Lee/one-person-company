// Display only: never infer relationships from wording, session or time.
export function taskGroups(runs = [], { tasks = [], messages = [] } = {}, approvals = []) {
  const rm = new Map(runs.map(r => [r.id, r])), tm = new Map(tasks.map(t => [t.id, t])), mm = new Map(messages.map(m => [m.id, m]));
  const roots = (run, seen = new Set()) => {
    if (!run) return [];
    if (seen.has(run.id)) return [`run:${run.id}`];
    const next = new Set(seen).add(run.id);
    if (run.teamTaskId && tm.has(run.teamTaskId)) {
      const task = tm.get(run.teamTaskId), found = roots(rm.get(task.origin?.runId), next);
      return found.length === 1 ? found : [`task:${task.id}`];
    }
    if (run.kind === 'inbox') {
      const found = [...new Set((run.managerMessageIds || []).flatMap(id => {
        const task = tm.get(mm.get(id)?.taskId);
        if (!task) return [];
        const rr = roots(rm.get(task.origin?.runId), next);
        return rr.length === 1 ? rr : [`task:${task.id}`];
      }))];
      return found.length ? found : [`run:${run.id}`];
    }
    if (run.parentRunId && rm.has(run.parentRunId)) return roots(rm.get(run.parentRunId), next);
    return [`run:${run.id}`];
  };
  const groups = new Map();
  const get = key => { if (!groups.has(key)) groups.set(key, { id: key, runs: [], tasks: [], messages: [] }); return groups.get(key); };
  for (const run of runs) for (const key of roots(run)) get(key).runs.push(run);
  for (const task of tasks) {
    const found = roots(rm.get(task.origin?.runId));
    get(found.length === 1 ? found[0] : `task:${task.id}`).tasks.push(task);
  }
  for (const g of groups.values()) {
    const ids = new Set(g.tasks.map(t => t.id));
    g.messages = messages.filter(m => ids.has(m.taskId));
    g.runs.sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    g.root = g.id.startsWith('run:') ? rm.get(g.id.slice(4)) : null;
    g.ownerRoleKey = g.root?.roleKey || g.tasks[0]?.managerRoleKey || g.runs[0]?.roleKey;
    g.createdAt = g.root?.createdAt || g.tasks[0]?.createdAt || g.runs[0]?.createdAt;
    g.updatedAt = [g.createdAt, ...g.runs.map(r => r.completedAt || r.startedAt || r.createdAt), ...g.tasks.map(t => t.acceptedAt || t.deliveredAt || t.startedAt || t.createdAt)].filter(Boolean).sort().at(-1);
    g.participants = [...new Set([...g.runs.map(r => r.roleKey), ...g.tasks.flatMap(t => [t.managerRoleKey, t.employeeRoleKey, ...(t.collaborators || [])])].filter(Boolean))];
    const runIds = new Set(g.runs.map(r => r.id)), states = g.tasks.map(t => t.status);
    g.status = approvals.some(a => a.status === 'pending' && runIds.has(a.runId)) || states.includes('needs_decision') ? 'waiting_approval'
      : states.includes('blocked') ? 'blocked'
      : states.some(s => ['paused','interrupted'].includes(s)) ? 'interrupted'
      : g.runs.some(r => ['starting','running','waiting_approval'].includes(r.status)) ? 'running'
      : states.some(s => ['submitted','running'].includes(s)) || g.runs.some(r => r.status === 'queued') ? 'queued'
      : states.includes('delivered') ? 'delivered'
      : g.tasks.length ? (states.every(s => s === 'cancelled') ? 'cancelled' : states.every(s => ['accepted','cancelled'].includes(s)) ? 'completed' : 'queued')
      : g.runs.at(-1)?.status || 'queued';
    g.label = ({ blocked: '有阻碍', delivered: '待验收' })[g.status];
    g.tone = ({ blocked: 'error', delivered: 'waiting' })[g.status];
    g.sharedProcess = g.runs.some(r => roots(r).length > 1);
  }
  return [...groups.values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Configured defaults are never actual turn evidence.
export function actualRoleModel(role, runs = []) {
  const own = runs.filter(r => r.roleKey === role.key).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const active = own.find(r => ['starting','running','waiting_approval'].includes(r.status));
  const run = active || own.find(r => r.turnId || r.startedAt), evidence = run?.actualModel;
  if (!run) return { text: own.length ? '待确认' : '未运行', source: '尚无实际运行模型记录' };
  if (!evidence?.id || evidence.turnId !== run.turnId) return { text: '待确认', source: '运行端未返回这一轮的实际模型；默认配置不作依据' };
  return { text: `${active ? '' : '上次 · '}${evidence.id}`, source: `${evidence.source} · 回合 ${evidence.turnId}${evidence.provider ? ` · 渠道 ${evidence.provider}` : ''}；不推断供应商底层模型` };
}
