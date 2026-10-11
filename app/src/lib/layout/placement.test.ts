import { describe, expect, it } from 'vitest';
import { planProduction } from '../calc';
import type { PlanRequest } from '../calc';
import { allTechs, computeTechEffects, GameDataIndex } from '../data';
import { buildingOBBs, obbOverlap } from '../geometry';
import type { PlacedBuilding } from '../geometry';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { buildNetlist } from './netlist';
import type { BeltNet, Netlist } from './netlist';
import {
  annealPlacement,
  constructivePlacement,
  DEFAULT_PLACEMENT_WEIGHTS,
  machineIdOfBuilding,
  placementBuildingIdOf,
  placementCost,
  stationBuildingId,
} from './placement';
import type { Placement, PlacementParams } from './placement';

const parsed = loadFixtureGameData();
const data = new GameDataIndex(parsed);
const everything = allTechs(parsed);
const effects = computeTechEffects(parsed, everything);

const ASSEMBLER = 2303;
const SMELTER = 2302;
const CHEM_PLANT = 2309;
const REFINERY = 2308;
const COLLIDER = 2310;
const SILO = 2312;
const PLS = 2103;
const ILS = 2104;

// ---------------------------------------------------------------------------------------------
// Netlists

function request(over: Partial<PlanRequest> & Pick<PlanRequest, 'targetItemId'>): PlanRequest {
  return {
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: ASSEMBLER,
    unlockedTechs: everything,
    suppliedItemIds: new Set(),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
    ...over,
  };
}

const PROCESSOR_MK1 = { 51: ASSEMBLER, 50: ASSEMBLER, 53: ASSEMBLER, 1: SMELTER, 3: SMELTER, 59: SMELTER };
const processorRequest = (perSecond: number): PlanRequest =>
  request({
    targetItemId: 1303,
    quantity: { kind: 'rate', perSecond },
    suppliedItemIds: new Set([1001, 1002, 1003]),
    facilityOverrides: PROCESSOR_MK1,
  });

const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: ASSEMBLER,
  SMELT: SMELTER,
  CHEMICAL: CHEM_PLANT,
  REFINE: REFINERY,
  PARTICLE: COLLIDER,
  RESEARCH: 2901,
};
/** 1 Quantum Chip/s on base-tier machines: 19 stages of assemblers, smelters, chemical plants, refineries, colliders. */
const quantumRequest = (): PlanRequest =>
  request({
    targetItemId: 1305,
    suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1120]),
    recipeOverrides: { 1114: 16 },
    facilityOverrides: Object.fromEntries(
      parsed.recipes.filter((r) => r.type in BASE_TIER_BY_TYPE).map((r) => [r.id, BASE_TIER_BY_TYPE[r.type]] as const),
    ),
  });

