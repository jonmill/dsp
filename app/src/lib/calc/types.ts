/**
 * Production planner contract: what the UI asks for (`PlanRequest`) and what the layout solver
 * builds from (`ProductionPlan`). Rates are items (or crafts) per second, power is in watts.
 */

export interface ItemRate {
  itemId: number;
  perSecond: number;
}

/** Tier n is item 1140+n; tier 0 means no proliferator. */
export interface ProliferatorSetting {
  tier: 0 | 1 | 2 | 3;
  mode: 'extra' | 'speed';
}

export interface PlanRequest {
  targetItemId: number;
  quantity: { kind: 'rate'; perSecond: number } | { kind: 'buildings'; count: number };
  finalFacilityItemId: number;
  unlockedTechs: Set<number>;
  suppliedItemIds: Set<number>;
  /** recipeId -> building item id. */
  facilityOverrides: Record<number, number>;
  /** itemId -> recipeId (forces the recipe for that item). */
  recipeOverrides: Record<number, number>;
  proliferator: ProliferatorSetting;
  stationKind: 'planetary' | 'interstellar';
  /** J/tick; defaults to the constants entry for `stationKind`. */
  stationChargePerTick?: number;
  /**
   * Spare machine capacity as a fraction of what a stage needs (0.01 = 1 %); defaults to
   * `DEFAULT_MACHINE_HEADROOM`. A stage is sized `ceil(exact * (1 + headroom))`, so any stage that
   * `ceil(exact)` machines would run above `1 / (1 + headroom)` (99 % at the default) gets at least one more machine:
   * `ceil(exact * (1 + headroom))`; a large stage gets more than one.
   * The stage that `quantity.kind === 'buildings'` pins keeps the count the user asked for.
   */
  machineHeadroom?: number;
}

export interface Stage {
  recipeId: number;
  buildingItemId: number;
  machines: number;
  exactMachines: number;
  craftsPerSecond: number;
  /** exactMachines / machines. */
  utilization: number;
  /** Totals for the stage at the planned (exact) crafts/s. */
  inputs: ItemRate[];
  outputs: ItemRate[];
  /** At 100 % utilization. */
  perMachineCraftsPerSecond: number;
  proliferated: boolean;
  /** Building speed times the proliferator speed-up (1.0 = 10000). */
  effectiveSpeed: number;
  /** Per machine; the proliferator power multiplier applies to the work power. */
  workPowerW: number;
  idlePowerW: number;
}

/**
 * `from` and `to` are indexes into `ProductionPlan.stages`. Flows cover the materials only: the
 * proliferator import goes to the spray coaters, not to a stage, so it has no flows.
 */
export interface Flow {
  itemId: number;
  from: number | 'import';
  to: number | 'export';
  perSecond: number;
}

export interface StationSlotDemand {
  itemId: number;
  role: 'import' | 'export' | 'proliferator';
}

export interface PowerEstimate {
  productionWorkW: number;
  productionIdleW: number;
  sortersW: number;
  coatersW: number;
  stationChargeW: number;
  steadyW: number;
  peakW: number;
}

export interface ProductionPlan {
  request: PlanRequest;
  stages: Stage[];
  flows: Flow[];
  /**
   * Includes the proliferator, which has no flows (spray coaters consume it, not stages). If the
   * proliferator item is also a regular import, the two are summed into one entry and the flows
   * carry only the regular part.
   */
  imports: ItemRate[];
  /** The target comes first, then by-products nothing consumes. */
  exports: ItemRate[];
  /**
   * Candidates for a surplus sink: items that several stages make and the stages use, whose belts could also end at a station port (an
   * export slot) for what the machines can make beyond what is used, as producers that share a belt that nothing drains fill it and
   * block (`calc/surplus.ts`). The rate is the spare capacity of the producers. Only candidates: the plan's `stationSlots`,
   * `stationsNeeded` and `power` are those of a plan without the sinks, and the layout solver switches them on (`planWithSurplusSinks`)
   * only for a layout whose validation found a deadlock. They are not exports (the flows do not change). Absent: none.
   */
  surplus?: ItemRate[];
  actualTargetRate: number;
  /** One slot per item id; an item with several roles keeps export over proliferator over import. */
  stationSlots: StationSlotDemand[];
  /** Slot-based lower bound; the netlist may need more once belt ports are counted. */
  stationsNeeded: number;
  proliferatorPerSecond: number;
  power: PowerEstimate;
  warnings: string[];
}

export type PlanError =
  | { kind: 'target-locked'; itemId: number; message: string }
  /** Not supplied and no unlocked recipe. */
  | { kind: 'no-recipe'; itemId: number; message: string }
  | { kind: 'facility-unavailable'; recipeId: number; buildingItemId: number; message: string }
  | { kind: 'infeasible'; message: string };

export type PlanResult = { ok: true; plan: ProductionPlan } | { ok: false; error: PlanError };
