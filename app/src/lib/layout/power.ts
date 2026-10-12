// Power poles: where the nodes that power a layout stand (Task 23).
//
// What has to be powered. Every consumer building (anything GameData lists as a power consumer that is not itself a
// node) at its position, every sorter at the midpoint of its two ends, and every spray coater at the belt node it stands
// on: the validator's POWER_UNCOVERED rule, which is judged with the node's power point, the 2D distance in metres and
// the node's cover radius. `consumerPoints` carries the sorter midpoints and the coaters (which are not in
// `Layout.buildings`); `powerTargets` finds them for a layout.
//
// Which node. Of the Tesla Tower (2201), the Wireless Power Tower (2202) and the Satellite Substation (2212) that are
// unlocked, the one with the best `coverRadius² / footprint`. That is the Tesla Tower in the fixture; the others only
// stand where the Tesla Tower is not available. (The wind turbine, thermal plant and solar panel carry a node too,
// but they are generators, not poles.)
//
// Where. A node stands on a lattice point (x, y integers, z 0). It must not overlap a building or another node
// (`Occupancy.buildingCollides`), and must keep its body off the cells in `blockedPoints`: a node is as tall as the
// highest belt level, so a belt node at any z is in its way, and so are the tap points and the cells a sorter spans.
// A node wider than a lattice step also keeps off the cells beside the one it stands on.
//
// Cover. Greedy set cover over the lattice points that reach at least one target: take the point that covers the most
// targets not yet covered (ties go to the point found first), until all are. The greedy choice is made lazily (a
// candidate's count only falls as targets get covered), which gives the same nodes as recounting every candidate each
// round, at a fraction of the work.
//
// Links. Two nodes are linked when their power points are at most `min(connectDistance_a, connectDistance_b)` metres
// apart, as in the validator. Components that the cover leaves apart are joined, closest pair first, by relay nodes
// of the same type placed along the straight line between them, each about 0.9 of a link from the last (moved to
// the nearest free lattice point when the exact spot is taken). The link phase also runs when the nodes that stand
// already cover every consumer: covered is not connected.
import type { GameDataIndex, TechEffects } from '../data';
import { BELT_HALF_WIDTH_TILES, buildingDef, coaterBuildings, LayoutIndex, LEVEL, prefabToGrid, sorterEnds, TILE } from '../geometry';
import type { Layout, PlacedBuilding } from '../geometry';
import { MinHeap } from './heap';
import type { Occupancy } from './occupancy';

/** The node types a layout may use, in the order ties between them are broken. */
const POLE_ITEM_IDS = [2201, 2202, 2212] as const;

/** A relay is placed this share of a link away from the last node. */
const RELAY_STEP = 0.9;
/** Metres a node keeps inside its cover radius or link distance, so float noise never decides a case. */
const SLACK_M = 1e-6;
/** Most relays one layout may need before the call gives up (a runaway guard). */
const MAX_RELAYS = 100_000;
/** Lattice steps a relay may move away from its ideal spot while keeping to the nominal step. */
const RELAY_SNAP_TILES = 3;
/** Float noise allowance when walking lattice points between sorter ends. */
const TOL = 1e-6;

const KEY_OFFSET = 1 << 20;
const KEY_STRIDE = 1 << 21;
const keyOf = (x: number, y: number): number => (x + KEY_OFFSET) * KEY_STRIDE + (y + KEY_OFFSET);
const cell = (x: number, y: number): string => `${x},${y}`;

const metres = (dx: number, dy: number, dz = 0): number => Math.hypot(dx * TILE, dy * TILE, dz * LEVEL);

/** The type chosen for the layout, with what the placement needs to know about it. */
interface PoleType {
  itemId: number;
  /** Cover radius and link distance, metres. */
  cover: number;
  connect: number;
  /** Where the power point sits relative to the building's position, tiles and levels. */
  offset: { x: number; y: number; z: number };
  /** Half the footprint's width and depth, tiles. */
  halfX: number;
  halfY: number;
}

