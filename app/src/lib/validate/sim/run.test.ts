import { describe, expect, it } from 'vitest';
import { GameDataIndex } from '../../data';
import type { Layout } from '../../geometry';
import { checkSimulation } from '../report';
import { codesOf, fixtureData, fixtureEffects, ITEM, LayoutKit, line, only, onNode, onSlot, planOf, refineryLayout, smelterRowLayout, stationConfig, stationPairLayout } from '../testkit';
import { runSimulation } from './run';
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

  it('stops once two consecutive windows agree within 1 %, though the provisioned rate is never reached', () => {
    const row = smelterRowLayout(3);
    row.plan.exports = [{ itemId: 1101, perSecond: 5 }]; // the row makes 3/s
    const sim = simulate(row, { measureTicks: 3600 });
    expect(sim.warmupTicksUsed).toBeGreaterThanOrEqual(7200);
    expect(sim.warmupTicksUsed).toBeLessThan(18000);
    expect(Math.abs(sim.measuredTargetRate - 3)).toBeLessThan(0.05);
  });

  it('does not take two windows without any output as agreeing: a block that makes nothing runs to the 72000-tick cap', () => {
    const row = smelterRowLayout(3);
    row.ore.source = undefined; // no ore ever enters
    const sim = simulate(row, { measureTicks: 600 });
    expect(sim.warmupTicksUsed).toBe(72000);
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

describe('runSimulation: spray coaters', () => {
  /** The smelter row with a coater on the ore belt before the first smelter, and a Mk.III proliferator belt above it. */
  function sprayedRow(): { layout: Layout; row: ReturnType<typeof smelterRowLayout> } {
    const row = smelterRowLayout(3);
    const prolifSource = row.kit.station(0, 30, 0, ITEM.ils, { station: stationConfig(1) });
    prolifSource.station!.slots[0].itemId = 1143;
    const prolif = row.kit.belt(1, 1143, line([0, 6], [12, 6], 1), { source: { buildingId: prolifSource.id, port: 0 } });
    const layout = { ...row.kit.layout(), coaters: [{ id: 1, beltId: row.ore.id, node: 6, yaw: 0 }] } as Layout;
    expect(prolif.nodes[6]).toEqual({ x: 6, y: 6, z: 1 });
    return { layout, row };
  }

  it('sprays the ore so the smelters make 25 % more ingots', () => {
    const { layout, row } = sprayedRow();
    const sim = runSimulation(layout, row.plan, fixtureData, fixtureEffects, { warmupTicks: 3600, measureTicks: 7200 });
    expect(sim.warnings).toEqual([]);
    expect(Math.abs(sim.measuredTargetRate - 3.75)).toBeLessThan(0.1);
    const plain = simulate(row, { warmupTicks: 3600, measureTicks: 7200 });
    expect(plain.measuredTargetRate).toBeLessThan(3.05);
    // Work power is drawn by the Mk.III-sprayed smelters (x2.5), so the average power rises.
    expect(sim.power.steadyW).toBeGreaterThan(plain.power.steadyW * 2);
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
    const layout = { ...row.kit.layout(), coaters: [{ id: 1, beltId: row.ore.id, node: 6, yaw: 0 }] } as Layout;
    const sim = runSimulation(layout, row.plan, fixtureData, fixtureEffects, FAST);
    expect(sim.warnings.join('\n')).toMatch(/coater 1.*proliferator belt/);
    expect(sim.measuredTargetRate).toBeGreaterThan(2.9);
  });
});
