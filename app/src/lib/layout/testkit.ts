// Helpers for the layout tests: the Processor netlist from a real plan, hand-made netlists and tap assignments, and
// the Layout that a placement, a tap assignment and a set of routes make together (what the solver builds later, here
// so the validator can judge the router's output).
import { planProduction } from '../calc';
import type { PlanRequest } from '../calc';
import { allTechs, computeTechEffects, GameDataIndex } from '../data';
import type { TechEffects } from '../data';
import { buildingDef, slotInfos } from '../geometry';
import type { BeltPath, Layout, PlacedBuilding, Sorter, StationConfig } from '../geometry';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { buildNetlist } from './netlist';
import type { BeltNet, Netlist } from './netlist';
import { Occupancy } from './occupancy';
import { placementBuildingIdOf, stationBuildingId } from './placement';
import type { Placement } from './placement';
import type { RoutedNet } from './router';
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

/** Processors on Mk.III assemblers, everything unlocked, ore/copper/silicon supplied: a real plan's netlist. */
export async function processorNetlist(perSecond = 1): Promise<Netlist> {
  const request: PlanRequest = {
    targetItemId: 1303,
    quantity: { kind: 'rate', perSecond },
    finalFacilityItemId: ASSEMBLER_MK3,
    unlockedTechs: everything,
    suppliedItemIds: new Set([1001, 1002, 1003]),
    facilityOverrides: { 51: ASSEMBLER_MK3, 50: ASSEMBLER_MK3, 53: ASSEMBLER_MK3, 1: SMELTER, 3: SMELTER, 59: SMELTER },
    recipeOverrides: {},
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
  };
  const result = await planProduction(request, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return buildNetlist(result.plan, data, effects);
}

const BASE_TIER_BY_TYPE: Record<string, number> = {
  ASSEMBLE: ASSEMBLER,
  SMELT: SMELTER,
  CHEMICAL: 2309,
  REFINE: 2308,
  PARTICLE: 2310,
  RESEARCH: 2901,
};

/** 1 Quantum Chip/s on base-tier machines: 19 stages, 231 machines, 70 nets. */
export async function quantumNetlist(): Promise<Netlist> {
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
    proliferator: { tier: 0, mode: 'extra' },
    stationKind: 'planetary',
  };
  const result = await planProduction(request, data, effects);
  if (!result.ok) throw new Error(`plan failed: ${result.error.kind}: ${result.error.message}`);
  return buildNetlist(result.plan, data, effects);
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

function stationConfigOf(net: Netlist, idx: number, ports: TapAssignment['stationPorts']): StationConfig {
  const st = net.stations[idx];
  const cfg: StationConfig = {
    slots: st.slots.map((s) => ({ ...s })),
    ports: Array.from({ length: 12 }, () => ({ dir: 0 as const, storageIdx: 0 })),
    chargePerTick: 0,
    pilerCount: 1,
  };
  for (const p of ports) {
    if (p.stationBuildingId !== stationBuildingId(idx)) continue;
    const item = net.nets.find((n) => n.id === p.netId)?.itemId;
    const slot = st.slots.findIndex((s) => s.itemId === item);
    cfg.ports[p.port] = p.end === 'source' ? { dir: 1, storageIdx: slot + 1 } : { dir: 2, storageIdx: 0 };
  }
  return cfg;
}

/** The layout a placement, its taps and the routes make: belts from the routes, one sorter per assigned tap. */
export function layoutOf(
  net: Netlist,
  placement: Placement,
  taps: TapAssignment,
  routes: RoutedNet[],
): Layout {
  const buildings = placement.buildings.map((b) => {
    const idx = b.role?.startsWith('station:') ? Number(b.role.slice('station:'.length)) : -1;
    return idx >= 0 ? { ...b, station: stationConfigOf(net, idx, taps.stationPorts) } : { ...b };
  });
  const belts: BeltPath[] = [];
  const sorters: Sorter[] = [];
  const beltOf = new Map<number, BeltPath>();
  for (const route of routes) {
    const n = net.nets.find((x) => x.id === route.netId) as BeltNet;
    const belt: BeltPath = {
      id: n.id,
      tierItemId: n.tierItemId,
      itemId: n.itemId,
      nodes: route.nodes.map((p) => ({ ...p })),
      plannedRate: n.rate,
    };
    for (const p of taps.stationPorts) {
      if (p.netId !== n.id) continue;
      if (p.end === 'source') belt.source = { buildingId: p.stationBuildingId, port: p.port };
      else belt.sink = { kind: 'port', buildingId: p.stationBuildingId, port: p.port };
    }
    belts.push(belt);
    beltOf.set(n.id, belt);
  }
  for (const t of taps.taps) {
    const belt = beltOf.get(t.netId);
    if (!belt) continue;
    const node = belt.nodes.findIndex((p) => p.x === t.point.x && p.y === t.point.y && p.z === 0);
    if (node < 0) throw new Error(`net ${t.netId}: no belt node at tap point (${t.point.x}, ${t.point.y})`);
    const building = { kind: 'building' as const, buildingId: placementBuildingIdOf(t.machineId), slot: t.slot };
    const onBelt = { kind: 'belt' as const, beltId: belt.id, node };
    sorters.push({
      id: sorters.length + 1,
      tierItemId: net.sorterTierItemId,
      filterItemId: belt.itemId,
      span: t.span,
      pick: t.dir === 'out' ? building : onBelt,
      drop: t.dir === 'out' ? onBelt : building,
      plannedRate: t.rate,
    });
  }
  return {
    buildings,
    belts,
    sorters,
    meta: { geometrySource: 'approximate', gameVersion: 'test', planTargetItemId: 1303, planTargetRate: 1 },
  };
}
