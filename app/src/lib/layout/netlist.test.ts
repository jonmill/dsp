import { describe, expect, it } from 'vitest';
import { planProduction } from '../calc';
import type { Flow, ItemRate, PlanRequest, ProductionPlan, Stage, StationSlotDemand } from '../calc';
import { allTechs, computeTechEffects, GameDataIndex } from '../data';
import type { TechEffects } from '../data';
import { beltCapacity, sorterRate } from '../validate/capacity';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { buildNetlist, netCapacity, sortersNeeded } from './netlist';
import type { BeltNet, Netlist } from './netlist';

const parsed = loadFixtureGameData();
const data = new GameDataIndex(parsed);
const everything = allTechs(parsed);
const allEffects = computeTechEffects(parsed, everything);

const ASSEMBLER_MK1 = 2303;
const ASSEMBLER_MK3 = 2305;
const ARC_SMELTER = 2302;
const CHEMICAL_PLANT = 2309;
const REFINERY = 2308;
const MATRIX_LAB = 2901;
const PLS = 2103;
const ILS = 2104;
const BELTS = [2001, 2002, 2003];
const SORTERS = [2011, 2012, 2013, 2014];

const IRON_ORE = 1001;
const COPPER_ORE = 1002;
const SILICON_ORE = 1003;
const IRON_INGOT = 1101;
const GEAR = 1201;
const PROCESSOR = 1303;
const QUANTUM_CHIP = 1305;
const ORES = [IRON_ORE, COPPER_ORE, SILICON_ORE];
const CIRCUIT_BOARD = 1301;
const HYDROGEN = 1120;
const HIGH_PURITY_SILICON = 1105;

/** Every tech, but only the given belt and sorter tiers built (the rest of the buildings stay available). */
function withTiers(belt: number, sorter: number, over: Partial<TechEffects> = {}): TechEffects {
  const kept = [...allEffects.availableBuildings].filter((id) => !BELTS.includes(id) && !SORTERS.includes(id));
  return { ...allEffects, availableBuildings: new Set([...kept, belt, sorter]), ...over };
}
/** A fresh game: Mk.I belts and sorters, no station piler. */
const MK1 = withTiers(2001, 2011, { stationPilerLevel: 1 });

function request(over: Partial<PlanRequest> & Pick<PlanRequest, 'targetItemId'>): PlanRequest {
  return {
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: ASSEMBLER_MK1,
    unlockedTechs: everything,
    suppliedItemIds: new Set(),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
    ...over,
  };
}

/** Processor chain on Mk.I assemblers and Arc Smelters (every recipe pinned: "all techs" would pick the fastest). */
const PROCESSOR_MK1 = {
  51: ASSEMBLER_MK1,
  50: ASSEMBLER_MK1,
  53: ASSEMBLER_MK1,
  1: ARC_SMELTER,
  3: ARC_SMELTER,
  59: ARC_SMELTER,
};
const processorRequest = (over: Partial<PlanRequest> = {}): PlanRequest =>
  request({ targetItemId: PROCESSOR, suppliedItemIds: new Set(ORES), facilityOverrides: PROCESSOR_MK1, ...over });

const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: ASSEMBLER_MK1,
  SMELT: ARC_SMELTER,
  CHEMICAL: CHEMICAL_PLANT,
  REFINE: REFINERY,
  PARTICLE: 2310,
  RESEARCH: MATRIX_LAB,
};
const BASE_TIER_EVERYWHERE: Record<number, number> = Object.fromEntries(
  parsed.recipes.filter((r) => r.type in BASE_TIER_BY_TYPE).map((r) => [r.id, BASE_TIER_BY_TYPE[r.type]] as const),
);
/** 1 Quantum Chip/s on base-tier machines: 19 stages, Hydrogen both imported and made as a by-product. */
const quantumRequest = (over: Partial<PlanRequest> = {}): PlanRequest =>
  request({
    targetItemId: QUANTUM_CHIP,
    suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, HYDROGEN]),
    recipeOverrides: { 1114: 16 },
    facilityOverrides: BASE_TIER_EVERYWHERE,
    ...over,
  });

