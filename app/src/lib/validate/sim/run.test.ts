import { describe, expect, it } from 'vitest';
import { GameDataIndex } from '../../data';
import type { Layout } from '../../geometry';
import { checkSimulation } from '../report';
import { codesOf, fixtureData, fixtureEffects, ITEM, LayoutKit, line, only, onNode, onSlot, planOf, refineryLayout, smelterRowLayout, stationConfig, stationPairLayout } from '../testkit';
import { ABORT_CHECK_TICKS, MAX_WARMUP_TICKS, runSimulation, SimulationAborted, WarmupNotSettled } from './run';
import type { SimResult } from './run';

const TPS = 60;
const FAST = { warmupTicks: 1800, measureTicks: 3600 };

const simulate = (row: { kit: LayoutKit; plan: Parameters<typeof runSimulation>[1] }, opts?: Parameters<typeof runSimulation>[4]): SimResult =>
  runSimulation(row.kit.layout(), row.plan, fixtureData, fixtureEffects, opts);

describe('runSimulation: a smelter row', () => {
  it('(a) 3 smelters deliver 3 ingots/s from an ILS to an ILS over the adaptive warm-up + 5 minutes, and log the speed', () => {
    const row = smelterRowLayout(3);
    const started = performance.now();
    const sim = simulate(row);
    const ms = performance.now() - started;
    const ticks = sim.warmupTicksUsed + 18000;
    console.log(`run.test (a): ${ticks} ticks in ${ms.toFixed(0)} ms = ${Math.round((ticks / ms) * 1000)} ticks/s`);
    expect(ms).toBeLessThan(3000);
    expect(sim.warmupTicksUsed).toBeGreaterThanOrEqual(3600);
    expect(sim.warmupTicksUsed).toBeLessThan(18000); // a 28-node block settles in a window or two

    expect(sim.measuredTargetRate).toBeGreaterThanOrEqual(2.97);
    expect(sim.measuredTargetRate).toBeLessThan(3.03);
    expect(sim.deadlocked).toBe(false);
    expect(sim.warnings).toEqual([]);
    expect(sim.measuredExports).toEqual([{ itemId: 1101, perSecond: sim.measuredTargetRate }]);
    expect(sim.measureSeconds).toBe(300);

    expect(sim.stageStats).toHaveLength(1);
    const stage = sim.stageStats[0];
    expect(stage.stageIndex).toBe(0);
    expect(stage.plannedCrafts).toBe(900);
    expect(Math.abs(stage.crafts - 900)).toBeLessThanOrEqual(3);

    expect(sim.machineStats.map((m) => m.buildingId)).toEqual(row.smelters.map((s) => s.id));
    for (const m of sim.machineStats) {
      expect(m.stageIndex).toBe(0);
      expect(m.busyFraction).toBeGreaterThan(0.98);
      expect(m.outputBlockedFraction).toBeLessThan(0.01);
      expect(m.starvedFraction).toBeLessThan(0.02);
      expect(Math.abs(m.crafts - 300)).toBeLessThanOrEqual(2);
    }
    expect(checkSimulation(sim, row.kit.layout(), row.plan, fixtureData)).toEqual([]);
  });

  it('(b) with the ingot belt dead-ended nothing arrives and the stage stalls', () => {
    const row = smelterRowLayout(3, { deadEnd: true });
    const sim = simulate(row, { warmupTicks: 7200, measureTicks: 7200 });
    expect(sim.measuredTargetRate).toBe(0);
    const stage = sim.stageStats[0];
    expect(stage.crafts).toBeLessThan(0.9 * stage.plannedCrafts);
    const violations = checkSimulation(sim, row.kit.layout(), row.plan, fixtureData);
    expect(codesOf(violations)).toContain('SIM_OUTPUT_LOW');
    expect(codesOf(violations)).toContain('SIM_STALLED');
    const stalled = only(violations, 'SIM_STALLED')[0];
    expect(stalled.entities.map((e) => e.id)).toEqual(row.smelters.map((s) => s.id));
    expect(stalled.entities.every((e) => e.kind === 'building')).toBe(true);
    expect(stalled.message).toMatch(/blocked/);
  });

  it('(c) a refinery whose hydrogen has no output belt stalls (Review Focus 4)', () => {
    const run = refineryLayout();
    const sim = simulate(run, { warmupTicks: 7200, measureTicks: 7200 });
    const stage = sim.stageStats[0];
    expect(stage.plannedCrafts).toBe(0.25 * 120);
    expect(stage.crafts).toBeLessThan(0.9 * stage.plannedCrafts);
    const stat = sim.machineStats[0];
    expect(stat.buildingId).toBe(run.refinery.id);
    expect(stat.outputBlockedFraction).toBeGreaterThan(0.9);
    const violations = checkSimulation(sim, run.kit.layout(), run.plan, fixtureData);
    const stalled = only(violations, 'SIM_STALLED');
    expect(stalled).toHaveLength(1);
    expect(stalled[0].entities).toEqual([{ kind: 'building', id: run.refinery.id }]);
    expect(stalled[0].message).toMatch(/Plasma Refining/);
  });

  it('(c, control) the same refinery with a hydrogen belt runs at plan and exports both', () => {
    const run = refineryLayout({ drainHydrogen: true });
    const sim = simulate(run, { warmupTicks: 7200, measureTicks: 7200 });
    expect(Math.abs(sim.measuredTargetRate - 0.5)).toBeLessThan(0.02);
    expect(sim.measuredExports.map((e) => e.itemId)).toEqual([1114, 1120]);
    expect(Math.abs(sim.measuredExports[1].perSecond - 0.25)).toBeLessThan(0.02);
    expect(sim.machineStats[0].outputBlockedFraction).toBeLessThan(0.01);
    expect(checkSimulation(sim, run.kit.layout(), run.plan, fixtureData)).toEqual([]);
  });

  it('(d) two runs of one layout give identical results', () => {
    const row = smelterRowLayout(3);
    const a = simulate(row, FAST);
    const b = simulate(row, FAST);
    expect(b).toEqual(a);
    expect(simulate(smelterRowLayout(3), FAST)).toEqual(a);
  });

  it('measures only the window after the warm-up', () => {
    const row = smelterRowLayout(3);
    const sim = simulate(row, { warmupTicks: 1200, measureTicks: 1800 });
    expect(sim.measureSeconds).toBe(30);
    expect(sim.stageStats[0].plannedCrafts).toBe(90);
    expect(sim.measuredTargetRate).toBeGreaterThan(2.9);
    // With no warm-up the first ingot has not even left the ILS yet: the rate reads low.
    const cold = simulate(row, { warmupTicks: 0, measureTicks: 300 });
    expect(cold.measuredTargetRate).toBeLessThan(sim.measuredTargetRate);
  });

  it('rejects a measurement window that is not a positive whole number of ticks', () => {
    const row = smelterRowLayout(1);
    expect(() => simulate(row, { measureTicks: 0 })).toThrow(/measureTicks/);
    expect(() => simulate(row, { warmupTicks: -1 })).toThrow(/warmupTicks/);
    expect(() => simulate(row, { measureTicks: 1.5 })).toThrow(/measureTicks/);
  });
});

