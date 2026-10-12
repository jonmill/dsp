// The proliferator network (Task 28): the spray coaters on the item nets' belts, and the feed belt that carries the
// proliferator past every one of them.
//
// The pattern is the capsule sample's (docs/research/blueprint-samples; geometry/coater.ts has the details): a coater
// stands on a node of a straight ground belt, turned along it; a belt one level up (z 1) crosses the item belt at a right
// angle at the node one step behind the coater, which is the coater's top passage. Nothing is linked to the coater.
//
// Bays. A coater needs a stretch no tap is on: producers before it, so that what they put on the belt is sprayed before a
// consumer takes it, and consumers after it, five nodes in a line (the coater's body reaches two nodes behind the one it
// stands on and one in front). Whether a routed net has such a stretch is a matter of luck, and on a large plan with the
// producers and consumers of a net standing close (Quantum Chip at margin 3: Copper Ingot, High-purity Silicon, Circuit Board;
// High-Explosive Shell Set: the lifts and bends between its stages) it often has none. So the stretch is made, not looked for
// (`placeBays`): once the item nets are routed, each sprayed net in turn gets a bay, three cells in a row, and is routed again
// through it (`BayRouter`), with every other net's cells closed to it. A bay is picked among the places where the five nodes
// and the cells above them at z 1 are free of every other net, of every tap point and the nodes a tap needs beside it, of the
// cells the sorters span and of the other bays, and of buildings at the coater's body in whichever way the belt passes (a coater
// is turned either way round), with room at z 1 beside the top passage for the feed to cross: first a stretch of the net's own
// route that is already straight between its last producer and its first consumer, else the nearest places to that stretch, the
// cheapest first, until the net is routed through one. A net that no place serves makes the placement fail, as a tap run
// that cannot be reached would, and the ladder goes on to a wider placement. The routes of the others are not touched, so the
// placement that routed without the bays still routes with them.
//
// Order. The item nets are routed first (`routeNets`); the feed (the netlist's `proliferator` net) is routed afterwards,
// because where it must go depends on where the coaters stand. Each bay offers a place or two for its coater (turned with the
// flow or against it: the top passage is the node before or the node after the one it stands on), each one `FeedOption`, and
// the feed takes the one it reaches cheapest.
import type { GameDataIndex } from '../data';
import { buildingDef, headingDeg, slotInfos, sorterTapEnds, sprayCoaterDef } from '../geometry';
import type { GridPoint, PlacedBuilding, SprayCoater, Yaw } from '../geometry';
import type { Netlist } from './netlist';
import type { Occupancy } from './occupancy';
import { coaterIdOf, placementBuildingIdOf } from './placement';
import type { Placement } from './placement';
import { sorterEndCells } from './power';
import { BayRouter, routeFeed } from './router';
import type { Bay, FeedOption, RouteParams, RoutedNet } from './router';
import type { TapAssignment } from './taps';

/** Heading indices of the router: 0 east, 1 north, 2 west, 3 south. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The search for a bay looks this far (tiles) beyond the box around the net's last producer and first consumer first, then
 * wider, then over the whole routing window, until it has `BAY_CANDIDATES` places: a bay near the stretch the belt has to cross
 * anyway costs little belt.
 */
const BAY_REACH = [6, 16, Infinity] as const;
/** Places for a bay the search gathers before it tries them, cheapest first. */
const BAY_CANDIDATES = 24;
/** ...and the most of them a net is routed through before it gives up, taken at least `BAY_SPACING` tiles apart where there are enough. */
const BAY_TRIES = 10;
const BAY_SPACING = 4;
/** What each node of another net beside a bay costs, in tiles of belt: a crowded stretch is a place the net cannot get out of. */
const CROWD_COST = 1;

/** One place a coater could stand. */
export interface Place {
  netId: number;
  node: number;
  yaw: Yaw;
}

export type FeedOutcome = { coaters: SprayCoater[]; route: RoutedNet } | { failed: string } | { stopped: true };
export type BayOutcome = { routes: RoutedNet[]; bays: Bay[] } | { failed: string } | { stopped: true };

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const flat = (x: number, y: number): string => `${x},${y}`;

