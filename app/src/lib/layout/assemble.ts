// Layout assembly: the placement, the tap assignment, the routes and the power nodes, put together as the `Layout` the
// validator and the blueprint builder read (Task 23).
//
// Buildings. The placement's buildings as they are (production buildings keep `recipeId` and `role: 'stage:<i>'`),
// each station given its `StationConfig`, then the power nodes.
//  - Slots are the netlist's, with the logic and maximum it set. A port is `dir 1` (output) where a net starts at it,
//    `dir 2` (input) where a net ends at it and `dir 0` otherwise; `storageIdx` is the 1-based position of the net's
//    item among the slots. `chargePerTick` is the request's, else the data's default for the station kind. No piler.
//    With several stations each one gets its own config (the building ids follow the netlist's station indices): a
//    station's slots cover the item of every port on it, an item has one slot on a station, and a port serves one net.
// Belts. One per net, with the net's id: the route's nodes, the net's item and tier, and the station ports the tap
//    assignment gave it as `source` / `sink`. `plannedRate` is the net's rate. The proliferator net (Task 28) is routed
//    after the others, so a call that is given no route for it leaves it out (the layout of the item nets alone).
// Coaters. The spray coaters the caller placed (proliferator.ts) are the layout's `coaters` as they are.
// Proliferator mode. A production building or lab of a plan that sprays in `speed` mode carries `prolifMode` 1, which the
//    blueprint writes as the machine's parameter and the simulator reads; with `extra` (or no proliferator) it carries none.
// Sorters. One per assigned tap, ids from 1 in assignment order. An `in` tap picks from the belt node at the tap
//    point and drops into the machine slot; an `out` tap does the reverse. Every sorter is filtered to its net's item,
//    whichever way it runs (an unfiltered output sorter on a machine with several products would put the wrong one
//    on the belt). The tier is the netlist's, the span and rate those of the tap.
//    The internal sorters of the netlist's motifs come after them: building to building, filtered to the item, at the
//    netlist's tier with the motif's span and planned rate.
// Stacks. A stacked building (`z`, `stackParentId`) is the placement's, as it is.
// Meta. The geometry is `'approximate'` as soon as one building, belt or sorter the layout uses is.
import type { ProductionPlan } from '../calc';
import type { GameDataIndex } from '../data';
import { sprayCoaterDef } from '../geometry';
import type { BeltPath, Endpoint, Layout, PlacedBuilding, Sorter, SprayCoater, StationConfig } from '../geometry';
import { provisionedRate } from '../validate/sim/run';
import type { BeltNet, Netlist } from './netlist';
import { placementBuildingIdOf, stationBuildingId } from './placement';
import type { Placement } from './placement';
import type { RoutedNet } from './router';
import type { TapAssignment } from './taps';

const STATION_PORTS = 12;

function stationConfig(
  netlist: Netlist,
  stationIdx: number,
  taps: TapAssignment,
  plan: ProductionPlan,
  data: GameDataIndex,
): StationConfig {
  const station = netlist.stations[stationIdx];
  const config: StationConfig = {
    slots: station.slots.map((s) => ({ ...s })),
    ports: Array.from({ length: STATION_PORTS }, () => ({ dir: 0 as const, storageIdx: 0 })),
    chargePerTick: plan.request.stationChargePerTick ?? data.data.constants.stationDefaultChargePerTick[station.kind],
    pilerCount: 0,
  };
  const id = stationBuildingId(stationIdx);
  const seen = new Set<number>();
  for (const { itemId } of config.slots) {
    if (seen.has(itemId)) throw new Error(`station ${stationIdx} has two slots for item ${itemId}`);
    seen.add(itemId);
  }
  const portNet = new Map<number, number>();
  for (const p of taps.stationPorts) {
    if (p.stationBuildingId !== id) continue;
    const net = netlist.nets.find((n) => n.id === p.netId);
    if (!net) throw new Error(`station port ${p.port} of building ${id} serves net ${p.netId}, which the netlist does not have`);
    const slot = config.slots.findIndex((s) => s.itemId === net.itemId);
    if (slot < 0) throw new Error(`net ${net.id} carries item ${net.itemId}, which station ${stationIdx} has no slot for`);
    if (!Number.isInteger(p.port) || p.port < 0 || p.port >= STATION_PORTS) {
      throw new Error(`net ${net.id} is on port ${p.port} of building ${id}, which has ${STATION_PORTS} ports`);
    }
    const other = portNet.get(p.port);
    if (other !== undefined) throw new Error(`port ${p.port} of building ${id} is used by nets ${other} and ${net.id}`);
    portNet.set(p.port, net.id);
    config.ports[p.port] = { dir: p.end === 'source' ? 1 : 2, storageIdx: slot + 1 };
  }
  return config;
}

function beltOf(net: BeltNet, route: RoutedNet | undefined, taps: TapAssignment): BeltPath {
  if (!route || route.nodes.length === 0) throw new Error(`net ${net.id} has no route`);
  const belt: BeltPath = {
    id: net.id,
    tierItemId: net.tierItemId,
    itemId: net.itemId,
    nodes: route.nodes.map((p) => ({ ...p })),
    plannedRate: net.rate,
  };
  for (const p of taps.stationPorts) {
    if (p.netId !== net.id) continue;
    if (p.end === 'source') belt.source = { buildingId: p.stationBuildingId, port: p.port };
    else belt.sink = { kind: 'port', buildingId: p.stationBuildingId, port: p.port };
  }
  return belt;
}

