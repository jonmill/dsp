// Direct insertion (MX §9 M3): a machine hands its product to the next one through a sorter between the two, so the
// item needs no belt, no tap on either machine and no lattice row between them.
//
// What is a cluster. A centre machine and up to `MAX_NEIGHBOURS` neighbours stand in a fixed arrangement, each
// neighbour linked to the centre by sorters between facing slots. A link replaces taps: on one net, the centre's tap
// and the taps of its neighbours there. They have to balance, so what is left of the net still balances: the centre
// makes (or takes) exactly what its one or two neighbours on that net take (or make). That covers a producer and a consumer
// of one item with equal rates (a pair), one producer for two consumers, and two producers for one consumer. A centre
// can link on several nets (a coil assembler fed magnet and copper by three smelters).
//
// Geometry. For two building types, `linkPoses` searches the poses of the second one beside the first (offsets of
// -8 to 8 tiles, four yaws) where facing slots can carry a sorter: the slots face each other, their first lattice
// points outside lie on one line at most `span - 1 <= 2` tiles apart, and the sorter's ends pass `sorterEndsValid`.
// Each such pair of slots is then confirmed by the validator's own geometry checks on a two-building layout with that
// sorter (every SORTER_* and BUILDING_* rule; the power and station rules are not asked, there is nothing to power).
// A sorter moves one item a trip from a building (`sorterRate` with no belt), so a link of a higher rate takes several
// pairs of slots, on different slots of both machines.
//
// Which clusters. Every centre with balanced neighbours is a candidate (and each combination of its links); those whose
// buildings have an arrangement that passes the validator's rules are kept. Machines belong to one cluster at most, so
// the clusters are chosen to remove the most sorters from the belts (exactly, among few candidates, else greedily by
// sorters per machine). An arrangement with more internal sorters than the taps it removes is not worth it and is left out.
import type { Building, GameDataIndex, TechEffects } from '../../data';
import { buildingDef, buildingOBBs, obbOverlap, slotInfos, sorterEndsValid } from '../../geometry';
import type { Layout, OBB2, PlacedBuilding, SlotInfo, Sorter, Yaw } from '../../geometry';
import { checkGeometry } from '../../validate';
import { sorterRate } from '../../validate/capacity';
import type { NetTap, Netlist } from '../netlist';
import { obbsBounds } from '../occupancy';
import type { Bounds } from '../occupancy';
import type { Motif, MotifInstance } from './types';

/** The offsets searched for a neighbour, in tiles, each way. */
const SEARCH = 8;
/** The poses of one building type beside another that are kept, best (smallest box) first. */
const POSES_KEPT = 40;
/** Combinations of poses looked at for a centre and its neighbours. */
const LEAF_BUDGET = 800;
/** The best combinations that get the full validator check before one is taken. */
const VERIFY_TRIES = 6;
/** Neighbours a centre can have: one on each side. */
const MAX_NEIGHBOURS = 4;
/** Links (nets) of one centre that are combined. */
const MAX_LINK_SETS = 6;
/** Candidates up to this many are chosen from exactly; more are chosen greedily. */
const EXACT_LIMIT = 36;
/** Flows closer than this (relative) are the same. */
const BALANCE_EPS = 1e-6;
const YAWS: readonly Yaw[] = [0, 90, 180, 270];
/** The codes of the rules that need a power node or a station: nothing to judge in a layout of two machines. */
const NOT_ASKED = /^(POWER_|STATION_)/;
/** Any sorter tier does for the geometry rules. */
const PROBE_SORTER = 2011;

export interface Pair {
  centreSlot: number;
  otherSlot: number;
  span: 1 | 2 | 3;
}

/** A pose of one building beside a centre at the origin (yaw 0), with the slot pairs that can carry a sorter there. */
export interface Pose {
  dx: number;
  dy: number;
  yaw: Yaw;
  pairs: Pair[];
  obbs: OBB2[];
  bounds: Bounds;
}

const area = (b: Bounds): number => (b.maxX - b.minX) * (b.maxY - b.minY);
const union = (a: Bounds, b: Bounds): Bounds => ({
  minX: Math.min(a.minX, b.minX),
  minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX),
  maxY: Math.max(a.maxY, b.maxY),
});

