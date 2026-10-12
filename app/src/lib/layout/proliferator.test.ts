import { describe, expect, it } from 'vitest';
import { planProduction } from '../calc';
import { coaterBuildings, coaterPlacementProblem } from '../geometry';
import type { GridPoint } from '../geometry';
import { MAX_WARMUP_TICKS, runSimulation, validateLayout } from '../validate';
import { assembleLayout } from './assemble';
import { buildNetlist } from './netlist';
import type { Netlist } from './netlist';
import { feedProliferator, placeBays } from './proliferator';
import { COATER_ID_OFFSET, coaterIdOf, constructivePlacement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { defaultRouteParams, routeNets } from './router';
import type { Bay } from './router';
import { assignTaps } from './taps';
import type { TapAssignment } from './taps';
import { data, effects, everything, occupancyOf, processorNetlist, processorPlan } from './testkit';

const never = () => false;

/** Items that come from the ground, the sea or the air: supplied, never planned. */
const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];

const key = (x: number, y: number): string => `${x},${y}`;

/** The pipeline up to the feed: placement, taps, routes, bays (the sprayed nets routed through them). */
function pipelineOf(plan: Awaited<ReturnType<typeof processorPlan>>, net: Netlist, margin: number) {
  const placement = constructivePlacement(net, data, margin);
  const occ = occupancyOf(placement.buildings);
  const taps = assignTaps(net, placement, occ, data, effects);
  if ('failed' in taps) throw new Error(taps.failed);
  const params = defaultRouteParams(occ);
  const routed = routeNets(net, taps, occ, params, never);
  if (!routed.ok) throw new Error(`routing left ${routed.conflicts} conflicts`);
  const bayed = placeBays(net, taps, placement, routed.routes, occ, data, params, never);
  if (!('bays' in bayed)) throw new Error(JSON.stringify(bayed));
  return { plan, net, placement, occ, taps, params, bays: bayed.bays, plain: routed.routes, routed: { routes: bayed.routes } };
}

async function processorPipeline(margin: number) {
  const plan = await processorPlan(1, { tier: 3, mode: 'extra' });
  return pipelineOf(plan, await processorNetlist(1, { tier: 3, mode: 'extra' }), margin);
}

/** 1 High-Explosive Shell Set/s with proliferator `tier` (extra products) on the first facility that can make it. */
async function shellSetPipeline(margin: number, tier: 1 | 2 | 3 = 3) {
  const itemId = data.data.items.find((i) => i.name === 'High-Explosive Shell Set')!.id;
  const result = await planProduction(
    {
      targetItemId: itemId,
      quantity: { kind: 'rate', perSecond: 1 },
      finalFacilityItemId: 2303,
      unlockedTechs: everything,
      suppliedItemIds: new Set(RAW_ITEMS),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier, mode: 'extra' },
      stationKind: 'planetary',
    },
    data,
    effects,
  );
  if (!result.ok) throw new Error(result.error.message);
  return pipelineOf(result.plan, buildNetlist(result.plan, data, effects), margin);
}

