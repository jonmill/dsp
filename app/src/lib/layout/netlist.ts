// Netlist: expands a ProductionPlan into what placement and routing have to realise (Task 20).
//  - machine instances, one per plan machine, ids 1.. in stage order then machine index (id 0 is unused);
//  - belt nets: one item flowing from its producers (a station port, or machine taps) to its consumers, ending at a
//    station port (exports) or dead-ending (feeds);
//  - logistics stations: which item sits in which slot of which station, and how many belt ports each one needs.
//
// Which nets an item gets. An item that flows out of the station (`from: 'import'`) gets a station-sourced net whose
// taps are its consumers. An item made by stages gets a taps-sourced net: the producers' taps, then the consumers'
// taps, ending at a station port when part of it is exported and dead-ending otherwise. An item that is both
// imported and made (Hydrogen from Plasma Refining) gets the station-sourced net(s) for ALL its consumers, at their
// full rate, and a taps-sourced net(s) that carries every producer's output and ends at the station: a consumer
// never taps a belt a producer feeds. (Otherwise consumers fill from the import belt, which the always-full station
// keeps full, and the producers' belt backs up and blocks them.) A station input port takes any item of a configured
// slot whatever the slot's logic, so the slot keeps the import role the plan gave it and the station pools both
// sources.
//
// The proliferator (Task 28). Its import has no flows: spray coaters take it, not stages. When the plan spends any
// (`proliferatorPerSecond`), the netlist adds one more net, last: `proliferator: true`, starting at the station that
// holds the proliferator's slot, with no taps and a dead end. Where it goes is not known yet: the router lays it through
// the top passages of the coaters, which are placed on the other nets' routes (proliferator.ts). Every other net that has a
// consumer in a proliferated stage is marked `sprayed`: a coater goes on its belt. The feed takes a belt port of its
// station like any other net, so a full station (12 ports) gets a new one.
//
// Splitting by rate. A net is cut into several when it carries more than `NET_LOAD` of its belt, or has more than
// `maxMachinesPerNet` taps. Think of the producers laid end to end along a rate axis [0, R) in id order, and of the
// consumers (then the station sink, if any) laid end to end on the same axis. A sub-net is a window [a, b) of that
// axis: it takes the consumers inside the window and the producers whose span overlaps it, so every sub-net's supply
// equals its demand. A producer whose span crosses a cut would get a tap, and a planned share, in each sub-net, and
// output sorters cannot enforce a share: one grabs everything and the other net starves. A consumer split the same way
// shares its input between two belts, which its sorters cannot enforce either; the router visits such consumers last
// on each belt, in machine id order, so that one can only take what reaches the end of the belt (see router.ts). So
// windows are made as wide as the capacity allows, and a cut is placed, in this order of preference, at
//  1. the latest producer end that cuts no consumer machine (the station sink is a port on each net it spans, not a
//     machine, so it may be cut), if the net then also has at most `maxMachinesPerNet` taps;
//  2. else the latest such point within the capacity alone: the producers stay whole and the net holds more taps than
//     `maxMachinesPerNet`, which a warning says;
//  3. else the latest producer end within the capacity, within the tap limit if one is: a consumer is split;
//  4. else no producer ends within the capacity, because one machine makes more than a belt carries: the cut is at the
//     capacity or the tap limit, moved back to a consumer end, and that producer is split (a warning names it).
// The window ends are floats from running sums, so spans closer than `EPS` count as touching.
//
// Stations. Each net that starts or ends at a station uses one port of it. Slots are handed out in the order target,
// imports by rate, proliferator, by-products; a station is full at `maxItemKinds` slots or 12 ports. An item that is
// imported and made keeps the nets that end at the station on the same stations as the nets that start there (a
// station's stock of it only drains through its own output ports): its nets are dealt into groups that each hold at
// least one import net, and if the sink nets need more stations than there are import nets, the import is cut into
// more nets (consumers of the import are split between them).
import type { ItemRate, ProductionPlan, StationSlotDemand } from '../calc';
import { proliferatorItemId } from '../calc/proliferator';
import type { GameDataIndex, TechEffects } from '../data';
import type { StationSlotConfig } from '../geometry';
import { beltCapacity, sorterRate } from '../validate/capacity';
import type { NetlistMotifs } from './motifs/types';

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
  /**
   * Exports, by-products and what is made of an item the station also supplies end at a station port; feed belts
   * dead-end.
   */
  sink: { kind: 'station'; stationIdx: number } | { kind: 'deadEnd' };
  /** Producers (`out`) first, then consumers (`in`), each in machine id order. */
  taps: NetTap[];
  /**
   * Set on the net that carries the proliferator to the spray coaters (see the file comment). It has no taps; it is
   * routed after the other nets, through the top passage of every coater.
   */
  proliferator?: true;
  /** Set on a net that feeds a machine of a proliferated stage: a spray coater stands on its belt, before the consumers. */
  sprayed?: true;
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
  /**
   * Set by `applyMotifs` (motifs/index.ts), never by `buildNetlist`: machines that placement keeps together, and the
   * sorters between them that stand in for belts. The nets are those left after the motifs took theirs off.
   */
  motifs?: NetlistMotifs;
}

