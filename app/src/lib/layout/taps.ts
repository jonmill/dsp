// Tap assignment: which sorter slot of which machine serves each tap of each net, and which belt port of which
// station each net starts or ends at (Task 22). The router takes it from there.
//
// Sorters. A tap that moves `rate` items/s gets as many sorters as it needs, each on a slot of its own. A slot is
// used by one sorter ever (the validator's SORTER_SLOT_REUSED). Each slot offers the smallest span (1, 2 or 3) whose
// tap point works; a tap fills up from span 1 and then 2 and 3 until the sorters' summed `sorterRate` covers the
// rate, so a span-2 sorter, which is slower, makes the tap use more of them.
//
// What makes a tap point work. The belt has to pass the tap point straight, along the axis across the slot facing,
// with a node before it and a node after it (SORTER_BELT_TANGENT). So three lattice points on the ground are needed:
// the tap point T and T -/+ axis. They must be free for belts (`Occupancy.blockedForBelt`, which inflates every
// footprint by half a belt and so is stricter than the slot's own `firstOutside`), and nobody else may need them:
// not another net's tap, not a station port's two belt nodes. Taps of the same net on the same row may share nodes
// (the belt just runs past them), but a producer and a consumer of one net keep more than two nodes apart on a row,
// or one straight pass would carry them in an order that starves the consumer. The lattice points a span-2 or span-3
// sorter reaches over (those between the slot and T) must not lie inside a building (SORTER_IN_BUILDING); a belt may
// run there.
//
// The sorter's own ends. The validator holds every sorter to 1 m <= the distance between its ends <= the reach and
// to an alignment with its slot (SORTER_SPAN, SORTER_SKEW). A slot set back in its building, with the first lattice
// point outside close by, makes a span-1 sorter shorter than 1 m (the Miniature Particle Collider's side slots).
// `sorterTapEnds` gives the ends of a tap and `sorterEndsValid` is the validator's own predicate: a span that fails
// it is not offered, and the tap goes on to the next span or slot.
//
// Skew poses. A slot or port that does not face along an axis is left out, the building's other poses still work
// (`slotInfos` throws for the whole building, so each pose is tried alone, as the validator does).
//
// Which slot. Among the free slots at the smallest span: the one facing the centroid of the net's other taps (and
// station ports) best, then the nearer tap point, then the lower index. Slots next to one already chosen for the same
// tap, in the same row, get a bonus, so a tap with several sorters takes a straight stretch of one side.
//
// Lanes (MX §9 M2). The taps of nets that share a machine's face compete for the same ground: the sorter that comes
// first takes the nearest lane (span 1), a tap whose span-1 point lies on that ground goes one lane further out (span 2,
// then 3) on a slot facing the same way, reaching over the nearer lanes, and needs more sorters for it. A farther lane
// is slower. The taps are first assigned in the order of the netlist; when that leaves a tap on a farther lane or fails
// for want of slots, they are assigned again in order of their demand, the share of a span-1 sorter's rate they need,
// the most demanding first (the highest-rate input on the nearest lane, M2), and the assignment with fewer sorters
// wins (then the lower total span; a tie keeps the netlist order). Either way the taps come back in net order. A span-2
// or 3 sorter that reaches over another net's belt is legal for the validator (sorters do not collide with belts) and
// unverified in game: Task 30's checklist.
//
// Motifs. The slots that the internal sorters of `Netlist.motifs` use are taken before the first tap is assigned.
//
// Ports. A net that starts or ends at a station takes one of its 12 ports. A station's nets are matched to its ports
// greedily by cost: the distance from the port's first lattice point outside to the net's tap centroid, plus a
// penalty when the port faces away from it. A net keeps the station the netlist gave it (several stations are matched one
// at a time; the proliferator feed has its one station, the one that holds the proliferator's slot), so what a station
// takes in of an imported and made item stays what the netlist balanced; the assignment checks it (`pooledImbalances`).
import type { Building, GameDataIndex, TechEffects } from '../data';
import { buildingDef, pointInOBBs, portInfos, slotInfos, sorterEndsValid, sorterTapEnds, sorterTapPoint } from '../geometry';
import type { OBB2, PlacedBuilding, SlotInfo } from '../geometry';
import { sorterRate } from '../validate/capacity';
import { netStack, pooledImbalances } from './netlist';
import type { BeltNet, NetTap, Netlist, StationEnd } from './netlist';
import type { Bounds, Occupancy } from './occupancy';
import { obbsBounds } from './occupancy';
import { placementBuildingIdOf, stationBuildingId } from './placement';
import type { Placement } from './placement';

