// The proliferator network (Task 28): the spray coaters on the item nets' belts, and the feed belt that carries the
// proliferator past every one of them.
//
// The pattern is the capsule sample's (docs/research/blueprint-samples; geometry/coater.ts has the details): a coater
// stands on a node of a straight ground belt, turned along it; a belt one level up (z 1) crosses the item belt at a right
// angle at the node one step behind the coater, which is the coater's top passage. Nothing is linked to the coater.
//
// Order. The item nets are routed first (`routeNets`); the feed (the netlist's `proliferator` net) is routed afterwards,
// because where it must go depends on where the coaters stand, and where they can stand depends on the item routes.
//
// Where a coater can stand (`coaterOptions`). On a net marked `sprayed`, on a node `k` of its route that has a straight
// ground run around it: the node itself and the ones either side (the top passage is over one of them), and the belt keeps
// to the same line for one more node each way where it goes on, so that no segment of it leaves the coater's body sideways.
// The coater's back reaches 1.75 tiles behind it, which the validator's belt width rounds to two nodes: the cell two nodes
// behind may be no node of the belt at all (it starts or ends there). There are two ways round: turned with the flow (top
// passage over the node before, back to the upstream) or against it (over the node after). The body must be free of
// everything else the validator would hold against a building:
//  - no tap of the net (a sorter beside the coater's body), producers before and consumers after it, so what the producers
//    put on the belt is sprayed before it reaches a consumer;
//  - no sorter of any net on the body's cells, and no building box over the coater's (`Occupancy.buildingCollides`);
//  - no other net's belt at z 1 over the body, and the top cell free of buildings and of other nets at z 1, with a free cell
//    on at least one side of it for the feed to cross.
// A net may offer many such places; each is one `FeedOption`, and the feed takes the one it reaches cheapest.
import type { GameDataIndex } from '../data';
import { headingDeg, sprayCoaterDef } from '../geometry';
import type { GridPoint, SprayCoater, Yaw } from '../geometry';
import type { BeltNet, Netlist } from './netlist';
import type { Occupancy } from './occupancy';
import { coaterIdOf } from './placement';
import { routeFeed } from './router';
import type { FeedOption, RouteParams, RoutedNet } from './router';
import type { TapAssignment } from './taps';

/** At most this many places per coater go to the search (spread along the allowed stretch): each is a goal it measures. */
const MAX_OPTIONS_PER_NET = 64;

/** Heading indices of the router: 0 east, 1 north, 2 west, 3 south. */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** One place a coater could stand. */
export interface Place {
  netId: number;
  node: number;
  yaw: Yaw;
}

export type FeedOutcome = { coaters: SprayCoater[]; route: RoutedNet } | { failed: string } | { stopped: true };

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * The places a coater of net `net` could stand, as options for the feed. `places` collects what each option means (its tag
 * is its position there). See the file comment for the rules.
 */