/** A node in the network: a power point and its reach. */
interface NodePoint {
  x: number;
  y: number;
  z: number;
  cover: number;
  connect: number;
}

function poleTypeOf(itemId: number, data: GameDataIndex, occ: Occupancy): PoleType | undefined {
  const node = data.building(itemId)?.power.node;
  if (!node || node.coverRadius <= 0) return undefined;
  const power = prefabToGrid({ x: 0, y: 0, z: 0, yaw: 0 }, node.powerPoint);
  const fp = occ.footprintOf(itemId, 0);
  return {
    itemId,
    cover: node.coverRadius,
    connect: node.connectDistance,
    offset: { x: power.x, y: power.y, z: power.z },
    halfX: (fp.maxX - fp.minX) / 2,
    halfY: (fp.maxY - fp.minY) / 2,
  };
}

/** The unlocked node type with the best `coverRadius² / footprint`; undefined when none is unlocked. */
function bestPoleType(data: GameDataIndex, effects: TechEffects, occ: Occupancy): PoleType | undefined {
  let best: { type: PoleType; score: number } | undefined;
  for (const itemId of POLE_ITEM_IDS) {
    if (!effects.availableBuildings.has(itemId)) continue;
    const type = poleTypeOf(itemId, data, occ);
    if (!type) continue;
    const score = (type.cover / TILE) ** 2 / (4 * type.halfX * type.halfY);
    if (!best || score > best.score) best = { type, score };
  }
  return best?.type;
}

/**
 * The nodes that power `buildings` and `consumerPoints`, or null when that cannot be done (no node type is unlocked
 * and something is uncovered or the nodes that stand are apart, or no free lattice point reaches a consumer, or a
 * relay cannot be placed). `buildings` are all the buildings of the
 * layout, which `occ` must hold (and nothing else: a probe node takes the id after the highest of `buildings`);
 * nodes among them count as already placed. `blockedPoints` holds "x,y" lattice cells
 * a node's body must keep off (see the file comment). Only the new nodes come back, as ground-level buildings with ids
 * above those of `buildings` and role `'power'`; `occ` is left as it was.
 */
export function placePowerNodes(
  buildings: PlacedBuilding[],
  consumerPoints: { x: number; y: number }[],
  blockedPoints: Set<string>,
  occ: Occupancy,
  data: GameDataIndex,
  effects: TechEffects,
): PlacedBuilding[] | null {
  // targets, and the nodes that are there already
  const targets: { x: number; y: number }[] = [];
  const nodes: NodePoint[] = [];
  for (const b of buildings) {
    const power = buildingDef(data, b.itemId).power;
    if (power.node) {
      const p = prefabToGrid(b, power.node.powerPoint);
      nodes.push({ x: p.x, y: p.y, z: p.z, cover: power.node.coverRadius, connect: power.node.connectDistance });
    } else if (power.consumer) {
      targets.push({ x: b.x, y: b.y });
    }
  }
  for (const p of consumerPoints) targets.push({ x: p.x, y: p.y });
  const covered = targets.map((t) => nodes.some((n) => n.cover > 0 && metres(n.x - t.x, n.y - t.y) <= n.cover - SLACK_M));

  // Nodes that already cover everything may still stand apart, so the link phase runs either way. Without an unlocked
  // type there is nothing to cover or relay with, which only works out if nothing needs either.
  const type = bestPoleType(data, effects, occ);
  if (!type && !covered.every(Boolean)) return null;
  return new Placer(buildings, blockedPoints, occ, type, targets, covered, nodes).run();
}

class Placer {
  private readonly added: PlacedBuilding[] = [];
  private readonly valid = new Map<number, boolean>();
  private readonly firstId: number;
  /** How far, in whole lattice steps, a node's body reaches over the cells beside its own. */
  private readonly reachX: number;
  private readonly reachY: number;

