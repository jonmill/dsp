import { describe, expect, it } from 'vitest';
import { coaterBuildings, coaterPlacementProblem } from '../geometry';
import type { GridPoint, PlacedBuilding } from '../geometry';
import { validateLayout } from '../validate';
import { assembleLayout } from './assemble';
import type { BeltNet, Netlist } from './netlist';
import { coaterOptions, feedProliferator } from './proliferator';
import type { Place } from './proliferator';
import { COATER_ID_OFFSET, coaterIdOf, constructivePlacement } from './placement';
import { placePowerNodes, powerTargets, sorterGeometry } from './power';
import { COATER_LEAD, defaultRouteParams, routeNets } from './router';
import { assignTaps } from './taps';
import type { AssignedTap, TapAssignment } from './taps';
import { ASSEMBLER, data, effects, occupancyOf, processorNetlist, processorPlan } from './testkit';

const never = () => false;
const COATER = 2313;

/** A straight east-west row of ground nodes along y = 10 from x = 0, `n` of them. */
const row = (n: number, y = 10): GridPoint[] => Array.from({ length: n }, (_, i) => ({ x: i, y, z: 0 }));

const netOf = (over: Partial<BeltNet> = {}): BeltNet => ({
  id: 3,
  itemId: 1301,
  tierItemId: 2003,
  rate: 1,
  source: { kind: 'taps' },
  sink: { kind: 'deadEnd' },
  taps: [],
  sprayed: true,
  ...over,
});

/** Taps of net 3 at the given nodes of `nodes`: `out` ones are producers, `in` ones consumers. */
const tapsAt = (nodes: GridPoint[], at: { i: number; dir: 'in' | 'out' }[]): TapAssignment => ({
  taps: at.map(
    ({ i, dir }, n): AssignedTap => ({ netId: 3, machineId: n + 1, slot: 0, span: 1, point: { x: nodes[i].x, y: nodes[i].y }, axis: 'x', dir, sorterIndex: 0, rate: 1 }),
  ),
  stationPorts: [],
});

const options = (
  nodes: GridPoint[],
  at: { i: number; dir: 'in' | 'out' }[],
  over: { occ?: PlacedBuilding[]; sorterCells?: string[]; used?: string[] } = {},
) => {
  const places: Place[] = [];
  const found = coaterOptions(
    netOf(),
    nodes,
    tapsAt(nodes, at),
    occupancyOf(over.occ ?? []),
    new Set(over.sorterCells ?? []),
    new Set(over.used ?? []),
    COATER,
    places,
  );
  return { found, places };
};

