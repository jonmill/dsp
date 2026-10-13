import { describe, expect, it } from 'vitest';
import { planProduction } from '../calc';
import type { ProductionPlan } from '../calc';
import { allTechs, computeTechEffects, GameDataIndex } from '../data';
import * as validate from './index';
import { checkSimulation, onlyStalled, OUTPUT_FACTOR, validateLayout } from './report';
import { GATE_SHARE, runSimulation } from './sim/run';
import type { SimResult } from './sim/run';
import type { Violation } from './types';
import {
  codesOf,
  compositeLayout,
  fixtureData,
  fixtureEffects,
  ITEM,
  LayoutKit,
  line,
  only,
  onNode,
  onSlot,
  planOf,
  planStage,
  smelterRowLayout,
  stationConfig,
} from './testkit';

const IRON_INGOT = 1101;
const GEAR = 1201;

/**
 * A layout that passes every geometry rule and the rate check, and runs: station A feeds iron ingots along a belt past
 * one Assembler Mk.II (gear, 1 s), whose output sorter puts the gears back on the belt; the belt ends in station B,
 * which takes gears and the ingots the assembler did not use.
 */
function gearLine() {
  const kit = new LayoutKit();
  const a = kit.station(0, 0);
  a.station!.slots[0].itemId = IRON_INGOT;
  a.station!.ports[0] = { dir: 0, storageIdx: 0 };
  a.station!.ports[1] = { dir: 1, storageIdx: 1 };
  const b = kit.station(12, 0, 0, ITEM.ils, { station: stationConfig(2) });
  b.station!.slots[0].itemId = GEAR;
  b.station!.slots[1].itemId = IRON_INGOT;
  b.station!.ports[0] = { dir: 0, storageIdx: 0 };
  b.station!.ports[1] = { dir: 2, storageIdx: 0 };
  kit.tesla(6, 3);
  const asm = kit.assembler(10, 7, 0, 5, 2304);
  asm.role = 'stage:0';
  // Nodes 0 and 1 are (0,4) and (0,5); node k from 2 on is (k - 1, 5); the last is (12,4).
  const belt = kit.belt(1, IRON_INGOT, [...line([0, 4], [0, 5]), ...line([1, 5], [12, 5]), { x: 12, y: 4, z: 0 }], {
    source: { buildingId: a.id, port: 1 },
    sink: { kind: 'port', buildingId: b.id, port: 1 },
  });
  const feed = kit.sorter(onNode(belt, 11), onSlot(asm, 7), 1, { filterItemId: IRON_INGOT });
  const out = kit.sorter(onSlot(asm, 6), onNode(belt, 12), 1, { filterItemId: GEAR });
  const stage = planStage(5, {
    buildingItemId: 2304,
    craftsPerSecond: 1,
    inputs: [{ itemId: IRON_INGOT, perSecond: 1 }],
    outputs: [{ itemId: GEAR, perSecond: 1 }],
  });
  const base = planOf([stage]);
  const plan: ProductionPlan = {
    ...base,
    request: { ...base.request, targetItemId: GEAR },
    actualTargetRate: 1,
    exports: [{ itemId: GEAR, perSecond: 1 }],
  };
  return { kit, a, b, asm, belt, feed, out, plan };
}

const validateKit = (kit: LayoutKit, plan: ProductionPlan, opts?: Parameters<typeof validateLayout>[4]) =>
  validateLayout(kit.layout(), plan, fixtureData, fixtureEffects, opts);