describe('runSimulation: the warm-up', () => {
  /** A station feeds a Mk.I belt of `nodes` nodes (20 ticks each) into another station: nothing arrives for `nodes * 20` ticks. */
  function longBelt(nodes: number, provisioned: number): { layout: Layout; plan: Parameters<typeof runSimulation>[1] } {
    const { kit } = stationPairLayout(1, nodes);
    const base = planOf([]);
    const plan = {
      ...base,
      actualTargetRate: provisioned,
      request: { ...base.request, targetItemId: 1001, quantity: { kind: 'rate' as const, perSecond: provisioned } },
    };
    return { layout: kit.layout(), plan };
  }
  /** The belt carries 6/s; `provisioned` is what the plan asks of it. */
  const run = (nodes: number, opts?: Parameters<typeof runSimulation>[4], provisioned = 6): SimResult => {
    const { layout, plan } = longBelt(nodes, provisioned);
    return runSimulation(layout, plan, fixtureData, fixtureEffects, opts);
  };

  it('uses exactly the ticks it is given, and reports them', () => {
    const row = smelterRowLayout(3);
    for (const warmupTicks of [0, 1234, 7200, 9000]) {
      const sim = simulate(row, { warmupTicks, measureTicks: 600 });
      expect(sim.warmupTicksUsed).toBe(warmupTicks);
    }
    // an explicit warm-up is not extended even when the block is still ramping up
    const short = run(500, { warmupTicks: 7200, measureTicks: 18000 });
    expect(short.warmupTicksUsed).toBe(7200);
    expect(short.measuredTargetRate).toBeLessThan(5.5); // the first item lands at tick ~10000, inside the window
  });

  it('with no warm-up given runs windows of 3600 ticks until the ramp-up is over: a 500-node belt takes over 7200', () => {
    const sim = run(500);
    expect(sim.warmupTicksUsed).toBeGreaterThan(7200);
    expect(sim.warmupTicksUsed).toBeLessThanOrEqual(72000);
    expect(sim.warmupTicksUsed % 3600).toBe(0);
    expect(sim.measuredTargetRate).toBeGreaterThan(5.9);
    expect(sim.measuredTargetRate).toBeLessThan(6.1);
    // the fixed 7200 ticks the simulator used to run measure the ramp-up instead
    expect(run(500, { warmupTicks: 7200 }).measuredTargetRate).toBeLessThan(sim.measuredTargetRate - 0.5);
  });

  it('needs two consecutive windows at the provisioned rate, so it never stops before 7200 ticks', () => {
    const sim = run(20, undefined, 3); // the belt carries 6/s, 3/s is provisioned: the first window already makes it
    expect(sim.warmupTicksUsed).toBe(7200);
    expect(sim.measuredTargetRate).toBeGreaterThan(5.9);
    // at 6/s provisioned the first window, which spends ~400 ticks filling the belt, falls short (5.3/s); the second makes
    // it, but one window is not enough: it ends with the third
    expect(run(20).warmupTicksUsed).toBe(10800);
  });

  it('does not stop on a plateau below the provisioned rate: a block that cannot reach it keeps warming up to the cap', () => {
    const row = smelterRowLayout(3);
    row.plan.exports = [{ itemId: 1101, perSecond: 5 }]; // the row makes 3/s; steady from the second window on
    const sim = simulate(row, { measureTicks: 3600 });
    expect(sim.warmupTicksUsed).toBe(MAX_WARMUP_TICKS);
    expect(Math.abs(sim.measuredTargetRate - 3)).toBeLessThan(0.05);
  });

  it('a block that makes nothing runs to the 72000-tick cap', () => {
    const row = smelterRowLayout(3);
    row.ore.source = undefined; // no ore ever enters
    const sim = simulate(row, { measureTicks: 600 });
    expect(sim.warmupTicksUsed).toBe(MAX_WARMUP_TICKS);
    expect(sim.measuredTargetRate).toBe(0);
    expect(sim.deadlocked).toBe(true);
  });

  it('is the same on every run', () => {
    expect(run(500)).toEqual(run(500));
  });
});

