// Slot and port geometry of placed buildings, and where sorter ends and belt ends sit in grid space.
// Shared by the layout solver (which places belts on the lattice points found here), the validator and the
// blueprint builder (which writes the sorter end positions).
import type { Building, GameDataIndex, Pose } from '../data';
import { buildingOBBs } from './footprint';
import type { BeltPath, Endpoint, GridPoint, Layout, PlacedBuilding, Sorter } from './model';
import { pointInOBBs } from './obb';
import type { OBB2 } from './obb';
import { prefabDirToGrid, prefabToGrid, TILE } from './transform';

/** Half the width of a belt: 0.32 m, in tiles. */
export const BELT_HALF_WIDTH_TILES = 0.32 / TILE;

// ---------------------------------------------------------------------------------------------
// Looking things up in a layout

/** An id to array position map that stays correct when the solver edits the layout it indexes. */
class IdIndex<T extends { id: number }> {
  private readonly at = new Map<number, number>();

  constructor(
    private readonly items: () => T[],
    private readonly kind: string,
  ) {
    this.rebuild();
  }

  private rebuild(): void {
    this.at.clear();
    let i = 0;
    for (const item of this.items()) {
      if (this.at.has(item.id)) throw new Error(`duplicate ${this.kind} id ${item.id}`);
      this.at.set(item.id, i++);
    }
  }

  /** The item with this id, read from the live array. A stale position triggers one rebuild. */
  get(id: number): T | undefined {
    const i = this.at.get(id);
    const hit = i === undefined ? undefined : this.items()[i];
    if (hit?.id === id) return hit;
    this.rebuild();
    const j = this.at.get(id);
    return j === undefined ? undefined : this.items()[j];
  }
}

/**
 * Buildings and belts of a layout by id. Build one per layout and pass it to `sorterEnds` and friends for
 * many calls; the lookups read the live arrays, so an index outlives edits to the layout (an edit that moves
 * or adds an element costs one rebuild on the next lookup that notices).
 */
export class LayoutIndex {
  private readonly buildings: IdIndex<PlacedBuilding>;
  private readonly belts: IdIndex<BeltPath>;

  /** Throws on a duplicate building or belt id. */
  constructor(readonly layout: Layout) {
    this.buildings = new IdIndex(() => layout.buildings, 'building');
    this.belts = new IdIndex(() => layout.belts, 'belt');
  }

  /** `what` names the caller in the error, e.g. "belt 2 source". */
  building(id: number, what: string): PlacedBuilding {
    const b = this.buildings.get(id);
    if (!b) throw new Error(`${what}: building ${id} is not in the layout`);
    return b;
  }

  belt(id: number, what: string): BeltPath {
    const belt = this.belts.get(id);
    if (!belt) throw new Error(`${what}: belt ${id} is not in the layout`);
    return belt;
  }
}

const indexes = new WeakMap<Layout, LayoutIndex>();

/** The shared `LayoutIndex` of `layout`, built on first use. */
export function layoutIndex(layout: Layout): LayoutIndex {
  let index = indexes.get(layout);
  if (!index) {
    index = new LayoutIndex(layout);
    indexes.set(layout, index);
  }
  return index;
}

/** The GameData building for an item id, or a clear error. */
export function buildingDef(data: GameDataIndex, itemId: number): Building {
  const def = data.building(itemId);
  if (!def) throw new Error(`GameData has no building for item ${itemId}`);
  return def;
}

/** Node `node` of `belt`, or a clear error. */
export function beltNodeAt(belt: BeltPath, node: number, what: string): GridPoint {
  const p = belt.nodes[node];
  if (!p) throw new Error(`${what}: belt ${belt.id} has no node ${node} (${belt.nodes.length} nodes)`);
  return p;
}

function poseAt(b: PlacedBuilding, poses: Pose[], i: number, kind: 'slot' | 'port', what: string): Pose {
  const pose = poses[i];
  if (!pose) throw new Error(`${what}: building ${b.id} (item ${b.itemId}) has no ${kind} ${i}`);
  return pose;
}

/** Grid position of sorter slot `slot` of `b`. */
export function slotPosition(b: PlacedBuilding, bd: Building, slot: number, what = 'slot'): GridPoint {
  return prefabToGrid(b, poseAt(b, bd.geometry.slots, slot, 'slot', what).position);
}

/** Grid position of belt port `port` of `b`. */
export function portPosition(b: PlacedBuilding, bd: Building, port: number, what = 'port'): GridPoint {
  return prefabToGrid(b, poseAt(b, bd.geometry.ports, port, 'port', what).position);
}