/** A coater standing on the node `at`, with the belt passing it by `(dx, dy)` and the coater turned `back` (-1 with the flow, 1 against it). */
interface Spot {
  yaw: Yaw;
  /** The cells of the body along the belt: the node it stands on, the one in front, the top passage and the one behind that. */
  cells: { x: number; y: number }[];
  top: { x: number; y: number };
  /** The headings the feed may cross the top passage with, and those that leave a free cell after it too. */
  dirs: number[];
  through: number[];
}

/**
 * Whether a coater can stand on `at` for a belt passing it in direction `(dx, dy)`, turned `back`: nothing of `occ` in its
 * box, the top passage free for a belt at z 1 and a free cell at z 1 before it (and after it for `through`), the cells at z 1
 * in `used` aside. `net` names the coater (`coaterIdOf`).
 */
function spotAt(
  occ: Occupancy,
  itemId: number,
  netId: number,
  at: GridPoint | { x: number; y: number },
  dx: number,
  dy: number,
  back: -1 | 1,
  used: ReadonlySet<string> | undefined,
): Spot | undefined {
  const cells = [back * 2, back, 0, -back].map((j) => ({ x: at.x + j * dx, y: at.y + j * dy }));
  const taken = (c: { x: number; y: number }): boolean => used?.has(key(c.x, c.y, 1)) === true;
  // nothing else at z 1 over the body (the top cell included: the feed needs it)
  if (cells.some(taken)) return undefined;
  const yaw = (back < 0 ? headingDeg(dx, dy) : (headingDeg(dx, dy) + 180) % 360) as Yaw;
  const pose: PlacedBuilding = { id: coaterIdOf(netId), itemId, x: at.x, y: at.y, z: 0, yaw };
  if (occ.buildingCollides(pose)) return undefined;
  // the feed crosses the item belt at a right angle: which of the two ways is open (a free cell before it, and after it
  // for a coater the feed goes on from)
  const top = { x: at.x + back * dx, y: at.y + back * dy };
  if (occ.blockedForBelt(top.x, top.y, 1)) return undefined;
  const across = dx !== 0 ? [1, 3] : [0, 2];
  const open = (x: number, y: number): boolean => !occ.blockedForBelt(x, y, 1) && !used?.has(key(x, y, 1));
  const dirs = across.filter((h) => open(top.x - DX[h], top.y - DY[h]));
  if (dirs.length === 0) return undefined;
  const through = dirs.filter((h) => open(top.x + DX[h], top.y + DY[h]));
  return { yaw, cells, top, dirs, through };
}

/** The cells (z 0) of the sorters of `taps`, as "x,y": what a sorter spans is no place for a coater's body. */
function tapSorterCells(taps: TapAssignment, placement: Placement, data: GameDataIndex): Set<string> {
  const byId = new Map(placement.buildings.map((b) => [b.id, b]));
  const cells = new Set<string>();
  for (const t of taps.taps) {
    const b = byId.get(placementBuildingIdOf(t.machineId));
    if (!b) continue;
    const slot = slotInfos(b, buildingDef(data, b.itemId))[t.slot];
    if (!slot) continue;
    const { pick, drop } = sorterTapEnds(slot, t.point, t.dir);
    for (const c of sorterEndCells(pick, drop)) cells.add(c);
  }
  return cells;
}

/** A place for a bay, and what it costs the net: the belt between where its route is and the bay's two ends. */
interface Candidate {
  bay: Bay;
  /** The belt already runs through it, straight, after the last producer and before the first consumer: no new route needed. */
  onRoute: boolean;
  cost: number;
  near: number;
}

/**
 * Gives every net of `netlist` marked `sprayed` a bay (see the file comment) and routes it through it. `routes` are the item
 * nets' routes from `routeNets`, all of them; the result has the same nets, the sprayed ones through their bays. `params` are
 * the router's, as for the item nets (the routing window is `params.bounds`). Says why when a net has no place, or that
 * `shouldStop` stopped it.
 */
