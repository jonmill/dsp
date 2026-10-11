// Netlist: expands a ProductionPlan into what placement and routing have to realise (Task 20).
//  - machine instances, one per plan machine, ids 1.. in stage order then machine index (id 0 is unused);
//  - belt nets: one item flowing from its producers (a station port, or machine taps) to its consumers, ending at a
//    station port (exports) or dead-ending (feeds);
//  - logistics stations: which item sits in which slot of which station, and how many belt ports each one needs.
//
// Which nets an item gets. An item that flows out of the station (`from: 'import'`) gets a station-sourced net whose
// taps are its consumers. An item made by stages gets a taps-sourced net: the producers' taps, then the consumers'
// taps, ending at a station port when part of it is exported and dead-ending otherwise. An item that is both
// imported and made (Hydrogen from Plasma Refining) gets one of each; its consumers tap both. The proliferator
// import has no flows (spray coaters take it), so it gets a station slot here but no net; Task 28 adds that net.
//
// Splitting by rate. A net is cut into several when it carries more than `NET_LOAD` of its belt, or has more than
// `maxMachinesPerNet` taps. Think of the producers laid end to end along a rate axis [0, R) in id order, and of the
// consumers (then the station sink, if any) laid end to end on the same axis. A sub-net is a window [a, b) of that
// axis: it takes the consumers inside the window and the producers whose span overlaps it, so every sub-net's supply
// equals its demand. A producer whose span crosses a cut gets a tap in each sub-net, its rate divided. Windows are
// made as wide as the capacity and the tap limit allow, but a cut is moved back to the nearest consumer boundary,
// so a consumer stays whole unless it alone does not fit (one machine asking for more than a belt carries, or more
// producers than the tap limit allows). The window ends are floats from running sums, so spans closer than `EPS`
// count as touching.
//
// Stations. Each net that starts or ends at a station uses one port of it. Slots are handed out in the order target,
// imports by rate, proliferator, by-products; a station is full at `maxItemKinds` slots or 12 ports.
import type { ItemRate, ProductionPlan, StationSlotDemand } from '../calc';
import type { GameDataIndex, TechEffects } from '../data';
import type { StationSlotConfig } from '../geometry';
import { beltCapacity, sorterRate } from '../validate/capacity';

export interface MachineInst {
  id: number;
  stageIndex: number;
  recipeId: number;
  buildingItemId: number;
}
/** Per machine, at plan utilization (stage totals / machines). */
export interface MachineInstIO {
  inputs: ItemRate[];
  outputs: ItemRate[];
}
/** `sorters` is the number needed at span 1 (recomputed by assignTaps once spans are chosen). */
export interface NetTap {
  machineId: number;
  itemId: number;
  dir: 'in' | 'out';
  rate: number;
  sorters: number;
}
export interface BeltNet {
  /** From 1, in net order. */
  id: number;
  itemId: number;
  tierItemId: 2001 | 2002 | 2003;
  /** Items/s put on the belt: the demand of a station-sourced net, the producers' output of a taps-sourced one. */
  rate: number;
  /** Import belts start at a station port; intermediate belts start at the first producer tap. */
  source: { kind: 'station'; stationIdx: number } | { kind: 'taps' };
  /** Exports and by-products end at a station port; feed belts dead-end. */
  sink: { kind: 'station'; stationIdx: number } | { kind: 'deadEnd' };
  /** Producers (`out`) first, then consumers (`in`), each in machine id order. */
  taps: NetTap[];
}
export interface NetStation {
  kind: 'planetary' | 'interstellar';
  buildingItemId: number;
  slots: StationSlotConfig[];
  /** Belts that start or end at this station, one port each. */
  portsNeeded: number;
}
export interface Netlist {
  machines: (MachineInst & MachineInstIO)[];
  nets: BeltNet[];
  stations: NetStation[];
  sorterTierItemId: 2011 | 2012 | 2013 | 2014;
  beltTierItemId: 2001 | 2002 | 2003;
  warnings: string[];
}

