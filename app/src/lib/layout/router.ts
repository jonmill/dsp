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
// cells others hold, which left the last conflicts of large layouts unresolved. When the same nets are in conflict in
// `STUCK_ROUNDS + 1` rounds in a row (the first, and `STUCK_ROUNDS` that repeat it), every other round after that routes
// them in the opposite order (the net routed first takes the cell the others need, round after round; Planetary
// Logistics Station at margin 3 stalled on 3 cells for 30 rounds once its split consumers were routed last). The result
// is the round with the fewest nets without a route and, among those, the fewest shared cells. The forced nodes of a
// stop (the node before and after a tap, the step out of a port) count as the net's cells like any other, so the other
// nets are steered off them.
//
// A net that cannot be routed (Task 27). Its legs are laid one after the other, and a leg can take the cells that a later
// stop has to be entered through (a net never uses a cell twice), or wall in the node a sink port is entered through.
// When the leg to a stop finds no route, the net is searched again with the stops of that stop's group in another order
// (`reorderings`: the failed run first, the group reversed; for a port, the group of the run before it), at most
// `maxReorders` times, and the order that works is the one the net keeps. A net whose searches fail `maxNetFailures` times
// in a row is left alone for the rest of the call (a failing search explores the whole window, which is what made hot
// nets that could not be rerouted cost round after round). `stallRounds` and `hopeless` let a caller that can afford to
// lose the candidate (the solver's improvement loop) end a negotiation that is not converging; they are off by default.
//
// Speed (Task 27). The A* heuristic is weighted (`heuristicWeight`, 1.25): routes about as long as the exact ones in a
// fifth of the expansions, which at 40 negotiation rounds on 500 nets is the difference between 7 and 30 seconds. With
// a weight above 1 the first goal found is not always the cheapest, so a route is no longer a shortest one.
//
// Room for a coater (Task 28). A net marked `sprayed` needs a bay (`Bay`): a straight stretch of ground nodes where its coater
// stands, between its last producer and its first consumer (for a net that starts at a station port, after the port). The item
// nets are routed first as any other, and then each sprayed net is routed once more through a bay that proliferator.ts picked
// for it (`BayRouter`), with every other net's cells closed, so the others keep the routes they converged on and the bay takes
// the room that is left. The bay is a stop like a tap run: three cells, entered by a flat step and left by one more node, so five
// nodes in a line, visited after the last run that holds a producer. Doing it net by net, on top of routes that are clear of one
// another, keeps 40 bays from congesting a placement that routes without them (Planetary Logistics Station with Mk.III
// proliferator: 41 sprayed nets; routed with all the bays at once, it did not converge at margin 3, 4 or 6).
//
// The proliferator feed (Task 28). `routeNets` leaves the net marked `proliferator` alone: it has no taps, and where it
// goes depends on where the coaters stand, which depends on the routes of the other nets. `routeFeed` routes it afterwards,
// as one net with no rivals: its start is the station port, its stops are the top passages of the coaters (`FeedOption`),
// and the cells the other nets use are closed to it. A top passage is a goal at z 1 that the belt crosses at a right angle
// to the coater's axis (the sample's pattern; running along the axis would put the next node inside the coater). Each coater
// offers several top passages, one per place it could stand on its belt, and a leg of the search takes the cheapest
// reachable one: the coater stands where the feed finds it cheapest to pass. The feed lifts from the ground to z 1 with the
// router's usual lift (two flat steps either side), and ends at its last top passage.
import type { GridPoint } from '../geometry';
import { MinHeap } from './heap';
import type { BeltNet, Netlist } from './netlist';
import type { Occupancy } from './occupancy';
import { FEED_PORT_CELLS } from './taps';
import type { AssignedStationPort, AssignedTap, TapAssignment } from './taps';