describe('placeBays: the room for a coater, made on every sprayed net', () => {
  it('gives every sprayed net a bay of three cells in a row, and the other nets none', async () => {
    const p = await processorPipeline(3);
    const sprayed = p.net.nets.filter((n) => n.sprayed);
    expect(sprayed.length).toBeGreaterThan(3);
    expect(p.bays.map((b) => b.netId)).toEqual(sprayed.map((n) => n.id));
    for (const b of p.bays) {
      const [a, m, c] = b.cells;
      expect(b.cells).toHaveLength(3);
      const [ux, uy] = b.axis === 'x' ? [1, 0] : [0, 1];
      expect([m.x - a.x, m.y - a.y, c.x - m.x, c.y - m.y]).toEqual([ux, uy, ux, uy]);
      expect(b.signs.length).toBeGreaterThan(0);
      // the cells above the five nodes, and beside the nodes either side of the middle one
      expect(b.held).toHaveLength(9);
      expect(b.held.every((h) => h.z === 1)).toBe(true);
    }
  });

  it('routes every sprayed net through its bay, five nodes in a line, and leaves the routes of the other nets as they were', async () => {
    const p = await processorPipeline(3);
    for (const route of p.routed.routes) {
      const bay = p.bays.find((b) => b.netId === route.netId);
      const before = p.plain.find((r) => r.netId === route.netId);
      if (!bay) {
        expect(route.nodes).toEqual(before?.nodes);
        continue;
      }
      const mid = bay.cells[1];
      const k = route.nodes.findIndex((n) => n.z === 0 && n.x === mid.x && n.y === mid.y);
      expect(k, `net ${route.netId}`).toBeGreaterThanOrEqual(2);
      const dx = route.nodes[k + 1].x - route.nodes[k].x;
      const dy = route.nodes[k + 1].y - route.nodes[k].y;
      for (let j = -2; j <= 2; j++) expect(route.nodes[k + j], `net ${route.netId} node ${j}`).toEqual({ x: mid.x + j * dx, y: mid.y + j * dy, z: 0 });
    }
  });

  it('keeps every bay clear of the taps, the nodes they need beside them, the station ports, buildings and other bays, and no two nets share a cell', async () => {
    const p = await processorPipeline(3);
    const forbidden = new Set<string>();
    for (const t of p.taps.taps) {
      const [ux, uy] = t.axis === 'x' ? [1, 0] : [0, 1];
      for (const j of [-1, 0, 1]) forbidden.add(key(t.point.x + j * ux, t.point.y + j * uy));
    }
    for (const q of p.taps.stationPorts) {
      forbidden.add(key(q.point.x, q.point.y));
      forbidden.add(key(q.point.x + q.dir[0], q.point.y + q.dir[1]));
    }
    const seen = new Set<string>();
    for (const b of p.bays) {
      const [ux, uy] = b.axis === 'x' ? [1, 0] : [0, 1];
      const mid = b.cells[1];
      for (const j of [-2, -1, 0, 1, 2]) {
        const x = mid.x + j * ux;
        const y = mid.y + j * uy;
        expect(forbidden.has(key(x, y)), `bay of net ${b.netId}: (${x}, ${y}) is a tap's or a port's`).toBe(false);
        expect(p.occ.blockedForBelt(x, y, 0), `bay of net ${b.netId}: (${x}, ${y}) is under a building`).toBe(false);
        expect(seen.has(key(x, y)), `bay of net ${b.netId}: (${x}, ${y}) is in another bay`).toBe(false);
        seen.add(key(x, y));
      }
    }
    // the routes are clear of one another, and nothing crosses a bay's body at z 1
    const cells = new Map<string, number>();
    for (const r of p.routed.routes) {
      for (const n of r.nodes) {
        const k3 = `${n.x},${n.y},${n.z}`;
        expect(cells.get(k3) ?? r.netId, `cell ${k3}`).toBe(r.netId);
        cells.set(k3, r.netId);
      }
    }
    for (const b of p.bays) for (const h of b.held) expect(cells.has(`${h.x},${h.y},${h.z}`), `bay of net ${b.netId}: (${h.x}, ${h.y}) at z 1`).toBe(false);
  });

  it('is deterministic, and makes none when no net is sprayed', async () => {
    const a = await processorPipeline(3);
    const b = await processorPipeline(3);
    expect(b.bays).toEqual(a.bays);
    expect(b.routed.routes).toEqual(a.routed.routes);
    const plain = await processorNetlist(1);
    const placement = constructivePlacement(plain, data, 3);
    const occ = occupancyOf(placement.buildings);
    const taps = assignTaps(plain, placement, occ, data, effects) as TapAssignment;
    const params = defaultRouteParams(occ);
    const routed = routeNets(plain, taps, occ, params, never);
    expect(placeBays(plain, taps, placement, routed.routes, occ, data, params, never)).toEqual({ routes: routed.routes, bays: [] });
  });

  it('says why when the routing window has no room for a bay, and stops when asked to', async () => {
    const net = await processorNetlist(1, { tier: 3, mode: 'extra' });
    const placement = constructivePlacement(net, data, 3);
    const occ = occupancyOf(placement.buildings);
    const taps = assignTaps(net, placement, occ, data, effects) as TapAssignment;
    const params = defaultRouteParams(occ);
    const routed = routeNets(net, taps, occ, params, never);
    if (!routed.ok) throw new Error('routing');
    const cramped = { ...params, bounds: { minX: 0, minY: 0, maxX: 6, maxY: 6 } };
    expect(placeBays(net, taps, placement, routed.routes, occ, data, cramped, never)).toMatchObject({
      failed: expect.stringMatching(/^no place for the spray coater of net \d+ \(item \d+\)/),
    });
    expect(placeBays(net, taps, placement, routed.routes, occ, data, params, () => true)).toEqual({ stopped: true });
    expect(placeBays(net, taps, placement, routed.routes.map((r) => ({ ...r, nodes: [] })), occ, data, params, never)).toMatchObject({
      failed: expect.stringMatching(/^net \d+ \(item \d+\) has no route to put a spray coater on$/),
    });
  });
});

