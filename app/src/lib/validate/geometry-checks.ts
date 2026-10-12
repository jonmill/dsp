// Geometry and connection rules: the independent gate that decides whether a generated layout can be built in
// game. Everything here is checked from the Layout and GameData alone; nothing from the layout solver is used.
// Rule numbers refer to the Task 15 brief. Each violation names its entities, and `mirrors` names the game
// method the rule follows where there is one.
import type { Building, GameDataIndex, TechEffects } from '../data';
import {
  BELT_HALF_WIDTH_TILES,
  LEVEL,
  LayoutIndex,
  MIN_SORTER_LENGTH_M,
  SKEW_LIMIT_BELT_DEG,
  TILE,
  buildingDef,
  buildingOBBs,
  obbOverlap,
  pointInOBBs,
  portInfos,
  prefabToGrid,
  slotInfos,
  sorterEnds,
  sorterReachProblem,
  sorterSkewProblem,
  sorterTapPoint,
} from '../geometry';
import type { BeltPath, GridPoint, Layout, OBB2, PlacedBuilding, SlotInfo, Sorter } from '../geometry';
import type { Violation, ViolationCode, ViolationEntity } from './types';

const MIRROR_CLICK = 'BuildTool_Click.CheckBuildConditions';
const MIRROR_PATH = 'BuildTool_Path.CheckBuildConditions';
const MIRROR_INSERTER = 'BuildTool_Inserter.CheckBuildConditions';
// The power rules follow how PowerSystem.GameTick links nodes and supplies consumers. No `// mirrors:` marker here:
// that method is listed against the tick simulator's module (sim/world.ts), where the port itself lives.
const MIRROR_POWER = 'PowerSystem.GameTick';

/** The codes this module emits, in the order its violations are returned. */
const RULE_ORDER: ViolationCode[] = [
  'BUILDING_OVERLAP',
  'BELT_IN_BUILDING',
  'BELT_OVERLAP',
  'BELT_DISCONNECTED',
  'BELT_BAD_RAMP',
  'BELT_TOO_HIGH',
  'BELT_PORT_MISMATCH',
  'SORTER_SPAN',
  'SORTER_SLOT_INVALID',
  'SORTER_SLOT_REUSED',
  'SORTER_SKEW',
  'SORTER_IN_BUILDING',
  'SORTER_ENDPOINT_BELT_RAMP',
  'SORTER_BELT_TANGENT',
  'SORTER_TO_STATION',
  'POWER_UNCOVERED',
  'POWER_DISCONNECTED',
  'STATION_SLOTS',
];

/** Positions closer than this are the same position. */
const TOL = 1e-6;
/** Lattice points examined between the ends of one sorter; a sorter in reach spans at most 5, this only bounds bad input. */
const MAX_LATTICE_WALK = 16;
/** Flat steps a lift needs on each side (MX §2.4). */
const FLAT_STEPS_AROUND_LIFT = 2;
/** Stacked buildings share x and y to within this many tiles. */
const STACK_XY_TOL = 0.05;
/** A stacked building stands within this many metres of the lower one's lapJoint height. */
const STACK_Z_TOL_M = 0.05;
/** A lapJoint at most this many metres high is no lapJoint (the data holds 0 for buildings that cannot stack). */
const STACK_MIN_LAP_M = 0.01;

// ---------------------------------------------------------------------------------------------
// Spatial hash

const KEY_OFFSET = 1 << 20;
const KEY_SPAN = 1 << 21;

/** Items registered under the cells their bounding boxes touch, for near-neighbour queries. Ids are 0..capacity-1. */
class SpatialGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly marks: Int32Array;
  private epoch = 0;

  constructor(
    capacity: number,
    private readonly cell: number,
  ) {
    this.marks = new Int32Array(capacity);
  }

  add(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
    const c = this.cell;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cy = Math.floor(minY / c); cy <= Math.floor(maxY / c); cy++) {
        const key = (cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET);
        const list = this.cells.get(key);
        if (list) list.push(id);
        else this.cells.set(key, [id]);
      }
    }
  }

  /** Calls `visit` once for every id registered under a cell that the box touches. */
  query(minX: number, minY: number, maxX: number, maxY: number, visit: (id: number) => void): void {
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
    this.epoch++;
    const c = this.cell;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cy = Math.floor(minY / c); cy <= Math.floor(maxY / c); cy++) {
        const list = this.cells.get((cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET));
        if (!list) continue;
        for (const id of list) {
          if (this.marks[id] === this.epoch) continue;
          this.marks[id] = this.epoch;
          visit(id);
        }
      }
    }
  }
}

/** Grid cell size in tiles: about the width of one building. */
const CELL_TILES = 4;
/** Cell size for power nodes, whose reach is tens of tiles. */
const POWER_CELL_TILES = 16;

