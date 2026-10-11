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

/** `from` and `to` are indexes into `ProductionPlan.stages`. */
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
  imports: ItemRate[];
  /** The target comes first, then by-products nothing consumes. */
  exports: ItemRate[];
  actualTargetRate: number;
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