async function planOf(req: PlanRequest, effects: TechEffects = allEffects): Promise<ProductionPlan> {
  const result = await planProduction(req, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return result.plan;
}

/** A hand-made plan: stages get sensible defaults; the slots follow the imports and exports unless given. */
interface SynthStage {
  machines: number;
  inputs?: ItemRate[];
  outputs?: ItemRate[];
}
function synthPlan(over: {
  stages: SynthStage[];
  flows: Flow[];
  imports?: ItemRate[];
  exports: ItemRate[];
  slots?: StationSlotDemand[];
  stationKind?: 'planetary' | 'interstellar';
  stationsNeeded?: number;
}): ProductionPlan {
  const stages: Stage[] = over.stages.map((s) => ({
    recipeId: 5,
    buildingItemId: ASSEMBLER_MK1,
    machines: s.machines,
    exactMachines: s.machines,
    craftsPerSecond: 1,
    utilization: 1,
    inputs: s.inputs ?? [],
    outputs: s.outputs ?? [],
    perMachineCraftsPerSecond: 1,
    proliferated: false,
    effectiveSpeed: 1,
    workPowerW: 0,
    idlePowerW: 0,
  }));
  const imports = over.imports ?? [];
  const slots: StationSlotDemand[] = over.slots ?? [
    ...imports.map((i) => ({ itemId: i.itemId, role: 'import' as const })),
    ...over.exports.map((e) => ({ itemId: e.itemId, role: 'export' as const })),
  ];
  return {
    request: request({ targetItemId: over.exports[0].itemId, stationKind: over.stationKind ?? 'planetary' }),
    stages,
    flows: over.flows,
    imports,
    exports: over.exports,
    actualTargetRate: over.exports[0].perSecond,
    stationSlots: slots,
    stationsNeeded: over.stationsNeeded ?? Math.max(1, Math.ceil(slots.length / 4)),
    proliferatorPerSecond: 0,
    power: { productionWorkW: 0, productionIdleW: 0, sortersW: 0, coatersW: 0, stationChargeW: 0, steadyW: 0, peakW: 0 },
    warnings: [],
  };
}

/**
 * 5 smelters make 20 Iron Ingot/s from 20 Iron Ore/s (imported, 4/s each); 8 assemblers use all of it
 * (2.5/s each) and make 4 Gear/s, which is exported.
 */
const ingotPlan = (): ProductionPlan =>
  synthPlan({
    stages: [
      { machines: 8, inputs: [{ itemId: IRON_INGOT, perSecond: 20 }], outputs: [{ itemId: GEAR, perSecond: 4 }] },
      { machines: 5, inputs: [{ itemId: IRON_ORE, perSecond: 20 }], outputs: [{ itemId: IRON_INGOT, perSecond: 20 }] },
    ],
    flows: [
      { itemId: IRON_ORE, from: 'import', to: 1, perSecond: 20 },
      { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 20 },
      { itemId: GEAR, from: 0, to: 'export', perSecond: 4 },
    ],
    imports: [{ itemId: IRON_ORE, perSecond: 20 }],
    exports: [{ itemId: GEAR, perSecond: 4 }],
  });

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const netsOf = (nl: Netlist, itemId: number): BeltNet[] => nl.nets.filter((n) => n.itemId === itemId);
const outRate = (net: BeltNet): number => sum(net.taps.filter((t) => t.dir === 'out').map((t) => t.rate));
const inRate = (net: BeltNet): number => sum(net.taps.filter((t) => t.dir === 'in').map((t) => t.rate));
/** `machine/item` of every producer that has `out` taps for one item on more than one net. */
function splitProducers(nl: Netlist): string[] {
  const count = new Map<string, number>();
  for (const net of nl.nets) {
    for (const t of net.taps) if (t.dir === 'out') count.set(`${t.machineId}/${t.itemId}`, (count.get(`${t.machineId}/${t.itemId}`) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1).map(([key]) => key);
}
const stationNets = (nl: Netlist): BeltNet[] => nl.nets.filter((n) => n.source.kind === 'station' || n.sink.kind === 'station');

/** Everything every netlist must satisfy, whatever the plan. */
function expectSound(nl: Netlist, plan: ProductionPlan, effects: TechEffects, maxTaps = 12): void {
  // machines: one per plan machine, ids 1..n in stage order, rates = stage totals / machines
  expect(nl.machines.map((m) => m.id)).toEqual(nl.machines.map((_, i) => i + 1));
  expect(nl.machines.length).toBe(plan.stages.reduce((n, s) => n + s.machines, 0));
  expect(nl.machines.map((m) => m.stageIndex)).toEqual(
    plan.stages.flatMap((s, i) => Array.from({ length: s.machines }, () => i)),
  );

  const ids = nl.nets.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const net of nl.nets) {
    const stationSourced = net.source.kind === 'station';
    // capacity, tap count, balance
    expect(net.tierItemId).toBe(nl.beltTierItemId);
    expect(net.rate).toBeLessThanOrEqual(netCapacity(net.tierItemId, stationSourced, effects, data) * (1 + 1e-9));
    // the tap limit gives way to keeping a producer whole, and the netlist says which net it let grow
    if (net.taps.length > maxTaps) expect(nl.warnings.some((w) => w.startsWith(`net ${net.id} (`) && /taps/.test(w))).toBe(true);
    expect(net.taps.length).toBeGreaterThan(0);
    for (const t of net.taps) {
      expect(t.itemId).toBe(net.itemId);
      expect(t.rate).toBeGreaterThan(0);
      expect(t.sorters).toBeGreaterThanOrEqual(1);
    }
    if (stationSourced) {
      expect(net.taps.every((t) => t.dir === 'in')).toBe(true);
      expect(inRate(net)).toBeCloseTo(net.rate, 7);
    } else {
      expect(net.rate).toBeCloseTo(outRate(net), 7);
      expect(outRate(net) + 1e-7).toBeGreaterThanOrEqual(inRate(net));
      if (net.sink.kind === 'deadEnd') expect(outRate(net)).toBeCloseTo(inRate(net), 7);
      else expect(outRate(net)).toBeGreaterThan(inRate(net) + 1e-9); // the rest goes to the station
    }
  }

  // a producer machine puts an item on one net, unless it alone makes more than a belt carries (then a warning names it)
  const outs = new Map<string, { nets: number; rate: number }>();
  for (const net of nl.nets) {
    for (const t of net.taps) {
      if (t.dir !== 'out') continue;
      const key = `${t.machineId}/${t.itemId}`;
      const entry = outs.get(key) ?? { nets: 0, rate: 0 };
      outs.set(key, { nets: entry.nets + 1, rate: entry.rate + t.rate });
    }
  }
  for (const [key, { nets, rate }] of outs) {
    if (nets < 2) continue;
    const [machineId] = key.split('/').map(Number);
    expect(rate, `machine ${key} is split over ${nets} nets`).toBeGreaterThan(
      netCapacity(nl.beltTierItemId, false, effects, data),
    );
    expect(nl.warnings.some((w) => w.startsWith(`machine ${machineId} (`))).toBe(true);
  }
  // an item the station supplies is not also tapped off a belt that producers feed
  const supplied = new Set(nl.nets.filter((n) => n.source.kind === 'station').map((n) => n.itemId));
  for (const net of nl.nets) {
    if (!supplied.has(net.itemId) || net.source.kind !== 'taps') continue;
    expect(net.taps.every((t) => t.dir === 'out'), `net ${net.id} of item ${net.itemId}`).toBe(true);
    expect(net.sink.kind).toBe('station');
  }

  // every machine gets and gives exactly what its stage says, across all its taps
  const allTaps = nl.nets.flatMap((n) => n.taps);
  const tapRate = (machineId: number, itemId: number, dir: 'in' | 'out'): number =>
    sum(allTaps.filter((t) => t.machineId === machineId && t.itemId === itemId && t.dir === dir).map((t) => t.rate));
  for (const m of nl.machines) {
    for (const input of m.inputs) expect(tapRate(m.id, input.itemId, 'in')).toBeCloseTo(input.perSecond, 7);
    for (const output of m.outputs) expect(tapRate(m.id, output.itemId, 'out')).toBeCloseTo(output.perSecond, 7);
  }

  // stations: slot and port limits, every station net lands on a station that has its item
  for (const st of nl.stations) {
    const building = data.building(st.buildingItemId)?.station;
    expect(st.slots.length).toBeLessThanOrEqual(building?.maxItemKinds ?? 0);
    expect(st.portsNeeded).toBeLessThanOrEqual(12);
  }
  const portsByStation = nl.stations.map(() => 0);
  for (const net of stationNets(nl)) {
    const end = net.source.kind === 'station' ? net.source : net.sink;
    if (end.kind !== 'station') throw new Error('unreachable');
    expect(end.stationIdx).toBeGreaterThanOrEqual(0);
    expect(nl.stations[end.stationIdx].slots.some((s) => s.itemId === net.itemId)).toBe(true);
    portsByStation[end.stationIdx]++;
  }
  expect(nl.stations.map((s) => s.portsNeeded)).toEqual(portsByStation);
  expect(nl.stations.length).toBeGreaterThanOrEqual(plan.stationsNeeded);
  // every slot of the plan exists in some station
  const placed = new Set(nl.stations.flatMap((s) => s.slots.map((x) => x.itemId)));
  for (const slot of plan.stationSlots) expect(placed.has(slot.itemId)).toBe(true);
}

describe('buildNetlist: Processor chain on Mk.I', () => {
  it('has 25 machines, ids 1..25 in stage order, rates = stage totals / machines', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    expect(plan.stages.map((s) => s.machines)).toEqual([4, 2, 6, 2, 3, 8]);
    expect(nl.machines).toHaveLength(25);
    expect(nl.machines[0]).toMatchObject({ id: 1, stageIndex: 0, recipeId: 51, buildingItemId: ASSEMBLER_MK1 });
    expect(nl.machines[24]).toMatchObject({ id: 25, stageIndex: 5, recipeId: 59, buildingItemId: ARC_SMELTER });
    // stage 0: 4 Processor assemblers share 1 Processor/s
    for (const m of nl.machines.slice(0, 4)) {
      expect(m.outputs).toEqual([{ itemId: PROCESSOR, perSecond: expect.closeTo(0.25, 9) }]);
      expect(m.inputs).toEqual(
        plan.stages[0].inputs.map((x) => ({ itemId: x.itemId, perSecond: expect.closeTo(x.perSecond / 4, 9) })),
      );
    }
    expectSound(nl, plan, MK1);
  });

  it('puts the ore imports on station-sourced dead-end nets; the 2/s iron ore net is one net', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    expect(nl.beltTierItemId).toBe(2001);
    expect(nl.sorterTierItemId).toBe(2011);
    const iron = netsOf(nl, IRON_ORE);
    expect(iron).toHaveLength(1);
    expect(iron[0].rate).toBeCloseTo(2, 9);
    expect(iron[0].tierItemId).toBe(2001);
    for (const ore of ORES) {
      for (const net of netsOf(nl, ore)) {
        expect(net.source.kind).toBe('station');
        expect(net.sink.kind).toBe('deadEnd');
        expect(net.taps.every((t) => t.dir === 'in')).toBe(true);
      }
    }
    // 2 Arc Smelters take 1/s each: one Mk.I sorter (1.5/s) per tap
    expect(iron[0].taps).toHaveLength(2);
    expect(iron[0].taps.every((t) => t.sorters === 1)).toBe(true);
  });

  it('feeds Circuit Boards from 2 producer machines to 4 Processor machines on a dead-end net', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    const boards = netsOf(nl, CIRCUIT_BOARD);
    expect(boards).toHaveLength(1);
    const [net] = boards;
    expect(net.source).toEqual({ kind: 'taps' });
    expect(net.sink).toEqual({ kind: 'deadEnd' });
    const producers = net.taps.filter((t) => t.dir === 'out');
    const consumers = net.taps.filter((t) => t.dir === 'in');
    expect(producers.map((t) => nl.machines[t.machineId - 1].stageIndex)).toEqual([1, 1]);
    expect(consumers.map((t) => t.machineId)).toEqual([1, 2, 3, 4]);
    expect(net.rate).toBeCloseTo(2, 9);
    expect(producers.every((t) => t.rate === net.rate / 2)).toBe(true);
    // producers come first along the belt
    expect(net.taps.map((t) => t.dir)).toEqual(['out', 'out', 'in', 'in', 'in', 'in']);
  });

  it('ends the Processor export on a station sink, fed by the 4 Processor assemblers', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    const exportNets = netsOf(nl, PROCESSOR);
    expect(exportNets).toHaveLength(1);
    expect(exportNets[0].source).toEqual({ kind: 'taps' });
    expect(exportNets[0].sink).toEqual({ kind: 'station', stationIdx: 0 });
    expect(exportNets[0].taps.map((t) => [t.machineId, t.dir])).toEqual([1, 2, 3, 4].map((id) => [id, 'out']));
    expect(exportNets[0].rate).toBeCloseTo(1, 9);
  });

  it('splits a net whose taps exceed maxMachinesPerNet, here the 14-tap silicon net', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    const silicon = netsOf(nl, HIGH_PURITY_SILICON); // 8 smelters feed 6 assemblers
    expect(silicon).toHaveLength(2);
    expect(nl.warnings).toEqual([]);
    expectSound(nl, plan, MK1);
    // a limit of 4: where no cut keeps the producers whole within it, a net grows past it and the netlist warns
    const tight = buildNetlist(plan, data, MK1, { maxMachinesPerNet: 4 });
    expectSound(tight, plan, MK1, 4);
    expect(tight.nets.length).toBeGreaterThan(nl.nets.length);
    const over = tight.nets.filter((n) => n.taps.length > 4);
    expect(over.length).toBeGreaterThan(0);
    for (const net of over) expect(tight.warnings.filter((w) => w.startsWith(`net ${net.id} (`))).toHaveLength(1);
    expect(tight.warnings).toHaveLength(over.length);
  });

  it('is deterministic and does not change the plan', async () => {
    const plan = await planOf(processorRequest());
    const before = JSON.stringify(plan);
    const a = buildNetlist(plan, data, MK1);
    const b = buildNetlist(plan, data, MK1);
    expect(b).toEqual(a);
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('buildNetlist: tiers', () => {
  it('uses the best available belt and sorter, the pile sorter included', async () => {
    const plan = await planOf(processorRequest());
    const best = buildNetlist(plan, data, allEffects);
    expect([best.beltTierItemId, best.sorterTierItemId]).toEqual([2003, 2014]);
    const mk2 = buildNetlist(plan, data, withTiers(2002, 2012));
    expect([mk2.beltTierItemId, mk2.sorterTierItemId]).toEqual([2002, 2012]);
    expect(new Set(mk2.nets.map((n) => n.tierItemId))).toEqual(new Set([2002]));
    // no pile sorter: Mk.III wins over Mk.II
    expect(buildNetlist(plan, data, withTiers(2003, 2013)).sorterTierItemId).toBe(2013);
  });

  it('falls back to Mk.I with a warning when no belt or sorter is unlocked', async () => {
    const plan = await planOf(processorRequest());
    const none = computeTechEffects(parsed, new Set());
    expect(none.availableBuildings.has(2001)).toBe(false);
    const nl = buildNetlist(plan, data, none);
    expect([nl.beltTierItemId, nl.sorterTierItemId]).toEqual([2001, 2011]);
    expect(nl.warnings.some((w) => /belt/i.test(w))).toBe(true);
    expect(nl.warnings.some((w) => /sorter/i.test(w))).toBe(true);
  });

  it('counts sorters per tap with the stack the tap picks from, and one item per trip from a building', () => {
    // 4/s at Mk.I (1.5/s per sorter at stack 1)
    expect(sortersNeeded(4, 2011, 1, 1, MK1, data)).toBe(3);
    expect(sortersNeeded(4, 2011, 1, 4, { ...MK1, stationPilerLevel: 4 }, data)).toBe(1);
    expect(sortersNeeded(4, 2013, 1, 0, MK1, data)).toBe(1); // 6/s from a building
    expect(sortersNeeded(1.5, 2011, 1, 1, MK1, data)).toBe(1); // exact fit, no float round-up
    expect(sortersNeeded(1.5000001, 2011, 1, 1, MK1, data)).toBe(2);
    expect(sortersNeeded(4, 2011, 2, 1, MK1, data)).toBe(Math.ceil(4 / sorterRate(2011, 2, 1, MK1, data)));
  });
});

describe('buildNetlist: splitting by rate', () => {
  it('splits a taps-sourced 20/s net on Mk.I (5.7/s) into 5 at producer boundaries, each with supply >= demand', () => {
    const plan = ingotPlan();
    const nl = buildNetlist(plan, data, MK1);
    const ingots = netsOf(nl, IRON_INGOT);
    expect(netCapacity(2001, false, MK1, data)).toBeCloseTo(0.95 * beltCapacity(2001, 1, data), 12);
    // Producers (4/s) and consumers (2.5/s) only meet at 20/s, past one belt, so there is no cut that splits neither:
    // every producer stays whole on its own net and the consumers a cut falls inside get a tap on both sides.
    expect(ingots).toHaveLength(5);
    for (const net of ingots) {
      expect(net.source).toEqual({ kind: 'taps' });
      expect(net.sink).toEqual({ kind: 'deadEnd' });
      expect(net.rate).toBeLessThanOrEqual(0.95 * 6 + 1e-9);
      expect(net.taps.filter((t) => t.dir === 'out')).toHaveLength(1);
      expect(outRate(net)).toBeCloseTo(4, 9);
      expect(outRate(net) + 1e-9).toBeGreaterThanOrEqual(inRate(net));
      expect(inRate(net)).toBeCloseTo(4, 9);
    }
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'out').map((t) => t.machineId))).toEqual([
      [9],
      [10],
      [11],
      [12],
      [13],
    ]);
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'in').map((t) => [t.machineId, +t.rate.toFixed(9)]))).toEqual([
      [[1, 2.5], [2, 1.5]],
      [[2, 1], [3, 2.5], [4, 0.5]],
      [[4, 2], [5, 2]],
      [[5, 0.5], [6, 2.5], [7, 1]],
      [[7, 1.5], [8, 2.5]],
    ]);
    expect(nl.warnings).toEqual([]);
    expectSound(nl, plan, MK1);
  });

  it('cuts where a producer end and a consumer end coincide, not at the later consumer end the belt could carry', () => {
    // 2 producers of 4/s and 8 consumers of 1/s: a belt (5.7/s) could end at the consumer end 5, which would split the
    // second producer; the cut goes to 4, where the first producer ends too
    const plan = synthPlan({
      stages: [
        { machines: 8, inputs: [{ itemId: IRON_INGOT, perSecond: 8 }], outputs: [{ itemId: GEAR, perSecond: 1 }] },
        { machines: 2, inputs: [], outputs: [{ itemId: IRON_INGOT, perSecond: 8 }] },
      ],
      flows: [
        { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 8 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }],
    });
    const nl = buildNetlist(plan, data, MK1);
    const ingots = netsOf(nl, IRON_INGOT);
    expect(ingots).toHaveLength(2);
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'out').map((t) => t.machineId))).toEqual([[9], [10]]);
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'in').map((t) => t.machineId))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(splitProducers(nl)).toEqual([]);
    expect(nl.warnings).toEqual([]);
    expectSound(nl, plan, MK1);
  });

  it('splits no producer in Processor x6, on the best belts and on Mk.II belts', async () => {
    const plan = await planOf(
      processorRequest({
        quantity: { kind: 'rate', perSecond: 6 },
        finalFacilityItemId: ASSEMBLER_MK3,
        facilityOverrides: { ...PROCESSOR_MK1, 51: ASSEMBLER_MK3, 50: ASSEMBLER_MK3, 53: ASSEMBLER_MK3 },
      }),
    );
    expect(plan.stages.reduce((n, st) => n + st.machines, 0)).toBeGreaterThan(100);
    for (const effects of [allEffects, withTiers(2002, 2012)]) {
      const nl = buildNetlist(plan, data, effects);
      expect(splitProducers(nl)).toEqual([]);
      expect(nl.warnings).toEqual([]);
      expectSound(nl, plan, effects);
    }
  });

  it('keeps a producer whole on a net over the tap limit when no cut fits, and warns about the net', () => {
    // one producer of 4/s, four consumers of 1/s, at most 3 taps: the only cut that splits neither is the end, 5 taps
    const plan = synthPlan({
      stages: [
        { machines: 4, inputs: [{ itemId: IRON_INGOT, perSecond: 4 }], outputs: [{ itemId: GEAR, perSecond: 1 }] },
        { machines: 1, inputs: [], outputs: [{ itemId: IRON_INGOT, perSecond: 4 }] },
      ],
      flows: [
        { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 4 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }],
    });
    const nl = buildNetlist(plan, data, MK1, { maxMachinesPerNet: 3 });
    const ingots = netsOf(nl, IRON_INGOT);
    expect(ingots).toHaveLength(1);
    expect(ingots[0].taps).toHaveLength(5);
    expect(ingots[0].taps[0]).toMatchObject({ machineId: 5, dir: 'out', rate: expect.closeTo(4, 9) });
    expect(splitProducers(nl)).toEqual([]);
    expect(nl.warnings).toHaveLength(1);
    expect(nl.warnings[0]).toMatch(new RegExp(`^net ${ingots[0].id} \\(Iron Ingot\\) has 5 taps.*3`));
    expectSound(nl, plan, MK1, 3);
    // with room for 5 taps nothing is over the limit
    expect(buildNetlist(plan, data, MK1, { maxMachinesPerNet: 5 }).warnings).toEqual([]);
  });

  it('splits a producer that alone makes more than a belt carries, and warns naming the machine', () => {
    const plan = synthPlan({
      stages: [
        { machines: 2, inputs: [{ itemId: IRON_INGOT, perSecond: 10 }], outputs: [{ itemId: GEAR, perSecond: 1 }] },
        { machines: 1, inputs: [], outputs: [{ itemId: IRON_INGOT, perSecond: 10 }] },
      ],
      flows: [
        { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 10 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }],
    });
    const nl = buildNetlist(plan, data, MK1);
    const ingots = netsOf(nl, IRON_INGOT);
    expect(ingots).toHaveLength(2);
    expect(splitProducers(nl)).toEqual(['3/1101']);
    expect(sum(ingots.flatMap((n) => n.taps.filter((t) => t.machineId === 3).map((t) => t.rate)))).toBeCloseTo(10, 9);
    // the consumers (5/s each) stay whole
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'in').map((t) => t.machineId))).toEqual([[1], [2]]);
    const warning = nl.warnings.filter((w) => /machine 3 /.test(w));
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatch(/machine 3 \(Assembling Machine Mk\.I\) makes 10 Iron Ingot\/s, more than one belt carries \(5\.7\/s\)/);
    expectSound(nl, plan, MK1);
  });

  it('keeps a station-sourced 20/s import on one net at stationPilerLevel 4 (0.95 x 24)', () => {
    const plan = ingotPlan();
    const piled = { ...MK1, stationPilerLevel: 4 };
    const nl = buildNetlist(plan, data, piled);
    const ore = netsOf(nl, IRON_ORE);
    expect(ore).toHaveLength(1);
    expect(ore[0].rate).toBeCloseTo(20, 9);
    expect(netCapacity(2001, true, piled, data)).toBeCloseTo(0.95 * 24, 9);
    // at stack 4 a Mk.I sorter takes 6/s from the belt, so a 4/s tap needs one
    expect(ore[0].taps.every((t) => t.sorters === 1)).toBe(true);
    expectSound(nl, plan, piled);
    // without the piler it splits, and each 4/s tap needs 3 sorters at 1.5/s
    const plain = buildNetlist(plan, data, MK1);
    expect(netsOf(plain, IRON_ORE)).toHaveLength(5);
    expect(netsOf(plain, IRON_ORE)[0].taps[0].sorters).toBe(3);
  });

  it('splits an over-capacity export into several nets, each with its own station port', () => {
    const plan = synthPlan({
      stages: [{ machines: 5, inputs: [], outputs: [{ itemId: GEAR, perSecond: 12 }] }],
      flows: [{ itemId: GEAR, from: 0, to: 'export', perSecond: 12 }],
      exports: [{ itemId: GEAR, perSecond: 12 }],
    });
    const nl = buildNetlist(plan, data, MK1);
    const gears = netsOf(nl, GEAR);
    expect(gears).toHaveLength(3); // 12 / 5.7
    expect(gears.every((n) => n.sink.kind === 'station' && n.source.kind === 'taps')).toBe(true);
    expect(sum(gears.map((n) => n.rate))).toBeCloseTo(12, 9);
    expect(nl.stations[0].portsNeeded).toBe(3);
    expectSound(nl, plan, MK1);
  });

  it('ends a net on the station when the item is consumed and also exported', () => {
    const plan = synthPlan({
      stages: [
        { machines: 2, inputs: [{ itemId: IRON_INGOT, perSecond: 2 }], outputs: [{ itemId: GEAR, perSecond: 1 }] },
        { machines: 2, inputs: [], outputs: [{ itemId: IRON_INGOT, perSecond: 3 }] },
      ],
      flows: [
        { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 2 },
        { itemId: IRON_INGOT, from: 1, to: 'export', perSecond: 1 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }, { itemId: IRON_INGOT, perSecond: 1 }],
    });
    const nl = buildNetlist(plan, data, MK1);
    const ingots = netsOf(nl, IRON_INGOT);
    expect(ingots).toHaveLength(1);
    expect(ingots[0].sink).toEqual({ kind: 'station', stationIdx: 0 });
    expect(ingots[0].rate).toBeCloseTo(3, 9);
    expect(inRate(ingots[0])).toBeCloseTo(2, 9);
    expectSound(nl, plan, MK1);
  });

  it('splits one machine tap that is bigger than a belt across nets, and warns about its sorters', () => {
    const plan = synthPlan({
      stages: [
        { machines: 1, inputs: [{ itemId: IRON_INGOT, perSecond: 10 }], outputs: [{ itemId: GEAR, perSecond: 1 }] },
        { machines: 2, inputs: [], outputs: [{ itemId: IRON_INGOT, perSecond: 10 }] },
      ],
      flows: [
        { itemId: IRON_INGOT, from: 1, to: 0, perSecond: 10 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }],
    });
    const nl = buildNetlist(plan, data, MK1);
    const ingots = netsOf(nl, IRON_INGOT);
    // the two 5/s producers each fit a belt, so each stays whole on its own net, and the consumer is split between them
    expect(ingots).toHaveLength(2);
    expect(ingots.map((n) => n.taps.filter((t) => t.dir === 'out').map((t) => t.machineId))).toEqual([[2], [3]]);
    const taps = ingots.flatMap((n) => n.taps.filter((t) => t.dir === 'in'));
    expect(taps.map((t) => t.machineId)).toEqual([1, 1]);
    expect(sum(taps.map((t) => t.rate))).toBeCloseTo(10, 9);
    // 5/s through Mk.I sorters (1.5/s) is 4 sorters, over the limit of 3
    expect(taps.map((t) => t.sorters)).toEqual([4, 4]);
    expect(nl.warnings.filter((w) => /sorter/i.test(w))).toHaveLength(2); // one per net
    expect(nl.warnings.join('\n')).toMatch(/Iron Ingot/);
    expectSound(nl, plan, MK1);
  });

  it('raises no sorter warning when every tap needs 3 or fewer', () => {
    const nl = buildNetlist(ingotPlan(), data, MK1);
    expect(nl.warnings.filter((w) => /sorter/i.test(w))).toEqual([]);
  });

  it('rejects a maxMachinesPerNet below 2', () => {
    expect(() => buildNetlist(ingotPlan(), data, MK1, { maxMachinesPerNet: 1 })).toThrow(/maxMachinesPerNet/);
    expect(() => buildNetlist(ingotPlan(), data, MK1, { maxMachinesPerNet: 3.5 })).toThrow(/maxMachinesPerNet/);
  });

  it('rejects a flow that goes straight from import to export', () => {
    const plan = synthPlan({
      stages: [{ machines: 1, outputs: [{ itemId: GEAR, perSecond: 1 }] }],
      flows: [
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
        { itemId: IRON_ORE, from: 'import', to: 'export', perSecond: 1 },
      ],
      exports: [{ itemId: GEAR, perSecond: 1 }],
    });
    expect(() => buildNetlist(plan, data, MK1)).toThrow(/import to export/);
  });
});