function probeLayout(buildings: PlacedBuilding[], sorters: Sorter[]): Layout {
  return {
    buildings,
    belts: [],
    sorters,
    meta: { geometrySource: 'approximate', gameVersion: 'motif', planTargetItemId: 0, planTargetRate: 0 },
  };
}

/** Does the validator accept `buildings` and `sorters` (the rules about power and stations aside)? */
function accepted(buildings: PlacedBuilding[], sorters: Sorter[], data: GameDataIndex, effects: TechEffects): boolean {
  return checkGeometry(probeLayout(buildings, sorters), data, effects).every((v) => NOT_ASKED.test(v.code));
}

const probeSorter = (id: number, from: number, fromSlot: number, to: number, toSlot: number, span: 1 | 2 | 3): Sorter => ({
  id,
  tierItemId: PROBE_SORTER,
  filterItemId: 0,
  span,
  pick: { kind: 'building', buildingId: from, slot: fromSlot },
  drop: { kind: 'building', buildingId: to, slot: toSlot },
  plannedRate: 0,
});

const poseCache = new WeakMap<GameDataIndex, Map<string, Pose[]>>();

/**
 * The poses of a building of `otherItem` beside a centre building of `centreItem` (at the origin, yaw 0) where a
 * sorter can join facing slots, smallest box first (at most `POSES_KEPT`). Cached per game data.
 */
export function linkPoses(centreItem: number, otherItem: number, data: GameDataIndex, effects: TechEffects): Pose[] {
  let byKey = poseCache.get(data);
  if (!byKey) poseCache.set(data, (byKey = new Map()));
  const key = `${centreItem}/${otherItem}`;
  const known = byKey.get(key);
  if (known) return known;

  const cDef = buildingDef(data, centreItem);
  const oDef = buildingDef(data, otherItem);
  const centre: PlacedBuilding = { id: 1, itemId: centreItem, x: 0, y: 0, z: 0, yaw: 0 };
  const reach = data.data.constants.sorterMaxReachMeters;
  const found: { pose: Pose; area: number; span: number }[] = [];
  let cSlots: SlotInfo[] | undefined;
  try {
    cSlots = slotInfos(centre, cDef);
  } catch {
    cSlots = undefined; // a slot that does not face along an axis: no clean pairs
  }
  const cObbs = buildingOBBs(centre, cDef);
  const cBounds = obbsBounds(cObbs);

  for (let k = 0; cSlots && k < YAWS.length; k++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      for (let dy = -SEARCH; dy <= SEARCH; dy++) {
        if (dx === 0 && dy === 0) continue;
        const other: PlacedBuilding = { id: 2, itemId: otherItem, x: dx, y: dy, z: 0, yaw: YAWS[k] };
        const oObbs = buildingOBBs(other, oDef);
        if (cObbs.some((a) => oObbs.some((b) => obbOverlap(a, b)))) continue;
        let oSlots: SlotInfo[];
        try {
          oSlots = slotInfos(other, oDef);
        } catch {
          continue;
        }
        const pairs: Pair[] = [];
        for (const sc of cSlots) {
          for (const so of oSlots) {
            if (sc.dir[0] + so.dir[0] !== 0 || sc.dir[1] + so.dir[1] !== 0) continue;
            // the first lattice points outside are on one line along the facing, 0 to 2 tiles apart
            const alongX = sc.dir[0] !== 0;
            if (alongX ? sc.firstOutside.y !== so.firstOutside.y : sc.firstOutside.x !== so.firstOutside.x) continue;
            const along = (so.firstOutside.x - sc.firstOutside.x) * sc.dir[0] + (so.firstOutside.y - sc.firstOutside.y) * sc.dir[1];
            if (!(along >= 0 && along <= 2)) continue;
            if (!sorterEndsValid({ pick: sc.pos, drop: so.pos, facings: [sc.dir, so.dir], toBelt: false }, reach)) continue;
            const span = (along + 1) as 1 | 2 | 3;
            if (!accepted([centre, other], [probeSorter(1, centre.id, sc.index, other.id, so.index, span)], data, effects)) continue;
            pairs.push({ centreSlot: sc.index, otherSlot: so.index, span });
          }
        }
        if (pairs.length === 0) continue;
        pairs.sort((a, b) => a.span - b.span || a.centreSlot - b.centreSlot || a.otherSlot - b.otherSlot);
        const bounds = obbsBounds(oObbs);
        found.push({ pose: { dx, dy, yaw: YAWS[k], pairs, obbs: oObbs, bounds }, area: area(union(cBounds, bounds)), span: pairs[0].span });
      }
    }
  }
  found.sort(
    (a, b) =>
      a.area - b.area ||
      a.span - b.span ||
      Math.abs(a.pose.dx) + Math.abs(a.pose.dy) - (Math.abs(b.pose.dx) + Math.abs(b.pose.dy)) ||
      a.pose.yaw - b.pose.yaw ||
      a.pose.dx - b.pose.dx ||
      a.pose.dy - b.pose.dy,
  );
  const poses = found.slice(0, POSES_KEPT).map((f) => f.pose);
  byKey.set(key, poses);
  return poses;
}

