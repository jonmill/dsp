// Placement: where the stations and machines of a netlist stand (Task 21). Belts, sorters and poles come later; the
// placement leaves them room.
//
// Buildings. All buildings stand at whole grid coordinates (x and y integers, z 0), turned by quarter turns. Ids are
// fixed so the later tasks can find a building without a lookup table: station `i` of the netlist is building
// `stationBuildingId(i)` (1..S) and the machine with netlist id `m` is building `placementBuildingIdOf(m)`. A machine
// carries `recipeId` and `role: 'stage:<stageIndex>'` (the capacity check and the simulator map buildings to plan
// stages by role); a station carries `role: 'station:<index>'` and no `StationConfig` yet (its ports are assigned
// when the belts are routed).
//
// Margin. For building-against-building collision every footprint counts as grown by `margin` tiles, so two buildings
// need `2 * margin` tiles between them. With `margin >= 1` there is always a lattice line for a belt, and room for
// the sorters on both sides of it, between neighbours. The grown footprint keeps square corners.
//
// Cost. `weights.area * area + weights.wire * wire`. `area` is the bounding box of all footprints, in tiles squared.
// `wire` is the sum over the nets of the half perimeter of the box around the centres of the machines it taps (the
// centre of a machine's footprint), plus, when the net starts or ends at a station, the distance from that box to the
// nearest of the station's belt ports (the lattice point a belt leaves it from). Taking the nearest port is the best
// a router could do for that net alone, so the term is optimistic when several nets want the same port.
import type { GameDataIndex } from '../data';
import { buildingDef, obbOverlap, portInfos } from '../geometry';
import type { PlacedBuilding, Yaw } from '../geometry';
import type { Netlist } from './netlist';
import { Occupancy } from './occupancy';
import { Rng } from './rng';

export interface PlacementParams {
  /** Tiles every footprint is grown by during placement (see the file comment). */
  margin: number;
  seed: number;
  /** Moves tried. */
  iterations: number;
  /** Temperature at the first move, in cost units: a move that costs this much is accepted with probability 1/e. */
  startTemp: number;
  weights: { area: number; wire: number };
}
/** Stations and machines; no belts, sorters or poles yet. `cost` is under the weights of the call that made it. */
export interface Placement {
  buildings: PlacedBuilding[];
  cost: number;
}

/** What `constructivePlacement` weighs its cost with. */
export const DEFAULT_PLACEMENT_WEIGHTS = { area: 1, wire: 1 } as const;

/** A machine's building id is its netlist id plus this; station buildings take 1..S below it. */
export const MACHINE_ID_OFFSET = 1000;

/** The building id of station `stationIdx` of the netlist. */
export function stationBuildingId(stationIdx: number): number {
  return stationIdx + 1;
}
/** The building id of the machine with netlist id `machineId`. */
export function placementBuildingIdOf(machineId: number): number {
  return machineId + MACHINE_ID_OFFSET;
}
/** The netlist machine id behind a building id; undefined for a station. */
export function machineIdOfBuilding(buildingId: number): number | undefined {
  return buildingId > MACHINE_ID_OFFSET ? buildingId - MACHINE_ID_OFFSET : undefined;
}

const YAWS: readonly Yaw[] = [0, 90, 180, 270];
/** Float noise allowance when rounding a coordinate up to the next whole tile. */
const SNAP_EPS = 1e-9;
/** Clear tiles between rows of machines, beyond the margins: room for the belts that run along the row. */
const CHANNEL_TILES = 3;

function checkMargin(margin: number): void {
  if (!Number.isFinite(margin) || margin < 0) throw new RangeError(`margin must be a number of at least 0, got ${margin}`);
}

// ---------------------------------------------------------------------------------------------
// Cost

interface Point {
  x: number;
  y: number;
}

/** The nets as indices: which machines each taps, which stations it ends at (their candidate port points). */
interface WireModel {
  /** Per net, indices into `Netlist.machines`. */
  taps: number[][];
  /** Per net, for each station it starts or ends at, that station's port points. */
  ends: Point[][][];
  /** Per machine, the nets that tap it. */
  netsOf: number[][];
}

/** Where belts leave a station: the first lattice point outside along each port (the building centre if it has none). */
function stationPortPoints(b: PlacedBuilding, data: GameDataIndex): Point[] {
  const infos = portInfos(b, buildingDef(data, b.itemId));
  return infos.length > 0 ? infos.map((i) => i.firstOutside) : [{ x: b.x, y: b.y }];
}

