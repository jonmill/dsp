import { describe, expect, it } from 'vitest';
import type { GridPoint, PlacedBuilding } from '../geometry';
import { checkGeometry } from '../validate/geometry-checks';
import { LayoutKit } from '../validate/testkit';
import type { BeltNet, Netlist } from './netlist';
import { routeNets } from './router';
import type { RouteParams, RoutedNet } from './router';
import type { AssignedTap, TapAssignment } from './taps';
import { ASSEMBLER, data, effects, ILS, occupancyOf, PLS, synthNetlist } from './testkit';

const never = () => false;
const WINDOW = { minX: 0, minY: 0, maxX: 20, maxY: 20 };

const params = (over: Partial<RouteParams> = {}): RouteParams => ({
  maxIterations: 40,
  presentFactorStart: 0.5,
  presentFactorGrowth: 1.5,
  historyFactor: 1,
  allowElevation: true,
  maxLevel: 2,
  bounds: WINDOW,
  ...over,
});

type Dir = [number, number];
const E: Dir = [1, 0];
const W: Dir = [-1, 0];
const N: Dir = [0, 1];
const S: Dir = [0, -1];

/** A net from station port `a` (facing `fa`) to station port `b` (facing `fb`), plus the given taps. */
interface Spec {
  id: number;
  source?: { x: number; y: number; dir: Dir };
  sink?: { x: number; y: number; dir: Dir };
  taps?: { x: number; y: number; axis: 'x' | 'y'; dir: 'in' | 'out' }[];
}

function build(specs: Spec[]): { net: Netlist; taps: TapAssignment } {
  const nets: Partial<BeltNet>[] = specs.map((s) => ({
    source: s.source ? { kind: 'station', stationIdx: 0 } : { kind: 'taps' },
    sink: s.sink ? { kind: 'station', stationIdx: 0 } : { kind: 'deadEnd' },
    taps: (s.taps ?? []).map((t, i) => ({ machineId: 1 + i, itemId: 1001, dir: t.dir, rate: 1, sorters: 1 })),
  }));
  const net = synthNetlist([{ building: ASSEMBLER, count: 12 }], [PLS], nets);
  const assigned: AssignedTap[] = [];
  const ports: TapAssignment['stationPorts'] = [];
  let port = 0;
  for (const s of specs) {
    (s.taps ?? []).forEach((t, i) =>
      assigned.push({
        netId: s.id,
        machineId: 1 + i,
        slot: 0,
        span: 1,
        point: { x: t.x, y: t.y },
        axis: t.axis,
        dir: t.dir,
        sorterIndex: 0,
        rate: 1,
      }),
    );
    if (s.source) ports.push({ netId: s.id, stationBuildingId: 1, port: port++, point: { x: s.source.x, y: s.source.y }, end: 'source', dir: s.source.dir });
    if (s.sink) ports.push({ netId: s.id, stationBuildingId: 1, port: port++, point: { x: s.sink.x, y: s.sink.y }, end: 'sink', dir: s.sink.dir });
  }
  return { net, taps: { taps: assigned, stationPorts: ports } };
}

function route(specs: Spec[], over: Partial<RouteParams> = {}, obstacles: PlacedBuilding[] = []) {
  const { net, taps } = build(specs);
  return routeNets(net, taps, occupancyOf(obstacles), params(over), never);
}

function routeOf(res: { routes: RoutedNet[] }, netId: number): GridPoint[] {
  const r = res.routes.find((x) => x.netId === netId);
  if (!r) throw new Error(`no route for net ${netId}`);
  return r.nodes;
}

const adjacent4 = (a: GridPoint, b: GridPoint): boolean => a.z === b.z && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const at = (nodes: GridPoint[], x: number, y: number, z = 0): number =>
  nodes.findIndex((p) => p.x === x && p.y === y && p.z === z);

/** The BELT_* violations of the routes laid out as belts on an otherwise empty map (plus `buildings`). */
function beltViolations(routes: RoutedNet[], buildings: PlacedBuilding[] = []) {
  const kit = new LayoutKit();
  for (const b of buildings) kit.building(b.itemId, b.x, b.y, b.yaw);
  for (const r of routes) kit.belt(1, 1001, r.nodes);
  return checkGeometry(kit.layout(), data, effects).filter((v) => v.code.startsWith('BELT_') && v.code !== 'BELT_PORT_MISMATCH');
}