/** Pairs of slots at `pose` that together carry `rate`, avoiding the centre slots in `used`; undefined if they cannot. */
function pickPairs(
  pose: Pose,
  used: ReadonlySet<number>,
  rate: number,
  net: Netlist,
  data: GameDataIndex,
  effects: TechEffects,
): Pair[] | undefined {
  const chosen: Pair[] = [];
  const otherUsed = new Set<number>();
  let capacity = 0;
  for (const p of pose.pairs) {
    if (used.has(p.centreSlot) || otherUsed.has(p.otherSlot) || chosen.some((c) => c.centreSlot === p.centreSlot)) continue;
    chosen.push(p);
    otherUsed.add(p.otherSlot);
    capacity += sorterRate(net.sorterTierItemId, p.span, 0, effects, data);
    if (capacity >= rate * (1 - BALANCE_EPS)) return chosen;
  }
  return undefined;
}

/** How a centre and its neighbours stand: for each neighbour its pose and the slot pairs of its link. */
interface Arrangement {
  neighbours: { pose: Pose; pairs: Pair[] }[];
}

/**
 * The tightest arrangement of `others` (building and link rate) around a centre of `centreItem` that the validator
 * accepts, or undefined. Poses are combined smallest box first; neighbours must not overlap each other and must not
 * share a centre slot.
 */