describe('validateLayout', () => {
  it('passes a layout that clears geometry, capacity and the simulation, and reports the simulation', () => {
    const line_ = gearLine();
    const report = validateKit(line_.kit, line_.plan);
    expect(report.violations).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.stage).toBe('simulation');
    expect(report.sim).toBeDefined();
    expect(report.sim!.measuredTargetRate).toBeGreaterThan(0.99);
    expect(report.sim!.deadlocked).toBe(false);
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt);
  });

  it('probes for a late deadlock only when asked: deadlockProbeTicks runs a passing layout on to that many ticks and still passes if it moves', () => {
    const line_ = gearLine();
    expect(validateKit(line_.kit, line_.plan).sim!.deadlockProbe).toBeUndefined(); // plain validateLayout does not
    const probed = validateKit(line_.kit, line_.plan, { warmupTicks: 600, measureTicks: 1200, deadlockProbeTicks: 20_000 });
    expect(probed.violations).toEqual([]);
    expect(probed.sim!.deadlockProbe).toMatchObject({ atTick: 20_000, deadlocked: false });
    // a layout that fails its verdict is not probed: it is turned down anyway (here the cold start of a 5 s window)
    const turnedDown = validateKit(line_.kit, line_.plan, { warmupTicks: 0, measureTicks: 300, deadlockProbeTicks: 20_000 });
    expect(turnedDown.pass).toBe(false);
    expect(turnedDown.stage).toBe('simulation'); // it was simulated, and turned down
    expect(turnedDown.sim?.deadlockProbe).toBeUndefined();
  });

  it('stops at geometry: an overlap fails there, and no simulation runs', () => {
    const line_ = gearLine();
    line_.kit.assembler(10, 7, 0, 5, 2304); // on top of the first
    const report = validateKit(line_.kit, line_.plan);
    expect(report.pass).toBe(false);
    expect(report.stage).toBe('geometry');
    expect(codesOf(report.violations)).toContain('BUILDING_OVERLAP');
    expect(report.sim).toBeUndefined();
  });

  it('stops at capacity when geometry is clean: an overloaded belt fails there', () => {
    const line_ = gearLine();
    line_.belt.plannedRate = 100;
    const report = validateKit(line_.kit, line_.plan);
    expect(report.pass).toBe(false);
    expect(report.stage).toBe('capacity');
    expect(codesOf(report.violations)).toEqual(['RATE_BELT']);
    expect(report.sim).toBeUndefined();
  });

  it('with simulate: false it stops after capacity and passes', () => {
    const line_ = gearLine();
    const report = validateKit(line_.kit, line_.plan, { simulate: false });
    expect(report).toMatchObject({ pass: true, stage: 'capacity', violations: [] });
    expect(report.sim).toBeUndefined();
  });

  it('reaches the simulation with a layout that is right on paper but does not work: a missing output sorter', () => {
    const line_ = gearLine();
    line_.kit.sorters.splice(line_.kit.sorters.indexOf(line_.out), 1);
    const report = validateKit(line_.kit, line_.plan);
    expect(report.pass).toBe(false);
    expect(report.stage).toBe('simulation');
    expect(report.sim).toBeDefined();
    expect(codesOf(report.violations)).toEqual(expect.arrayContaining(['SIM_OUTPUT_LOW', 'SIM_STALLED']));
    const stalled = only(report.violations, 'SIM_STALLED')[0];
    expect(stalled.entities).toEqual([{ kind: 'building', id: line_.asm.id }]);
  });

  it('passes the window lengths on to the simulation', () => {
    const line_ = gearLine();
    const report = validateKit(line_.kit, line_.plan, { warmupTicks: 600, measureTicks: 1200 });
    expect(report.sim!.measureSeconds).toBe(20);
    expect(report.sim!.warmupTicksUsed).toBe(600);
  });

  it('warms up adaptively when no warm-up is given', () => {
    const line_ = gearLine();
    const report = validateKit(line_.kit, line_.plan, { measureTicks: 1200 });
    expect(report.sim!.warmupTicksUsed).toBeGreaterThanOrEqual(3600);
    expect(report.sim!.warmupTicksUsed % 3600).toBe(0);
  });

  it('fails the composite fixture in the simulation: its ingots have nowhere to go', () => {
    const { kit } = compositeLayout();
    const stage = planStage(1, {
      buildingItemId: ITEM.assembler,
      machines: 2,
      craftsPerSecond: 1.5,
      inputs: [{ itemId: 1001, perSecond: 2 }],
      outputs: [{ itemId: IRON_INGOT, perSecond: 1.5 }],
    });
    for (const b of kit.buildings) if (b.recipeId === 1) b.role = 'stage:0';
    const report = validateKit(kit, planOf([stage]), { warmupTicks: 600, measureTicks: 1200 });
    expect(report.stage).toBe('simulation');
    expect(report.pass).toBe(false);
    expect(codesOf(report.violations)).toContain('SIM_OUTPUT_LOW');
  });
});