  constructor(
    buildings: PlacedBuilding[],
    private readonly blocked: Set<string>,
    private readonly occ: Occupancy,
    private readonly poleType: PoleType | undefined,
    private readonly targets: { x: number; y: number }[],
    private readonly covered: boolean[],
    private readonly nodes: NodePoint[],
  ) {
    this.firstId = buildings.reduce((m, b) => Math.max(m, b.id), 0) + 1;
    // a belt node (or sorter cell) on a lattice point inside the body grown by half a belt is in the node's way
    this.reachX = poleType ? Math.ceil(poleType.halfX + BELT_HALF_WIDTH_TILES) - 1 : 0;
    this.reachY = poleType ? Math.ceil(poleType.halfY + BELT_HALF_WIDTH_TILES) - 1 : 0;
  }

  /** The node type, asked for only when a node is to be placed (`placePowerNodes` leaves it undefined only if none is). */
  private get type(): PoleType {
    if (!this.poleType) throw new Error('no power node type is unlocked');
    return this.poleType;
  }

  run(): PlacedBuilding[] | null {
    try {
      if (!this.cover() || !this.link()) return null;
      return this.added;
    } finally {
      for (const b of this.added) this.occ.removeBuilding(b.id);
    }
  }

  private pole(x: number, y: number, id: number): PlacedBuilding {
    return { id, itemId: this.type.itemId, x, y, z: 0, yaw: 0, role: 'power' };
  }

  /** Can a node stand on (x, y)? Free of blocked cells and of buildings, nodes already placed included. */
  private free(x: number, y: number): boolean {
    const key = keyOf(x, y);
    let ok = this.valid.get(key);
    if (ok === undefined) {
      ok = !this.touchesBlocked(x, y) && !this.occ.buildingCollides(this.pole(x, y, this.firstId + this.added.length));
      // a free spot can be taken later by a node placed here: only a refusal is final
      if (!ok) this.valid.set(key, false);
    }
    return ok;
  }

  private touchesBlocked(x: number, y: number): boolean {
    if (this.blocked.size === 0) return false;
    for (let dx = -this.reachX; dx <= this.reachX; dx++) {
      for (let dy = -this.reachY; dy <= this.reachY; dy++) if (this.blocked.has(cell(x + dx, y + dy))) return true;
    }
    return false;
  }