function arrange(
  centreItem: number,
  others: { itemId: number; rate: number }[],
  net: Netlist,
  data: GameDataIndex,
  effects: TechEffects,
): Arrangement | undefined {
  const lists = others.map((o) => linkPoses(centreItem, o.itemId, data, effects));
  if (lists.some((l) => l.length === 0)) return undefined;
  const centre: PlacedBuilding = { id: 1, itemId: centreItem, x: 0, y: 0, z: 0, yaw: 0 };
  const cBounds = obbsBounds(buildingOBBs(centre, buildingDef(data, centreItem)));

  const leaves: { chosen: Arrangement['neighbours']; box: Bounds }[] = [];
  let budget = LEAF_BUDGET;
  const walk = (i: number, chosen: Arrangement['neighbours'], used: ReadonlySet<number>, box: Bounds): void => {
    if (i === others.length) {
      leaves.push({ chosen, box });
      return;
    }
    for (const pose of lists[i]) {
      if (budget <= 0) return;
      if (chosen.some((c) => c.pose.obbs.some((a) => pose.obbs.some((b) => obbOverlap(a, b))))) continue;
      const pairs = pickPairs(pose, used, others[i].rate, net, data, effects);
      if (!pairs) continue;
      budget--;
      walk(i + 1, [...chosen, { pose, pairs }], new Set([...used, ...pairs.map((p) => p.centreSlot)]), union(box, pose.bounds));
    }
  };
  walk(0, [], new Set(), cBounds);

  const spans = (c: Arrangement['neighbours']): number => c.reduce((s, n) => s + n.pairs.reduce((t, p) => t + p.span, 0), 0);
  leaves.sort((a, b) => area(a.box) - area(b.box) || spans(a.chosen) - spans(b.chosen));
  for (const leaf of leaves.slice(0, VERIFY_TRIES)) {
    const buildings: PlacedBuilding[] = [centre];
    const sorters: Sorter[] = [];
    leaf.chosen.forEach((n, i) => {
      const id = 2 + i;
      buildings.push({ id, itemId: others[i].itemId, x: n.pose.dx, y: n.pose.dy, z: 0, yaw: n.pose.yaw });
      for (const p of n.pairs) sorters.push(probeSorter(sorters.length + 1, centre.id, p.centreSlot, id, p.otherSlot, p.span));
    });
    if (accepted(buildings, sorters, data, effects)) return { neighbours: leaf.chosen };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Candidates

interface LinkSet {
  netId: number;
  itemId: number;
  /** The centre's tap on the net. */
  centre: NetTap;
  /** The neighbours' taps (the opposite direction), whose rates add up to the centre's. */
  neighbours: NetTap[];
}

interface Candidate {
  centre: number;
  links: LinkSet[];
  /** Centre first, then the neighbours in link order. */
  machines: number[];
  /** Sorters this takes off the belts, less the ones it puts between the machines. */
  value: number;
  arrangement: Arrangement;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= BALANCE_EPS * Math.max(1, Math.abs(a), Math.abs(b));

/** Can the machine take part: a building with sorter slots that makes or takes items. */
function capable(def: Building | undefined): boolean {
  return !!def && (def.kind === 'production' || def.kind === 'lab') && def.geometry.slots.length > 0;
}

/** The sets of one or two taps whose rates add up to `tap`'s, among `others`. */
function balancedSets(tap: NetTap, others: NetTap[]): NetTap[][] {
  const sets: NetTap[][] = [];
  for (let i = 0; i < others.length; i++) {
    if (close(others[i].rate, tap.rate)) sets.push([others[i]]);
    for (let j = i + 1; j < others.length; j++) {
      if (close(others[i].rate + others[j].rate, tap.rate)) sets.push([others[i], others[j]]);
    }
  }
  return sets;
}

const sortersOf = (link: LinkSet): number => link.centre.sorters + link.neighbours.reduce((s, t) => s + t.sorters, 0);

export const directInsertionMotif: Motif = {
  kind: 'direct',
  propose(net: Netlist, data: GameDataIndex, effects: TechEffects, taken: ReadonlySet<number> = new Set()): MotifInstance[] {
    const itemOf = new Map(net.machines.map((m) => [m.id, m.buildingItemId] as const));
    const usable = (machineId: number): boolean => !taken.has(machineId) && capable(data.building(itemOf.get(machineId) ?? -1));

    // the link sets of each centre
    const linksOf = new Map<number, LinkSet[]>();
    for (const n of net.nets) {
      if (n.source.kind !== 'taps') continue;
      const outs = n.taps.filter((t) => t.dir === 'out' && usable(t.machineId));
      const ins = n.taps.filter((t) => t.dir === 'in' && usable(t.machineId));
      if (outs.length === 0 || ins.length === 0) continue;
      const add = (centre: NetTap, neighbours: NetTap[]): void => {
        const list = linksOf.get(centre.machineId) ?? [];
        list.push({ netId: n.id, itemId: n.itemId, centre, neighbours });
        linksOf.set(centre.machineId, list);
      };
      for (const o of outs) for (const set of balancedSets(o, ins)) add(o, set);
      for (const i of ins) for (const set of balancedSets(i, outs)) add(i, set);
    }

    const found: Candidate[] = [];
    const arranged = new Map<string, Arrangement | null>();

    const consider = (centre: number, chosen: LinkSet[]): void => {
      const neighbours = chosen.flatMap((c) =>
        c.neighbours.map((t) => ({ machineId: t.machineId, itemId: itemOf.get(t.machineId) as number, rate: t.rate })),
      );
      const centreItem = itemOf.get(centre) as number;
      const key = `${centreItem}|${neighbours.map((o) => `${o.itemId}:${+o.rate.toFixed(6)}`).join(',')}`;
      let arrangement = arranged.get(key);
      if (arrangement === undefined) {
        arrangement = arrange(centreItem, neighbours, net, data, effects) ?? null;
        arranged.set(key, arrangement);
      }
      if (!arrangement) return;
      const removed = chosen.reduce((s, c) => s + sortersOf(c), 0);
      const internal = arrangement.neighbours.reduce((s, n) => s + n.pairs.length, 0);
      if (internal > removed) return;
      found.push({ centre, links: chosen, machines: [centre, ...neighbours.map((o) => o.machineId)], value: removed - internal, arrangement });
    };

    // the combinations of one centre's links: one set per net, no neighbour twice, at most four neighbours
    for (const [centre, links] of [...linksOf].sort((a, b) => a[0] - b[0])) {
      const options = links.slice().sort((a, b) => sortersOf(b) - sortersOf(a) || a.netId - b.netId).slice(0, MAX_LINK_SETS);
      const combine = (from: number, chosen: LinkSet[]): void => {
        if (chosen.length > 0) consider(centre, chosen);
        for (let i = from; i < options.length; i++) {
          const o = options[i];
          const members = new Set(chosen.flatMap((c) => c.neighbours.map((t) => t.machineId)));
          if (chosen.some((c) => c.netId === o.netId)) continue;
          if (o.neighbours.some((t) => members.has(t.machineId) || t.machineId === centre)) continue;
          if (members.size + o.neighbours.length > MAX_NEIGHBOURS) continue;
          combine(i + 1, [...chosen, o]);
        }
      };
      combine(0, []);
    }

    return choose(found).map((c) => toInstance(c, net, data, effects));
  },
};

/** The candidates to use: no machine twice, the most value (sorters taken off the belts) in all. */
function choose(candidates: Candidate[]): Candidate[] {
  const sorted = candidates.slice().sort((a, b) => b.value - a.value || a.machines.length - b.machines.length || a.centre - b.centre);
  if (sorted.length <= EXACT_LIMIT) {
    let best: Candidate[] = [];
    let bestValue = 0;
    const suffix = sorted.map((_, i) => sorted.slice(i).reduce((s, c) => s + c.value, 0));
    const walk = (i: number, picked: Candidate[], used: ReadonlySet<number>, total: number): void => {
      if (total > bestValue) {
        bestValue = total;
        best = picked;
      }
      if (i >= sorted.length || total + suffix[i] <= bestValue) return;
      const c = sorted[i];
      if (!c.machines.some((m) => used.has(m))) walk(i + 1, [...picked, c], new Set([...used, ...c.machines]), total + c.value);
      walk(i + 1, picked, used, total);
    };
    walk(0, [], new Set(), 0);
    return best.slice().sort((a, b) => a.centre - b.centre);
  }
  const used = new Set<number>();
  const picked: Candidate[] = [];
  const byDensity = sorted.slice().sort((a, b) => b.value / b.machines.length - a.value / a.machines.length || a.centre - b.centre);
  for (const c of byDensity) {
    if (c.machines.some((m) => used.has(m))) continue;
    for (const m of c.machines) used.add(m);
    picked.push(c);
  }
  return picked.sort((a, b) => a.centre - b.centre);
}

function toInstance(c: Candidate, net: Netlist, data: GameDataIndex, effects: TechEffects): MotifInstance {
  const sorters: MotifInstance['internalSorters'] = [];
  const relative: MotifInstance['relative'] = [{ machineId: c.centre, dx: 0, dy: 0, dz: 0, yaw: 0 }];
  let at = 0;
  for (const link of c.links) {
    const centreMakes = link.centre.dir === 'out';
    for (const tap of link.neighbours) {
      const { pose, pairs } = c.arrangement.neighbours[at++];
      relative.push({ machineId: tap.machineId, dx: pose.dx, dy: pose.dy, dz: 0, yaw: pose.yaw });
      const caps = pairs.map((p) => sorterRate(net.sorterTierItemId, p.span, 0, effects, data));
      const total = caps.reduce((s, v) => s + v, 0);
      pairs.forEach((p, i) => {
        sorters.push({
          fromMachine: centreMakes ? c.centre : tap.machineId,
          fromSlot: centreMakes ? p.centreSlot : p.otherSlot,
          toMachine: centreMakes ? tap.machineId : c.centre,
          toSlot: centreMakes ? p.otherSlot : p.centreSlot,
          itemId: link.itemId,
          span: p.span,
          plannedRate: (tap.rate * caps[i]) / total,
        });
      });
    }
  }
  return {
    kind: 'direct',
    machineIds: c.machines,
    anchor: { x: 0, y: 0, yaw: 0 },
    relative,
    internalSorters: sorters,
    satisfiesNets: c.links.map((l) => ({ netId: l.netId, machineIds: [c.centre, ...l.neighbours.map((t) => t.machineId)] })),
  };
}