describe('coaterOptions: where a coater can stand on a net', () => {
  it('on a straight row between the last producer and the first consumer, turned either way round', () => {
    const nodes = row(20);
    const { found, places } = options(nodes, [{ i: 2, dir: 'out' }, { i: 17, dir: 'in' }]);
    expect(found.length).toBeGreaterThan(10);
    // with the flow (east, 90): the top passage over the node before it; against the flow (270): over the node after
    const withFlow = places.filter((p) => p.yaw === 90);
    const against = places.filter((p) => p.yaw === 270);
    expect(withFlow.length).toBeGreaterThan(0);
    expect(against.length).toBeGreaterThan(0);
    for (const o of found) {
      const place = places[o.tag];
      const expectTop = place.yaw === 90 ? place.node - 1 : place.node + 1;
      expect([o.x, o.y]).toEqual([nodes[expectTop].x, nodes[expectTop].y]);
      // crosses the row at a right angle: north or south
      expect(o.dirs.sort()).toEqual([1, 3]);
      expect(o.through.sort()).toEqual([1, 3]);
      expect(coaterPlacementProblem({ id: 3, tierItemId: 2003, itemId: 1301, nodes, plannedRate: 1 }, place.node, place.yaw)).toBeUndefined();
    }
  });

  it('the earliest and the latest place are the ones the taps leave room for', () => {
    const nodes = row(20);
    const { places } = options(nodes, [{ i: 5, dir: 'out' }, { i: 15, dir: 'in' }]);
    const spots = places.map((p) => [p.node, p.yaw]);
    // with the flow the body reaches 2 nodes back and 1 forward: producers at <= k - 3, consumers at >= k + 2
    expect(Math.min(...places.filter((p) => p.yaw === 90).map((p) => p.node))).toBe(8);
    expect(Math.max(...places.filter((p) => p.yaw === 90).map((p) => p.node))).toBe(13);
    // against it the body reaches 1 node back and 2 forward: producers at <= k - 2, consumers at >= k + 3
    expect(Math.min(...places.filter((p) => p.yaw === 270).map((p) => p.node))).toBe(7);
    expect(Math.max(...places.filter((p) => p.yaw === 270).map((p) => p.node))).toBe(12);
    expect(spots.length).toBe(6 + 6);
  });

  it('a net with no producers (an import) allows the first nodes: a coater at node 2, the top over node 1, the rear at the port node', () => {
    const nodes = row(12);
    const { places } = options(nodes, [{ i: 8, dir: 'in' }]);
    expect(Math.min(...places.filter((p) => p.yaw === 90).map((p) => p.node))).toBe(1);
    expect(Math.max(...places.filter((p) => p.yaw === 90).map((p) => p.node))).toBe(6);
  });

  it('no place when the taps leave no room', () => {
    const nodes = row(12);
    expect(options(nodes, [{ i: 4, dir: 'out' }, { i: 6, dir: 'in' }]).found).toEqual([]);
    // a consumer before the producer: no stretch is after the one and before the other
    expect(options(nodes, [{ i: 6, dir: 'in' }, { i: 3, dir: 'out' }]).found).toEqual([]);
  });

  it('no place on a bend: the nodes under the coater and the ones either side of its body are one straight line', () => {
    const bent: GridPoint[] = [...row(8), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ x: 7, y: 10 + i, z: 0 }))];
    const { places } = options(bent, [{ i: 15, dir: 'in' }]);
    // the row runs to the corner at node 7 (7, 10); a coater needs nodes k - 2 .. k + 2 on one line, the corner node included
    expect([...new Set(places.filter((p) => p.node <= 8).map((p) => p.node))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]); // node 5: nodes 3..7
    // on the column north of the corner the same: nodes 9..13 have a line of five around them, 8 and 14 do not reach the corner / the tap
    // a coater on node 6 would have the belt leave its body sideways at node 7
    expect(places.some((p) => p.node === 6 || p.node === 7 || p.node === 8)).toBe(false);
    expect([...new Set(places.filter((p) => p.node > 8).map((p) => p.node))].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13]);
  });

  it('no place on a lifted stretch', () => {
    const lifted: GridPoint[] = [...row(8), { x: 7, y: 10, z: 1 }, { x: 8, y: 10, z: 1 }, { x: 9, y: 10, z: 1 }, { x: 10, y: 10, z: 1 }];
    const { places } = options(lifted, [{ i: 11, dir: 'in' }]);
    expect(places.every((p) => lifted[p.node].z === 0 && lifted[p.node + 1].z === 0 && lifted[p.node - 1].z === 0)).toBe(true);
    expect(Math.max(...places.map((p) => p.node))).toBeLessThan(7);
  });

  it('the cell two behind a coater that is no node of the belt (it starts or ends there) may not be taken by another net', () => {
    // a belt of 8 nodes along y = 10 from x = 3; a coater on its node 1 (4, 10) turned east has its rear cell at (2, 10)
    const short = row(8).map((p) => ({ ...p, x: p.x + 3 }));
    const loose = options(short, [{ i: 7, dir: 'in' }]);
    expect(loose.places.some((p) => p.yaw === 90 && p.node === 1)).toBe(true);
    expect(options(short, [{ i: 7, dir: 'in' }], { used: ['2,10,0'] }).places.some((p) => p.yaw === 90 && p.node === 1)).toBe(false);
    expect(options(short, [{ i: 7, dir: 'in' }], { used: ['2,10,1'] }).places.some((p) => p.yaw === 90 && p.node === 1)).toBe(false);
    // and a coater on node 2 has the node behind it, (3, 10), under its back: nothing to check there
    expect(options(short, [{ i: 7, dir: 'in' }], { used: ['2,10,0'] }).places.some((p) => p.yaw === 90 && p.node === 2)).toBe(true);
  });

  it('keeps off the cells sorters take, and off z 1 cells that another net holds over the body', () => {
    const nodes = row(20);
    const plain = options(nodes, [{ i: 19, dir: 'in' }]);
    // a sorter cell on node 10: no place whose body includes it
    const sorted = options(nodes, [{ i: 19, dir: 'in' }], { sorterCells: ['10,10'] });
    expect(sorted.places.length).toBeLessThan(plain.places.length);
    for (const p of sorted.places) {
      const reach = p.yaw === 90 ? [p.node - 2, p.node + 1] : [p.node - 1, p.node + 2];
      expect(10 >= reach[0] && 10 <= reach[1]).toBe(false);
    }
    const covered = options(nodes, [{ i: 19, dir: 'in' }], { used: ['10,10,1'] });
    expect(covered.places.length).toBe(sorted.places.length);
  });

  it('keeps off buildings: the coater\'s body is held to the building footprint', () => {
    const nodes = row(20);
    const asm: PlacedBuilding = { id: 1, itemId: ASSEMBLER, x: 10, y: 11, z: 0, yaw: 0 };
    const near = options(nodes, [{ i: 19, dir: 'in' }], { occ: [asm] });
    const far = options(nodes, [{ i: 19, dir: 'in' }]);
    expect(near.places.length).toBeLessThan(far.places.length);
  });

  it('needs a free cell beside the top passage to cross: none free, no option; one side free, one direction', () => {
    const nodes = row(20);
    // a wall of buildings along the row at z 1: north of it
    const wall: PlacedBuilding[] = [{ id: 1, itemId: ASSEMBLER, x: 10, y: 12, z: 0, yaw: 0 }];
    const { found } = options(nodes, [{ i: 19, dir: 'in' }], { occ: wall });
    // a top passage right under the assembler has no free cell north of it: it can only be entered from the south
    const under = found.filter((o) => o.x >= 9 && o.x <= 11);
    for (const o of under) expect(o.dirs).toEqual([1]); // north is blocked: only a belt coming from the south, heading north
    // through needs the cell after as well
    const used = options(nodes, [{ i: 19, dir: 'in' }], { used: ['5,9,1'] });
    const at5 = used.found.filter((o) => o.x === 5);
    for (const o of at5) {
      expect(o.dirs).toContain(3);
      expect(o.through).not.toContain(1);
    }
  });

  it('offers at most 64 places however long the row, spread along it, the first and last among them', () => {
    const nodes = row(160);
    const { found, places } = options(nodes, [{ i: 159, dir: 'in' }]);
    expect(found).toHaveLength(64);
    const nodesUsed = found.map((o) => places[o.tag].node);
    expect(nodesUsed[0]).toBe(1);
    expect(nodesUsed[nodesUsed.length - 1]).toBeGreaterThan(150);
    expect(nodesUsed).toEqual([...nodesUsed].sort((a, b) => a - b));
  });

  it('the body cells are the three beside the top passage at z 1, the top passage is not one of them', () => {
    const nodes = row(20);
    const { found, places } = options(nodes, [{ i: 19, dir: 'in' }]);
    const o = found.find((f) => places[f.tag].node === 8 && places[f.tag].yaw === 90) as (typeof found)[number];
    // coater on (8, 10) turned east: top over (7, 10); body (6, 10), (8, 10), (9, 10) at z 1
    expect([o.x, o.y]).toEqual([7, 10]);
    expect(o.body.map((b) => [b.x, b.y, b.z]).sort()).toEqual([[6, 10, 1], [8, 10, 1], [9, 10, 1]]);
  });
});