// ---------------------------------------------------------------------------------------------
// Slots and ports

export interface SlotInfo {
  index: number;
  /** Position of the slot or port in grid space. */
  pos: GridPoint;
  /** Unit grid vector the slot faces (east, north), along an axis. */
  dir: [number, number];
  /** The first lattice point beyond the slot along `dir` that is outside the footprint. */
  firstOutside: { x: number; y: number };
}

const AXIS_TOLERANCE = 1e-3;
/** More lattice steps than any building is wide: stops a runaway walk on broken geometry. */
const MAX_STEPS = 64;
/** Float noise allowance when asking for the lattice point strictly beyond a coordinate. */
const LATTICE_SLACK = 1e-9;

function axisDir(dir: [number, number], what: string): [number, number] {
  const [e, n] = dir;
  if (Math.abs(e) > 1 - AXIS_TOLERANCE) return [Math.sign(e), 0];
  if (Math.abs(n) > 1 - AXIS_TOLERANCE) return [0, Math.sign(n)];
  throw new Error(`${what} does not face along an axis (${e.toFixed(3)}, ${n.toFixed(3)})`);
}

function poseInfo(b: PlacedBuilding, pose: Pose, index: number, kind: 'slot' | 'port', obbs: OBB2[]): SlotInfo {
  const pos = prefabToGrid(b, pose.position);
  const dir = axisDir(prefabDirToGrid(b.yaw, pose.rotation), `building ${b.id} (item ${b.itemId}) ${kind} ${index}`);

  // On the line through the pose along dir, at the lattice row nearest to it, the first lattice point past the
  // pose that is not inside the footprint.
  const alongX = dir[0] !== 0;
  const lateral = Math.round(alongX ? pos.y : pos.x) + 0;
  const normal = alongX ? pos.x : pos.y;
  const step = alongX ? dir[0] : dir[1];
  const at = (v: number) => (alongX ? { x: v, y: lateral } : { x: lateral, y: v });
  let n = step > 0 ? Math.floor(normal + LATTICE_SLACK) + 1 : Math.ceil(normal - LATTICE_SLACK) - 1;
  for (let steps = 0; pointInOBBs(at(n).x, at(n).y, null, obbs, 0); steps++) {
    if (steps >= MAX_STEPS) throw new Error(`building ${b.id} (item ${b.itemId}) ${kind} ${index}: no free lattice point within ${MAX_STEPS} tiles`);
    n += step;
  }
  return { index, pos, dir, firstOutside: at(n + 0) };
}

/** Every sorter slot of `b`, in the building's slot order, with the first lattice point outside along each. */
export function slotInfos(b: PlacedBuilding, bd: Building): SlotInfo[] {
  const obbs = buildingOBBs(b, bd);
  return bd.geometry.slots.map((pose, i) => poseInfo(b, pose, i, 'slot', obbs));
}

/** Every belt port of `b`, in the building's port order, with the first lattice point outside along each. */
export function portInfos(b: PlacedBuilding, bd: Building): SlotInfo[] {
  const obbs = buildingOBBs(b, bd);
  return bd.geometry.ports.map((pose, i) => poseInfo(b, pose, i, 'port', obbs));
}

/**
 * The lattice point a sorter of this span taps on a belt: `span - 1` tiles further out than `firstOutside`
 * (a span-1 sorter reaches the first lattice point, a span-2 sorter the one after it).
 */
export function sorterTapPoint(slot: SlotInfo, span: 1 | 2 | 3): { x: number; y: number } {
  return {
    x: Math.round(slot.firstOutside.x + (span - 1) * slot.dir[0]) + 0,
    y: Math.round(slot.firstOutside.y + (span - 1) * slot.dir[1]) + 0,
  };
}

/**
 * The two ends of a sorter on `slot` that taps a straight belt at the ground lattice point `tap`, without a layout
 * to look them up in: `sorterEnds` for that tap. The belt runs across the slot's facing through `tap` (the only way
 * a tap passes the validator's SORTER_BELT_TANGENT), so its end is the slot projected onto that line, at z 0.
 * `dir` 'in' picks from the belt and drops into the slot, 'out' the reverse.
 */
export function sorterTapEnds(slot: SlotInfo, tap: { x: number; y: number }, dir: 'in' | 'out'): { pick: GridPoint; drop: GridPoint } {
  const axis: [number, number] = [Math.abs(slot.dir[1]), Math.abs(slot.dir[0])];
  const onBelt = projectOnAxis({ x: tap.x, y: tap.y, z: 0 }, axis, slot.pos);
  return dir === 'in' ? { pick: onBelt, drop: { ...slot.pos } } : { pick: { ...slot.pos }, drop: onBelt };
}

