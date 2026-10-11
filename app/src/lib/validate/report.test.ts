import { describe, expect, it } from 'vitest';
import type { ProductionPlan } from '../calc';
import * as validate from './index';
import { checkSimulation, validateLayout } from './report';
import type { SimResult } from './sim/run';
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

describe('checkSimulation thresholds', () => {
  const plan: ProductionPlan = {
    ...planOf([planStage(1, { craftsPerSecond: 2 })]),
    actualTargetRate: 2,
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
    measureSeconds: 100,
    warnings: [],
    ...over,
  });
  const check = (sim: SimResult) => checkSimulation(sim, layout, plan, fixtureData);

  it('passes a run that meets the plan', () => {
    expect(check(simOf())).toEqual([]);
  });

  it('SIM_OUTPUT_LOW below 99 % of the plan rate, with one item of slack', () => {
    expect(codesOf(check(simOf({ measuredTargetRate: 1.96 })))).toEqual(['SIM_OUTPUT_LOW']);
    expect(check(simOf({ measuredTargetRate: 1.99 }))).toEqual([]);
    // 99 % of 2/s is 1.98; one item over 100 s is 0.01/s of slack, so the line is at 1.97.
    expect(check(simOf({ measuredTargetRate: 1.975 }))).toEqual([]);
    expect(codesOf(check(simOf({ measuredTargetRate: 1.965 })))).toEqual(['SIM_OUTPUT_LOW']);
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
