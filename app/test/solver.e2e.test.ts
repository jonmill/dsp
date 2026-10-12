// M3 acceptance (Task 24): the solver on real plans of growing size. Each plan must come out of `solve` as a layout
// that passes the full validator (the simulation included) and delivers its provisioned rate, and the layout must make
// a blueprint string that decodes. The solver runs with the app's simulation settings (adaptive warm-up, 18000
// measured ticks): the simulator is fast enough (see the ticks/s test) that the short windows the plan suggested
// (1800 warm-up, 3600 measured) buy nothing, and they cost correctness: a 60 s window can read one item short of the
// rate (0.983 of 1/s) which the validator tolerates but the 0.99 assertion here does not, and the Processor on Mk.II
// belts has not filled its chain after 1800 ticks (0.63 of 1/s; at 7200 ticks it reaches the full rate). Slow: it
// logs its runtimes. The property test checks every layout the solver emits for random plans. Run with
// `npm run test:e2e` (about 2 minutes); `npm test` leaves it out.
import { describe, expect, it } from 'vitest';
import type { PlanRequest, ProductionPlan } from '../src/lib/calc';
import { planProduction } from '../src/lib/calc';
import { decodeBlueprint, layoutToBlueprintString } from '../src/lib/blueprint';
import type { Layout } from '../src/lib/geometry';
import { buildNetlist } from '../src/lib/layout/netlist';
import { Rng } from '../src/lib/layout/rng';
import { DEFAULT_SOLVE_OPTIONS, footprintOf, solve } from '../src/lib/layout/solver';
import type { SolveOptions, SolveResult } from '../src/lib/layout/solver';
import { data, effects, everything, matrixPlan, planFor, processorPlan, SMELTER } from '../src/lib/layout/testkit';
import { runSimulation, validateLayout } from '../src/lib/validate';
import type { ValidationReport } from '../src/lib/validate';

const BUDGET_MS = 20_000;
const MIN_TICKS_PER_SECOND = 2000;

const wantedRate = (plan: ProductionPlan): number => plan.exports.find((e) => e.itemId === plan.request.targetItemId)!.perSecond;
const messages = (r: ValidationReport): string[] => r.violations.map((v) => `${v.code}: ${v.message}`);
const log = (line: string): void => void process.stdout.write(`${line}\n`);