  private place(x: number, y: number): void {
    const b = this.pole(x, y, this.firstId + this.added.length);
    this.occ.addBuilding(b);
    this.added.push(b);
    this.nodes.push({
      x: x + this.type.offset.x,
      y: y + this.type.offset.y,
      z: this.type.offset.z,
      cover: this.type.cover,
      connect: this.type.connect,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Cover

  /** Greedy set cover; false when a target has no free spot that reaches it. */
  private cover(): boolean {
    if (!this.poleType) return true; // nothing is uncovered, or `placePowerNodes` would have refused
    const { targets, covered, type } = this;
    const r = type.cover / TILE;
    // candidate lattice points (the node's origin) and the targets each reaches, in the order they are found
    const lists = new Map<number, number[]>();
    const spots: { x: number; y: number; list: number[] }[] = [];
    targets.forEach((t, i) => {
      if (covered[i]) return;
      const cx = t.x - type.offset.x;
      const cy = t.y - type.offset.y;
      for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
        for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
          if (metres(x - cx, y - cy) > type.cover - SLACK_M) continue;
          const key = keyOf(x, y);
          let list = lists.get(key);
          if (!list) {
            list = [];
            lists.set(key, list);
            spots.push({ x, y, list });
          }
          list.push(i);
        }
      }
    });

    // most targets first, then the spot found first
    const order = (count: number, at: number): number => -count * 1e9 + at;
    const heap = new MinHeap(spots.length);
    spots.forEach((s, at) => heap.push(order(s.list.length, at), at));
    let left = covered.filter((c) => !c).length;
    while (left > 0 && heap.size > 0) {
      const at = heap.pop();
      const spot = spots[at];
      const count = spot.list.reduce((n, i) => n + (covered[i] ? 0 : 1), 0);
      if (count === 0) continue;
      // the count only falls: when it still beats whatever is next, the spot is the greedy choice
      if (heap.size > 0 && order(count, at) > heap.peekKey()) {
        heap.push(order(count, at), at);
        continue;
      }
      if (!this.free(spot.x, spot.y)) continue;
      this.place(spot.x, spot.y);
      for (const i of spot.list) {
        if (covered[i]) continue;
        covered[i] = true;
        left--;
      }
    }
    return left === 0;
  }

  // -------------------------------------------------------------------------------------------
  // Links

  /** Joins the components of the network with relays; false when a relay has no free spot. */
  private link(): boolean {
    for (;;) {
      const comp = this.components();
      let best: { i: number; j: number; d: number } | undefined;
      const n = this.nodes.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (comp[i] === comp[j]) continue;
          const d = this.distance(this.nodes[i], this.nodes[j]);
          if (!best || d < best.d) best = { i, j, d };
        }
      }
      if (!best) return true;
      if (!this.relayChain(this.nodes[best.i], this.nodes[best.j])) return false;
    }
  }

  private distance(a: NodePoint, b: NodePoint): number {
    return metres(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  private linked(a: NodePoint, b: NodePoint): boolean {
    return this.distance(a, b) <= Math.min(a.connect, b.connect) - SLACK_M;
  }

  /** The component of every node, numbered by the lowest node in it. */
  private components(): number[] {
    const n = this.nodes.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (this.linked(this.nodes[i], this.nodes[j])) parent[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
      }
    }
    return parent.map((_, i) => find(i));
  }

  /** Relays from `from` towards `to` until the last one links to `to`. */
  private relayChain(from: NodePoint, to: NodePoint): boolean {
    if (!this.poleType) return false;
    const { type } = this;
    let cur = from;
    for (let relays = 0; !this.linked(cur, to); relays++) {
      if (relays >= MAX_RELAYS) return false;
      const d = this.distance(cur, to);
      const step = Math.min(RELAY_STEP * type.connect, d);
      // the ideal spot, on the straight line, in node-origin coordinates
      const ix = cur.x + ((to.x - cur.x) * step) / d - type.offset.x;
      const iy = cur.y + ((to.y - cur.y) * step) / d - type.offset.y;
      const spot = this.relaySpot(cur, to, ix, iy, d);
      if (!spot) return false;
      this.place(spot.x, spot.y);
      cur = this.nodes[this.nodes.length - 1];
    }
    return true;
  }

  /**
   * A free lattice point for the next relay: the one nearest the ideal spot within `RELAY_SNAP_TILES` that links to
   * `cur` and gets nearer to `to`; failing that, the one that gets nearest to `to` of all that link to `cur`.
   */
  private relaySpot(cur: NodePoint, to: NodePoint, ix: number, iy: number, d: number): { x: number; y: number } | undefined {
    const { type } = this;
    const reach = (x: number, y: number): NodePoint => ({
      x: x + type.offset.x,
      y: y + type.offset.y,
      z: type.offset.z,
      cover: type.cover,
      connect: type.connect,
    });
    const ok = (x: number, y: number): number | undefined => {
      const p = reach(x, y);
      if (!this.linked(cur, p)) return undefined;
      const left = this.distance(p, to);
      if (left >= d - SLACK_M) return undefined;
      return this.free(x, y) ? left : undefined;
    };

    let near: { x: number; y: number; away: number } | undefined;
    for (let x = Math.round(ix) - RELAY_SNAP_TILES; x <= Math.round(ix) + RELAY_SNAP_TILES; x++) {
      for (let y = Math.round(iy) - RELAY_SNAP_TILES; y <= Math.round(iy) + RELAY_SNAP_TILES; y++) {
        if (ok(x, y) === undefined) continue;
        const away = metres(x - ix, y - iy);
        if (!near || away < near.away) near = { x, y, away };
      }
    }
    if (near) return near;

    let far: { x: number; y: number; left: number } | undefined;
    const range = Math.floor(type.connect / TILE);
    const cx = Math.round(cur.x - type.offset.x);
    const cy = Math.round(cur.y - type.offset.y);
    for (let x = cx - range; x <= cx + range; x++) {
      for (let y = cy - range; y <= cy + range; y++) {
        const left = ok(x, y);
        if (left !== undefined && (!far || left < far.left)) far = { x, y, left };
      }
    }
    return far;
  }
}

