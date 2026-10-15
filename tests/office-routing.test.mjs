import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeOfficeRoutes, routeOfficeConnections, segmentBlocked } from '../public/office-routing.js';

test('opposite handoffs share one route without losing counts or active direction', () => {
  const merged = mergeOfficeRoutes([
    { from: 'manager', to: 'developer', kind: 'dispatch', channel: 'native', count: 5, last: '2026-10-14T01:00:00Z', live: false },
    { from: 'developer', to: 'manager', kind: 'report', channel: 'native', count: 3, last: '2026-10-14T02:00:00Z', live: false },
    { from: 'manager', to: 'developer', kind: 'dispatch', channel: 'runner', count: 1, last: '2026-10-14T03:00:00Z', live: true },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 9);
  assert.deepEqual(merged[0].kinds, { dispatch: 6, report: 3 });
  assert.equal(merged[0].flowFrom, 'manager');
  assert.equal(merged[0].live, true);
  assert.deepEqual([...merged[0].channels], ['native', 'runner']);
});

test('routes use corridors and never cross unrelated workstations or headers', () => {
  const nodes = {
    manager: { x: 40, y: 55, w: 100, h: 125 },
    director: { x: 160, y: 55, w: 100, h: 125 },
    developer: { x: 40, y: 260, w: 100, h: 125 },
    designer: { x: 160, y: 260, w: 100, h: 125 },
    finance: { x: 40, y: 460, w: 100, h: 125 },
    console: { x: 350, y: 55, w: 150, h: 100 },
  };
  const headers = [{ x: 35, y: 225, w: 240, h: 18 }, { x: 35, y: 425, w: 240, h: 18 }];
  const zones = [{ x: 20, y: 20, w: 270, h: 185 }, { x: 20, y: 220, w: 270, h: 185 }, { x: 20, y: 420, w: 270, h: 190 }];
  const connections = mergeOfficeRoutes(['developer', 'designer', 'finance', 'director', 'console'].map((to) => ({ from: 'manager', to, kind: 'dispatch', channel: 'native', count: 1, live: false, last: '' })));
  const routes = routeOfficeConnections(connections, nodes, headers, zones, 560, 650);
  assert.equal(routes.length, connections.length);
  for (const route of routes) {
    for (let i = 1; i < route.points.length; i += 1) {
      const a = route.points[i - 1], b = route.points[i];
      assert.ok(a[0] === b[0] || a[1] === b[1], `${route.key} has a diagonal`);
      assert.equal(segmentBlocked(a, b, [...Object.values(nodes), ...headers]), false, `${route.key} collides with a workstation`);
    }
    assert.ok(route.points.every(([x, y]) => x >= 0 && y >= 0 && x <= 560 && y <= 650));
  }
});

test('missing nodes and sealed routes do not draw fabricated direct connections', () => {
  const routes = routeOfficeConnections([{ from: 'a', to: 'missing' }], { a: { x: 20, y: 20, w: 80, h: 100 } }, [], [], 300, 300);
  assert.deepEqual(routes, []);
});
