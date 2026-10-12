// Task 29 acceptance: several logistics stations and by-product exports, end to end. A station holds `maxItemKinds` items (4 on a
// Planetary Logistics Station, 5 on an Interstellar one) and has 12 belt ports; a plan with more items than that, or more nets
// than ports, gets several stations, and the layout has to place them, give each its own config (its slots, a port for every
// belt end on it, the slot of the port's item) and pass the full validator with the tick simulation. A by-product that nothing
// consumes (Hydrogen from Plasma Refining) has to end at a station input port, or its refineries block (Review Focus #3, #4).
//
// What the tests below check:
//  - Quantum Chip from Processors and what a Plane Filter is made of (6 items, so 2 stations on a PLS, 2 on an ILS), plain and with
//    Mk.III proliferator (7 items: exactly one station holds the proliferator's slot and the feed's port);
//  - Plasma Refining for Refined Oil: Hydrogen is exported to a station input port and nothing stalls; with that port taken
//    away the same layout stalls (SIM_STALLED), so the export is what keeps the refineries running;
//  - Plastic made from Refined Oil by Plasma Refining, with Mk.III proliferator: 2 stations, the by-product on the second;
//  - Casimir Crystal at 4/s with at most 2 taps per net (72 nets, 80 machines): 7 stations, Hydrogen (imported and made) on two
//    of them, each of which gives out what it takes in;
//  - Quantum Chip from the raw resources: 3 stations, Hydrogen imported and made.
// Every plan is sized with the planner's default machine headroom, as the user gets it. Slow: it logs the numbers the report
// quotes (stations, slots and ports per station, rates, footprints). Run with `npm run test:e2e`.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MACHINE_HEADROOM } from '../src/lib/calc';
import type { PlanRequest, ProductionPlan } from '../src/lib/calc';
import { decodeBlueprint, layoutToBlueprintString } from '../src/lib/blueprint';
import type { Layout, PlacedBuilding } from '../src/lib/geometry';
import { buildNetlist, pooledImbalances, stationEnds } from '../src/lib/layout/netlist';
import type { Netlist } from '../src/lib/layout/netlist';
import { DEFAULT_SOLVE_OPTIONS, footprintOf, solve } from '../src/lib/layout/solver';
import type { SolveResult } from '../src/lib/layout/solver';
import { data, effects, pipelineLayout, planFor, quantumPlan } from '../src/lib/layout/testkit';
import { validateLayout } from '../src/lib/validate';
import type { ValidationReport } from '../src/lib/validate';

const PLS = 2103;
const ILS = 2104;
const CRUDE_OIL = 1007;
const COAL = 1006;
const STONE = 1005;
const WATER = 1000;
const REFINED_OIL = 1114;
const HYDROGEN = 1120;
const PROCESSOR = 1303;
const QUANTUM_CHIP = 1305;
const TITANIUM_CRYSTAL = 1118;
const TITANIUM_GLASS = 1119;
const GRAPHENE = 1123;
const CASIMIR_CRYSTAL = 1126;
const PLASTIC = 1115;
const PLASMA_REFINING = 16;
const REFINERY = 2308;
const CHEMICAL_PLANT = 2309;
const MK3 = 1143;

const log = (line: string): void => void process.stdout.write(`${line}\n`);
const messages = (r: ValidationReport): string[] => r.violations.map((v) => `${v.code}: ${v.message}`);
const itemName = (id: number): string => data.item(id).name;
const wantedRate = (plan: ProductionPlan): number => plan.exports.find((e) => e.itemId === plan.request.targetItemId)!.perSecond;
const stationsOf = (layout: Layout): PlacedBuilding[] => layout.buildings.filter((b) => b.station !== undefined);

/** Solves with the fallback ladder alone (`timeBudgetMs: 1`) and the default, adaptive simulation. */
function ladder(plan: ProductionPlan): { result: SolveResult; seconds: number } {
  const t0 = performance.now();
  const result = solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1, seed: 1 }, () => {}, () => {}, () => false);
  return { result, seconds: (performance.now() - t0) / 1000 };
}