describe('runSimulation: deadlock', () => {
  it('flags a block where nothing moves for 600 ticks while the plan expects output', () => {
    const row = smelterRowLayout(3);
    row.ore.source = undefined; // no ore ever enters
    const sim = simulate(row, FAST);
    expect(sim.deadlocked).toBe(true);
    expect(sim.measuredTargetRate).toBe(0);
    const violations = checkSimulation(sim, row.kit.layout(), row.plan, fixtureData);
    expect(codesOf(violations)).toEqual(expect.arrayContaining(['SIM_DEADLOCK', 'SIM_OUTPUT_LOW', 'SIM_STALLED']));
  });

  it('does not count cargo circulating in a merge cycle as progress', () => {
    const kit = new LayoutKit();
    const source = kit.station(0, 0);
    const a = kit.belt(1, 1001, line([0, 5], [8, 5]), { source: { buildingId: source.id, port: 0 } });
    const b = kit.belt(1, 1001, line([0, 9], [8, 9]));
    a.sink = { kind: 'belt', beltId: b.id, node: 3 };
    b.sink = { kind: 'belt', beltId: a.id, node: 3 };
    const row = { kit, plan: { ...smelterRowLayout(1).plan } };
    const sim = simulate(row, FAST);
    expect(sim.deadlocked).toBe(true);
  });

  it('counts an item reaching a station as progress, with no machine and no sorter in the block', () => {
    const { kit, belt } = stationPairLayout(1, 10);
    expect(belt.nodes).toHaveLength(10);
    const plan = { ...planOf([]), actualTargetRate: 1, request: { ...planOf([]).request, targetItemId: 1001 } };
    const sim = runSimulation(kit.layout(), plan, fixtureData, fixtureEffects, { warmupTicks: 0, measureTicks: 3000 });
    expect(sim.deadlocked).toBe(false);
    expect(sim.measuredTargetRate).toBeGreaterThan(5);
  });

  it('counts a sorter delivery as progress, with no machine and no item reaching a station', () => {
    const kit = new LayoutKit();
    const source = kit.station(0, 0);
    const feed = kit.belt(1, 1001, line([0, 5], [30, 5]), { source: { buildingId: source.id, port: 0 } });
    const store = kit.belt(1, 1001, line([0, 9], [30, 9])); // a dead end that takes 60 cargo
    kit.sorter(onNode(feed, 10), onNode(store, 10), 1, { filterItemId: 1001 });
    const plan = { ...planOf([]), actualTargetRate: 1 };
    const sim = runSimulation(kit.layout(), plan, fixtureData, fixtureEffects, { warmupTicks: 0, measureTicks: 2400 });
    expect(sim.measuredTargetRate).toBe(0);
    expect(sim.deadlocked).toBe(false);
    // Once the store is full the deliveries stop, and the block is stuck.
    const later = runSimulation(kit.layout(), plan, fixtureData, fixtureEffects, { warmupTicks: 6000, measureTicks: 2400 });
    expect(later.deadlocked).toBe(true);
  });

  it('is not a deadlock when the plan expects nothing', () => {
    const row = smelterRowLayout(3);
    row.ore.source = undefined;
    const sim = simulate({ kit: row.kit, plan: { ...row.plan, actualTargetRate: 0 } }, FAST);
    expect(sim.deadlocked).toBe(false);
  });

  it('does not flag a block that is merely slow: a 30 s recipe keeps making progress', () => {
    const row = smelterRowLayout(1);
    const slow = structuredClone(fixtureData.data);
    slow.recipes.find((r) => r.id === 1)!.timeTicks = 1800;
    const data = new GameDataIndex(slow);
    const plan = { ...row.plan, actualTargetRate: 1 / 30 };
    const sim = runSimulation(row.kit.layout(), plan, data, fixtureEffects, { warmupTicks: 3600, measureTicks: 3600 });
    expect(sim.deadlocked).toBe(false);
    expect(sim.measuredTargetRate).toBeGreaterThan(0);
  });
});

