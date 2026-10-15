// Paired channels use the same orthogonal corridor. At the workstations,
// dispatch always occupies the left port and return the right port.
const EPS = 0.01;
const GAP = 14;
const num = n => Math.round(n * 10) / 10;

export function mergeOfficeRoutes(edges) {
  const merged = new Map();
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.lane || edge.kind}`;
    const route = merged.get(key);
    if (route) {
      route.count += edge.count;
      route.channels.add(edge.channel);
      route.live ||= edge.live;
      if (Date.parse(edge.last) > Date.parse(route.last)) route.last = edge.last;
      route.kinds[edge.kind] = (route.kinds[edge.kind] || 0) + edge.count;
    } else merged.set(key, { ...edge, key, channels: new Set([edge.channel]), kinds: { [edge.kind]: edge.count }, flowFrom: edge.from });
  }
  return [...merged.values()].sort((a, b) => Number(b.live) - Number(a.live) || b.count - a.count || a.key.localeCompare(b.key));
}

// Segment/rectangle intersection works for diagonal as well as vertical lines.
export function segmentBlocked(a, b, obstacles) {
  return obstacles.some(r => {
    let low = 0, high = 1;
    for (let axis = 0; axis < 2; axis++) {
      const start = axis ? r.y + EPS : r.x + EPS;
      const end = axis ? r.y + r.h - EPS : r.x + r.w - EPS;
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < EPS) { if (a[axis] <= start || a[axis] >= end) return false; }
      else {
        const t1 = (start - a[axis]) / delta, t2 = (end - a[axis]) / delta;
        low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
        if (low >= high - 1e-9) return false;
      }
    }
    return low < high - 1e-9;
  });
}

export function orthogonalRoute(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.map(num).join(' ')}`).join('');
}

function compact(points) {
  return points.filter((p, i) => !i || Math.abs(p[0] - points[i - 1][0]) > EPS || Math.abs(p[1] - points[i - 1][1]) > EPS)
    .filter((p, i, all) => !i || i === all.length - 1 || !((Math.abs(all[i - 1][0] - p[0]) < EPS && Math.abs(p[0] - all[i + 1][0]) < EPS) || (Math.abs(all[i - 1][1] - p[1]) < EPS && Math.abs(p[1] - all[i + 1][1]) < EPS)));
}

export function routeOfficeConnections(connections, nodes, headers, _zones, _width, _height) {
  const bundles = new Map(), ports = new Map(), corridors = new Map();
  for (const edge of connections) {
    if (!nodes[edge.from] || !nodes[edge.to] || edge.from === edge.to) continue;
    const key = [edge.from, edge.to].sort().join('|');
    if (!bundles.has(key)) {
      const [a, b] = [edge.from, edge.to].sort((x, y) => nodes[x].y - nodes[y].y || nodes[x].x - nodes[y].x);
      const vertical = nodes[a].y + nodes[a].h <= nodes[b].y;
      bundles.set(key, { key, a, b, vertical, members: [] });
    }
    bundles.get(key).members.push(edge);
  }
  for (const bundle of bundles.values()) {
    for (const [key, other, side] of [[bundle.a, bundle.b, bundle.vertical ? 'bottom' : 'right'], [bundle.b, bundle.a, bundle.vertical ? 'top' : 'left']]) {
      const id = `${key}:${side}`;
      if (!ports.has(id)) ports.set(id, []);
      ports.get(id).push({ key, other, side, bundle });
    }
  }
  for (const group of ports.values()) {
    group.sort((a, b) => nodes[a.other].x + nodes[a.other].w / 2 - nodes[b.other].x - nodes[b.other].w / 2 || a.bundle.key.localeCompare(b.bundle.key));
    group.forEach((port, i) => {
      const r = nodes[port.key], vertical = port.bundle.vertical;
      const length = vertical ? r.w : r.h, margin = 14;
      port.bundle.gap = Math.min(port.bundle.gap || GAP, GAP, (length - margin * 2) / (group.length + 1) * 0.65);
      const position = margin + (length - margin * 2) * (i + 1) / (group.length + 1);
      const point = vertical ? [r.x + position, port.side === 'top' ? r.y - 1 : r.y + r.h + 1] : [port.side === 'left' ? r.x - 1 : r.x + r.w + 1, r.y + position];
      port.bundle[port.key === port.bundle.a ? 'p1' : 'p2'] = point;
    });
  }
  for (const bundle of bundles.values()) {
    if (!bundle.vertical) continue;
    const [p1, p2] = [bundle.p1, bundle.p2];
    // Nearly aligned workstations use one vertical pair, not a tiny sideways jog.
    if (Math.abs(p2[0] - p1[0]) < GAP * 2) {
      const x = (p1[0] + p2[0]) / 2;
      p1[0] = x; p2[0] = x;
      continue;
    }
    const side = p2[0] < p1[0] ? 'left' : 'right';
    const id = `${bundle.a}:${num(p2[1])}:${side}`;
    if (!corridors.has(id)) corridors.set(id, []);
    corridors.get(id).push(bundle);
  }
  for (const group of corridors.values()) {
    // Outer employees turn first. Inner pairs turn below them, so neither the
    // horizontal runs nor the vertical drops cross another relationship.
    group.sort((a, b) => Math.abs(b.p2[0] - b.p1[0]) - Math.abs(a.p2[0] - a.p1[0]) || a.key.localeCompare(b.key));
    group.forEach((bundle, i) => {
      const top = bundle.p1[1] + 16, bottom = bundle.p2[1] - 16;
      bundle.bendY = top + (bottom - top) * (i + 1) / (group.length + 1);
    });
  }
  const routed = [];
  for (const bundle of bundles.values()) {
    for (const edge of bundle.members) {
      const dispatch = edge.lane === 'dispatch' || edge.kind === 'dispatch';
      const shift = (dispatch ? -1 : 1) * bundle.gap / 2;
      const offset = p => bundle.vertical ? [num(p[0] + shift), num(p[1])] : [num(p[0]), num(p[1] + shift)];
      let points = [offset(bundle.p1), offset(bundle.p2)];
      if (bundle.vertical && bundle.bendY !== undefined) {
        const y = num(bundle.bendY - shift * Math.sign(bundle.p2[0] - bundle.p1[0]));
        points = compact([points[0], [points[0][0], y], [points[1][0], y], points[1]]);
      } else if (!bundle.vertical && Math.abs(points[0][1] - points[1][1]) > EPS) {
        const x = num((points[0][0] + points[1][0]) / 2);
        points = compact([points[0], [x, points[0][1]], [x, points[1][1]], points[1]]);
      }
      if (edge.from !== bundle.a) points = points.reverse();
      const obstacles = [...Object.values(nodes), ...headers];
      if (points.slice(1).some((p, i) => segmentBlocked(points[i], p, obstacles))) continue;
      const length = points.slice(1).reduce((n, p, i) => n + Math.abs(p[0] - points[i][0]) + Math.abs(p[1] - points[i][1]), 0);
      routed.push({ ...edge, bundleKey: bundle.key, points, d: orthogonalRoute(points), length });
    }
  }
  return routed;
}