const BELT_TIERS = [2001, 2002, 2003] as const;
const SORTER_TIERS = [2011, 2012, 2013, 2014] as const;
const STATION_ITEM = { planetary: 2103, interstellar: 2104 } as const;

/** Share of a belt's capacity a net is planned to use. */
export const NET_LOAD = 0.95;
const DEFAULT_MAX_MACHINES_PER_NET = 12;
/** More sorters than this on one machine tap do not fit beside the machine. */
const MAX_SORTERS_PER_TAP = 3;
/** Belt ports on a logistics station. */
const STATION_PORTS = 12;
/** Items/s below which a rate counts as zero (float noise from running sums). */
const EPS = 1e-9;
const REL_EPS = 1e-9;

/** Cargo stack on a net's belt: the station stack when it starts at a station port, else 1 (as the validator has it). */
export function netStack(stationSourced: boolean, effects: TechEffects): number {
  return stationSourced ? effects.stationPilerLevel : 1;
}

/** Items/s a net of this belt tier is planned to carry: `NET_LOAD · beltCapacity(tier, stack)`. */
export function netCapacity(
  tierItemId: number,
  stationSourced: boolean,
  effects: TechEffects,
  data: GameDataIndex,
): number {
  return NET_LOAD * beltCapacity(tierItemId, netStack(stationSourced, effects), data);
}

/**
 * Sorters a tap needs for `rate` items/s at `span`. `stackFromBelt` is the stack of the belt the sorters pick from,
 * 0 for sorters that pick from a machine (see `sorterRate`).
 */
export function sortersNeeded(
  rate: number,
  sorterTierItemId: number,
  span: number,
  stackFromBelt: number,
  effects: TechEffects,
  data: GameDataIndex,
): number {
  const perSorter = sorterRate(sorterTierItemId, span, stackFromBelt, effects, data);
  return Math.max(1, Math.ceil(rate / perSorter - REL_EPS));
}

/** The highest tier in `tiers` that is available; the lowest, with a warning, when none is. */
function bestTier<T extends number>(
  tiers: readonly T[],
  effects: TechEffects,
  what: string,
  data: GameDataIndex,
  warnings: string[],
): T {
  const available = tiers.filter((id) => effects.availableBuildings.has(id));
  if (available.length > 0) return available[available.length - 1];
  const fallback = tiers[0];
  warnings.push(`no ${what} is unlocked; assuming ${itemName(data, fallback)}`);
  return fallback;
}

function itemName(data: GameDataIndex, itemId: number): string {
  try {
    return data.item(itemId).name;
  } catch {
    return `item ${itemId}`;
  }
}

/** A machine's share of a stage total. */
const perMachine = (rates: ItemRate[], machines: number): ItemRate[] =>
  rates.map((r) => ({ itemId: r.itemId, perSecond: r.perSecond / machines }));

/** A machine, or the station sink (`machineId` 0), and what it gives or takes. */
interface Piece {
  machineId: number;
  rate: number;
}
/** A piece's stretch of the rate axis. */
interface Span {
  machineId: number;
  lo: number;
  hi: number;
}

/** One item's flows of one kind, before they are cut into belts. */
interface NetSpec {
  itemId: number;
  /** The producer is the station (an import), not machines. */
  stationSourced: boolean;
  /** Stage index -> items/s its machines put on the belts. */
  producers: Map<number, number>;
  /** Stage index -> items/s its machines take off the belts. */
  consumers: Map<number, number>;
  /** Items/s that end at the station. */
  exportRate: number;
}

/** A window [from, to) of the rate axis: one sub-net. */
interface Cut {
  from: number;
  to: number;
}

const add = (map: Map<number, number>, key: number, amount: number): void => {
  map.set(key, (map.get(key) ?? 0) + amount);
};

