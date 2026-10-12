// Fallback ladder sweep (Task 24b): spec §6.2 says that failing to produce a valid layout from the relaxed fallback, for
// any plan the calculator emits, is a bug. So every item `planProduction` can plan at 1/s (all techs unlocked, the raw
// resources supplied, at most 12 recipe stages) is solved with the fallback ladder alone (`timeBudgetMs: 1` ends the
// improvement loop at once) and with the validator's default, adaptive simulation; the layout has to exist and pass a
// plain `validateLayout`. An item that fails is a failure of its own test, with the violations as the message; nothing
// is skipped silently (items the calculator rejects or that need more than 12 stages are listed in the log).
//
// One allowance, the solver's own (`validateWithRetry`): a layout whose only violation is SIM_OUTPUT_LOW, less than 2 %
// short, is measured once more over twice the window, and that verdict stands. It is needed for output that arrives in
// bursts: Hydrogen Fuel Rod makes 4 machines' worth in step, so its 60 s windows alternate between 0.933 and 1.067 of
// the rate and a 300 s window reads 0.987 or 1.000 depending on where it starts (the average is 1.000). The log names
// every item that needed it. The threshold (99 % of the rate) is the validator's, unchanged.
// Slow: about 4 minutes, logging the runtime of every item. Run with `npm run test:e2e`; `npm test` leaves it out.
import { afterAll, describe, expect, it } from 'vitest';
import type { PlanRequest, ProductionPlan } from '../src/lib/calc';
import { planProduction } from '../src/lib/calc';
import { DEFAULT_SOLVE_OPTIONS, solve, validateWithRetry } from '../src/lib/layout/solver';
import { data, effects, everything } from '../src/lib/layout/testkit';
import { validateLayout } from '../src/lib/validate';

/** Items that come from the ground, the sea or the air: supplied, never planned. */
const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
const MAX_STAGES = 12;
const ITEM_TIMEOUT_MS = 1_800_000;

const log = (line: string): void => void process.stdout.write(`${line}\n`);

interface Plannable {
  name: string;
  plan: ProductionPlan;
}

/** Every producible item, planned at 1/s on the first available facility of its first recipe. */
async function plannableItems(): Promise<{ items: Plannable[]; skipped: string[] }> {
  const items: Plannable[] = [];
  const skipped: string[] = [];
  const producible = data.data.items.map((i) => i.id).filter((id) => data.recipesProducing(id).length > 0 && !RAW_ITEMS.includes(id));
  for (const itemId of producible) {
    const name = data.item(itemId).name;
    const recipe = data.recipesProducing(itemId)[0];
    const facility = data.buildingsForRecipeType(recipe.type).find((b) => effects.availableBuildings.has(b.itemId));
    if (!facility) {
      skipped.push(`${name} (no unlocked facility)`);
      continue;
    }
    const request: PlanRequest = {
      targetItemId: itemId,
      quantity: { kind: 'rate', perSecond: 1 },
      finalFacilityItemId: facility.itemId,
      unlockedTechs: everything,
      suppliedItemIds: new Set(RAW_ITEMS),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier: 0, mode: 'extra' },
      stationKind: 'planetary',
    };
    const planned = await planProduction(request, data, effects);
    if (!planned.ok) {
      skipped.push(`${name} (rejected: ${planned.error.kind})`);
    } else if (planned.plan.stages.length < 1 || planned.plan.stages.length > MAX_STAGES) {
      skipped.push(`${name} (${planned.plan.stages.length} stages)`);
    } else {
      items.push({ name, plan: planned.plan });
    }
  }
  return { items, skipped };
}

const { items, skipped } = await plannableItems();

describe('fallback ladder sweep [slow]', () => {
  let passed = 0;
  let seconds = 0;
  const retriedItems: string[] = [];

  it('has plannable items to sweep', () => {
    log(`ladder sweep: ${items.length} plannable items; skipped ${skipped.length}: ${skipped.join('; ') || 'none'}`);
    expect(items.length).toBeGreaterThan(0);
  });

  for (const { name, plan } of items) {
    it(
      name,
      () => {
        const machines = plan.stages.reduce((n, s) => n + s.machines, 0);
        const t0 = performance.now();
        const result = solve(
          plan,
          data,
          effects,
          { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 },
          () => {},
          () => {},
          () => false,
        );
        const solved = (performance.now() - t0) / 1000;
        expect(result.layout, `${name}: no layout; ${result.failures.join(' || ')}`).not.toBeNull();
        let report = validateLayout(result.layout!, plan, data, effects);
        let retried = '';
        if (!report.pass) {
          // see the file comment
          report = validateWithRetry(result.layout!, plan, data, effects, { simulate: true });
          if (report.pass) {
            retried = '; the plain window failed, the 2x window passed';
            retriedItems.push(name);
          }
        }
        const total = (performance.now() - t0) / 1000;
        seconds += total;
        log(
          `${report.pass ? 'ok  ' : 'FAIL'} ${name}: ${plan.stages.length} stages, ${machines} machines, ladder ${solved.toFixed(1)} s, ` +
            `with the validation ${total.toFixed(1)} s${retried}`,
        );
        expect(report.violations.map((v) => `${v.code}: ${v.message}`), name).toEqual([]);
        expect(report.pass, name).toBe(true);
        passed++;
      },
      ITEM_TIMEOUT_MS,
    );
  }

  afterAll(() => {
    log(
      `ladder sweep: ${passed} of ${items.length} plannable items passed, ${seconds.toFixed(0)} s in all; ` +
        `plain validation passed over the 2x window only for: ${retriedItems.join(', ') || 'none'}`,
    );
  });
});