describe('feedProliferator on the Mk.III Processor plan', () => {
  it.each([3, 4])('puts one coater on the bay of every sprayed net and one feed through all their top passages, and the layout passes the static checks (margin %i)', async (margin) => {
    const p = await processorPipeline(margin);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
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

  it('every coater stands on the middle of its net\'s bay, after the last producer and before the first consumer, clear of the taps', async () => {
    const p = await processorPipeline(4);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
    if (!('coaters' in fed)) throw new Error(JSON.stringify(fed));
    for (const c of fed.coaters) {
      const nodes = p.routed.routes.find((r) => r.netId === c.beltId)?.nodes as GridPoint[];
      const bay = p.bays.find((b) => b.netId === c.beltId) as Bay;
      expect(nodes[c.node]).toMatchObject({ x: bay.cells[1].x, y: bay.cells[1].y, z: 0 });
      // the placement rule of the validator, on the route as routed
      expect(coaterPlacementProblem({ id: c.beltId, tierItemId: 2003, itemId: 1301, nodes, plannedRate: 1 }, c.node, c.yaw)).toBeUndefined();
      const index = (t: TapAssignment['taps'][number]) => nodes.findIndex((n) => n.z === 0 && n.x === t.point.x && n.y === t.point.y);
      const mine = p.taps.taps.filter((t) => t.netId === c.beltId);
      // turned with the flow or against it: whichever, the body's stretch is clear of every tap
      const flow = Math.atan2(nodes[c.node + 1].x - nodes[c.node].x, nodes[c.node + 1].y - nodes[c.node].y);
      const withFlow = Math.abs(((c.yaw * Math.PI) / 180 - flow + Math.PI * 3) % (2 * Math.PI) - Math.PI) < 0.01;
      const [lo, hi] = withFlow ? [c.node - 2, c.node + 1] : [c.node - 1, c.node + 2];
      for (const t of mine.filter((x) => x.dir === 'out')) expect(index(t), `producer of net ${c.beltId}`).toBeLessThan(lo);
      for (const t of mine.filter((x) => x.dir === 'in')) expect(index(t), `consumer of net ${c.beltId}`).toBeGreaterThan(hi);
    }
  });

  it('fails with a reason, not a throw: no feed net, no port for it, no bay for a net, a route that misses its bay', async () => {
    const p = await processorPipeline(3);
    const run = (net: Netlist, taps: TapAssignment, bays = p.bays, routes = p.routed.routes) => feedProliferator(net, taps, routes, bays, p.occ, p.params, data, never);
    expect(run({ ...p.net, nets: p.net.nets.filter((n) => !n.proliferator) }, p.taps)).toEqual({ failed: 'the netlist has no proliferator net' });
    const feedId = p.net.nets.find((n) => n.proliferator)?.id;
    expect(run(p.net, { ...p.taps, stationPorts: p.taps.stationPorts.filter((x) => x.netId !== feedId) })).toEqual({
      failed: `the proliferator net ${feedId} has no station port`,
    });
    expect(run(p.net, p.taps, p.bays.slice(1))).toMatchObject({ failed: expect.stringMatching(/^net \d+ \(item \d+\) has no bay for a spray coater$/) });
    // a bay somewhere the route does not go
    const first = p.bays[0];
    const moved: Bay = { ...first, cells: first.cells.map((c) => ({ x: c.x + 1000, y: c.y })) };
    expect(run(p.net, p.taps, [moved, ...p.bays.slice(1)])).toMatchObject({ failed: expect.stringMatching(/^the route of net \d+ does not pass the middle of its bay/) });
    // a net without a route
    expect(run(p.net, p.taps, p.bays, p.routed.routes.map((r) => (r.netId === first.netId ? { ...r, nodes: [] } : r)))).toMatchObject({
      failed: expect.stringMatching(/^net \d+ has no route to put a spray coater on$/),
    });
  });

  it('stops when asked to', async () => {
    const p = await processorPipeline(3);
    expect(feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, () => true)).toEqual({ stopped: true });
  });

  it('is deterministic, and the coater ids are in the range placement.ts documents', async () => {
    const p = await processorPipeline(3);
    const a = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
    const b = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
    expect(a).toEqual(b);
    if ('coaters' in a) for (const c of a.coaters) expect(c.id).toBe(coaterIdOf(c.beltId));
    expect(COATER_ID_OFFSET).toBeGreaterThan(1000 + 100_000);
  });
});

describe('a coating window on every sprayed net, whatever the placement', () => {
  // High-Explosive Shell Set has its producers and consumers on opposite sides of lifts and bends (producers of a net at nodes
  // 1 and 12, its consumers from node 28): with the coater looked for on the routed net, margins 3 and 4 had no stretch for it.
  it.each([3, 4, 6])('High-Explosive Shell Set with Mk.III: every sprayed net gets its coater and the feed reaches them all (margin %i)', async (margin) => {
    const p = await shellSetPipeline(margin);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
    if (!('coaters' in fed)) throw new Error(JSON.stringify(fed));
    expect(fed.coaters.map((c) => c.beltId)).toEqual(p.net.nets.filter((n) => n.sprayed).map((n) => n.id));
  });
});

describe('a start-up is not a shortfall (High-Explosive Shell Set)', () => {
  // Its Refined Oil is sized to 98 %. Sulfuric Acid takes oil from Plastic while its belt (232 cargo) fills at 0.06 cargo/s, which takes
  // 80 game minutes; the 20 minutes the adaptive warm-up used to be capped at read 94-96 % of a layout that makes 102 % once it is full.
  it('with Mk.I proliferator at margin 4 the plain validation passes, after a warm-up longer than the cap of a plan that fills at once', async () => {
    const p = await shellSetPipeline(4, 1);
    const fed = feedProliferator(p.net, p.taps, p.routed.routes, p.bays, p.occ, p.params, data, never);
    if (!('coaters' in fed)) throw new Error(JSON.stringify(fed));
    const routes = [...p.routed.routes, fed.route];
    const bare = assembleLayout(p.net, p.placement, p.taps, routes, [], p.plan, data, fed.coaters);
    for (const c of coaterBuildings(bare, data)) p.occ.addBuilding(c);
    const targets = powerTargets(bare, data);
    const poles = placePowerNodes(bare.buildings, targets.consumerPoints, targets.blockedPoints, p.occ, data, effects);
    const layout = assembleLayout(p.net, p.placement, p.taps, routes, poles ?? [], p.plan, data, fed.coaters);

    const short = runSimulation(layout, p.plan, data, effects, { warmupTicks: MAX_WARMUP_TICKS });
    expect(short.measuredTargetRate).toBeLessThan(0.99);
    const report = validateLayout(layout, p.plan, data, effects);
    expect(report.violations.map((v) => `${v.code}: ${v.message}`)).toEqual([]);
    expect(report.sim!.warmupTicksUsed).toBeGreaterThan(MAX_WARMUP_TICKS);
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99);
  }, 60_000);
});
