// Task 28 acceptance: the proliferator network end to end. A Processor line with Mk.III proliferator (extra products)
// goes through `solve` with a 60 s budget and comes out as a layout with spray coaters on its input belts and one belt
// of proliferator past all of them, which passes the full validator (the tick simulation included) at the rate the plan
// (which already counts the +25 %) asks for, with the coaters taking proliferator from the belt. The layout makes a
// blueprint with the coaters written as the capsule sample has them, and the importer reads that blueprint back into a
// layout that the validator and the simulator take as they took the original. Slow: it logs the numbers the report
// quotes (rate, proliferator used, footprint and time with and without the proliferator). Run with `npm run test:e2e`.
import { describe, expect, it } from 'vitest';
import type { ProductionPlan } from '../src/lib/calc';
import { blueprintToLayout, decodeBlueprint, layoutToBlueprintString, regressionPlanFor } from '../src/lib/blueprint';
import type { Layout } from '../src/lib/geometry';
import { buildNetlist } from '../src/lib/layout/netlist';
import { DEFAULT_SOLVE_OPTIONS, footprintOf, solve } from '../src/lib/layout/solver';
import type { SolveOptions, SolveProgress, SolveResult } from '../src/lib/layout/solver';
import { data, effects, processorPlan } from '../src/lib/layout/testkit';
import { checkGeometry, runSimulation, validateLayout } from '../src/lib/validate';
import type { ValidationReport } from '../src/lib/validate';

const log = (line: string): void => void process.stdout.write(`${line}\n`);
const wantedRate = (plan: ProductionPlan): number => plan.exports.find((e) => e.itemId === plan.request.targetItemId)!.perSecond;
const messages = (r: ValidationReport): string[] => r.violations.map((v) => `${v.code}: ${v.message}`);

function solveLogged(
  name: string,
  plan: ProductionPlan,
  over: Partial<SolveOptions>,
): { result: SolveResult; seconds: number; phases: string[] } {
  const t0 = performance.now();
  const phases: string[] = [];
  const result = solve(
    plan,
    data,
    effects,
    { ...DEFAULT_SOLVE_OPTIONS, seed: 1, ...over },
    (p: SolveProgress) => phases.push(p.phase),
    () => {},
    () => false,
  );
  const seconds = (performance.now() - t0) / 1000;
  log(
    `${name}: ${buildNetlist(plan, data, effects).machines.length} machines; footprint ${result.footprint?.toFixed(0)} tiles; ` +
      `${result.attempts} attempts, ${result.validated} validated, stopped by ${result.stoppedBy} after ${seconds.toFixed(1)} s`,
  );
  return { result, seconds, phases };
}