describe('routeNets: one net in an empty area', () => {
  it('finds a shortest path of 4-adjacent nodes between two ports', () => {
    const res = route([{ id: 1, source: { x: 2, y: 5, dir: E }, sink: { x: 17, y: 15, dir: W } }]);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    // 15 east and 10 north: 25 steps, 26 nodes
    expect(nodes).toHaveLength(26);
    for (let i = 1; i < nodes.length; i++) expect(adjacent4(nodes[i - 1], nodes[i]), `step ${i}`).toBe(true);
    expect(nodes.every((p) => p.z === 0)).toBe(true);
    expect(nodes[0]).toEqual({ x: 2, y: 5, z: 0 });
    expect(nodes[nodes.length - 1]).toEqual({ x: 17, y: 15, z: 0 });
  });

  it('steps straight out of the source port and straight into the sink port', () => {
    const res = route([{ id: 1, source: { x: 2, y: 5, dir: E }, sink: { x: 17, y: 15, dir: W } }]);
    const nodes = routeOf(res, 1);
    expect(nodes[1]).toEqual({ x: 3, y: 5, z: 0 });
    expect(nodes[nodes.length - 2]).toEqual({ x: 16, y: 15, z: 0 });
    // and a port facing away from the other end is left by a straight step before the belt turns round
    const back = routeOf(route([{ id: 1, source: { x: 10, y: 10, dir: W }, sink: { x: 17, y: 10, dir: W } }]), 1);
    expect(back[1]).toEqual({ x: 9, y: 10, z: 0 });
    expect(back[0]).toEqual({ x: 10, y: 10, z: 0 });
    for (let i = 2; i < back.length; i++) expect(back[i]).not.toEqual(back[i - 2]);
  });

  it('is deterministic', () => {
    const specs: Spec[] = [{ id: 1, source: { x: 2, y: 5, dir: E }, sink: { x: 17, y: 15, dir: W } }];
    expect(route(specs)).toEqual(route(specs));
  });
});

