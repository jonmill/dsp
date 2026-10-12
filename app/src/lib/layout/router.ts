// Belt routing: negotiated-congestion A* over (x, y, z) with vertical lifts (Task 22).
//
// The grid. Belt nodes sit on the lattice points of a window (`RouteParams.bounds`) at heights 0..maxLevel. A cell is
// free unless `Occupancy.blockedForBelt` says a building is there, or, at z 0, it is a tap point or a station port
// point (another net's, or this net's own, which it only enters as a waypoint). A net never uses a cell twice.
//
// Stops. A net visits, in order: its source port (if it has one), the runs of tap points of its producers, then those
// of its consumers, and its sink port (if it has one). Producers always come before consumers, whatever it costs: a
// consumer upstream of a producer is never fed by it. A run is a set of taps of the net on one row at most two nodes
// apart, which one straight pass serves (a run with producers and consumers is passed producers first). The
// producers are ordered by nearest neighbour from the source (or, for a belt that starts at its first tap, from the
// producer farthest from where the belt ends), the consumers likewise from the last producer, except the split
// consumers (below). Each stop is a goal that a leg of A* ends at:
//  - a tap run is entered along its axis by a flat step into its first tap, run through, and left by one more
//    straight node, so every tap has a node before and after it on the same line at z 0 (SORTER_BELT_TANGENT, and no
//    height change beside it). Either direction along the axis may be taken unless a run needs producers first. A
//    belt that starts at its first tap begins one node before it; a belt that ends at its last tap ends one node
//    after it;
//  - a source port is the first node, stepping straight out of the port; a sink port is the last node, reached by a
//    step straight into it. The node the sink port is entered through is kept for the last leg (the tap run before it
//    may end on it, which makes a straight line into the port), so no earlier leg walls the port in.
// Each leg starts where the one before ended, with the same heading and straight count, so there is no U-turn at a
// waypoint.
//
// Moves. A state is (x, y, z, heading, phase). The phase counts flat steps in the same heading since the last turn
// or lift (0, 1, 2 for "two or more"), with three states for a lift: 3 and 4 right after a lift up or down (a longer
// lift run may go on), 5 after one flat step past a lift (two are needed). Moves: a flat step ahead; a turn left or
// right (at z 0 always, higher up only at phase 2); a vertical lift of one level (only at phase 2 or inside a lift
// run, never past maxLevel or below 0). So a lift always has two flat steps in one heading before it and two after
// it (BELT_BAD_RAMP), a belt may not end within two nodes of one, and a turn never comes right after a lift. Moves
// that would end a belt in a state the validator rejects (a lift not yet followed by two flat steps) are not goals.
//
// Split consumers. A consumer machine that takes one item from two nets (the netlist cuts a consumer that straddles a
// cut of the rate axis) cannot be made to take its planned share from each: its two sorters fill one input buffer, and
// whichever finds items first takes more. Upstream on a belt it takes everything it needs from that belt, starves the
// consumers behind it, and leaves the other belt backed up so that its producers block; with no slack in the plan (every
// machine of a stage at full rate) the lost items are not made up, and the target fell to 0.95 of its rate (Planetary
// Shield Generator, 11 split consumers). A machine at the very end of a dead-end belt can only take what reaches it,
// the planned share, so the split consumers go last, after the other consumers, and among themselves in machine id order,
// which is the order of the rate axis the netlist cut (the straddler of a cut comes before the straddler of the next).
// Planetary Shield Generator then reaches its rate (1.000, where nearest-neighbour order gave 0.947).
//
// Cost and negotiation. A cell costs 1 + 0.5 z + presentFactor * (other nets on it) + history. Every net is routed
// once, in order of tap count; then the nets that share a cell, and those still without a route, are ripped up and
// routed again (the others keep their routes), the history of each shared cell grows by `historyFactor` times the
// present factor, the present factor grows, and so on until no cell is shared and every net has a route, or
// maxIterations is reached (or a round changes nothing). A net whose new route fails keeps its old one. Scaling the
// history with the present factor keeps a cell that stays shared from being cheaper to hold than a detour across two
// cells others hold, which left the last conflicts of large layouts unresolved. When the same nets are in conflict for
// `STUCK_ROUNDS` rounds in a row, every other round routes them in the opposite order (the net routed first takes the
// cell the others need, round after round; Planetary Logistics Station at margin 3 stalled on 3 cells for 30 rounds
// once its split consumers were routed last). The result is the round with the
// fewest nets without a route and, among those, the fewest shared cells. The forced nodes of a stop (the node before
// and after a tap, the step out of a port) count as the net's cells like any other, so the other nets are steered
// off them.
import type { GridPoint } from '../geometry';
import { MinHeap } from './heap';
import type { Netlist } from './netlist';
import type { Occupancy } from './occupancy';
import type { AssignedStationPort, AssignedTap, TapAssignment } from './taps';

export interface RouteParams {
  maxIterations: number;
  presentFactorStart: number;
  presentFactorGrowth: number;
  historyFactor: number;
  allowElevation: boolean;
  maxLevel: number;
  /** The search window in tiles; every tap point and port point has to lie inside it (placement bounds + 6). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
export interface RoutedNet {
  netId: number;
  /** In flow order: the first node is the belt start. Empty for a net that could not be routed. */
  nodes: GridPoint[];
}
export type RouteResult =
  | { ok: true; routes: RoutedNet[] }
  | { ok: false; conflicts: number; routes: RoutedNet[]; unroutable: number[] };

