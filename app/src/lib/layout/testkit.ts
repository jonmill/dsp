// Helpers for the layout tests: plans and netlists from the fixture data (the Processor one in particular), hand-made
// netlists, and the Layout that a placement, a tap assignment and a set of routes make together (so the validator can
// judge the router's output).
import { planProduction } from '../calc';
import type { PlanRequest, ProductionPlan, ProliferatorSetting } from '../calc';
import { allTechs, computeTechEffects, GameDataIndex } from '../data';
import type { TechEffects } from '../data';
import { buildingDef, slotInfos } from '../geometry';
import type { Layout, PlacedBuilding } from '../geometry';
import { planOf } from '../validate/testkit';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { assembleLayout } from './assemble';
import { buildNetlist } from './netlist';
import type { BeltNet, Netlist } from './netlist';
import { Occupancy } from './occupancy';
import { constructivePlacement } from './placement';
import type { Placement } from './placement';
import { placePowerNodes, powerTargets } from './power';
import { defaultRouteParams, routeNets } from './router';
import type { RoutedNet } from './router';
import { assignTaps } from './taps';
import type { TapAssignment } from './taps';

export const parsed = loadFixtureGameData();
export const data = new GameDataIndex(parsed);
export const everything = allTechs(parsed);
export const effects: TechEffects = computeTechEffects(parsed, everything);

export const ASSEMBLER = 2303;
export const ASSEMBLER_MK3 = 2305;
export const SMELTER = 2302;
export const PLS = 2103;
export const ILS = 2104;

/**
 * The plans of this kit are sized without machine headroom: the layout tests pin machine counts and structures
 * (25 machines, 6 labs in 2 stacks, 12 smelters in a row), and the benchmark plans built from them stay comparable with the
 * rows of docs/benchmarks.md. The sizing itself is tested in calc/plan.test.ts, and the ladder sweeps run the defaults.
 */
const NO_HEADROOM = 0;

/** A plan for `over.targetItemId` at 1/s with everything unlocked, planetary stations and no proliferator. */
export async function planFor(over: Partial<PlanRequest> & Pick<PlanRequest, 'targetItemId'>): Promise<ProductionPlan> {
  const request: PlanRequest = {
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: ASSEMBLER,
    unlockedTechs: everything,
    suppliedItemIds: new Set(),
    facilityOverrides: {},
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
    machineHeadroom: NO_HEADROOM,
    ...over,
  };
  const result = await planProduction(request, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return result.plan;
}

/**
 * The plan of `processorNetlist`: Processors on Mk.III assemblers, everything unlocked, ore/copper/silicon supplied;
 * `proliferator` sprays every stage (none by default).
 */
export async function processorPlan(perSecond = 1, proliferator: ProliferatorSetting = { tier: 0, mode: 'extra' }): Promise<ProductionPlan> {
  const request: PlanRequest = {
    targetItemId: 1303,
    quantity: { kind: 'rate', perSecond },
    finalFacilityItemId: ASSEMBLER_MK3,
    unlockedTechs: everything,
    suppliedItemIds: new Set([1001, 1002, 1003]),
    facilityOverrides: { 51: ASSEMBLER_MK3, 50: ASSEMBLER_MK3, 53: ASSEMBLER_MK3, 1: SMELTER, 3: SMELTER, 59: SMELTER },
    recipeOverrides: {},
    proliferator,
    stationKind: 'planetary',
    machineHeadroom: NO_HEADROOM,
  };
  const result = await planProduction(request, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return result.plan;
}

/** Processors on Mk.III assemblers, everything unlocked, ore/copper/silicon supplied: a real plan's netlist. */
export async function processorNetlist(perSecond = 1, proliferator?: ProliferatorSetting): Promise<Netlist> {
  return buildNetlist(await processorPlan(perSecond, proliferator), data, effects);
}

export const MATRIX_LAB = 2901;

/** `perSecond` Electromagnetic Matrix/s on Matrix Labs (6 labs at 2/s) from supplied ores: 11 machines, 8 nets. */
export async function matrixPlan(perSecond = 2): Promise<ProductionPlan> {
  return planFor({
    targetItemId: 6001,
    finalFacilityItemId: MATRIX_LAB,
    quantity: { kind: 'rate', perSecond },
    suppliedItemIds: new Set([1001, 1002, 1003]),
  });
}

/** The netlist of `matrixPlan`; `fx` is the tech state (the labs stack as high as its `labLevel`). */
export async function matrixNetlist(perSecond = 2, fx: TechEffects = effects): Promise<Netlist> {
  return buildNetlist(await matrixPlan(perSecond), data, fx);
}

const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: ASSEMBLER,
  SMELT: SMELTER,
  CHEMICAL: 2309,
  REFINE: 2308,
  PARTICLE: 2310,
  RESEARCH: 2901,
};

/**
 * 1 Quantum Chip/s on base-tier machines from the raw resources and Hydrogen: 19 stages, 231 machines, 56 nets (108 machines with
 * Mk.III proliferator, extra products). `machineHeadroom` is the planner's (`DEFAULT_MACHINE_HEADROOM` adds a 7th Oil Refinery to the
 * Plasma Refining stage, which needs 5.977, when proliferated).
 */
export async function quantumPlan(
  proliferator: ProliferatorSetting = { tier: 0, mode: 'extra' },
  machineHeadroom = NO_HEADROOM,
): Promise<ProductionPlan> {
  const request: PlanRequest = {
    targetItemId: 1305,
    quantity: { kind: 'rate', perSecond: 1 },
    finalFacilityItemId: ASSEMBLER,
    unlockedTechs: everything,
    suppliedItemIds: new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1120]),
    facilityOverrides: Object.fromEntries(
      parsed.recipes.filter((r) => r.type in BASE_TIER_BY_TYPE).map((r) => [r.id, BASE_TIER_BY_TYPE[r.type]] as const),
    ),
    recipeOverrides: { 1114: 16 },
    proliferator,
    stationKind: 'planetary',
    machineHeadroom,
  };
  const result = await planProduction(request, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return result.plan;
}