/** Groups the plan's flows into one spec per item and kind (station-sourced first, then by item id). */
function collectSpecs(plan: ProductionPlan): NetSpec[] {
  const specs = new Map<string, NetSpec>();
  for (const flow of plan.flows) {
    if (flow.perSecond <= EPS) continue;
    if (flow.from === 'import' && flow.to === 'export') {
      throw new Error(`netlist: ${flow.itemId} flows from import to export without passing a stage`);
    }
    const stationSourced = flow.from === 'import';
    const key = `${flow.itemId}/${stationSourced}`;
    let spec = specs.get(key);
    if (!spec) {
      spec = { itemId: flow.itemId, stationSourced, producers: new Map(), consumers: new Map(), exportRate: 0 };
      specs.set(key, spec);
    }
    if (flow.from !== 'import') add(spec.producers, flow.from, flow.perSecond);
    if (flow.to === 'export') spec.exportRate += flow.perSecond;
    else add(spec.consumers, flow.to, flow.perSecond);
  }
  return [...specs.values()].sort((a, b) => Number(b.stationSourced) - Number(a.stationSourced) || a.itemId - b.itemId);
}

/** The machines of the stages, one piece each, in machine id order. */
function expand(byStage: Map<number, number>, machineIdsOfStage: number[][]): Piece[] {
  const pieces: Piece[] = [];
  for (const stage of [...byStage.keys()].sort((a, b) => a - b)) {
    const ids = machineIdsOfStage[stage];
    if (!ids || ids.length === 0) throw new Error(`netlist: a flow touches stage ${stage}, which has no machines`);
    const rate = (byStage.get(stage) as number) / ids.length;
    for (const machineId of ids) pieces.push({ machineId, rate });
  }
  return pieces;
}

/** Lays pieces end to end on the rate axis. */
function toSpans(pieces: Piece[]): Span[] {
  let at = 0;
  return pieces.map(({ machineId, rate }) => {
    const span = { machineId, lo: at, hi: at + rate };
    at = span.hi;
    return span;
  });
}

/** How far the spans overlap the window. */
const overlap = (s: Span, w: Cut): number => Math.min(s.hi, w.to) - Math.max(s.lo, w.from);

/**
 * Cuts the rate axis into windows of at most `capacity` items/s and `maxTaps` taps, as wide as possible and ending
 * at a consumer boundary where one fits. `taps` are the spans that take a tap (the station sink does not).
 */
function cutWindows(taps: Span[], consumers: Span[], total: number, capacity: number, maxTaps: number): Cut[] {
  const windows: Cut[] = [];
  let from = 0;
  while (from < total - EPS) {
    const open = taps.filter((s) => s.lo <= from + EPS && s.hi > from + EPS).length;
    const starts = taps
      .filter((s) => s.lo > from + EPS)
      .map((s) => s.lo)
      .sort((a, b) => a - b);
    let to = Math.min(from + capacity * (1 + REL_EPS), total);
    // `open` taps plus the starts before `to` must stay within `maxTaps`
    const tapLimit = starts[maxTaps - open];
    if (tapLimit !== undefined) to = Math.min(to, tapLimit);
    if (to >= total - EPS) {
      to = total;
    } else {
      // prefer ending where a consumer ends, so it keeps one tap
      let snapped = from;
      for (const c of consumers) if (c.hi > snapped && c.hi <= to + EPS) snapped = c.hi;
      if (snapped > from + EPS) to = snapped;
    }
    windows.push({ from, to });
    from = to;
  }
  return windows;
}

/** Slot demands in the order stations are filled: target, imports by rate, proliferator, by-products. */
function slotOrder(plan: ProductionPlan): StationSlotDemand[] {
  const left = new Map(plan.stationSlots.map((s) => [s.itemId, s]));
  const ordered: StationSlotDemand[] = [];
  const take = (itemId: number): void => {
    const slot = left.get(itemId);
    if (!slot) return;
    ordered.push(slot);
    left.delete(itemId);
  };
  take(plan.request.targetItemId);
  const importsByRate = [...plan.imports].sort((a, b) => b.perSecond - a.perSecond);
  for (const { itemId } of importsByRate) if (left.get(itemId)?.role === 'import') take(itemId);
  for (const slot of [...left.values()]) if (slot.role === 'proliferator') take(slot.itemId);
  for (const { itemId } of plan.exports) take(itemId);
  for (const itemId of [...left.keys()]) take(itemId);
  return ordered;
}