describe('runSimulation: wiring problems', () => {
  it('names a station output port that is not configured as an output, and the belt stays empty', () => {
    const row = smelterRowLayout(2);
    row.source.station!.ports[0] = { dir: 0, storageIdx: 0 };
    const sim = simulate(row, FAST);
    expect(sim.measuredTargetRate).toBe(0);
    expect(sim.warnings).toHaveLength(1);
    expect(sim.warnings[0]).toMatch(new RegExp(`station ${row.source.id}.*port 0.*not an output`));
    const violations = checkSimulation(sim, row.kit.layout(), row.plan, fixtureData);
    expect(only(violations, 'SIM_OUTPUT_LOW')[0].message).toMatch(new RegExp(`station ${row.source.id}.*port 0`));
  });

  it('names an output port with no item, an item the belt does not carry, and an input port that is not an input', () => {
    const noItem = smelterRowLayout(1);
    noItem.source.station!.ports[0] = { dir: 1, storageIdx: 0 };
    expect(simulate(noItem, FAST).warnings.join('\n')).toMatch(/port 0.*no item/);

    const wrongItem = smelterRowLayout(1);
    wrongItem.source.station!.slots[0].itemId = 1002;
    expect(simulate(wrongItem, FAST).warnings.join('\n')).toMatch(/port 0.*Copper Ore.*Iron Ore/);

    const wrongDir = smelterRowLayout(1);
    wrongDir.sink.station!.ports[1] = { dir: 1, storageIdx: 1 };
    expect(simulate(wrongDir, FAST).warnings.join('\n')).toMatch(new RegExp(`station ${wrongDir.sink.id}.*port 1.*not an input`));

    const noSlot = smelterRowLayout(1);
    noSlot.sink.station!.slots[0].itemId = 1002;
    expect(simulate(noSlot, FAST).warnings.join('\n')).toMatch(new RegExp(`station ${noSlot.sink.id}.*port 1.*Iron Ingot`));
  });

  it('skips a sorter whose end is a building the simulator has no model for, with a warning', () => {
    const row = smelterRowLayout(1);
    row.kit.sorter(onNode(row.ore, 3), onSlot(row.sink, 0));
    const sim = simulate(row, FAST);
    expect(sim.warnings.join('\n')).toMatch(new RegExp(`sorter 3.*building ${row.sink.id}`));
    expect(sim.measuredTargetRate).toBeGreaterThan(0.9);
  });

  it('warns about a building with a recipe that the simulator has no model for, such as a fractionator', () => {
    const row = smelterRowLayout(1);
    const frac = row.kit.building(2314, 30, 20, 0, { recipeId: 1 });
    const sim = simulate(row, FAST);
    expect(sim.warnings.join('\n')).toMatch(new RegExp(`building ${frac.id}.*Fractionator.*no model`));
    expect(sim.machineStats.map((m) => m.buildingId)).toEqual([row.smelters[0].id]);
  });

  it('warns about a building whose recipe GameData does not have, instead of failing or ignoring it silently', () => {
    const row = smelterRowLayout(1);
    const odd = row.kit.building(ITEM.smelter, 30, 20, 0, { recipeId: 99999 });
    const sim = simulate(row, FAST);
    expect(sim.warnings.join('\n')).toMatch(new RegExp(`building ${odd.id}.*recipe 99999.*does not have`));
    expect(sim.machineStats.map((m) => m.buildingId)).toEqual([row.smelters[0].id]);
    expect(sim.measuredTargetRate).toBeGreaterThan(0.9);
  });

  it('warns about a building whose item is not a building in GameData', () => {
    const row = smelterRowLayout(1);
    const odd = row.kit.building(99999, 30, 20, 0, { recipeId: 1 });
    const sim = simulate(row, FAST);
    expect(sim.warnings.join('\n')).toMatch(new RegExp(`building ${odd.id}.*item 99999.*not a building`));
  });

  it('throws for a sorter that names a building or belt the layout does not have', () => {
    const row = smelterRowLayout(1);
    row.kit.sorter(onNode(row.ore, 3), { kind: 'building', buildingId: 999, slot: 0 });
    expect(() => simulate(row, FAST)).toThrow(/building 999/);
    const row2 = smelterRowLayout(1);
    row2.kit.sorter({ kind: 'belt', beltId: 999, node: 0 }, onSlot(row2.smelters[0], 2));
    expect(() => simulate(row2, FAST)).toThrow(/belt 999/);
  });

  it('throws for a sorter tier that GameData does not know as a sorter', () => {
    const row = smelterRowLayout(1);
    row.kit.sorters[0].tierItemId = 2201 as never;
    expect(() => simulate(row, FAST)).toThrow(/sorter/);
  });
});

describe('runSimulation: mapping buildings to stages', () => {
  it('falls back to the first stage with the building\'s recipe when there is no role', () => {
    const row = smelterRowLayout(2);
    for (const s of row.smelters) delete s.role;
    const sim = simulate(row, FAST);
    expect(sim.machineStats.map((m) => m.stageIndex)).toEqual([0, 0]);
    expect(sim.stageStats[0].crafts).toBeGreaterThan(100);
  });

  it('maps a building to the stage its role names, even when an earlier stage has the same recipe', () => {
    const row = smelterRowLayout(2);
    const second = { ...row.plan.stages[0], machines: 1, craftsPerSecond: 1 };
    row.plan.stages[0] = { ...row.plan.stages[0], machines: 1, craftsPerSecond: 1 };
    row.plan.stages.push(second);
    row.smelters[0].role = 'stage:0';
    row.smelters[1].role = 'stage:1';
    const sim = simulate(row, FAST);
    expect(sim.machineStats.map((m) => m.stageIndex)).toEqual([0, 1]);
    expect(sim.stageStats.map((s) => s.stageIndex)).toEqual([0, 1]);
    for (const stage of sim.stageStats) expect(Math.abs(stage.crafts - stage.plannedCrafts)).toBeLessThanOrEqual(2);
  });

  it('leaves a building that matches no stage out of the stage totals but still simulates it', () => {
    const row = smelterRowLayout(2);
    row.smelters[1].role = 'stage:7';
    row.smelters[1].recipeId = 3; // copper: no stage has it
    const sim = simulate(row, FAST);
    expect(sim.machineStats.map((m) => m.stageIndex)).toEqual([0, null]);
    expect(sim.stageStats[0].crafts).toBeLessThan(sim.machineStats[0].crafts + 1);
  });
});

