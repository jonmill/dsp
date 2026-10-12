// Fallback ladder sweep (Task 24b): spec §6.2 says that failing to produce a valid layout from the relaxed fallback, for
// any plan the calculator emits, is a bug. So every item `planProduction` can plan at 1/s (all techs unlocked, the raw
// resources supplied, at most 12 recipe stages) is solved with the fallback ladder alone (`timeBudgetMs: 1` ends the
// improvement loop at once) and with the validator's default, adaptive simulation; the layout has to exist and pass a
// plain `validateLayout`. The facility of the last stage is the first unlocked one that can run the item's first
// plannable recipe (a lab for the matrices, which `buildingsForRecipeType` does not list). An item that fails is a
// failure of its own test, with the violations as the message. Nothing is skipped silently: the items left out are
// listed in `EXPECTED_SKIPPED` and the test fails when the list or the number of items swept changes, so a shrinking
// sweep cannot go unnoticed.
//
// One allowance, and only for the items in `NEEDS_LONGER_WINDOW`: the solver's own (`validateWithRetry`), where a layout
// whose only violation is SIM_OUTPUT_LOW, less than 2 % short, is measured once more over twice the window and that
// verdict stands. Hydrogen Fuel Rod used to need it: its four final-stage machines work in step, so its 60 s windows
// alternate between 0.933 and 1.067 of the rate and a 300 s window reads 0.987 or 1.000 depending on where it starts (the
// average is 1.000). Since Task 27 the ladder keeps a layout that passes only over the doubled window for the end and takes
// the first rung that passes the plain window instead, and Hydrogen Fuel Rod has one, so the list is empty. An item in the
// list that passes the plain validation fails the test, so the list stays honest. The threshold (99 % of the rate) is the
// validator's, unchanged.
// Slow: about 2 minutes, logging the runtime of every item. Run with `npm run test:e2e`; `npm test` leaves it out.
import { afterAll, describe, expect, it } from 'vitest';
import type { PlanRequest, ProductionPlan } from '../src/lib/calc';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import { DEFAULT_SOLVE_OPTIONS, solve, validateWithRetry } from '../src/lib/layout/solver';
import { data, effects, everything } from '../src/lib/layout/testkit';
import { validateLayout } from '../src/lib/validate';

/** Items that come from the ground, the sea or the air: supplied, never planned. */
const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
const MAX_STAGES = 12;
const ITEM_TIMEOUT_MS = 1_800_000;

/** How many items are swept: every producible item but `EXPECTED_SKIPPED`. */
const EXPECTED_PLANNABLE = 102;
/** Items left out of the sweep and why: the calculator has no plan for them, or the plan needs more than 12 stages. */
const NO_RECIPE = 'no plannable recipe';
const TOO_DEEP = `more than ${MAX_STAGES} stages`;
const EXPECTED_SKIPPED: Record<string, string> = {
  Antimatter: NO_RECIPE,
  'Antimatter Capsule': NO_RECIPE,
  'Antimatter Fuel Rod': NO_RECIPE,
  'Strange Annihilation Fuel Rod': NO_RECIPE,
  'Orbital Collector': NO_RECIPE,
  'Re-composing Assembler': NO_RECIPE,
  'Negentropy Smelter': NO_RECIPE,
  'Self-evolution Lab': NO_RECIPE,
  'Universe Matrix': NO_RECIPE,
  ...Object.fromEntries(
    [
      'Space Warper',
      'Quantum Chip',
      'Reinforced Thruster',
      'Dyson Sphere Component',
      'Small Carrier Rocket',
      'Crystal Shell Set',
      'Supersonic Missile Set',
      'Gravity Missile Set',
      'Suppressing Capsule',
      'Deuteron Fuel Rod',
      'Conveyor Belt MK.III',
      'Pile Sorter',
      'Automatic Piler',
      'Interstellar Logistics Station',
      'Ray Receiver',
      'Energy Exchanger',
      'Artificial Star',
      'Mini Fusion Power Plant',
      'Satellite Substation',
      'Geothermal Power Station',
      'Assembling Machine Mk.III',
      'Miniature Particle Collider',
      'EM-Rail Ejector',
      'Vertical Launching Silo',
      'Plane Smelter',
      'Advanced Mining Machine',
      'Quantum Chemical Plant',
      'Plasma Turret',
      'Jammer Tower',
      'SR Plasma Turret',
      'Interstellar Logistics Vessel',
      'Precision Drone',
      'Attack Drone',
      'Corvette',
      'Destroyer',
      'Information Matrix',
      'Gravity Matrix',
    ].map((name) => [name, TOO_DEEP]),
  ),
};

/** Layouts that pass `validateLayout` only over twice the measure window (see the file comment). */
const NEEDS_LONGER_WINDOW: readonly string[] = [];

const log = (line: string): void => void process.stdout.write(`${line}\n`);

interface Plannable {
  name: string;
  plan: ProductionPlan;
}

/** Every producible item, planned at 1/s on the first unlocked facility of its first plannable recipe. */
async function plannableItems(): Promise<{ items: Plannable[]; skipped: Record<string, string> }> {
  const items: Plannable[] = [];
  const skipped: Record<string, string> = {};
  const producible = data.data.items.map((i) => i.id).filter((id) => data.recipesProducing(id).length > 0 && !RAW_ITEMS.includes(id));
  for (const itemId of producible) {
    const name = data.item(itemId).name;
    const recipe = plannableProducers(itemId, data, effects)[0];
    if (!recipe) {
      skipped[name] = NO_RECIPE;
      continue;
    }
    const facility = compatibleFacilities(recipe, data).find((b) => effects.availableBuildings.has(b.itemId));
    if (!facility) {
      skipped[name] = 'no unlocked facility';
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
      skipped[name] = planned.error.kind === 'no-recipe' ? NO_RECIPE : `rejected: ${planned.error.kind}`;
    } else if (planned.plan.stages.length < 1 || planned.plan.stages.length > MAX_STAGES) {
      skipped[name] = TOO_DEEP;
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

  it('sweeps the expected items', () => {
    const left = Object.entries(skipped).map(([name, why]) => `${name} (${why})`);
    log(`ladder sweep: ${items.length} plannable items; skipped ${left.length}: ${left.join('; ') || 'none'}`);
    expect(skipped).toEqual(EXPECTED_SKIPPED);
    expect(items).toHaveLength(EXPECTED_PLANNABLE);
    for (const name of NEEDS_LONGER_WINDOW) expect(items.map((i) => i.name), `${name} is in the sweep`).toContain(name);
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
        if (NEEDS_LONGER_WINDOW.includes(name)) {
          // see the file comment
          expect(report.pass, `${name} passes the plain validation now: take it out of NEEDS_LONGER_WINDOW`).toBe(false);
          report = validateWithRetry(result.layout!, plan, data, effects, { simulate: true });
          retried = `; the plain window failed, the 2x window ${report.pass ? 'passed' : 'failed too'}`;
          if (report.pass) retriedItems.push(name);
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
        `plain validation failed but the 2x window passed for: ${retriedItems.join(', ') || 'none'}`,
    );
  });
});