/** Does GameData mark any building, belt tier or sorter tier the layout uses as approximate? */
function geometrySource(
  buildings: PlacedBuilding[],
  netlist: Netlist,
  data: GameDataIndex,
  coaters: readonly SprayCoater[],
): Layout['meta']['geometrySource'] {
  const items = new Set<number>(buildings.map((b) => b.itemId));
  items.add(netlist.sorterTierItemId);
  for (const n of netlist.nets) items.add(n.tierItemId);
  const coater = coaters.length > 0 ? sprayCoaterDef(data) : undefined;
  if (coater) items.add(coater.itemId);
  for (const id of items) {
    const def = data.building(id);
    if (!def) {
      if (buildings.some((b) => b.itemId === id)) throw new Error(`GameData has no building for item ${id}`);
      continue;
    }
    if (def.geometry.source === 'approximate') return 'approximate';
  }
  return 'extracted';
}

/**
 * Assembles the layout of a placed, tapped and routed netlist (see the file comment). `routes` must hold a route for
 * every net of the netlist, and every tap point must be a ground node of its net's route. `powerNodes` are added to
 * the placement's buildings as they are. Throws on a net without a route, on a tap point that is not on its belt, and
 * on a power node whose id another building has.
 */
export function assembleLayout(
  netlist: Netlist,
  placement: Placement,
  taps: TapAssignment,
  routes: RoutedNet[],
  powerNodes: PlacedBuilding[],
  plan: ProductionPlan,
  data: GameDataIndex,
  coaters: readonly SprayCoater[] = [],
): Layout {
  const routeOf = new Map(routes.map((r) => [r.netId, r]));
  const stationIdxOf = new Map(netlist.stations.map((_, i) => [stationBuildingId(i), i]));
  const sprayMode: 0 | 1 | undefined =
    plan.request.proliferator.tier !== 0 && plan.request.proliferator.mode === 'speed' ? 1 : undefined;

  const buildings: PlacedBuilding[] = placement.buildings.map((b) => {
    const idx = stationIdxOf.get(b.id);
    if (idx !== undefined) return { ...b, station: stationConfig(netlist, idx, taps, plan, data) };
    return sprayMode !== undefined && b.recipeId !== undefined ? { ...b, prolifMode: sprayMode } : { ...b };
  });
  const ids = new Set(buildings.map((b) => b.id));
  for (const node of powerNodes) {
    if (ids.has(node.id)) throw new Error(`building id ${node.id} is used twice (power node and placement)`);
    ids.add(node.id);
    buildings.push({ ...node });
  }

  const belts: BeltPath[] = netlist.nets
    .filter((net) => !(net.proliferator && !routeOf.has(net.id)))
    .map((net) => beltOf(net, routeOf.get(net.id), taps));
  const beltById = new Map(belts.map((b) => [b.id, b]));

  const sorters: Sorter[] = [];
  for (const t of taps.taps) {
    const belt = beltById.get(t.netId);
    if (!belt) throw new Error(`a tap of machine ${t.machineId} is on net ${t.netId}, which the netlist does not have`);
    const node = belt.nodes.findIndex((p) => p.x === t.point.x && p.y === t.point.y && p.z === 0);
    if (node < 0) throw new Error(`net ${t.netId}: no belt node at tap point (${t.point.x}, ${t.point.y})`);
    const onMachine: Endpoint = { kind: 'building', buildingId: placementBuildingIdOf(t.machineId), slot: t.slot };
    const onBelt: Endpoint = { kind: 'belt', beltId: belt.id, node };
    sorters.push({
      id: sorters.length + 1,
      tierItemId: netlist.sorterTierItemId,
      filterItemId: belt.itemId,
      span: t.span,
      pick: t.dir === 'out' ? onMachine : onBelt,
      drop: t.dir === 'out' ? onBelt : onMachine,
      plannedRate: t.rate,
    });
  }

  for (const s of netlist.motifs?.sorters ?? []) {
    sorters.push({
      id: sorters.length + 1,
      tierItemId: netlist.sorterTierItemId,
      filterItemId: s.itemId,
      span: s.span,
      pick: { kind: 'building', buildingId: placementBuildingIdOf(s.fromMachine), slot: s.fromSlot },
      drop: { kind: 'building', buildingId: placementBuildingIdOf(s.toMachine), slot: s.toSlot },
      plannedRate: s.plannedRate,
    });
  }

  return {
    buildings,
    belts,
    sorters,
    ...(coaters.length > 0 ? { coaters: coaters.map((c) => ({ ...c })) } : {}),
    meta: {
      geometrySource: geometrySource(buildings, netlist, data, coaters),
      gameVersion: data.data.meta.gameVersion,
      planTargetItemId: plan.request.targetItemId,
      planTargetRate: provisionedRate(plan),
    },
  };
}