describe('runSimulation: power', () => {
  it('measures the average draw without station charge, and the peak with it', () => {
    const row = smelterRowLayout(3);
    row.source.station!.chargePerTick = 1_000_000; // an ILS: 60 MW
    row.sink.station!.chargePerTick = 200_000; // 12 MW
    const sim = simulate(row, FAST);
    const smelterWorkW = fixtureData.building(ITEM.smelter)!.power.workPerTick * TPS;
    const sorterIdleW = fixtureData.building(ITEM.sorter.mk1)!.power.idlePerTick * TPS;
    const sorterWorkW = fixtureData.building(ITEM.sorter.mk1)!.power.workPerTick * TPS;
    // 3 smelters always at work, plus 6 sorters that work part of the time (1 trip in 40 ticks of 1.5 trips/s offered).
    expect(sim.power.steadyW).toBeGreaterThan(3 * smelterWorkW + 6 * sorterIdleW + 0.3 * 6 * (sorterWorkW - sorterIdleW));
    expect(sim.power.steadyW).toBeLessThan(3 * smelterWorkW + 6 * sorterWorkW);
    expect(sim.power.idleW).toBeGreaterThan(0);
    expect(sim.power.idleW).toBeLessThan(sim.power.steadyW * 0.2);
    expect(sim.power.stationChargeW).toBe(72_000_000);
    expect(sim.power.peakW).toBeGreaterThanOrEqual(sim.power.steadyW + sim.power.stationChargeW);
    expect(sim.power.peakW).toBeLessThan(sim.power.steadyW * 1.5 + sim.power.stationChargeW);
  });

  it('a blocked block draws idle power only, and says so in idleW', () => {
    const row = smelterRowLayout(3, { deadEnd: true });
    const sim = simulate(row, { warmupTicks: 18000, measureTicks: 3600 }); // long enough for the dead end to fill up
    const smelterIdleW = fixtureData.building(ITEM.smelter)!.power.idlePerTick * TPS;
    const sorterIdleW = fixtureData.building(ITEM.sorter.mk1)!.power.idlePerTick * TPS;
    expect(sim.power.idleW).toBeCloseTo(3 * smelterIdleW + 6 * sorterIdleW, 3);
    expect(sim.power.steadyW).toBeCloseTo(sim.power.idleW, 3);
    // The start-up peak is still the full work draw.
    expect(sim.power.peakW).toBeGreaterThan(3 * fixtureData.building(ITEM.smelter)!.power.workPerTick * TPS);
  });

  it('slows everything to the supplied share of the demand, and freezes below 10 %', () => {
    const row = smelterRowLayout(3);
    const free = simulate(row, FAST);
    const half = simulate(row, { ...FAST, powerSupplyW: free.power.steadyW * 0.5 });
    expect(half.measuredTargetRate).toBeLessThan(free.measuredTargetRate * 0.75);
    expect(half.measuredTargetRate).toBeGreaterThan(0.5);
    const frozen = simulate(row, { ...FAST, powerSupplyW: free.power.steadyW * 0.05 });
    expect(frozen.measuredTargetRate).toBe(0);
  });
});

describe('runSimulation: labs', () => {
  it('a Matrix Lab makes one matrix every 3 s from belts of coils and circuit boards', () => {
    const kit = new LayoutKit();
    const source = kit.station(0, 0, 0, ITEM.ils, { station: stationConfig(2) });
    source.station!.slots[0].itemId = 1202;
    source.station!.slots[1].itemId = 1301;
    source.station!.ports[1] = { dir: 1, storageIdx: 2 };
    const sink = kit.station(80, 0);
    sink.station!.slots[0].itemId = 6001;
    sink.station!.ports[2] = { dir: 2, storageIdx: 0 };
    const lab = kit.building(ITEM.matrixLab, 20, 8, 0, { recipeId: 9, role: 'stage:0' });
    const coil = kit.belt(1, 1202, line([0, 5], [30, 5]), { source: { buildingId: source.id, port: 0 } });
    const board = kit.belt(1, 1301, line([0, 6], [30, 6]), { source: { buildingId: source.id, port: 1 } });
    const out = kit.belt(1, 6001, line([0, 12], [30, 12]), { sink: { kind: 'port', buildingId: sink.id, port: 2 } });
    kit.sorter(onNode(coil, 20), onSlot(lab, 0), 1, { filterItemId: 1202 });
    kit.sorter(onNode(board, 20), onSlot(lab, 1), 1, { filterItemId: 1301 });
    kit.sorter(onSlot(lab, 2), onNode(out, 20), 1, { filterItemId: 6001 });
    const stage = { ...smelterRowLayout(1).plan.stages[0], recipeId: 9, buildingItemId: ITEM.matrixLab, craftsPerSecond: 1 / 3 };
    const base = smelterRowLayout(1).plan;
    const plan = { ...base, stages: [stage], request: { ...base.request, targetItemId: 6001 }, actualTargetRate: 1 / 3, exports: [{ itemId: 6001, perSecond: 1 / 3 }] };
    const sim = runSimulation(kit.layout(), plan, fixtureData, fixtureEffects, { warmupTicks: 1800, measureTicks: 5400 });
    expect(Math.abs(sim.measuredTargetRate - 1 / 3)).toBeLessThan(0.01);
    expect(sim.deadlocked).toBe(false);
    expect(sim.machineStats[0].busyFraction).toBeGreaterThan(0.95);
  });
});