export interface RouteParams {
  maxIterations: number;
  presentFactorStart: number;
  presentFactorGrowth: number;
  historyFactor: number;
  allowElevation: boolean;
  maxLevel: number;
  /** Searches of one net that find no route, in a row, after which it is not tried again in this call (default 5). */
  maxNetFailures?: number;
  /** A failed net is searched again with other orders of its stops at most this often (default 2). */
  maxReorders?: number;
  /**
   * After this many rounds in a row with the same nets in conflict, every other round routes them in the opposite
   * order (default `STUCK_ROUNDS`; `Infinity`: never).
   */
  stuckRounds?: number;
  /**
   * Rounds in a row without a better result after which the negotiation gives up. Omitted: it goes on until it has
   * converged or `maxIterations` rounds are done (a stuck negotiation can still resolve after 30 rounds).
   */
  stallRounds?: number;
  /**
   * The negotiation gives up after round `afterRounds` if it still has more than `perNet` conflicts (shared cells plus
   * nets without a route) for every net: a placement whose routes are that far from clear after a few rounds does not
   * converge later. Omitted: never.
   */
  hopeless?: { afterRounds: number; perNet: number };
  /** Extra cost of a node per level above the ground (default `ELEVATION_COST`). */
  elevationCost?: number;
  /** The A* heuristic's weight; above 1 trades route length for speed (default `HEURISTIC_WEIGHT`). */
  heuristicWeight?: number;
  /** The search window in tiles; every tap point and port point has to lie inside it (placement bounds + 6). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
/**
 * Where the coater of a net stands (Task 28): three cells in a row on the ground, `cells` in ascending order along `axis`,
 * that the net's belt passes in one of `signs` (+1 ascending). The belt enters by a flat step into the first cell and goes
 * on one node past the last, so the five nodes are in a line, with the coater on the middle one. `held` are the cells at z 1
 * that the coater's body and the feed's approach to its top passage need: no net's belt may cross them.
 */
export interface Bay {
  netId: number;
  axis: 'x' | 'y';
  cells: { x: number; y: number }[];
  signs: (1 | -1)[];
  held: GridPoint[];
}
export interface RoutedNet {
  netId: number;
  /** In flow order: the first node is the belt start. Empty for a net that could not be routed. */
  nodes: GridPoint[];
}
/**
 * One place where a coater could stand, as the feed sees it (`routeFeed`): the cell of its top passage at z 1, the
 * headings (0 east, 1 north, 2 west, 3 south) the feed may cross it with (the two across the coater's axis; `through`: those
 * that leave a free cell after it, for a stop the feed goes on from), and the cells
 * of the coater's body at z 1 that the feed has to keep off. `tag` is the caller's handle on the option.
 */
export interface FeedOption {
  x: number;
  y: number;
  /** The headings the feed may cross it with when it is the last stop: the cell before it is free. */
  dirs: number[];
  /** ...and when the feed goes on from it: the cell after it is free too. */
  through: number[];
  body: GridPoint[];
  tag: number;
}
/** What a `routeNets` call did, for tuning and tests. */
export interface RouteStats {
  /** Negotiation rounds run (the first one routes every net). */
  rounds: number;
  /** Searches for a whole net, whether or not they found a route. */
  netSearches: number;
  /** Of those, the ones that found no route. */
  netFailures: number;
  /** Of the searches, the ones that tried the stops of a failed net in another order. */
  reorders: number;
  /** A* expansions in all. */
  expansions: number;
  /** After each round: the shared cells plus the nets without a route. */
  conflictsPerRound: number[];
}
export type RouteResult =
  | { ok: true; routes: RoutedNet[]; stats: RouteStats }
  | { ok: false; conflicts: number; routes: RoutedNet[]; unroutable: number[]; stats: RouteStats };

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
/**
 * What a node costs per level above the ground. Measured in Task 27. Quantum Chip placements annealed at margin 2 (8 of
 * them, routed the way the improvement loop does): at 0.25, 5 route and 20 % more nodes are lifted; at 0.5, 5 route; at 1
 * and 2 none do, the negotiation is too far from converging after 6 rounds. Quantum Chip placements of the ladder (margins
 * 3, 4, 6): 1, 2 and 4 lift about 16, 23 and 27 % fewer nodes, lay 3, 8 and 14 % more nodes in all, and take 2.3-2.5, 4.2-4.7
 * and 6-8.5 times as long. Most lifts are crossings that have no route on the ground, so a higher price buys few
 * fewer of them. Kept at 0.5.
 */
const ELEVATION_COST = 0.5;
/**
 * A* with the distance to the goal weighted by this much. 1.25 finds routes about as long as 1 does (Quantum Chip at
 * margin 2: 14.3k nodes either way; Planetary Logistics Station at margin 3: 35.5k against 35.3k) with 7-9 % more
 * elevated nodes, in a fifth of the expansions (the Station's routing: 27 s to 7 s). At 1.5 the elevated nodes grow by
 * three quarters (Quantum Chip: 3.2k to 5.7k) for a further saving that the layout does not need.
 */
const HEURISTIC_WEIGHT = 1.25;
/** Added to the heuristic's weight in the heap key, so states nearer a goal win ties between equal f. */
const TIE_BREAK = 1e-6;
/** Searches check `shouldStop` every this many expansions. */
const STOP_CHECK_MASK = 4095;
/**
 * Rounds that repeat the same nets in conflict (after the first one that has them) after which every other round routes
 * them in the opposite order: with 3, the fifth round is the first reversed.
 */
const STUCK_ROUNDS = 3;
/** The present factor stops growing here: past it every shared cell is as good as forbidden. */
const MAX_PRESENT_FACTOR = 1e4;
/** Consecutive failed searches after which a net is not tried again in one `routeNets` call. */
const MAX_NET_FAILURES = 5;
/** A failed net is searched again with other orders of its stops at most this often (per search of the net). */
const MAX_REORDERS = 2;
/** A leg whose best path crosses itself is searched again with the repeated cells closed, at most this often. */
const SELF_CROSS_RETRIES = 3;
/** A leg to a coater's top passage drops the goals whose path crosses their own coater, at most this many before it gives up. */
const MAX_BODY_DROPS = 12;

const headingOf = (dx: number, dy: number): number => (dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3);
const manhattan = (ax: number, ay: number, bx: number, by: number): number => Math.abs(ax - bx) + Math.abs(ay - by);
const sameNode = (a: GridPoint, b: GridPoint): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

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
/** The top passage of one coater of the feed: any of its options will do, and the search takes the cheapest. */
interface TopStop {
  kind: 'top';
  options: FeedOption[];
}
type Stop = RunStop | PortStop | TopStop;
type TapDir = AssignedTap['dir'];

/** The stops of a net in visiting order, and which of them may swap places with which (see `reorderings`). */
interface StopPlan {
  stops: Stop[];
  /** Per stop: the group of runs it may be reordered within (producers, mixed runs, consumers); -1: fixed in place. */
  group: number[];
}

/** The index of the stop a net's bay follows: the last that holds a producer (a producers-only or mixed run), else the port the belt starts at; -1: none. */
function bayAfter(stops: readonly Stop[], group: readonly number[]): number {
  let at = -1;
  stops.forEach((_, i) => {
    if (group[i] === 0 || group[i] === 1) at = i;
  });
  return at >= 0 ? at : stops.findIndex((x) => x.kind === 'start');
}

/** The bay as a stop: a run of three cells that holds no tap. */
function bayStop(bay: Bay): RunStop {
  const [a, , b] = bay.cells;
  return { kind: 'run', axis: bay.axis, cells: bay.cells.map((c) => ({ x: c.x, y: c.y })), kinds: bay.cells.map(() => null), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, signs: bay.signs };
}
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
  bay?: Bay,
): StopPlan | undefined {
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
  const groupOf: number[] = [];
  const push = (stop: Stop, group: number): void => {
    stops.push(stop);
    groupOf.push(group);
  };
  let from: Cell | undefined;
  if (source) {
    push({ kind: 'start', x: source.point.x, y: source.point.y, facing: headingOf(source.dir[0], source.dir[1]) }, -1);
    from = source.point;
  }
  for (const [g, { runs: group, byId }] of groups.entries()) {
    const gid = byId ? -1 : g;
    let pool = group;
    if (pool.length === 0) continue;
    if (!from && byId) {
      push(pool[0], gid);
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
      push(head, gid);
      from = head.center;
    }
    const ordered = byId ? pool : nearestFirst(pool, from);
    for (const stop of ordered) push(stop, gid);
    if (ordered.length > 0) from = ordered[ordered.length - 1].center;
  }
  if (sink) push({ kind: 'end', x: sink.point.x, y: sink.point.y, facing: headingOf(sink.dir[0], sink.dir[1]) }, -1);
  if (stops.length === 0) return undefined;
  if (bay) {
    const at = bayAfter(stops, groupOf);
    if (at >= 0) {
      stops.splice(at + 1, 0, bayStop(bay));
      groupOf.splice(at + 1, 0, -1);
    }
  }
  return { stops, group: groupOf };
}