/** ONE per sorter: a tap needing k sorters yields k of these, on k distinct slots, each with its own belt point. */
export interface AssignedTap {
  netId: number;
  machineId: number;
  slot: number;
  span: 1 | 2 | 3;
  /** The belt lattice point (z 0) the sorter taps: `sorterTapPoint(slot, span)`. */
  point: { x: number; y: number };
  /** The direction the belt must run through `point`: across the slot facing. */
  axis: 'x' | 'y';
  dir: 'in' | 'out';
  /** 0.. within the tap. */
  sorterIndex: number;
  /** This sorter's share of the tap rate. */
  rate: number;
}

/** A belt port a net starts at (`end: 'source'`) or ends at (`'sink'`). */
export interface AssignedStationPort {
  netId: number;
  stationBuildingId: number;
  port: number;
  /** The port's first lattice point outside, where the belt's first (source) or last (sink) node is, at z 0. */
  point: { x: number; y: number };
  end: 'source' | 'sink';
  /** The unit vector the port faces. The belt leaves (source) or arrives (sink) along this line, `point` first. */
  dir: [number, number];
}

export interface TapAssignment {
  taps: AssignedTap[];
  stationPorts: AssignedStationPort[];
}

/** What a cost unit of "the port faces away from the net" is worth, in tiles of distance. */
const PORT_BACKWARD_PENALTY = 6;
/**
 * The cells straight out of the proliferator feed's station port that are the feed's alone (the port's first lattice point and
 * the ones after it): it is on the ground for two flat steps before it lifts to z 1 to pass over the other nets' belts, which the
 * item nets routed first would otherwise have walled in.
 */
export const FEED_PORT_CELLS = 3;
/** Bonus (in facing-score units, which run from -1 to 1) for a slot beside one already chosen for the same tap. */
const CONTIGUITY_BONUS = 0.75;
/** Scores closer than this are equal. */
const SCORE_EPS = 1e-9;
/** Relative slack on "the sorters carry the rate". */
const REL_EPS = 1e-9;
const SPANS = [1, 2, 3] as const;

/** Thrown inside the assigner for a condition the caller should read as a message, not a crash. */
class Failure extends Error {}

const KEY_OFFSET = 1 << 20;
const KEY_STRIDE = 1 << 21;
const keyOf = (x: number, y: number): number => (x + KEY_OFFSET) * KEY_STRIDE + (y + KEY_OFFSET);

/** Who needs a lattice point on the ground: a tap running along an axis, or a station port. */
interface Claim {
  netId: number;
  kind: 'x' | 'y' | 'port';
}

interface Candidate {
  slot: SlotInfo;
  span: 1 | 2 | 3;
  point: { x: number; y: number };
  axis: 'x' | 'y';
  /** Facing score plus the contiguity bonus. */
  score: number;
  distance: number;
}

interface Box {
  bounds: Bounds;
  obbs: OBB2[];
}

const manhattan = (ax: number, ay: number, bx: number, by: number): number => Math.abs(ax - bx) + Math.abs(ay - by);

class Assigner {
  private readonly byId = new Map<number, PlacedBuilding>();
  private readonly boxes: Box[];
  private readonly blockedCache = new Map<number, boolean>();
  private readonly claims = new Map<number, Claim[]>();
  /** Tap points chosen so far, by lattice point. */
  private readonly tapCells = new Map<number, { netId: number; axis: 'x' | 'y'; dir: 'in' | 'out' }[]>();
  private readonly usedSlots = new Set<string>();
  private readonly slotCache = new Map<number, SlotInfo[]>();
  /** Machines with slots left out because they do not face along an axis. */
  private readonly skippedSlots = new Map<number, { skipped: number; cause: string }>();
  private readonly centers = new Map<number, { x: number; y: number }>();
  private readonly ports: AssignedStationPort[] = [];
  private readonly taps: AssignedTap[] = [];
  /** The longest a sorter may be, in metres. */
  private readonly reach: number;

