// The pipeline end to end on plans of growing size: plan -> netlist -> constructive placement (margin 2) -> taps ->
// routes -> power -> assembled layout -> `validateLayout` with the simulation, on its default (adaptive) warm-up and a
// measurement window of 18000 ticks (5 game minutes). Larger plans used to fall short of their rate in the simulator
// (Processor x6 5.5 of 6/s, Quantum Chip 0.68 of 1/s): producers split across belts, an imported by-product tapped off
// the belt its refineries feed, and a warm-up shorter than the ramp-up (Task 23b). Slow: it logs its runtimes.
import { describe, expect, it } from 'vitest';
import type { ProductionPlan } from '../calc';
import type { Layout } from '../geometry';
import { validateLayout } from '../validate';
import { assembleLayout } from './assemble';
import { buildNetlist } from './netlist';
import { constructivePlacement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { defaultRouteParams, routeNets } from './router';
import { assignTaps } from './taps';
import { data, effects, occupancyOf, planFor, processorPlan } from './testkit';

const MEASURE_TICKS = 18000;
const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: 2303,
  SMELT: 2302,
  CHEMICAL: 2309,
  REFINE: 2308,
  PARTICLE: 2310,
  RESEARCH: 2901,
};

/** 1 Quantum Chip/s on base-tier machines with the raw materials and Hydrogen supplied: the set the e2e tests use. */
const quantumPlan = (): Promise<ProductionPlan> =>
  planFor({
    targetItemId: 1305,
    suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1120]),
    facilityOverrides: Object.fromEntries(
      data.data.recipes.filter((r) => r.type in BASE_TIER_BY_TYPE).map((r) => [r.id, BASE_TIER_BY_TYPE[r.type]] as const),
    ),
    recipeOverrides: { 1114: 16 },
  });

/** The layout of `plan` on the constructive placement with the given margin. */
function layoutFor(plan: ProductionPlan, margin: number): { layout: Layout; machines: number; nets: number } {
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
  return {
    layout: assembleLayout(net, placement, taps, res.routes, poles, plan, data),
    machines: net.machines.length,
    nets: net.nets.length,
  };
}

/** Solve, validate with the simulation, log the runtime and return what the test asserts on. */
async function accept(name: string, plan: ProductionPlan) {
  const t0 = performance.now();
  const { layout, machines, nets } = layoutFor(plan, 2);
  const t1 = performance.now();
  const report = validateLayout(layout, plan, data, effects, { measureTicks: MEASURE_TICKS });
  const t2 = performance.now();
  const sim = report.sim;
  process.stdout.write(
    `${name}: ${machines} machines, ${nets} nets; solve ${(t1 - t0).toFixed(0)} ms, validate ${(t2 - t1).toFixed(0)} ms; ` +
      `warm-up ${sim?.warmupTicksUsed} ticks, ${sim?.measuredTargetRate.toFixed(3)} of ${plan.exports[0].perSecond}/s\n`,
  );
  return { report, sim, wanted: plan.exports.find((e) => e.itemId === plan.request.targetItemId)!.perSecond };
}

const text = (report: ReturnType<typeof validateLayout>): string[] => report.violations.map((v) => `${v.code}: ${v.message}`);

describe('simulated output of larger plans (default adaptive warm-up, 18000 measured ticks)', () => {
  it('Processor x1 reaches its rate', async () => {
    const { report, sim, wanted } = await accept('processor x1', await processorPlan(1));
    expect(text(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wanted);
  }, 600_000);

  it('Processor x6 reaches its rate', async () => {
    const { report, sim, wanted } = await accept('processor x6', await processorPlan(6));
    expect(text(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wanted);
  }, 600_000);

  it('Quantum Chip x1 with the raw materials and Hydrogen supplied reaches its rate', async () => {
    const { report, sim, wanted } = await accept('quantum chip x1', await quantumPlan());
    expect(text(report)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wanted);
    expect(sim!.deadlocked).toBe(false);
  }, 900_000);
});