// ---------------------------------------------------------------------------------------------
// Endpoints

/** The unit vector of (dx, dy), or undefined where it has no length. */
function unit(dx: number, dy: number): [number, number] | undefined {
  const len = Math.hypot(dx, dy);
  return len < 1e-9 ? undefined : [dx / len, dy / len];
}

/**
 * The belt point a building slot taps: the slot's position projected onto the belt's axis line through the
 * tap node, so the belt end sits at the slot's own lateral coordinate, not at the node. z is the node's.
 *
 * The axis runs between the node's neighbours. At a corner (the neighbours are not in line) the belt has two
 * axes, and the one perpendicular to the slot's `facing` is used: that is the row the sorter reaches across to.
 * A corner with no such segment is an error.
 */
function projectOntoBelt(belt: BeltPath, node: number, slot: GridPoint, facing: [number, number]): GridPoint {
  const at = beltNodeAt(belt, node, 'sorter endpoint');
  const prev = belt.nodes[node - 1];
  const next = belt.nodes[node + 1];
  const arriving = prev ? unit(at.x - prev.x, at.y - prev.y) : undefined;
  const leaving = next ? unit(next.x - at.x, next.y - at.y) : undefined;

  let axis = arriving ?? leaving;
  if (arriving && leaving && Math.abs(arriving[0] * leaving[1] - arriving[1] * leaving[0]) > 1e-6) {
    const across = [arriving, leaving].filter((d) => Math.abs(d[0] * facing[0] + d[1] * facing[1]) < AXIS_TOLERANCE);
    if (across.length !== 1) {
      throw new Error(
        `sorter endpoint: belt ${belt.id} node ${node} is a corner and neither segment is perpendicular to the slot facing`,
      );
    }
    axis = across[0];
  } else if (leaving) {
    axis = leaving;
  }
  if (!axis) return { ...at };
  return projectOnAxis(at, axis, slot);
}

/** `slot` projected onto the line through `at` along the unit vector `axis`, at the height of `at`. */
function projectOnAxis(at: GridPoint, axis: readonly [number, number], slot: GridPoint): GridPoint {
  const along = (slot.x - at.x) * axis[0] + (slot.y - at.y) * axis[1];
  return { x: at.x + along * axis[0], y: at.y + along * axis[1], z: at.z };
}

function buildingEnd(e: Extract<Endpoint, { kind: 'building' }>, data: GameDataIndex, index: LayoutIndex): GridPoint {
  const b = index.building(e.buildingId, 'sorter endpoint');
  return slotPosition(b, buildingDef(data, b.itemId), e.slot, 'sorter endpoint');
}

function endPoint(e: Endpoint, opposite: Endpoint, data: GameDataIndex, index: LayoutIndex): GridPoint {
  if (e.kind === 'building') return buildingEnd(e, data, index);
  const belt = index.belt(e.beltId, 'sorter endpoint');
  if (opposite.kind !== 'building') return { ...beltNodeAt(belt, e.node, 'sorter endpoint') };
  const b = index.building(opposite.buildingId, 'sorter endpoint');
  const pose = poseAt(b, buildingDef(data, b.itemId).geometry.slots, opposite.slot, 'slot', 'sorter endpoint');
  return projectOntoBelt(belt, e.node, prefabToGrid(b, pose.position), prefabDirToGrid(b.yaw, pose.rotation));
}

/** A building endpoint is its slot position; a belt endpoint is the belt node itself. */
export function endpointWorld(e: Endpoint, layout: Layout, data: GameDataIndex, index: LayoutIndex = layoutIndex(layout)): GridPoint {
  if (e.kind === 'building') return buildingEnd(e, data, index);
  return { ...beltNodeAt(index.belt(e.beltId, 'sorter endpoint'), e.node, 'sorter endpoint') };
}

/**
 * Where a sorter's two ends sit in grid space. A building end is the slot position; a belt end is the point on
 * the belt at the opposite building slot's lateral coordinate (see `projectOntoBelt`), at the tap node's height;
 * building to building uses both slot positions; belt to belt (unused in v1) uses both tap nodes.
 *
 * Pass an `index` built once (`new LayoutIndex(layout)`) when calling this for many sorters; without one the
 * layout's shared index is used.
 */
export function sorterEnds(
  s: Sorter,
  layout: Layout,
  data: GameDataIndex,
  index: LayoutIndex = layoutIndex(layout),
): { pick: GridPoint; drop: GridPoint } {
  return { pick: endPoint(s.pick, s.drop, data, index), drop: endPoint(s.drop, s.pick, data, index) };
}
