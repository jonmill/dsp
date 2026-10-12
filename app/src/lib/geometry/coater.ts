// Spray coaters in grid space (Task 28): where a coater stands, which belt nodes it spans, and where the proliferator
// belt has to pass it. Shared by the layout solver (which places coaters and routes the proliferator belt through their
// top passage), the validator (COATER_PLACEMENT, COATER_UNFED) and the tick simulator (which reads the proliferator from
// the belt at that point), so all three agree on one definition of "the top point".
//
// The pattern comes from the capsule sample (docs/research/blueprint-samples, 8 coaters): each coater stands on a node
// of a straight ground belt, turned along the belt; a single belt one level up (z = 1) passes the node one step behind
// the coater (on the side of its back), crossing the item belt at a right angle. Nothing is linked to the coater (BF §3.3).
// The top passage as a prefab point is [0, 1.333, -1.25] m (one level up, 1.25 m behind the origin along the axis): with the
// grid convention of `prefabToGrid` that is 0.995 tiles behind the coater, which the game's lattice makes one node.
//
// Which way round. The sample has all 8 coaters turned 180, whichever way their belt flows: they stand in columns 1, 2, 3, 7, 9,
// 10, 14 and 15; the belts of columns 1 and 9 flow north and those of columns 2, 3, 7, 10, 14 and 15 flow south, and the
// proliferator belt runs along y = 18, north of every coater. So a coater is turned along its belt either way round, and its
// top passage is the next node upstream (turned with the flow) or downstream (turned against it). The point, the crossing at a
// right angle and the freedom of the direction are inferred from that one sample, not tested against the game: Task 30's checklist.
import type { Building, GameDataIndex, Vec3 } from '../data';
import type { BeltPath, GridPoint, Layout, PlacedBuilding, SprayCoater } from './model';
import { headingDeg, LEVEL, prefabToGrid } from './transform';

/** The top passage in prefab space (metres): one level up, 1.25 m behind the origin along the coater's axis. */
export const COATER_TOP_PASSAGE: Vec3 = [0, LEVEL, -1.25];

/** A belt node this far (tiles, plan view) from the exact top point is the coater's top passage. */
export const COATER_TOP_TOLERANCE_TILES = 0.15;
/** ...and this far (levels) from one level above the coater. A game export's belts wander by about 0.01. */
export const COATER_TOP_TOLERANCE_LEVELS = 0.1;
/** A coater's belt nodes are on the ground to within this many levels. */
export const COATER_GROUND_TOLERANCE_LEVELS = 0.05;
/** A coater's neighbour nodes are on its axis to within this many tiles. */
export const COATER_AXIS_TOLERANCE_TILES = 0.1;
/** ...and the steps to them are this long, at least and at most, in tiles. */
export const COATER_STEP_TILES: readonly [min: number, max: number] = [0.75, 1.25];
/** A coater is turned along its belt (with the flow or against it) to within this many degrees. */
export const COATER_YAW_TOLERANCE_DEG = 5;

/** The spray coater of GameData (there is one: item 2313), or undefined for a data set without it. */
export function sprayCoaterDef(data: GameDataIndex): Building | undefined {
  return data.data.buildings.find((b) => b.kind === 'sprayCoater');
}

/** Where the top passage of a coater standing at `b` is, exactly: one level up and 1.25 m behind it (its back is `yaw` + 180). */
export function coaterTopPoint(b: { x: number; y: number; z: number; yaw: PlacedBuilding['yaw'] }): GridPoint {
  return prefabToGrid(b, COATER_TOP_PASSAGE);
}

/**
 * The building a coater stands as, for the checks that treat it like one (overlap with other buildings, power cover,
 * a sorter through it): at its belt node, turned `yaw`, with the coater's own id. Undefined where the belt or the node
 * is not in the layout (the placement rule reports that).
 */
export function coaterBuilding(c: SprayCoater, belt: BeltPath | undefined, def: Building): PlacedBuilding | undefined {
  const p = belt?.nodes[c.node];
  if (!p) return undefined;
  return { id: c.id, itemId: def.itemId, x: p.x, y: p.y, z: p.z, yaw: c.yaw, role: 'coater' };
}

/** The buildings of `layout.coaters` that stand on a belt node of the layout, in order. */
export function coaterBuildings(layout: Layout, data: GameDataIndex): PlacedBuilding[] {
  const coaters = layout.coaters;
  if (!coaters || coaters.length === 0) return [];
  const def = sprayCoaterDef(data);
  if (!def) return [];
  const belts = new Map(layout.belts.map((b) => [b.id, b]));
  return coaters.flatMap((c) => coaterBuilding(c, belts.get(c.beltId), def) ?? []);
}