describe('routeNets: crossings', () => {
  const cross: Spec[] = [
    { id: 1, source: { x: 0, y: 10, dir: E }, sink: { x: 20, y: 10, dir: W } },
    { id: 2, source: { x: 10, y: 0, dir: N }, sink: { x: 10, y: 20, dir: S } },
  ];

  it('with elevation, one net climbs to z = 1 by vertical lifts and the belts pass the BELT rules', () => {
    const res = route(cross, { allowElevation: true, maxLevel: 1 });
    expect(res.ok).toBe(true);
    const a = routeOf(res, 1);
    const b = routeOf(res, 2);
    const high = [a, b].filter((n) => n.some((p) => p.z > 0));
    expect(high).toHaveLength(1);
    for (const nodes of [a, b]) {
      expect(nodes.every((p) => p.z >= 0 && p.z <= 1)).toBe(true);
      for (let i = 1; i < nodes.length; i++) {
        const s = nodes[i - 1];
        const t = nodes[i];
        const lift = s.x === t.x && s.y === t.y && Math.abs(s.z - t.z) === 1;
        expect(adjacent4(s, t) || lift, `${JSON.stringify(s)} -> ${JSON.stringify(t)}`).toBe(true);
      }
    }
    expect(beltViolations(res.routes)).toEqual([]);
    // no cell is shared
    const seen = new Set<string>();
    for (const p of [...a, ...b]) {
      const k = `${p.x},${p.y},${p.z}`;
      expect(seen.has(k), `cell ${k} used twice`).toBe(false);
      seen.add(k);
    }
  });

  it('without elevation they cannot both fit: ok is false and conflicts are counted', () => {
    const res = route(cross, { allowElevation: false, maxIterations: 12 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflicts).toBeGreaterThan(0);
    expect(res.routes).toHaveLength(2);
  });

  it('maxLevel 0 is the same as no elevation', () => {
    const res = route(cross, { allowElevation: true, maxLevel: 0, maxIterations: 8 });
    expect(res.ok).toBe(false);
  });

  it('never lifts within two nodes of a belt end', () => {
    const res = route(cross, { allowElevation: true, maxLevel: 1 });
    for (const nodes of res.routes.map((r) => r.nodes)) {
      nodes.forEach((p, i) => {
        if (i > 0 && nodes[i - 1].z !== p.z) {
          expect(i).toBeGreaterThanOrEqual(3);
          expect(nodes.length - 1 - i).toBeGreaterThanOrEqual(2);
        }
      });
    }
  });
});

describe('routeNets: taps and waypoints', () => {
  it('passes a tap with axis y straight along y, and the next leg does not reverse', () => {
    const res = route([
      {
        id: 1,
        source: { x: 2, y: 2, dir: E },
        taps: [{ x: 10, y: 10, axis: 'y', dir: 'in' }],
      },
    ]);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    const i = at(nodes, 10, 10);
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(nodes.length - 1);
    expect(nodes[i - 1].x).toBe(10);
    expect(nodes[i + 1].x).toBe(10);
    expect(nodes[i - 1].z).toBe(0);
    expect(nodes[i + 1].z).toBe(0);
    // collinear: the step into the tap is the step out of it
    expect(nodes[i].y - nodes[i - 1].y).toBe(nodes[i + 1].y - nodes[i].y);
  });

  it('a dead-end taps belt starts one node before its first tap and ends one node after its last, along the axes', () => {
    const res = route([
      {
        id: 1,
        taps: [
          { x: 5, y: 5, axis: 'x', dir: 'out' },
          { x: 12, y: 9, axis: 'y', dir: 'in' },
        ],
      },
    ]);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    const first = at(nodes, 5, 5);
    const last = at(nodes, 12, 9);
    expect(first).toBe(1);
    expect(last).toBe(nodes.length - 2);
    expect(nodes[0].y).toBe(5);
    expect(Math.abs(nodes[0].x - 5)).toBe(1);
    expect(nodes[2].y).toBe(5);
    expect(nodes[nodes.length - 1].x).toBe(12);
    expect(Math.abs(nodes[nodes.length - 1].y - 9)).toBe(1);
    expect(nodes[nodes.length - 3].x).toBe(12);
    for (let i = 2; i < nodes.length; i++) expect(nodes[i], `U-turn at ${i}`).not.toEqual(nodes[i - 2]);
  });

  it('visits the waypoints in order at z = 0: source port, producers, consumers, sink port', () => {
    const specs: Spec[] = [
      {
        id: 1,
        source: { x: 1, y: 10, dir: E },
        sink: { x: 19, y: 10, dir: W },
        // listed out of order on purpose: producers come first in the route whatever the order of the list
        taps: [
          { x: 14, y: 6, axis: 'x', dir: 'in' },
          { x: 5, y: 14, axis: 'x', dir: 'out' },
          { x: 9, y: 14, axis: 'x', dir: 'out' },
          { x: 12, y: 6, axis: 'x', dir: 'in' },
        ],
      },
    ];
    const res = route(specs);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    const idx = (x: number, y: number) => {
      const i = at(nodes, x, y);
      expect(i, `tap (${x}, ${y}) on the route at z 0`).toBeGreaterThan(0);
      return i;
    };
    const producers = [idx(5, 14), idx(9, 14)];
    const consumers = [idx(12, 6), idx(14, 6)];
    expect(nodes[0]).toEqual({ x: 1, y: 10, z: 0 });
    expect(nodes[nodes.length - 1]).toEqual({ x: 19, y: 10, z: 0 });
    expect(Math.max(...producers)).toBeLessThan(Math.min(...consumers));
    // nearest neighbour: from the station the nearer producer first, then the nearer consumer
    expect(producers[0]).toBeLessThan(producers[1]);
    expect(consumers[0]).toBeLessThan(consumers[1]);
    // every tap is mid-straight
    for (const i of [...producers, ...consumers]) {
      const prev = nodes[i - 1];
      const next = nodes[i + 1];
      expect(nodes[i].x - prev.x).toBe(next.x - nodes[i].x);
      expect(nodes[i].y - prev.y).toBe(next.y - nodes[i].y);
      expect(prev.y).toBe(nodes[i].y);
    }
  });

  it('runs adjacent taps of one net on a single straight pass', () => {
    const res = route([
      {
        id: 1,
        source: { x: 1, y: 1, dir: E },
        taps: [
          { x: 8, y: 10, axis: 'x', dir: 'in' },
          { x: 9, y: 10, axis: 'x', dir: 'in' },
          { x: 10, y: 10, axis: 'x', dir: 'in' },
        ],
      },
    ]);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    const a = at(nodes, 8, 10);
    const b = at(nodes, 9, 10);
    const c = at(nodes, 10, 10);
    expect(Math.abs(b - a)).toBe(1);
    expect(Math.abs(c - b)).toBe(1);
    expect(a < b ? c > b : c < b).toBe(true);
    expect(new Set(nodes.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(nodes.length);
  });

  it('joins a producer tap and a consumer tap side by side into one straight pass', () => {
    const res = route([
      {
        id: 1,
        source: undefined,
        sink: { x: 19, y: 19, dir: W },
        taps: [
          { x: 8, y: 10, axis: 'x', dir: 'out' },
          { x: 9, y: 10, axis: 'x', dir: 'in' },
        ],
      },
    ]);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    const a = at(nodes, 8, 10);
    const b = at(nodes, 9, 10);
    expect(Math.abs(a - b)).toBe(1);
    // the producer first: a taps-sourced belt carries the producer's items on to the consumer
    expect(a).toBeLessThan(b);
    expect(nodes[a - 1].y).toBe(10);
    expect(nodes[b + 1].y).toBe(10);
  });

  it('leaves another net tap point alone: the belt of another net goes round it', () => {
    const res = route([
      { id: 1, source: { x: 1, y: 10, dir: E }, sink: { x: 19, y: 10, dir: W } },
      { id: 2, taps: [{ x: 10, y: 10, axis: 'y', dir: 'out' }, { x: 10, y: 14, axis: 'y', dir: 'in' }] },
    ]);
    expect(res.ok).toBe(true);
    expect(at(routeOf(res, 1), 10, 10, 0)).toBe(-1);
    expect(at(routeOf(res, 2), 10, 10, 0)).toBeGreaterThan(0);
  });
});

describe('routeNets: obstacles and failure', () => {
  const wall: PlacedBuilding[] = [
    // assemblers (3.2 tiles wide) stacked into a wall across x = 10, leaving the rows y <= 3 and y >= 17 open
    ...[6, 9, 12, 15].map((y, i) => ({ id: 100 + i, itemId: ASSEMBLER, x: 10, y, z: 0, yaw: 0 as const })),
  ];

  it('avoids an obstacle building', () => {
    const occ = occupancyOf(wall);
    const { net, taps } = build([{ id: 1, source: { x: 2, y: 10, dir: E }, sink: { x: 18, y: 10, dir: W } }]);
    const res = routeNets(net, taps, occ, params(), never);
    expect(res.ok).toBe(true);
    const nodes = routeOf(res, 1);
    for (const p of nodes) expect(occ.blockedForBelt(p.x, p.y, p.z), `node ${JSON.stringify(p)}`).toBe(false);
    expect(nodes.length).toBeGreaterThan(17);
    expect(beltViolations(res.routes, wall)).toEqual([]);
  });

  it('shares a gap between nets without overlapping them', () => {
    const specs: Spec[] = [
      { id: 1, source: { x: 2, y: 10, dir: E }, sink: { x: 18, y: 10, dir: W } },
      { id: 2, source: { x: 2, y: 12, dir: E }, sink: { x: 18, y: 12, dir: W } },
      { id: 3, source: { x: 2, y: 8, dir: E }, sink: { x: 18, y: 8, dir: W } },
    ];
    const res = route(specs, {}, wall);
    expect(res.ok).toBe(true);
    expect(beltViolations(res.routes, wall)).toEqual([]);
  });

  it('reports a net that cannot be reached: ok false, the net named, the others still routed', () => {
    // the node before the sink port (9, 10) is inside a building, so the belt cannot enter the port
    const plug: PlacedBuilding[] = [{ id: 200, itemId: ASSEMBLER, x: 8, y: 10, z: 0, yaw: 0 }];
    const res = route(
      [
        { id: 1, source: { x: 1, y: 1, dir: E }, sink: { x: 10, y: 10, dir: W } },
        { id: 2, source: { x: 1, y: 19, dir: E }, sink: { x: 19, y: 19, dir: W } },
      ],
      { maxIterations: 5 },
      plug,
    );
    expect(res.ok).toBe(false);
    expect(res.routes.find((r) => r.netId === 1)?.nodes).toEqual([]);
    expect(res.routes.find((r) => r.netId === 2)?.nodes.length).toBeGreaterThan(2);
    if (!res.ok) {
      expect(res.conflicts).toBeGreaterThan(0);
      expect(res.unroutable).toEqual([1]);
    }
  });

  it('stops when asked to', () => {
    const { net, taps } = build([{ id: 1, source: { x: 2, y: 5, dir: E }, sink: { x: 17, y: 15, dir: W } }]);
    const res = routeNets(net, taps, occupancyOf([]), params(), () => true);
    expect(res.ok).toBe(false);
    expect(res.routes).toHaveLength(1);
  });
});

describe('routeNets: stations', () => {
  it('routes from real station ports (an ILS and a PLS facing each other)', () => {
    const a: PlacedBuilding = { id: 1, itemId: PLS, x: 0, y: 10, z: 0, yaw: 0 };
    const b: PlacedBuilding = { id: 2, itemId: ILS, x: 30, y: 10, z: 0, yaw: 0 };
    const occ = occupancyOf([a, b]);
    const { net } = build([{ id: 1, source: { x: 4, y: 10, dir: E }, sink: { x: 26, y: 10, dir: W } }]);
    const taps: TapAssignment = {
      taps: [],
      stationPorts: [
        { netId: 1, stationBuildingId: 1, port: 10, point: { x: 4, y: 10 }, end: 'source', dir: E },
        { netId: 1, stationBuildingId: 2, port: 4, point: { x: 26, y: 10 }, end: 'sink', dir: W },
      ],
    };
    const res = routeNets(net, taps, occ, params({ bounds: { minX: -10, minY: 0, maxX: 40, maxY: 20 } }), never);
    expect(res.ok).toBe(true);
    expect(routeOf(res, 1)).toHaveLength(23);
  });
});