/** One line per station: its place, its slots (with logic) and how many of its 12 ports are in use. */
function describeStations(layout: Layout): string {
  return stationsOf(layout)
    .map((b) => {
      const cfg = b.station!;
      const slots = cfg.slots.map((s) => `${itemName(s.itemId)} ${s.localLogic === 2 ? 'in' : 'out'}`).join(', ');
      return `#${b.id} ${data.item(b.itemId).name} at (${b.x}, ${b.y}): ${cfg.slots.length} slots [${slots}], ${cfg.ports.filter((p) => p.dir !== 0).length}/12 ports`;
    })
    .join('; ');
}

/**
 * What every layout with several stations has to be: `count` stations of the plan's kind, each with at most `maxItemKinds`
 * slots, one slot per item, a configured port for every belt end on it (the output ports where a belt starts, the input ports
 * where one ends) whose `storageIdx` points at a slot of the belt's item, and every item of the plan's slots on at least one
 * station. Returns the stations.
 */
function expectStationConfigs(layout: Layout, plan: ProductionPlan, count: number): PlacedBuilding[] {
  const kind = plan.request.stationKind === 'interstellar' ? ILS : PLS;
  const maxKinds = data.building(kind)!.station!.maxItemKinds;
  const stations = stationsOf(layout);
  expect(stations).toHaveLength(count);
  expect(stations.every((b) => b.itemId === kind)).toBe(true);
  expect(new Set(stations.map((b) => b.id)).size).toBe(count);

  for (const b of stations) {
    const cfg = b.station!;
    expect(cfg.slots.length, `station ${b.id}: slots`).toBeLessThanOrEqual(maxKinds);
    expect(new Set(cfg.slots.map((s) => s.itemId)).size, `station ${b.id}: an item has one slot`).toBe(cfg.slots.length);
    expect(cfg.ports).toHaveLength(12);
    cfg.ports.forEach((p, port) => {
      const starts = layout.belts.filter((x) => x.source?.buildingId === b.id && x.source.port === port);
      const ends = layout.belts.filter((x) => x.sink?.kind === 'port' && x.sink.buildingId === b.id && x.sink.port === port);
      expect(starts.length + ends.length, `station ${b.id} port ${port}: at most one belt`).toBeLessThanOrEqual(1);
      expect(p.dir, `station ${b.id} port ${port}`).toBe(starts.length > 0 ? 1 : ends.length > 0 ? 2 : 0);
      if (p.dir === 0) return expect(p.storageIdx).toBe(0);
      expect(p.storageIdx).toBeGreaterThanOrEqual(1);
      expect(p.storageIdx).toBeLessThanOrEqual(cfg.slots.length);
      expect(cfg.slots[p.storageIdx - 1].itemId, `station ${b.id} port ${port}: the slot of its belt's item`).toBe((starts[0] ?? ends[0]).itemId);
    });
  }
  const held = new Set(stations.flatMap((b) => b.station!.slots.map((s) => s.itemId)));
  for (const slot of plan.stationSlots) expect(held.has(slot.itemId), `${itemName(slot.itemId)} has a slot`).toBe(true);
  // the belts' station ends are all accounted for
  const beltEnds = layout.belts.reduce((n, x) => n + (x.source ? 1 : 0) + (x.sink?.kind === 'port' ? 1 : 0), 0);
  expect(stations.reduce((n, b) => n + b.station!.ports.filter((p) => p.dir !== 0).length, 0)).toBe(beltEnds);
  return stations;
}

/**
 * The blueprint of the layout carries each station as the game reads it: slot items and logic at `6 i .. 6 i + 3`, port
 * directions and storage indices at `192 + 4 s` and `+ 1` (BF §4.1), and a belt record linked to the station at the port's
 * index for every configured port.
 */