const BELT_TIERS = [2001, 2002, 2003] as const;
const SORTER_TIERS = [2011, 2012, 2013, 2014] as const;
const STATION_ITEM = { planetary: 2103, interstellar: 2104 } as const;

/** Share of a belt's capacity a net is planned to use. */
export const NET_LOAD = 0.95;
const DEFAULT_MAX_MACHINES_PER_NET = 12;
/** More sorters than this on one machine tap do not fit beside the machine. */
export const MAX_SORTERS_PER_TAP = 3;
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
  // An item that is imported and made: every consumer takes from the station, every producer feeds the station.
  for (const spec of specs.values()) {
    if (spec.stationSourced) continue;
    const imported = specs.get(`${spec.itemId}/true`);
    if (!imported) continue;
    for (const [stage, rate] of spec.consumers) add(imported.consumers, stage, rate);
    spec.consumers.clear();
    spec.exportRate = [...spec.producers.values()].reduce((n, r) => n + r, 0);
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
 * Cuts the rate axis into windows of at most `capacity` items/s, as wide as possible, without splitting a producer (see
 * the file comment for the order of preference). `producers` are the producers' spans (none for a station-sourced
 * net), `consumers` the consumers' spans with the station sink (`machineId` 0) last; it takes no tap.
 */
function cutWindows(producers: Span[], consumers: Span[], total: number, capacity: number, maxTaps: number): Cut[] {
  const machineConsumers = consumers.filter((c) => c.machineId !== 0);
  const taps = [...producers, ...machineConsumers];
  // with no producers the ends of the consumers are the candidate cuts
  const producerEnds = producers.length > 0 ? producers.map((p) => p.hi) : machineConsumers.map((c) => c.hi);
  // a cut at `x` splits no consumer machine (the station sink is not one: it is a port on every net it spans)
  const clean = (x: number): boolean => !machineConsumers.some((c) => c.lo + EPS < x && x < c.hi - EPS);
  const windows: Cut[] = [];
  let from = 0;
  while (from < total - EPS) {
    const reach = Math.min(from + capacity * (1 + REL_EPS), total);
    const tapsUpTo = (to: number): number =>
      taps.filter((s) => Math.min(s.hi, to) - Math.max(s.lo, from) > EPS).length;
    const ends = [...new Set(producerEnds.map((x) => Math.min(x, total)))]
      .filter((x) => x > from + EPS && x <= reach + EPS)
      .sort((a, b) => a - b);
    const fits = (x: number): boolean => tapsUpTo(x) <= maxTaps;
    const latest = (xs: number[]): number | undefined => xs[xs.length - 1];
    const cleanEnds = ends.filter(clean);
    let to = latest(cleanEnds.filter(fits)) ?? latest(cleanEnds) ?? latest(ends.filter(fits)) ?? latest(ends);
    if (to === undefined) {
      // one producer makes more than a belt carries: cut at the capacity, or the tap limit, back to a consumer end
      to = reach;
      const starts = taps
        .filter((s) => s.lo > from + EPS)
        .map((s) => s.lo)
        .sort((a, b) => a - b);
      const open = taps.filter((s) => s.lo <= from + EPS && s.hi > from + EPS).length;
      const tapLimit = starts[maxTaps - open];
      if (tapLimit !== undefined) to = Math.min(to, tapLimit);
      if (to < total - EPS) {
        let snapped = from;
        for (const c of machineConsumers) if (c.hi > snapped && c.hi <= to + EPS) snapped = c.hi;
        if (snapped > from + EPS) to = snapped;
      }
    }
    if (to >= total - EPS) to = total;
    windows.push({ from, to });
    from = to;
  }
  return windows;
}

/**
 * Splits windows of the rate axis until there are `count` of them: the widest window that has a consumer machine end
 * strictly inside it is cut at the end nearest its middle (no consumer is split); when no window has one, the widest is
 * cut in the middle (a consumer is split, as an over-capacity consumer is). Changes `windows` in place.
 */