export function placeBays(
  netlist: Netlist,
  taps: TapAssignment,
  placement: Placement,
  routes: readonly RoutedNet[],
  occ: Occupancy,
  data: GameDataIndex,
  params: RouteParams,
  shouldStop: () => boolean,
): BayOutcome {
  const def = sprayCoaterDef(data);
  if (!def) return { failed: 'GameData has no spray coater' };
  const sprayed = netlist.nets.filter((n) => n.sprayed);
  if (sprayed.length === 0) return { routes: [...routes], bays: [] };

  // Cells no bay may take: the tap points and the nodes a tap needs beside them, the cells out of the station ports, the cells
  // the sorters span.
  const avoid = tapSorterCells(taps, placement, data);
  for (const t of taps.taps) {
    const [ux, uy] = t.axis === 'x' ? [1, 0] : [0, 1];
    for (const j of [-1, 0, 1]) avoid.add(flat(t.point.x + j * ux, t.point.y + j * uy));
  }
  for (const p of taps.stationPorts) {
    avoid.add(flat(p.point.x, p.point.y));
    avoid.add(flat(p.point.x + p.dir[0], p.point.y + p.dir[1]));
  }
  const window = {
    minX: Math.ceil(params.bounds.minX) + 2,
    maxX: Math.floor(params.bounds.maxX) - 2,
    minY: Math.ceil(params.bounds.minY) + 2,
    maxY: Math.floor(params.bounds.maxY) - 2,
  };

  const current = new Map(routes.map((r) => [r.netId, r.nodes]));
  /** Who holds each cell, "x,y,z": the item nets' nodes, and the cells above the bays chosen so far. */
  const holder = new Map<string, number>();
  const hold = (nodes: readonly GridPoint[], netId: number): void => {
    for (const p of nodes) holder.set(key(p.x, p.y, p.z), netId);
  };
  const release = (nodes: readonly GridPoint[]): void => {
    for (const p of nodes) holder.delete(key(p.x, p.y, p.z));
  };
  for (const r of routes) hold(r.nodes, r.netId);
  const rerouter = new BayRouter(netlist, taps, occ, params, shouldStop);
  const bays: Bay[] = [];

  for (const net of sprayed) {
    const nodes = current.get(net.id);
    if (!nodes || nodes.length === 0) return { failed: `net ${net.id} (item ${net.itemId}) has no route to put a spray coater on` };
    // where the belt is between its last producer and its first consumer
    let lastOut = 0;
    let firstIn = nodes.length - 1;
    for (const t of taps.taps) {
      if (t.netId !== net.id) continue;
      const at = nodes.findIndex((p) => p.z === 0 && p.x === t.point.x && p.y === t.point.y);
      if (at < 0) continue;
      if (t.dir === 'out') lastOut = Math.max(lastOut, at);
      else firstIn = Math.min(firstIn, at);
    }
    const from = nodes[Math.min(lastOut, nodes.length - 1)];
    const to = nodes[Math.max(firstIn, 0)];

    const free = (bay: Bay): boolean =>
      bay.held.every((h) => !holder.has(key(h.x, h.y, h.z))) &&
      bay.cells.every((c) => holder.get(key(c.x, c.y, 0)) === undefined || holder.get(key(c.x, c.y, 0)) === net.id);
    // the nodes of other nets in the block round the bay: the more, the less room the belt has to get in and out
    const crowd = (bay: Bay): number => {
      const [ux, uy] = bay.axis === 'x' ? [1, 0] : [0, 1];
      const m = bay.cells[1];
      let n = 0;
      for (let a = -3; a <= 3; a++) {
        for (let b = -1; b <= 1; b++) {
          const owner = holder.get(key(m.x + a * ux + b * uy, m.y + a * uy + b * ux, 0));
          if (owner !== undefined && owner !== net.id) n++;
        }
      }
      return n;
    };
    const search: Search = { netId: net.id, coaterItemId: def.itemId, occ, avoid, window, chosen: bays, free, crowd, nodes, lastOut, firstIn };
    // the stretches of the route that are straight already first, and only then the places near it
    const tried: Candidate[] = [];
    let placed: Bay | undefined;
    for (const wave of [() => bayOnRoute(search), () => spread(bayNearby(search, from, to))]) {
      const candidates = wave();
      tried.push(...candidates);
      for (const cand of candidates) {
        if (shouldStop()) return { stopped: true };
        if (!cand.onRoute) {
          const closed: GridPoint[] = [...cand.bay.held];
          for (const [k, owner] of holder) {
            if (owner === net.id) continue;
            const [x, y, z] = k.split(',').map(Number);
            closed.push({ x, y, z });
          }
          const out = rerouter.route(net.id, cand.bay, closed, nodes);
          if (out === 'stopped') return { stopped: true };
          if (!out) continue;
          release(nodes);
          current.set(net.id, out);
          hold(out, net.id);
        }
        placed = cand.bay;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      return { failed: `no place for the spray coater of net ${net.id} (item ${net.itemId}): none of ${tried.length} places that the cells of the other nets leave could be routed through` };
    }
    bays.push(placed);
    for (const h of placed.held) holder.set(key(h.x, h.y, h.z), net.id);
  }
  return { routes: routes.map((r) => ({ netId: r.netId, nodes: current.get(r.netId) ?? r.nodes })), bays };
}

/** Everything the search for the places of one net's bay shares. */
interface Search {
  netId: number;
  coaterItemId: number;
  occ: Occupancy;
  avoid: ReadonlySet<string>;
  window: { minX: number; maxX: number; minY: number; maxY: number };
  chosen: readonly Bay[];
  free: (bay: Bay) => boolean;
  crowd: (bay: Bay) => number;
  /** The route of the net, and the nodes of it that bound the stretch between its last producer and its first consumer. */
  nodes: readonly GridPoint[];
  lastOut: number;
  firstIn: number;
}

/**
 * The places for the bay of the net on its own route, the nearest the last producer first: straight runs of five ground
 * nodes between its last producer (index `lastOut`) and its first consumer (`firstIn`) that are free. No new route is
 * needed for them.
 */
function bayOnRoute(q: Search): Candidate[] {
  const { nodes } = q;
  const out: Candidate[] = [];
  for (let k = q.lastOut + 3; k <= q.firstIn - 3 && k + 2 < nodes.length; k++) {
    const dx = nodes[k + 1].x - nodes[k].x;
    const dy = nodes[k + 1].y - nodes[k].y;
    if ((dx === 0) === (dy === 0)) continue;
    let straight = true;
    for (let j = -2; j <= 2 && straight; j++) {
      const n = nodes[k + j];
      straight = n.z === 0 && n.x === nodes[k].x + j * dx && n.y === nodes[k].y + j * dy;
    }
    if (!straight) continue;
    const axis = dx !== 0 ? 'x' : 'y';
    const bay = bayAt(nodes[k].x, nodes[k].y, axis, q.netId, q.coaterItemId, q.occ, q.avoid, q.chosen);
    if (!bay) continue;
    const sign = (axis === 'x' ? dx : dy) > 0 ? 1 : -1;
    if (!bay.signs.includes(sign)) continue;
    const onRoute: Bay = { ...bay, signs: [sign] };
    if (!q.free(onRoute)) continue;
    out.push({ bay: onRoute, onRoute: true, cost: 0, near: k - q.lastOut });
  }
  return out.sort((a, b) => a.near - b.near);
}

/**
 * The places near the stretch between `from` and `to`, the cheapest first: the belt from `from` to the bay's near end and from
 * its far end to `to`, and `CROWD_COST` for every node of another net in the block round the bay. Looks further out until it
 * has found `BAY_TRIES` of them.
 */
function bayNearby(q: Search, from: GridPoint, to: GridPoint): Candidate[] {
  const off: Candidate[] = [];
  for (const reach of BAY_REACH) {
    off.length = 0;
    const x0 = Math.max(q.window.minX, Math.min(from.x, to.x) - reach);
    const x1 = Math.min(q.window.maxX, Math.max(from.x, to.x) + reach);
    const y0 = Math.max(q.window.minY, Math.min(from.y, to.y) - reach);
    const y1 = Math.min(q.window.maxY, Math.max(from.y, to.y) + reach);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const axis of ['x', 'y'] as const) {
          const [ux, uy] = axis === 'x' ? [1, 0] : [0, 1];
          // a lower bound first: most cells cannot make the best few
          const near = Math.abs(from.x - x) + Math.abs(from.y - y);
          const lower = near + Math.abs(x - to.x) + Math.abs(y - to.y) - 4;
          if (off.length >= BAY_CANDIDATES && lower >= off[off.length - 1].cost) continue;
          const bay = bayAt(x, y, axis, q.netId, q.coaterItemId, q.occ, q.avoid, q.chosen);
          if (!bay || !q.free(bay)) continue;
          const cost =
            Math.min(...bay.signs.map((s) => Math.abs(from.x - (x - 2 * s * ux)) + Math.abs(from.y - (y - 2 * s * uy)) + Math.abs(x + 2 * s * ux - to.x) + Math.abs(y + 2 * s * uy - to.y))) +
            CROWD_COST * q.crowd(bay);
          off.push({ bay, onRoute: false, cost, near });
          off.sort((a, b) => a.cost - b.cost || a.near - b.near);
          if (off.length > BAY_CANDIDATES) off.pop();
        }
      }
    }
    if (off.length >= BAY_TRIES) break;
  }
  return off;
}