function expectBlueprintStations(layout: Layout, stations: PlacedBuilding[]): void {
  const records = decodeBlueprint(layoutToBlueprintString(layout, data, { shortDesc: 'multistation', desc: 'multistation e2e' })).body.buildings;
  for (const b of stations) {
    const index = layout.buildings.indexOf(b);
    const record = records[index];
    expect(record.itemId).toBe(b.itemId);
    expect(record.parameters).toHaveLength(2048);
    const cfg = b.station!;
    cfg.slots.forEach((s, i) => {
      expect([...record.parameters.slice(6 * i, 6 * i + 4)]).toEqual([s.itemId, s.localLogic, s.remoteLogic, s.max]);
    });
    for (let i = cfg.slots.length; i < 5; i++) expect(record.parameters[6 * i]).toBe(0);
    cfg.ports.forEach((p, port) => {
      expect([record.parameters[192 + 4 * port], record.parameters[192 + 4 * port + 1]]).toEqual([p.dir, p.storageIdx]);
      if (p.dir === 1) expect(records.filter((r) => r.inputObjIdx === index && r.inputFromSlot === port), `output port ${port} of station ${b.id}`).toHaveLength(1);
      if (p.dir === 2) expect(records.filter((r) => r.outputObjIdx === index && r.outputToSlot === port), `input port ${port} of station ${b.id}`).toHaveLength(1);
    });
  }
}

function expectPasses(name: string, plan: ProductionPlan, layout: Layout, seconds: number, over: Partial<{ rateLow: number }> = {}): ValidationReport {
  const t0 = performance.now();
  const report = validateLayout(layout, plan, data, effects);
  const rate = report.sim!.measuredTargetRate;
  log(
    `${name}: ${plan.stages.reduce((n, s) => n + s.machines, 0)} machines, footprint ${footprintOf(layout, data).toFixed(0)} tiles, ladder ${seconds.toFixed(1)} s, ` +
      `plain validation ${((performance.now() - t0) / 1000).toFixed(1)} s: ${rate.toFixed(3)}/s of ${wantedRate(plan)}/s after a warm-up of ${report.sim!.warmupTicksUsed} ticks`,
  );
  log(`${name}: stations: ${describeStations(layout)}`);
  expect(messages(report)).toEqual([]);
  expect(report.pass).toBe(true);
  expect(rate).toBeGreaterThanOrEqual((over.rateLow ?? 0.99) * wantedRate(plan));
  return report;
}

/** 1 Quantum Chip/s from Processors, Titanium Glass, Titanium Crystal, Graphene and Hydrogen: 6 items with the chips. */
const quantumFromParts = (over: Partial<PlanRequest> = {}): Promise<ProductionPlan> =>
  planFor({
    targetItemId: QUANTUM_CHIP,
    suppliedItemIds: new Set([PROCESSOR, TITANIUM_GLASS, TITANIUM_CRYSTAL, GRAPHENE, HYDROGEN]),
    machineHeadroom: DEFAULT_MACHINE_HEADROOM,
    ...over,
  });