/** Tiles of free search space around the placement. */
export const ROUTE_WINDOW_MARGIN = 6;

/** Defaults for a placement: the window is the bounds of `occ` plus `ROUTE_WINDOW_MARGIN`. */
export function defaultRouteParams(occ: Occupancy, over: Partial<RouteParams> = {}): RouteParams {
  const b = occ.bounds();
  return {
    maxIterations: 40,
    presentFactorStart: 0.5,
    presentFactorGrowth: 1.5,
    historyFactor: 1,
    allowElevation: true,
    maxLevel: 2,
    bounds: {
      minX: b.minX - ROUTE_WINDOW_MARGIN,
      minY: b.minY - ROUTE_WINDOW_MARGIN,
      maxX: b.maxX + ROUTE_WINDOW_MARGIN,
      maxY: b.maxY + ROUTE_WINDOW_MARGIN,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Constants

/** Headings: 0 east, 1 north, 2 west, 3 south (a left turn is +1). */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** The phase after a flat step ahead, by phase. */
const AHEAD = [1, 2, 2, 5, 5, 2];
const PHASES = 6;
const STATES_PER_CELL = 4 * PHASES;
const PHASE_LIFTED_UP = 3;
const PHASE_LIFTED_DOWN = 4;
/** A belt may end in these phases. */
const END_PHASES = (1 << 1) | (1 << 2);
const ANY_PHASE = (1 << PHASES) - 1;
const ELEVATION_COST = 0.5;
/** Added to the heuristic's weight in the heap key, so states nearer a goal win ties between equal f. */
const TIE_BREAK = 1e-6;
/** Searches check `shouldStop` every this many expansions. */
const STOP_CHECK_MASK = 4095;
/** Rounds with the same nets in conflict after which every other such round routes them in the opposite order. */
const STUCK_ROUNDS = 3;
/** The present factor stops growing here: past it every shared cell is as good as forbidden. */
const MAX_PRESENT_FACTOR = 1e4;
/** A leg whose best path crosses itself is searched again with the repeated cells closed, at most this often. */
const SELF_CROSS_RETRIES = 3;

const headingOf = (dx: number, dy: number): number => (dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3);
const manhattan = (ax: number, ay: number, bx: number, by: number): number => Math.abs(ax - bx) + Math.abs(ay - by);

// ---------------------------------------------------------------------------------------------
// Stops

interface Cell {
  x: number;
  y: number;
}
/**
 * Taps of one net on one row at most two nodes apart, in ascending order along `axis`, with the node between two taps
 * two apart: one straight pass serves them all.
 */
interface RunStop {
  kind: 'run';
  axis: 'x' | 'y';
  cells: Cell[];
  /** Per cell: the tap's direction, or null for a node between two taps. */
  kinds: (TapDir | null)[];
  center: Cell;
  /** The directions along the axis (+1 ascending, -1 descending) the belt may pass the run in. */
  signs: (1 | -1)[];
  /** The lowest machine id among the run's taps of split consumers (see `stopsOf`), if it has one. */
  splitId?: number;
}
interface PortStop {
  kind: 'start' | 'end';
  x: number;
  y: number;
  /** Heading index of the port facing. */
  facing: number;
}
type Stop = RunStop | PortStop;
type TapDir = AssignedTap['dir'];

/** No consumer before a producer in `kinds`, in the order they are passed. */
const producersFirst = (kinds: (TapDir | null)[]): boolean => {
  let seenIn = false;
  for (const k of kinds) {
    if (k === 'in') seenIn = true;
    else if (k === 'out' && seenIn) return false;
  }
  return true;
};
/** The first tap in `kinds` is a producer. */
const startsWithProducer = (kinds: (TapDir | null)[]): boolean => kinds.find((k) => k !== null) !== 'in';

/**
 * Along which directions a belt may pass a run so that consumers are fed: with producers and consumers in one run,
 * the producers have to come first. If the run cannot be passed that way (a consumer between two producers), at least
 * the first tap must be a producer; if even that cannot be, both directions are allowed (nothing better exists).
 */
function signsOf(kinds: (TapDir | null)[]): (1 | -1)[] {
  const reversed = [...kinds].reverse();
  for (const ok of [producersFirst, startsWithProducer]) {
    const signs: (1 | -1)[] = [];
    if (ok(kinds)) signs.push(1);
    if (ok(reversed)) signs.push(-1);
    if (signs.length > 0) return signs;
  }
  return [1, -1];
}

/** A tap cell: where taps of a net sit, and the lowest machine id of the split consumers (if any) tapping it. */
interface TapCell {
  x: number;
  y: number;
  axis: 'x' | 'y';
  dir: TapDir;
  splitId?: number;
}

const lowest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** The runs of a set of tap cells: cells on one row and axis, at most two apart. */
function runsOf(cells: Map<number, TapCell>): RunStop[] {
  const list = [...cells.values()];
  list.sort((a, b) => {
    if (a.axis !== b.axis) return a.axis < b.axis ? -1 : 1;
    const fa = a.axis === 'x' ? a.y : a.x;
    const fb = b.axis === 'x' ? b.y : b.x;
    if (fa !== fb) return fa - fb;
    return (a.axis === 'x' ? a.x : a.y) - (b.axis === 'x' ? b.x : b.y);
  });
  const runs: RunStop[] = [];
  let cur: RunStop | undefined;
  for (const c of list) {
    const last = cur?.cells[cur.cells.length - 1];
    const gap =
      cur !== undefined && last !== undefined && cur.axis === c.axis
        ? c.axis === 'x'
          ? c.y === last.y
            ? c.x - last.x
            : Infinity
          : c.x === last.x
            ? c.y - last.y
            : Infinity
        : Infinity;
    if (cur && last && gap <= 2) {
      if (gap === 2) {
        cur.cells.push({ x: c.axis === 'x' ? last.x + 1 : last.x, y: c.axis === 'y' ? last.y + 1 : last.y });
        cur.kinds.push(null);
      }
      cur.cells.push({ x: c.x, y: c.y });
      cur.kinds.push(c.dir);
      cur.splitId = lowest(cur.splitId, c.splitId);
    } else {
      cur = {
        kind: 'run',
        axis: c.axis,
        cells: [{ x: c.x, y: c.y }],
        kinds: [c.dir],
        center: { x: c.x, y: c.y },
        signs: [1, -1],
        splitId: c.splitId,
      };
      runs.push(cur);
    }
  }
  for (const r of runs) {
    const a = r.cells[0];
    const b = r.cells[r.cells.length - 1];
    r.center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    r.signs = signsOf(r.kinds);
  }
  return runs;
}

/** Orders `pool` by nearest neighbour from `from` (ties: the earlier in the pool). */
function nearestFirst(pool: RunStop[], from: Cell): RunStop[] {
  const left = [...pool];
  const out: RunStop[] = [];
  let at = from;
  while (left.length > 0) {
    let best = 0;
    let bestD = Infinity;
    left.forEach((r, i) => {
      const d = manhattan(r.center.x, r.center.y, at.x, at.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    out.push(next);
    at = next.center;
  }
  return out;
}

/**
 * The stops of a net in visiting order, or undefined when it has nothing to connect. Producers always come before
 * consumers, whatever it costs: the belt carries the producers' items downstream only. So: the source port, the
 * runs of producers, the runs with both (their producers first, see `signsOf`), the runs of consumers, the runs of
 * split consumers (`isSplit`: the machine also consumes this item on another net; see the file comment), the sink port;
 * each group by nearest neighbour from the one before, but the split consumers by machine id.
 */
function stopsOf(
  hasSource: boolean,
  hasSink: boolean,
  taps: AssignedTap[],
  ports: AssignedStationPort[],
  isSplit: (t: AssignedTap) => boolean = () => false,
): Stop[] | undefined {
  const source = ports.find((p) => p.end === 'source');
  const sink = ports.find((p) => p.end === 'sink');
  if ((hasSource && !source) || (hasSink && !sink)) return undefined;

  // one map of tap cells, so taps side by side join into one run whoever produces or consumes; a cell with a producer
  // on it is a producer cell
  const cellsByKey = new Map<number, TapCell>();
  const key = (x: number, y: number) => x * 1_000_003 + y;
  for (const t of taps) {
    const k = key(t.point.x, t.point.y);
    const known = cellsByKey.get(k);
    const splitId = t.dir === 'in' && isSplit(t) ? lowest(known?.splitId, t.machineId) : known?.splitId;
    cellsByKey.set(k, { ...t.point, axis: t.axis, dir: t.dir === 'out' || known?.dir === 'out' ? 'out' : 'in', splitId });
  }
  const allRuns = runsOf(cellsByKey);
  if (!source && allRuns.length === 0) return undefined;
  const has = (r: RunStop, d: TapDir): boolean => r.kinds.includes(d);
  const consumerRuns = allRuns.filter((r) => !has(r, 'out'));
  const groups: { runs: RunStop[]; byId?: boolean }[] = [
    { runs: allRuns.filter((r) => !has(r, 'in')) },
    { runs: allRuns.filter((r) => has(r, 'in') && has(r, 'out')) },
    { runs: consumerRuns.filter((r) => r.splitId === undefined) },
    { runs: consumerRuns.filter((r) => r.splitId !== undefined).sort((a, b) => (a.splitId as number) - (b.splitId as number)), byId: true },
  ];

  const stops: Stop[] = [];
  let from: Cell | undefined;
  if (source) {
    stops.push({ kind: 'start', x: source.point.x, y: source.point.y, facing: headingOf(source.dir[0], source.dir[1]) });
    from = source.point;
  }
  for (const { runs: group, byId } of groups) {
    let pool = group;
    if (pool.length === 0) continue;
    if (!from && byId) {
      stops.push(pool[0]);
      from = pool[0].center;
      pool = pool.slice(1);
    } else if (!from) {
      // the belt starts here: at the run farthest from where the belt goes on
      const anchor: Cell = sink
        ? sink.point
        : {
            x: allRuns.reduce((s, r) => s + r.center.x, 0) / allRuns.length,
            y: allRuns.reduce((s, r) => s + r.center.y, 0) / allRuns.length,
          };
      let first = 0;
      let far = -1;
      pool.forEach((r, i) => {
        const d = manhattan(r.center.x, r.center.y, anchor.x, anchor.y);
        if (d > far) {
          far = d;
          first = i;
        }
      });
      const head = pool[first];
      pool = pool.filter((_, i) => i !== first);
      stops.push(head);
      from = head.center;
    }
    const ordered = byId ? pool : nearestFirst(pool, from);
    stops.push(...ordered);
    if (ordered.length > 0) from = ordered[ordered.length - 1].center;
  }
  if (sink) stops.push({ kind: 'end', x: sink.point.x, y: sink.point.y, facing: headingOf(sink.dir[0], sink.dir[1]) });
  return stops.length > 0 ? stops : undefined;
}

// ---------------------------------------------------------------------------------------------
// The router

interface Start {
  x: number;
  y: number;
  z: number;
  dir: number;
  phase: number;
  /** Cost already spent on the nodes before it. */
  g0: number;
  /** The nodes of the path before and including the start cell. */
  prefix: GridPoint[];
}
interface Goal {
  /** The first cell of the stop, entered by a flat step. */
  ex: number;
  ey: number;
  dir: number;
  /** Bit p set: the phase p is acceptable on arrival. */
  phases: number;
  /** The nodes after the entry cell, with the entry cell first. */
  tail: GridPoint[];
  tailCost: number;
}
interface Found {
  start: Start;
  /** Cells from the start to the cell before the goal, both included. */
  path: GridPoint[];
  goal: Goal;
  /** The phase on entering the goal cell. */
  phase: number;
  /** Cost of the whole belt so far: the start's `g0`, the leg's cells and the goal tail. */
  cost: number;
}

class Aborted extends Error {}

class Router {
  private readonly W: number;
  private readonly H: number;
  private readonly Lz: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly maxX: number;
  private readonly maxY: number;
  private readonly maxLevel: number;
  private readonly cells: number;

  private readonly blockedCache: Int8Array;
  /** Net id owning a tap or port point at z 0 (0: none). */
  private readonly reserved: Int32Array;
  private readonly use: Uint16Array;
  private readonly history: Float32Array;
  private readonly own: Int32Array;
  private readonly legBlock: Int32Array;
  // stamps start at 1: the arrays they are compared with start at 0
  private ownStamp = 1;
  private legStamp = 1;

  private G: Float64Array | undefined;
  private parent: Int32Array | undefined;
  private seen: Int32Array | undefined;
  private closed: Int32Array | undefined;
  private stamp = 0;
  private readonly heap = new MinHeap(4096);

  private presentFactor: number;
  /** The node before a sink port's first node (cell index), or -1: only the last leg may use it. */
  private approach = -1;

  // the search under way
  private goals: Goal[] = [];
  private bestTerm = Infinity;
  private bestParent = -1;
  private bestGoal: Goal | undefined;
  private bestPhase = 0;
  private expansions = 0;

  constructor(
    private readonly net: Netlist,
    private readonly taps: TapAssignment,
    private readonly occ: Occupancy,
    private readonly p: RouteParams,
    private readonly shouldStop: () => boolean,
  ) {
    this.minX = Math.ceil(p.bounds.minX);
    this.minY = Math.ceil(p.bounds.minY);
    this.maxX = Math.floor(p.bounds.maxX);
    this.maxY = Math.floor(p.bounds.maxY);
    this.W = Math.max(0, this.maxX - this.minX + 1);
    this.H = Math.max(0, this.maxY - this.minY + 1);
    this.maxLevel = p.allowElevation ? Math.max(0, Math.floor(p.maxLevel)) : 0;
    this.Lz = this.maxLevel + 1;
    this.cells = this.W * this.H * this.Lz;
    this.blockedCache = new Int8Array(this.cells);
    this.reserved = new Int32Array(this.W * this.H);
    this.use = new Uint16Array(this.cells);
    this.history = new Float32Array(this.cells);
    this.own = new Int32Array(this.cells);
    this.legBlock = new Int32Array(this.cells);
    this.presentFactor = p.presentFactorStart;
  }

  // -------------------------------------------------------------------------------------------
  // Cells

  private inWindow(x: number, y: number): boolean {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }
  private cellOf(x: number, y: number, z: number): number {
    return (z * this.H + (y - this.minY)) * this.W + (x - this.minX);
  }
  private flatOf(x: number, y: number): number {
    return (y - this.minY) * this.W + (x - this.minX);
  }
  private blocked(x: number, y: number, z: number, cell: number): boolean {
    let v = this.blockedCache[cell];
    if (v === 0) {
      v = this.occ.blockedForBelt(x, y, z) ? 2 : 1;
      this.blockedCache[cell] = v;
    }
    return v === 2;
  }
  /** Can a belt of the net being routed pass through the cell? Tap and port points are for waypoints only. */
  private usable(x: number, y: number, z: number, cell: number): boolean {
    if (this.own[cell] === this.ownStamp) return false;
    if (this.legBlock[cell] === this.legStamp) return false;
    if (z === 0 && this.reserved[this.flatOf(x, y)] !== 0) return false;
    return !this.blocked(x, y, z, cell);
  }
  private plain(x: number, y: number): boolean {
    return this.inWindow(x, y) && this.usable(x, y, 0, this.cellOf(x, y, 0));
  }
  /**
   * The node after a tap run. The last run before a sink port may end on the node the port is entered through (the
   * belt then goes straight on into the port); no other stretch may use that node.
   */
  private postPlain(x: number, y: number, nextIsEnd: boolean): boolean {
    if (!nextIsEnd || this.approach < 0 || !this.inWindow(x, y) || this.cellOf(x, y, 0) !== this.approach) return this.plain(x, y);
    const cell = this.approach;
    return this.own[cell] !== this.ownStamp && this.reserved[this.flatOf(x, y)] === 0 && !this.blocked(x, y, 0, cell);
  }
  private cost(cell: number, z: number): number {
    return 1 + ELEVATION_COST * z + this.presentFactor * this.use[cell] + this.history[cell];
  }
  private nodeCost(n: GridPoint): number {
    return this.cost(this.cellOf(n.x, n.y, n.z), n.z);
  }

  private markOwn(nodes: GridPoint[], from: number): void {
    for (let i = from; i < nodes.length; i++) this.own[this.cellOf(nodes[i].x, nodes[i].y, nodes[i].z)] = this.ownStamp;
  }

  // -------------------------------------------------------------------------------------------
  // A*

  private ensureSearchArrays(): void {
    if (this.G) return;
    const n = this.cells * STATES_PER_CELL;
    this.G = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.closed = new Int32Array(n);
  }

  private heuristic(x: number, y: number): number {
    let m = Infinity;
    const goals = this.goals;
    for (let i = 0; i < goals.length; i++) {
      const d = Math.abs(x - goals[i].ex) + Math.abs(y - goals[i].ey);
      if (d < m) m = d;
    }
    return m;
  }

  private relax(from: number, gFrom: number, nx: number, ny: number, nz: number, nd: number, np: number, flat: boolean): void {
    if (nx < this.minX || nx > this.maxX || ny < this.minY || ny > this.maxY) return;
    const cell = this.cellOf(nx, ny, nz);
    const g = gFrom + this.cost(cell, nz);
    if (flat && nz === 0) {
      const goals = this.goals;
      for (let i = 0; i < goals.length; i++) {
        const goal = goals[i];
        if (goal.ex !== nx || goal.ey !== ny || goal.dir !== nd || ((goal.phases >> np) & 1) === 0) continue;
        const total = g + goal.tailCost;
        if (total < this.bestTerm) {
          this.bestTerm = total;
          this.bestParent = from;
          this.bestGoal = goal;
          this.bestPhase = np;
        }
      }
    }
    if (!this.usable(nx, ny, nz, cell)) return;
    const s = cell * STATES_PER_CELL + nd * PHASES + np;
    const seen = this.seen as Int32Array;
    const G = this.G as Float64Array;
    if ((this.closed as Int32Array)[s] === this.stamp) return;
    if (seen[s] === this.stamp && G[s] <= g) return;
    G[s] = g;
    seen[s] = this.stamp;
    (this.parent as Int32Array)[s] = from;
    this.heap.push(g + this.heuristic(nx, ny) * (1 + TIE_BREAK), s);
  }

  /**
   * One A* from any of `starts` to any of `goals`. Throws `Aborted` when `shouldStop` says so. Returns undefined when
   * no goal can be reached.
   */
  private search(starts: Start[], goals: Goal[]): Found | undefined {
    this.ensureSearchArrays();
    this.goals = goals;
    this.bestTerm = Infinity;
    this.bestParent = -1;
    this.bestGoal = undefined;
    this.stamp++;
    const stamp = this.stamp;
    const heap = this.heap;
    heap.clear();
    const G = this.G as Float64Array;
    const parent = this.parent as Int32Array;
    const seen = this.seen as Int32Array;
    const closed = this.closed as Int32Array;
    const startOf = new Map<number, Start>();
    for (const st of starts) {
      const s = this.cellOf(st.x, st.y, st.z) * STATES_PER_CELL + st.dir * PHASES + st.phase;
      if (seen[s] === stamp && G[s] <= st.g0) continue;
      G[s] = st.g0;
      parent[s] = -1;
      seen[s] = stamp;
      startOf.set(s, st);
      heap.push(st.g0 + this.heuristic(st.x, st.y), s);
    }
    const area = this.W * this.H;

    while (heap.size > 0) {
      if (heap.peekKey() > this.bestTerm) break;
      const s = heap.pop();
      if (closed[s] === stamp) continue;
      closed[s] = stamp;
      if ((++this.expansions & STOP_CHECK_MASK) === 0 && this.shouldStop()) throw new Aborted();
      const cell = (s / STATES_PER_CELL) | 0;
      const within = s - cell * STATES_PER_CELL;
      const d = (within / PHASES) | 0;
      const ph = within - d * PHASES;
      const z = (cell / area) | 0;
      const rest = cell - z * area;
      const y = ((rest / this.W) | 0) + this.minY;
      const x = (rest % this.W) + this.minX;
      const g = G[s];

      // straight on
      this.relax(s, g, x + DX[d], y + DY[d], z, d, AHEAD[ph], true);
      // turns
      if (ph <= 2 && (z === 0 || ph === 2)) {
        const left = (d + 1) & 3;
        const right = (d + 3) & 3;
        this.relax(s, g, x + DX[left], y + DY[left], z, left, 1, true);
        this.relax(s, g, x + DX[right], y + DY[right], z, right, 1, true);
      }
      // vertical lifts
      if (this.maxLevel > 0) {
        if ((ph === 2 || ph === PHASE_LIFTED_UP) && z < this.maxLevel) this.relax(s, g, x, y, z + 1, d, PHASE_LIFTED_UP, false);
        if ((ph === 2 || ph === PHASE_LIFTED_DOWN) && z > 0) this.relax(s, g, x, y, z - 1, d, PHASE_LIFTED_DOWN, false);
      }
    }
    if (!this.bestGoal) return undefined;

    const states: number[] = [];
    for (let s = this.bestParent; s !== -1; s = parent[s]) states.push(s);
    states.reverse();
    const path: GridPoint[] = states.map((s) => {
      const cell = (s / STATES_PER_CELL) | 0;
      const z = (cell / area) | 0;
      const rest = cell - z * area;
      return { x: (rest % this.W) + this.minX, y: ((rest / this.W) | 0) + this.minY, z };
    });
    return { start: startOf.get(states[0]) as Start, path, goal: this.bestGoal, phase: this.bestPhase, cost: this.bestTerm };
  }

  /**
   * A* for one leg (`newLeg` was called before its goals were made), searched again with the repeated cells closed in
   * the rare case the best path crosses itself.
   */
  private leg(starts: Start[], goals: Goal[]): Found | undefined {
    for (let attempt = 0; attempt <= SELF_CROSS_RETRIES; attempt++) {
      const found = this.search(starts, goals);
      if (!found) return undefined;
      const seen = new Set<number>();
      const repeated: number[] = [];
      for (const n of [...found.path, ...found.goal.tail]) {
        const c = this.cellOf(n.x, n.y, n.z);
        if (seen.has(c)) repeated.push(c);
        seen.add(c);
      }
      if (repeated.length === 0) return found;
      for (const c of repeated) this.legBlock[c] = this.legStamp;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // One net

  /**
   * Starts a leg: forgets the cells the previous leg closed because its best path crossed itself, and, unless this is
   * the last leg, closes the node the sink port is entered through, which only the last leg may use.
   */
  private newLeg(last: boolean): void {
    this.legStamp++;
    if (!last && this.approach >= 0) this.legBlock[this.approach] = this.legStamp;
  }

  /** The goals for entering `stop` (both directions along the axis for a run), with the tails priced and checked. */
  private goalsOf(stop: RunStop | PortStop, from: Start, nextIsEnd: boolean): Goal[] {
    const goals: Goal[] = [];
    if (stop.kind === 'run') {
      for (const sign of stop.signs) {
        const dir = stop.axis === 'x' ? (sign > 0 ? 0 : 2) : sign > 0 ? 1 : 3;
        const cells = sign > 0 ? stop.cells : [...stop.cells].reverse();
        const last = cells[cells.length - 1];
        const post = { x: last.x + DX[dir], y: last.y + DY[dir] };
        if (!this.postPlain(post.x, post.y, nextIsEnd)) continue;
        const tail: GridPoint[] = [...cells.map((c) => ({ x: c.x, y: c.y, z: 0 })), { x: post.x, y: post.y, z: 0 }];
        if (!tail.every((n) => this.inWindow(n.x, n.y))) continue;
        if (!cells.every((c) => !this.blocked(c.x, c.y, 0, this.cellOf(c.x, c.y, 0)) && this.own[this.cellOf(c.x, c.y, 0)] !== this.ownStamp)) continue;
        goals.push({ ex: cells[0].x, ey: cells[0].y, dir, phases: ANY_PHASE & ~((1 << PHASE_LIFTED_UP) | (1 << PHASE_LIFTED_DOWN)), tail, tailCost: tail.slice(1).reduce((s, n) => s + this.nodeCost(n), 0) });
      }
    } else {
      const dir = (stop.facing + 2) & 3;
      const ax = stop.x + DX[stop.facing];
      const ay = stop.y + DY[stop.facing];
      if (this.inWindow(stop.x, stop.y) && !this.blocked(stop.x, stop.y, 0, this.cellOf(stop.x, stop.y, 0)) && (this.plain(ax, ay) || (ax === from.x && ay === from.y && from.z === 0))) {
        const node = { x: stop.x, y: stop.y, z: 0 };
        goals.push({ ex: stop.x, ey: stop.y, dir, phases: END_PHASES, tail: [node], tailCost: 0 });
      }
    }
    return goals;
  }

  /** The starting states of a belt that begins with `stop`: the port and its first step, or a run entered from one node before. */
  private startsOf(stop: Stop, nextIsEnd: boolean): Start[] {
    const starts: Start[] = [];
    if (stop.kind === 'start') {
      const { x, y } = stop;
      const nx = x + DX[stop.facing];
      const ny = y + DY[stop.facing];
      if (!this.inWindow(x, y) || this.blocked(x, y, 0, this.cellOf(x, y, 0)) || !this.plain(nx, ny)) return starts;
      const prefix = [
        { x, y, z: 0 },
        { x: nx, y: ny, z: 0 },
      ];
      starts.push({ x: nx, y: ny, z: 0, dir: stop.facing, phase: 1, g0: prefix.reduce((s, n) => s + this.nodeCost(n), 0), prefix });
    } else if (stop.kind === 'run') {
      for (const sign of stop.signs) {
        const dir = stop.axis === 'x' ? (sign > 0 ? 0 : 2) : sign > 0 ? 1 : 3;
        const cells = sign > 0 ? stop.cells : [...stop.cells].reverse();
        const last = cells[cells.length - 1];
        const pre = { x: cells[0].x - DX[dir], y: cells[0].y - DY[dir] };
        const post = { x: last.x + DX[dir], y: last.y + DY[dir] };
        if (!this.plain(pre.x, pre.y) || !this.postPlain(post.x, post.y, nextIsEnd)) continue;
        if (!cells.every((c) => this.inWindow(c.x, c.y) && !this.blocked(c.x, c.y, 0, this.cellOf(c.x, c.y, 0)))) continue;
        const prefix: GridPoint[] = [pre, ...cells, post].map((c) => ({ x: c.x, y: c.y, z: 0 }));
        starts.push({ x: post.x, y: post.y, z: 0, dir, phase: 2, g0: prefix.reduce((s, n) => s + this.nodeCost(n), 0), prefix });
      }
    }
    return starts;
  }

  /** Appends a leg and the stop it ended at to `base`; the start that continues from there. */
  private extend(found: Found, base: GridPoint[]): { nodes: GridPoint[]; start: Start } {
    const nodes = [...base, ...found.path.slice(1), ...found.goal.tail];
    this.markOwn(nodes, base.length);
    let phase = found.phase;
    for (let i = 1; i < found.goal.tail.length; i++) phase = AHEAD[phase];
    const end = nodes[nodes.length - 1];
    return { nodes, start: { x: end.x, y: end.y, z: 0, dir: found.goal.dir, phase, g0: 0, prefix: nodes } };
  }

  /** Routes a net through `stops`; undefined when it cannot be done. Throws `Aborted`. */
  private routeNet(stops: Stop[]): GridPoint[] | undefined {
    const end = stops[stops.length - 1];
    const ax = end.kind === 'end' ? end.x + DX[end.facing] : 0;
    const ay = end.kind === 'end' ? end.y + DY[end.facing] : 0;
    this.approach = end.kind === 'end' && this.inWindow(ax, ay) ? this.cellOf(ax, ay, 0) : -1;
    this.ownStamp++;
    this.newLeg(stops.length <= 1);
    const firsts = this.startsOf(stops[0], stops[1]?.kind === 'end');
    if (firsts.length === 0) return undefined;
    if (stops.length === 1) {
      // a lone run: the cheaper direction
      const only = firsts.reduce((a, b) => (b.g0 < a.g0 ? b : a));
      this.markOwn(only.prefix, 0);
      return only.prefix;
    }

    // the first leg, from each way the belt can begin; the cheapest wins
    let chosen: { found: Found; start: Start } | undefined;
    for (const start of firsts) {
      this.ownStamp++;
      this.newLeg(stops.length === 2);
      this.markOwn(start.prefix, 0);
      const goals = this.goalsOf(stops[1], start, stops[2]?.kind === 'end');
      if (goals.length === 0) continue;
      const found = this.leg([start], goals);
      if (found && (!chosen || found.cost < chosen.found.cost)) chosen = { found, start };
    }
    if (!chosen) return undefined;
    this.ownStamp++;
    this.markOwn(chosen.start.prefix, 0);
    let { nodes, start } = this.extend(chosen.found, chosen.start.prefix);

    for (let k = 2; k < stops.length; k++) {
      const stop = stops[k];
      if (stop.kind === 'start') return undefined;
      this.newLeg(k === stops.length - 1);
      const goals = this.goalsOf(stop, start, stops[k + 1]?.kind === 'end');
      if (goals.length === 0) return undefined;
      const found = this.leg([start], goals);
      if (!found) return undefined;
      ({ nodes, start } = this.extend(found, nodes));
    }
    return nodes;
  }

  // -------------------------------------------------------------------------------------------
  // Negotiation

  run(): RouteResult {
    const nets = this.net.nets;
    // consumers that take one item on several nets: `${machine}:${item}` -> how many nets
    const consumedOn = new Map<string, number>();
    for (const n of nets) {
      for (const k of new Set(n.taps.filter((t) => t.dir === 'in').map((t) => `${t.machineId}:${t.itemId}`))) {
        consumedOn.set(k, (consumedOn.get(k) ?? 0) + 1);
      }
    }
    // reserve tap and port points
    const stopsOfNet: (Stop[] | undefined)[] = nets.map((n) => {
      const taps = this.taps.taps.filter((t) => t.netId === n.id);
      const ports = this.taps.stationPorts.filter((p) => p.netId === n.id);
      for (const t of taps) if (this.inWindow(t.point.x, t.point.y)) this.reserved[this.flatOf(t.point.x, t.point.y)] = n.id;
      for (const q of ports) if (this.inWindow(q.point.x, q.point.y)) this.reserved[this.flatOf(q.point.x, q.point.y)] = n.id;
      const isSplit = (t: AssignedTap): boolean => (consumedOn.get(`${t.machineId}:${n.itemId}`) ?? 0) > 1;
      return stopsOf(n.source.kind === 'station', n.sink.kind === 'station', taps, ports, isSplit);
    });

    const order = nets
      .map((n, i) => i)
      .sort((a, b) => nets[b].taps.length - nets[a].taps.length || nets[a].id - nets[b].id);
    const routes: GridPoint[][] = nets.map(() => []);
    /** A net with no stops has nothing to route: it stays without a route. */
    const routable = (i: number): boolean => stopsOfNet[i] !== undefined;
    type Best = { routes: GridPoint[][]; shared: number; unroutable: number[] };
    let best: Best | undefined;

    const addUse = (nodes: GridPoint[], delta: 1 | -1): void => {
      for (const n of nodes) this.use[this.cellOf(n.x, n.y, n.z)] += delta;
    };
    /** The shared cells (and how many nets too many are on them), and the nets on them. */
    const snapshot = (): { shared: number; hot: Set<number>; cells: number[] } => {
      const cells: number[] = [];
      const hot = new Set<number>();
      let shared = 0;
      const counted = new Set<number>();
      routes.forEach((nodes, i) => {
        for (const n of nodes) {
          const c = this.cellOf(n.x, n.y, n.z);
          if (this.use[c] > 1) {
            hot.add(i);
            if (!counted.has(c)) {
              counted.add(c);
              shared += this.use[c] - 1;
              cells.push(c);
            }
          }
        }
      });
      return { shared, hot, cells };
    };
    const unroutableIds = (): number[] => nets.flatMap((n, i) => (routes[i].length === 0 ? [n.id] : []));
    /** Keeps the iteration if it has fewer nets without a route, or as many and no more shared cells. */
    const record = (): ReturnType<typeof snapshot> => {
      const snap = snapshot();
      const unroutable = unroutableIds();
      const better =
        !best ||
        unroutable.length < best.unroutable.length ||
        (unroutable.length === best.unroutable.length && snap.shared <= best.shared);
      if (better) best = { routes: routes.map((r) => r), shared: snap.shared, unroutable };
      return snap;
    };

    try {
      let todo = order;
      let lastHot = '';
      let stuck = 0;
      for (let iter = 0; iter < Math.max(1, this.p.maxIterations); iter++) {
        let gained = false;
        for (const i of todo) {
          if (this.shouldStop()) throw new Aborted();
          const before = routes[i];
          addUse(before, -1);
          routes[i] = [];
          let nodes: GridPoint[] | undefined;
          try {
            nodes = routable(i) ? this.routeNet(stopsOfNet[i] as Stop[]) : undefined;
          } catch (err) {
            routes[i] = before;
            addUse(before, 1);
            throw err;
          }
          // a net that cannot be routed this time keeps the route it had
          routes[i] = nodes ?? before;
          addUse(routes[i], 1);
          if (nodes && before.length === 0) gained = true;
        }
        const snap = record();
        const missing = nets.filter((_, i) => routes[i].length === 0 && routable(i)).length;
        if (snap.shared === 0 && missing === 0) break;
        // with nothing shared and no net newly routed, another round would only repeat this one
        if (snap.shared === 0 && !gained) break;
        if (snap.shared > 0) {
          // history is scaled by the present factor, so a cell that stays shared overtakes the price of sharing another
          for (const c of snap.cells) this.history[c] += this.p.historyFactor * (this.use[c] - 1) * Math.max(1, this.presentFactor);
          this.presentFactor = Math.min(
            this.presentFactor * this.p.presentFactorGrowth,
            Math.max(this.p.presentFactorStart, MAX_PRESENT_FACTOR),
          );
        }
        todo = order.filter((i) => snap.hot.has(i) || (routes[i].length === 0 && routable(i)));
        // The same nets in conflict round after round: whichever of them is routed first takes the cell the others
        // need, every time. Routing them in the opposite order every other round lets the other one have it.
        const hotKey = todo.join(',');
        stuck = hotKey === lastHot ? stuck + 1 : 0;
        lastHot = hotKey;
        if (stuck >= STUCK_ROUNDS && stuck % 2 === 1) todo.reverse();
        if (todo.length === 0) break;
      }
    } catch (err) {
      if (!(err instanceof Aborted)) throw err;
      // the round in progress is dropped: report the best complete round, or what there is
      if (!best) best = { routes: routes.map((r) => r), shared: snapshot().shared, unroutable: unroutableIds() };
      return this.result(best, true);
    }
    return this.result(best as Best, false);
  }

  private result(best: { routes: GridPoint[][]; shared: number; unroutable: number[] }, stopped: boolean): RouteResult {
    const out: RoutedNet[] = this.net.nets.map((n, i) => ({ netId: n.id, nodes: best.routes[i] }));
    if (best.shared === 0 && best.unroutable.length === 0 && !stopped) return { ok: true, routes: out };
    const conflicts = best.shared + best.unroutable.length;
    return { ok: false, conflicts: Math.max(conflicts, stopped ? 1 : 0), routes: out, unroutable: best.unroutable };
  }
}

/**
 * Routes every net of `net` over the tap points and ports of `taps` (see the file comment). The routes are in flow
 * order, one node per lattice point, with `z` in levels. `ok` is true when no (x, y, z) is used by two nets and
 * every net has a route; otherwise `conflicts` counts the shared cells plus the nets without a route, and
 * `unroutable` names those. The result is the best round seen: fewest nets without a route, then fewest shared cells.
 * `shouldStop` is asked between nets and every few thousand search steps; when it says yes the best so far comes back
 * with `ok: false`.
 */
export function routeNets(
  net: Netlist,
  taps: TapAssignment,
  occ: Occupancy,
  p: RouteParams,
  shouldStop: () => boolean,
): RouteResult {
  return new Router(net, taps, occ, p, shouldStop).run();
}
