// What the ladder sweeps share (ladder-sweep.e2e.test.ts, ladder-sweep-proliferated.e2e.test.ts, and the deep ones,
// ladder-sweep-deep*.e2e.test.ts, Task 30b): the items swept, the ones left out and why, and the loop that solves every item
// with the fallback ladder alone and judges it with a plain `validateLayout`. The first two sweep the items of at most 12
// stages, the deep ones the items of more (`Depth`).
import { afterAll, describe, expect, it } from 'vitest';
import type { PlanRequest, ProductionPlan, ProliferatorSetting } from '../src/lib/calc';
import { compatibleFacilities, planProduction, plannableProducers } from '../src/lib/calc';
import { DEFAULT_SOLVE_OPTIONS, solve } from '../src/lib/layout/solver';
import type { SolveProgress } from '../src/lib/layout/solver';
import { buildNetlist } from '../src/lib/layout/netlist';
import { data, effects, everything } from '../src/lib/layout/testkit';
import { validateLayout } from '../src/lib/validate';
import { provisionedRate } from '../src/lib/validate/sim/run';

/** Items that come from the ground, the sea or the air: supplied, never planned. */
export const RAW_ITEMS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1030, 1031];
export const MAX_STAGES = 12;
export const ITEM_TIMEOUT_MS = 1_800_000;
/** A deep item may have hundreds of machines, and a rung that is rejected may have waited for a slow start-up for millions of ticks. */
export const DEEP_ITEM_TIMEOUT_MS = 3_600_000;

/** Which items a sweep covers: the ones of at most `MAX_STAGES` stages, or the ones of more. */
export type Depth = 'shallow' | 'deep';

/** How many items are swept: every producible item but `EXPECTED_SKIPPED`. */
export const EXPECTED_PLANNABLE = 102;
/** Items left out of the sweep and why: the calculator has no plan for them, or the plan needs more than 12 stages. */
export const NO_RECIPE = 'no plannable recipe';
export const TOO_DEEP = `more than ${MAX_STAGES} stages`;
/** What the deep sweeps call the items the shallow ones cover. */
export const NOT_DEEP = `at most ${MAX_STAGES} stages`;
export const EXPECTED_SKIPPED: Record<string, string> = {
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

/** The items the deep sweeps cover: the ones `EXPECTED_SKIPPED` leaves out of the shallow sweeps for their depth. */
export const EXPECTED_DEEP = Object.entries(EXPECTED_SKIPPED)
  .filter(([, why]) => why === TOO_DEEP)
  .map(([name]) => name)
  .sort();

export const log = (line: string): void => void process.stdout.write(`${line}\n`);

export interface Plannable {
  name: string;
  plan: ProductionPlan;
}

/**
 * Every producible item, planned at 1/s on the first unlocked facility of its first plannable recipe, with `proliferator` on
 * every stage. Which items are swept does not depend on it: the ones the plain plan (no proliferator) makes of at most
 * `MAX_STAGES` stages are (`depth` 'shallow'), or of more ('deep'), so the plain and the proliferated sweep of a depth run over
 * the same set.
 */
export async function plannableItems(
  proliferator: ProliferatorSetting = { tier: 0, mode: 'extra' },
  depth: Depth = 'shallow',
): Promise<{ items: Plannable[]; skipped: Record<string, string> }> {
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
    } else if (depth === 'shallow' && (planned.plan.stages.length < 1 || planned.plan.stages.length > MAX_STAGES)) {
      skipped[name] = TOO_DEEP;
    } else if (depth === 'deep' && planned.plan.stages.length <= MAX_STAGES) {
      skipped[name] = NOT_DEEP;
    } else if (proliferator.tier === 0) {
      items.push({ name, plan: planned.plan });
    } else {
      const sprayed = await planProduction({ ...request, proliferator }, data, effects);
      if (!sprayed.ok) throw new Error(`${name}: the plan with proliferator tier ${proliferator.tier} fails: ${sprayed.error.kind}: ${sprayed.error.message}`);
      items.push({ name, plan: sprayed.plan });
    }
  }
  return { items, skipped };
}

