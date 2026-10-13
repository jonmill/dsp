// A belt that nothing drains (Task 30b). Deuteron Fuel Rod with Mk.III proliferator: Plasma Refining and Graphene (advanced) both
// make the hydrogen that Deuterium uses, Plasma Refining also makes the oil that the sulfuric acid, the titanium alloy and so the
// fuel rods need. With the hydrogen belt a dead end, the second producer filled it, Plasma Refining blocked on its hydrogen, the oil
// stopped, no fuel rod was made and no hydrogen was used: nothing moved after about 160000 ticks (SIM_DEADLOCK at four of the six
// rungs of the ladder). The ladder builds its layouts without a way out for the surplus (`plan.surplus` lists the candidates), and
// when a rung's validation reports that deadlock it gives the hydrogen belt a station port to end in, from that rung on.
import { describe, expect, it } from 'vitest';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import type { ProductionPlan } from '../src/lib/calc';
import type { Layout } from '../src/lib/geometry';
import { surplusExportsIn } from '../src/lib/calc';
import { DEADLOCK_PROBE_TICKS, DEFAULT_SOLVE_OPTIONS, solve } from '../src/lib/layout/solver';
import { data, effects, everything } from '../src/lib/layout/testkit';
import { checkSimulation, runSimulation, validateLayout } from '../src/lib/validate';
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
  const hydrogen = data.data.items.find((i) => i.name === 'Hydrogen')!.id;

  it('the ladder deadlocks at margin 3 without the sink, switches it on, and passes with it: the layout ends the hydrogen belt at a station', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    const phases: string[] = [];
    const result = solve(
      plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 },
      (p) => { if (p.phase.startsWith('ladder:')) phases.push(p.phase); }, () => {}, () => false,
    );
    expect(phases[0]).toBe('ladder: margin 3 deadlocked; Hydrogen gets a surplus export from here on');
    expect(result.failures.some((f) => f.startsWith('margin 3: SIM_DEADLOCK'))).toBe(true);
    expect(phases.at(-1)).toMatch(/^ladder: margin \d \(surplus export\)$/); // the rung that passed says it had the sink
    expect(result.layout).not.toBeNull();
    expect(result.report!.pass).toBe(true);
    expect(surplusExportsIn(result.layout!, plan).map((s) => s.itemId)).toEqual([hydrogen]);
    expect(validateLayout(result.layout!, plan, data, effects).pass).toBe(true); // plain validateLayout agrees
  }, 300_000);

  it('the layout built without the sink deadlocks, and the ones built with it move 400000 ticks in and make the plan\'s rate', async () => {
    const plan = await planOf('Deuteron Fuel Rod', 3);
    // the ladder builds a layout per rung; this validator says the first deadlocks (without simulating it) and turns each other down
    // without simulating, which hands us all of them
    const layouts: Layout[] = [];
    const collect: typeof validateLayout = (layout) => {
      layouts.push(layout);
      const code = layouts.length === 1 ? 'SIM_DEADLOCK' : 'SIM_OUTPUT_LOW';
      return { pass: false, violations: [{ code, entities: [], message: 'not simulated' }], checkedAt: '', stage: 'simulation' };
    };
    solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 }, () => {}, () => {}, () => false, collect);
    expect(layouts.length).toBeGreaterThanOrEqual(3);
    expect(surplusExportsIn(layouts[0], plan)).toEqual([]);
    const bare = runSimulation(layouts[0], plan, data, effects, { warmupTicks: 400_000 });
    expect(bare.deadlocked).toBe(true);
    expect(bare.measuredTargetRate).toBe(0);
    for (const [i, layout] of layouts.slice(1, 3).entries()) {
      expect(surplusExportsIn(layout, plan).map((s) => s.itemId), `rung ${i + 1}`).toEqual([hydrogen]);
      const sim = runSimulation(layout, plan, data, effects, { warmupTicks: 400_000 });
      expect(sim.deadlocked, `rung ${i + 1}`).toBe(false);
      expect(sim.measuredTargetRate, `rung ${i + 1}`).toBeGreaterThan(0.9);
      expect(checkSimulation(sim, layout, plan, data).filter((v) => v.code === 'SIM_DEADLOCK'), `rung ${i + 1}`).toEqual([]);
    }
  }, 300_000);
});