/** The candidates in the order they are tried: the route's own straight stretches, then the cheapest, no two within `BAY_SPACING` tiles while others are left. */
function spread(candidates: readonly Candidate[]): Candidate[] {
  const picked: Candidate[] = [];
  const rest: Candidate[] = [];
  const mid = (c: Candidate) => c.bay.cells[1];
  for (const c of candidates) {
    if (picked.length < BAY_TRIES && picked.every((p) => Math.abs(mid(p).x - mid(c).x) + Math.abs(mid(p).y - mid(c).y) >= BAY_SPACING)) picked.push(c);
    else rest.push(c);
  }
  return [...picked, ...rest].slice(0, BAY_TRIES);
}

/** The bay of net `netId` on the five nodes around `(x, y)` along `axis`, if they and the coater's body are free; undefined if not. */
function bayAt(
  x: number,
  y: number,
  axis: 'x' | 'y',
  netId: number,
  coaterItemId: number,
  occ: Occupancy,
  avoid: ReadonlySet<string>,
  chosen: readonly Bay[],
): Bay | undefined {
  const [ux, uy] = axis === 'x' ? [1, 0] : [0, 1];
  const line = [-2, -1, 0, 1, 2].map((j) => ({ x: x + j * ux, y: y + j * uy }));
  for (const c of line) {
    if (avoid.has(flat(c.x, c.y)) || occ.blockedForBelt(c.x, c.y, 0)) return undefined;
  }
  // two bays share no node, and no coater's body reaches another's
  for (const other of chosen) {
    for (const o of other.cells) for (const c of line) if (Math.abs(o.x - c.x) + Math.abs(o.y - c.y) <= 2 && (o.x === c.x || o.y === c.y)) return undefined;
  }
  // a coater the feed goes on from needs a free cell at z 1 on both sides of its top passage: a bay where no way round has one
  // could only be the feed's last stop
  const signs = ([1, -1] as const).filter((s) =>
    ([-1, 1] as const).some((back) => (spotAt(occ, coaterItemId, netId, { x, y }, s * ux, s * uy, back, undefined)?.through.length ?? 0) > 0),
  );
  if (signs.length === 0) return undefined;
  // z 1: the body, and the cells beside the two nodes either side of the coater's, from where the feed reaches the top passage
  const held: GridPoint[] = line.map((c) => ({ x: c.x, y: c.y, z: 1 }));
  for (const j of [-1, 1]) {
    held.push({ x: x + j * ux + uy, y: y + j * uy + ux, z: 1 }, { x: x + j * ux - uy, y: y + j * uy - ux, z: 1 });
  }
  return { netId, axis, cells: line.slice(1, 4), signs: [...signs], held };
}