function buildWireModel(net: Netlist, stationBuilding: (idx: number) => PlacedBuilding, data: GameDataIndex): WireModel {
  const indexOfMachine = new Map(net.machines.map((m, k) => [m.id, k] as const));
  const ports = new Map<number, Point[]>();
  const portsOf = (net_: number, idx: number): Point[] => {
    if (!Number.isInteger(idx) || idx < 0 || idx >= net.stations.length) {
      throw new Error(`net ${net_} starts or ends at station ${idx}, which the netlist does not have`);
    }
    let list = ports.get(idx);
    if (!list) {
      list = stationPortPoints(stationBuilding(idx), data);
      ports.set(idx, list);
    }
    return list;
  };

  const model: WireModel = { taps: [], ends: [], netsOf: net.machines.map(() => []) };
  net.nets.forEach((n, netIdx) => {
    const taps: number[] = [];
    for (const tap of n.taps) {
      const k = indexOfMachine.get(tap.machineId);
      if (k === undefined) throw new Error(`net ${n.id} taps machine ${tap.machineId}, which the netlist does not have`);
      if (!taps.includes(k)) {
        taps.push(k);
        model.netsOf[k].push(netIdx);
      }
    }
    const ends: Point[][] = [];
    if (n.source.kind === 'station') ends.push(portsOf(n.id, n.source.stationIdx));
    if (n.sink.kind === 'station') ends.push(portsOf(n.id, n.sink.stationIdx));
    model.taps.push(taps);
    model.ends.push(ends);
  });
  return model;
}

/** Half perimeter of the box around the tapped machine centres, plus the distance to the nearest port of each end. */
function netWire(taps: number[], ends: Point[][], cx: ArrayLike<number>, cy: ArrayLike<number>): number {
  if (taps.length === 0) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const k of taps) {
    const x = cx[k];
    const y = cy[k];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let wire = maxX - minX + (maxY - minY);
  for (const points of ends) {
    let nearest = Infinity;
    for (const p of points) {
      const d = Math.max(0, minX - p.x, p.x - maxX) + Math.max(0, minY - p.y, p.y - maxY);
      if (d < nearest) nearest = d;
    }
    wire += nearest;
  }
  return wire;
}

function checkWeights(weights: { area: number; wire: number }): void {
  for (const [name, w] of [['area', weights.area], ['wire', weights.wire]] as const) {
    if (!Number.isFinite(w) || w < 0) throw new RangeError(`the ${name} weight must be a number of at least 0, got ${w}`);
  }
}

/**
 * The cost of a placement of `net`: `weights.area * area + weights.wire * wire` (see the file comment). Every machine
 * and every station a net ends at must be among `buildings`; any other building only counts towards the area.
 */
export function placementCost(
  net: Netlist,
  data: GameDataIndex,
  buildings: readonly PlacedBuilding[],
  weights: { area: number; wire: number },
): number {
  checkWeights(weights);
  const occ = new Occupancy(data);
  const byId = new Map(buildings.map((b) => [b.id, b] as const));
  const n = net.machines.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  net.machines.forEach((m, k) => {
    const b = byId.get(placementBuildingIdOf(m.id));
    if (!b) throw new Error(`placementCost: the placement has no building for machine ${m.id}`);
    const fp = occ.footprintOf(b.itemId, b.yaw);
    cx[k] = b.x + (fp.minX + fp.maxX) / 2;
    cy[k] = b.y + (fp.minY + fp.maxY) / 2;
  });
  const model = buildWireModel(
    net,
    (idx) => {
      const b = byId.get(stationBuildingId(idx));
      if (!b) throw new Error(`placementCost: the placement has no building for station ${idx}`);
      return b;
    },
    data,
  );
  let wire = 0;
  for (let i = 0; i < model.taps.length; i++) wire += netWire(model.taps[i], model.ends[i], cx, cy);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of buildings) {
    const fp = occ.footprintOf(b.itemId, b.yaw);
    minX = Math.min(minX, b.x + fp.minX);
    maxX = Math.max(maxX, b.x + fp.maxX);
    minY = Math.min(minY, b.y + fp.minY);
    maxY = Math.max(maxY, b.y + fp.maxY);
  }
  const area = buildings.length > 0 ? (maxX - minX) * (maxY - minY) : 0;
  return weights.area * area + weights.wire * wire;
}