// A deadlock that comes after the start-up (Task 30b round 3). Crystal Explosive Unit with Mk.III proliferator (14 machines): the
// ladder's first layout passes validateLayout (1.04/s after 54000 ticks of warm-up) and moves for 160000 ticks, and from about
// 240000 on nothing moves, for good, because the hydrogen belt its two producers share is full and one of them blocks. The ladder
// watches a sinkless layout of a plan with surplus candidates to DEADLOCK_PROBE_TICKS before it takes it.
describe('Crystal Explosive Unit with Mk.III proliferator', () => {
  const hydrogen = data.data.items.find((i) => i.name === 'Hydrogen')!.id;

  it('the premise: the sinkless layout passes validateLayout, is fine at 160000 ticks, and is stuck at 400000', async () => {
    const plan = await planOf('Crystal Explosive Unit', 3);
    const layouts: Layout[] = [];
    // the validator without the probe, as plain validateLayout is: the first rung's layout passes
    const noProbe: typeof validateLayout = (layout, p, d, fx, o) => {
      layouts.push(layout);
      return validateLayout(layout, p, d, fx, { ...o, deadlockProbeTicks: undefined });
    };
    const result = solve(plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 }, () => {}, () => {}, () => false, noProbe);
    expect(result.report!.pass).toBe(true);
    const bare = layouts[0];
    expect(surplusExportsIn(bare, plan)).toEqual([]);
    expect(validateLayout(bare, plan, data, effects).pass).toBe(true); // plain validateLayout takes it
    expect(runSimulation(bare, plan, data, effects, { warmupTicks: 160_000 }).deadlocked).toBe(false);
    const late = runSimulation(bare, plan, data, effects, { warmupTicks: 400_000 });
    expect(late.deadlocked).toBe(true);
    expect(late.measuredTargetRate).toBe(0);
  }, 300_000);

  it('the ladder returns a layout with the surplus export, built from margin 3 on, that moves to the probe horizon', async () => {
    const plan = await planOf('Crystal Explosive Unit', 3);
    const phases: string[] = [];
    const result = solve(
      plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 },
      (p) => { if (p.phase.startsWith('ladder:')) phases.push(p.phase); }, () => {}, () => false,
    );
    expect(phases).toEqual(['ladder: margin 3 deadlocked; Hydrogen gets a surplus export from here on', 'ladder: margin 3 (surplus export)']);
    expect(result.failures.some((f) => f.startsWith('margin 3: SIM_DEADLOCK') && f.includes('of the run nothing did'))).toBe(true);
    expect(result.layout).not.toBeNull();
    expect(surplusExportsIn(result.layout!, plan).map((s) => s.itemId)).toEqual([hydrogen]);
    expect(validateLayout(result.layout!, plan, data, effects).pass).toBe(true);
    const horizon = runSimulation(result.layout!, plan, data, effects, { warmupTicks: DEADLOCK_PROBE_TICKS });
    expect(horizon.deadlocked).toBe(false);
    expect(horizon.measuredTargetRate).toBeGreaterThan(0.99);
  }, 300_000);

  it('a plan whose sinkless layout does not get stuck keeps it: Crystal Explosive Unit, plain', async () => {
    const plan = await planOf('Crystal Explosive Unit', 0);
    const phases: string[] = [];
    const result = solve(
      plan, data, effects, { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 },
      (p) => { if (p.phase.startsWith('ladder:')) phases.push(p.phase); }, () => {}, () => false,
    );
    expect(phases).toEqual(['ladder: margin 3']);
    expect(surplusExportsIn(result.layout!, plan)).toEqual([]);
    expect(runSimulation(result.layout!, plan, data, effects, { warmupTicks: DEADLOCK_PROBE_TICKS }).deadlocked).toBe(false);
  }, 300_000);
});