async function netlistOf(req: PlanRequest): Promise<Netlist> {
  const result = await planProduction(req, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return buildNetlist(result.plan, data, effects);
}

/** A hand-made netlist: `stages[i]` is the building of stage i's machines (`count` of them); nets given as tap lists. */
function synthNetlist(
  stages: { building: number; count: number }[],
  stationBuildings: number[],
  nets: { taps: number[]; station?: { idx: number; as: 'source' | 'sink' } }[],
): Netlist {
  const machines: Netlist['machines'] = [];
  stages.forEach((s, stageIndex) => {
    for (let i = 0; i < s.count; i++) {
      machines.push({
        id: machines.length + 1,
        stageIndex,
        recipeId: 100 + stageIndex,
        buildingItemId: s.building,
        inputs: [],
        outputs: [],
      });
    }
  });
  const beltNets: BeltNet[] = nets.map((n, i) => ({
    id: i + 1,
    itemId: 1001,
    tierItemId: 2001,
    rate: 1,
    source: n.station?.as === 'source' ? { kind: 'station', stationIdx: n.station.idx } : { kind: 'taps' },
    sink: n.station?.as === 'sink' ? { kind: 'station', stationIdx: n.station.idx } : { kind: 'deadEnd' },
    taps: n.taps.map((machineId, j) => ({
      machineId,
      itemId: 1001,
      dir: j === 0 && n.station?.as !== 'source' ? ('out' as const) : ('in' as const),
      rate: 1,
      sorters: 1,
    })),
  }));
  return {
    machines,
    nets: beltNets,
    stations: stationBuildings.map((buildingItemId) => ({
      kind: buildingItemId === ILS ? ('interstellar' as const) : ('planetary' as const),
      buildingItemId,
      slots: [],
      portsNeeded: 0,
    })),
    sorterTierItemId: 2011,
    beltTierItemId: 2001,
    warnings: [],
  };
}

/** Mixed sizes, three stations (one an ILS), a chain of nets linking neighbouring stages. */
function mixedNetlist(): Netlist {
  const stages = [
    { building: SMELTER, count: 6 },
    { building: ASSEMBLER, count: 9 },
    { building: CHEM_PLANT, count: 3 },
    { building: REFINERY, count: 2 },
    { building: COLLIDER, count: 2 },
    { building: ASSEMBLER, count: 4 },
    { building: SILO, count: 1 },
    { building: SMELTER, count: 1 },
  ];
  const ids = (stage: number): number[] => {
    let first = 1;
    for (let i = 0; i < stage; i++) first += stages[i].count;
    return Array.from({ length: stages[stage].count }, (_, k) => first + k);
  };
  const nets: Parameters<typeof synthNetlist>[2] = [];
  for (let s = 0; s + 1 < stages.length; s++) nets.push({ taps: [...ids(s), ...ids(s + 1)].slice(0, 12) });
  nets.push({ taps: ids(0), station: { idx: 0, as: 'source' } });
  nets.push({ taps: ids(2), station: { idx: 1, as: 'source' } });
  nets.push({ taps: ids(5), station: { idx: 2, as: 'sink' } });
  nets.push({ taps: ids(6), station: { idx: 2, as: 'sink' } });
  return synthNetlist(stages, [PLS, ILS, PLS], nets);
}

// ---------------------------------------------------------------------------------------------
// Checks

function obbsOf(b: PlacedBuilding) {
  return buildingOBBs(b, data.building(b.itemId)!);
}

/** Brute force: no two buildings closer than 2 * margin tiles (footprints inflated by `margin` each). */
function expectNoCollisions(buildings: PlacedBuilding[], margin: number): void {
  const obbs = buildings.map(obbsOf);
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const hit = obbs[i].some((a) =>
        obbs[j].some((c) => obbOverlap({ ...a, hx: a.hx + 2 * margin, hy: a.hy + 2 * margin }, c)),
      );
      if (hit) {
        throw new Error(
          `buildings ${buildings[i].id} (item ${buildings[i].itemId} at ${buildings[i].x},${buildings[i].y}) and ` +
            `${buildings[j].id} (item ${buildings[j].itemId} at ${buildings[j].x},${buildings[j].y}) collide at margin ${margin}`,
        );
      }
    }
  }
}

/** What every placement of `net` must satisfy, whatever produced it. */
function expectSoundPlacement(net: Netlist, p: Placement, margin: number): void {
  expect(p.buildings).toHaveLength(net.stations.length + net.machines.length);
  expect(new Set(p.buildings.map((b) => b.id)).size).toBe(p.buildings.length);
  net.stations.forEach((st, idx) => {
    const b = p.buildings[idx];
    expect(b).toMatchObject({ id: stationBuildingId(idx), itemId: st.buildingItemId, z: 0 });
    expect(b.role).toBe(`station:${idx}`);
  });
  net.machines.forEach((m, k) => {
    const b = p.buildings[net.stations.length + k];
    expect(b).toMatchObject({
      id: placementBuildingIdOf(m.id),
      itemId: m.buildingItemId,
      recipeId: m.recipeId,
      role: `stage:${m.stageIndex}`,
      z: 0,
    });
    expect(machineIdOfBuilding(b.id)).toBe(m.id);
  });
  for (const b of p.buildings) {
    expect(Number.isInteger(b.x), `building ${b.id} x=${b.x}`).toBe(true);
    expect(Number.isInteger(b.y), `building ${b.id} y=${b.y}`).toBe(true);
    expect([0, 90, 180, 270]).toContain(b.yaw);
  }
  expectNoCollisions(p.buildings, margin);
}

const params = (over: Partial<PlacementParams> = {}): PlacementParams => ({
  margin: 2,
  seed: 1,
  iterations: 20000,
  startTemp: 20,
  weights: DEFAULT_PLACEMENT_WEIGHTS,
  ...over,
});

const never = () => false;

// ---------------------------------------------------------------------------------------------

