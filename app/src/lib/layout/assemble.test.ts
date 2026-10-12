import { describe, expect, it } from 'vitest';
import type { ProductionPlan } from '../calc';
import { GameDataIndex } from '../data';
import { sorterEnds, TILE } from '../geometry';
import type { Layout, PlacedBuilding } from '../geometry';
import { validateLayout } from '../validate';
import { LayoutKit, onNode, onSlot } from '../validate/testkit';
import { assembleLayout } from './assemble';
import { buildNetlist } from './netlist';
import type { Netlist } from './netlist';
import { constructivePlacement, placementBuildingIdOf, stationBuildingId } from './placement';
import type { Placement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { defaultRouteParams, routeNets } from './router';
import type { RoutedNet } from './router';
import { assignTaps } from './taps';
import type { TapAssignment } from './taps';
import { data, effects, occupancyOf, parsed, planFor, processorPlan, SMELTER } from './testkit';

const REFINERY = 2308;

interface Solved {
  net: Netlist;
  placement: Placement;
  taps: TapAssignment;
  routes: RoutedNet[];
  poles: PlacedBuilding[];
  /** Without poles. */
  base: Layout;
  layout: Layout;
}

/** Netlist, constructive placement, taps, routes and poles for `plan`, assembled. */
function solve(plan: ProductionPlan, margin = 3): Solved {
  const net = buildNetlist(plan, data, effects);
  const placement = constructivePlacement(net, data, margin);
  const occ = occupancyOf(placement.buildings);
  const taps = assignTaps(net, placement, occ, data, effects);
  if ('failed' in taps) throw new Error(`assignTaps failed: ${taps.failed}`);
  const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
  if (!res.ok) throw new Error(`routing left ${res.conflicts} conflicts; unroutable nets ${res.unroutable.join(', ')}`);
  const base = assembleLayout(net, placement, taps, res.routes, [], plan, data);
  const { consumerPoints, blockedPoints } = powerTargets(base, data);
  const poles = placePowerNodes(base.buildings, consumerPoints, blockedPoints, occ, data, effects);
  if (!poles) throw new Error('no power node placement');
  const layout = assembleLayout(net, placement, taps, res.routes, poles, plan, data);
  return { net, placement, taps, routes: res.routes, poles, base, layout };
}

const ironIngotPlan = () =>
  planFor({ targetItemId: 1101, suppliedItemIds: new Set([1001]), finalFacilityItemId: SMELTER, facilityOverrides: { 1: SMELTER } });

const plasmaPlan = () =>
  planFor({
    targetItemId: 1114,
    suppliedItemIds: new Set([1007]),
    finalFacilityItemId: REFINERY,
    facilityOverrides: { 16: REFINERY },
    recipeOverrides: { 1114: 16 },
  });

const violationText = (r: ReturnType<typeof validateLayout>): string[] =>
  r.violations.map((v) => `${v.code}: ${v.message}`);

describe('assembleLayout on one smelter and one station (iron ingots)', () => {
  it('builds the belts, sorters and station config the netlist and the assignment ask for', async () => {
    const plan = await ironIngotPlan();
    const s = solve(plan);
    const { net, taps, layout } = s;
    expect(net.stations).toHaveLength(1);
    expect(net.nets.map((n) => [n.itemId, n.source.kind, n.sink.kind])).toEqual([
      [1001, 'station', 'deadEnd'],
      [1101, 'taps', 'station'],
    ]);

    // belts: one per net, ids are the net ids, the route's nodes, ports from the station assignment
    expect(layout.belts.map((b) => b.id)).toEqual(net.nets.map((n) => n.id));
    for (const n of net.nets) {
      const belt = layout.belts.find((b) => b.id === n.id)!;
      const route = s.routes.find((r) => r.netId === n.id)!;
      expect(belt.itemId).toBe(n.itemId);
      expect(belt.tierItemId).toBe(n.tierItemId);
      expect(belt.plannedRate).toBe(n.rate);
      expect(belt.nodes).toEqual(route.nodes);
      expect(belt.nodes).not.toBe(route.nodes);
      const port = taps.stationPorts.find((p) => p.netId === n.id)!;
      if (port.end === 'source') {
        expect(belt.source).toEqual({ buildingId: stationBuildingId(0), port: port.port });
        expect(belt.sink).toBeUndefined();
      } else {
        expect(belt.sink).toEqual({ kind: 'port', buildingId: stationBuildingId(0), port: port.port });
        expect(belt.source).toBeUndefined();
      }
    }

    // the station: slots from the netlist, ports by direction, the item's slot (1-based), charge and piler defaults
    const station = layout.buildings.find((b) => b.id === stationBuildingId(0))!;
    const cfg = station.station!;
    expect(cfg.slots).toEqual(net.stations[0].slots);
    expect(cfg.slots).not.toBe(net.stations[0].slots);
    expect(cfg.ports).toHaveLength(12);
    expect(cfg.pilerCount).toBe(0);
    expect(cfg.chargePerTick).toBe(data.data.constants.stationDefaultChargePerTick.planetary);
    const used = new Set(taps.stationPorts.map((p) => p.port));
    cfg.ports.forEach((p, i) => {
      if (!used.has(i)) expect(p).toEqual({ dir: 0, storageIdx: 0 });
    });
    for (const p of taps.stationPorts) {
      const item = net.nets.find((n) => n.id === p.netId)!.itemId;
      const slot = cfg.slots.findIndex((x) => x.itemId === item);
      expect(cfg.ports[p.port]).toEqual({ dir: p.end === 'source' ? 1 : 2, storageIdx: slot + 1 });
    }

    // machines keep the placement's role and recipe
    const smelters = layout.buildings.filter((b) => b.itemId === SMELTER);
    expect(smelters).toHaveLength(1);
    expect(smelters[0].role).toBe('stage:0');
    expect(smelters[0].recipeId).toBe(plan.stages[0].recipeId);

    // sorters: one per assigned tap, filtered to the net's item, belt and building on the right sides
    expect(layout.sorters).toHaveLength(taps.taps.length);
    expect(new Set(layout.sorters.map((x) => x.id)).size).toBe(layout.sorters.length);
    taps.taps.forEach((t, i) => {
      const sorter = layout.sorters[i];
      const belt = layout.belts.find((b) => b.id === t.netId)!;
      const onBelt = { kind: 'belt', beltId: belt.id, node: expect.any(Number) };
      const onMachine = { kind: 'building', buildingId: t.machineId + 1000, slot: t.slot };
      expect(sorter.filterItemId).toBe(belt.itemId);
      expect(sorter.tierItemId).toBe(net.sorterTierItemId);
      expect(sorter.span).toBe(t.span);
      expect(sorter.plannedRate).toBe(t.rate);
      expect(sorter.pick).toMatchObject(t.dir === 'in' ? onBelt : onMachine);
      expect(sorter.drop).toMatchObject(t.dir === 'in' ? onMachine : onBelt);
      const end = t.dir === 'in' ? sorter.pick : sorter.drop;
      if (end.kind !== 'belt') throw new Error('expected a belt end');
      expect(belt.nodes[end.node]).toEqual({ x: t.point.x, y: t.point.y, z: 0 });
    });

    // meta
    expect(layout.meta).toEqual({
      geometrySource: 'approximate',
      gameVersion: data.data.meta.gameVersion,
      planTargetItemId: 1101,
      planTargetRate: 1,
    });
    // poles are appended after the placement's buildings
    expect(layout.buildings.slice(0, s.placement.buildings.length).map((b) => b.id)).toEqual(
      s.placement.buildings.map((b) => b.id),
    );
    expect(layout.buildings.slice(s.placement.buildings.length)).toEqual(s.poles);
  });

  it('passes the full validator, simulation included (3000 warm-up and 6000 measured ticks)', async () => {
    const plan = await ironIngotPlan();
    const { layout } = solve(plan);
    const report = validateLayout(layout, plan, data, effects, { warmupTicks: 3000, measureTicks: 6000 });
    expect(violationText(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.stage).toBe('simulation');
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99);
  }, 120_000);

  it('takes the station charge from the request when it gives one', async () => {
    const plan = await ironIngotPlan();
    const custom: ProductionPlan = { ...plan, request: { ...plan.request, stationChargePerTick: 123_456 } };
    const { layout } = solve(custom);
    expect(layout.buildings.find((b) => b.id === stationBuildingId(0))!.station!.chargePerTick).toBe(123_456);
  });

  it('marks the geometry extracted only when everything the layout uses is extracted', async () => {
    const plan = await ironIngotPlan();
    const s = solve(plan);
    const copy = structuredClone(parsed);
    for (const b of copy.buildings) b.geometry.source = 'extracted';
    const extracted = new GameDataIndex(copy);
    const args = [s.net, s.placement, s.taps, s.routes, s.poles, plan] as const;
    expect(assembleLayout(...args, extracted).meta.geometrySource).toBe('extracted');

    copy.buildings.find((b) => b.itemId === s.poles[0].itemId)!.geometry.source = 'approximate';
    expect(assembleLayout(...args, new GameDataIndex(copy)).meta.geometrySource).toBe('approximate');
    copy.buildings.find((b) => b.itemId === s.poles[0].itemId)!.geometry.source = 'extracted';
    copy.buildings.find((b) => b.itemId === s.net.beltTierItemId)!.geometry.source = 'approximate';
    expect(assembleLayout(...args, new GameDataIndex(copy)).meta.geometrySource).toBe('approximate');
  });

  it('rejects inputs that cannot make a layout: a net without a route, a stray tap, a repeated id', async () => {
    const plan = await ironIngotPlan();
    const s = solve(plan);
    const args = (routes: RoutedNet[], taps = s.taps, poles = s.poles) =>
      () => assembleLayout(s.net, s.placement, taps, routes, poles, plan, data);
    expect(args(s.routes.slice(1))).toThrow(/net 1 has no route/);
    const empty = s.routes.map((r) => (r.netId === 1 ? { ...r, nodes: [] } : r));
    expect(args(empty)).toThrow(/net 1 has no route/);
    const stray = { ...s.taps, taps: s.taps.taps.map((t, i) => (i === 0 ? { ...t, point: { x: 9999, y: 9999 } } : t)) };
    expect(args(s.routes, stray)).toThrow(/no belt node at tap point \(9999, 9999\)/);
    const clash = s.poles.map((p, i) => (i === 0 ? { ...p, id: s.placement.buildings[0].id } : p));
    expect(args(s.routes, s.taps, clash)).toThrow(/building id \d+ is used twice/);
  });
});

describe('powerTargets', () => {
  it('lists the sorter midpoints and blocks the belt nodes and the cells a sorter spans', () => {
    // An assembler at (6, 8), a belt along y = 5 and a span-2 sorter on its south slot: the sorter reaches from
    // the slot (6, 7.117) to the belt node (6, 5) over the lattice points (6, 7) and (6, 6).
    const kit = new LayoutKit(data, effects);
    const asm = kit.assembler(6, 8);
    const belt = kit.belt(1, 1001, [
      [5, 5, 0],
      [6, 5, 0],
      [7, 5, 0],
      [7, 5, 1],
    ]);
    const sorter = kit.sorter(onNode(belt, 1), onSlot(asm, 7), 2);
    const layout = kit.layout();
    const { consumerPoints, blockedPoints } = powerTargets(layout, data);

    const ends = sorterEnds(sorter, layout, data);
    expect(consumerPoints).toEqual([{ x: (ends.pick.x + ends.drop.x) / 2, y: (ends.pick.y + ends.drop.y) / 2 }]);
    expect(consumerPoints[0].x).toBeCloseTo(6, 9);
    expect(consumerPoints[0].y).toBeCloseTo((5 + 8 - 1.11 / TILE) / 2, 6);
    // every belt node, at any height, and the sorter's cells
    for (const p of belt.nodes) expect(blockedPoints.has(`${p.x},${p.y}`)).toBe(true);
    for (const cell of ['6,5', '6,6', '6,7']) expect(blockedPoints.has(cell), cell).toBe(true);
    expect(blockedPoints.has('3,3')).toBe(false);
  });
});

describe('Plasma Refining', () => {
  it('filters each output sorter to its own product: refined oil 1114 and hydrogen 1120', async () => {
    const plan = await plasmaPlan();
    expect(plan.stages.some((st) => st.outputs.some((o) => o.itemId === 1120))).toBe(true);
    const s = solve(plan);
    const refinery = (id: number) => s.layout.buildings.find((b) => b.id === id)?.itemId === REFINERY;
    const outputs = s.layout.sorters.filter((x) => x.pick.kind === 'building' && refinery(x.pick.buildingId));
    expect(outputs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(outputs.map((x) => x.filterItemId))).toEqual(new Set([1114, 1120]));
    for (const x of s.layout.sorters) {
      if (x.drop.kind !== 'belt' && x.pick.kind !== 'belt') continue;
      const end = x.drop.kind === 'belt' ? x.drop : x.pick;
      if (end.kind !== 'belt') continue;
      expect(x.filterItemId).toBe(s.layout.belts.find((b) => b.id === end.beltId)!.itemId);
    }
    expect(outputs.filter((x) => x.filterItemId === 1120).length).toBeGreaterThanOrEqual(1);
    expect(outputs.filter((x) => x.filterItemId === 1114).length).toBeGreaterThanOrEqual(1);
    const report = validateLayout(s.layout, plan, data, effects, { simulate: false });
    expect(violationText(report)).toEqual([]);
  }, 120_000);
});

describe('the Processor netlist end to end', () => {
  it('constructive placement (margin 2), taps, routes and poles pass the validator with the simulation', async () => {
    const plan = await processorPlan();
    const s = solve(plan, 2);
    const t0 = performance.now();
    // 3600 warm-up ticks (1800 before Task 27): the weighted heuristic routes some belts of the chain differently, and the
    // chain fills a few seconds later (59 items of 60 in the window after 1800 ticks, 1.000 from 2400); the steady state is the same
    const report = validateLayout(s.layout, plan, data, effects, { warmupTicks: 3600, measureTicks: 3600 });
    const ms = performance.now() - t0;
    process.stdout.write(
      `processor: ${s.net.machines.length} machines, ${s.poles.length} poles, ${s.layout.sorters.length} sorters, ` +
        `validate ${ms.toFixed(0)} ms, ${report.sim ? report.sim.measuredTargetRate.toFixed(3) : 'no sim'}/s\n`,
    );
    expect(violationText(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});

describe('assembleLayout with motifs', () => {
  it('writes the internal sorters of the netlist as sorters between two buildings, after the tap sorters', async () => {
    const plan = await ironIngotPlan();
    const s = solve(plan);
    const machine = s.net.machines[0];
    const net: Netlist = {
      ...s.net,
      motifs: {
        groups: [],
        sorters: [
          { fromMachine: machine.id, fromSlot: 4, toMachine: machine.id, toSlot: 10, itemId: 1101, span: 2, plannedRate: 0.75 },
        ],
      },
    };
    const layout = assembleLayout(net, s.placement, s.taps, s.routes, [], plan, data);
    expect(layout.sorters).toHaveLength(s.base.sorters.length + 1);
    expect(layout.sorters.slice(0, s.base.sorters.length)).toEqual(s.base.sorters);
    const internal = layout.sorters[layout.sorters.length - 1];
    expect(internal).toEqual({
      id: s.base.sorters.length + 1,
      tierItemId: net.sorterTierItemId,
      filterItemId: 1101,
      span: 2,
      pick: { kind: 'building', buildingId: placementBuildingIdOf(machine.id), slot: 4 },
      drop: { kind: 'building', buildingId: placementBuildingIdOf(machine.id), slot: 10 },
      plannedRate: 0.75,
    });
  });

  it('keeps the stacks of the placement: z and stackParentId come through to the layout', async () => {
    const plan = await ironIngotPlan();
    const s = solve(plan);
    const machineId = placementBuildingIdOf(s.net.machines[0].id);
    const placement: Placement = {
      ...s.placement,
      buildings: s.placement.buildings.map((b) => (b.id === machineId ? { ...b, z: 3, stackParentId: stationBuildingId(0) } : b)),
    };
    const layout = assembleLayout(s.net, placement, s.taps, s.routes, [], plan, data);
    expect(layout.buildings.find((b) => b.id === machineId)).toMatchObject({ z: 3, stackParentId: stationBuildingId(0) });
  });
});

describe('assembleLayout: the proliferator network (Task 28)', () => {
  const sprayed = (tier: 1 | 2 | 3 = 3, mode: 'extra' | 'speed' = 'extra') => processorPlan(1, { tier, mode });

  /** Netlist, placement, taps and the routes of the item nets (every net but the feed) of the sprayed Processor plan. */
  async function itemNets(mode: 'extra' | 'speed' = 'extra') {
    const plan = await sprayed(3, mode);
    const net = buildNetlist(plan, data, effects);
    const placement = constructivePlacement(net, data, 3);
    const occ = occupancyOf(placement.buildings);
    const taps = assignTaps(net, placement, occ, data, effects);
    if ('failed' in taps) throw new Error(taps.failed);
    const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
    if (!res.ok) throw new Error('routing');
    return { plan, net, placement, taps, routes: res.routes };
  }

  it('leaves the proliferator net out while it has no route: the layout of the item nets alone', async () => {
    const s = await itemNets();
    const feed = s.net.nets.find((n) => n.proliferator)!;
    expect(s.routes.some((r) => r.netId === feed.id)).toBe(false); // routeNets leaves it alone
    const layout = assembleLayout(s.net, s.placement, s.taps, s.routes, [], s.plan, data);
    expect(layout.belts.map((b) => b.id)).toEqual(s.net.nets.filter((n) => !n.proliferator).map((n) => n.id));
    expect(layout.coaters).toBeUndefined();
    // the station still has the feed's port configured, so a later call with the route finds it in place
    const station = layout.buildings.find((b) => b.id === stationBuildingId(feed.source.kind === 'station' ? feed.source.stationIdx : 0));
    expect(station?.station?.ports.some((p) => p.dir === 1 && station.station?.slots[p.storageIdx - 1]?.itemId === 1143)).toBe(true);
  });

  it('with the feed route and the coaters: a belt for the feed (item 1143, from its port, no sink) and the coaters as given', async () => {
    const s = await itemNets();
    const feed = s.net.nets.find((n) => n.proliferator)!;
    const coaters = [{ id: 1_000_001, beltId: 1, node: 5, yaw: 90 as const }];
    const route: RoutedNet = { netId: feed.id, nodes: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] };
    const layout = assembleLayout(s.net, s.placement, s.taps, [...s.routes, route], [], s.plan, data, coaters);
    const belt = layout.belts.find((b) => b.id === feed.id)!;
    expect(belt).toMatchObject({ itemId: 1143, tierItemId: s.net.beltTierItemId, plannedRate: feed.rate });
    expect(belt.sink).toBeUndefined();
    const port = s.taps.stationPorts.find((p) => p.netId === feed.id)!;
    expect(belt.source).toEqual({ buildingId: port.stationBuildingId, port: port.port });
    expect(layout.coaters).toEqual(coaters);
    // copies: editing the layout's coaters leaves the caller's
    layout.coaters![0].node = 99;
    expect(coaters[0].node).toBe(5);
  });

  it('a layout with coaters is approximate while the coater geometry is', async () => {
    const s = await itemNets();
    const coaters = [{ id: 1_000_001, beltId: 1, node: 5, yaw: 90 as const }];
    const plain = assembleLayout(s.net, s.placement, s.taps, s.routes, [], s.plan, data, []);
    const withCoaters = assembleLayout(s.net, s.placement, s.taps, s.routes, [], s.plan, data, coaters);
    expect(withCoaters.meta.geometrySource).toBe('approximate');
    expect(plain.meta.geometrySource).toBe(withCoaters.meta.geometrySource); // everything is approximate in the fixture
    const real = new GameDataIndex({
      ...data.data,
      buildings: data.data.buildings.map((b) => ({ ...b, geometry: { ...b.geometry, source: 'extracted' as const } })).map((b) => (b.kind === 'sprayCoater' ? { ...b, geometry: { ...b.geometry, source: 'approximate' as const } } : b)),
    });
    expect(assembleLayout(s.net, s.placement, s.taps, s.routes, [], s.plan, real).meta.geometrySource).toBe('extracted');
    expect(assembleLayout(s.net, s.placement, s.taps, s.routes, [], s.plan, real, coaters).meta.geometrySource).toBe('approximate');
  });

  it('speed mode: every machine and lab carries the speed-up (prolifMode 1); extra products and no proliferator carry none', async () => {
    const speed = await itemNets('speed');
    const layout = assembleLayout(speed.net, speed.placement, speed.taps, speed.routes, [], speed.plan, data);
    const machines = layout.buildings.filter((b) => b.recipeId !== undefined);
    expect(machines.length).toBeGreaterThan(5);
    expect(machines.every((b) => b.prolifMode === 1)).toBe(true);
    expect(layout.buildings.filter((b) => b.recipeId === undefined).every((b) => b.prolifMode === undefined)).toBe(true);

    const extra = await itemNets('extra');
    const plain = assembleLayout(extra.net, extra.placement, extra.taps, extra.routes, [], extra.plan, data);
    expect(plain.buildings.every((b) => b.prolifMode === undefined)).toBe(true);

    // without a proliferator the mode of the request means nothing
    const none = await processorPlan(1, { tier: 0, mode: 'speed' });
    const net = buildNetlist(none, data, effects);
    const placement = constructivePlacement(net, data, 3);
    const occ = occupancyOf(placement.buildings);
    const taps = assignTaps(net, placement, occ, data, effects);
    if ('failed' in taps) throw new Error(taps.failed);
    const res = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
    if (!res.ok) throw new Error('routing');
    expect(assembleLayout(net, placement, taps, res.routes, [], none, data).buildings.every((b) => b.prolifMode === undefined)).toBe(true);
  });
});