/** The plan-view bounding box of `o`, grown by `margin` tiles. */
function bounds(o: OBB2, margin = 0): [number, number, number, number] {
  const c = Math.abs(Math.cos(o.angle));
  const s = Math.abs(Math.sin(o.angle));
  const ex = c * o.hx + s * o.hy + margin;
  const ey = s * o.hx + c * o.hy + margin;
  return [o.cx - ex, o.cy - ey, o.cx + ex, o.cy + ey];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const num = (n: number): string => String(Math.round(n * 1000) / 1000);
const at = (p: { x: number; y: number }): string => `(${num(p.x)}, ${num(p.y)})`;
const near = (a: number, b: number): boolean => Math.abs(a - b) < TOL;
const metres = (dx: number, dy: number, dz = 0): number => Math.hypot(dx * TILE, dy * TILE, dz * LEVEL);

const building = (id: number): ViolationEntity => ({ kind: 'building', id });
const sorter = (id: number): ViolationEntity => ({ kind: 'sorter', id });
const beltNode = (id: number, node: number): ViolationEntity => ({ kind: 'belt', id, node });

interface BuildingEntry {
  /** Position in `layout.buildings`. */
  index: number;
  b: PlacedBuilding;
  bd: Building;
  obbs: OBB2[];
  slots?: (SlotInfo | string)[];
  ports?: (SlotInfo | string)[];
}

const label = (e: BuildingEntry): string => `building ${e.b.id} (${e.bd.name})`;

/** One collider box of a building, registered in the building grid. */
interface Box {
  entry: BuildingEntry;
  obb: OBB2;
  /** `[obb]`, ready for `pointInOBBs`. */
  solo: OBB2[];
}

interface BeltNodeRef {
  belt: BeltPath;
  node: number;
}

/** What one belt step is. `dir` is the heading of a flat step. */
type Step = { kind: 'flat'; dir: [number, number] } | { kind: 'lift'; dz: number } | { kind: 'broken' };

function classifyStep(a: GridPoint, b: GridPoint): Step {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  if (near(dz, 0)) {
    if (near(Math.abs(dx), 1) && near(dy, 0)) return { kind: 'flat', dir: [Math.sign(dx), 0] };
    if (near(dx, 0) && near(Math.abs(dy), 1)) return { kind: 'flat', dir: [0, Math.sign(dy)] };
  } else if (near(dx, 0) && near(dy, 0) && near(Math.abs(dz), 1)) {
    return { kind: 'lift', dz: Math.sign(dz) };
  }
  return { kind: 'broken' };
}

/** One end of a sorter, resolved against the layout. */
interface EndCtx {
  name: 'pick' | 'drop';
  building?: BuildingEntry;
  /** Set where the slot index is valid. */
  slotIndex?: number;
  /** Set where the slot is also usable (faces along an axis). */
  slot?: SlotInfo;
  belt?: BeltPath;
  node?: number;
}

interface SorterCtx {
  s: Sorter;
  ends: [EndCtx, EndCtx];
  /** Both ends exist, none is on a station, and any slot index is in range. */
  resolved: boolean;
  /** The sorter placement problem already reported by the tangent rule, which explains a failed `sorterEnds`. */
  tangentReported: boolean;
}

interface PowerNode {
  entry: BuildingEntry;
  x: number;
  y: number;
  z: number;
  cover: number;
  connect: number;
}

// ---------------------------------------------------------------------------------------------

class GeometryChecker {
  private readonly byCode = new Map<ViolationCode, Violation[]>(RULE_ORDER.map((c) => [c, []]));
  private readonly index: LayoutIndex;
  private readonly entries: BuildingEntry[] = [];
  private readonly entryById = new Map<number, BuildingEntry>();
  private readonly beltById = new Map<number, BeltPath>();
  private readonly boxes: Box[] = [];
  private readonly boxGrid: SpatialGrid;
  /** Midpoints of the sorters whose ends could be placed: sorters are power consumers. */
  private readonly sorterPoints: { s: Sorter; x: number; y: number }[] = [];
  /** Entries (by position in `layout.buildings`) whose `stackParentId` names a building they may stand on. */
  private readonly stackedOk = new Set<number>();
  /** What is wrong with the stacks the layout declares, in building order. */
  private readonly stackProblems: { entities: [BuildingEntry, BuildingEntry?]; text: string }[] = [];

  constructor(
    private readonly layout: Layout,
    private readonly data: GameDataIndex,
    private readonly effects: TechEffects,
  ) {
    // Throws on a duplicate building or belt id: a malformed layout, not an invalid one.
    this.index = new LayoutIndex(layout);
    layout.buildings.forEach((b, index) => {
      const bd = buildingDef(data, b.itemId);
      const entry: BuildingEntry = { index, b, bd, obbs: buildingOBBs(b, bd) };
      this.entries.push(entry);
      this.entryById.set(b.id, entry);
    });
    for (const belt of layout.belts) this.beltById.set(belt.id, belt);
    for (const entry of this.entries) {
      for (const obb of entry.obbs) this.boxes.push({ entry, obb, solo: [obb] });
    }
    this.boxGrid = new SpatialGrid(this.boxes.length, CELL_TILES);
    this.boxes.forEach((box, i) => this.boxGrid.add(i, ...bounds(box.obb)));
    this.analyzeStacks();
  }

  run(): Violation[] {
    this.buildingOverlaps();
    this.beltsInBuildings();
    this.beltOverlaps();
    this.beltSteps();
    this.beltHeights();
    this.beltPorts();
    this.sorters();
    this.power();
    this.stationSlots();
    return RULE_ORDER.flatMap((code) => this.byCode.get(code) ?? []);
  }

  private emit(code: ViolationCode, entities: ViolationEntity[], message: string, mirrors?: string): void {
    const v: Violation = { code, entities, message };
    if (mirrors !== undefined) v.mirrors = mirrors;
    this.byCode.get(code)!.push(v);
  }

  // -------------------------------------------------------------------------------------------
  // Slot and port geometry, with a skew pose degrading to a message instead of an exception

  /**
   * The slots (or ports) of a building. `slotInfos` throws for the whole building when one pose does not face
   * along an axis; then each pose is tried alone and the bad ones come back as the cause text.
   */
  private poseInfos(entry: BuildingEntry, kind: 'slot' | 'port'): (SlotInfo | string)[] {
    const cached = kind === 'slot' ? entry.slots : entry.ports;
    if (cached) return cached;
    const infos = kind === 'slot' ? slotInfos : portInfos;
    const key = kind === 'slot' ? 'slots' : 'ports';
    let out: (SlotInfo | string)[];
    try {
      out = infos(entry.b, entry.bd);
    } catch {
      out = entry.bd.geometry[key].map((pose, i) => {
        const alone: Building = { ...entry.bd, geometry: { ...entry.bd.geometry, [key]: [pose] } };
        try {
          return { ...infos(entry.b, alone)[0], index: i };
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          return cause.replace(new RegExp(` ${kind} 0\\b`), ` ${kind} ${i}`);
        }
      });
    }
    if (kind === 'slot') entry.slots = out;
    else entry.ports = out;
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // 1. BUILDING_OVERLAP

  // mirrors: BuildTool_Click.CheckBuildConditions
  /**
   * Pairwise `obbOverlap` of building boxes, found through the spatial hash. Buildings of one declared stack
   * (`stackParentId`, one `lapJoint` apart, see `analyzeStacks`) are exempt. A stack that breaks the stacking rules
   * (wrong place, wrong height, too tall) is reported here too, after the overlaps.
   */
  private buildingOverlaps(): void {
    const seen = new Set<number>();
    const n = this.entries.length;
    this.boxes.forEach((a, i) => {
      this.boxGrid.query(...bounds(a.obb), (j) => {
        if (j <= i) return;
        const b = this.boxes[j];
        if (b.entry === a.entry) return;
        const key = Math.min(a.entry.index, b.entry.index) * n + Math.max(a.entry.index, b.entry.index);
        if (seen.has(key) || !obbOverlap(a.obb, b.obb)) return;
        seen.add(key);
        if (this.isStacked(a.entry, b.entry)) return;
        this.emit(
          'BUILDING_OVERLAP',
          [building(a.entry.b.id), building(b.entry.b.id)],
          `${label(a.entry)} and ${label(b.entry)} overlap`,
          MIRROR_CLICK,
        );
      });
    });
    for (const { entities, text } of this.stackProblems) {
      this.emit('BUILDING_OVERLAP', entities.flatMap((e) => (e ? [building(e.b.id)] : [])), text, MIRROR_CLICK);
    }
  }

  /**
   * Stacking (MX §4.4, §8). A building that carries a `stackParentId` stands on that building: the same kind of
   * multiLevel building, on the same x, y and yaw, one `lapJoint` of the lower one higher. A stack of labs is at most
   * `effects.labLevel` high (other kinds are not limited here: their limits are not modelled). `stackedOk` holds the
   * buildings whose link to the building below is right; `stackProblems` the rest, and the stacks that are too tall.
   */
  private analyzeStacks(): void {
    const linkProblem = (e: BuildingEntry, parent: BuildingEntry): string | undefined => {
      const geo = (x: BuildingEntry) => x.bd.geometry;
      if (e.bd.kind !== parent.bd.kind) {
        return `${label(e)} is stacked on ${label(parent)}, but they are different kinds of building (${e.bd.kind} and ${parent.bd.kind})`;
      }
      if (!geo(e).multiLevel || !geo(parent).multiLevel) {
        const flat = geo(e).multiLevel ? parent : e;
        return `${label(e)} is stacked on ${label(parent)}, but ${label(flat)} is not multiLevel and cannot be stacked`;
      }
      if (Math.abs(e.b.x - parent.b.x) > STACK_XY_TOL || Math.abs(e.b.y - parent.b.y) > STACK_XY_TOL) {
        return `${label(e)} is stacked on ${label(parent)}, but is not on the same x, y: ${at(e.b)} against ${at(parent.b)}`;
      }
      if (e.b.yaw !== parent.b.yaw) {
        return `${label(e)} is stacked on ${label(parent)}, but its yaw is ${e.b.yaw} and the building below has yaw ${parent.b.yaw}`;
      }
      const lap = geo(parent).lapJoint[1];
      const dz = e.b.z - parent.b.z;
      if (!(lap > STACK_MIN_LAP_M) || Math.abs(dz * LEVEL - lap) > STACK_Z_TOL_M) {
        return (
          `${label(e)} is stacked on ${label(parent)} at z ${num(e.b.z)}, ${num(dz)} levels up, but the lapJoint of ` +
          `${parent.bd.name} is ${num(lap)} m = ${num(lap / LEVEL)} levels: it must stand at z ${num(parent.b.z + lap / LEVEL)}`
        );
      }
      return undefined;
    };

    for (const e of this.entries) {
      const parentId = e.b.stackParentId;
      if (parentId === undefined) continue;
      if (parentId === e.b.id) {
        this.stackProblems.push({ entities: [e], text: `${label(e)} cannot be stacked on itself` });
        continue;
      }
      const parent = this.entryById.get(parentId);
      if (!parent) {
        this.stackProblems.push({ entities: [e], text: `${label(e)} is stacked on building ${parentId}, which is not in the layout` });
        continue;
      }
      const problem = linkProblem(e, parent);
      if (problem) this.stackProblems.push({ entities: [e, parent], text: problem });
      else this.stackedOk.add(e.index);
    }

    // Heights, from the links that are right; a loop of links is cut where it closes.
    const height = (e: BuildingEntry, seen: Set<number>): number => {
      if (!this.stackedOk.has(e.index) || seen.has(e.index)) return 1;
      seen.add(e.index);
      return 1 + height(this.entryById.get(e.b.stackParentId as number) as BuildingEntry, seen);
    };
    for (const e of this.entries) {
      if (!this.stackedOk.has(e.index)) continue;
      const limit = e.bd.kind === 'lab' ? this.effects.labLevel : Infinity;
      const high = height(e, new Set());
      if (high > limit) {
        this.stackProblems.push({
          entities: [e, this.entryById.get(e.b.stackParentId as number)],
          text: `the stack ends at ${label(e)} and is ${high} high; at labLevel ${limit} a stack of labs is at most ${limit} high`,
        });
      }
    }
  }

  /** Is one of the two stacked, directly or through the buildings between them, on the other? */
  private isStacked(a: BuildingEntry, b: BuildingEntry): boolean {
    const [lower, upper] = a.b.z <= b.b.z ? [a, b] : [b, a];
    let cur: BuildingEntry = upper;
    for (let steps = 0; steps <= this.entries.length; steps++) {
      if (!this.stackedOk.has(cur.index)) return false;
      const parent = this.entryById.get(cur.b.stackParentId as number) as BuildingEntry;
      if (parent === lower) return true;
      cur = parent;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // 2. BELT_IN_BUILDING

  // mirrors: BuildTool_Path.CheckBuildConditions
  /** A belt node inside a building box grown by the belt's half width, within the building's height range. */
  private beltsInBuildings(): void {
    const margin = BELT_HALF_WIDTH_TILES + TOL;
    for (const belt of this.layout.belts) {
      belt.nodes.forEach((p, node) => {
        const hits: BuildingEntry[] = [];
        this.boxGrid.query(p.x - margin, p.y - margin, p.x + margin, p.y + margin, (id) => {
          const box = this.boxes[id];
          if (!hits.includes(box.entry) && pointInOBBs(p.x, p.y, p.z, box.solo, BELT_HALF_WIDTH_TILES)) hits.push(box.entry);
        });
        if (hits.length === 0) return;
        hits.sort((a, b) => a.index - b.index);
        this.emit(
          'BELT_IN_BUILDING',
          [beltNode(belt.id, node), ...hits.map((h) => building(h.b.id))],
          `belt ${belt.id} node ${node} at ${at(p)} z ${num(p.z)} is inside ${hits.map(label).join(' and ')}`,
          MIRROR_PATH,
        );
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // 3. BELT_OVERLAP

  // mirrors: BuildTool_Path.CheckBuildConditions
  /**
   * Two belt nodes at one (x, y, z): across belts, or non-consecutive in one belt. The last node of a belt that
   * merges into another (`sink: belt`) may sit on the node it merges into.
   */
  private beltOverlaps(): void {
    const groups = new Map<string, BeltNodeRef[]>();
    for (const belt of this.layout.belts) {
      belt.nodes.forEach((p, node) => {
        const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)},${Math.round(p.z * 1e4)}`;
        const list = groups.get(key);
        if (list) list.push({ belt, node });
        else groups.set(key, [{ belt, node }]);
      });
    }
    for (const refs of groups.values()) {
      if (refs.length < 2) continue;
      const involved = new Set<number>();
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          if (this.overlapAllowed(refs[i], refs[j])) continue;
          involved.add(i);
          involved.add(j);
        }
      }
      if (involved.size === 0) continue;
      const nodes = refs.filter((_, i) => involved.has(i));
      const p = nodes[0].belt.nodes[nodes[0].node];
      this.emit(
        'BELT_OVERLAP',
        nodes.map((r) => beltNode(r.belt.id, r.node)),
        `${nodes.map((r) => `belt ${r.belt.id} node ${r.node}`).join(' and ')} are at the same point ${at(p)} z ${num(p.z)}`,
        MIRROR_PATH,
      );
    }
  }

  private overlapAllowed(a: BeltNodeRef, b: BeltNodeRef): boolean {
    if (a.belt === b.belt && Math.abs(a.node - b.node) === 1) return true; // a duplicated node is BELT_DISCONNECTED
    return this.mergesInto(a, b) || this.mergesInto(b, a);
  }

  /** `m` is the last node of a belt whose sink is exactly node `t`. */
  private mergesInto(m: BeltNodeRef, t: BeltNodeRef): boolean {
    const sink = m.belt.sink;
    return (
      sink?.kind === 'belt' &&
      m.belt !== t.belt &&
      sink.beltId === t.belt.id &&
      sink.node === t.node &&
      m.node === m.belt.nodes.length - 1
    );
  }

  // -------------------------------------------------------------------------------------------
  // 4. BELT_DISCONNECTED and 5. BELT_BAD_RAMP

  // mirrors: BuildTool_Path.CheckBuildConditions
  /**
   * Consecutive nodes must be a flat step (4-adjacent, same height) or a vertical lift (same x/y, one level).
   * Diagonal 1 tile + 1 level ramps are unverified in game and not generated in v1. A lift run needs two flat
   * steps in one direction on each side (the editor's JointCannotLift and TooBendToLift, MX §2.4).
   */
  private beltSteps(): void {
    for (const belt of this.layout.belts) {
      if (belt.nodes.length === 0) {
        this.emit('BELT_DISCONNECTED', [{ kind: 'belt', id: belt.id }], `belt ${belt.id} has no nodes`, MIRROR_PATH);
        continue;
      }
      const steps: Step[] = [];
      for (let i = 0; i + 1 < belt.nodes.length; i++) {
        const a = belt.nodes[i];
        const b = belt.nodes[i + 1];
        const step = classifyStep(a, b);
        steps.push(step);
        if (step.kind === 'broken') {
          this.emit(
            'BELT_DISCONNECTED',
            [beltNode(belt.id, i)],
            `belt ${belt.id}: node ${i} at ${at(a)} z ${num(a.z)} to node ${i + 1} at ${at(b)} z ${num(b.z)} is neither a flat step ` +
              `(one tile along an axis, same height) nor a vertical lift (same x/y, one level)`,
            MIRROR_PATH,
          );
        }
      }
      this.liftRuns(belt, steps);
    }
  }

  private liftRuns(belt: BeltPath, steps: Step[]): void {
    for (let a = 0; a < steps.length; ) {
      const first = steps[a];
      if (first.kind !== 'lift') {
        a++;
        continue;
      }
      let e = a;
      while (e + 1 < steps.length) {
        const next = steps[e + 1];
        if (next.kind !== 'lift' || next.dz !== first.dz) break;
        e++;
      }
      const problem = this.rampProblem(steps, a, e);
      if (problem) {
        const from = belt.nodes[a];
        const to = belt.nodes[e + 1];
        this.emit(
          'BELT_BAD_RAMP',
          [beltNode(belt.id, a)],
          `belt ${belt.id}: the lift at node ${a} (z ${num(from.z)} to ${num(to.z)}) needs ${FLAT_STEPS_AROUND_LIFT} flat steps ` +
            `in one direction before and after it, but ${problem}`,
          MIRROR_PATH,
        );
      }
      a = e + 1;
    }
  }

  /** Why the lift run of steps `a..e` is not a valid ramp, or undefined if it is. */
  private rampProblem(steps: Step[], a: number, e: number): string | undefined {
    const n = FLAT_STEPS_AROUND_LIFT;
    if (a < n) return `only ${a} step${a === 1 ? '' : 's'} come before it`;
    const after = steps.length - 1 - e;
    if (after < n) return `only ${after} step${after === 1 ? '' : 's'} come after it`;
    const around = [...steps.slice(a - n, a), ...steps.slice(e + 1, e + 1 + n)];
    const dirs: [number, number][] = [];
    for (const step of around) {
      if (step.kind !== 'flat') return `the ${n} steps before or after it are not all flat`;
      dirs.push(step.dir);
    }
    if (dirs.some((d) => d[0] !== dirs[0][0] || d[1] !== dirs[0][1])) {
      return `the belt turns within ${n} steps of the lift (or at it)`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // 6. BELT_TOO_HIGH

  // mirrors: BuildTool_Path.CheckBuildConditions
  /** A node above `effects.beltMaxLevel` (12 levels base, +6 per Vertical Construction level). One violation per belt. */
  private beltHeights(): void {
    const max = this.effects.beltMaxLevel;
    for (const belt of this.layout.belts) {
      const first = belt.nodes.findIndex((p) => p.z > max + TOL);
      if (first < 0) continue;
      const top = Math.max(...belt.nodes.map((p) => p.z));
      this.emit(
        'BELT_TOO_HIGH',
        [beltNode(belt.id, first)],
        `belt ${belt.id} climbs to z ${num(top)}, above the limit of ${max} levels (first at node ${first})`,
        MIRROR_PATH,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // 7. BELT_PORT_MISMATCH

  // mirrors: BuildTool_Path.CheckBuildConditions
  /** Source and sink ports must exist, and the first/last node is the port's first lattice point outside, at z 0. */
  private beltPorts(): void {
    for (const belt of this.layout.belts) {
      const last = belt.nodes.length - 1;
      if (last < 0) continue;
      if (belt.source) this.checkPortEnd(belt, 'source', 0, belt.source.buildingId, belt.source.port);
      const sink = belt.sink;
      if (sink?.kind === 'port') this.checkPortEnd(belt, 'sink', last, sink.buildingId, sink.port);
      if (sink?.kind === 'belt') {
        const target = this.beltById.get(sink.beltId);
        const problem = !target
          ? `belt ${sink.beltId} is not in the layout`
          : sink.node < 0 || sink.node >= target.nodes.length || !Number.isInteger(sink.node)
            ? `belt ${sink.beltId} has no node ${sink.node} (${target.nodes.length} nodes)`
            : undefined;
        if (problem) {
          this.emit('BELT_PORT_MISMATCH', [beltNode(belt.id, last)], `belt ${belt.id} merges into a belt that does not exist: ${problem}`, MIRROR_PATH);
        } else {
          this.checkMerge(belt, last, target!, sink.node);
        }
      }
    }
  }

  /**
   * A belt that merges into another (`sink: belt`) ends on the target node or on a lattice point beside it at
   * the same height, and never joins the target belt at its first node (that would be a continuation, not a merge).
   */
  private checkMerge(belt: BeltPath, last: number, target: BeltPath, node: number): void {
    const m = belt.nodes[last];
    const t = target.nodes[node];
    const entities = [beltNode(belt.id, last), beltNode(target.id, node)];
    const who = `belt ${belt.id} merges into belt ${target.id} node ${node} at ${at(t)} z ${num(t.z)}`;
    const sameHeight = near(m.z, t.z);
    const onIt = sameHeight && near(m.x, t.x) && near(m.y, t.y);
    const beside =
      sameHeight &&
      ((near(Math.abs(m.x - t.x), 1) && near(m.y, t.y)) || (near(m.x, t.x) && near(Math.abs(m.y - t.y), 1)));
    if (!onIt && !beside) {
      this.emit(
        'BELT_PORT_MISMATCH',
        entities,
        `${who}, but its last node (node ${last}) at ${at(m)} z ${num(m.z)} is neither on that node nor one tile beside it at the same height`,
        MIRROR_PATH,
      );
    }
    if (node === 0) {
      this.emit(
        'BELT_PORT_MISMATCH',
        entities,
        `${who}, but node 0 is the first node of belt ${target.id}; a merge cannot join a belt at its head`,
        MIRROR_PATH,
      );
    }
  }

  private checkPortEnd(belt: BeltPath, role: 'source' | 'sink', node: number, buildingId: number, port: number): void {
    const fail = (why: string) =>
      this.emit(
        'BELT_PORT_MISMATCH',
        [beltNode(belt.id, node), building(buildingId)],
        `belt ${belt.id} ${role}: ${why}`,
        MIRROR_PATH,
      );
    const entry = this.entryById.get(buildingId);
    if (!entry) return fail(`building ${buildingId} is not in the layout`);
    const count = entry.bd.geometry.ports.length;
    if (!Number.isInteger(port) || port < 0 || port >= count) {
      return fail(`${label(entry)} has no port ${port} (it has ${count})`);
    }
    const info = this.poseInfos(entry, 'port')[port];
    if (typeof info === 'string') return fail(`port ${port} of ${label(entry)} cannot be used: ${info}`);
    const p = belt.nodes[node];
    const want = info.firstOutside;
    if (!near(p.x, want.x) || !near(p.y, want.y) || !near(p.z, 0)) {
      fail(`node ${node} is at ${at(p)} z ${num(p.z)}, but port ${port} of ${label(entry)} opens onto ${at(want)} at z 0`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // 8-13. Sorters

  private sorters(): void {
    const ctxs = this.layout.sorters.map((s) => this.resolveSorter(s));

    // 9. SORTER_SLOT_REUSED: one sorter per building slot.
    const users = new Map<string, { entry: BuildingEntry; slot: number; ids: number[] }>();
    for (const ctx of ctxs) {
      const keys = new Set<string>();
      for (const end of ctx.ends) {
        if (!end.building || end.slotIndex === undefined) continue;
        const key = `${end.building.b.id}:${end.slotIndex}`;
        if (keys.has(key)) continue;
        keys.add(key);
        const use = users.get(key);
        if (use) use.ids.push(ctx.s.id);
        else users.set(key, { entry: end.building, slot: end.slotIndex, ids: [ctx.s.id] });
      }
    }
    for (const { entry, slot, ids } of users.values()) {
      if (ids.length < 2) continue;
      this.emit(
        'SORTER_SLOT_REUSED',
        [...ids.map(sorter), building(entry.b.id)],
        `sorters ${ids.join(' and ')} all use slot ${slot} of ${label(entry)}; a slot takes one sorter`,
        MIRROR_INSERTER,
      );
    }

    for (const ctx of ctxs) {
      if (ctx.resolved) this.checkSorter(ctx);
    }
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /** Rules 9 (invalid slot) and 13 (station) and a missing belt end: what stops a sorter from being placed at all. */
  private resolveSorter(s: Sorter): SorterCtx {
    const ctx: SorterCtx = {
      s,
      ends: [{ name: 'pick' }, { name: 'drop' }],
      resolved: true,
      tangentReported: false,
    };
    for (const end of ctx.ends) {
      const endpoint = end.name === 'pick' ? s.pick : s.drop;
      const who = `sorter ${s.id}: ${end.name} end`;
      if (endpoint.kind === 'building') {
        const entry = this.entryById.get(endpoint.buildingId);
        if (!entry) {
          this.emit('SORTER_SLOT_INVALID', [sorter(s.id), building(endpoint.buildingId)], `${who} is on building ${endpoint.buildingId}, which is not in the layout`, MIRROR_INSERTER);
          ctx.resolved = false;
          continue;
        }
        end.building = entry;
        if (entry.b.stackParentId !== undefined && !entry.bd.geometry.multiLevelAllowInserter) {
          this.emit(
            'SORTER_SLOT_INVALID',
            [sorter(s.id), building(entry.b.id)],
            `${who} is on ${label(entry)}, which is stacked on building ${entry.b.stackParentId}: ${entry.bd.name}s take sorters on the bottom level of a stack only (multiLevelAllowInserter is false, MX §8)`,
            MIRROR_INSERTER,
          );
          ctx.resolved = false;
          continue;
        }
        if (entry.bd.kind === 'station' || entry.bd.station !== undefined) {
          this.emit(
            'SORTER_TO_STATION',
            [sorter(s.id), building(entry.b.id)],
            `${who} is on ${label(entry)}; sorters cannot connect to logistics stations, which have belt ports only (MX §3.3)`,
            MIRROR_INSERTER,
          );
          ctx.resolved = false;
          continue;
        }
        const count = entry.bd.geometry.slots.length;
        if (!Number.isInteger(endpoint.slot) || endpoint.slot < 0 || endpoint.slot >= count) {
          this.emit(
            'SORTER_SLOT_INVALID',
            [sorter(s.id), building(entry.b.id)],
            `${who} uses slot ${endpoint.slot} of ${label(entry)}, which has ${count} slots`,
            MIRROR_INSERTER,
          );
          ctx.resolved = false;
          continue;
        }
        end.slotIndex = endpoint.slot;
        const info = this.poseInfos(entry, 'slot')[endpoint.slot];
        if (typeof info === 'string') {
          this.emit(
            'SORTER_SLOT_INVALID',
            [sorter(s.id), building(entry.b.id)],
            `${who} uses slot ${endpoint.slot} of ${label(entry)}, which cannot be used: ${info}`,
            MIRROR_INSERTER,
          );
        } else {
          end.slot = info;
        }
      } else {
        const belt = this.beltById.get(endpoint.beltId);
        const problem = !belt
          ? `belt ${endpoint.beltId}, which is not in the layout`
          : !Number.isInteger(endpoint.node) || endpoint.node < 0 || endpoint.node >= belt.nodes.length
            ? `node ${endpoint.node} of belt ${endpoint.beltId}, which has ${belt.nodes.length} nodes`
            : undefined;
        if (problem) {
          this.emit('SORTER_SPAN', [sorter(s.id)], `${who} is on ${problem}`, MIRROR_INSERTER);
          ctx.resolved = false;
          continue;
        }
        end.belt = belt;
        end.node = endpoint.node;
      }
    }
    return ctx;
  }

  /** Rules 8, 10, 11, 12 and 12a for a sorter whose ends exist. */
  private checkSorter(ctx: SorterCtx): void {
    const { s } = ctx;
    const [pickEnd, dropEnd] = ctx.ends;

    // 12 and 12a on each belt end. The facing a belt tap must be perpendicular to is the building end's slot.
    for (const end of ctx.ends) {
      if (!end.belt) continue;
      const other = end === pickEnd ? dropEnd : pickEnd;
      this.checkBeltEnd(ctx, end, other.slot?.dir);
    }

    let pos: { pick: GridPoint; drop: GridPoint } | undefined;
    try {
      pos = sorterEnds(s, this.layout, this.data, this.index);
    } catch (err) {
      // A corner with no segment across the slot facing; the tangent rule has already said so.
      if (!ctx.tangentReported) {
        const cause = err instanceof Error ? err.message : String(err);
        this.emit('SORTER_SPAN', [sorter(s.id)], `sorter ${s.id}: its ends cannot be placed: ${cause}`, MIRROR_INSERTER);
      }
    }

    this.checkTap(ctx);
    if (!pos) return;
    this.sorterPoints.push({ s, x: (pos.pick.x + pos.drop.x) / 2, y: (pos.pick.y + pos.drop.y) / 2 });
    const inReach = this.checkReach(ctx, pos);
    this.checkSkew(ctx, pos);
    // Walking the lattice between ends that are out of reach could take forever on absurd coordinates.
    if (inReach) this.checkInBuilding(ctx, pos);
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /**
   * Rule 8, lattice part. Building to belt: the belt tap node is `sorterTapPoint(slot, span)`. Building to
   * building: the slots face each other and their first-outside points are `span - 1` apart along the facing.
   */
  private checkTap(ctx: SorterCtx): void {
    const { s } = ctx;
    if (s.span !== 1 && s.span !== 2 && s.span !== 3) {
      this.emit('SORTER_SPAN', [sorter(s.id)], `sorter ${s.id}: span ${String(s.span)} is not 1, 2 or 3`, MIRROR_INSERTER);
      return;
    }
    const buildings = ctx.ends.filter((e) => e.building);
    const belts = ctx.ends.filter((e) => e.belt);
    if (buildings.length === 1 && belts.length === 1) {
      const slotEnd = buildings[0];
      const beltEnd = belts[0];
      if (!slotEnd.slot) return;
      const tap = sorterTapPoint(slotEnd.slot, s.span);
      const p = beltEnd.belt!.nodes[beltEnd.node!];
      if (!near(p.x, tap.x) || !near(p.y, tap.y)) {
        this.emit(
          'SORTER_SPAN',
          [sorter(s.id), beltNode(beltEnd.belt!.id, beltEnd.node!)],
          `sorter ${s.id}: a span-${s.span} sorter on slot ${slotEnd.slotIndex} of ${label(slotEnd.building!)} taps a belt at ` +
            `${at(tap)}, but belt ${beltEnd.belt!.id} node ${beltEnd.node} is at ${at(p)}`,
          MIRROR_INSERTER,
        );
      }
    } else if (buildings.length === 2) {
      const [a, b] = buildings;
      if (!a.slot || !b.slot) return;
      const who = `sorter ${s.id}: slot ${a.slotIndex} of ${label(a.building!)} and slot ${b.slotIndex} of ${label(b.building!)}`;
      if (Math.abs(a.slot.dir[0] + b.slot.dir[0]) > TOL || Math.abs(a.slot.dir[1] + b.slot.dir[1]) > TOL) {
        this.emit('SORTER_SPAN', [sorter(s.id)], `${who} do not face each other`, MIRROR_INSERTER);
        return;
      }
      const along =
        (b.slot.firstOutside.x - a.slot.firstOutside.x) * a.slot.dir[0] +
        (b.slot.firstOutside.y - a.slot.firstOutside.y) * a.slot.dir[1];
      if (!near(along, s.span - 1)) {
        this.emit(
          'SORTER_SPAN',
          [sorter(s.id)],
          `${who} have first-outside points ${num(along)} tiles apart along the facing, but span ${s.span} needs ${s.span - 1}`,
          MIRROR_INSERTER,
        );
      }
    }
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /**
   * Rule 8, distance part: 1 m <= 3D distance between the ends <= `sorterMaxReachMeters` (`sorterReachProblem`, which
   * the solver's tap assignment asks too). Returns false when the ends are too far apart.
   */
  private checkReach(ctx: SorterCtx, pos: { pick: GridPoint; drop: GridPoint }): boolean {
    const { s } = ctx;
    const reach = this.data.data.constants.sorterMaxReachMeters;
    const problem = sorterReachProblem(pos.pick, pos.drop, reach);
    if (problem?.kind === 'too-far') {
      this.emit('SORTER_SPAN', [sorter(s.id)], `sorter ${s.id}: its ends are ${num(problem.meters)} m apart, farther than the ${num(reach)} m reach`, MIRROR_INSERTER);
    } else if (problem?.kind === 'too-close') {
      this.emit('SORTER_SPAN', [sorter(s.id)], `sorter ${s.id}: its ends are ${num(problem.meters)} m apart, closer than the ${MIN_SORTER_LENGTH_M} m minimum`, MIRROR_INSERTER);
    }
    return problem?.kind !== 'too-far';
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /**
   * Rule 10. The pick-to-drop direction must align with the facing of each building slot (or its reverse) within
   * 14 degrees (building to building) or 11 degrees (a belt end): `sorterSkewProblem`.
   */
  private checkSkew(ctx: SorterCtx, pos: { pick: GridPoint; drop: GridPoint }): void {
    const { s } = ctx;
    const slotEnds = ctx.ends.filter((e) => e.slot);
    if (slotEnds.length === 0) return;
    const problem = sorterSkewProblem(
      pos.pick,
      pos.drop,
      slotEnds.map((e) => e.slot!.dir),
      ctx.ends.some((e) => e.belt),
    );
    if (problem?.kind === 'no-direction') {
      this.emit(
        'SORTER_SKEW',
        [sorter(s.id)],
        `sorter ${s.id}: its ends are at one point in the plan (no horizontal direction), so it cannot face along a slot (limit ${problem.limitDeg} degrees)`,
        MIRROR_INSERTER,
      );
    } else if (problem?.kind === 'skew') {
      const worstEnd = slotEnds[problem.facing];
      this.emit(
        'SORTER_SKEW',
        [sorter(s.id)],
        `sorter ${s.id}: its direction is ${problem.degrees.toFixed(1)} degrees off the facing of slot ${worstEnd.slotIndex} of ` +
          `${label(worstEnd.building!)}; the limit is ${problem.limitDeg} degrees`,
        MIRROR_INSERTER,
      );
    }
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /**
   * Rule 11. The lattice points strictly between the ends (along the longer plan axis, on the row nearest the
   * line) must be free of buildings other than the sorter's own.
   */
  private checkInBuilding(ctx: SorterCtx, pos: { pick: GridPoint; drop: GridPoint }): void {
    const { s } = ctx;
    const own = new Set(ctx.ends.flatMap((e) => (e.building ? [e.building.b.id] : [])));
    const dx = pos.drop.x - pos.pick.x;
    const dy = pos.drop.y - pos.pick.y;
    const dz = pos.drop.z - pos.pick.z;
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const a0 = alongX ? pos.pick.x : pos.pick.y;
    const a1 = alongX ? pos.drop.x : pos.drop.y;
    if (Math.abs(a1 - a0) < TOL) return;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    const hits: BuildingEntry[] = [];
    const points: string[] = [];
    for (let v = Math.floor(lo + TOL) + 1, steps = 0; v < hi - TOL && steps < MAX_LATTICE_WALK; v++, steps++) {
      const t = (v - a0) / (a1 - a0);
      const lateral = Math.round(alongX ? pos.pick.y + t * dy : pos.pick.x + t * dx) + 0;
      const x = alongX ? v : lateral;
      const y = alongX ? lateral : v;
      const z = pos.pick.z + t * dz;
      this.boxGrid.query(x - TOL, y - TOL, x + TOL, y + TOL, (id) => {
        const box = this.boxes[id];
        if (own.has(box.entry.b.id) || !pointInOBBs(x, y, z, box.solo, 0)) return;
        if (!hits.includes(box.entry)) hits.push(box.entry);
        points.push(at({ x, y }));
      });
    }
    if (hits.length === 0) return;
    hits.sort((a, b) => a.index - b.index);
    this.emit(
      'SORTER_IN_BUILDING',
      [sorter(s.id), ...hits.map((h) => building(h.b.id))],
      `sorter ${s.id} passes through ${hits.map(label).join(' and ')}: lattice point ${points.join(', ')} between its ends is inside`,
      MIRROR_INSERTER,
    );
  }

  // mirrors: BuildTool_Inserter.CheckBuildConditions
  /**
   * Rules 12 and 12a for one belt end of a sorter. 12: the tap node is on the ground with no height change next
   * to it. 12a: the tap is mid-straight (a previous and a next node, collinear), with the belt across the slot
   * facing within 11 degrees; a corner is diagonal in game and breaks the facing rule.
   */
  private checkBeltEnd(ctx: SorterCtx, end: EndCtx, facing: [number, number] | undefined): void {
    const { s } = ctx;
    const belt = end.belt!;
    const n = end.node!;
    const p = belt.nodes[n];
    const prev = belt.nodes[n - 1];
    const next = belt.nodes[n + 1];
    const entities = [sorter(s.id), beltNode(belt.id, n)];

    if (!near(p.z, 0) || [prev, next].some((q) => q && !near(q.z, p.z))) {
      this.emit(
        'SORTER_ENDPOINT_BELT_RAMP',
        entities,
        `sorter ${s.id}: belt ${belt.id} node ${n} (z ${num(p.z)}) must be at z 0 with no height change at the nodes next to it`,
        MIRROR_INSERTER,
      );
    }

    const problem = this.tangentProblem(p, prev, next, facing);
    if (problem) {
      ctx.tangentReported = true;
      this.emit(
        'SORTER_BELT_TANGENT',
        entities,
        `sorter ${s.id}: belt ${belt.id} node ${n} is not a straight tap: ${problem}`,
        MIRROR_INSERTER,
      );
    }
  }

  private tangentProblem(
    p: GridPoint,
    prev: GridPoint | undefined,
    next: GridPoint | undefined,
    facing: [number, number] | undefined,
  ): string | undefined {
    if (!prev) return 'it is the first node of the belt, with no previous node';
    if (!next) return 'it is the last node of the belt, with no next node';
    const ux = p.x - prev.x;
    const uy = p.y - prev.y;
    const uz = p.z - prev.z;
    if (!near(ux, next.x - p.x) || !near(uy, next.y - p.y) || !near(uz, next.z - p.z)) {
      return 'the belt bends there, so the previous, this and the next node are not collinear';
    }
    if (!facing) return undefined;
    const len = Math.hypot(ux, uy);
    if (len < TOL) return 'the belt has no horizontal direction there';
    const along = Math.abs(ux * facing[0] + uy * facing[1]) / len;
    const off = (Math.asin(Math.min(1, along)) * 180) / Math.PI;
    if (off > SKEW_LIMIT_BELT_DEG + 1e-9) {
      return `the belt axis is ${off.toFixed(1)} degrees off perpendicular to the slot facing (limit ${SKEW_LIMIT_BELT_DEG})`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // 14-15. Power

  private powerNodes(): PowerNode[] {
    const nodes: PowerNode[] = [];
    for (const entry of this.entries) {
      const node = entry.bd.power.node;
      if (!node) continue;
      const p = prefabToGrid(entry.b, node.powerPoint);
      nodes.push({ entry, x: p.x, y: p.y, z: p.z, cover: node.coverRadius, connect: node.connectDistance });
    }
    return nodes;
  }

  private power(): void {
    const nodes = this.powerNodes();
    this.powerCover(nodes);
    this.powerLinks(nodes);
  }

  /**
   * Rule 14 (the supply side of PowerSystem.GameTick). Every consumer within `coverRadius` m (2D) of some node's power point: consumer buildings at their
   * centre, sorters at the midpoint of their ends.
   */
  private powerCover(nodes: PowerNode[]): void {
    const covering = nodes.filter((n) => n.cover > 0);
    const grid = new SpatialGrid(covering.length, CELL_TILES);
    covering.forEach((n, i) => {
      const r = n.cover / TILE;
      grid.add(i, n.x - r, n.y - r, n.x + r, n.y + r);
    });

    const covered = (x: number, y: number): boolean => {
      let ok = false;
      grid.query(x, y, x, y, (i) => {
        const n = covering[i];
        if (!ok && metres(n.x - x, n.y - y) <= n.cover + 1e-9) ok = true;
      });
      return ok;
    };
    const report = (entity: ViolationEntity, what: string, x: number, y: number): void => {
      let nearest: PowerNode | undefined;
      let best = Infinity;
      for (const n of covering) {
        const d = metres(n.x - x, n.y - y);
        if (d < best) {
          best = d;
          nearest = n;
        }
      }
      const detail = nearest
        ? `the nearest node, ${label(nearest.entry)}, is ${num(best)} m away and covers ${num(nearest.cover)} m`
        : 'the layout has no power node that covers an area';
      this.emit('POWER_UNCOVERED', [entity], `${what} at ${at({ x, y })} is not within the cover radius of any power node: ${detail}`, MIRROR_POWER);
    };

    for (const entry of this.entries) {
      const power = entry.bd.power;
      if (!power.consumer || power.node) continue;
      if (!covered(entry.b.x, entry.b.y)) report(building(entry.b.id), label(entry), entry.b.x, entry.b.y);
    }
    for (const { s, x, y } of this.sorterPoints) {
      if (!covered(x, y)) report(sorter(s.id), `sorter ${s.id}`, x, y);
    }
  }

  /**
   * Rule 15 (the linking side of PowerSystem.GameTick). Nodes form one connected graph; two nodes are linked when their power points are at most
   * `min(connectDistance_a, connectDistance_b)` metres apart (3D). The min rule is C3 in MX §6.1: unverified.
   */
  private powerLinks(nodes: PowerNode[]): void {
    if (nodes.length < 2) return;
    const parent = nodes.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const dist = (a: PowerNode, b: PowerNode): number => metres(a.x - b.x, a.y - b.y, a.z - b.z);

    const grid = new SpatialGrid(nodes.length, POWER_CELL_TILES);
    nodes.forEach((n, i) => grid.add(i, n.x, n.y, n.x, n.y));
    nodes.forEach((a, i) => {
      const r = a.connect / TILE;
      grid.query(a.x - r, a.y - r, a.x + r, a.y + r, (j) => {
        if (j > i && dist(a, nodes[j]) <= Math.min(a.connect, nodes[j].connect) + 1e-9) parent[find(i)] = find(j);
      });
    });

    const groups = new Map<number, number[]>();
    nodes.forEach((_, i) => {
      const root = find(i);
      const list = groups.get(root);
      if (list) list.push(i);
      else groups.set(root, [i]);
    });
    if (groups.size < 2) return;
    const all = [...groups.values()];
    const main = all.reduce((best, g) => (g.length > best.length ? g : best));
    for (const group of all) {
      if (group === main) continue;
      let link: { a: PowerNode; b: PowerNode; d: number } | undefined;
      for (const i of group) {
        for (const j of main) {
          const d = dist(nodes[i], nodes[j]);
          if (!link || d < link.d) link = { a: nodes[i], b: nodes[j], d };
        }
      }
      const entries = group.map((i) => nodes[i].entry);
      const need = Math.min(link!.a.connect, link!.b.connect);
      this.emit(
        'POWER_DISCONNECTED',
        entries.map((e) => building(e.b.id)),
        `${entries.map(label).join(' and ')} ${entries.length === 1 ? 'is' : 'are'} not connected to the main power network: ` +
          `the nearest link, to ${label(link!.b.entry)}, is ${num(link!.d)} m, but a link needs at most ` +
          `min(connectDistance_a, connectDistance_b) = ${num(need)} m (MX §6.1, C3: unverified)`,
        MIRROR_POWER,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // 16. STATION_SLOTS

  /** More slot configs than `maxItemKinds`, or a port that outputs a storage slot beyond the configured ones. */
  private stationSlots(): void {
    for (const entry of this.entries) {
      const cfg = entry.b.station;
      if (!cfg) continue;
      const max = entry.bd.station?.maxItemKinds;
      if (max !== undefined && cfg.slots.length > max) {
        this.emit(
          'STATION_SLOTS',
          [building(entry.b.id)],
          `${label(entry)} is configured with ${cfg.slots.length} item slots, but holds at most ${max} item kinds`,
        );
      }
      cfg.ports.forEach((port, i) => {
        if (port.storageIdx > cfg.slots.length) {
          this.emit(
            'STATION_SLOTS',
            [building(entry.b.id)],
            `${label(entry)} port ${i} outputs storageIdx ${port.storageIdx}, but only ${cfg.slots.length} slots are configured`,
          );
        }
      });
    }
  }
}

/**
 * Check a layout against the geometry and connection rules (Task 15). Returns every violation found, grouped by
 * rule in a fixed order; an empty array means the layout passes. Throws only for a malformed layout: a duplicate
 * building or belt id, or a building whose item is not in GameData.
 */
export function checkGeometry(layout: Layout, data: GameDataIndex, effects: TechEffects): Violation[] {
  return new GeometryChecker(layout, data, effects).run();
}