describe('validateLayout: a stage whose crafts swing from window to window', () => {
  /**
   * The gear line with a 30 s recipe (one assembler, one craft every 1800 ticks). A 2700-tick window holds one craft or two, and the
   * plan asks for 1.5: one craft is 0.67 of the planned, two are 1.33. Over four windows (10800 ticks) there are always six, which
   * is the plan. The target is asked for 0.02/s, which one craft in 45 s (0.022/s) meets.
   */
  const slow = (() => {
    const raw = structuredClone(fixtureData.data);
    raw.recipes.find((r) => r.id === 5)!.timeTicks = 1800;
    return new GameDataIndex(raw);
  })();
  const planFor = (craftsPerSecond: number, exportRate: number): ProductionPlan => {
    const stage = planStage(5, {
      buildingItemId: 2304,
      craftsPerSecond,
      inputs: [{ itemId: IRON_INGOT, perSecond: craftsPerSecond }],
      outputs: [{ itemId: GEAR, perSecond: craftsPerSecond }],
    });
    const base = planOf([stage]);
    return { ...base, request: { ...base.request, targetItemId: GEAR }, actualTargetRate: craftsPerSecond, exports: [{ itemId: GEAR, perSecond: exportRate }] };
  };
  const SHORT = { measureTicks: 2700 };
  /** The warm-up after which the short window holds one craft (the low phase); 3000 holds two. */
  const LOW_PHASE = 4000;
  const one = (plan: ProductionPlan, warmupTicks: number, opts: { measureTicks: number } = SHORT) =>
    validateLayout(gearLine().kit.layout(), plan, slow, fixtureEffects, { warmupTicks, ...opts });
  const plain = (plan: ProductionPlan, warmupTicks: number) => {
    const layout = gearLine().kit.layout();
    return checkSimulation(runSimulation(layout, plan, slow, fixtureEffects, { warmupTicks, measureTicks: 2700 }), layout, plan, slow);
  };

  it('passes when only the window was unlucky: SIM_STALLED alone in the short window is measured again over four times as long', () => {
    const plan = planFor(1 / 30, 0.02);
    expect(codesOf(plain(plan, LOW_PHASE))).toEqual(['SIM_STALLED']); // the precondition: the normal window fails on the stage alone
    const report = one(plan, LOW_PHASE);
    expect(report.violations).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.sim!.measureSeconds).toBe(180); // four windows of 45 s
    expect(report.sim!.stageStats[0].crafts).toBe(6);
    expect(report.sim!.warmupTicksUsed).toBe(LOW_PHASE + 2700); // the first window is warm-up now
  });

  it('a window that passes is left alone, and is not measured again', () => {
    const report = one(planFor(1 / 30, 0.02), 3000);
    expect(report.pass).toBe(true);
    expect(report.sim!.measureSeconds).toBe(45);
  });

  it('a stage that is really short of its crafts still fails: the long window reads it too, with its own length in the message', () => {
    const plan = planFor(1.3 / 30, 0.02); // the machine makes 1/30 a second: 0.77 of the planned, whatever the window
    expect(codesOf(plain(plan, LOW_PHASE))).toEqual(['SIM_STALLED']);
    const report = one(plan, LOW_PHASE);
    expect(codesOf(report.violations)).toEqual(['SIM_STALLED']);
    expect(report.pass).toBe(false);
    expect(report.sim!.measureSeconds).toBe(180);
    expect(report.violations[0].message).toContain('made 6 crafts in 180 s');
  });

  it('a layout that also misses the rate is not given the longer window: SIM_OUTPUT_LOW plus SIM_STALLED is the verdict as it stands', () => {
    const plan = planFor(1 / 30, 0.1); // the target is asked for 0.1/s and the machine delivers 0.022
    const report = one(plan, LOW_PHASE);
    expect(codesOf(report.violations)).toEqual(['SIM_OUTPUT_LOW', 'SIM_STALLED']);
    expect(report.sim!.measureSeconds).toBe(45);
  });

  it('a layout that deadlocks is not given the longer window either: SIM_DEADLOCK plus SIM_STALLED (and any other mix) is the verdict as it stands', () => {
    const v = (code: Violation['code']): Violation => ({ code, entities: [], message: code });
    expect(onlyStalled([v('SIM_STALLED')])).toBe(true);
    expect(onlyStalled([v('SIM_STALLED'), v('SIM_STALLED')])).toBe(true);
    expect(onlyStalled([v('SIM_DEADLOCK'), v('SIM_STALLED')])).toBe(false);
    expect(onlyStalled([v('SIM_STALLED'), v('SIM_DEADLOCK')])).toBe(false);
    expect(onlyStalled([v('SIM_OUTPUT_LOW'), v('SIM_STALLED')])).toBe(false);
    expect(onlyStalled([v('SIM_DEADLOCK'), v('SIM_OUTPUT_LOW'), v('SIM_STALLED')])).toBe(false);
    expect(onlyStalled([v('SIM_DEADLOCK')])).toBe(false);
    expect(onlyStalled([])).toBe(false);
  });

  it('the gate the simulator warms up towards is the validator\'s (run.ts cannot import report.ts: it would be circular)', () => {
    expect(GATE_SHARE).toBe(OUTPUT_FACTOR);
  });

  it('applies with the adaptive warm-up as well (the option is not tied to an explicit warm-up)', () => {
    const layout = gearLine().kit.layout();
    const asked: number[] = [];
    const sim = runSimulation(layout, planFor(1 / 30, 0.02), slow, fixtureEffects, {
      measureTicks: 2700,
      longerWindow: (r) => (asked.push(r.measureSeconds), r.measureSeconds === 45),
    });
    expect(asked).toEqual([45]); // asked once, about the first (and only normal) measurement
    expect(sim.measureSeconds).toBe(180);
    expect(sim.warmupTicksUsed).toBeGreaterThan(0);
  });
});