/** The netlist of `quantumPlan`. */
export async function quantumNetlist(): Promise<Netlist> {
  return buildNetlist(await quantumPlan(), data, effects);
}

/** A hand-made netlist of `count` machines of `building` (ids 1..count) and the given nets. */
export function synthNetlist(
  machines: { building: number; count: number }[],
  stationBuildings: number[],
  nets: Partial<BeltNet>[],
  sorterTierItemId: Netlist['sorterTierItemId'] = 2011,
): Netlist {
  const list: Netlist['machines'] = [];
  machines.forEach((m, stageIndex) => {
    for (let i = 0; i < m.count; i++) {
      list.push({
        id: list.length + 1,
        stageIndex,
        recipeId: 100 + stageIndex,
        buildingItemId: m.building,
        inputs: [],
        outputs: [],
      });
    }
  });
  const beltNets: BeltNet[] = nets.map((n, i) => ({
    id: i + 1,
    itemId: 1001,
    tierItemId: 2001,
    rate: 1,
    source: { kind: 'taps' },
    sink: { kind: 'deadEnd' },
    taps: [],
    ...n,
  }));
  return {
    machines: list,
    nets: beltNets,
    stations: stationBuildings.map((buildingItemId) => ({
      kind: buildingItemId === ILS ? ('interstellar' as const) : ('planetary' as const),
      buildingItemId,
      slots: [],
      portsNeeded: 0,
    })),
    sorterTierItemId,
    beltTierItemId: 2001,
    warnings: [],
  };
}

/** An Occupancy holding `buildings`. */
export function occupancyOf(buildings: readonly PlacedBuilding[]): Occupancy {
  const occ = new Occupancy(data);
  for (const b of buildings) occ.addBuilding(b);
  return occ;
}

/** An Occupancy that, besides the buildings, treats the lattice points in `cells` as blocked for belts at z 0. */
export class BlockingOccupancy extends Occupancy {
  private readonly extra: Set<string>;

  constructor(buildings: readonly PlacedBuilding[], cells: Iterable<{ x: number; y: number }>) {
    super(data);
    for (const b of buildings) this.addBuilding(b);
    this.extra = new Set([...cells].map((c) => `${c.x},${c.y}`));
  }

  override blockedForBelt(x: number, y: number, z: number): boolean {
    return (z === 0 && this.extra.has(`${x},${y}`)) || super.blockedForBelt(x, y, z);
  }
}

/** The tap points a span-1 sorter on each slot of `b` would use. */
export function spanOnePoints(b: PlacedBuilding): { x: number; y: number }[] {
  return slotInfos(b, buildingDef(data, b.itemId)).map((s) => s.firstOutside);
}

/** The layout a placement, its taps and the routes make, without power nodes (`assembleLayout` on an empty plan). */
export function layoutOf(net: Netlist, placement: Placement, taps: TapAssignment, routes: RoutedNet[]): Layout {
  return assembleLayout(net, placement, taps, routes, [], planOf([]), data);
}

/**
 * The pipeline of one solver candidate with the constructive placement at `margin`: taps, routes, power nodes, the
 * layout. `placement` replaces the constructive one when given. Throws, naming the stage, when one of them fails.
 */
export function pipelineLayout(
  net: Netlist,
  plan: ProductionPlan,
  margin = 4,
  placement: Placement = constructivePlacement(net, data, margin),
  fx: TechEffects = effects,
): { layout: Layout; placement: Placement; taps: TapAssignment } {
  const occ = occupancyOf(placement.buildings);
  const taps = assignTaps(net, placement, occ, data, fx);
  if ('failed' in taps) throw new Error(`assignTaps failed: ${taps.failed}`);
  const routed = routeNets(net, taps, occ, defaultRouteParams(occ), () => false);
  if (!routed.ok) throw new Error(`routing left ${routed.conflicts} conflicts; unroutable nets ${routed.unroutable.join(', ')}`);
  const bare = assembleLayout(net, placement, taps, routed.routes, [], plan, data);
  const targets = powerTargets(bare, data);
  const poles = placePowerNodes(bare.buildings, targets.consumerPoints, targets.blockedPoints, occ, data, fx);
  if (!poles) throw new Error('no power node placement covers and links the layout');
  return { layout: assembleLayout(net, placement, taps, routed.routes, poles, plan, data), placement, taps };
}