describe('the proliferator network end to end [slow]', () => {
  const BUDGET_MS = 60_000;

  it('Processor with Mk.III proliferator, extra products: coaters on the input belts, a proliferator belt, and it passes', async () => {
    const plan = await processorPlan(1, { tier: 3, mode: 'extra' });
    expect(plan.proliferatorPerSecond).toBeGreaterThan(0);
    const { result, phases } = solveLogged('processor Mk.III extra', plan, { timeBudgetMs: BUDGET_MS });

    expect(result.failures, 'failures').toEqual([]);
    expect(result.layout, 'a layout').not.toBeNull();
    const layout = result.layout as Layout;
    const report = result.report as ValidationReport;
    expect(messages(report)).toEqual([]);
    expect(report.pass).toBe(true);

    // the plan already counts the +25 %: the line delivers its rate
    const sim = report.sim!;
    expect(sim.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wantedRate(plan));
    // the coaters work: they take proliferator from the belt and spray what passes
    expect(layout.coaters!.length).toBeGreaterThan(0);
    expect(sim.coaters.count).toBe(layout.coaters!.length);
    expect(sim.coaters.proliferatorPerSecond).toBeGreaterThan(0);
    expect(sim.coaters.sprayedItems).toBeGreaterThan(0);
    // one coater on every belt that feeds a machine, none on the proliferator belt
    const consumed = new Set(layout.sorters.filter((s) => s.drop.kind === 'building' && s.pick.kind === 'belt').map((s) => (s.pick as { beltId: number }).beltId));
    expect(new Set(layout.coaters!.map((c) => c.beltId))).toEqual(consumed);
    expect(layout.belts.filter((b) => b.itemId === 1143)).toHaveLength(1);

    log(
      `processor Mk.III extra: simulated ${sim.measuredTargetRate.toFixed(3)}/s of ${wantedRate(plan)}/s; ${sim.coaters.count} coaters sprayed ` +
        `${(sim.coaters.sprayedItems / sim.measureSeconds).toFixed(2)} items/s and took ${sim.coaters.proliferatorPerSecond.toFixed(3)} Mk.III/s ` +
        `(plan ${plan.proliferatorPerSecond.toFixed(3)}/s); steady power ${(sim.power.steadyW / 1e6).toFixed(1)} MW; ` +
        `improvement phases ${phases.filter((p) => p.startsWith('improve') && !/failed|no better|no smaller|rejected/.test(p)).length}, ` +
        `margin 3 tried ${phases.filter((p) => /^improve: margin 3/.test(p)).length} times`,
    );

    // a fresh validation of the emitted layout agrees
    const again = validateLayout(layout, plan, data, effects, { measureTicks: 18000 });
    expect(messages(again)).toEqual([]);

    // the blueprint: the coaters are written as the capsule sample has them
    const blueprint = layoutToBlueprintString(layout, data, { shortDesc: 'processor Mk.III', desc: 'proliferator e2e' });
    const bp = decodeBlueprint(blueprint);
    const records = bp.body.buildings;
    const coaterRecords = records.filter((r) => r.itemId === 2313);
    expect(coaterRecords).toHaveLength(layout.coaters!.length);
    for (const r of coaterRecords) {
      expect([r.outputObjIdx, r.inputObjIdx]).toEqual([-1, -1]);
      expect([r.outputToSlot, r.inputFromSlot, r.outputFromSlot, r.inputToSlot, r.outputOffset, r.inputOffset]).toEqual([14, 15, 15, 14, 0, 0]);
      expect(r.parameters).toHaveLength(0);
      expect(records.some((o) => o.outputObjIdx === r.index || o.inputObjIdx === r.index)).toBe(false);
    }
    // the machines carry the extra-products mode
    expect(records.filter((r) => r.itemId === 2305).every((r) => r.parameters[0] === 0)).toBe(true);

    // ...and the importer reads it back: the same coaters, passing the same rules, simulating the same
    const { layout: back, warnings } = blueprintToLayout(bp, data);
    expect(back.coaters).toHaveLength(layout.coaters!.length);
    expect(warnings.filter((w) => /Spray Coater/.test(w))).toEqual([]);
    const geometry = checkGeometry(back, data, effects);
    expect(geometry.filter((v) => v.code === 'COATER_PLACEMENT' || v.code === 'COATER_UNFED').map((v) => v.message)).toEqual([]);
    const regression = regressionPlanFor(back, data, effects, { targetItemId: plan.request.targetItemId });
    const replay = runSimulation(back, regression, data, effects, { warmupTicks: sim.warmupTicksUsed, measureTicks: 18000 });
    log(`processor Mk.III extra, imported back: ${replay.measuredTargetRate.toFixed(3)}/s, ${replay.coaters.count} coaters, ${replay.coaters.proliferatorPerSecond.toFixed(3)} Mk.III/s`);
    expect(replay.coaters.count).toBe(layout.coaters!.length);
    expect(replay.coaters.proliferatorPerSecond).toBeGreaterThan(0);
    expect(replay.measuredTargetRate).toBeGreaterThanOrEqual(0.98 * again.sim!.measuredTargetRate);
    expect(replay.measuredTargetRate).toBeLessThanOrEqual(1.02 * again.sim!.measuredTargetRate);
  }, 300_000);

  it('the same line without a proliferator: no coaters, no feed belt, and fewer constraints on the footprint (the numbers the report compares)', async () => {
    const plain = await processorPlan(1);
    const sprayed = await processorPlan(1, { tier: 3, mode: 'extra' });
    const { result, seconds } = solveLogged('processor, no proliferator', plain, { timeBudgetMs: BUDGET_MS });
    expect(result.report?.pass).toBe(true);
    const layout = result.layout as Layout;
    expect(layout.coaters).toBeUndefined();
    expect(layout.belts.some((b) => b.itemId >= 1141 && b.itemId <= 1143)).toBe(false);
    expect(result.report!.sim!.coaters).toEqual({ count: 0, sprayedItems: 0, proliferatorPerSecond: 0 });
    // the proliferator saves machines: +25 % output for the same inputs
    expect(buildNetlist(sprayed, data, effects).machines.length).toBeLessThan(buildNetlist(plain, data, effects).machines.length);
    log(`processor, no proliferator: footprint ${footprintOf(layout, data).toFixed(0)} in ${seconds.toFixed(1)} s`);
  }, 300_000);

  it('speed mode with Mk.II: the machines carry the speed-up in the blueprint, and the line passes', async () => {
    const plan = await processorPlan(1, { tier: 2, mode: 'speed' });
    const { result } = solveLogged('processor Mk.II speed', plan, { timeBudgetMs: 20_000 });
    expect(result.failures).toEqual([]);
    const layout = result.layout as Layout;
    const report = result.report as ValidationReport;
    expect(messages(report)).toEqual([]);
    expect(report.sim!.measuredTargetRate).toBeGreaterThanOrEqual(0.99 * wantedRate(plan));
    expect(report.sim!.coaters.proliferatorPerSecond).toBeGreaterThan(0);
    const bp = decodeBlueprint(layoutToBlueprintString(layout, data, { shortDesc: 'speed', desc: '' }));
    const machines = bp.body.buildings.filter((r) => r.recipeId !== 0);
    expect(machines.length).toBeGreaterThan(5);
    expect(machines.every((r) => r.parameters[0] === 1)).toBe(true);
    const { layout: back } = blueprintToLayout(bp, data);
    expect(back.buildings.filter((b) => b.recipeId !== undefined).every((b) => b.prolifMode === 1)).toBe(true);
  }, 300_000);

  it('does not use the motifs\' direct sorters even when asked for, where the line without a proliferator does', async () => {
    const asked = { useUnverifiedMotifs: true, timeBudgetMs: 12_000, simulate: false };
    const plain = solveLogged('processor + motifs, no proliferator', await processorPlan(1), asked);
    expect(plain.phases.some((p) => p.startsWith('motif'))).toBe(true);
    const sprayed = solveLogged('processor + motifs, Mk.III', await processorPlan(1, { tier: 3, mode: 'extra' }), asked);
    expect(sprayed.phases.filter((p) => p.startsWith('motif'))).toEqual([]);
    expect(sprayed.result.layout?.sorters.every((s) => s.pick.kind !== 'building' || s.drop.kind !== 'building')).toBe(true);
  }, 120_000);
});