/** For a net: whether a consumer tap of it is of a machine that takes the net's item on another net too (see the file comment). */
export function splitConsumers(nets: readonly BeltNet[]): (net: BeltNet) => (t: AssignedTap) => boolean {
  // consumers that take one item on several nets: `${machine}:${item}` -> how many nets
  const consumedOn = new Map<string, number>();
  for (const n of nets) {
    for (const k of new Set(n.taps.filter((t) => t.dir === 'in').map((t) => `${t.machineId}:${t.itemId}`))) {
      consumedOn.set(k, (consumedOn.get(k) ?? 0) + 1);
    }
  }
  return (net) => (t) => (consumedOn.get(`${t.machineId}:${net.itemId}`) ?? 0) > 1;
}

/**
 * Other orders for the stops of a net whose leg to stop `k` failed, most promising first. The stop that failed is
 * usually a run whose cells (or the nodes beside them) an earlier leg took: its group is reordered with it moved to the
 * front, so that the cells of that run are taken before the legs that used to run over them, and with the group
 * reversed. A stop that has to stay where it is (a sink port, whose approach an earlier leg walled in; split consumers)
 * leaves the last run before it to move instead: the group of that run is reordered the same way. Producers still come
 * before consumers in all of them: only stops of one group change places; the ports and the split consumers, whose order
 * is the machine id order of the rate axis, stay where they are.
 */
function reorderings(plan: StopPlan, k: number): StopPlan[] {
  let j = k;
  while (j >= 0 && plan.group[j] < 0) j--;
  if (j < 0) return [];
  const g = plan.group[j];
  const from = plan.group.indexOf(g);
  const to = plan.group.lastIndexOf(g) + 1;
  const make = (order: Stop[]): StopPlan => ({
    stops: [...plan.stops.slice(0, from), ...order, ...plan.stops.slice(to)],
    group: plan.group,
  });
  const members = plan.stops.slice(from, to);
  const seen = new Set<string>([members.map((m) => stopKey(m)).join('|')]);
  const out: StopPlan[] = [];
  const add = (order: Stop[]): void => {
    const key = order.map((m) => stopKey(m)).join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(make(order));
  };
  if (j > from) add([plan.stops[j], ...members.filter((_, i) => i !== j - from)]);
  if (members.length > 1) add([...members].reverse());
  return out;
}