describe('checkSimulation thresholds', () => {
  const plan: ProductionPlan = {
    ...planOf([planStage(1, { craftsPerSecond: 2 })]),
    actualTargetRate: 2,
    exports: [{ itemId: IRON_INGOT, perSecond: 2 }],
  };
  const layout = new LayoutKit().layout();

  const simOf = (over: Partial<SimResult> = {}): SimResult => ({
    measuredTargetRate: 2,
    measuredExports: [],
    machineStats: [
      { buildingId: 7, stageIndex: 0, crafts: 100, busyFraction: 0.5, outputBlockedFraction: 0.25, starvedFraction: 0.25 },
      { buildingId: 8, stageIndex: 0, crafts: 100, busyFraction: 0.5, outputBlockedFraction: 0.25, starvedFraction: 0.25 },
    ],
    stageStats: [{ stageIndex: 0, crafts: 200, plannedCrafts: 200 }],
    deadlocked: false,
    power: { steadyW: 0, idleW: 0, peakW: 0, stationChargeW: 0 },
    coaters: { count: 0, sprayedItems: 0, proliferatorPerSecond: 0 },
    measureSeconds: 100,
    warmupTicksUsed: 7200,
    warnings: [],
    ...over,
  });
  const check = (sim: SimResult) => checkSimulation(sim, layout, plan, fixtureData);

  it('passes a run that meets the plan', () => {
    expect(check(simOf())).toEqual([]);
  });

  it('SIM_OUTPUT_LOW below 99 % of the provisioned rate', () => {
    expect(codesOf(check(simOf({ measuredTargetRate: 1.97 })))).toEqual(['SIM_OUTPUT_LOW']);
    expect(check(simOf({ measuredTargetRate: 1.99 }))).toEqual([]);
    expect(check(simOf({ measuredTargetRate: 1.98 }))).toEqual([]); // exactly 99 %
  });

  describe('the tolerance', () => {
    const at = (rate: number, seconds: number, measured: number) =>
      checkSimulation(
        simOf({ measuredTargetRate: measured, measureSeconds: seconds }),
        layout,
        { ...plan, actualTargetRate: rate, exports: [{ itemId: IRON_INGOT, perSecond: rate }] },
        fixtureData,
      );

    it('is 1 % of the rate when the window holds many items', () => {
      expect(at(10, 100, 9.89)).toHaveLength(1);
      expect(at(10, 100, 9.91)).toEqual([]);
    });

    it('widens to one item per window at low rates and short windows', () => {
      // 0.5/s over 120 s: 1 % is 0.005/s, one item is 0.0083/s.
      expect(at(0.5, 120, 0.4925)).toEqual([]);
      expect(at(0.5, 120, 0.49)).toHaveLength(1);
    });

    it('never widens beyond 2 % of the rate', () => {
      // 0.1/s over 100 s: one item is 0.01/s (10 %), capped at 0.002/s.
      expect(at(0.1, 100, 0.0981)).toEqual([]);
      expect(at(0.1, 100, 0.0979)).toHaveLength(1);
      expect(at(0.1, 100, 0.09)).toHaveLength(1);
    });
  });

  describe('the rate it is judged against', () => {
    it('is the plan\'s export of the target, not the final stage\'s capacity', () => {
      const chain: ProductionPlan = { ...plan, actualTargetRate: 3, exports: [{ itemId: IRON_INGOT, perSecond: 2 }] };
      expect(checkSimulation(simOf({ measuredTargetRate: 2 }), layout, chain, fixtureData)).toEqual([]);
      expect(codesOf(checkSimulation(simOf({ measuredTargetRate: 1.5 }), layout, chain, fixtureData))).toEqual(['SIM_OUTPUT_LOW']);
    });

    it('falls back to the requested rate when the plan lists no export of the target', () => {
      const noExport: ProductionPlan = { ...plan, exports: [], request: { ...plan.request, quantity: { kind: 'rate', perSecond: 4 } } };
      expect(codesOf(checkSimulation(simOf({ measuredTargetRate: 2 }), layout, noExport, fixtureData))).toEqual(['SIM_OUTPUT_LOW']);
      expect(checkSimulation(simOf({ measuredTargetRate: 4 }), layout, noExport, fixtureData)).toEqual([]);
    });

    it('falls back to the capacity when the request is in buildings and there is no export', () => {
      const byBuildings: ProductionPlan = { ...plan, exports: [], request: { ...plan.request, quantity: { kind: 'buildings', count: 2 } } };
      expect(codesOf(checkSimulation(simOf({ measuredTargetRate: 1 }), layout, byBuildings, fixtureData))).toEqual(['SIM_OUTPUT_LOW']);
      expect(checkSimulation(simOf({ measuredTargetRate: 2 }), layout, byBuildings, fixtureData)).toEqual([]);
    });
  });

  it('SIM_OUTPUT_LOW says what was measured and carries the wiring warnings', () => {
    const [v] = check(simOf({ measuredTargetRate: 0.5, warnings: ['belt 1: station 3 port 0 is not an output port'] }));
    expect(v.message).toContain('0.5/s');
    expect(v.message).toContain('2/s');
    expect(v.message).toContain('Iron Ingot');
    expect(v.message).toContain('belt 1: station 3 port 0 is not an output port');
  });

  it('names the stations that take the target as the entities of SIM_OUTPUT_LOW', () => {
    const kit = new LayoutKit();
    kit.station(0, 0); // output only
    const sink = kit.station(20, 0);
    sink.station!.slots[0].itemId = IRON_INGOT;
    sink.station!.ports[1] = { dir: 2, storageIdx: 0 };
    const v = checkSimulation(simOf({ measuredTargetRate: 0 }), kit.layout(), plan, fixtureData);
    expect(v[0].entities).toEqual([{ kind: 'building', id: sink.id }]);
  });

  it('does not judge the output when the plan expects none', () => {
    const none = { ...plan, actualTargetRate: 0 };
    expect(checkSimulation(simOf({ measuredTargetRate: 0 }), layout, none, fixtureData)).toEqual([]);
  });

  it('SIM_DEADLOCK when the simulator says so, listing the machines that never crafted', () => {
    const sim = simOf({
      deadlocked: true,
      machineStats: [
        { buildingId: 7, stageIndex: 0, crafts: 0, busyFraction: 0, outputBlockedFraction: 1, starvedFraction: 0 },
        { buildingId: 8, stageIndex: 0, crafts: 40, busyFraction: 0.2, outputBlockedFraction: 0.8, starvedFraction: 0 },
      ],
    });
    const v = only(check(sim), 'SIM_DEADLOCK');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'building', id: 7 }]);
  });

  it('SIM_DEADLOCK from the probe: the measurement made progress, the probe window at the horizon did not (Task 30b)', () => {
    const stuck = simOf({ deadlockProbe: { atTick: 1_000_000, deadlocked: true, stuckBuildingIds: [7, 8] } });
    const v = only(check(stuck), 'SIM_DEADLOCK');
    expect(v).toHaveLength(1);
    expect(v[0].entities).toEqual([{ kind: 'building', id: 7 }, { kind: 'building', id: 8 }]);
    expect(v[0].message).toContain('at tick 1000000 of the run');
    expect(check(stuck)).toHaveLength(1); // nothing else is judged
    // a probe that saw progress is no violation, and a run that deadlocked in the measurement already is named once
    expect(check(simOf({ deadlockProbe: { atTick: 1_000_000, deadlocked: false, stuckBuildingIds: [] } }))).toEqual([]);
    expect(only(check(simOf({ deadlocked: true, deadlockProbe: { atTick: 1_000_000, deadlocked: true, stuckBuildingIds: [7] } })), 'SIM_DEADLOCK')).toHaveLength(1);
  });

  it('SIM_STALLED below 90 % of the planned crafts, with each machine\'s busy and blocked share', () => {
    const stalled = simOf({ stageStats: [{ stageIndex: 0, crafts: 179, plannedCrafts: 200 }] });
    const [v] = check(stalled);
    expect(v.code).toBe('SIM_STALLED');
    expect(v.entities).toEqual([
      { kind: 'building', id: 7 },
      { kind: 'building', id: 8 },
    ]);
    expect(v.message).toContain('stage 0');
    expect(v.message).toContain('Iron Ingot');
    expect(v.message).toContain('179');
    expect(v.message).toContain('building 7 busy 50 %, output-blocked 25 %');
    expect(check(simOf({ stageStats: [{ stageIndex: 0, crafts: 181, plannedCrafts: 200 }] }))).toEqual([]);
  });

  it('carries the wiring warnings on SIM_STALLED and SIM_DEADLOCK too', () => {
    const warning = 'belt 1: station 3 port 0 is not an output port (dir 0); the belt stays empty';
    const sim = simOf({
      deadlocked: true,
      warnings: [warning],
      stageStats: [{ stageIndex: 0, crafts: 0, plannedCrafts: 200 }],
    });
    for (const code of ['SIM_STALLED', 'SIM_DEADLOCK'] as const) {
      expect(only(check(sim), code)[0].message).toContain(warning);
    }
    expect(only(check(simOf({ stageStats: [{ stageIndex: 0, crafts: 0, plannedCrafts: 200 }] })), 'SIM_STALLED')[0].message).not.toContain('Wiring');
  });

  it('judges a stage as a whole: one idle machine does not stall a stage that makes its crafts', () => {
    const sim = simOf({
      machineStats: [
        { buildingId: 7, stageIndex: 0, crafts: 190, busyFraction: 0.95, outputBlockedFraction: 0, starvedFraction: 0.05 },
        { buildingId: 8, stageIndex: 0, crafts: 10, busyFraction: 0.05, outputBlockedFraction: 0.95, starvedFraction: 0 },
      ],
    });
    expect(check(sim)).toEqual([]);
  });

  it('a stage with no machines in the layout stalls, and says so', () => {
    const sim = simOf({ machineStats: [], stageStats: [{ stageIndex: 0, crafts: 0, plannedCrafts: 200 }] });
    const [v] = check(sim);
    expect(v.code).toBe('SIM_STALLED');
    expect(v.entities).toEqual([]);
    expect(v.message).toContain('no machine');
  });

  it('skips a stage that plans no crafts', () => {
    expect(check(simOf({ stageStats: [{ stageIndex: 0, crafts: 0, plannedCrafts: 0 }] }))).toEqual([]);
  });
});