describe('several stations end to end [slow]', () => {
  it('Quantum Chip from Processors and Plane Filter parts on PLS: 2 stations with at most 4 slots each, and it passes with the simulation', async () => {
    const plan = await quantumFromParts();
    expect(plan.stationSlots).toHaveLength(6);
    expect(plan.stationsNeeded).toBe(2);
    expect(buildNetlist(plan, data, effects).stations).toHaveLength(2);

    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    expect(layout).not.toBeNull();
    const stations = expectStationConfigs(layout, plan, 2);
    expect(stations.map((b) => b.station!.slots.length)).toEqual([4, 2]);
    // the second station stands clear of the first (the validator checks collisions; this is the spacing)
    expect(stations[1].y).toBeGreaterThan(stations[0].y);
    // imports are demand slots, the chips a supply slot
    expect(stations.flatMap((b) => b.station!.slots).filter((s) => s.localLogic === 1).map((s) => s.itemId)).toEqual([QUANTUM_CHIP]);
    expectBlueprintStations(layout, stations);
    expectPasses('quantum chip from parts (PLS)', plan, layout, seconds);
  }, 300_000);

  it('...with an ILS: 5 slots a station, so the same 6 items are 2 stations again, with remote logic', async () => {
    const plan = await quantumFromParts({ stationKind: 'interstellar' });
    expect(plan.stationsNeeded).toBe(2);
    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    const stations = expectStationConfigs(layout, plan, 2);
    expect(stations.map((b) => b.station!.slots.length)).toEqual([5, 1]);
    for (const s of stations.flatMap((b) => b.station!.slots)) expect(s.remoteLogic).toBe(s.localLogic);
    expectBlueprintStations(layout, stations);
    expectPasses('quantum chip from parts (ILS)', plan, layout, seconds);
  }, 300_000);

  it('...with Mk.III proliferator: 7 items, 2 stations, the proliferator\'s slot and its feed port on one of them', async () => {
    const plan = await quantumFromParts({ proliferator: { tier: 3, mode: 'extra' } });
    expect(plan.stationSlots).toContainEqual({ itemId: MK3, role: 'proliferator' });
    expect(plan.stationsNeeded).toBe(2);
    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    const stations = expectStationConfigs(layout, plan, 2);

    // exactly one station holds the proliferator, with exactly one output port for it: the feed's
    const holders = stations.filter((b) => b.station!.slots.some((s) => s.itemId === MK3));
    expect(holders).toHaveLength(1);
    const cfg = holders[0].station!;
    const slot = cfg.slots.findIndex((s) => s.itemId === MK3);
    expect(cfg.ports.filter((p) => p.dir !== 0 && p.storageIdx === slot + 1)).toEqual([{ dir: 1, storageIdx: slot + 1 }]);
    const feed = layout.belts.filter((b) => b.itemId === MK3);
    expect(feed).toHaveLength(1);
    expect(feed[0].source?.buildingId).toBe(holders[0].id);
    expect(feed[0].sink).toBeUndefined();
    expect(layout.coaters!.length).toBeGreaterThan(0);

    expectBlueprintStations(layout, stations);
    const report = expectPasses('quantum chip from parts (PLS, Mk.III)', plan, layout, seconds);
    expect(report.sim!.coaters.proliferatorPerSecond).toBeGreaterThan(0);
  }, 300_000);
});