describe('runSimulation: lab stacks', () => {
  const COIL = 1202;
  const BOARD = 1301;
  const MATRIX = 6001;

  /**
   * `stacks` stacks of `height` Matrix Labs (height 1: lone labs), each fed coils and boards by Mk.III sorters and
   * unloaded by one, on its bottom lab only (a tall stack needs the fast ones: a Mk.I sorter moves 1.5 items/s). The plan is `stacks * height` labs making 1/3 matrix/s each.
   */
  function labs(stacks: number, height: number) {
    const kit = new LayoutKit();
    const source = kit.station(0, 0, 0, ITEM.ils, { station: stationConfig(2) });
    source.station!.slots[0].itemId = COIL;
    source.station!.slots[1].itemId = BOARD;
    source.station!.ports[1] = { dir: 1, storageIdx: 2 };
    const sink = kit.station(0, 60);
    sink.station!.slots[0].itemId = MATRIX;
    sink.station!.ports[2] = { dir: 2, storageIdx: 0 };
    const length = 20 + 10 * stacks;
    const coil = kit.belt(1, COIL, line([0, 5], [length, 5]), { source: { buildingId: source.id, port: 0 } });
    const board = kit.belt(1, BOARD, line([0, 6], [length, 6]), { source: { buildingId: source.id, port: 1 } });
    const out = kit.belt(1, MATRIX, line([0, 12], [length, 12]), { sink: { kind: 'port', buildingId: sink.id, port: 2 } });
    for (let k = 0; k < stacks; k++) {
      const x = 20 + 10 * k;
      let below: number | undefined;
      for (let level = 0; level < height; level++) {
        const lab = kit.building(ITEM.matrixLab, x, 8, 0, {
          recipeId: 9,
          role: 'stage:0',
          z: 3 * level,
          ...(below === undefined ? {} : { stackParentId: below }),
        });
        below = lab.id;
        if (level > 0) continue;
        kit.sorter(onNode(coil, x), onSlot(lab, 0), 1, { filterItemId: COIL, tierItemId: ITEM.sorter.mk3 });
        kit.sorter(onNode(board, x), onSlot(lab, 1), 1, { filterItemId: BOARD, tierItemId: ITEM.sorter.mk3 });
        kit.sorter(onSlot(lab, 2), onNode(out, x), 1, { filterItemId: MATRIX, tierItemId: ITEM.sorter.mk3 });
      }
    }
    const count = stacks * height;
    const base = smelterRowLayout(1).plan;
    const stage = {
      ...base.stages[0],
      recipeId: 9,
      buildingItemId: ITEM.matrixLab,
      machines: count,
      exactMachines: count,
      craftsPerSecond: count / 3,
      inputs: [
        { itemId: COIL, perSecond: count / 3 },
        { itemId: BOARD, perSecond: count / 3 },
      ],
      outputs: [{ itemId: MATRIX, perSecond: count / 3 }],
    };
    const plan = {
      ...base,
      stages: [stage],
      request: { ...base.request, targetItemId: MATRIX },
      actualTargetRate: count / 3,
      exports: [{ itemId: MATRIX, perSecond: count / 3 }],
    };
    return { kit, plan };
  }
  const simulateLabs = (rig: ReturnType<typeof labs>) =>
    runSimulation(rig.kit.layout(), rig.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 18000 });

  it('6 Matrix Labs as 2 stacks of 3 make the matrices of 6 labs (within 2 %)', () => {
    const flat = simulateLabs(labs(6, 1));
    const stacked = simulateLabs(labs(2, 3));
    expect(Math.abs(flat.measuredTargetRate - 2)).toBeLessThan(0.04);
    expect(Math.abs(stacked.measuredTargetRate - flat.measuredTargetRate)).toBeLessThanOrEqual(0.02 * flat.measuredTargetRate);
    expect(stacked.deadlocked).toBe(false);
    expect(stacked.warnings).toEqual([]);
    // every lab of the stacks worked, the unfed upper ones too
    expect(stacked.machineStats).toHaveLength(6);
    for (const m of stacked.machineStats) expect(m.busyFraction).toBeGreaterThan(0.95);
  });

  it('a stack of 6 labs fed only at the bottom makes 6 labs of matrices', () => {
    const six = simulateLabs(labs(1, 6));
    expect(Math.abs(six.measuredTargetRate - 2)).toBeLessThan(0.04);
  });

  it('links a Self-evolution Lab to the Matrix Lab under it: the labs mix in one stack (mechanics.md §8)', () => {
    const rig = labs(1, 2);
    const layout = rig.kit.layout();
    layout.buildings = layout.buildings.map((b) => (b.stackParentId === undefined ? b : { ...b, itemId: 2902 }));
    const sim = runSimulation(layout, rig.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 18000 });
    expect(sim.warnings).toEqual([]);
    // the upper lab is fed through the bottom one and works
    expect(sim.machineStats[1].crafts).toBeGreaterThan(0);
  });

  it('without the links the upper labs would starve: that is what the stackParentId buys', () => {
    const rig = labs(2, 3);
    const layout = rig.kit.layout();
    layout.buildings = layout.buildings.map((b) => ({ ...b, stackParentId: undefined }));
    const sim = runSimulation(layout, rig.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 18000 });
    expect(sim.measuredTargetRate).toBeLessThan(0.4 * 6 / 3 + 0.05);
  });
});