describe('a real plan whose final stage has spare capacity', () => {
  it('is not rejected when the chain delivers what was asked: Gear 1/s on Mk.I assemblers has capacity 1.5/s', async () => {
    const everything = allTechs(fixtureData.data);
    const result = await planProduction(
      {
        targetItemId: GEAR,
        quantity: { kind: 'rate', perSecond: 1 },
        finalFacilityItemId: ITEM.assembler,
        unlockedTechs: everything,
        suppliedItemIds: new Set([1001]),
        facilityOverrides: { 5: ITEM.assembler, 1: ITEM.smelter },
        recipeOverrides: {},
        proliferator: { tier: 0, mode: 'extra' },
        stationKind: 'planetary',
        machineHeadroom: 0, // the layout below is hand-built for the exact sizing: 1 smelter, 2 assemblers
      },
      fixtureData,
      computeTechEffects(fixtureData.data, everything),
    );
    if (!result.ok) throw new Error(result.error.message);
    const plan = result.plan;
    // Two Mk.I assemblers (0.75x) can make 1.5 gears/s, but one Arc Smelter feeds them 1 ingot/s.
    expect(plan.actualTargetRate).toBe(1.5);
    expect(plan.exports[0]).toEqual({ itemId: GEAR, perSecond: 1 });
    const gearStage = plan.stages.findIndex((st) => st.recipeId === 5);
    const smeltStage = plan.stages.findIndex((st) => st.recipeId === 1);
    expect(plan.stages[gearStage].machines).toBe(2);
    expect(plan.stages[smeltStage].machines).toBe(1);

    // Ore ILS -> smelter -> ingot belt -> 2 assemblers -> gear belt -> ILS, geometry-agnostic.
    const kit = new LayoutKit();
    const source = kit.station(0, 0);
    const sink = kit.station(80, 0);
    sink.station!.slots[0].itemId = GEAR;
    sink.station!.ports[1] = { dir: 2, storageIdx: 0 };
    const ore = kit.belt(1, 1001, line([0, 5], [30, 5]), { source: { buildingId: source.id, port: 0 } });
    const ingots = kit.belt(1, IRON_INGOT, line([0, 9], [30, 9]));
    const gears = kit.belt(1, GEAR, line([0, 13], [30, 13]), { sink: { kind: 'port', buildingId: sink.id, port: 1 } });
    const smelter = kit.smelter(10, 7, 0, 1);
    smelter.role = `stage:${smeltStage}`;
    kit.sorter(onNode(ore, 10), onSlot(smelter, 0), 1, { filterItemId: 1001 });
    kit.sorter(onSlot(smelter, 1), onNode(ingots, 10), 1, { filterItemId: IRON_INGOT });
    for (const node of [16, 20]) {
      const asm = kit.assembler(node, 11, 0, 5);
      asm.role = `stage:${gearStage}`;
      kit.sorter(onNode(ingots, node), onSlot(asm, 0), 1, { filterItemId: IRON_INGOT });
      kit.sorter(onSlot(asm, 1), onNode(gears, node), 1, { filterItemId: GEAR });
    }
    const layout = kit.layout();
    const sim = runSimulation(layout, plan, fixtureData, computeTechEffects(fixtureData.data, everything), {
      warmupTicks: 3600,
      measureTicks: 7200,
    });
    expect(sim.warnings).toEqual([]);
    expect(Math.abs(sim.measuredTargetRate - 1)).toBeLessThan(0.02);
    expect(sim.measuredTargetRate).toBeLessThan(0.99 * plan.actualTargetRate); // the old comparison would have failed it
    expect(checkSimulation(sim, layout, plan, fixtureData)).toEqual([]);

    // And a layout that really delivers less than the 1/s asked for still fails.
    const starved = { ...sim, measuredTargetRate: 0.9 };
    expect(codesOf(checkSimulation(starved, layout, plan, fixtureData))).toEqual(['SIM_OUTPUT_LOW']);
  });
});

describe('validate index', () => {
  it('exports the four entry points', () => {
    expect(validate.validateLayout).toBe(validateLayout);
    expect(typeof validate.checkGeometry).toBe('function');
    expect(typeof validate.checkCapacity).toBe('function');
    expect(typeof validate.runSimulation).toBe('function');
  });

  it('runs a smelter row through validateLayout\'s simulation stage only when geometry allows', () => {
    // The smelter-row fixture is geometry-agnostic, so the gate rejects it before simulating.
    const row = smelterRowLayout(1);
    const report = validateLayout(row.kit.layout(), row.plan, fixtureData, fixtureEffects, { warmupTicks: 60, measureTicks: 60 });
    expect(report.stage).not.toBe('simulation');
    expect(report.pass).toBe(false);
  });
});