describe('by-product exports end to end [slow]', () => {
  const refinedOil = (over: Partial<PlanRequest> = {}): Promise<ProductionPlan> =>
    planFor({
      targetItemId: REFINED_OIL,
      finalFacilityItemId: REFINERY,
      suppliedItemIds: new Set([CRUDE_OIL]),
      recipeOverrides: { [REFINED_OIL]: PLASMA_REFINING },
      machineHeadroom: DEFAULT_MACHINE_HEADROOM,
      ...over,
    });

  it('Plasma Refining for Refined Oil: the Hydrogen goes to a station input port, nothing stalls, and without that port the refineries do', async () => {
    const plan = await refinedOil({ quantity: { kind: 'rate', perSecond: 2 } });
    // Hydrogen is no input of any stage: nothing consumes it, so the plan exports it
    expect(plan.stages.map((s) => data.recipe(s.recipeId).name)).toEqual(['Plasma Refining']);
    expect(plan.exports.map((e) => e.itemId)).toEqual([REFINED_OIL, HYDROGEN]);
    expect(plan.stationSlots).toContainEqual({ itemId: HYDROGEN, role: 'export' });

    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    const stations = expectStationConfigs(layout, plan, 1);

    // the Hydrogen belt ends at a port of the station: an input port (dir 2) of the Hydrogen slot, which is a supply slot
    const belts = layout.belts.filter((b) => b.itemId === HYDROGEN);
    expect(belts).toHaveLength(1);
    const sink = belts[0].sink;
    if (sink?.kind !== 'port') throw new Error('the Hydrogen belt does not end at a station port');
    const cfg = stations[0].station!;
    expect(sink.buildingId).toBe(stations[0].id);
    expect(cfg.ports[sink.port].dir).toBe(2);
    expect(cfg.slots[cfg.ports[sink.port].storageIdx - 1]).toMatchObject({ itemId: HYDROGEN, localLogic: 1 });
    expect(belts[0].source).toBeUndefined();

    const report = expectPasses('plasma refining 2/s', plan, layout, seconds);
    expect(report.violations.filter((v) => v.code === 'SIM_STALLED')).toEqual([]);
    const hydrogen = report.sim!.measuredExports.find((e) => e.itemId === HYDROGEN);
    const refined = report.sim!.measuredExports.find((e) => e.itemId === REFINED_OIL)!;
    expect(hydrogen?.perSecond).toBeGreaterThan(0.45 * refined.perSecond);
    log(`plasma refining 2/s: exports ${refined.perSecond.toFixed(3)} Refined Oil/s and ${hydrogen?.perSecond.toFixed(3)} Hydrogen/s`);

    // the same layout without the export: the Hydrogen belt has no station to end at, the refineries cannot put their by-product
    // anywhere, and the validator fails the layout rather than passing it
    const unexported: Layout = {
      ...layout,
      belts: layout.belts.map((b) => (b.itemId === HYDROGEN ? { ...b, sink: undefined } : b)),
      buildings: layout.buildings.map((b) =>
        b.station
          ? { ...b, station: { ...b.station, ports: b.station.ports.map((p, i) => (i === sink.port ? { dir: 0 as const, storageIdx: 0 } : p)) } }
          : b,
      ),
    };
    const stalled = validateLayout(unexported, plan, data, effects);
    log(`plasma refining 2/s without the Hydrogen port: ${stalled.violations.map((v) => v.code).join(', ')}`);
    expect(stalled.pass).toBe(false);
    const codes = stalled.violations.map((v) => v.code);
    expect(codes).toContain('SIM_STALLED');
    expect(stalled.violations.find((v) => v.code === 'SIM_STALLED')?.message).toMatch(/Plasma Refining/);
  }, 300_000);

  it('Plastic from Refined Oil by Plasma Refining, with Mk.III proliferator: 2 stations, the Hydrogen is exported on the second', async () => {
    const plan = await planFor({
      targetItemId: PLASTIC,
      finalFacilityItemId: CHEMICAL_PLANT,
      suppliedItemIds: new Set([CRUDE_OIL, COAL]),
      recipeOverrides: { [REFINED_OIL]: PLASMA_REFINING },
      facilityOverrides: { [PLASMA_REFINING]: REFINERY },
      proliferator: { tier: 3, mode: 'extra' },
      machineHeadroom: DEFAULT_MACHINE_HEADROOM,
    });
    expect(plan.stationSlots.map((s) => [s.itemId, s.role])).toContainEqual([HYDROGEN, 'export']);
    expect(plan.stationsNeeded).toBe(2);

    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    const stations = expectStationConfigs(layout, plan, 2);
    const hydrogen = layout.belts.filter((b) => b.itemId === HYDROGEN);
    expect(hydrogen).toHaveLength(1);
    expect(hydrogen[0].sink).toMatchObject({ kind: 'port', buildingId: stations[1].id });
    expect(stations[1].station!.slots.map((s) => s.itemId)).toEqual([HYDROGEN]);
    expectBlueprintStations(layout, stations);
    const report = expectPasses('plastic via plasma refining (PLS, Mk.III)', plan, layout, seconds);
    expect(report.violations.filter((v) => v.code === 'SIM_STALLED')).toEqual([]);
  }, 300_000);
});