/**
 * The lattice cells the sorters of `layout` take, as "x,y" keys, and the midpoint of each sorter's ends (the sorters are
 * power consumers): the two ends of each sorter rounded to the lattice, and the lattice points strictly between its ends
 * along the longer plan axis, as the validator's SORTER_IN_BUILDING walks them. Throws as `sorterEnds` does for a sorter
 * whose ends cannot be placed.
 */
export function sorterGeometry(layout: Layout, data: GameDataIndex): { midpoints: { x: number; y: number }[]; cells: Set<string> } {
  const midpoints: { x: number; y: number }[] = [];
  const cells = new Set<string>();
  const index = new LayoutIndex(layout);
  for (const s of layout.sorters) {
    const { pick, drop } = sorterEnds(s, layout, data, index);
    midpoints.push({ x: (pick.x + drop.x) / 2, y: (pick.y + drop.y) / 2 });
    for (const c of sorterEndCells(pick, drop)) cells.add(c);
  }
  return { midpoints, cells };
}

/**
 * The lattice cells a sorter with ends `pick` and `drop` takes, as "x,y" keys: its two ends rounded to the lattice and the
 * lattice points strictly between them along the longer plan axis, as the validator's SORTER_IN_BUILDING walks them.
 */
export function sorterEndCells(pick: { x: number; y: number }, drop: { x: number; y: number }): string[] {
  const cells = [cell(Math.round(pick.x), Math.round(pick.y)), cell(Math.round(drop.x), Math.round(drop.y))];
  const dx = drop.x - pick.x;
  const dy = drop.y - pick.y;
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const a0 = alongX ? pick.x : pick.y;
  const a1 = alongX ? drop.x : drop.y;
  if (Math.abs(a1 - a0) < TOL) return cells;
  const lo = Math.min(a0, a1);
  const hi = Math.max(a0, a1);
  for (let v = Math.floor(lo + TOL) + 1; v < hi - TOL; v++) {
    const t = (v - a0) / (a1 - a0);
    const lateral = Math.round(alongX ? pick.y + t * dy : pick.x + t * dx);
    cells.push(alongX ? cell(v, lateral) : cell(lateral, v));
  }
  return cells;
}

/**
 * What `placePowerNodes` needs to know about a layout that has no nodes yet: the midpoint of each sorter's ends (the
 * sorters are power consumers) and of each spray coater (a consumer at the node it stands on), and the lattice cells a
 * node's body must keep off. These are every belt node (at any height), and for each sorter its two ends rounded to the
 * lattice and the lattice points strictly between its ends along the longer plan axis, as the validator's SORTER_IN_BUILDING
 * walks them (`sorterGeometry`). Throws as `sorterEnds` does for a sorter whose ends cannot be placed.
 */
export function powerTargets(
  layout: Layout,
  data: GameDataIndex,
): { consumerPoints: { x: number; y: number }[]; blockedPoints: Set<string> } {
  const blockedPoints = new Set<string>();
  for (const belt of layout.belts) for (const p of belt.nodes) blockedPoints.add(cell(Math.round(p.x), Math.round(p.y)));

  const { midpoints, cells } = sorterGeometry(layout, data);
  for (const c of cells) blockedPoints.add(c);
  const consumerPoints = midpoints;
  for (const c of coaterBuildings(layout, data)) consumerPoints.push({ x: c.x, y: c.y });
  return { consumerPoints, blockedPoints };
}