describe('runSimulation: spray coaters', () => {
  /**
   * The smelter row with a coater on the ore belt before the first smelter, and a Mk.III proliferator belt over its top
   * passage. The ore belt flows east along y = 5, so the coater on its node 6, (6, 5), is turned 90 and its top passage is
   * the node upstream of it, (5, 5), one level up: the proliferator belt crosses there, from a station of its own.
   */
  function sprayedRow(prolifLine: [number, number][] = [[5, 3], [5, 12]]): { layout: Layout; row: ReturnType<typeof smelterRowLayout> } {
    const row = smelterRowLayout(3);
    const prolifSource = row.kit.station(0, 30, 0, ITEM.ils, { station: stationConfig(1) });
    prolifSource.station!.slots[0].itemId = 1143;
    row.kit.belt(1, 1143, line(prolifLine[0], prolifLine[1], 1), { source: { buildingId: prolifSource.id, port: 0 } });
    const coater = row.kit.coater(row.ore, 6);
    expect(coater.yaw).toBe(90);
    return { layout: row.kit.layout(), row };
  }

  it('sprays the ore so the smelters make 25 % more ingots', () => {
    const { layout, row } = sprayedRow();
    expect(layout.belts[2].nodes.find((p) => p.x === 5 && p.y === 5)).toEqual({ x: 5, y: 5, z: 1 });
    const sim = runSimulation(layout, row.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 7200 });
    expect(sim.warnings).toEqual([]);
    expect(Math.abs(sim.measuredTargetRate - 3.75)).toBeLessThan(0.1);
    const plain = simulate(smelterRowLayout(3), { warmupTicks: 3600, measureTicks: 7200 });
    expect(plain.measuredTargetRate).toBeLessThan(3.05);
    // Work power is drawn by the Mk.III-sprayed smelters (x2.5), so the average power rises.
    expect(sim.power.steadyW).toBeGreaterThan(plain.power.steadyW * 2);
  });

  it('reads the proliferator from the belt at the exact top passage, not from one that merely passes near', () => {
    // one node downstream of the coater, one node upstream but on the ground, and two levels up: none feeds it
    for (const [name, nodes, z] of [
      ['downstream', [[7, 3], [7, 12]], 1],
      ['two nodes upstream', [[4, 3], [4, 12]], 1],
      ['two levels up', [[5, 3], [5, 12]], 2],
    ] as const) {
      const { layout, row } = sprayedRow(nodes as unknown as [number, number][]);
      for (const p of layout.belts[2].nodes) p.z = z;
      const sim = runSimulation(layout, row.plan, fixtureData, fixtureEffects, FAST);
      expect(sim.warnings.join('\n'), name).toMatch(/coater \d+.*no proliferator belt/);
      expect(sim.coaters.proliferatorPerSecond, name).toBe(0);
    }
  });

  it('counts what the coaters sprayed and the proliferator they took from the belt', () => {
    const { layout, row } = sprayedRow();
    const sim = runSimulation(layout, row.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 7200 });
    expect(sim.coaters.count).toBe(1);
    // the three smelters eat 3 ore/s; every cargo that passes the coater is sprayed
    expect(Math.abs(sim.coaters.sprayedItems / sim.measureSeconds - 3)).toBeLessThan(0.15);
    // Mk.III: 60 sprays an item (and a few more for a stack that was itself sprayed: none here)
    expect(sim.coaters.proliferatorPerSecond).toBeGreaterThan(0);
    expect(Math.abs(sim.coaters.proliferatorPerSecond - 3 / 60)).toBeLessThan(0.02);
  });

  it('counts the coater\'s draw in the power it reports: idle with nothing to spray, work while it sprays', () => {
    // a belt of ore from one station to another, no machine and no sorter: the coater is the only consumer
    const rig = (prolifNodes: number) => {
      const pair = stationPairLayout(1, 14);
      const prolifSource = pair.kit.station(0, 30, 0, ITEM.ils, { station: stationConfig(1) });
      prolifSource.station!.slots[0].itemId = 1143;
      if (prolifNodes > 0) pair.kit.belt(1, 1143, line([6, 3], [6, 8], 1), { source: { buildingId: prolifSource.id, port: 0 } });
      pair.kit.coater(pair.belt, 7);
      const plan = { ...planOf([]), actualTargetRate: 0 };
      return runSimulation(pair.kit.layout(), plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 3600 });
    };
    const def = fixtureData.building(2313)!;
    const work = def.power.workPerTick * 60;
    const idle = def.power.idlePerTick * 60;
    // wired: idle power all the time, work power on each tick it sprays a cargo (one tick per cargo that passes)
    const wired = rig(6);
    expect(wired.coaters.count).toBe(1);
    const cargoPerSecond = wired.coaters.sprayedItems / wired.measureSeconds; // stack 1: one item a cargo
    expect(cargoPerSecond).toBeGreaterThan(5);
    expect(wired.power.steadyW).toBeCloseTo(idle + (cargoPerSecond / 60) * (work - idle), 0);
    expect(wired.power.idleW).toBeCloseTo(idle * (1 - cargoPerSecond / 60), 0);
    expect(wired.power.peakW).toBeCloseTo(work, 6);
    // no proliferator belt over it: not wired, so it is not in the sum, and the run says so
    const unfed = rig(0);
    expect(unfed.coaters.count).toBe(0);
    expect(unfed.power.steadyW).toBe(0);
    expect(unfed.warnings.join('\n')).toMatch(/coater \d+.*never sprays/);
  });

  it('a layout without coaters reports none', () => {
    const sim = simulate(smelterRowLayout(3), FAST);
    expect(sim.coaters).toEqual({ count: 0, sprayedItems: 0, proliferatorPerSecond: 0 });
  });

  it('takes the proliferator mode from the plan unless a building sets its own', () => {
    const { layout, row } = sprayedRow();
    const window = { warmupTicks: 3600, measureTicks: 7200 };
    const speed = { ...row.plan, request: { ...row.plan.request, proliferator: { tier: 3 as const, mode: 'speed' as const } } };
    // Speed mode doubles the smelters, so the 1.5 trips/s of their Mk.I sorters limit them, not the extra products.
    const fast = runSimulation(layout, speed, fixtureData, fixtureEffects, window);
    expect(fast.measuredTargetRate).toBeGreaterThan(4.2);
    expect(fast.measuredTargetRate).toBeLessThan(4.6);
    for (const b of layout.buildings) if (b.recipeId !== undefined) b.prolifMode = 0;
    const extra = runSimulation(layout, speed, fixtureData, fixtureEffects, window);
    expect(Math.abs(extra.measuredTargetRate - 3.75)).toBeLessThan(0.1);
  });

  it('is inert when the layout has no coaters field, and warns about a coater with no proliferator belt', () => {
    const row = smelterRowLayout(3);
    expect('coaters' in row.kit.layout()).toBe(false);
    row.kit.coater(row.ore, 6);
    const sim = runSimulation(row.kit.layout(), row.plan, fixtureData, fixtureEffects, FAST);
    expect(sim.warnings.join('\n')).toMatch(/coater \d+.*proliferator belt/);
    expect(sim.measuredTargetRate).toBeGreaterThan(2.9);
  });

  it('a coater on a belt or node that is not there is an error, like a sorter on one', () => {
    const row = smelterRowLayout(3);
    row.kit.coaters.push({ id: 7, beltId: 99, node: 6, yaw: 90 });
    expect(() => runSimulation(row.kit.layout(), row.plan, fixtureData, fixtureEffects, FAST)).toThrow(/coater 7/);
  });
});