// ---------------------------------------------------------------------------------------------
// Constructive placement

/**
 * A deterministic first placement: the stations in a column at the origin (the first one centred on it), the machines
 * to their right in rows along +x, filled stage by stage in machine id order. A stage stays in one row when it fits
 * the row's width. Rows are stacked upwards from the bottom of the stations, with `2 * margin + 3` tiles of clear
 * channel between a row and the next; neighbours in a row are `2 * margin` apart, and the machines start
 * `2 * margin + 3` tiles right of the stations. The row width is chosen so the block comes out roughly square.
 * Footprints are treated as their bounding rectangles, so buildings of any size never overlap, whatever the margin.
 * The cost is under `DEFAULT_PLACEMENT_WEIGHTS`.
 */
export function constructivePlacement(net: Netlist, data: GameDataIndex, margin: number): Placement {
  checkMargin(margin);
  if (net.stations.length >= MACHINE_ID_OFFSET) {
    throw new RangeError(`a netlist with ${net.stations.length} stations does not fit the building id scheme`);
  }
  const occ = new Occupancy(data);
  const gap = 2 * margin;
  const channel = 2 * margin + CHANNEL_TILES;
  const buildings: PlacedBuilding[] = [];

  // stations: a column, bottom to top
  let stationsRight = -Infinity;
  let stationsBottom = Infinity;
  let top = -Infinity;
  net.stations.forEach((st, i) => {
    const fp = occ.footprintOf(st.buildingItemId, 0);
    const y = i === 0 ? 0 : Math.ceil(top + channel - fp.minY - SNAP_EPS);
    buildings.push({ id: stationBuildingId(i), itemId: st.buildingItemId, x: 0, y, z: 0, yaw: 0, role: `station:${i}` });
    stationsRight = Math.max(stationsRight, fp.maxX);
    stationsBottom = Math.min(stationsBottom, y + fp.minY);
    top = y + fp.maxY;
  });
  const left = net.stations.length > 0 ? Math.ceil(stationsRight + channel - SNAP_EPS) : 0;
  const bottom = net.stations.length > 0 ? stationsBottom : 0;

  // machines: grouped by stage, in rows
  const stages = new Map<number, (typeof net.machines)[number][]>();
  for (const m of net.machines) {
    const list = stages.get(m.stageIndex);
    if (list) list.push(m);
    else stages.set(m.stageIndex, [m]);
  }
  const footprint = (itemId: number) => occ.footprintOf(itemId, 0);
  const pitch = (itemId: number): number => {
    const fp = footprint(itemId);
    return fp.maxX - fp.minX + gap;
  };
  let pitchSum = 0;
  let heightSum = 0;
  let widest = 0;
  for (const m of net.machines) {
    const fp = footprint(m.buildingItemId);
    pitchSum += pitch(m.buildingItemId);
    heightSum += fp.maxY - fp.minY;
    widest = Math.max(widest, pitch(m.buildingItemId));
  }
  // rows of width L and mean height h hold pitchSum / L rows: square when L^2 = pitchSum * (h + channel)
  const meanHeight = net.machines.length > 0 ? heightSum / net.machines.length : 0;
  const rowWidth = Math.max(widest - gap, Math.ceil(Math.sqrt(pitchSum * (meanHeight + channel))));

  let rowBottom = bottom;
  let rowTop = -Infinity;
  let cursor = left;
  let inRow = 0;
  const newRow = (): void => {
    rowBottom = rowTop + channel;
    rowTop = -Infinity;
    cursor = left;
    inRow = 0;
  };
  const xFor = (fp: { minX: number }): number => Math.ceil(cursor - fp.minX - SNAP_EPS);
  for (const stage of [...stages.keys()].sort((a, b) => a - b)) {
    const machines = stages.get(stage) as (typeof net.machines)[number][];
    const stageWidth = machines.reduce((w, m) => w + pitch(m.buildingItemId), 0) - gap;
    if (inRow > 0 && cursor + stageWidth > left + rowWidth && stageWidth <= rowWidth) newRow();
    for (const m of machines) {
      const fp = footprint(m.buildingItemId);
      let x = xFor(fp);
      if (inRow > 0 && x + fp.maxX > left + rowWidth) {
        newRow();
        x = xFor(fp);
      }
      const y = Math.ceil(rowBottom - fp.minY - SNAP_EPS);
      buildings.push({
        id: placementBuildingIdOf(m.id),
        itemId: m.buildingItemId,
        x,
        y,
        z: 0,
        yaw: 0,
        recipeId: m.recipeId,
        role: `stage:${m.stageIndex}`,
      });
      rowTop = Math.max(rowTop, y + fp.maxY);
      cursor = x + fp.maxX + gap;
      inRow++;
    }
  }
  return { buildings, cost: placementCost(net, data, buildings, DEFAULT_PLACEMENT_WEIGHTS) };
}