/** Runs the solver for `BUDGET_MS`, logging the improvements as they come. */
function solveLogged(name: string, plan: ProductionPlan, over: Partial<SolveOptions>, fx = effects): { result: SolveResult; seconds: number } {
  const t0 = performance.now();
  const stamps: string[] = [];
  const result = solve(
    plan,
    data,
    fx,
    { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: BUDGET_MS, seed: 1, ...over },
    () => {},
    (_l, _r, footprint) => stamps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s:${footprint.toFixed(0)}`),
    () => false,
  );
  const seconds = (performance.now() - t0) / 1000;
  const machines = buildNetlist(plan, data, fx).machines.length;
  log(
    `${name}: ${machines} machines; footprint ${result.footprint?.toFixed(0)} tiles; ${result.attempts} attempts, ${result.validated} validated, ` +
      `stopped by ${result.stoppedBy} after ${seconds.toFixed(1)} s; improvements ${stamps.join(' ')}`,
  );
  return { result, seconds };
}

/** The assertions of the acceptance: a layout, a pass, the rate, the blueprint, then the validator again on the layout. */
function expectAcceptable(name: string, plan: ProductionPlan, result: SolveResult, fx = effects): Layout {
  expect(result.failures, 'failures').toEqual([]);
  expect(result.layout, `${name}: a layout`).not.toBeNull();
  const layout = result.layout as Layout;
  const report = result.report as ValidationReport;
  expect(messages(report)).toEqual([]);
  expect(report.pass).toBe(true);
  expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wantedRate(plan));
  expect(result.footprint).toBeCloseTo(footprintOf(layout, data), 9);

  const blueprint = layoutToBlueprintString(layout, data, { shortDesc: name, desc: 'solver e2e' });
  const decoded = decodeBlueprint(blueprint);
  expect(decoded.body.buildings.length).toBeGreaterThan(layout.buildings.length);

  const t0 = performance.now();
  const full = validateLayout(layout, plan, data, fx, { measureTicks: 18000 });
  log(`${name}: validated again ${full.sim?.measuredTargetRate.toFixed(3)} of ${wantedRate(plan)}/s, warm-up ${full.sim?.warmupTicksUsed} ticks (${(performance.now() - t0).toFixed(0)} ms)`);
  expect(messages(full)).toEqual([]);
  expect(full.pass).toBe(true);
  return layout;
}

describe('solver end to end [slow]', () => {
  it('(a) 3 Iron Ingots/s', async () => {
    const plan = await planFor({
      targetItemId: 1101,
      finalFacilityItemId: SMELTER,
      quantity: { kind: 'rate', perSecond: 3 },
      suppliedItemIds: new Set([1001]),
    });
    const { result } = solveLogged('iron ingots 3/s', plan, {});
    expectAcceptable('iron ingots 3/s', plan, result);
  }, 180_000);

  it('(b) 1 Circuit Board/s from iron and copper ore', async () => {
    const plan = await planFor({ targetItemId: 1301, suppliedItemIds: new Set([1001, 1002]) });
    const { result } = solveLogged('circuit board 1/s', plan, {});
    expectAcceptable('circuit board 1/s', plan, result);
  }, 180_000);

  it('(c) 1 Processor/s from ores on Mk.III assemblers and Mk.II belts', async () => {
    // no Mk.III belt unlocked: the netlist takes the best belt there is, Mk.II
    const mk2 = { ...effects, availableBuildings: new Set([...effects.availableBuildings].filter((id) => id !== 2003)) };
    const plan = await processorPlan(1);
    expect(buildNetlist(plan, data, mk2).beltTierItemId).toBe(2002);
    const { result } = solveLogged('processor 1/s (Mk.II belts)', plan, {}, mk2);
    const layout = expectAcceptable('processor 1/s (Mk.II belts)', plan, result, mk2);
    expect(new Set(layout.belts.map((b) => b.tierItemId))).toEqual(new Set([2002]));

    // the simulator's speed on the finished layout
    const warmup = 1800;
    const measure = 18000;
    const t0 = performance.now();
    const sim = runSimulation(layout, plan, data, mk2, { warmupTicks: warmup, measureTicks: measure });
    const seconds = (performance.now() - t0) / 1000;
    const ticksPerSecond = (warmup + measure) / seconds;
    log(`simulator on the processor layout: ${(warmup + measure)} ticks in ${seconds.toFixed(2)} s = ${ticksPerSecond.toFixed(0)} ticks/s (${sim.measuredTargetRate.toFixed(3)}/s)`);
    expect(ticksPerSecond).toBeGreaterThanOrEqual(MIN_TICKS_PER_SECOND);
  }, 180_000);

  it('(c) 1 Processor/s from ores on Mk.III assemblers and the best belts unlocked (Mk.III)', async () => {
    const plan = await processorPlan(1);
    const { result } = solveLogged('processor 1/s (Mk.III belts)', plan, { timeBudgetMs: 10_000 });
    expectAcceptable('processor 1/s (Mk.III belts)', plan, result);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// Dense motifs (Task 26)

const MOTIF_ITERATIONS = 24;

/**
 * Solves on a clock that moves one second per iteration of the ordinary chain (the ladder rungs and the improvement
 * iterations that work on the plain netlist) and not at all for the motif chains. A run with motifs and a run without
 * therefore get the same budget of ordinary iterations; the ordinary chain draws from its own random source, so it
 * does exactly the same in both, and the run with motifs can only have more candidates to choose its best from.
 */
function solveCounted(name: string, plan: ProductionPlan, over: Partial<SolveOptions>, fx = effects): SolveResult {
  const clock = { t: 0 };
  const t0 = performance.now();
  const result = solve(
    plan,
    data,
    fx,
    { ...DEFAULT_SOLVE_OPTIONS, seed: 1, timeBudgetMs: MOTIF_ITERATIONS * 1000, minRunMs: 1e9, ...over, now: () => clock.t },
    (p) => {
      if (p.phase !== 'done' && !p.phase.startsWith('motif')) clock.t += 1000;
    },
    () => {},
    () => false,
  );
  const sorters = result.layout?.sorters.filter((s) => s.pick.kind === 'building' && s.drop.kind === 'building').length;
  const stacked = result.layout?.buildings.filter((b) => b.stackParentId !== undefined).length;
  log(
    `${name}: footprint ${result.footprint?.toFixed(0)} tiles; ${result.attempts} attempts, ${result.validated} validated; ` +
      `${sorters} sorters between buildings, ${stacked} stacked labs; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
  return result;
}

describe('solver with dense motifs end to end [slow]', () => {
  it('(d) 1 Processor/s with useUnverifiedMotifs passes the validator and is no larger than without (same seed, same budget)', async () => {
    const plan = await processorPlan(1);
    const without = solveCounted('processor 1/s without motifs', plan, {});
    const withMotifs = solveCounted('processor 1/s with motifs', plan, { useUnverifiedMotifs: true });
    expectAcceptable('processor 1/s without motifs', plan, without);
    const layout = expectAcceptable('processor 1/s with motifs', plan, withMotifs);
    expect(withMotifs.footprint as number).toBeLessThanOrEqual(without.footprint as number);
    log(`processor: ${(without.footprint as number).toFixed(0)} tiles without motifs, ${(withMotifs.footprint as number).toFixed(0)} with`);
    // the motif layout is the one that was asked for: the same machines
    expect(layout.buildings.filter((b) => b.recipeId !== undefined)).toHaveLength(
      without.layout!.buildings.filter((b) => b.recipeId !== undefined).length,
    );
  }, 600_000);

  it('(e) 2 Electromagnetic Matrix/s: the six labs stack up to labLevel, the layout passes, and it is smaller than without motifs', async () => {
    const plan = await matrixPlan(2);
    const fx = { ...effects, labLevel: 3 };
    const without = solveCounted('matrix 2/s without motifs', plan, {}, fx);
    const withMotifs = solveCounted('matrix 2/s with motifs (labLevel 3)', plan, { useUnverifiedMotifs: true }, fx);
    expectAcceptable('matrix 2/s without motifs', plan, without, fx);
    const layout = expectAcceptable('matrix 2/s with motifs', plan, withMotifs, fx);
    expect(withMotifs.footprint as number).toBeLessThanOrEqual(without.footprint as number);
    expect(withMotifs.footprint as number).toBeLessThan(without.footprint as number);
    const labs = layout.buildings.filter((b) => b.itemId === 2901);
    expect(labs).toHaveLength(6);
    expect(labs.some((b) => b.stackParentId !== undefined)).toBe(true);
    expect(Math.max(...labs.map((b) => b.z))).toBeLessThanOrEqual(6);
    // the same layout is not valid where labs may only stack 2 high
    const tooTall = validateLayout(layout, plan, data, { ...fx, labLevel: 2 }, { simulate: false });
    expect(tooTall.pass).toBe(false);
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------
// Property test (spec §11)

/** Items that come from the ground, the sea or the air: what a plan may start from. */
const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
/** The most recipe stages a random plan may have (from the raw items). */
const MAX_STAGES = 3;
const PROPERTY_PLANS = 5;
const PROPERTY_BUDGET_MS = 10_000;

/** The seeded random plans: a random producible item at a random rate of 0.5 to 3 per second, up to 3 stages deep. */
async function randomPlans(seed: number, count: number): Promise<{ name: string; plan: ProductionPlan }[]> {
  const rng = new Rng(seed);
  const producible = data.data.items.map((i) => i.id).filter((id) => data.recipesProducing(id).length > 0 && !RAW_ITEMS.includes(id));
  const plans: { name: string; plan: ProductionPlan }[] = [];
  for (let tries = 0; plans.length < count && tries < 500; tries++) {
    const itemId = producible[rng.int(producible.length)];
    if (plans.some((p) => p.plan.request.targetItemId === itemId)) continue;
    const rate = Math.round((0.5 + 2.5 * rng.next()) * 100) / 100;
    const recipe = data.recipesProducing(itemId)[0];
    const facility = data.buildingsForRecipeType(recipe.type).find((b) => effects.availableBuildings.has(b.itemId));
    if (!facility) continue;
    const request: PlanRequest = {
      targetItemId: itemId,
      quantity: { kind: 'rate', perSecond: rate },
      finalFacilityItemId: facility.itemId,
      unlockedTechs: everything,
      suppliedItemIds: new Set(RAW_ITEMS),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier: 0, mode: 'extra' },
      stationKind: 'planetary',
    };
    const planned = await planProduction(request, data, effects);
    if (!planned.ok || planned.plan.stages.length < 1 || planned.plan.stages.length > MAX_STAGES) continue;
    if (!planned.plan.exports.some((e) => e.itemId === itemId)) continue;
    plans.push({ name: `${data.item(itemId).name} ${rate}/s (${planned.plan.stages.length} stages)`, plan: planned.plan });
  }
  expect(plans).toHaveLength(count);
  return plans;
}

describe('solver property test [slow]', () => {
  it(`every layout emitted for ${PROPERTY_PLANS} seeded random feasible plans passes the validator with the simulation`, async () => {
    const plans = await randomPlans(24, PROPERTY_PLANS);
    for (const [k, { name, plan }] of plans.entries()) {
      const emitted: { layout: Layout; footprint: number }[] = [];
      const t0 = performance.now();
      const result = solve(
        plan,
        data,
        effects,
        { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: PROPERTY_BUDGET_MS, seed: 100 + k },
        () => {},
        (layout, _report, footprint) => emitted.push({ layout, footprint }),
        () => false,
      );
      const t1 = performance.now();
      log(
        `property ${k + 1}/${PROPERTY_PLANS} ${name}: ${emitted.length} layouts emitted ${emitted.map((e) => e.footprint.toFixed(0)).join(' > ')}; ` +
          `${result.attempts} attempts, ${result.validated} validated, stopped by ${result.stoppedBy}; solve ${((t1 - t0) / 1000).toFixed(1)} s`,
      );
      expect(result.failures, name).toEqual([]);
      expect(emitted.length, `${name}: layouts emitted`).toBeGreaterThanOrEqual(1);
      for (const { layout } of emitted) {
        const report = validateLayout(layout, plan, data, effects, { measureTicks: 18000 });
        expect(messages(report), name).toEqual([]);
        expect(report.pass, name).toBe(true);
        expect(report.stage, name).toBe('simulation');
      }
      log(`property ${k + 1}/${PROPERTY_PLANS}: independent validation of ${emitted.length} layouts ${((performance.now() - t1) / 1000).toFixed(1)} s`);
    }
  }, 900_000);
});