/**
 * The sweep: a test per item that solves it with the fallback ladder alone (`timeBudgetMs: 1`) and the default, adaptive
 * simulation, and judges the layout with a plain `validateLayout`. `title` names the describe block; the totals are logged
 * after the last item. `depth` says which items `swept` holds (`plannableItems`), and so what the first test expects of
 * the ones left out. Every item logs its runtime, the rungs the ladder went through and the rate the validation measured;
 * an item that fails is a failure of its own test, with the violations as the message, and nothing is allowed for it.
 */
export function sweep(title: string, swept: { items: Plannable[]; skipped: Record<string, string> }, depth: Depth = 'shallow'): void {
  const { items, skipped } = swept;
  describe(title, () => {
    let passed = 0;
    let seconds = 0;

    it('sweeps the expected items', () => {
      // the deep sweeps leave out the 102 shallow items, which are not worth listing
      const left = Object.entries(skipped)
        .filter(([, why]) => why !== NOT_DEEP)
        .map(([name, why]) => `${name} (${why})`);
      const shallow = Object.values(skipped).length - left.length;
      log(`${title}: ${items.length} plannable items; skipped ${left.length}: ${left.join('; ') || 'none'}${shallow > 0 ? `; and ${shallow} items of ${NOT_DEEP}` : ''}`);
      if (depth === 'shallow') {
        expect(skipped).toEqual(EXPECTED_SKIPPED);
        expect(items).toHaveLength(EXPECTED_PLANNABLE);
      } else {
        // the deep items are the ones the shallow sweeps leave out for their depth; the shallow ones and the ones without a plan are the rest
        expect(items.map((i) => i.name).sort()).toEqual(EXPECTED_DEEP);
        const unplanned = Object.fromEntries(Object.entries(skipped).filter(([, why]) => why !== NOT_DEEP));
        expect(unplanned).toEqual(Object.fromEntries(Object.entries(EXPECTED_SKIPPED).filter(([, why]) => why !== TOO_DEEP)));
        expect(Object.values(skipped).filter((why) => why === NOT_DEEP)).toHaveLength(EXPECTED_PLANNABLE);
      }
    });

    for (const { name, plan } of items) {
      it(
        name,
        () => {
          const machines = plan.stages.reduce((n, s) => n + s.machines, 0);
          const sprayed = buildNetlist(plan, data, effects).nets.filter((n) => n.sprayed).length;
          const rungs: string[] = [];
          const t0 = performance.now();
          const result = solve(
            plan,
            data,
            effects,
            { ...DEFAULT_SOLVE_OPTIONS, timeBudgetMs: 1 },
            (p: SolveProgress) => {
              if (p.phase.startsWith('ladder:')) rungs.push(p.phase.slice('ladder: '.length));
            },
            () => {},
            () => false,
          );
          const solved = (performance.now() - t0) / 1000;
          const head = `${name}: ${plan.stages.length} stages, ${machines} machines, ${sprayed} sprayed nets, ladder ${solved.toFixed(1)} s (${rungs.join(' | ')})`;
          if (!result.layout) {
            seconds += solved;
            log(`FAIL ${head}, no layout`);
          }
          expect(result.layout, `${name}: no layout; ${result.failures.join(' || ')}`).not.toBeNull();
          const report = validateLayout(result.layout!, plan, data, effects);
          const total = (performance.now() - t0) / 1000;
          seconds += total;
          log(
            `${report.pass ? 'ok  ' : 'FAIL'} ${head}, with the validation ${total.toFixed(1)} s, warm-up ${report.sim?.warmupTicksUsed ?? 0} ticks, ` +
              `rate ${report.sim ? +report.sim.measuredTargetRate.toFixed(3) : '-'}/s of ${+provisionedRate(plan).toFixed(3)}`,
          );
          expect(report.violations.map((v) => `${v.code}: ${v.message}`), name).toEqual([]);
          expect(report.pass, name).toBe(true);
          passed++;
        },
        depth === 'deep' ? DEEP_ITEM_TIMEOUT_MS : ITEM_TIMEOUT_MS,
      );
    }

    afterAll(() => {
      log(`${title}: ${passed} of ${items.length} plannable items passed the plain validation, ${seconds.toFixed(0)} s in all`);
    });
  });
}