function splitWindows(windows: Cut[], consumers: Span[], count: number): void {
  while (windows.length > 0 && windows.length < count) {
    const inside = (w: Cut): Span[] => consumers.filter((c) => c.machineId !== 0 && c.hi > w.from + EPS && c.hi < w.to - EPS);
    const widest = (xs: Cut[]): number => xs.reduce((best, w, i) => (w.to - w.from > xs[best].to - xs[best].from ? i : best), 0);
    const clean = windows.map((w, i) => ({ w, i })).filter(({ w }) => inside(w).length > 0);
    const at = clean.length > 0 ? clean[widest(clean.map(({ w }) => w))].i : widest(windows);
    const w = windows[at];
    const middle = (w.from + w.to) / 2;
    const ends = inside(w).map((c) => c.hi);
    const cut = ends.length > 0 ? ends.reduce((best, x) => (Math.abs(x - middle) < Math.abs(best - middle) ? x : best)) : middle;
    windows.splice(at, 1, { from: w.from, to: cut }, { from: cut, to: w.to });
  }
}

/**
 * Deals the nets of an item that is imported and made among stations. A station that takes the producers' nets ends
 * them in the item's slot, which only drains through an output port of the same station; so each group gets import
 * nets and sink nets together. As few groups as the 12 ports allow, import nets dealt in runs of near-equal size, each
 * sink net to the group with the most import rate left over its sink rate that still has a free port.
 */
