// Orthogonal office routes. Geometry is independent of the DOM so clearance can be verified.
const EPS = 0.01;
const num = (n) => Math.round(n * 10) / 10;
const pointKey = ([x, y]) => `${num(x)},${num(y)}`;

export function mergeOfficeRoutes(edges) {
  const pairs = new Map();
  for (const edge of edges) {
    const [from, to] = [edge.from, edge.to].sort();
    const key = `${from}|${to}`;
    const route = pairs.get(key) || { key, from, to, count: 0, channels: new Set(), kinds: {}, live: false, last: '', flowFrom: from };
    route.count += edge.count;
    route.channels.add(edge.channel);
    route.kinds[edge.kind] = (route.kinds[edge.kind] || 0) + edge.count;
    if (edge.last >= route.last) {
      route.last = edge.last;
      if (!route.live) route.flowFrom = edge.from;
    }
    if (edge.live) { route.live = true; route.flowFrom = edge.from; }
    pairs.set(key, route);
  }
  return [...pairs.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.count - a.count || a.key.localeCompare(b.key));
}

export function segmentBlocked(a, b, obstacles) {
  return obstacles.some((r) => a[0] === b[0]
    ? a[0] > r.x + EPS && a[0] < r.x + r.w - EPS && Math.max(a[1], b[1]) > r.y + EPS && Math.min(a[1], b[1]) < r.y + r.h - EPS
    : a[1] > r.y + EPS && a[1] < r.y + r.h - EPS && Math.max(a[0], b[0]) > r.x + EPS && Math.min(a[0], b[0]) < r.x + r.w - EPS);
}

function simplify(points) {
  const result = [];
  for (const p of points) {
    if (result.length && pointKey(result.at(-1)) === pointKey(p)) continue;
    while (result.length > 1) {
      const a = result.at(-2), b = result.at(-1);
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) result.pop();
      else break;
    }
    result.push(p);
  }
  return result;
}

export function roundedRoute(points, radius = 10) {
  if (!points.length) return '';
  let d = `M${points[0].map(num).join(' ')}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i], next = points[i + 1], prev = points[i - 1];
    if (!next) { d += `L${p.map(num).join(' ')}`; break; }
    const before = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const after = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const r = Math.min(radius, before / 2, after / 2);
    const entry = [p[0] + (prev[0] - p[0]) * r / before, p[1] + (prev[1] - p[1]) * r / before];
    const exit = [p[0] + (next[0] - p[0]) * r / after, p[1] + (next[1] - p[1]) * r / after];
    d += `L${entry.map(num).join(' ')}Q${p.map(num).join(' ')} ${exit.map(num).join(' ')}`;
  }
  return d;
}

class Heap {
  items = [];
  push(item) {
    let i = this.items.length;
    this.items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].cost <= item.cost) break;
      this.items[i] = this.items[parent]; i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].cost < this.items[child].cost) child += 1;
        if (this.items[child].cost >= last.cost) break;
        this.items[i] = this.items[child]; i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

/** Bottom ports reach the aisles; shared graph segments form a consistent main corridor. */
export function routeOfficeConnections(connections, nodes, headers, zones, width, height) {
  const clearance = 7;
  const inflate = (r, gap) => ({ x: num(r.x - gap), y: num(r.y - gap), w: num(r.w + 2 * gap), h: num(r.h + 2 * gap) });
  const obstacles = [...Object.values(nodes).map((r) => inflate(r, clearance)), ...headers.map((r) => inflate(r, 3))];
  const ports = Object.fromEntries(Object.entries(nodes).map(([key, r]) => [key, [num(r.x + r.w / 2), num(r.y + r.h + clearance + 1)]]));
  const xs = new Set([11, num(width - 11)]), ys = new Set([11, num(height - 11)]);
  for (const p of Object.values(ports)) { xs.add(p[0]); ys.add(p[1]); }
  for (const r of obstacles) { xs.add(r.x); xs.add(num(r.x + r.w)); ys.add(r.y); ys.add(num(r.y + r.h)); }
  for (const r of zones) {
    xs.add(num(r.x - 9)); xs.add(num(r.x + r.w + 9));
    ys.add(num(r.y - 9)); ys.add(num(r.y + r.h + 9));
  }
  const X = [...xs].filter((x) => x >= 8 && x <= width - 8).sort((a, b) => a - b);
  const Y = [...ys].filter((y) => y >= 8 && y <= height - 8).sort((a, b) => a - b);
  const points = [], at = new Map(), graph = [];
  for (const y of Y) for (const x of X) {
    if (obstacles.some((r) => x > r.x + EPS && x < r.x + r.w - EPS && y > r.y + EPS && y < r.y + r.h - EPS)) continue;
    at.set(pointKey([x, y]), points.length); points.push([x, y]); graph.push([]);
  }
  const used = new Set();
  const segmentKey = (a, b) => [a, b].sort((x, y) => x - y).join('|');
  const link = (a, b, dir) => {
    if (segmentBlocked(points[a], points[b], obstacles)) return;
    const p = points[a], q = points[b];
    const length = Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const inRoom = zones.some((r) => mx > r.x + 1 && mx < r.x + r.w - 1 && my > r.y + 1 && my < r.y + r.h - 1);
    const weight = length * (inRoom ? 3 : 1);
    graph[a].push({ node: b, dir, weight }); graph[b].push({ node: a, dir, weight });
  };
  for (const y of Y) {
    let prev;
    for (const x of X) { const id = at.get(pointKey([x, y])); if (id === undefined) continue; if (prev !== undefined) link(prev, id, 1); prev = id; }
  }
  for (const x of X) {
    let prev;
    for (const y of Y) { const id = at.get(pointKey([x, y])); if (id === undefined) continue; if (prev !== undefined) link(prev, id, 2); prev = id; }
  }
  const routed = [];
  for (const connection of connections) {
    if (!ports[connection.from] || !ports[connection.to]) continue;
    const start = at.get(pointKey(ports[connection.from])), end = at.get(pointKey(ports[connection.to]));
    if (start === undefined || end === undefined) continue;
    const heap = new Heap(), dist = new Map(), previous = new Map();
    const initial = start * 3;
    dist.set(initial, 0); heap.push({ state: initial, cost: 0 });
    let goal;
    while (heap.items.length) {
      const { state, cost } = heap.pop();
      if (cost !== dist.get(state)) continue;
      const node = Math.floor(state / 3), dir = state % 3;
      if (node === end) { goal = state; break; }
      for (const edge of graph[node]) {
        const next = edge.node * 3 + edge.dir;
        const weight = edge.weight * (used.has(segmentKey(node, edge.node)) ? 0.72 : 1);
        const nextCost = cost + weight + (dir && dir !== edge.dir ? 20 : 0);
        if (nextCost >= (dist.get(next) ?? Infinity)) continue;
        dist.set(next, nextCost); previous.set(next, state); heap.push({ state: next, cost: nextCost });
      }
    }
    if (goal === undefined) continue;
    const path = [];
    for (let state = goal; state !== undefined; state = previous.get(state)) path.push(Math.floor(state / 3));
    path.reverse();
    for (let i = 1; i < path.length; i += 1) used.add(segmentKey(path[i - 1], path[i]));
    const from = nodes[connection.from], to = nodes[connection.to];
    const pts = simplify([[ports[connection.from][0], num(from.y + from.h + 2)], ...path.map((id) => points[id]), [ports[connection.to][0], num(to.y + to.h + 2)]]);
    routed.push({ ...connection, points: pts, d: roundedRoute(pts), length: pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) });
  }
  return routed;
}