/**
 * The places a coater of `net` could stand on its bay `bay`, as options for the feed, for the route `nodes` the net got (the
 * belt passes the bay in the direction the router chose). `places` collects what each option means (its tag is its position
 * there). Says why when the route does not pass the bay in a line.
 */
function bayOptions(
  netId: number,
  bay: Bay,
  nodes: readonly GridPoint[],
  occ: Occupancy,
  used: ReadonlySet<string>,
  coaterDefItemId: number,
  places: Place[],
): FeedOption[] | string {
  const mid = bay.cells[1];
  const k = nodes.findIndex((p) => p.z === 0 && p.x === mid.x && p.y === mid.y);
  if (k < 2 || k > nodes.length - 3) return `the route of net ${netId} does not pass the middle of its bay at (${mid.x}, ${mid.y})`;
  const dx = nodes[k + 1].x - nodes[k].x;
  const dy = nodes[k + 1].y - nodes[k].y;
  for (let j = -2; j <= 2; j++) {
    const n = nodes[k + j];
    if (n.z !== 0 || n.x !== mid.x + j * dx || n.y !== mid.y + j * dy) return `the route of net ${netId} does not run straight through its bay at (${mid.x}, ${mid.y})`;
  }
  const options: FeedOption[] = [];
  for (const back of [-1, 1] as const) {
    const spot = spotAt(occ, coaterDefItemId, netId, mid, dx, dy, back, used);
    if (!spot) continue;
    const tag = places.length;
    places.push({ netId, node: k, yaw: spot.yaw });
    options.push({
      x: spot.top.x,
      y: spot.top.y,
      dirs: spot.dirs,
      through: spot.through,
      body: spot.cells.filter((c) => !(c.x === spot.top.x && c.y === spot.top.y)).map((c) => ({ x: c.x, y: c.y, z: 1 })),
      tag,
    });
  }
  return options;
}

