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
  /**
   * An export slot that only a surplus sink asked for (`planWithSurplusSinks`; calc/surplus.ts): the plan has it when the layout
   * solver switched the sinks on, and nothing else exports the item. Absent on the slots of the planner's own plan.
   */
  surplus?: true;
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
   * carry only the regular part. Not a proliferator the plan makes itself (`selfSpray`): nothing imports that.
   */
  imports: ItemRate[];
  /**
   * The target comes first, then by-products nothing consumes. The target's rate is the net one, what the player collects: for
   * a product that is also the proliferator its coaters spray with (`selfSpray`) it is the stages' output less the spray.
   */
  exports: ItemRate[];
  /**
   * Present when the plan makes the proliferator it sprays with (the target is that proliferator, or a stage makes it for the others'
   * recipes) and it is not supplied: the stages that make it are sized for the spray as well as for the rate (the export is the net),
   * `perSecond` is `proliferatorPerSecond` and the plan has no import of the item. The flows to the export carry the spray on top
   * of the export, and the station slot is an export one: the coaters' feed draws the spray from it. Absent: the spray is an import
   * (or there is none).
   */
  selfSpray?: ItemRate;
  /**
   * Candidates for a surplus sink: items that several stages make and the stages use, whose belts could also end at a station port (an
   * export slot) for what the machines can make beyond what is used, as producers that share a belt that nothing drains fill it and
   * block (`calc/surplus.ts`). The rate is the spare capacity of the producers. Only candidates: the plan's `stationSlots`,
   * `stationsNeeded` and `power` are those of a plan without the sinks, and the layout solver switches them on (`planWithSurplusSinks`)
   * only for a layout whose validation found a deadlock. They are not exports (the flows do not change). Absent: none.
   */
  surplus?: ItemRate[];
  /** What the rounded-up machines can deliver of the target, net of the coaters' share of it when the target is its own spray. */
  actualTargetRate: number;
  /** One slot per item id; an item with several roles keeps export over proliferator over import. */
  stationSlots: StationSlotDemand[];
  /** Slot-based lower bound; the netlist may need more once belt ports are counted. */
  stationsNeeded: number;
  /** What the coaters spend a second, imported or (`selfSpray`) made by the plan. */
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