describe('building ids', () => {
  it('stations take ids 1..S; a machine keeps its netlist id behind a fixed offset', () => {
    expect(stationBuildingId(0)).toBe(1);
    expect(stationBuildingId(4)).toBe(5);
    expect(placementBuildingIdOf(1)).toBe(1001);
    expect(placementBuildingIdOf(25)).toBe(1025);
    expect(machineIdOfBuilding(1025)).toBe(25);
    expect(machineIdOfBuilding(3)).toBeUndefined();
  });
});

describe('placementCost', () => {
  const mk = (id: number, itemId: number, x: number, y: number): PlacedBuilding => ({ id, itemId, x, y, z: 0, yaw: 0 });

  it('is area * bounding box + wire * half perimeter of each net', () => {
    const net = synthNetlist([{ building: ASSEMBLER, count: 3 }], [], [{ taps: [1, 2] }, { taps: [2, 3] }]);
    const buildings = [
      mk(placementBuildingIdOf(1), ASSEMBLER, 0, 0),
      mk(placementBuildingIdOf(2), ASSEMBLER, 10, 4),
      mk(placementBuildingIdOf(3), ASSEMBLER, 10, 12),
    ];
    const half = buildingOBBs(buildings[0], data.building(ASSEMBLER)!)[0].hx;
    const area = (10 + 2 * half) * (12 + 2 * half);
    const wire = 10 + 4 + 8;
    expect(placementCost(net, data, buildings, { area: 1, wire: 0 })).toBeCloseTo(area, 9);
    expect(placementCost(net, data, buildings, { area: 0, wire: 1 })).toBeCloseTo(wire, 9);
    expect(placementCost(net, data, buildings, { area: 2, wire: 3 })).toBeCloseTo(2 * area + 3 * wire, 9);
  });

  it('counts the nearest port of the net station as one more point of the net', () => {
    const net = synthNetlist([{ building: ASSEMBLER, count: 1 }], [PLS], [{ taps: [1], station: { idx: 0, as: 'source' } }]);
    // the PLS' east ports start belts at (4, -1..1) from its centre
    const buildings = [mk(1, PLS, -10, 0), mk(placementBuildingIdOf(1), ASSEMBLER, 10, 4)];
    // nearest port (x = -6, y = 1) to the machine at (10, 4): 16 across, 3 up
    expect(placementCost(net, data, buildings, { area: 0, wire: 1 })).toBeCloseTo(19, 9);
    // a machine above the station: the nearest port is on its north face, (x, 4)
    const above = [mk(1, PLS, 0, 0), mk(placementBuildingIdOf(1), ASSEMBLER, 1, 20)];
    expect(placementCost(net, data, above, { area: 0, wire: 1 })).toBeCloseTo(16, 9);
  });

  it('does not add a port to a net without a station', () => {
    const net = synthNetlist([{ building: ASSEMBLER, count: 2 }], [PLS], [{ taps: [1, 2] }]);
    const buildings = [mk(1, PLS, 0, 0), mk(placementBuildingIdOf(1), ASSEMBLER, 20, 0), mk(placementBuildingIdOf(2), ASSEMBLER, 20, 6)];
    expect(placementCost(net, data, buildings, { area: 0, wire: 1 })).toBeCloseTo(6, 9);
  });

  it('names a building the placement lacks', () => {
    const net = synthNetlist([{ building: ASSEMBLER, count: 2 }], [], [{ taps: [1, 2] }]);
    expect(() => placementCost(net, data, [mk(placementBuildingIdOf(1), ASSEMBLER, 0, 0)], DEFAULT_PLACEMENT_WEIGHTS)).toThrow(
      /machine 2/,
    );
  });
});