// ---------------------------------------------------------------------------------------------
// Annealing

/** `shouldStop` is asked every this many moves (and before the first). */
const STOP_CHECK_EVERY = 256;
/** The temperature at the last move, as a share of `startTemp`. */
const FINAL_TEMP_RATIO = 1e-3;
/** A single-machine or whole-stage move shifts by 1..this many tiles per axis. */
const MAX_STEP = 4;
/** The summed wire length is recomputed from the per-net lengths this often, against drift. */
const RESYNC_EVERY = 1 << 16;
/** A better cost has to win by this much to replace the best so far (float noise). */
const IMPROVEMENT_EPS = 1e-9;

// move mix, as cumulative shares: translate one machine, swap two, rotate one, translate a stage
const P_TRANSLATE = 0.55;
const P_SWAP = 0.75;
const P_ROTATE = 0.85;

function checkParams(p: PlacementParams): void {
  checkMargin(p.margin);
  if (!Number.isInteger(p.iterations) || p.iterations < 0) {
    throw new RangeError(`iterations must be a whole number of at least 0, got ${p.iterations}`);
  }
  if (!Number.isFinite(p.startTemp) || p.startTemp <= 0) {
    throw new RangeError(`startTemp must be a number above 0, got ${p.startTemp}`);
  }
  checkWeights(p.weights);
}

/**
 * Improves `init` by simulated annealing and returns the best placement seen (never worse than `init`, which
 * must be collision free at `p.margin`; it is not modified). The stations stay where they are. Moves, each rejected
 * if the buildings it moves collide at `p.margin`:
 *  - translate one machine by 1..4 tiles along x, y or both;
 *  - swap the positions of two machines of different stages;
 *  - turn one machine by 90 degrees;
 *  - translate all machines of one stage by the same 1..4 tiles.
 * A move that raises the cost by `d` is accepted with probability `exp(-d / T)`; `T` falls geometrically from
 * `p.startTemp` to a thousandth of it over `p.iterations`. The result depends only on the inputs and `p.seed`.
 * `shouldStop` is asked before the first move and every 256 moves; when it says yes the best so far is returned.
 */