/**
 * Expands `plan` into machines, belt nets and stations.
 *
 * Belts and sorters are the best tiers `effects` has unlocked (the pile sorter counts; it moves one item per trip
 * from a building, as `sorterRate` has it, so building picks are not special). If none is unlocked, Mk.I is assumed
 * and a warning says so. Throws if a net touches an item without a matching station slot, or if the split leaves a
 * sub-net with less supply than demand (a bug).
 */
export function buildNetlist(
  plan: ProductionPlan,
  data: GameDataIndex,
  effects: TechEffects,
  opts: { maxMachinesPerNet?: number } = {},
): Netlist {
  const maxTaps = opts.maxMachinesPerNet ?? DEFAULT_MAX_MACHINES_PER_NET;
  if (!Number.isInteger(maxTaps) || maxTaps < 2) {
    throw new RangeError(`maxMachinesPerNet must be an integer of at least 2, got ${maxTaps}`);
  }
  const warnings: string[] = [];
  const beltTierItemId = bestTier(BELT_TIERS, effects, 'conveyor belt', data, warnings);
  const sorterTierItemId = bestTier(SORTER_TIERS, effects, 'sorter', data, warnings);

  // machines
  const machines: Netlist['machines'] = [];
  const machineIdsOfStage: number[][] = [];
  plan.stages.forEach((stage, stageIndex) => {
    const ids: number[] = [];
    for (let i = 0; i < stage.machines; i++) {
      const id = machines.length + 1;
      ids.push(id);
      machines.push({
        id,
        stageIndex,
        recipeId: stage.recipeId,
        buildingItemId: stage.buildingItemId,
        inputs: perMachine(stage.inputs, stage.machines),
        outputs: perMachine(stage.outputs, stage.machines),
      });
    }
    machineIdsOfStage.push(ids);
  });

  // nets
  const nets: BeltNet[] = [];
  for (const spec of collectSpecs(plan)) {
    const producerPieces = spec.stationSourced ? [] : expand(spec.producers, machineIdsOfStage);
    const consumerPieces = expand(spec.consumers, machineIdsOfStage);
    if (spec.exportRate > EPS) consumerPieces.push({ machineId: 0, rate: spec.exportRate });
    const producers = toSpans(producerPieces);
    const consumers = toSpans(consumerPieces);
    const total = consumers.length > 0 ? consumers[consumers.length - 1].hi : 0;
    const capacity = netCapacity(beltTierItemId, spec.stationSourced, effects, data);
    const stack = netStack(spec.stationSourced, effects);
    const tapSpans = [...producers, ...consumers.filter((c) => c.machineId !== 0)];

    for (const cut of cutWindows(tapSpans, consumers, total, capacity, maxTaps)) {
      const taps: NetTap[] = [];
      const tap = (s: Span, dir: NetTap['dir']): void => {
        const rate = overlap(s, cut);
        if (rate <= EPS) return;
        const sorters = sortersNeeded(rate, sorterTierItemId, 1, dir === 'in' ? stack : 0, effects, data);
        taps.push({ machineId: s.machineId, itemId: spec.itemId, dir, rate, sorters });
      };
      for (const s of producers) tap(s, 'out');
      for (const s of consumers) if (s.machineId !== 0) tap(s, 'in');

      const demand = cut.to - cut.from;
      const supply = spec.stationSourced ? demand : taps.filter((t) => t.dir === 'out').reduce((n, t) => n + t.rate, 0);
      if (supply < demand - 1e-6) {
        throw new Error(
          `netlist: a sub-net of ${itemName(data, spec.itemId)} has supply ${supply} below demand ${demand} (a split bug)`,
        );
      }
      const exported = consumers.some((c) => c.machineId === 0 && overlap(c, cut) > EPS);
      const net: BeltNet = {
        id: nets.length + 1,
        itemId: spec.itemId,
        tierItemId: beltTierItemId,
        rate: supply,
        source: spec.stationSourced ? { kind: 'station', stationIdx: -1 } : { kind: 'taps' },
        sink: exported ? { kind: 'station', stationIdx: -1 } : { kind: 'deadEnd' },
        taps,
      };
      nets.push(net);
    }
  }
  // sorters: the belt tier is already the best, so a tap that needs too many is a warning, not a tier change
  for (const net of nets) {
    const heavy = net.taps.filter((t) => t.sorters > MAX_SORTERS_PER_TAP);
    if (heavy.length === 0) continue;
    warnings.push(
      `net ${net.id} (${itemName(data, net.itemId)}): ${heavy.length} tap(s) need more than ` +
        `${MAX_SORTERS_PER_TAP} sorters ` +
        `at span 1 (up to ${Math.max(...heavy.map((t) => t.sorters))}), already on the best belt and sorter tiers`,
    );
  }

  // stations
  const stationKind = plan.request.stationKind;
  const stationItemId = STATION_ITEM[stationKind];
  const stationSpec = data.building(stationItemId)?.station;
  if (!stationSpec) throw new Error(`GameData has no station for item ${stationItemId}`);
  const remote = stationKind === 'interstellar';
  const stations: NetStation[] = [];
  const newStation = (): NetStation => {
    const station: NetStation = { kind: stationKind, buildingItemId: stationItemId, slots: [], portsNeeded: 0 };
    stations.push(station);
    return station;
  };

  const roleOf = new Map(plan.stationSlots.map((s) => [s.itemId, s.role]));
  const netsOfItem = new Map<number, BeltNet[]>();
  for (const net of nets) {
    const imported = net.source.kind === 'station';
    if (!imported && net.sink.kind !== 'station') continue;
    const role = roleOf.get(net.itemId);
    if (role === undefined) {
      throw new Error(`netlist: the plan has no station slot for ${itemName(data, net.itemId)} (${net.itemId})`);
    }
    if (imported === (role === 'export')) {
      throw new Error(
        `netlist: ${itemName(data, net.itemId)} (${net.itemId}) is ${imported ? 'imported' : 'exported'} ` +
          `but its station slot is ${role}`,
      );
    }
    const list = netsOfItem.get(net.itemId) ?? [];
    list.push(net);
    netsOfItem.set(net.itemId, list);
  }

  let current: NetStation | undefined;
  for (const { itemId, role } of slotOrder(plan)) {
    const demand = role !== 'export';
    const slot: StationSlotConfig = {
      itemId,
      localLogic: demand ? 2 : 1,
      remoteLogic: remote ? (demand ? 2 : 1) : 0,
      max: stationSpec.maxItemCount,
    };
    const itemNets = netsOfItem.get(itemId) ?? [];
    let placed = 0;
    do {
      // as many of the item's ports as one station takes; a new station when slot or ports would overflow
      const want = Math.min(itemNets.length - placed, STATION_PORTS);
      if (!current || current.slots.length >= stationSpec.maxItemKinds || current.portsNeeded + want > STATION_PORTS) {
        current = newStation();
      }
      current.slots.push({ ...slot });
      const stationIdx = stations.length - 1;
      for (const net of itemNets.slice(placed, placed + want)) {
        if (net.source.kind === 'station') net.source = { kind: 'station', stationIdx };
        else net.sink = { kind: 'station', stationIdx };
      }
      current.portsNeeded += want;
      placed += want;
    } while (placed < itemNets.length);
  }
  while (stations.length < plan.stationsNeeded) newStation();
  if (stations.length > plan.stationsNeeded) {
    warnings.push(
      `the netlist needs ${stations.length} stations, the plan predicted ${plan.stationsNeeded}: ` +
        `belt ports (${STATION_PORTS} per station) need more than the item slots do`,
    );
  }

  return { machines, nets, stations, sorterTierItemId, beltTierItemId, warnings };
}