/**
 * Places a spray coater on the bay of every sprayed net and routes the feed through their top passages. `routes` are the item
 * nets' routes (every net of `netlist` but the feed, each through its bay); `occ` holds the placed buildings. `params` are the
 * router's, as for the item nets. Says why when it cannot, or that `shouldStop` stopped it.
 */
export function feedProliferator(
  netlist: Netlist,
  taps: TapAssignment,
  routes: readonly RoutedNet[],
  bays: readonly Bay[],
  occ: Occupancy,
  params: RouteParams,
  data: GameDataIndex,
  shouldStop: () => boolean,
): FeedOutcome {
  const feed = netlist.nets.find((n) => n.proliferator);
  if (!feed) return { failed: 'the netlist has no proliferator net' };
  const def = sprayCoaterDef(data);
  if (!def) return { failed: 'GameData has no spray coater' };
  const port = taps.stationPorts.find((p) => p.netId === feed.id && p.end === 'source');
  if (!port) return { failed: `the proliferator net ${feed.id} has no station port` };

  const routeOf = new Map(routes.map((r) => [r.netId, r.nodes]));
  const bayOf = new Map(bays.map((b) => [b.netId, b]));
  const used = new Set<string>();
  for (const r of routes) for (const p of r.nodes) used.add(key(p.x, p.y, p.z));

  const places: Place[] = [];
  const groups: FeedOption[][] = [];
  for (const net of netlist.nets) {
    if (!net.sprayed) continue;
    const nodes = routeOf.get(net.id);
    const bay = bayOf.get(net.id);
    if (!nodes || nodes.length === 0) return { failed: `net ${net.id} has no route to put a spray coater on` };
    if (!bay) return { failed: `net ${net.id} (item ${net.itemId}) has no bay for a spray coater` };
    const options = bayOptions(net.id, bay, nodes, occ, used, def.itemId, places);
    if (typeof options === 'string') return { failed: options };
    if (options.length === 0) return { failed: `no place for a spray coater on net ${net.id} (item ${net.itemId}): its bay is taken at z 1` };
    groups.push(options);
  }

  const taken = routes.flatMap((r) => r.nodes);
  const routed = routeFeed(port, groups, taken, occ, params, shouldStop);
  if (!routed.ok) {
    if (routed.stopped) return { stopped: true };
    return { failed: `the proliferator belt cannot be routed: ${routed.reason}` };
  }
  const coaters: SprayCoater[] = routed.chosen
    .map((tag) => places[tag])
    .sort((a, b) => a.netId - b.netId)
    .map((pl) => ({ id: coaterIdOf(pl.netId), beltId: pl.netId, node: pl.node, yaw: pl.yaw }));
  return { coaters, route: { netId: feed.id, nodes: routed.nodes } };
}