export function annealPlacement(
  net: Netlist,
  data: GameDataIndex,
  init: Placement,
  p: PlacementParams,
  shouldStop: () => boolean,
): Placement {
  checkParams(p);
  const { margin, weights } = p;
  const n = net.machines.length;
  const occ = new Occupancy(data);

  // who is who in the initial placement
  const byId = new Map<number, PlacedBuilding>();
  for (const b of init.buildings) {
    if (byId.has(b.id)) throw new Error(`annealPlacement: the initial placement has two buildings with id ${b.id}`);
    byId.set(b.id, b);
  }
  const machineAt = new Map<number, number>(); // building id -> machine index
  const cur: PlacedBuilding[] = net.machines.map((m, k) => {
    const b = byId.get(placementBuildingIdOf(m.id));
    if (!b) throw new Error(`annealPlacement: the initial placement has no building for machine ${m.id}`);
    machineAt.set(b.id, k);
    return b;
  });
  const statics = init.buildings.filter((b) => !machineAt.has(b.id));

  const initCost = placementCost(net, data, init.buildings, weights);
  const unchanged = (): Placement => ({ buildings: init.buildings.map((b) => ({ ...b })), cost: initCost });

  // the initial placement has to be sound, or no move could make it so
  for (const b of [...statics, ...cur]) {
    if (occ.buildingCollides(b, margin)) {
      throw new Error(`annealPlacement: the initial placement has colliding buildings at margin ${margin} (building ${b.id})`);
    }
    occ.addBuilding(b);
  }
  if (n === 0 || p.iterations === 0) return unchanged();

  // machine state
  const itemOf = cur.map((b) => b.itemId);
  const stageOf = net.machines.map((m) => m.stageIndex);
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const TURNS = new Uint8Array(n);
  const minX = new Float64Array(n);
  const maxX = new Float64Array(n);
  const minY = new Float64Array(n);
  const maxY = new Float64Array(n);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const setState = (k: number, x: number, y: number, turns: number): void => {
    X[k] = x;
    Y[k] = y;
    TURNS[k] = turns;
    const fp = occ.footprintOf(itemOf[k], YAWS[turns]);
    minX[k] = x + fp.minX;
    maxX[k] = x + fp.maxX;
    minY[k] = y + fp.minY;
    maxY[k] = y + fp.maxY;
    cx[k] = x + (fp.minX + fp.maxX) / 2;
    cy[k] = y + (fp.minY + fp.maxY) / 2;
  };
  cur.forEach((b, k) => setState(k, b.x, b.y, YAWS.indexOf(b.yaw)));

  // the bounding box of what does not move
  let sMinX = Infinity;
  let sMaxX = -Infinity;
  let sMinY = Infinity;
  let sMaxY = -Infinity;
  for (const b of statics) {
    const fp = occ.footprintOf(b.itemId, b.yaw);
    sMinX = Math.min(sMinX, b.x + fp.minX);
    sMaxX = Math.max(sMaxX, b.x + fp.maxX);
    sMinY = Math.min(sMinY, b.y + fp.minY);
    sMaxY = Math.max(sMaxY, b.y + fp.maxY);
  }
  const area = (): number => {
    let x0 = sMinX;
    let x1 = sMaxX;
    let y0 = sMinY;
    let y1 = sMaxY;
    for (let k = 0; k < n; k++) {
      if (minX[k] < x0) x0 = minX[k];
      if (maxX[k] > x1) x1 = maxX[k];
      if (minY[k] < y0) y0 = minY[k];
      if (maxY[k] > y1) y1 = maxY[k];
    }
    return (x1 - x0) * (y1 - y0);
  };

  // nets
  const model = buildWireModel(
    net,
    (idx) => {
      const b = byId.get(stationBuildingId(idx));
      if (!b) throw new Error(`annealPlacement: the initial placement has no building for station ${idx}`);
      return b;
    },
    data,
  );
  const netCount = model.taps.length;
  const wireOf = new Float64Array(netCount);
  let wire = 0;
  for (let i = 0; i < netCount; i++) {
    wireOf[i] = netWire(model.taps[i], model.ends[i], cx, cy);
    wire += wireOf[i];
  }
  const newWireOf = new Float64Array(netCount);
  const netStamp = new Int32Array(netCount);
  const affected: number[] = [];

  // stage groups
  const groupOfStage = new Map<number, number[]>();
  stageOf.forEach((s, k) => {
    const g = groupOfStage.get(s);
    if (g) g.push(k);
    else groupOfStage.set(s, [k]);
  });
  const groups = [...groupOfStage.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);

  let curArea = area();
  let cost = weights.area * curArea + weights.wire * wire;
  let bestCost = cost;
  const bestX = Float64Array.from(X);
  const bestY = Float64Array.from(Y);
  const bestTurns = Uint8Array.from(TURNS);

  // the move under trial
  const mvK: number[] = [];
  const mvX: number[] = [];
  const mvY: number[] = [];
  const mvT: number[] = [];
  const oldX: number[] = [];
  const oldY: number[] = [];
  const oldT: number[] = [];
  const ignore = new Set<number>();
  const probe: PlacedBuilding = { id: 0, itemId: 0, x: 0, y: 0, z: 0, yaw: 0 };
  const candidate = (j: number): PlacedBuilding => ({
    ...cur[mvK[j]],
    x: mvX[j],
    y: mvY[j],
    yaw: YAWS[mvT[j]],
  });

  const rng = new Rng(p.seed);
  const step = (): number => (1 + rng.int(MAX_STEP)) * (rng.next() < 0.5 ? -1 : 1);

  /** Fills the trial move; false if the dice gave no move. */
  const propose = (): boolean => {
    mvK.length = mvX.length = mvY.length = mvT.length = 0;
    const r = rng.next();
    if (r >= P_TRANSLATE && r < P_SWAP) {
      const a = rng.int(n);
      const b = rng.int(n);
      if (stageOf[a] === stageOf[b]) return false;
      mvK.push(a, b);
      mvX.push(X[b], X[a]);
      mvY.push(Y[b], Y[a]);
      mvT.push(TURNS[a], TURNS[b]);
      return true;
    }
    if (r >= P_SWAP && r < P_ROTATE) {
      const k = rng.int(n);
      mvK.push(k);
      mvX.push(X[k]);
      mvY.push(Y[k]);
      mvT.push((TURNS[k] + 1) & 3);
      return true;
    }
    const members = r < P_TRANSLATE ? [rng.int(n)] : groups[rng.int(groups.length)];
    const axes = rng.int(3); // 0: x, 1: y, 2: both
    const dx = axes !== 1 ? step() : 0;
    const dy = axes !== 0 ? step() : 0;
    for (const k of members) {
      mvK.push(k);
      mvX.push(X[k] + dx);
      mvY.push(Y[k] + dy);
      mvT.push(TURNS[k]);
    }
    return true;
  };

  /** Would the moved buildings collide with anything that stays, or (a swap) with each other? */
  const collides = (): boolean => {
    ignore.clear();
    for (const k of mvK) ignore.add(cur[k].id);
    for (let j = 0; j < mvK.length; j++) {
      const b = cur[mvK[j]];
      probe.id = b.id;
      probe.itemId = b.itemId;
      probe.x = mvX[j];
      probe.y = mvY[j];
      probe.z = b.z;
      probe.yaw = YAWS[mvT[j]];
      if (occ.buildingCollides(probe, margin, ignore)) return true;
    }
    if (mvK.length === 2) {
      // the two swapped machines move relative to each other
      const reach = 2 * margin;
      const a = occ.obbsOf(candidate(0));
      const b = occ.obbsOf(candidate(1));
      for (const oa of a) {
        const grown = { ...oa, hx: oa.hx + reach, hy: oa.hy + reach };
        for (const ob of b) if (obbOverlap(grown, ob)) return true;
      }
    }
    return false;
  };

  const alpha = Math.pow(FINAL_TEMP_RATIO, 1 / p.iterations);
  let temp = p.startTemp;
  for (let it = 0; it < p.iterations; it++, temp *= alpha) {
    if (it % STOP_CHECK_EVERY === 0 && shouldStop()) break;
    if (!propose() || collides()) continue;

    // try it: move the machines, price the nets they touch
    oldX.length = oldY.length = oldT.length = 0;
    for (let j = 0; j < mvK.length; j++) {
      const k = mvK[j];
      oldX.push(X[k]);
      oldY.push(Y[k]);
      oldT.push(TURNS[k]);
      setState(k, mvX[j], mvY[j], mvT[j]);
    }
    affected.length = 0;
    for (const k of mvK) {
      for (const i of model.netsOf[k]) {
        if (netStamp[i] !== it + 1) {
          netStamp[i] = it + 1;
          affected.push(i);
        }
      }
    }
    let wireDelta = 0;
    for (const i of affected) {
      newWireOf[i] = netWire(model.taps[i], model.ends[i], cx, cy);
      wireDelta += newWireOf[i] - wireOf[i];
    }
    const newArea = area();
    const newWire = wire + wireDelta;
    const newCost = weights.area * newArea + weights.wire * newWire;
    const delta = newCost - cost;

    if (delta <= 0 || rng.next() < Math.exp(-delta / temp)) {
      for (let j = 0; j < mvK.length; j++) {
        const k = mvK[j];
        const moved = candidate(j);
        occ.removeBuilding(moved.id);
        occ.addBuilding(moved);
        cur[k] = moved;
      }
      for (const i of affected) wireOf[i] = newWireOf[i];
      wire = newWire;
      curArea = newArea;
      cost = newCost;
      if (cost < bestCost - IMPROVEMENT_EPS) {
        bestCost = cost;
        bestX.set(X);
        bestY.set(Y);
        bestTurns.set(TURNS);
      }
    } else {
      for (let j = 0; j < mvK.length; j++) setState(mvK[j], oldX[j], oldY[j], oldT[j]);
    }
    if ((it + 1) % RESYNC_EVERY === 0) {
      wire = 0;
      for (let i = 0; i < netCount; i++) wire += wireOf[i];
      cost = weights.area * curArea + weights.wire * wire;
    }
  }

  const buildings = init.buildings.map((b) => {
    const k = machineAt.get(b.id);
    return k === undefined ? { ...b } : { ...b, x: bestX[k], y: bestY[k], yaw: YAWS[bestTurns[k]] };
  });
  // the exact cost of the best, not the running sum; and never worse than the start
  const bestExact = placementCost(net, data, buildings, weights);
  return bestExact < initCost ? { buildings, cost: bestExact } : unchanged();
}