/**
 * Does a belt carry something a coater could take from the top passage? A belt of a proliferator, or one whose item is
 * not known (itemId 0: a belt of an imported blueprint, which names no item).
 */
export function isProliferatorBelt(belt: BeltPath, proliferators: ReadonlySet<number>): boolean {
  return belt.itemId === 0 || proliferators.has(belt.itemId);
}

/** The items the coater `def` takes: its `incItemIds`. */
export function coaterProliferators(def: Building): ReadonlySet<number> {
  return new Set(def.sprayCoater?.incItemIds ?? []);
}

/**
 * The proliferator belt node at the top passage of the coater `pose`: of the nodes of belts that carry a proliferator
 * (`isProliferatorBelt`) within `COATER_TOP_TOLERANCE_TILES` of `coaterTopPoint` and one level (to within
 * `COATER_TOP_TOLERANCE_LEVELS`) above the coater, the nearest. Null when none passes there.
 */
export function findCoaterTop(
  layout: Layout,
  pose: PlacedBuilding,
  proliferators: ReadonlySet<number>,
): { belt: BeltPath; node: number } | null {
  const top = coaterTopPoint(pose);
  let best: { belt: BeltPath; node: number } | null = null;
  let bestDistance = Infinity;
  for (const belt of layout.belts) {
    if (!isProliferatorBelt(belt, proliferators)) continue;
    for (let node = 0; node < belt.nodes.length; node++) {
      const p = belt.nodes[node];
      if (Math.abs(p.z - top.z) > COATER_TOP_TOLERANCE_LEVELS) continue;
      const distance = Math.hypot(p.x - top.x, p.y - top.y);
      if (distance <= COATER_TOP_TOLERANCE_TILES && distance < bestDistance) {
        best = { belt, node };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Smallest angle between two headings in degrees, in [0, 180]. */
const headingGap = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/**
 * Why a coater `yaw` on node `node` of `belt` is not on a straight ground run, or undefined when it is. The coater needs
 * the node it stands on and one before and after it (its body spans those three and a little more), all on the ground, in
 * a line, a node apart, and it is turned along that line, with the flow or against it (the sample has both). The
 * tolerances let a game export through, whose nodes are a little off the lattice; a generated layout is exact.
 */
export function coaterPlacementProblem(belt: BeltPath, node: number, yaw: PlacedBuilding['yaw']): string | undefined {
  const here = belt.nodes[node];
  if (!here) return `belt ${belt.id} has no node ${node} (${belt.nodes.length} nodes)`;
  const prev = belt.nodes[node - 1];
  const next = belt.nodes[node + 1];
  if (!prev || !next) {
    return `node ${node} of belt ${belt.id} is ${prev ? 'the last' : 'the first'} node of the belt: a coater needs a node before and after it`;
  }
  const run = [prev, here, next];
  if (run.some((p) => Math.abs(p.z) > COATER_GROUND_TOLERANCE_LEVELS)) {
    return `nodes ${node - 1}..${node + 1} of belt ${belt.id} are not all on the ground (z ${run.map((p) => +p.z.toFixed(3)).join(', ')})`;
  }
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return `nodes ${node - 1} and ${node + 1} of belt ${belt.id} are at one point`;
  // the lateral offset of the middle node from the line through its neighbours, and the length of the two steps
  const lateral = Math.abs((here.x - prev.x) * dy - (here.y - prev.y) * dx) / length;
  const steps = [Math.hypot(here.x - prev.x, here.y - prev.y), Math.hypot(next.x - here.x, next.y - here.y)];
  if (lateral > COATER_AXIS_TOLERANCE_TILES || steps.some((s) => s < COATER_STEP_TILES[0] || s > COATER_STEP_TILES[1])) {
    return `nodes ${node - 1}..${node + 1} of belt ${belt.id} are not a straight run of single steps (the middle node is ${+lateral.toFixed(3)} tiles off the line, steps ${steps.map((s) => +s.toFixed(3)).join(' and ')} tiles)`;
  }
  const flows = headingDeg(dx, dy);
  if (Math.min(headingGap(flows, yaw), headingGap(flows + 180, yaw)) > COATER_YAW_TOLERANCE_DEG) {
    return `the belt runs along ${+flows.toFixed(1)} degrees (${+((flows + 180) % 360).toFixed(1)} the other way) at node ${node} of belt ${belt.id}, but the coater is turned ${yaw}: it must be turned along its belt`;
  }
  return undefined;
}