describe('constructivePlacement', () => {
  it('places the Processor netlist without collisions at margin 2', async () => {
    const net = await netlistOf(processorRequest(1));
    expect(net.machines.length).toBeGreaterThanOrEqual(20);
    const p = constructivePlacement(net, data, 2);
    expectSoundPlacement(net, p, 2);
    expect(p.cost).toBe(placementCost(net, data, p.buildings, DEFAULT_PLACEMENT_WEIGHTS));
  });

  it('puts the first station at the origin and the machines to its right (rows along +x)', async () => {
    const net = await netlistOf(processorRequest(1));
    const p = constructivePlacement(net, data, 2);
    expect(p.buildings[0]).toMatchObject({ x: 0, y: 0, yaw: 0 });
    const stationRight = Math.max(...p.buildings.slice(0, net.stations.length).map((b) => b.x + 4));
    for (const b of p.buildings.slice(net.stations.length)) expect(b.x).toBeGreaterThan(stationRight);
  });

  it('is deterministic', async () => {
    const net = await netlistOf(processorRequest(1));
    expect(constructivePlacement(net, data, 2)).toEqual(constructivePlacement(net, data, 2));
  });

  it('spaces rows by 2 * margin + 3 tiles of clear channel', () => {
    for (const margin of [1, 2, 3]) {
      const net = synthNetlist([{ building: ASSEMBLER, count: 40 }], [PLS], [{ taps: [1, 2] }]);
      const p = constructivePlacement(net, data, margin);
      const machines = p.buildings.slice(1);
      const ys = [...new Set(machines.map((b) => b.y))].sort((a, b) => a - b);
      expect(ys.length).toBeGreaterThan(2);
      const half = obbsOf(machines[0])[0].hy;
      for (let i = 1; i < ys.length; i++) {
        const gap = ys[i] - ys[i - 1] - 2 * half;
        expect(gap).toBeGreaterThanOrEqual(2 * margin + 3 - 1e-9);
        expect(gap).toBeLessThan(2 * margin + 4);
      }
      // and neighbours in a row are 2 * margin apart, rounded up to a whole tile
      const row = machines.filter((b) => b.y === ys[0]).sort((a, b) => a.x - b.x);
      expect(row.length).toBeGreaterThan(2);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].x - row[i - 1].x - 2 * half;
        expect(gap).toBeGreaterThanOrEqual(2 * margin - 1e-9);
        expect(gap).toBeLessThan(2 * margin + 1);
      }
    }
  });

  it('keeps a stage together: its machines are laid out in id order, row by row', () => {
    const net = synthNetlist(
      [
        { building: SMELTER, count: 5 },
        { building: ASSEMBLER, count: 5 },
      ],
      [PLS],
      [{ taps: [1, 6] }],
    );
    const p = constructivePlacement(net, data, 2);
    const order = p.buildings.slice(1).map((b) => b.id);
    expect(order).toEqual(net.machines.map((m) => placementBuildingIdOf(m.id)));
    // within a row, ids grow with x
    const byRow = new Map<number, PlacedBuilding[]>();
    for (const b of p.buildings.slice(1)) byRow.set(b.y, [...(byRow.get(b.y) ?? []), b]);
    for (const row of byRow.values()) {
      const xs = row.map((b) => b.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });

  it('is collision free for the Quantum Chip netlist (19 stages, five building types) at several margins', async () => {
    const net = await netlistOf(quantumRequest());
    expect(new Set(net.machines.map((m) => m.buildingItemId)).size).toBeGreaterThanOrEqual(4);
    for (const margin of [0, 1, 2, 3]) expectSoundPlacement(net, constructivePlacement(net, data, margin), margin);
  });

  it('is collision free for mixed sizes and several stations (PLS and ILS), including a silo', () => {
    const net = mixedNetlist();
    expect(net.stations).toHaveLength(3);
    for (const margin of [0, 1, 2, 4]) expectSoundPlacement(net, constructivePlacement(net, data, margin), margin);
  });

  it('is collision free for a 700-machine Processor netlist, and quick', async () => {
    const net = await netlistOf(processorRequest(30));
    expect(net.machines.length).toBeGreaterThan(600);
    expect(net.stations.length).toBeGreaterThan(2);
    const t0 = performance.now();
    const p = constructivePlacement(net, data, 2);
    expect(performance.now() - t0).toBeLessThan(2000);
    expectSoundPlacement(net, p, 2);
  });

  it('lays rows out roughly square rather than in one long line', async () => {
    const net = await netlistOf(processorRequest(10));
    const p = constructivePlacement(net, data, 2);
    const xs = p.buildings.map((b) => b.x);
    const ys = p.buildings.map((b) => b.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeGreaterThan(0.4);
    expect(w / h).toBeLessThan(2.5);
  });

  it('handles a netlist without machines or stations', () => {
    const empty = synthNetlist([], [], []);
    expect(constructivePlacement(empty, data, 2)).toEqual({ buildings: [], cost: 0 });
    const stationOnly = synthNetlist([], [PLS, PLS], []);
    expectSoundPlacement(stationOnly, constructivePlacement(stationOnly, data, 2), 2);
  });

  it('rejects a margin that is negative or not a number', async () => {
    const net = synthNetlist([{ building: ASSEMBLER, count: 1 }], [PLS], []);
    for (const margin of [-1, NaN, Infinity]) expect(() => constructivePlacement(net, data, margin)).toThrow(RangeError);
  });

  it('names a building GameData does not have', () => {
    const net = synthNetlist([{ building: 424242, count: 1 }], [PLS], []);
    expect(() => constructivePlacement(net, data, 2)).toThrow(/424242/);
  });
});

describe('annealPlacement', () => {
  it('never increases the cost above the initial, has no collisions and is deterministic (Processor, seed 1, 20k)', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const a = annealPlacement(net, data, init, params(), never);
    const b = annealPlacement(net, data, init, params(), never);
    expect(a).toEqual(b);
    expect(a.cost).toBeLessThanOrEqual(init.cost);
    expectSoundPlacement(net, a, 2);
    expect(a.cost).toBe(placementCost(net, data, a.buildings, DEFAULT_PLACEMENT_WEIGHTS));
  });

  it('actually improves the constructive layout: markedly lower cost', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const out = annealPlacement(net, data, init, params(), never);
    expect(out.cost).toBeLessThan(init.cost * 0.9);
  });

  it('gives other seeds other (valid) layouts', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const a = annealPlacement(net, data, init, params({ seed: 1, iterations: 5000 }), never);
    const b = annealPlacement(net, data, init, params({ seed: 2, iterations: 5000 }), never);
    expect(b.buildings).not.toEqual(a.buildings);
    expectSoundPlacement(net, b, 2);
    expect(b.cost).toBeLessThanOrEqual(init.cost);
  });

  it('does not touch its input', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const copy = structuredClone(init);
    annealPlacement(net, data, init, params({ iterations: 3000 }), never);
    expect(init).toEqual(copy);
  });

  it('keeps ids, items, recipes, roles and the stations where they were', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const out = annealPlacement(net, data, init, params({ iterations: 5000 }), never);
    expect(out.buildings.map((b) => [b.id, b.itemId, b.recipeId, b.role, b.z])).toEqual(
      init.buildings.map((b) => [b.id, b.itemId, b.recipeId, b.role, b.z]),
    );
    net.stations.forEach((_, i) => expect(out.buildings[i]).toEqual(init.buildings[i]));
  });

  it('shouldStop returning true stops immediately with the current best (the initial placement)', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    let calls = 0;
    const out = annealPlacement(net, data, init, params(), () => {
      calls++;
      return true;
    });
    expect(calls).toBe(1);
    expect(out.buildings).toEqual(init.buildings);
    expect(out.cost).toBe(init.cost);
  });

  it('checks shouldStop periodically, not every iteration and not never', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    let calls = 0;
    annealPlacement(net, data, init, params(), () => {
      calls++;
      return false;
    });
    expect(calls).toBeGreaterThanOrEqual(20);
    expect(calls).toBeLessThanOrEqual(200);
  });

  it('stops mid-run with the best so far: valid, no worse than the start', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    let calls = 0;
    const out = annealPlacement(net, data, init, params(), () => ++calls > 40);
    expect(calls).toBe(41);
    expect(out.cost).toBeLessThanOrEqual(init.cost);
    expect(out.cost).toBeLessThan(init.cost);
    expectSoundPlacement(net, out, 2);
  });

  it('keeps the best seen even when a very hot start wanders far from it', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const weights = { area: 1, wire: 3 };
    const out = annealPlacement(net, data, init, params({ startTemp: 1e6, weights }), never);
    expectNoCollisions(out.buildings, 2);
    // reported under the weights of the call, and never above the start under those weights
    expect(out.cost).toBe(placementCost(net, data, out.buildings, weights));
    expect(out.cost).toBeLessThanOrEqual(placementCost(net, data, init.buildings, weights));
  });

  it('with zero iterations returns the initial placement', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const out = annealPlacement(net, data, init, params({ iterations: 0 }), never);
    expect(out.buildings).toEqual(init.buildings);
    expect(out.cost).toBe(init.cost);
  });

  it('weighs area against wire: a wire-only run shortens the nets, an area-only run shrinks the box', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const areaOnly = annealPlacement(net, data, init, params({ weights: { area: 1, wire: 0 } }), never);
    const wireOnly = annealPlacement(net, data, init, params({ weights: { area: 0, wire: 1 }, startTemp: 2 }), never);
    const wireOf = (p: Placement) => placementCost(net, data, p.buildings, { area: 0, wire: 1 });
    const areaOf = (p: Placement) => placementCost(net, data, p.buildings, { area: 1, wire: 0 });
    expect(areaOf(areaOnly)).toBeLessThan(areaOf(init));
    expect(wireOf(wireOnly)).toBeLessThan(wireOf(init));
    expect(areaOf(areaOnly)).toBeLessThanOrEqual(areaOf(wireOnly));
    expect(wireOf(wireOnly)).toBeLessThanOrEqual(wireOf(areaOnly));
  });

  it('works at margin 1 and margin 3, and keeps that margin', async () => {
    const net = await netlistOf(processorRequest(1));
    for (const margin of [1, 3]) {
      const init = constructivePlacement(net, data, margin);
      const out = annealPlacement(net, data, init, params({ margin, iterations: 6000 }), never);
      expectSoundPlacement(net, out, margin);
      expect(out.cost).toBeLessThanOrEqual(init.cost);
    }
  });

  it('keeps mixed sizes, rotations and several stations collision free (Quantum Chip and a synthetic mix)', async () => {
    const nets = [await netlistOf(quantumRequest()), mixedNetlist()];
    for (const net of nets) {
      const init = constructivePlacement(net, data, 2);
      const out = annealPlacement(net, data, init, params({ iterations: 8000 }), never);
      expectSoundPlacement(net, out, 2);
      expect(out.cost).toBeLessThanOrEqual(init.cost);
      expect(out.cost).toBeLessThan(init.cost);
      // asymmetric buildings do get turned
      const turned = out.buildings.filter((b) => b.yaw !== 0);
      expect(turned.length).toBeGreaterThan(0);
    }
  });

  it('copes with a single stage (nothing to swap), a single machine and no nets', () => {
    for (const count of [1, 2, 7]) {
      const net = synthNetlist([{ building: ASSEMBLER, count }], [PLS], count > 1 ? [{ taps: [1, 2] }] : []);
      const init = constructivePlacement(net, data, 2);
      const out = annealPlacement(net, data, init, params({ iterations: 2000 }), never);
      expectSoundPlacement(net, out, 2);
      expect(out.cost).toBeLessThanOrEqual(init.cost);
    }
  });

  it('refuses an initial placement that already collides, or one missing a machine', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const crowded: Placement = {
      ...init,
      buildings: init.buildings.map((b, i) => (i === 3 ? { ...b, x: init.buildings[2].x, y: init.buildings[2].y } : b)),
    };
    expect(() => annealPlacement(net, data, crowded, params(), never)).toThrow(/collid|overlap/i);
    const short: Placement = { ...init, buildings: init.buildings.slice(0, -1) };
    expect(() => annealPlacement(net, data, short, params(), never)).toThrow(/machine/);
  });

  it('rejects parameters that make no sense', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    for (const bad of [{ margin: -1 }, { iterations: -5 }, { iterations: 2.5 }, { startTemp: 0 }, { startTemp: NaN }]) {
      expect(() => annealPlacement(net, data, init, params(bad), never)).toThrow(RangeError);
    }
  });

  it('is fast: 20k iterations on the Processor netlist well under a second', async () => {
    const net = await netlistOf(processorRequest(1));
    const init = constructivePlacement(net, data, 2);
    const t0 = performance.now();
    annealPlacement(net, data, init, params(), never);
    const ms = performance.now() - t0;
    console.info(`anneal ${net.machines.length} machines, 20k iterations: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });

  it('scales to a few hundred machines (238 machines, 20k iterations) without collisions', async () => {
    const net = await netlistOf(processorRequest(10));
    expect(net.machines.length).toBeGreaterThan(200);
    const init = constructivePlacement(net, data, 2);
    const t0 = performance.now();
    const out = annealPlacement(net, data, init, params({ startTemp: 40 }), never);
    const ms = performance.now() - t0;
    console.info(`anneal ${net.machines.length} machines, 20k iterations: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(10000);
    expectSoundPlacement(net, out, 2);
    expect(out.cost).toBeLessThanOrEqual(init.cost);
  });
});