function groupPooledNets(imports: BeltNet[], sinks: BeltNet[]): BeltNet[][] {
  const groups = Math.max(1, Math.ceil((imports.length + sinks.length) / STATION_PORTS));
  const dealt: BeltNet[][] = Array.from({ length: groups }, () => []);
  let next = 0;
  for (let g = 0; g < groups; g++) {
    const size = Math.floor(imports.length / groups) + (g < imports.length % groups ? 1 : 0);
    dealt[g] = imports.slice(next, next + size);
    next += size;
  }
  const spare = dealt.map((list) => list.reduce((n, net) => n + net.rate, 0));
  for (const sink of sinks) {
    let best = -1;
    for (let g = 0; g < groups; g++) {
      if (dealt[g].length >= STATION_PORTS) continue;
      if (best < 0 || spare[g] > spare[best]) best = g;
    }
    dealt[best].push(sink);
    spare[best] -= sink.rate;
  }
  return dealt;
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
 * Checks what the cuts promise and warns about what they gave up. Throws if a producer machine has `out` taps for one
 * item on several nets although it makes no more than a belt carries, or if a consumer taps a belt a producer of an
 * item that the station also supplies feeds (both are bugs). Warns about each producer that has to be split because
 * it makes more than one belt carries, and about each net that holds more taps than `maxTaps` so that a producer
 * stays whole.
 */
function checkProducers(
  nets: BeltNet[],
  machines: Netlist['machines'],
  importedItems: Set<number>,
  beltTierItemId: number,
  maxTaps: number,
  effects: TechEffects,
  data: GameDataIndex,
  warnings: string[],
): void {
  const outOf = new Map<string, { machineId: number; itemId: number; nets: number; rate: number }>();
  for (const net of nets) {
    if (importedItems.has(net.itemId) && net.source.kind === 'taps' && net.taps.some((t) => t.dir === 'in')) {
      throw new Error(
        `netlist: net ${net.id} of ${itemName(data, net.itemId)} has producers and consumers, ` +
          `but the station also supplies ${itemName(data, net.itemId)} (a split bug)`,
      );
    }
    if (net.taps.length > maxTaps) {
      warnings.push(
        `net ${net.id} (${itemName(data, net.itemId)}) has ${net.taps.length} taps, more than the ${maxTaps} of ` +
          `maxMachinesPerNet: no cut keeps every producer whole within the belt capacity and the limit`,
      );
    }
    for (const t of net.taps) {
      if (t.dir !== 'out') continue;
      const key = `${t.machineId}/${t.itemId}`;
      const entry = outOf.get(key) ?? { machineId: t.machineId, itemId: t.itemId, nets: 0, rate: 0 };
      entry.nets++;
      entry.rate += t.rate;
      outOf.set(key, entry);
    }
  }
  for (const { machineId, itemId, nets: count, rate } of outOf.values()) {
    if (count < 2) continue;
    const capacity = netCapacity(beltTierItemId, false, effects, data);
    const machine = machines[machineId - 1];
    const name = `machine ${machineId} (${data.building(machine.buildingItemId)?.name ?? `item ${machine.buildingItemId}`})`;
    if (rate <= capacity * (1 - 1e-6)) {
      throw new Error(
        `netlist: ${name} makes ${rate} ${itemName(data, itemId)}/s, which one belt carries, ` +
          `but its output is on ${count} nets (a split bug)`,
      );
    }
    warnings.push(
      `${name} makes ${+rate.toFixed(3)} ${itemName(data, itemId)}/s, more than one belt carries ` +
        `(${+capacity.toFixed(3)}/s), so its output is split over ${count} belts`,
    );
  }
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

  // nets: first every spec's windows, then the nets, so that the windows of an item can be adjusted to its stations
  const planned = collectSpecs(plan).map((spec) => {
    const producerPieces = spec.stationSourced ? [] : expand(spec.producers, machineIdsOfStage);
    const consumerPieces = expand(spec.consumers, machineIdsOfStage);
    if (spec.exportRate > EPS) consumerPieces.push({ machineId: 0, rate: spec.exportRate });
    const producers = toSpans(producerPieces);
    const consumers = toSpans(consumerPieces);
    const total = consumers.length > 0 ? consumers[consumers.length - 1].hi : 0;
    const capacity = netCapacity(beltTierItemId, spec.stationSourced, effects, data);
    const windows = cutWindows(producers, consumers, total, capacity, maxTaps);
    return { spec, producers, consumers, stack: netStack(spec.stationSourced, effects), windows };
  });
  // An item that is imported and made: each station that takes the producers' nets also needs an import net of the item
  // to drain it (see `groupPooledNets`), and a station has 12 ports, so there must be at least one import net per 11
  // sink nets.
  for (const made of planned) {
    const imported = planned.find((p) => p.spec.stationSourced && p.spec.itemId === made.spec.itemId);
    if (made.spec.stationSourced || !imported) continue;
    splitWindows(imported.windows, imported.consumers, Math.ceil(made.windows.length / (STATION_PORTS - 1)));
  }

  const nets: BeltNet[] = [];
  for (const { spec, producers, consumers, stack, windows } of planned) {
    for (const cut of windows) {
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
  const importedItems = new Set(nets.filter((n) => n.source.kind === 'station').map((n) => n.itemId));
  checkProducers(nets, machines, importedItems, beltTierItemId, maxTaps, effects, data, warnings);

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

  // the proliferator: the nets whose consumers are proliferated get a coater, and one more net feeds the coaters
  const sprayTier = plan.request.proliferator.tier;
  if (sprayTier !== 0 && plan.proliferatorPerSecond > EPS) {
    for (const net of nets) {
      const consumesSprayed = net.taps.some((t) => t.dir === 'in' && plan.stages[machines[t.machineId - 1].stageIndex]?.proliferated);
      if (consumesSprayed) net.sprayed = true;
    }
    nets.push({
      id: nets.length + 1,
      itemId: proliferatorItemId(sprayTier),
      tierItemId: beltTierItemId,
      rate: plan.proliferatorPerSecond,
      source: { kind: 'station', stationIdx: -1 },
      sink: { kind: 'deadEnd' },
      taps: [],
      proliferator: true,
    });
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
    // what a producer of an imported item makes goes back to the station: its slot keeps the import role
    const pooled = !imported && importedItems.has(net.itemId) && role === 'import';
    // the proliferator net draws from its slot whatever role the slot has (the plan makes the proliferator it sprays with
    // when that is the target: the slot is then an export)
    if (!pooled && !net.proliferator && imported === (role === 'export')) {
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
    const imports = itemNets.filter((n) => n.source.kind === 'station');
    const sinks = itemNets.filter((n) => n.source.kind !== 'station');
    // groups of nets that go to one station together: an imported and made item keeps its sinks with its imports
    const groups: BeltNet[][] = [];
    if (imports.length > 0 && sinks.length > 0) {
      groups.push(...groupPooledNets(imports, sinks));
    } else {
      for (let at = 0; at < itemNets.length; at += STATION_PORTS) groups.push(itemNets.slice(at, at + STATION_PORTS));
      if (groups.length === 0) groups.push([]);
    }
    for (const group of groups) {
      // a new station when the slot or the ports would overflow
      if (!current || current.slots.length >= stationSpec.maxItemKinds || current.portsNeeded + group.length > STATION_PORTS) {
        current = newStation();
      }
      current.slots.push({ ...slot });
      const stationIdx = stations.length - 1;
      for (const net of group) {
        if (net.source.kind === 'station') net.source = { kind: 'station', stationIdx };
        else net.sink = { kind: 'station', stationIdx };
      }
      current.portsNeeded += group.length;
    }
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
