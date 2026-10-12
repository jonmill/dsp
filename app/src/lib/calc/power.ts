/**
 * Power estimate for a plan. Game power is held as J/tick; watts are J/tick x 60
 * (`constants.ticksPerSecond`). Sorters and spray coaters are not placed yet, so they are estimated
 * from the machine count; the layout's own count replaces them later. The coaters are estimated at one per
 * distinct item that goes into a proliferated stage; a layout has one per belt that carries such an item, and
 * an item that needs more than one belt (or is cut across several) has more. The stations are the plan's
 * `stationsNeeded`, a lower bound from the item slots; a layout also needs stations for its belt ports. So
 * `withLayout` puts the layout's coaters and stations in.
 */
import type { Building, GameDataIndex, TechEffects } from '../data';
import type { Layout } from '../geometry';
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

  const coatersW = coaterPowerW(sprayedBelts.size, data);

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

/** What `count` spray coaters draw working, in watts: one per belt that carries an item into a proliferated stage. */
export function coaterPowerW(count: number, data: GameDataIndex): number {
  const coater = data.data.buildings.find((b) => b.kind === 'sprayCoater');
  return count * (coater?.power.workPerTick ?? 0) * data.data.constants.ticksPerSecond;
}

/** A station of a layout, as far as power goes: which kind, and the charge its config sets (the kind's default when it sets none). */
export interface LayoutStation {
  kind: 'planetary' | 'interstellar';
  chargePerTick?: number;
}

/** The stations of `layout` (the buildings with a station config), in building order. */
export function layoutStations(layout: Pick<Layout, 'buildings'>, data: GameDataIndex): LayoutStation[] {
  return layout.buildings.flatMap((b) =>
    b.station
      ? [{ kind: data.building(b.itemId)?.station?.isStellar ? ('interstellar' as const) : ('planetary' as const), chargePerTick: b.station.chargePerTick }]
      : [],
  );
}

/**
 * `power` with what a layout has in place of what the plan estimated: its `coaters` (one per sprayed belt, not one per sprayed
 * item) and its `stations` (a plan counts the stations its item slots need, a layout also the ones its belt ports need: 7
 * where the plan said 2). The station charge is the sum of the stations' own charges; the steady total follows by the share of
 * it that is drawn on average and the peak by all of it. The machines and sorters are the estimate's.
 */
export function withLayout(
  power: PowerEstimate,
  layout: { coaters: number; stations: readonly LayoutStation[] },
  data: GameDataIndex,
): PowerEstimate {
  const { ticksPerSecond, stationDefaultChargePerTick } = data.data.constants;
  const coatersW = coaterPowerW(layout.coaters, data);
  const stationChargeW = layout.stations.reduce(
    (sum, s) => sum + (s.chargePerTick ?? stationDefaultChargePerTick[s.kind]) * ticksPerSecond,
    0,
  );
  const coaterChange = coatersW - power.coatersW;
  const stationChange = stationChargeW - power.stationChargeW;
  return {
    ...power,
    coatersW,
    stationChargeW,
    steadyW: power.steadyW + coaterChange + STEADY_STATION_SHARE * stationChange,
    peakW: power.peakW + coaterChange + stationChange,
  };
}