export function coaterOptions(
  net: BeltNet,
  nodes: readonly GridPoint[],
  taps: TapAssignment,
  occ: Occupancy,
  sorterCells: ReadonlySet<string>,
  used: ReadonlySet<string>,
  coaterDefItemId: number,
  places: Place[],
): FeedOption[] {
  // where the taps of the net are on the route
  let lastOut = -Infinity;
  let firstIn = Infinity;
  for (const t of taps.taps) {
    if (t.netId !== net.id) continue;
    const at = nodes.findIndex((p) => p.z === 0 && p.x === t.point.x && p.y === t.point.y);
    if (at < 0) continue;
    if (t.dir === 'out') lastOut = Math.max(lastOut, at);
    else firstIn = Math.min(firstIn, at);
  }

  const options: FeedOption[] = [];
  for (let k = 1; k < nodes.length - 1; k++) {
    const dx = nodes[k + 1].x - nodes[k].x;
    const dy = nodes[k + 1].y - nodes[k].y;
    if (nodes[k].z !== 0 || (dx === 0) === (dy === 0)) continue; // a flat step along an axis
    // turned with the flow, the top passage is over the node before it; against the flow, over the node after
    for (const back of [-1, 1] as const) {
      // the coater's body reaches two nodes behind the one it stands on (its back) and one in front; taps stay out of that
      // stretch, producers before it and consumers after it
      const zone = [k + 2 * back, k, k - back];
      const lo = Math.min(...zone);
      const hi = Math.max(...zone);
      if (lastOut >= lo || firstIn <= hi) continue;
      // The run it stands on: the node itself and one each side, straight and on the ground, and the belt goes on along the same
      // line at both ends (a segment that left the body sideways would cross its wall): the nodes two either side, where there
      // are any, are on it too.
      if (!straightRun(nodes, Math.max(0, k - 2), Math.min(nodes.length - 1, k + 2), dx, dy)) continue;
      // The cells of the body along the axis: the node, the one in front, the top passage and the one behind that. The last
      // is a node of the run, or no node at all (the belt starts or ends there), in which case nothing else may take it.
      const cells = [back * 2, back, 0, -back].map((j) => ({ x: nodes[k].x + j * dx, y: nodes[k].y + j * dy }));
      const rear = cells[0];
      if (nodes[k + 2 * back] === undefined && (used.has(key(rear.x, rear.y, 0)) || used.has(key(rear.x, rear.y, 1)))) continue;
      if (cells.some((c) => sorterCells.has(`${c.x},${c.y}`))) continue;
      // nothing else at z 1 over the body (the top cell included: the feed needs it)
      if (cells.some((c) => used.has(key(c.x, c.y, 1)))) continue;

      const yaw = (back < 0 ? headingDeg(dx, dy) : (headingDeg(dx, dy) + 180) % 360) as Yaw;
      const pose = { id: coaterIdOf(net.id), itemId: coaterDefItemId, x: nodes[k].x, y: nodes[k].y, z: 0, yaw };
      if (occ.buildingCollides(pose)) continue;

      // the feed crosses the item belt at a right angle: which of the two ways is open (a free cell before it, and after it
      // for a coater the feed goes on from)
      const top = nodes[k + back];
      const across = dx !== 0 ? [1, 3] : [0, 2];
      const open = (x: number, y: number): boolean => !occ.blockedForBelt(x, y, 1) && !used.has(key(x, y, 1));
      if (occ.blockedForBelt(top.x, top.y, 1)) continue;
      const dirs = across.filter((h) => open(top.x - DX[h], top.y - DY[h]));
      if (dirs.length === 0) continue;
      const through = dirs.filter((h) => open(top.x + DX[h], top.y + DY[h]));

      const tag = places.length;
      places.push({ netId: net.id, node: k, yaw });
      options.push({
        x: top.x,
        y: top.y,
        dirs,
        through,
        body: cells.filter((c) => !(c.x === top.x && c.y === top.y)).map((c) => ({ x: c.x, y: c.y, z: 1 })),
        tag,
      });
    }
  }
  return thin(options);
}

/** Nodes `lo..hi` are on the ground and each is the flat step `(dx, dy)` after the one before (nothing to check if `hi < lo`). */
function straightRun(nodes: readonly GridPoint[], lo: number, hi: number, dx: number, dy: number): boolean {
  for (let i = lo; i <= hi; i++) {
    if (nodes[i].z !== 0) return false;
    if (i > lo && (nodes[i].x - nodes[i - 1].x !== dx || nodes[i].y - nodes[i - 1].y !== dy)) return false;
  }
  return true;
}

/** Evenly spread `MAX_OPTIONS_PER_NET` of `options`, the first and the last among them. */
function thin(options: FeedOption[]): FeedOption[] {
  if (options.length <= MAX_OPTIONS_PER_NET) return options;
  const out: FeedOption[] = [];
  for (let i = 0; i < MAX_OPTIONS_PER_NET; i++) out.push(options[Math.round((i * (options.length - 1)) / (MAX_OPTIONS_PER_NET - 1))]);
  return out;
}

/**
 * Places a spray coater on every sprayed net and routes the feed through their top passages. `routes` are the item nets'
 * routes (every net of `netlist` but the feed); `occ` holds the placed buildings; `sorterCells` are the lattice cells the
 * sorters take (`sorterGeometry`). `params` are the router's, as for the item nets. Says why when it cannot, or that
 * `shouldStop` stopped it.
 */
export function feedProliferator(
  netlist: Netlist,
  taps: TapAssignment,
  routes: readonly RoutedNet[],
  occ: Occupancy,
  sorterCells: ReadonlySet<string>,
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
  const used = new Set<string>();
  for (const r of routes) for (const p of r.nodes) used.add(key(p.x, p.y, p.z));

  const places: Place[] = [];
  const groups: FeedOption[][] = [];
  for (const net of netlist.nets) {
    if (!net.sprayed) continue;
    const nodes = routeOf.get(net.id);
    if (!nodes) return { failed: `net ${net.id} has no route to put a spray coater on` };
    const options = coaterOptions(net, nodes, taps, occ, sorterCells, used, def.itemId, places);
    if (options.length === 0) return { failed: `no place for a spray coater on net ${net.id} (item ${net.itemId}): no straight run clear of taps, sorters and buildings` };
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