const stopKey = (s: Stop): string =>
  s.kind === 'run' ? `${s.axis}${s.cells[0].x},${s.cells[0].y}` : s.kind === 'top' ? `top${s.options[0].x},${s.options[0].y}` : `${s.kind}${s.x},${s.y}`;

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
  /** Its height (default 0: a tap run or a port; a coater's top passage is at 1). */
  ez?: number;
  dir: number;
  /** Bit p set: the phase p is acceptable on arrival. */
  phases: number;
  /** The nodes after the entry cell, with the entry cell first. */
  tail: GridPoint[];
  tailCost: number;
  /** A coater's top passage: which option of the feed this goal is, and the cells of the coater's body the belt must keep off. */
  tag?: number;
  body?: GridPoint[];
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
  /** Cells that other nets hold, closed to the net being routed (only `routeFeed` sets any). */
  private fixed: Uint8Array | undefined;
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
  private readonly elevationCost: number;
  private readonly hWeight: number;
  /** The node before a sink port's first node (cell index), or -1: only the last leg may use it. */
  private approach = -1;

  // the search under way
  private goals: Goal[] = [];
  /** The highest `ez` of the goals: a flat step into a cell at or below it may reach one. */
  private goalZ = 0;
  /** The `tag` of the goal each leg of the net under way ended at, in order. */
  private chosen: number[] = [];
  private bestTerm = Infinity;
  private bestParent = -1;
  private bestGoal: Goal | undefined;
  private bestPhase = 0;
  private expansions = 0;
  private rounds = 0;
  private netSearches = 0;
  private netFailures = 0;
  private reorders = 0;
  private readonly conflictsPerRound: number[] = [];

  /** The nets `run` routes: the netlist's without the proliferator feed, which `routeFeed` routes afterwards. */
  private readonly nets: BeltNet[];
  /** The feed nets of the netlist (at most one): `run` keeps their port cells clear. */
  private readonly feedNets: BeltNet[];

  constructor(
    nets: readonly BeltNet[],
    private readonly taps: TapAssignment,
    private readonly occ: Occupancy,
    private readonly p: RouteParams,
    private readonly shouldStop: () => boolean,
  ) {
    this.feedNets = nets.filter((n) => n.proliferator);
    this.nets = nets.filter((n) => !n.proliferator);
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
    this.elevationCost = p.elevationCost ?? ELEVATION_COST;
    this.hWeight = (p.heuristicWeight ?? HEURISTIC_WEIGHT) + TIE_BREAK;
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
    if (this.fixed !== undefined && this.fixed[cell] === 1) return false;
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
    return 1 + this.elevationCost * z + this.presentFactor * this.use[cell] + this.history[cell];
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
    if (flat && nz <= this.goalZ) {
      const goals = this.goals;
      for (let i = 0; i < goals.length; i++) {
        const goal = goals[i];
        if (goal.ex !== nx || goal.ey !== ny || (goal.ez ?? 0) !== nz || goal.dir !== nd || ((goal.phases >> np) & 1) === 0) continue;
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
    this.heap.push(g + this.heuristic(nx, ny) * this.hWeight, s);
  }

  /**
   * One A* from any of `starts` to any of `goals`. Throws `Aborted` when `shouldStop` says so. Returns undefined when
   * no goal can be reached.
   */
  private search(starts: Start[], goals: Goal[]): Found | undefined {
    this.ensureSearchArrays();
    this.goals = goals;
    this.goalZ = goals.reduce((m, g) => Math.max(m, g.ez ?? 0), 0);
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
      heap.push(st.g0 + this.heuristic(st.x, st.y) * this.hWeight, s);
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
    let open = goals;
    let dropped = 0;
    for (let attempt = 0; attempt <= SELF_CROSS_RETRIES; attempt++) {
      const found = this.search(starts, open);
      if (!found) return undefined;
      // A coater's top passage is a goal that keeps the belt off the coater's body; the belt that gets there may have crossed
      // it. That goal is dropped and the leg searched again (a drop is not a self-crossing, and does not use up a retry).
      const body = found.goal.body;
      if (body && [...found.path, ...found.goal.tail].some((n) => body.some((b) => b.x === n.x && b.y === n.y && b.z === n.z))) {
        open = open.filter((g) => g !== found.goal);
        if (open.length === 0 || ++dropped > MAX_BODY_DROPS) return undefined;
        attempt--;
        continue;
      }
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

  /**
   * The goals for entering `stop` (both directions along the axis for a run), with the tails priced and checked. `last` is
   * set when `stop` is the last of the net (a top passage ends the belt there, so it must not end in the middle of a lift).
   */
  private goalsOf(stop: Stop, from: Start, nextIsEnd: boolean, last = false): Goal[] {
    const goals: Goal[] = [];
    if (stop.kind === 'top') {
      for (const o of stop.options) {
        if (!this.inWindow(o.x, o.y) || !this.usable(o.x, o.y, 1, this.cellOf(o.x, o.y, 1))) continue;
        if (o.body.some((b) => !this.inWindow(b.x, b.y) || this.own[this.cellOf(b.x, b.y, b.z)] === this.ownStamp)) continue;
        const phases = last ? END_PHASES : ANY_PHASE & ~((1 << PHASE_LIFTED_UP) | (1 << PHASE_LIFTED_DOWN));
        for (const dir of last ? o.dirs : o.through) {
          goals.push({ ex: o.x, ey: o.y, ez: 1, dir, phases, tail: [{ x: o.x, y: o.y, z: 1 }], tailCost: 0, tag: o.tag, body: o.body });
        }
      }
      return goals;
    }
    if (stop.kind === 'run') {
      for (const sign of stop.signs) {
        const dir = stop.axis === 'x' ? (sign > 0 ? 0 : 2) : sign > 0 ? 1 : 3;
        const cells = sign > 0 ? stop.cells : [...stop.cells].reverse();
        const last = cells[cells.length - 1];
        const post = { x: last.x + DX[dir], y: last.y + DY[dir] };
        if (!this.postPlain(post.x, post.y, nextIsEnd)) continue;
        const tail: GridPoint[] = [...cells.map((c) => ({ x: c.x, y: c.y, z: 0 })), { x: post.x, y: post.y, z: 0 }];
        if (!tail.every((n) => this.inWindow(n.x, n.y))) continue;
        if (!cells.every((c) => !this.blocked(c.x, c.y, 0, this.cellOf(c.x, c.y, 0)) && this.own[this.cellOf(c.x, c.y, 0)] !== this.ownStamp && this.fixed?.[this.cellOf(c.x, c.y, 0)] !== 1)) continue;
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
    if (stop.kind === 'top') return starts; // a top passage is never where a belt begins
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
        const end = prefix[prefix.length - 1];
        starts.push({ x: end.x, y: end.y, z: 0, dir, phase: 2, g0: prefix.reduce((s, n) => s + this.nodeCost(n), 0), prefix });
      }
    }
    return starts;
  }

  /** Appends a leg and the stop it ended at to `base`; the start that continues from there. */
  private extend(found: Found, base: GridPoint[]): { nodes: GridPoint[]; start: Start } {
    const nodes = [...base, ...found.path.slice(1), ...found.goal.tail];
    this.markOwn(nodes, base.length);
    if (found.goal.tag !== undefined) {
      // a coater's top passage: remember which option it was, and keep the rest of the belt off the coater's body
      this.chosen.push(found.goal.tag);
      for (const b of found.goal.body ?? []) this.own[this.cellOf(b.x, b.y, b.z)] = this.ownStamp;
    }
    let phase = found.phase;
    for (let i = 1; i < found.goal.tail.length; i++) phase = AHEAD[phase];
    const end = nodes[nodes.length - 1];
    return { nodes, start: { x: end.x, y: end.y, z: end.z, dir: found.goal.dir, phase, g0: 0, prefix: nodes } };
  }

  /** Routes a net through `stops`; the failing stop's index when it cannot be done. Throws `Aborted`. */
  private routeNet(stops: Stop[]): GridPoint[] | number {
    this.chosen = [];
    const end = stops[stops.length - 1];
    const ax = end.kind === 'end' ? end.x + DX[end.facing] : 0;
    const ay = end.kind === 'end' ? end.y + DY[end.facing] : 0;
    this.approach = end.kind === 'end' && this.inWindow(ax, ay) ? this.cellOf(ax, ay, 0) : -1;
    this.ownStamp++;
    this.newLeg(stops.length <= 1);
    const firsts = this.startsOf(stops[0], stops[1]?.kind === 'end');
    if (firsts.length === 0) return 0;
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
      const goals = this.goalsOf(stops[1], start, stops[2]?.kind === 'end', stops.length === 2);
      if (goals.length === 0) continue;
      const found = this.leg([start], goals);
      if (found && (!chosen || found.cost < chosen.found.cost)) chosen = { found, start };
    }
    if (!chosen) return 1;
    this.ownStamp++;
    this.markOwn(chosen.start.prefix, 0);
    let { nodes, start } = this.extend(chosen.found, chosen.start.prefix);

    for (let k = 2; k < stops.length; k++) {
      const stop = stops[k];
      if (stop.kind === 'start') return k;
      this.newLeg(k === stops.length - 1);
      const goals = this.goalsOf(stop, start, stops[k + 1]?.kind === 'end', k === stops.length - 1);
      if (goals.length === 0) return k;
      const found = this.leg([start], goals);
      if (!found) return k;
      ({ nodes, start } = this.extend(found, nodes));
    }
    return nodes;
  }

  // -------------------------------------------------------------------------------------------
  // Negotiation

  private prepared = false;
  private splitOf: ((net: BeltNet) => (t: AssignedTap) => boolean) | undefined;

  /** Keeps the cells that are nobody else's clear: the feed's port cells, the tap points and the port points of every net. */
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    this.splitOf = splitConsumers(this.nets);
    // the feed's port: the cell outside it and the two after, which its first nodes will need (the belt is on the ground for
    // two flat steps before it lifts to z 1, and the nodes that cross the other nets' belts come after that), are nobody else's
    for (const f of this.feedNets) {
      for (const q of this.taps.stationPorts) {
        if (q.netId !== f.id) continue;
        for (let i = 0; i < FEED_PORT_CELLS; i++) {
          const cx = q.point.x + i * q.dir[0];
          const cy = q.point.y + i * q.dir[1];
          if (this.inWindow(cx, cy)) this.reserved[this.flatOf(cx, cy)] = f.id;
        }
      }
    }
    // reserve tap and port points
    for (const t of this.taps.taps) if (this.inWindow(t.point.x, t.point.y)) this.reserved[this.flatOf(t.point.x, t.point.y)] = t.netId;
    for (const q of this.taps.stationPorts) if (this.inWindow(q.point.x, q.point.y)) this.reserved[this.flatOf(q.point.x, q.point.y)] = q.netId;
  }

  /** The stops of net `n`, with `bay` after the last producer if it has one. */
  private planOf(n: BeltNet, bay?: Bay): StopPlan | undefined {
    const taps = this.taps.taps.filter((t) => t.netId === n.id);
    const ports = this.taps.stationPorts.filter((p) => p.netId === n.id);
    return stopsOf(n.source.kind === 'station', n.sink.kind === 'station', taps, ports, (this.splitOf as NonNullable<typeof this.splitOf>)(n), bay);
  }

  run(): RouteResult {
    const nets = this.nets;
    this.prepare();
    const planOfNet: (StopPlan | undefined)[] = nets.map((n) => this.planOf(n));

    const order = nets
      .map((n, i) => i)
      .sort((a, b) => nets[b].taps.length - nets[a].taps.length || nets[a].id - nets[b].id);
    const routes: GridPoint[][] = nets.map(() => []);
    /** A net with no stops has nothing to route: it stays without a route. */
    const routable = (i: number): boolean => planOfNet[i] !== undefined;
    /** Searches of a net that found no route, in a row. A net at `maxNetFailures` is not tried again. */
    const failStreak: number[] = nets.map(() => 0);
    const maxFailures = Math.max(1, this.p.maxNetFailures ?? MAX_NET_FAILURES);
    const maxReorders = this.p.maxReorders ?? MAX_REORDERS;
    const tried = (i: number): boolean => failStreak[i] < maxFailures;
    /**
     * Routes net `i`. When a leg fails, the net is routed again with the stops of that leg's group in other orders (see
     * `reorderings`), at most `maxReorders` times; the order that works is the one the net keeps for the next round.
     */
    const search = (i: number): GridPoint[] | undefined => {
      let plan = planOfNet[i] as StopPlan;
      this.netSearches++;
      let outcome = this.routeNet(plan.stops);
      let alternatives: StopPlan[] | undefined;
      for (let attempt = 0; typeof outcome === 'number' && attempt < maxReorders; attempt++) {
        alternatives ??= reorderings(plan, outcome);
        const next = alternatives.shift();
        if (!next) break;
        this.netSearches++;
        this.reorders++;
        const again = this.routeNet(next.stops);
        if (typeof again !== 'number') planOfNet[i] = plan = next;
        outcome = again;
      }
      if (typeof outcome === 'number') {
        this.netFailures++;
        return undefined;
      }
      return outcome;
    };
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
      let bestRound = Infinity;
      let sinceBest = 0;
      const stallRounds = this.p.stallRounds === undefined ? Infinity : Math.max(1, this.p.stallRounds);
      for (let iter = 0; iter < Math.max(1, this.p.maxIterations); iter++) {
        this.rounds++;
        let gained = false;
        for (const i of todo) {
          if (this.shouldStop()) throw new Aborted();
          const before = routes[i];
          addUse(before, -1);
          routes[i] = [];
          let nodes: GridPoint[] | undefined;
          try {
            if (routable(i)) nodes = search(i);
          } catch (err) {
            routes[i] = before;
            addUse(before, 1);
            throw err;
          }
          failStreak[i] = nodes || !routable(i) ? 0 : failStreak[i] + 1;
          // a net that cannot be routed this time keeps the route it had
          routes[i] = nodes ?? before;
          addUse(routes[i], 1);
          if (nodes && before.length === 0) gained = true;
        }
        const snap = record();
        const score = snap.shared + unroutableIds().length;
        this.conflictsPerRound.push(score);
        sinceBest = score < bestRound ? 0 : sinceBest + 1;
        bestRound = Math.min(bestRound, score);
        if (sinceBest >= stallRounds) break;
        if (this.p.hopeless && this.rounds >= this.p.hopeless.afterRounds && score > this.p.hopeless.perNet * nets.length && score > 0) break;
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
        todo = order.filter((i) => tried(i) && (snap.hot.has(i) || (routes[i].length === 0 && routable(i))));
        // The same nets in conflict round after round: whichever of them is routed first takes the cell the others
        // need, every time. Routing them in the opposite order every other round lets the other one have it.
        const hotKey = todo.join(',');
        stuck = hotKey === lastHot ? stuck + 1 : 0;
        lastHot = hotKey;
        if (stuck >= (this.p.stuckRounds ?? STUCK_ROUNDS) && stuck % 2 === 1) todo.reverse();
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

  // -------------------------------------------------------------------------------------------
  // The proliferator feed

  /** Closes the cells of `nodes` (other nets' routes) to the net being routed. */
  closeCells(nodes: readonly GridPoint[]): void {
    this.fixed ??= new Uint8Array(this.cells);
    for (const n of nodes) {
      if (this.inWindow(n.x, n.y) && n.z >= 0 && n.z <= this.maxLevel) this.fixed[this.cellOf(n.x, n.y, n.z)] = 1;
    }
  }

  /**
   * Routes net `netId` once more, through `bay`, with the cells in `closed` (every other net's nodes, the cells above the other
   * bays) closed to it. `old` is the route it had. First only the stretch between its last producer and its first consumer is
   * routed again, through the bay, and the rest of `old` is kept (and closed to that stretch); when that cannot be done, the
   * whole net is, with the bay after its last producer, and when a leg fails the stops of its group are tried in other orders
   * as in the negotiation. Undefined when it cannot be done. Throws `Aborted`.
   */
  routeThroughBay(netId: number, bay: Bay, closed: readonly GridPoint[], old: readonly GridPoint[]): GridPoint[] | undefined {
    this.prepare();
    if (this.shouldStop()) throw new Aborted();
    const net = this.nets.find((n) => n.id === netId);
    if (!net) return undefined;
    const base = this.planOf(net);
    if (!base) return undefined;
    this.fixed ??= new Uint8Array(this.cells);

    const part = this.stretchThrough(base, bay, old);
    if (part) {
      this.fixed.fill(0);
      this.closeCells(closed);
      this.closeCells(old.slice(0, part.from));
      this.closeCells(old.slice(part.to + 1));
      const out = this.routeNet(part.stops);
      if (typeof out !== 'number' && sameNode(out[0], old[part.from]) && sameNode(out[out.length - 1], old[part.to])) {
        return [...old.slice(0, part.from), ...out, ...old.slice(part.to + 1)];
      }
    }

    let plan = this.planOf(net, bay);
    if (!plan) return undefined;
    this.fixed.fill(0);
    this.closeCells(closed);
    let outcome = this.routeNet(plan.stops);
    let alternatives: StopPlan[] | undefined;
    for (let attempt = 0; typeof outcome === 'number' && attempt < (this.p.maxReorders ?? MAX_REORDERS); attempt++) {
      alternatives ??= reorderings(plan, outcome);
      const next = alternatives.shift();
      if (!next) break;
      const again = this.routeNet(next.stops);
      if (typeof again !== 'number') plan = next;
      outcome = again;
    }
    return typeof outcome === 'number' ? undefined : outcome;
  }

  /**
   * The stops of the stretch of `old` between the last run that holds a producer (or the port the belt starts at) and the next
   * stop, a run: those two, passed the way `old` passes them, with `bay` between; and the nodes of `old` it replaces (the
   * first node of the first stop's approach to the last node of the second's exit). Undefined when `old` does not pass them
   * as a plan would.
   */
  private stretchThrough(base: StopPlan, bay: Bay, old: readonly GridPoint[]): { stops: Stop[]; from: number; to: number } | undefined {
    const at = bayAfter(base.stops, base.group);
    const first = base.stops[at];
    const last = base.stops[at + 1];
    if (at < 0 || !last || last.kind !== 'run') return undefined;
    const indexOf = (c: Cell): number => old.findIndex((p) => p.z === 0 && p.x === c.x && p.y === c.y);
    /** The run passed the way `old` passes it, and the indexes of the node before it and the one after it. */
    const passed = (run: RunStop): { stop: RunStop; before: number; after: number } | undefined => {
      const a = indexOf(run.cells[0]);
      const b = indexOf(run.cells[run.cells.length - 1]);
      if (a < 0 || b < 0 || Math.abs(b - a) !== run.cells.length - 1) return undefined;
      let sign: 1 | -1;
      if (b !== a) {
        sign = b > a ? 1 : -1;
      } else {
        // a run of one cell: the way the belt goes on from it along the axis
        const step = a + 1 < old.length ? (run.axis === 'x' ? old[a + 1].x - old[a].x : old[a + 1].y - old[a].y) : 0;
        if (step === 0) return undefined;
        sign = step > 0 ? 1 : -1;
      }
      if (!run.signs.includes(sign)) return undefined;
      const entry = Math.min(a, b);
      const exit = Math.max(a, b);
      if (entry < 1 || exit + 1 >= old.length) return undefined;
      return { stop: { ...run, signs: [sign] }, before: entry - 1, after: exit + 1 };
    };
    const tail = passed(last);
    if (!tail) return undefined;
    let head: Stop;
    let from: number;
    if (first.kind === 'start') {
      if (old.length < 2 || !sameNode(old[0], { x: first.x, y: first.y, z: 0 })) return undefined;
      head = first;
      from = 0;
    } else if (first.kind === 'run') {
      const run = passed(first);
      if (!run) return undefined;
      head = run.stop;
      from = run.before;
    } else {
      return undefined;
    }
    if (from >= tail.before) return undefined;
    return { stops: [head, bayStop(bay), tail.stop], from, to: tail.after };
  }

  /** Routes one net through `stops`, with no rivals; the failing stop's index, or the nodes and the tag of each top passage. */
  routeStops(stops: Stop[]): { nodes: GridPoint[]; chosen: number[] } | number {
    const out = this.routeNet(stops);
    return typeof out === 'number' ? out : { nodes: out, chosen: [...this.chosen] };
  }

  private result(best: { routes: GridPoint[][]; shared: number; unroutable: number[] }, stopped: boolean): RouteResult {
    const out: RoutedNet[] = this.nets.map((n, i) => ({ netId: n.id, nodes: best.routes[i] }));
    const stats: RouteStats = { rounds: this.rounds, netSearches: this.netSearches, netFailures: this.netFailures, reorders: this.reorders, expansions: this.expansions, conflictsPerRound: this.conflictsPerRound };
    if (best.shared === 0 && best.unroutable.length === 0 && !stopped) return { ok: true, routes: out, stats };
    const conflicts = best.shared + best.unroutable.length;
    return { ok: false, conflicts: Math.max(conflicts, stopped ? 1 : 0), routes: out, unroutable: best.unroutable, stats };
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
  return new Router(net.nets, taps, occ, p, shouldStop).run();
}

/**
 * Routes single nets of `net` once more through a bay (see the file comment), one after the other, each with the cells of the
 * others closed: for the caller to place the coaters of the sprayed nets after `routeNets` has routed them all. One instance
 * serves any number of calls.
 */
export class BayRouter {
  private readonly router: Router;

  constructor(net: Netlist, taps: TapAssignment, occ: Occupancy, p: RouteParams, shouldStop: () => boolean) {
    this.router = new Router(net.nets, taps, occ, p, shouldStop);
  }

  /**
   * The nodes of net `netId` routed through `bay` with `closed` cells closed to it, `old` being the route it has (the stretch
   * round the bay is routed again, the rest kept where it can); undefined when it cannot be; `'stopped'` when asked to stop.
   */
  route(netId: number, bay: Bay, closed: readonly GridPoint[], old: readonly GridPoint[]): GridPoint[] | undefined | 'stopped' {
    try {
      return this.router.routeThroughBay(netId, bay, closed, old);
    } catch (err) {
      if (err instanceof Aborted) return 'stopped';
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The proliferator feed

export type FeedResult =
  | { ok: true; nodes: GridPoint[]; chosen: number[] }
  | { ok: false; reason: string; stopped: boolean };

/**
 * Orders are tried until one routes: nearest first, then the failing coater first, last, and the order reversed, then the failing
 * coater one place earlier, two, and so on (the coater before it left the belt where it could not go on).
 */
const MAX_FEED_ORDERS = 12;

/**
 * Routes the proliferator feed (see the file comment): from the station port `port` through one option of every group of
 * `groups` (a group is one coater's alternatives), and ends at the last one. `taken` are the nodes of every other net; their
 * cells are closed. The groups are visited nearest first; when the leg to one fails, orders with that group first, last and
 * reversed are tried. `chosen[i]` is the `tag` of the option the route passes for the i-th group visited, and the groups
 * come back in `order` (indexes into `groups`). Returns `stopped` when `shouldStop` said yes.
 */
export function routeFeed(
  port: AssignedStationPort,
  groups: FeedOption[][],
  taken: readonly GridPoint[],
  occ: Occupancy,
  p: RouteParams,
  shouldStop: () => boolean,
): FeedResult & { order?: number[] } {
  if (groups.length === 0 || groups.some((g) => g.length === 0)) {
    return { ok: false, reason: 'a coater has no place to stand', stopped: false };
  }
  const router = new Router([], { taps: [], stationPorts: [port] }, occ, p, shouldStop);
  router.closeCells(taken);
  const start: Stop = { kind: 'start', x: port.point.x, y: port.point.y, facing: headingOf(port.dir[0], port.dir[1]) };

  // nearest first: from the port, to the nearest option of the nearest group, and so on
  const nearest = (from: Cell, left: number[]): { at: number; to: Cell } => {
    let best = { at: left[0], to: { x: groups[left[0]][0].x, y: groups[left[0]][0].y }, d: Infinity };
    for (const g of left) {
      for (const o of groups[g]) {
        const d = manhattan(from.x, from.y, o.x, o.y);
        if (d < best.d) best = { at: g, to: { x: o.x, y: o.y }, d };
      }
    }
    return best;
  };
  const initial: number[] = [];
  let left = groups.map((_, i) => i);
  let at: Cell = port.point;
  while (left.length > 0) {
    const next = nearest(at, left);
    initial.push(next.at);
    left = left.filter((g) => g !== next.at);
    at = next.to;
  }

  const tried = new Set<string>();
  let order = initial;
  let lastFailure = '';
  for (let attempt = 0; attempt < MAX_FEED_ORDERS; attempt++) {
    tried.add(order.join(','));
    const stops: Stop[] = [start, ...order.map((g): Stop => ({ kind: 'top', options: groups[g] }))];
    if (shouldStop()) return { ok: false, reason: 'stopped', stopped: true };
    let outcome: ReturnType<Router['routeStops']>;
    try {
      outcome = router.routeStops(stops);
    } catch (err) {
      if (err instanceof Aborted) return { ok: false, reason: 'stopped', stopped: true };
      throw err;
    }
    if (typeof outcome !== 'number') return { ok: true, nodes: outcome.nodes, chosen: outcome.chosen, order };
    const failed = outcome - 1; // index into `order` (stop 0 is the port)
    lastFailure =
      outcome === 0
        ? 'the belt cannot leave the station port'
        : `no route to the top passage of coater ${failed + 1} of ${order.length} (${groups[order[failed]].length} places tried)`;
    if (failed < 0) break;
    const g = order[failed];
    const rest = order.filter((x) => x !== g);
    const earlier = Array.from({ length: failed }, (_, j) => [...rest.slice(0, failed - 1 - j), g, ...rest.slice(failed - 1 - j)]);
    const next = [[g, ...rest], [...rest, g], [...order].reverse(), ...earlier].map((o) => o.join(',')).find((k) => !tried.has(k));
    if (next === undefined) break;
    order = next.split(',').map(Number);
  }
  return { ok: false, reason: lastFailure, stopped: false };
}

