// The validation gate for a generated layout: geometry checks, then the rate-capacity check, then the tick
// simulation. The first stage with violations ends the run, so the solver gets the cheapest explanation of what is
// wrong. Nothing here imports from the layout solver.
import type { ProductionPlan } from '../calc';
import type { GameDataIndex, TechEffects } from '../data';
import type { Layout } from '../geometry';
import { checkCapacity } from './capacity';
import { checkGeometry } from './geometry-checks';
import { runSimulation } from './sim/run';
import type { SimResult } from './sim/run';
import type { Violation, ViolationEntity } from './types';

export interface ValidationReport {
  pass: boolean;
  violations: Violation[];
  /** Present when the simulation ran. */
  sim?: SimResult;
  /** ISO 8601 time of the check. */
  checkedAt: string;
  /** The stage reached: the one that failed, or the last one that ran. */
  stage: 'geometry' | 'capacity' | 'simulation';
}

export interface ValidateOptions {
  /** Run the tick simulation after the static checks. Default true. */
  simulate?: boolean;
  warmupTicks?: number;
  measureTicks?: number;
}

/** The target output must reach this share of the plan rate (the Global Constraints: 99 %). */
const OUTPUT_FACTOR = 0.99;
/** A stage must make this share of its planned crafts. */
const STAGE_FACTOR = 0.9;

const pct = (share: number): string => `${Math.round(share * 100)} %`;
const rateText = (perSecond: number): string => `${+perSecond.toFixed(3)}/s`;

function itemName(data: GameDataIndex, itemId: number): string {
  try {
    return data.item(itemId).name;
  } catch {
    return `item ${itemId}`;
  }
}

/**
 * Turn a simulation result into violations:
 *  - SIM_OUTPUT_LOW if the target item reached the stations at less than 99 % of the plan rate (with one item of
 *    slack for the window's edges), naming the wiring warnings the simulator collected;
 *  - SIM_DEADLOCK if the simulator saw no progress for 600 ticks while output was expected;
 *  - SIM_STALLED for every stage whose machines made fewer than 90 % of the planned crafts, listing its machines. A
 *    stage is judged as a whole, so a machine rounded up to be idle part of the time does not trip it, while an
 *    undrained by-product that blocks a refinery does.
 */
export function checkSimulation(sim: SimResult, layout: Layout, plan: ProductionPlan, data: GameDataIndex): Violation[] {
  const violations: Violation[] = [];
  const warnings = sim.warnings.length > 0 ? ` Wiring: ${sim.warnings.join('; ')}.` : '';

  const wanted = plan.actualTargetRate;
  const slack = 1 / sim.measureSeconds;
  if (wanted > 0 && sim.measuredTargetRate < wanted * OUTPUT_FACTOR - slack) {
    const target = plan.request.targetItemId;
    const sinks: ViolationEntity[] = layout.buildings
      .filter((b) => b.station?.slots.some((s) => s.itemId === target) && b.station.ports.some((p) => p.dir === 2))
      .map((b) => ({ kind: 'building', id: b.id }));
    violations.push({
      code: 'SIM_OUTPUT_LOW',
      entities: sinks,
      message:
        `${itemName(data, target)} reached the stations at ${rateText(sim.measuredTargetRate)} over ${sim.measureSeconds} s, ` +
        `below ${pct(OUTPUT_FACTOR)} of the planned ${rateText(wanted)}.${warnings}`,
    });
  }

  if (sim.deadlocked) {
    const stuck = sim.machineStats.filter((m) => m.crafts === 0).map((m): ViolationEntity => ({ kind: 'building', id: m.buildingId }));
    violations.push({
      code: 'SIM_DEADLOCK',
      entities: stuck,
      message:
        `nothing made progress for 600 ticks or more (no item reached a station, no machine advanced, no sorter delivered); ` +
        `${stuck.length} of ${sim.machineStats.length} machines made no craft in the measurement window.${warnings}`,
    });
  }

  for (const stat of sim.stageStats) {
    if (stat.plannedCrafts <= 0 || stat.crafts >= stat.plannedCrafts * STAGE_FACTOR) continue;
    const stage = plan.stages[stat.stageIndex];
    const machines = sim.machineStats.filter((m) => m.stageIndex === stat.stageIndex);
    const recipe = data.recipe(stage.recipeId).name;
    const building = data.building(stage.buildingItemId)?.name ?? `item ${stage.buildingItemId}`;
    const detail = machines.length === 0
      ? 'the layout has no machine for it'
      : machines
          .map((m) => `building ${m.buildingId} busy ${pct(m.busyFraction)}, output-blocked ${pct(m.outputBlockedFraction)}, starved ${pct(m.starvedFraction)}`)
          .join('; ');
    violations.push({
      code: 'SIM_STALLED',
      entities: machines.map((m) => ({ kind: 'building', id: m.buildingId })),
      message:
        `stage ${stat.stageIndex} (${recipe} on ${building}) made ${+stat.crafts.toFixed(1)} crafts in ${sim.measureSeconds} s, ` +
        `below ${pct(STAGE_FACTOR)} of the ${+stat.plannedCrafts.toFixed(1)} planned: ${detail}`,
    });
  }
  return violations;
}

/**
 * Validate `layout` against `plan`: geometry first, then the rate-capacity check, then (unless `simulate` is false)
 * the tick simulation. Stops at the first stage that finds a violation. `pass` means no violations.
 */
export function validateLayout(
  layout: Layout,
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: ValidateOptions = {},
): ValidationReport {
  const checkedAt = new Date().toISOString();
  const geometry = checkGeometry(layout, data, effects);
  if (geometry.length > 0) return { pass: false, violations: geometry, checkedAt, stage: 'geometry' };

  const capacity = checkCapacity(layout, plan, data, effects);
  if (capacity.length > 0) return { pass: false, violations: capacity, checkedAt, stage: 'capacity' };

  if (opts.simulate === false) return { pass: true, violations: [], checkedAt, stage: 'capacity' };

  const sim = runSimulation(layout, plan, data, effects, { warmupTicks: opts.warmupTicks, measureTicks: opts.measureTicks });
  const violations = checkSimulation(sim, layout, plan, data);
  return { pass: violations.length === 0, violations, sim, checkedAt, stage: 'simulation' };
}