describe('buildNetlist: stations', () => {
  it('lays out the Processor stations on a PLS: target slot first, then ores by rate, logic 2/0 and 1/0', async () => {
    const plan = await planOf(processorRequest());
    const nl = buildNetlist(plan, data, MK1);
    expect(nl.stations).toHaveLength(1);
    const [st] = nl.stations;
    // one port each, except the 8/s Silicon Ore, which Mk.I belts (5.7/s) carry on two
    expect(st).toMatchObject({ kind: 'planetary', buildingItemId: PLS, portsNeeded: 5 });
    expect(st.slots).toEqual([
      { itemId: PROCESSOR, localLogic: 1, remoteLogic: 0, max: 5000 },
      { itemId: SILICON_ORE, localLogic: 2, remoteLogic: 0, max: 5000 },
      { itemId: COPPER_ORE, localLogic: 2, remoteLogic: 0, max: 5000 },
      { itemId: IRON_ORE, localLogic: 2, remoteLogic: 0, max: 5000 },
    ]);
  });

  it('configures an ILS with remote logic: imports {2,2}, export {1,1}, max 10000', async () => {
    const plan = await planOf(processorRequest({ stationKind: 'interstellar' }));
    const nl = buildNetlist(plan, data, MK1);
    expect(nl.stations).toHaveLength(1);
    expect(nl.stations[0]).toMatchObject({ kind: 'interstellar', buildingItemId: ILS });
    const bySlot = new Map(nl.stations[0].slots.map((s) => [s.itemId, s]));
    for (const ore of ORES) expect(bySlot.get(ore)).toEqual({ itemId: ore, localLogic: 2, remoteLogic: 2, max: 10000 });
    expect(bySlot.get(PROCESSOR)).toEqual({ itemId: PROCESSOR, localLogic: 1, remoteLogic: 1, max: 10000 });
    expectSound(nl, plan, MK1);
  });

  it('orders slots: target, imports by rate, proliferator, by-products; the proliferator gets a slot but no net', () => {
    const MK1_SPRAY = 1141;
    const BYPRODUCT = 1120;
    const plan = synthPlan({
      stages: [
        {
          machines: 2,
          inputs: [
            { itemId: IRON_ORE, perSecond: 1 },
            { itemId: COPPER_ORE, perSecond: 3 },
          ],
          outputs: [
            { itemId: GEAR, perSecond: 1 },
            { itemId: BYPRODUCT, perSecond: 2 },
          ],
        },
      ],
      flows: [
        { itemId: IRON_ORE, from: 'import', to: 0, perSecond: 1 },
        { itemId: COPPER_ORE, from: 'import', to: 0, perSecond: 3 },
        { itemId: GEAR, from: 0, to: 'export', perSecond: 1 },
        { itemId: BYPRODUCT, from: 0, to: 'export', perSecond: 2 },
      ],
      imports: [
        { itemId: IRON_ORE, perSecond: 1 },
        { itemId: COPPER_ORE, perSecond: 3 },
        { itemId: MK1_SPRAY, perSecond: 0.1 },
      ],
      exports: [
        { itemId: GEAR, perSecond: 1 },
        { itemId: BYPRODUCT, perSecond: 2 },
      ],
      // the plan lists imports, spray, exports; the netlist reorders
      slots: [
        { itemId: IRON_ORE, role: 'import' },
        { itemId: COPPER_ORE, role: 'import' },
        { itemId: MK1_SPRAY, role: 'proliferator' },
        { itemId: BYPRODUCT, role: 'export' },
        { itemId: GEAR, role: 'export' },
      ],
    });
    const nl = buildNetlist(plan, data, MK1);
    expect(nl.stations).toHaveLength(2); // 5 slots, 4 per PLS
    expect(nl.stations.flatMap((s) => s.slots.map((x) => x.itemId))).toEqual([
      GEAR,
      COPPER_ORE,
      IRON_ORE,
      MK1_SPRAY,
      BYPRODUCT,
    ]);
    const spray = nl.stations.flatMap((s) => s.slots).find((s) => s.itemId === MK1_SPRAY);
    expect(spray).toEqual({ itemId: MK1_SPRAY, localLogic: 2, remoteLogic: 0, max: 5000 });
    expect(netsOf(nl, MK1_SPRAY)).toEqual([]);
    expectSound(nl, plan, MK1);
  });

  it('starts a new station when ports would exceed 12, and warns that the plan under-predicted', async () => {
    // 3 Quantum Chips/s: the raw imports need dozens of 5.7/s Mk.I belts, far more than 3 stations have ports for
    const plan = await planOf(quantumRequest({ quantity: { kind: 'rate', perSecond: 3 } }));
    expect(plan.stationSlots).toHaveLength(10);
    expect(plan.stationsNeeded).toBe(3);
    const nl = buildNetlist(plan, data, MK1);
    expectSound(nl, plan, MK1);
    expect(stationNets(nl).length).toBeGreaterThan(12 * plan.stationsNeeded);
    expect(nl.stations.length).toBeGreaterThan(plan.stationsNeeded);
    expect(nl.warnings.some((w) => /stations/.test(w) && new RegExp(`${nl.stations.length}`).test(w))).toBe(true);
  });

  it('Quantum Chip with PLS on the best belts: at least the planned stations, at most 4 slots and 12 ports each', async () => {
    const plan = await planOf(quantumRequest());
    const nl = buildNetlist(plan, data, allEffects);
    expectSound(nl, plan, allEffects);
    expect(nl.stations.length).toBeGreaterThanOrEqual(plan.stationsNeeded);
    for (const st of nl.stations) {
      expect(st.slots.length).toBeLessThanOrEqual(4);
      expect(st.portsNeeded).toBeLessThanOrEqual(12);
    }
    expect(plan.stages).toHaveLength(19);
    expect(nl.machines.length).toBeGreaterThan(200);
  });

  it('Hydrogen that is both imported and made: all consumers on station-sourced nets, all producers on a station-sink net', async () => {
    const plan = await planOf(quantumRequest());
    const nl = buildNetlist(plan, data, allEffects);
    const hydrogen = netsOf(nl, HYDROGEN);
    const imported = hydrogen.filter((n) => n.source.kind === 'station');
    const made = hydrogen.filter((n) => n.source.kind === 'taps');
    expect(imported.length).toBeGreaterThan(0);
    expect(made.length).toBeGreaterThan(0);
    // 17.5/s is imported and 6.5/s made, but the consumers take all 24/s from the station, which the refineries refill
    expect(sum(imported.map((n) => n.rate))).toBeCloseTo(24, 7);
    expect(sum(made.map((n) => n.rate))).toBeCloseTo(6.5, 7);
    expect(sum(imported.map(inRate))).toBeCloseTo(sum(plan.stages.map((st) => st.inputs.find((i) => i.itemId === HYDROGEN)?.perSecond ?? 0)), 7);
    for (const net of imported) {
      expect(net.taps.every((t) => t.dir === 'in')).toBe(true);
      expect(net.sink).toEqual({ kind: 'deadEnd' });
    }
    for (const net of made) {
      expect(net.taps.every((t) => t.dir === 'out')).toBe(true);
      expect(net.sink.kind).toBe('station');
    }
    expectSound(nl, plan, allEffects);
  });

  it('Hydrogen: no net has both producer and consumer taps; producers end at the station; the slot stays one import slot', async () => {
    const plan = await planOf(quantumRequest());
    const nl = buildNetlist(plan, data, allEffects);
    const hydrogen = netsOf(nl, HYDROGEN);
    expect(hydrogen.filter((n) => n.taps.some((t) => t.dir === 'out') && n.taps.some((t) => t.dir === 'in'))).toEqual([]);
    const producerNets = hydrogen.filter((n) => n.taps.some((t) => t.dir === 'out'));
    expect(producerNets.length).toBeGreaterThan(0);
    for (const net of producerNets) {
      if (net.sink.kind !== 'station') throw new Error(`net ${net.id} of Hydrogen producers does not end at a station`);
      const slots = nl.stations[net.sink.stationIdx].slots.filter((s) => s.itemId === HYDROGEN);
      expect(slots).toEqual([{ itemId: HYDROGEN, localLogic: 2, remoteLogic: 0, max: 5000 }]);
    }
    // every station that holds Hydrogen holds it once, as an import (demand logic 2)
    for (const st of nl.stations) {
      const slots = st.slots.filter((s) => s.itemId === HYDROGEN);
      expect(slots.length).toBeLessThanOrEqual(1);
      for (const slot of slots) expect(slot.localLogic).toBe(2);
    }
    // the refineries (stage 12 in the Quantum plan) put nothing on a belt a consumer taps
    const refineries = new Set(nl.machines.filter((m) => m.outputs.some((o) => o.itemId === HYDROGEN)).map((m) => m.id));
    expect(refineries.size).toBeGreaterThan(0);
    for (const net of hydrogen) {
      for (const t of net.taps) expect(refineries.has(t.machineId)).toBe(t.dir === 'out');
    }
  });

  it('Hydrogen: the import belts carry the consumers\' full demand, sized by the station stack', async () => {
    const plan = await planOf(quantumRequest());
    const demand = sum(plan.stages.map((st) => st.inputs.find((i) => i.itemId === HYDROGEN)?.perSecond ?? 0));
    expect(demand).toBeCloseTo(24, 7); // imports 17.5 + by-product 6.5
    for (const [stack, nets] of [[1, 3], [4, 1]] as const) {
      const effects = withTiers(2002, 2012, { stationPilerLevel: stack });
      const nl = buildNetlist(plan, data, effects);
      const imported = netsOf(nl, HYDROGEN).filter((n) => n.source.kind === 'station');
      const capacity = netCapacity(2002, true, effects, data);
      expect(capacity).toBeCloseTo(0.95 * beltCapacity(2002, stack, data), 9);
      expect(imported).toHaveLength(nets);
      expect(imported).toHaveLength(Math.ceil(demand / capacity - 1e-9));
      expect(sum(imported.map((n) => n.rate))).toBeCloseTo(demand, 7);
      expectSound(nl, plan, effects);
    }
  });

  it('pads to the stations the plan asked for', () => {
    const plan = { ...ingotPlan(), stationsNeeded: 3 };
    const nl = buildNetlist(plan, data, MK1);
    expect(nl.stations).toHaveLength(3);
    expect(nl.stations.slice(1).every((s) => s.slots.length === 0 && s.portsNeeded === 0)).toBe(true);
    expect(nl.warnings.filter((w) => /stations/.test(w))).toEqual([]);
  });

  it('puts an item with more nets than one station has ports on several stations', () => {
    // 5 gear producers at 12/s with maxMachinesPerNet 2 -> many export nets, all the same item
    const plan = synthPlan({
      stages: [{ machines: 30, outputs: [{ itemId: GEAR, perSecond: 30 }] }],
      flows: [{ itemId: GEAR, from: 0, to: 'export', perSecond: 30 }],
      exports: [{ itemId: GEAR, perSecond: 30 }],
    });
    const nl = buildNetlist(plan, data, allEffects, { maxMachinesPerNet: 2 });
    expect(netsOf(nl, GEAR).length).toBeGreaterThan(12);
    expect(nl.stations.length).toBeGreaterThanOrEqual(2);
    for (const st of nl.stations) expect(st.slots.map((s) => s.itemId)).toEqual([GEAR]);
    expectSound(nl, plan, allEffects, 2);
  });

  it('fails loudly when a net touches an item the plan gave no slot, or the slot role disagrees', () => {
    const base = ingotPlan();
    expect(() => buildNetlist({ ...base, stationSlots: [{ itemId: GEAR, role: 'export' }] }, data, MK1)).toThrow(
      /no station slot.*1001/,
    );
    expect(() =>
      buildNetlist(
        {
          ...base,
          stationSlots: [
            { itemId: IRON_ORE, role: 'export' },
            { itemId: GEAR, role: 'export' },
          ],
        },
        data,
        MK1,
      ),
    ).toThrow(/Iron Ore.*import/);
  });
});
