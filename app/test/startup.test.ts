// Slow start-ups (Task 30b): the validator's warm-up on the plans of the deep chains. A plan that fails its first measurement
// is given more time while it is still starting up (`SimOptions.acceptable`), and only then measured once more; a settled plan
// that fails is not. The two ends of that, on real plans: the settled Processor stops at its normal warm-up, and the 20-stage
// Space Warper (whose rate sits at two thirds of the plan for 250000 ticks and then climbs, with its belts full) is waited for
// well past the point where the total of what its belts hold stops growing.
import { describe, expect, it } from 'vitest';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import type { ProductionPlan } from '../src/lib/calc';
import { buildNetlist } from '../src/lib/layout/netlist';
import { DEFAULT_SOLVE_OPTIONS, solve } from '../src/lib/layout/solver';
import { data, effects, everything, pipelineLayout, processorPlan } from '../src/lib/layout/testkit';
import { runSimulation } from '../src/lib/validate';
import { MAX_FILL_WARMUP_TICKS } from '../src/lib/validate/sim/run';
import { RAW_ITEMS } from './ladderSweep';

describe('the warm-up extension on real plans', () => {
  it('a settled Processor that fails stops at its normal warm-up: the extension costs it nothing', async () => {
    const plan = await processorPlan(1);
    const layout = solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1, simulate: false }, () => {}, () => {}, () => false).layout!;
    const plain = runSimulation(layout, plan, data, effects, {});
    let asked = 0;
    const sim = runSimulation(layout, plan, data, effects, { acceptable: () => (asked++, false) });
    expect(asked).toBe(1);
    expect(sim.warmupTicksUsed).toBeLessThanOrEqual(14_400); // 10800 at the time of writing
    expect(sim).toEqual(plain);
  });

  async function spaceWarper(): Promise<ProductionPlan> {
    const item = data.data.items.find((i) => i.name === 'Space Warper')!;
    const recipe = plannableProducers(item.id, data, effects)[0];
    const facility = compatibleFacilities(recipe, data).find((b) => effects.availableBuildings.has(b.itemId))!;
    const planned = await planProduction(
      {
        targetItemId: item.id,
        quantity: { kind: 'rate', perSecond: 1 },
        finalFacilityItemId: facility.itemId,
        unlockedTechs: everything,
        suppliedItemIds: new Set(RAW_ITEMS),
        facilityOverrides: {},
        recipeOverrides: {},
        proliferator: { tier: 0, mode: 'extra' },
        stationKind: 'planetary',
      },
      data,
      effects,
    );
    if (!planned.ok) throw new Error(`Space Warper: ${planned.error.kind}`);
    return planned.plan;
  }

  it('waits for the 20-stage Space Warper well past the point where its stored total stops growing, and measures once after that', async () => {
    const plan = await spaceWarper();
    const { layout } = pipelineLayout(buildNetlist(plan, data, effects), plan, 3);
    let asked = 0;
    const sim = runSimulation(layout, plan, data, effects, { acceptable: () => (asked++, false) });
    expect(asked).toBe(1); // no window in between is looked at
    // the stored total stops growing at about 740000 ticks (the fill signal alone ended the run there, at 756000, with the rate still
    // climbing to its level of 1.09/s at about 820000-1000000); the rate is what it waits for now
    expect(sim.warmupTicksUsed).toBeGreaterThan(1_000_000);
    expect(sim.warmupTicksUsed).toBeLessThan(MAX_FILL_WARMUP_TICKS);
    expect(sim.measuredTargetRate).toBeGreaterThan(0.9); // the window after it reads the level, not the start-up (it swings, 0.95-1.2)
    expect(sim).toEqual(runSimulation(layout, plan, data, effects, { warmupTicks: sim.warmupTicksUsed }));
  }, 120_000);
});
