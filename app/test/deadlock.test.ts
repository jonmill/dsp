// A belt that nothing drains (Task 30b). Deuteron Fuel Rod with Mk.III proliferator: Plasma Refining and Graphene (advanced) both
// make the hydrogen that Deuterium uses, Plasma Refining also makes the oil that the sulfuric acid, the titanium alloy and so the
// fuel rods need. With the hydrogen belt a dead end, the second producer filled it, Plasma Refining blocked on its hydrogen, the oil
// stopped, no fuel rod was made and no hydrogen was used: nothing moved after about 160000 ticks (SIM_DEADLOCK at four of the six
// rungs of the ladder). The belt now ends at a station port for the surplus (`plan.surplus`).
import { describe, expect, it } from 'vitest';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import type { ProductionPlan } from '../src/lib/calc';
import type { Layout } from '../src/lib/geometry';
import { DEFAULT_SOLVE_OPTIONS, solve } from '../src/lib/layout/solver';
import { data, effects, everything } from '../src/lib/layout/testkit';
import { checkSimulation, runSimulation } from '../src/lib/validate';
import type { validateLayout } from '../src/lib/validate';
import { RAW_ITEMS } from './ladderSweep';

async function planOf(name: string, tier: 0 | 3): Promise<ProductionPlan> {
  const item = data.data.items.find((i) => i.name === name)!;
  const facility = compatibleFacilities(plannableProducers(item.id, data, effects)[0], data).find((b) => effects.availableBuildings.has(b.itemId))!;
  const planned = await planProduction(
    {
      targetItemId: item.id,
      quantity: { kind: 'rate', perSecond: 1 },
      finalFacilityItemId: facility.itemId,
      unlockedTechs: everything,
      suppliedItemIds: new Set(RAW_ITEMS),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier, mode: 'extra' },
      stationKind: 'planetary',
    },
    data,
    effects,
  );
  if (!planned.ok) throw new Error(`${name}: ${planned.error.kind}`);
  return planned.plan;
}

describe('Deuteron Fuel Rod with Mk.III proliferator', () => {
  it('no longer deadlocks: every layout the ladder builds still moves 400000 ticks in, and makes the plan\'s rate', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    // the ladder builds a layout per rung; this validator turns each down without simulating, which hands us all of them
    const layouts: Layout[] = [];
    const collect: typeof validateLayout = (layout) => {
      layouts.push(layout);
      return { pass: false, violations: [{ code: 'SIM_OUTPUT_LOW', entities: [], message: 'not simulated' }], checkedAt: '', stage: 'simulation' };
    };
    solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 }, () => {}, () => {}, () => false, collect);
    expect(layouts.length).toBeGreaterThanOrEqual(3);
    for (const [i, layout] of layouts.slice(0, 3).entries()) {
      const sim = runSimulation(layout, plan, data, effects, { warmupTicks: 400_000 });
      expect(sim.deadlocked, `rung ${i}`).toBe(false);
      expect(sim.measuredTargetRate, `rung ${i}`).toBeGreaterThan(0.9);
      expect(checkSimulation(sim, layout, plan, data).filter((v) => v.code === 'SIM_DEADLOCK'), `rung ${i}`).toEqual([]);
    }
  }, 300_000);
});
