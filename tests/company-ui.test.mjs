import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortTaskTitle, organization } from '../public/company-ui.js';
import { officeEdges, officeHtml } from '../public/office.js';
import { mergeOfficeRoutes, routeOfficeConnections } from '../public/office-routing.js';

test('task names use the goal, never the dispatch envelope, and do not mutate recorded prompts', () => {
  const prompt = '工作台可信任务 teamtask_abcdefgh（第 1 次执行）\n任务：修复登录页面\n经理已授权的协作岗位：无\n执行范围：当前工作区';
  const run = { prompt, teamTaskId: 'a' };
  assert.equal(shortTaskTitle(run), '修复登录页面');
  assert.equal(run.prompt, prompt);
  assert.equal(shortTaskTitle(run, { tasks: [{ id: 'a', title: '检查首页布局' }] }), '检查首页布局');
  assert.equal(shortTaskTitle({ kind: 'inbox', prompt: '收件箱有 20 条待处理关键回报，已绑定到本轮。' }), '处理员工回报');
  assert.ok(Array.from(shortTaskTitle({ prompt: '整理' + '工作内容'.repeat(100) })).length <= 32);
});

test('organization includes only recorded reporting relationships, including zero and single-member cases', () => {
  const manager = { key: 'm', collaboration: { namespace: 'team-a', authority: 'manager' } };
  const staff = { key: 'e', collaboration: { namespace: 'team-a', authority: 'employee' } };
  const other = { key: 'x', collaboration: { namespace: 'team-b', authority: 'employee' } };
  assert.deepEqual(organization([]), { teams: [], unassigned: [] });
  assert.equal(organization([manager]).teams[0].employees.length, 0);
  const org = organization([manager, staff, other], [{ namespace: 'team-a', managerRoleKey: 'm' }]);
  assert.deepEqual(org.teams[0].employees.map((r) => r.key), ['e']);
  assert.deepEqual(org.unassigned.map((r) => r.key), ['x']);
  assert.equal(organization([manager, staff], [{ namespace: 'team-a', managerRoleKey: 'wrong' }]).teams[0].employees.length, 0);
});

test('office colors follow actual dispatch, completion, approval and error events, not palette or ordinary progress', () => {
  const at = new Date().toISOString(), roles = [{ key: 'm' }, { key: 'e' }];
  const handoffs = [
    { fromRole: 'm', toRole: 'e', kind: 'dispatch', at, channel: 'runner' },
    { fromRole: 'e', toRole: 'm', kind: 'report', reportKind: 'completed', at, channel: 'runner' },
    { fromRole: 'e', toRole: 'm', kind: 'report', reportKind: 'progress', at, channel: 'runner' },
    { fromRole: 'e', toRole: 'm', kind: 'report', reportKind: 'blocked', at, channel: 'runner' },
  ];
  const runs = [{ id: 'r', roleKey: 'e', status: 'waiting_approval', dispatcher: { roleKey: 'm' } }];
  const edges = officeEdges(handoffs, roles, runs, '48h', [{ id: 'a', runId: 'r', roleKey: 'e', createdAt: at, status: 'pending' }]);
  assert.deepEqual(edges.map((e) => e.kind).sort(), ['approval', 'dispatch']);
  assert.equal(edges.find((e) => e.lane === 'return').from, 'e');
  assert.equal(edges.find((e) => e.kind === 'dispatch').from, 'm');
  assert.equal(edges.find((e) => e.kind === 'approval').to, 'm');
  const html = officeHtml({ roles: [], runs: [], overview: { counts: {} }, handoffs: [], focusKey: '', range: '48h' }).html;
  assert.doesNotMatch(html, /休息区|会议室|玻璃隔间/);
  assert.match(html, /href="#\/approvals"/);
});

test('the same return lane changes orange to red to green instead of keeping three historical state lines', () => {
  const at = i => new Date(Date.now() - 20000 + i * 1000).toISOString();
  const roles = [{ key: 'm' }, { key: 'e' }];
  const dispatch = { fromRole: 'm', toRole: 'e', kind: 'dispatch', at: at(0), runId: 'r', channel: 'runner' };
  const run = { id: 'r', roleKey: 'e', status: 'waiting_approval', dispatcher: { roleKey: 'm' }, createdAt: at(0) };
  const approval = { id: 'a', runId: 'r', roleKey: 'e', createdAt: at(1), status: 'pending' };
  const messages = [dispatch];
  const nodes = { m: { x: 200, y: 50, w: 160, h: 150 }, e: { x: 200, y: 350, w: 144, h: 150 } };
  const shape = edges => routeOfficeConnections(mergeOfficeRoutes(edges), nodes, [], [], 600, 600).map(r => [r.lane, r.d]);
  let edges = officeEdges(messages, roles, [run], '48h', [approval]);
  assert.equal(edges.length, 2); assert.equal(edges[1].kind, 'approval');
  const approvedPath = shape(edges);
  run.status = 'failed'; run.completedAt = at(2); approval.status = 'rejected';
  messages.push({ fromRole: 'e', toRole: 'm', kind: 'report', reportKind: 'blocked', at: at(2), runId: 'r', channel: 'runner' });
  edges = officeEdges(messages, roles, [run], '48h', [approval]);
  assert.equal(edges.length, 2); assert.equal(edges[1].kind, 'error');
  assert.deepEqual(shape(edges), approvedPath, 'an error changes the return color, not its path');
  run.status = 'completed'; run.completedAt = at(3);
  messages.push({ fromRole: 'e', toRole: 'm', kind: 'report', reportKind: 'completed', at: at(3), runId: 'r', channel: 'runner' });
  edges = officeEdges(messages, roles, [run], '48h', [approval]);
  assert.equal(edges.length, 2); assert.equal(edges[0].kind, 'dispatch'); assert.equal(edges[1].kind, 'report');
  assert.deepEqual(shape(edges), approvedPath, 'completion changes the same return lane to green');
  assert.equal(edges[1].from, 'e'); assert.equal(edges[1].to, 'm');
  assert.equal(messages.length, 3, 'historical error and completion evidence stays intact');
  messages.push({ ...dispatch, at: at(4), runId: 'next' });
  edges = officeEdges(messages, roles, [run], '48h', [approval]);
  assert.equal(edges.length, 1, 'a new assignment cannot inherit the old green completion line');
});
