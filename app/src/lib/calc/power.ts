/**
 * Power estimate for a plan. Game power is held as J/tick; watts are J/tick x 60
 * (`constants.ticksPerSecond`). Sorters and spray coaters are not placed yet, so they are estimated
 * from the machine count; the layout's own count replaces them later.
 */
import type { Building, GameDataIndex, TechEffects } from '../data';
import type { PowerEstimate, ProductionPlan } from './types';

/** Sorter Mk.III, then Mk.II, then Mk.I. */
const SORTER_ITEM_IDS = [2013, 2012, 2011];
const SORTERS_PER_MACHINE = 2;
const SORTER_DUTY = 0.5;
/** Share of the station charge drawn on average once the stations are full. */
const STEADY_STATION_SHARE = 0.1;

/** The best sorter the player has, else the first one the data has. */
function pickSorter(data: GameDataIndex, effects: TechEffects): Building | undefined {
  const present = SORTER_ITEM_IDS.flatMap((id) => data.building(id) ?? []);
  return present.find((b) => effects.availableBuildings.has(b.itemId)) ?? present.at(-1);
}

export function estimatePower(
  plan: Omit<ProductionPlan, 'power'>,
  data: GameDataIndex,
  effects: TechEffects,
): PowerEstimate {
  const { ticksPerSecond, stationDefaultChargePerTick } = data.data.constants;

  let productionWorkW = 0;
  let productionIdleW = 0;
  let allWorkW = 0;
  let machines = 0;
  const sprayedBelts = new Set<number>();
  for (const stage of plan.stages) {
    productionWorkW += stage.machines * stage.workPowerW * stage.utilization;
    productionIdleW += stage.machines * stage.idlePowerW * (1 - stage.utilization);
    allWorkW += stage.machines * stage.workPowerW;
    machines += stage.machines;
    // One coater per belt that carries an item into a proliferated stage.
    if (stage.proliferated) for (const input of stage.inputs) sprayedBelts.add(input.itemId);
  }

  const sorter = pickSorter(data, effects);
  const sorterCount = SORTERS_PER_MACHINE * machines;
  const sorterWork = (sorter?.power.workPerTick ?? 0) * ticksPerSecond;
  const sorterIdle = (sorter?.power.idlePerTick ?? 0) * ticksPerSecond;
  const sortersW = sorterCount * (SORTER_DUTY * sorterWork + (1 - SORTER_DUTY) * sorterIdle);
  const sortersPeakW = sorterCount * sorterWork;

  const coater = data.data.buildings.find((b) => b.kind === 'sprayCoater');
  const coatersW = sprayedBelts.size * (coater?.power.workPerTick ?? 0) * ticksPerSecond;

  const chargePerTick =
    plan.request.stationChargePerTick ?? stationDefaultChargePerTick[plan.request.stationKind];
  const stationChargeW = chargePerTick * ticksPerSecond * plan.stationsNeeded;

  return {
    productionWorkW,
    productionIdleW,
    sortersW,
    coatersW,
    stationChargeW,
    steadyW: productionWorkW + productionIdleW + sortersW + coatersW + STEADY_STATION_SHARE * stationChargeW,
    peakW: allWorkW + sortersPeakW + coatersW + stationChargeW,
  };
}