  constructor(
    private readonly net: Netlist,
    placement: Placement,
    private readonly occ: Occupancy,
    private readonly data: GameDataIndex,
    private readonly effects: TechEffects,
    /** Assign the most demanding taps first instead of in netlist order. */
    private readonly byDemand = false,
  ) {
    this.reach = data.data.constants.sorterMaxReachMeters;
    // the slots the internal sorters of motifs use are theirs: a slot takes one sorter
    for (const s of net.motifs?.sorters ?? []) {
      this.usedSlots.add(`${s.fromMachine}:${s.fromSlot}`);
      this.usedSlots.add(`${s.toMachine}:${s.toSlot}`);
    }
    for (const b of placement.buildings) this.byId.set(b.id, b);
    this.boxes = placement.buildings.map((b) => {
      const obbs = occ.obbsOf(b);
      return { bounds: obbsBounds(obbs), obbs };
    });
  }

  run(): TapAssignment {
    this.assignPorts();
    this.assignAllTaps();
    return { taps: this.taps, stationPorts: this.ports };
  }

  // -------------------------------------------------------------------------------------------
  // Lookups

  private building(id: number, what: string): PlacedBuilding {
    const b = this.byId.get(id);
    if (!b) throw new Failure(`${what}: the placement has no building ${id}`);
    return b;
  }

  private nameOf(b: PlacedBuilding): string {
    return buildingDef(this.data, b.itemId).name;
  }

  private center(b: PlacedBuilding): { x: number; y: number } {
    let c = this.centers.get(b.id);
    if (!c) {
      const fp = this.occ.footprintOf(b.itemId, b.yaw);
      c = { x: b.x + (fp.minX + fp.maxX) / 2, y: b.y + (fp.minY + fp.maxY) / 2 };
      this.centers.set(b.id, c);
    }
    return c;
  }

  /**
   * The usable slots (or ports) of a building. When `slotInfos`/`portInfos` throws because a pose does not face along
   * an axis, each pose is tried alone, as the validator does, and only the bad ones are left out. `skipped` counts
   * them, `cause` is the first reason.
   */
  private posesOf(b: PlacedBuilding, kind: 'slot' | 'port'): { usable: SlotInfo[]; skipped: number; cause?: string } {
    const def = buildingDef(this.data, b.itemId);
    const infos = kind === 'slot' ? slotInfos : portInfos;
    try {
      return { usable: infos(b, def), skipped: 0 };
    } catch {
      const key = kind === 'slot' ? 'slots' : 'ports';
      const usable: SlotInfo[] = [];
      let skipped = 0;
      let cause: string | undefined;
      def.geometry[key].forEach((pose, i) => {
        const alone: Building = { ...def, geometry: { ...def.geometry, [key]: [pose] } };
        try {
          usable.push({ ...infos(b, alone)[0], index: i });
        } catch (err) {
          skipped++;
          cause ??= (err instanceof Error ? err.message : String(err)).replace(new RegExp(` ${kind} 0\\b`), ` ${kind} ${i}`);
        }
      });
      return { usable, skipped, cause };
    }
  }

  private slotsOf(machineId: number): SlotInfo[] {
    let infos = this.slotCache.get(machineId);
    if (!infos) {
      const b = this.building(placementBuildingIdOf(machineId), `machine ${machineId}`);
      const { usable, skipped, cause } = this.posesOf(b, 'slot');
      if (usable.length === 0 && skipped > 0) {
        throw new Failure(`machine ${machineId} (${this.nameOf(b)}): none of its sorter slots can be used: ${cause}`);
      }
      if (skipped > 0) this.skippedSlots.set(machineId, { skipped, cause: cause as string });
      infos = usable;
      this.slotCache.set(machineId, infos);
    }
    return infos;
  }