describe('feedProliferator on the Mk.III Processor plan', () => {
  async function pipeline(margin: number, lead = 0) {
    const plan = await processorPlan(1, { tier: 3, mode: 'extra' });
    const net = await processorNetlist(1, { tier: 3, mode: 'extra' });
    const placement = constructivePlacement(net, data, margin);
    const occ = occupancyOf(placement.buildings);
    const taps = assignTaps(net, placement, occ, data, effects, { lead });
    if ('failed' in taps) throw new Error(taps.failed);
    const params = defaultRouteParams(occ, { lead });
    const routed = routeNets(net, taps, occ, params, never);
    if (!routed.ok) throw new Error('routing');
    const items = assembleLayout(net, placement, taps, routed.routes, [], plan, data);
    const cells = sorterGeometry(items, data).cells;
    return { plan, net, placement, occ, taps, params, routed, cells };
  }

  it.each([0, COATER_LEAD])('puts one coater on every sprayed net and one feed through all their top passages, and the layout passes the static checks (room asked for: %i)', async (lead) => {
    const p = await pipeline(3, lead);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.occ, p.cells, p.params, data, never);
    if (!('coaters' in fed)) throw new Error(JSON.stringify(fed));
    const sprayed = p.net.nets.filter((n) => n.sprayed);
    expect(fed.coaters.map((c) => c.beltId)).toEqual(sprayed.map((n) => n.id));
    expect(fed.coaters.map((c) => c.id)).toEqual(sprayed.map((n) => COATER_ID_OFFSET + n.id));
    expect(fed.route.netId).toBe(p.net.nets.find((n) => n.proliferator)?.id);

    const routes = [...p.routed.routes, fed.route];
    const bare = assembleLayout(p.net, p.placement, p.taps, routes, [], p.plan, data, fed.coaters);
    for (const c of coaterBuildings(bare, data)) p.occ.addBuilding(c);
    const targets = powerTargets(bare, data);
    const poles = placePowerNodes(bare.buildings, targets.consumerPoints, targets.blockedPoints, p.occ, data, effects);
    expect(poles).not.toBeNull();
    const layout = assembleLayout(p.net, p.placement, p.taps, routes, poles ?? [], p.plan, data, fed.coaters);
    const report = validateLayout(layout, p.plan, data, effects, { simulate: false });
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);

    // the feed leaves its station port at z 0 and ends on the top passage of its last coater, at z 1
    const port = p.taps.stationPorts.find((x) => x.netId === fed.route.netId);
    expect(fed.route.nodes[0]).toEqual({ x: port?.point.x, y: port?.point.y, z: 0 });
    expect(fed.route.nodes[fed.route.nodes.length - 1].z).toBe(1);
  });

  it.each([0, COATER_LEAD])('every coater stands after the last producer of its net and before the first consumer, clear of the taps (room asked for: %i)', async (lead) => {
    const p = await pipeline(4, lead);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.occ, p.cells, p.params, data, never);
    if (!('coaters' in fed)) throw new Error(JSON.stringify(fed));
    for (const c of fed.coaters) {
      const nodes = p.routed.routes.find((r) => r.netId === c.beltId)?.nodes as GridPoint[];
      const idx = (t: AssignedTap) => nodes.findIndex((n) => n.z === 0 && n.x === t.point.x && n.y === t.point.y);
      const mine = p.taps.taps.filter((t) => t.netId === c.beltId);
      const outs = mine.filter((t) => t.dir === 'out').map(idx);
      const ins = mine.filter((t) => t.dir === 'in').map(idx);
      const zone = c.yaw === 0 || c.yaw === 90 ? [c.node - 2, c.node + 1] : [c.node - 1, c.node + 2];
      // turned with the flow or against it: whichever, the body's stretch is clear of every tap
      const flow = Math.atan2(nodes[c.node + 1].x - nodes[c.node].x, nodes[c.node + 1].y - nodes[c.node].y);
      const withFlow = Math.abs(((c.yaw * Math.PI) / 180 - flow + Math.PI * 3) % (2 * Math.PI) - Math.PI) < 0.01;
      const [lo, hi] = withFlow ? [c.node - 2, c.node + 1] : [c.node - 1, c.node + 2];
      expect(zone.length).toBe(2);
      for (const i of outs) expect(i, `producer of net ${c.beltId}`).toBeLessThan(lo);
      for (const i of ins) expect(i, `consumer of net ${c.beltId}`).toBeGreaterThan(hi);
    }
  });

  it('fails with a reason, not a throw: no feed net, no port for it, no data, and no place on a net', async () => {
    const p = await pipeline(3);
    const run = (net: Netlist, taps: TapAssignment, cells = p.cells) => feedProliferator(net, taps, p.routed.routes, p.occ, cells, p.params, data, never);
    expect(run({ ...p.net, nets: p.net.nets.filter((n) => !n.proliferator) }, p.taps)).toEqual({ failed: 'the netlist has no proliferator net' });
    const feedId = p.net.nets.find((n) => n.proliferator)?.id;
    expect(run(p.net, { ...p.taps, stationPorts: p.taps.stationPorts.filter((x) => x.netId !== feedId) })).toEqual({
      failed: `the proliferator net ${feedId} has no station port`,
    });
    // every cell taken by a sorter: no coater has room
    const all = new Set(p.routed.routes.flatMap((r) => r.nodes.map((n) => `${n.x},${n.y}`)));
    const none = run(p.net, p.taps, all);
    expect(none).toMatchObject({ failed: expect.stringMatching(/^no place for a spray coater on net \d+ \(item \d+\)/) });
  });

  it('stops when asked to', async () => {
    const p = await pipeline(3);
    expect(feedProliferator(p.net, p.taps, p.routed.routes, p.occ, p.cells, p.params, data, () => true)).toEqual({ stopped: true });
  });

  it('is deterministic, and the coater ids are in the range placement.ts documents', async () => {
    const p = await pipeline(3);
    const a = feedProliferator(p.net, p.taps, p.routed.routes, p.occ, p.cells, p.params, data, never);
    const b = feedProliferator(p.net, p.taps, p.routed.routes, p.occ, p.cells, p.params, data, never);
    expect(a).toEqual(b);
    if ('coaters' in a) for (const c of a.coaters) expect(c.id).toBe(coaterIdOf(c.beltId));
    expect(COATER_ID_OFFSET).toBeGreaterThan(1000 + 100_000);
  });
});