describe('runSimulation: aborting and capping the warm-up (Task 27)', () => {
  it('asks shouldAbort every ABORT_CHECK_TICKS ticks, in the warm-up and in the measurement, and a run that is not aborted reads the same', () => {
    const row = smelterRowLayout(3);
    let asked = 0;
    const watched = simulate(row, { ...FAST, shouldAbort: () => (asked++, false) });
    expect(asked).toBe(Math.ceil(FAST.warmupTicks / ABORT_CHECK_TICKS) + Math.ceil(FAST.measureTicks / ABORT_CHECK_TICKS));
    expect(watched).toEqual(simulate(smelterRowLayout(3), FAST));
  });

  it('stops with a SimulationAborted at the first yes, in the warm-up', () => {
    const row = smelterRowLayout(3);
    let asked = 0;
    expect(() => simulate(row, { shouldAbort: () => ++asked > 2 })).toThrow(SimulationAborted);
    expect(asked).toBe(3); // the third question, at tick 1200, ended it: the adaptive warm-up had not even finished a window
  });

  it('stops with a SimulationAborted in the measurement too', () => {
    const row = smelterRowLayout(3);
    const warmupAsks = Math.ceil(FAST.warmupTicks / ABORT_CHECK_TICKS);
    let asked = 0;
    expect(() => simulate(row, { ...FAST, shouldAbort: () => ++asked > warmupAsks + 2 })).toThrow(SimulationAborted);
  });

  it('a warm-up cap that the block settles within changes nothing: the same warm-up and the same measurement', () => {
    const plain = simulate(smelterRowLayout(3));
    expect(plain.warmupTicksUsed).toBeGreaterThanOrEqual(7200);
    const capped = simulate(smelterRowLayout(3), { warmupCapTicks: plain.warmupTicksUsed });
    expect(capped).toEqual(plain);
    expect(simulate(smelterRowLayout(3), { warmupCapTicks: 4 * plain.warmupTicksUsed })).toEqual(plain);
    // one window less and it is given up on
    expect(() => simulate(smelterRowLayout(3), { warmupCapTicks: plain.warmupTicksUsed - 3600 })).toThrow(WarmupNotSettled);
  });

  it('a warm-up cap that comes first ends the run with a WarmupNotSettled that names the ticks, and nothing is measured', () => {
    const row = smelterRowLayout(3);
    let asked = 0;
    let thrown: unknown;
    try {
      simulate(row, { warmupCapTicks: 3600, shouldAbort: () => (asked++, false) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WarmupNotSettled);
    expect((thrown as WarmupNotSettled).ticks).toBe(3600);
    expect((thrown as WarmupNotSettled).message).toMatch(/3600 warm-up ticks/);
    expect(asked).toBe(3600 / ABORT_CHECK_TICKS); // the warm-up only
  });

  it('a block that never settles is given up on at the cap instead of running to MAX_WARMUP_TICKS', () => {
    const dead = smelterRowLayout(3, { deadEnd: true });
    expect(() => simulate(dead, { warmupCapTicks: 10800 })).toThrow(WarmupNotSettled);
    // without the cap it runs to the limit and the measurement judges it
    const sim = simulate(smelterRowLayout(3, { deadEnd: true }), { measureTicks: 600 });
    expect(sim.warmupTicksUsed).toBe(MAX_WARMUP_TICKS);
  });

  it('ignores the cap when the warm-up is given, and a cap at or above MAX_WARMUP_TICKS is no cap', () => {
    const row = smelterRowLayout(3, { deadEnd: true });
    expect(simulate(row, { warmupTicks: 1200, measureTicks: 600, warmupCapTicks: 600 }).warmupTicksUsed).toBe(1200);
    const sim = simulate(smelterRowLayout(3, { deadEnd: true }), { measureTicks: 600, warmupCapTicks: MAX_WARMUP_TICKS });
    expect(sim.warmupTicksUsed).toBe(MAX_WARMUP_TICKS);
  });
});