  private blocked(x: number, y: number): boolean {
    const key = keyOf(x, y);
    let v = this.blockedCache.get(key);
    if (v === undefined) {
      v = this.occ.blockedForBelt(x, y, 0);
      this.blockedCache.set(key, v);
    }
    return v;
  }

  /** Is the lattice point inside a building footprint (no inflation)? */
  private insideBuilding(x: number, y: number): boolean {
    for (const { bounds, obbs } of this.boxes) {
      if (x <= bounds.minX || x >= bounds.maxX || y <= bounds.minY || y >= bounds.maxY) continue;
      if (pointInOBBs(x, y, null, obbs, 0)) return true;
    }
    return false;
  }

  private free(netId: number, kind: Claim['kind'], x: number, y: number): boolean {
    const list = this.claims.get(keyOf(x, y));
    if (!list) return true;
    return list.every((c) => c.netId === netId && c.kind === kind && kind !== 'port');
  }

  private claim(netId: number, kind: Claim['kind'], x: number, y: number): void {
    const key = keyOf(x, y);
    const list = this.claims.get(key);
    if (list) list.push({ netId, kind });
    else this.claims.set(key, [{ netId, kind }]);
  }

  /**
   * The centroid of what a net connects, leaving out the machine `exceptMachine`. The proliferator net taps no machine; it
   * goes where the coaters of the sprayed nets do, which are before the consumers of those nets, so the consumers stand
   * for them.
   */
  private centroid(n: BeltNet, exceptMachine: number): { x: number; y: number } | undefined {
    let sx = 0;
    let sy = 0;
    let count = 0;
    const taps = n.proliferator ? this.net.nets.filter((m) => m.sprayed).flatMap((m) => m.taps.filter((t) => t.dir === 'in')) : n.taps;
    for (const t of taps) {
      if (t.machineId === exceptMachine) continue;
      const c = this.center(this.building(placementBuildingIdOf(t.machineId), `net ${n.id}`));
      sx += c.x;
      sy += c.y;
      count++;
    }
    for (const p of this.ports) {
      if (p.netId !== n.id) continue;
      sx += p.point.x;
      sy += p.point.y;
      count++;
    }
    return count > 0 ? { x: sx / count, y: sy / count } : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Station ports

  private assignPorts(): void {
    interface Want {
      net: BeltNet;
      end: 'source' | 'sink';
      stationIdx: number;
    }
    const wants: Want[] = [];
    for (const n of this.net.nets) {
      if (n.source.kind === 'station') wants.push({ net: n, end: 'source', stationIdx: n.source.stationIdx });
      if (n.sink.kind === 'station') wants.push({ net: n, end: 'sink', stationIdx: n.sink.stationIdx });
    }
    const stationIdxs = [...new Set(wants.map((w) => w.stationIdx))].sort((a, b) => a - b);
    for (const idx of stationIdxs) {
      const station = this.building(stationBuildingId(idx), `station ${idx}`);
      const { usable: infos, skipped, cause } = this.posesOf(station, 'port');
      if (infos.length === 0 && skipped > 0) {
        throw new Failure(`station ${idx} (${this.nameOf(station)}): none of its belt ports can be used: ${cause}`);
      }
      const usable = infos.filter((info) => {
        const { x, y } = info.firstOutside;
        return !this.blocked(x, y) && !this.blocked(x + info.dir[0], y + info.dir[1]);
      });
      const mine = wants.filter((w) => w.stationIdx === idx);
      const taken = new Set<number>();
      const done = new Set<Want>();
      const stationCenter = this.center(station);
      // the pairs by cost, cheapest first; a net takes its cheapest free port, nets in the order of their best cost
      while (done.size < mine.length) {
        let best: { want: Want; info: SlotInfo; cost: number } | undefined;
        for (const want of mine) {
          if (done.has(want)) continue;
          const g = this.centroid(want.net, -1) ?? stationCenter;
          for (const info of usable) {
            if (taken.has(info.index)) continue;
            const { x, y } = info.firstOutside;
            if (want.net.proliferator && this.blocked(x + (FEED_PORT_CELLS - 1) * info.dir[0], y + (FEED_PORT_CELLS - 1) * info.dir[1])) continue;
            const forward = (g.x - x) * info.dir[0] + (g.y - y) * info.dir[1];
            const cost = manhattan(x, y, g.x, g.y) + (forward < 0 ? PORT_BACKWARD_PENALTY : 0);
            if (!best || cost < best.cost - SCORE_EPS) best = { want, info, cost };
          }
        }
        if (!best) {
          const left = mine.filter((w) => !done.has(w));
          throw new Failure(
            `net ${left[0].net.id}: station ${idx} (${this.nameOf(station)}) has no free usable belt port ` +
              `(${mine.length} nets need one; ${usable.length} of its ${infos.length + skipped} ports are clear of buildings` +
              (skipped > 0 ? ` and face along an axis: ${cause}` : '') +
              ')',
          );
        }
        const { want, info } = best;
        done.add(want);
        taken.add(info.index);
        const { x, y } = info.firstOutside;
        for (let i = 0; i < (want.net.proliferator ? FEED_PORT_CELLS : 2); i++) this.claim(want.net.id, 'port', x + i * info.dir[0], y + i * info.dir[1]);
        this.ports.push({
          netId: want.net.id,
          stationBuildingId: station.id,
          port: info.index,
          point: { x, y },
          end: want.end,
          dir: [info.dir[0], info.dir[1]],
        });
      }
    }
    this.ports.sort((a, b) => a.netId - b.netId || (a.end === b.end ? 0 : a.end === 'source' ? -1 : 1));
    this.checkPooledBalance();
  }

  /**
   * What a station takes in of an item that the plan also imports, it gives out: judged on the ports as assigned, which sit
   * on the stations the netlist gave the nets (see `pooledImbalances`). A station whose stock fills only blocks the producers
   * in game; the simulator does not model it, so a violation is a bug of the netlist and throws.
   */
  private checkPooledBalance(): void {
    const stationIdxOf = new Map(this.net.stations.map((_, i) => [stationBuildingId(i), i]));
    const ends: StationEnd[] = this.ports.map((p) => ({
      netId: p.netId,
      end: p.end,
      stationIdx: stationIdxOf.get(p.stationBuildingId) ?? -1,
    }));
    const [first] = pooledImbalances(this.net, ends);
    if (first) {
      throw new Error(
        `assignTaps: station ${first.stationIdx} takes in ${+first.inflow.toFixed(3)} of item ${first.itemId}/s and gives out ` +
          `${+first.outflow.toFixed(3)}/s, so its slot would fill (a netlist grouping bug)`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Taps

  /**
   * Assigns every tap of every net, in netlist order or (`byDemand`) the most demanding first, and puts the sorters in
   * net order, then the order of the net's taps, then sorter index.
   */
  private assignAllTaps(): void {
    interface Job {
      net: BeltNet;
      tap: NetTap;
      stack: number;
      /** The share of one span-1 sorter's rate the tap needs. */
      demand: number;
      order: number;
    }
    const jobs: Job[] = [];
    const tier = this.net.sorterTierItemId;
    for (const n of this.net.nets) {
      const stack = netStack(n.source.kind === 'station', this.effects);
      for (const tap of n.taps) {
        const cap = sorterRate(tier, 1, tap.dir === 'in' ? stack : 0, this.effects, this.data);
        jobs.push({ net: n, tap, stack, demand: tap.rate / cap, order: jobs.length });
      }
    }
    const sequence = this.byDemand
      ? [...jobs].sort((a, b) => (Math.abs(a.demand - b.demand) > SCORE_EPS ? b.demand - a.demand : a.order - b.order))
      : jobs;
    const placed = new Map<AssignedTap, number>();
    for (const job of sequence) {
      const before = this.taps.length;
      this.assignTap(job.net, job.tap, job.stack);
      for (let i = before; i < this.taps.length; i++) placed.set(this.taps[i], job.order);
    }
    this.taps.sort((a, b) => (placed.get(a) as number) - (placed.get(b) as number) || a.sorterIndex - b.sorterIndex);
  }

  /** Does a sorter of `span` on `slot` work for net `netId`? Returns where it taps, or undefined. */
  private tapAt(
    netId: number,
    dir: 'in' | 'out',
    slot: SlotInfo,
    span: 1 | 2 | 3,
  ): { point: { x: number; y: number }; axis: 'x' | 'y' } | undefined {
    for (let k = 0; k < span - 1; k++) {
      if (this.insideBuilding(slot.firstOutside.x + k * slot.dir[0], slot.firstOutside.y + k * slot.dir[1])) return undefined;
    }
    const point = sorterTapPoint(slot, span);
    // the sorter the validator would see: its ends have to be a legal distance apart and aligned with the slot
    const ends = sorterTapEnds(slot, point, dir);
    if (!sorterEndsValid({ ...ends, facings: [slot.dir], toBelt: true }, this.reach)) return undefined;
    const axis = slot.dir[0] !== 0 ? 'y' : 'x';
    for (const k of [-1, 0, 1]) {
      const x = point.x + (axis === 'x' ? k : 0);
      const y = point.y + (axis === 'y' ? k : 0);
      if (this.blocked(x, y) || !this.free(netId, axis, x, y)) return undefined;
    }
    // The net's own taps on this row within two nodes would share one straight pass with this one, so a consumer
    // would sit upstream of a producer on it (or the reverse): producers and consumers of a net keep apart.
    for (const k of [-2, -1, 0, 1, 2]) {
      const near = this.tapCells.get(keyOf(point.x + (axis === 'x' ? k : 0), point.y + (axis === 'y' ? k : 0)));
      if (near?.some((t) => t.netId === netId && t.axis === axis && t.dir !== dir)) return undefined;
    }
    return { point, axis };
  }

  private assignTap(n: BeltNet, tap: NetTap, stack: number): void {
    const b = this.building(placementBuildingIdOf(tap.machineId), `net ${n.id}`);
    const slots = this.slotsOf(tap.machineId);
    const goal = this.centroid(n, tap.machineId);
    const fromBelt = tap.dir === 'in' ? stack : 0;
    const tier = this.net.sorterTierItemId;
    const chosen: Candidate[] = [];
    let capacity = 0;
    const caps: number[] = [];

    while (capacity < tap.rate * (1 - REL_EPS)) {
      let best: Candidate | undefined;
      for (const slot of slots) {
        if (this.usedSlots.has(`${tap.machineId}:${slot.index}`)) continue;
        for (const span of SPANS) {
          const at = this.tapAt(n.id, tap.dir, slot, span);
          if (!at) continue;
          const c = this.score(slot, span, at, goal, chosen);
          if (!best || this.better(c, best)) best = c;
          break;
        }
      }
      if (!best) {
        const skip = this.skippedSlots.get(tap.machineId);
        throw new Failure(
          `net ${n.id}: machine ${tap.machineId} (${this.nameOf(b)}) has no usable sorter slot left for item ` +
            `${tap.itemId} (${tap.dir === 'in' ? 'input' : 'output'} of ${+tap.rate.toFixed(3)}/s: ` +
            `${chosen.length} sorter${chosen.length === 1 ? '' : 's'} placed carry ${+capacity.toFixed(3)}/s; ` +
            `each of its ${slots.length} usable slots is taken, blocked, or needs ground another net uses` +
            (skip ? `; ${skip.skipped} more do not face along an axis: ${skip.cause}` : '') +
            ')',
        );
      }
      chosen.push(best);
      this.usedSlots.add(`${tap.machineId}:${best.slot.index}`);
      const cellKey = keyOf(best.point.x, best.point.y);
      const here = this.tapCells.get(cellKey);
      if (here) here.push({ netId: n.id, axis: best.axis, dir: tap.dir });
      else this.tapCells.set(cellKey, [{ netId: n.id, axis: best.axis, dir: tap.dir }]);
      for (const k of [-1, 0, 1]) {
        this.claim(n.id, best.axis, best.point.x + (best.axis === 'x' ? k : 0), best.point.y + (best.axis === 'y' ? k : 0));
      }
      const cap = sorterRate(tier, best.span, fromBelt, this.effects, this.data);
      caps.push(cap);
      capacity += cap;
    }
    chosen.forEach((c, i) => {
      this.taps.push({
        netId: n.id,
        machineId: tap.machineId,
        slot: c.slot.index,
        span: c.span,
        point: c.point,
        axis: c.axis,
        dir: tap.dir,
        sorterIndex: i,
        rate: (tap.rate * caps[i]) / capacity,
      });
    });
  }

  private score(
    slot: SlotInfo,
    span: 1 | 2 | 3,
    at: { point: { x: number; y: number }; axis: 'x' | 'y' },
    goal: { x: number; y: number } | undefined,
    chosen: Candidate[],
  ): Candidate {
    let facing = 0;
    let distance = 0;
    if (goal) {
      const dx = goal.x - slot.pos.x;
      const dy = goal.y - slot.pos.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) facing = (dx * slot.dir[0] + dy * slot.dir[1]) / len;
      distance = manhattan(at.point.x, at.point.y, goal.x, goal.y);
    }
    const beside = chosen.some((c) => {
      if (c.axis !== at.axis) return false;
      const along = at.axis === 'x' ? c.point.x - at.point.x : c.point.y - at.point.y;
      const across = at.axis === 'x' ? c.point.y - at.point.y : c.point.x - at.point.x;
      return across === 0 && Math.abs(along) === 1;
    });
    return { slot, span, point: at.point, axis: at.axis, score: facing + (beside ? CONTIGUITY_BONUS : 0), distance };
  }

  /** `a` beats `b`: smaller span, then the better score, then the nearer tap point, then the lower slot index. */
  private better(a: Candidate, b: Candidate): boolean {
    if (a.span !== b.span) return a.span < b.span;
    if (Math.abs(a.score - b.score) > SCORE_EPS) return a.score > b.score;
    if (a.distance !== b.distance) return a.distance < b.distance;
    return a.slot.index < b.slot.index;
  }
}

/** Sorters, then total span: what the lanes of two assignments of one netlist are compared by (less is better). */
const cost = (r: TapAssignment): [number, number] => [r.taps.length, r.taps.reduce((sum, t) => sum + t.span, 0)];

/**
 * Picks the sorter slots and station ports of a placed netlist (see the file comment). `occ` must hold the buildings
 * of `placement`. Returns `{ failed }` with a message when a machine runs out of usable slots or a station out of
 * usable ports (poses that do not face along an axis do not count, and are named in the message). The taps come back in net order, then the order of the net's taps, then sorter index.
 */
export function assignTaps(
  net: Netlist,
  placement: Placement,
  occ: Occupancy,
  data: GameDataIndex,
  effects: TechEffects,
  /** `repass: false` assigns in netlist order only, with no second pass in order of demand (see the file comment). */
  options: { repass?: boolean } = {},
): TapAssignment | { failed: string } {
  const attempt = (byDemand: boolean): TapAssignment | { failed: string } => {
    try {
      return new Assigner(net, placement, occ, data, effects, byDemand).run();
    } catch (err) {
      if (err instanceof Failure) return { failed: err.message };
      throw err;
    }
  };
  const inOrder = attempt(false);
  // nothing on a farther lane (or in the way): the lanes are as good as they get
  if (options.repass === false || (!('failed' in inOrder) && inOrder.taps.every((t) => t.span === 1))) return inOrder;
  const byDemand = attempt(true);
  if ('failed' in byDemand) return inOrder;
  if ('failed' in inOrder) return byDemand;
  const [a, b] = [cost(inOrder), cost(byDemand)];
  return b[0] < a[0] || (b[0] === a[0] && b[1] < a[1]) ? byDemand : inOrder;
}