describe('an item that is imported and made, on several stations end to end [slow]', () => {
  it('Casimir Crystal at 4/s with at most 2 taps per net: 7 stations, Hydrogen on two of them, each giving out what it takes in', async () => {
    // Refined Oil by Plasma Refining makes Hydrogen as a by-product; the Casimir Crystals eat it, and the station tops it up.
    const BASE: Record<string, number> = { ASSEMBLE: 2303, SMELT: 2302, CHEMICAL: CHEMICAL_PLANT, REFINE: REFINERY, PARTICLE: 2310, RESEARCH: 2901 };
    const plan = await planFor({
      targetItemId: CASIMIR_CRYSTAL,
      quantity: { kind: 'rate', perSecond: 4 },
      suppliedItemIds: new Set([CRUDE_OIL, COAL, STONE, WATER, HYDROGEN, TITANIUM_CRYSTAL]),
      recipeOverrides: { [REFINED_OIL]: PLASMA_REFINING },
      facilityOverrides: Object.fromEntries(data.data.recipes.filter((r) => r.type in BASE).map((r) => [r.id, BASE[r.type]] as const)),
      machineHeadroom: DEFAULT_MACHINE_HEADROOM,
    });
    const hydrogenMade = plan.stages.some((s) => s.outputs.some((o) => o.itemId === HYDROGEN));
    expect(hydrogenMade && plan.imports.some((i) => i.itemId === HYDROGEN)).toBe(true);

    const net: Netlist = buildNetlist(plan, data, effects, { maxMachinesPerNet: 2 });
    expect(net.stations).toHaveLength(7);
    const withHydrogen = net.stations.flatMap((s, i) => (s.slots.some((x) => x.itemId === HYDROGEN) ? [i] : []));
    expect(withHydrogen).toHaveLength(2);
    expect(pooledImbalances(net)).toEqual([]);
    const perStation = withHydrogen.map((idx) => {
      const mine = net.nets.filter((n) => n.itemId === HYDROGEN);
      const inflow = mine.filter((n) => n.sink.kind === 'station' && n.sink.stationIdx === idx).reduce((s, n) => s + n.rate, 0);
      const outflow = mine.filter((n) => n.source.kind === 'station' && n.source.stationIdx === idx).reduce((s, n) => s + n.rate, 0);
      return { idx, inflow, outflow };
    });
    for (const { idx, inflow, outflow } of perStation) {
      expect(outflow, `station ${idx}: Hydrogen out`).toBeGreaterThanOrEqual(inflow);
      expect(inflow, `station ${idx}: Hydrogen in`).toBeGreaterThan(0);
    }
    log(`casimir 4/s: ${net.nets.length} nets; Hydrogen per station (in/out items/s): ${perStation.map((p) => `#${p.idx + 1} ${p.inflow.toFixed(2)}/${p.outflow.toFixed(2)}`).join(', ')}`);
    expect(stationEnds(net.nets).length).toBe(net.stations.reduce((n, s) => n + s.portsNeeded, 0));

    const t0 = performance.now();
    // the constructive placement at margin 4, routed once (margin 3 leaves 2 conflicts on 72 nets): the ladder's first rung
    const { layout } = pipelineLayout(net, plan, 4);
    const seconds = (performance.now() - t0) / 1000;
    const stations = expectStationConfigs(layout, plan, 7);
    // the Hydrogen sinks end at the stations that also give Hydrogen out, in the layout the validator sees
    for (const b of stations) {
      const cfg = b.station!;
      const slot = cfg.slots.findIndex((s) => s.itemId === HYDROGEN);
      if (slot < 0) continue;
      const rate = (dir: 1 | 2): number =>
        layout.belts
          .filter((x) => x.itemId === HYDROGEN && (dir === 1 ? x.source?.buildingId === b.id : x.sink?.kind === 'port' && x.sink.buildingId === b.id))
          .reduce((s, x) => s + x.plannedRate, 0);
      expect(rate(1), `station ${b.id}: Hydrogen out`).toBeGreaterThanOrEqual(rate(2));
      expect(cfg.slots[slot].localLogic).toBe(2);
    }
    expectBlueprintStations(layout, stations);
    expectPasses('casimir crystal 4/s, 2 taps a net (PLS)', plan, layout, seconds);
  }, 600_000);

  it('Quantum Chip from the raw resources: 3 stations, Hydrogen imported and made, and it passes', async () => {
    const plan = await quantumPlan({ tier: 0, mode: 'extra' }, DEFAULT_MACHINE_HEADROOM);
    expect(plan.stationsNeeded).toBe(3);
    expect(plan.stationSlots).toContainEqual({ itemId: HYDROGEN, role: 'import' });
    const net = buildNetlist(plan, data, effects);
    expect(net.stations).toHaveLength(3);
    expect(net.nets.some((n) => n.itemId === HYDROGEN && n.source.kind === 'taps' && n.sink.kind === 'station')).toBe(true);
    expect(pooledImbalances(net)).toEqual([]);

    const { result, seconds } = ladder(plan);
    expect(result.failures, 'failures').toEqual([]);
    const layout = result.layout as Layout;
    const stations = expectStationConfigs(layout, plan, 3);
    expect(stations.map((b) => b.station!.slots.length)).toEqual([4, 4, 2]);
    expectBlueprintStations(layout, stations);
    expectPasses('quantum chip from raw (PLS)', plan, layout, seconds);
  }, 900_000);
});
