/**
 * Layout to blueprint: turns a solved `Layout` into the record list the game pastes.
 * Format reference: docs/research/blueprint-format.md ("BF"), §3.3 records, §4.1 station parameters,
 * §5 coordinates. Output profile: header v0, body version 2, marker -101, patch2 1, no reform (BF §3.4).
 */
import type { Building, GameDataIndex, Vec3 } from '../data';
import type { BeltPath, Endpoint, GridPoint, Layout, PlacedBuilding, Sorter, StationConfig, Yaw } from '../geometry/model';
import { encodeBlueprint } from './codec';
import type { Blueprint, BlueprintBuilding, BlueprintHeader } from './model';

export const TILE = 1.2566370614359172;
export const LEVEL = 4 / 3;

/** Appended to `desc` while the geometry the layout was built on is approximate (Review Focus #5). */
const APPROXIMATE_FLAG = '[geometry: approximate - unverified in game]';

// ---------------------------------------------------------------------------------------------
// Geometry helpers. Task 14 moves `prefabToGrid` and `sorterEnds` into `app/src/lib/geometry/`.

const YAW_TRIG: Record<Yaw, readonly [cos: number, sin: number]> = {
  0: [1, 0],
  90: [0, 1],
  180: [-1, 0],
  270: [0, -1],
};

/**
 * Prefab space (metres; px right, py up, pz forward) to grid space for a building at `b` with yaw
 * `b.yaw` degrees clockwise from north, viewed from above:
 * `east = px·cosθ + pz·sinθ`, `north = −px·sinθ + pz·cosθ`, then metres to tiles and levels.
 * This convention is an assumption until checked in-game (global context, "Coordinates"); keep it here.
 */
export function prefabToGrid(b: { x: number; y: number; z: number; yaw: Yaw }, p: Vec3): GridPoint {
  const trig = YAW_TRIG[b.yaw];
  if (!trig) throw new Error(`unsupported yaw ${String(b.yaw)} (expected 0, 90, 180 or 270)`);
  const [cos, sin] = trig;
  const east = p[0] * cos + p[2] * sin;
  const north = -p[0] * sin + p[2] * cos;
  return { x: b.x + east / TILE, y: b.y + north / TILE, z: b.z + p[1] / LEVEL };
}

/** What the builder needs to resolve ids: the layout by id, and the game data. */
interface Context {
  data: GameDataIndex;
  buildings: Map<number, PlacedBuilding>;
  belts: Map<number, BeltPath>;
}

function makeContext(layout: Layout, data: GameDataIndex): Context {
  const buildings = new Map<number, PlacedBuilding>();
  for (const b of layout.buildings) {
    if (buildings.has(b.id)) throw new Error(`duplicate building id ${b.id}`);
    buildings.set(b.id, b);
  }
  const belts = new Map<number, BeltPath>();
  for (const belt of layout.belts) {
    if (belts.has(belt.id)) throw new Error(`duplicate belt id ${belt.id}`);
    belts.set(belt.id, belt);
  }
  return { data, buildings, belts };
}

function buildingDef(data: GameDataIndex, itemId: number): Building {
  const def = data.building(itemId);
  if (!def) throw new Error(`GameData has no building for item ${itemId}`);
  return def;
}

function placedBuilding(ctx: Context, id: number, what: string): PlacedBuilding {
  const b = ctx.buildings.get(id);
  if (!b) throw new Error(`${what}: building ${id} is not in the layout`);
  return b;
}

function placedBelt(ctx: Context, id: number, what: string): BeltPath {
  const belt = ctx.belts.get(id);
  if (!belt) throw new Error(`${what}: belt ${id} is not in the layout`);
  return belt;
}

function beltNode(belt: BeltPath, node: number, what: string): GridPoint {
  const p = belt.nodes[node];
  if (!p) throw new Error(`${what}: belt ${belt.id} has no node ${node} (${belt.nodes.length} nodes)`);
  return p;
}

function slotPoint(ctx: Context, e: Extract<Endpoint, { kind: 'building' }>): GridPoint {
  const b = placedBuilding(ctx, e.buildingId, 'sorter endpoint');
  const pose = buildingDef(ctx.data, b.itemId).geometry.slots[e.slot];
  if (!pose) throw new Error(`sorter endpoint: building ${b.id} (item ${b.itemId}) has no slot ${e.slot}`);
  return prefabToGrid(b, pose.position);
}

function portPoint(ctx: Context, buildingId: number, port: number, what: string): GridPoint {
  const b = placedBuilding(ctx, buildingId, what);
  const pose = buildingDef(ctx.data, b.itemId).geometry.ports[port];
  if (!pose) throw new Error(`${what}: building ${b.id} (item ${b.itemId}) has no port ${port}`);
  return prefabToGrid(b, pose.position);
}

/**
 * The belt point a building slot taps: the slot's position projected onto the belt's axis line through
 * the tap node (the axis runs between the node's neighbours), so the belt end sits at the slot's own
 * lateral coordinate, not at the node. z is the node's.
 */
function projectOntoBelt(belt: BeltPath, node: number, slot: GridPoint): GridPoint {
  const at = beltNode(belt, node, 'sorter endpoint');
  const prev = belt.nodes[node - 1] ?? at;
  const next = belt.nodes[node + 1] ?? at;
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { ...at };
  const ux = dx / len;
  const uy = dy / len;
  const along = (slot.x - at.x) * ux + (slot.y - at.y) * uy;
  return { x: at.x + along * ux, y: at.y + along * uy, z: at.z };
}

function endpointPoint(ctx: Context, e: Endpoint, opposite: Endpoint): GridPoint {
  if (e.kind === 'building') return slotPoint(ctx, e);
  const belt = placedBelt(ctx, e.beltId, 'sorter endpoint');
  if (opposite.kind === 'building') return projectOntoBelt(belt, e.node, slotPoint(ctx, opposite));
  return { ...beltNode(belt, e.node, 'sorter endpoint') };
}

function sorterEndsIn(s: Sorter, ctx: Context): { pick: GridPoint; drop: GridPoint } {
  return { pick: endpointPoint(ctx, s.pick, s.drop), drop: endpointPoint(ctx, s.drop, s.pick) };
}

/**
 * Where a sorter's two ends sit in grid space. A building end is the slot position; a belt end is the
 * point on the belt at the opposite building slot's lateral coordinate; building to building uses both
 * slot positions; belt to belt (unused in v1) uses both tap nodes.
 */
export function sorterEnds(s: Sorter, layout: Layout, data: GameDataIndex): { pick: GridPoint; drop: GridPoint } {
  return sorterEndsIn(s, makeContext(layout, data));
}

// ---------------------------------------------------------------------------------------------
// Records

function record(itemId: number, modelIndex: number, over: Partial<BlueprintBuilding> = {}): BlueprintBuilding {
  return {
    marker: -101,
    index: 0,
    areaIndex: 0,
    localOffset: [0, 0, 0],
    localOffset2: [0, 0, 0],
    yaw: 0,
    yaw2: 0,
    tilt: 0,
    pitch: 0,
    tilt2: 0,
    pitch2: 0,
    itemId,
    modelIndex,
    outputObjIdx: -1,
    inputObjIdx: -1,
    outputToSlot: 0,
    inputFromSlot: 0,
    outputFromSlot: 0,
    inputToSlot: 0,
    outputOffset: 0,
    inputOffset: 0,
    recipeId: 0,
    filterId: 0,
    parameters: new Int32Array(0),
    ...over,
  };
}

/** Yaw in degrees clockwise from north, in [0, 360), for a grid-space direction (east, north). */
function headingDeg(east: number, north: number): number {
  const deg = Math.round(((Math.atan2(east, north) * 180) / Math.PI) * 1e6) / 1e6;
  return ((deg % 360) + 360) % 360;
}

const mid = (a: GridPoint, b: GridPoint): GridPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

/**
 * Per-point yaw along a polyline: the direction to the next point, or, where the next point is straight
 * above or below (a vertical lift), the heading carried from the previous segment. The last point keeps
 * the heading before it; a belt that starts with a lift takes the first real heading.
 */
function headings(pts: GridPoint[]): number[] {
  const out: (number | undefined)[] = [];
  let carry: number | undefined;
  for (let i = 0; i < pts.length; i++) {
    const next = pts[i + 1];
    if (next) {
      const east = next.x - pts[i].x;
      const north = next.y - pts[i].y;
      if (Math.hypot(east, north) > 1e-9) carry = headingDeg(east, north);
    }
    out.push(carry);
  }
  const first = out.find((v) => v !== undefined) ?? 0;
  return out.map((v) => v ?? first);
}

// Station parameters, BF §4.1.
const STATION_PARAMS = 2048;
const STATION_PORTS = 12;
const STATION_MAX_STORAGES = 5;
const DRONE_RANGE_50_DEG = 64278761; // round(cos(50°) · 1e8)

function setParam(p: Int32Array, index: number, value: number, what: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`${what}: ${value} is not an int32`);
  }
  p[index] = value;
}

function stationParameters(b: PlacedBuilding, def: Building, cfg: StationConfig | undefined): Int32Array {
  const p = new Int32Array(STATION_PARAMS);
  if (!cfg) return p;
  const what = `station ${b.id}`;
  const maxStorages = Math.min(STATION_MAX_STORAGES, def.station?.maxItemKinds ?? STATION_MAX_STORAGES);
  if (cfg.slots.length > maxStorages) {
    throw new Error(`${what}: ${cfg.slots.length} storages configured, at most ${maxStorages} fit`);
  }
  if (cfg.ports.length !== STATION_PORTS) {
    throw new Error(`${what}: expected ${STATION_PORTS} ports, got ${cfg.ports.length}`);
  }
  cfg.slots.forEach((s, i) => {
    setParam(p, 6 * i, s.itemId, `${what} storage ${i} itemId`);
    setParam(p, 6 * i + 1, s.localLogic, `${what} storage ${i} localLogic`);
    setParam(p, 6 * i + 2, s.remoteLogic, `${what} storage ${i} remoteLogic`);
    setParam(p, 6 * i + 3, s.max, `${what} storage ${i} max`);
  });
  cfg.ports.forEach((port, s) => {
    setParam(p, 192 + 4 * s, port.dir, `${what} port ${s} dir`);
    setParam(p, 192 + 4 * s + 1, port.storageIdx, `${what} port ${s} storageIdx`);
  });
  setParam(p, 320, cfg.chargePerTick, `${what} chargePerTick`);
  p[321] = DRONE_RANGE_50_DEG; // tripRangeOfDrones
  p[326] = 1; // deliveryAmountOfDrones, minimum load %
  p[327] = 1; // deliveryAmountOfShips, minimum load %
  setParam(p, 328, cfg.pilerCount, `${what} pilerCount`);
  p[330] = 1; // droneAutoReplenish
  return p;
}

function buildingRecord(b: PlacedBuilding, ctx: Context): BlueprintBuilding {
  const def = buildingDef(ctx.data, b.itemId);
  if (b.station && def.kind !== 'station') {
    throw new Error(`building ${b.id} (item ${b.itemId}) is not a station but carries a station configuration`);
  }
  let parameters: Int32Array = new Int32Array(0);
  if (def.kind === 'station') parameters = stationParameters(b, def, b.station);
  else if (def.kind === 'production') parameters = Int32Array.of(b.prolifMode ?? 0);
  return record(b.itemId, def.modelIndex, {
    localOffset: [b.x, b.y, b.z],
    localOffset2: [b.x, b.y, b.z],
    yaw: b.yaw,
    yaw2: b.yaw,
    recipeId: b.recipeId ?? 0,
    parameters,
  });
}

/** Where each belt's records start, and how many stubs precede its first node. */
interface BeltLayout {
  base: number;
  pre: number;
  length: number;
}

function beltLayouts(belts: BeltPath[], firstIndex: number): Map<number, BeltLayout> {
  const out = new Map<number, BeltLayout>();
  let base = firstIndex;
  for (const belt of belts) {
    if (belt.nodes.length === 0) throw new Error(`belt ${belt.id} has no nodes`);
    // A port needs two stub records between the station and the lattice (see beltRecords).
    const pre = belt.source ? 2 : 0;
    const post = belt.sink?.kind === 'port' ? 2 : 0;
    const length = pre + belt.nodes.length + post;
    out.set(belt.id, { base, pre, length });
    base += length;
  }
  return out;
}

/**
 * The records of one belt, in flow order. A belt that leaves a building port starts with two stub
 * records, at the port position and halfway to node 0; a belt that ends at a port mirrors that after
 * its last node (halfway, then the port position). The game exports belts that way (the ILS sample has
 * records at ≈2.15 and ≈3.02 tiles from the centre before the lattice at 4.0); the stubs exist only in
 * the blueprint. Only the first stub carries the source link and only the last the sink link.
 */
function beltRecords(
  belt: BeltPath,
  ctx: Context,
  layouts: Map<number, BeltLayout>,
  buildingIndex: Map<number, number>,
): BlueprintBuilding[] {
  const what = `belt ${belt.id}`;
  const { base, length } = layouts.get(belt.id)!;
  const pts: GridPoint[] = [];
  if (belt.source) {
    const port = portPoint(ctx, belt.source.buildingId, belt.source.port, `${what} source`);
    pts.push(port, mid(port, belt.nodes[0]));
  }
  pts.push(...belt.nodes);
  if (belt.sink?.kind === 'port') {
    const port = portPoint(ctx, belt.sink.buildingId, belt.sink.port, `${what} sink`);
    pts.push(mid(belt.nodes[belt.nodes.length - 1], port), port);
  }

  const yaws = headings(pts);
  const modelIndex = buildingDef(ctx.data, belt.tierItemId).modelIndex;
  const recs = pts.map((p, i) =>
    record(belt.tierItemId, modelIndex, {
      localOffset: [p.x, p.y, p.z],
      localOffset2: [p.x, p.y, p.z],
      yaw: yaws[i],
      yaw2: yaws[i],
      // A belt chain carries 1,0,0,1,0,0 (BF §3.3); the open end of a chain has no target slot.
      outputObjIdx: i + 1 < length ? base + i + 1 : -1,
      outputToSlot: i + 1 < length ? 1 : 0,
      inputToSlot: 1,
    }),
  );

  if (belt.source) {
    recs[0].inputObjIdx = buildingIndex.get(belt.source.buildingId)!;
    recs[0].inputFromSlot = belt.source.port;
  }
  const last = recs[recs.length - 1];
  const sink = belt.sink;
  if (sink?.kind === 'port') {
    last.outputObjIdx = buildingIndex.get(sink.buildingId)!;
    last.outputToSlot = sink.port;
  } else if (sink?.kind === 'belt') {
    const target = placedBelt(ctx, sink.beltId, `${what} sink`);
    beltNode(target, sink.node, `${what} sink`);
    const t = layouts.get(target.id)!;
    last.outputObjIdx = t.base + t.pre + sink.node;
    last.outputToSlot = 1;
  }
  return recs;
}

function sorterRecord(
  s: Sorter,
  ctx: Context,
  layouts: Map<number, BeltLayout>,
  buildingIndex: Map<number, number>,
): BlueprintBuilding {
  const { pick, drop } = sorterEndsIn(s, ctx);
  const yaw = headingDeg(drop.x - pick.x, drop.y - pick.y);
  const target = (e: Endpoint): number => {
    if (e.kind === 'building') return buildingIndex.get(e.buildingId)!;
    const t = layouts.get(e.beltId)!;
    return t.base + t.pre + e.node;
  };
  return record(s.tierItemId, buildingDef(ctx.data, s.tierItemId).modelIndex, {
    localOffset: [pick.x, pick.y, pick.z],
    localOffset2: [drop.x, drop.y, drop.z],
    yaw,
    yaw2: yaw,
    inputObjIdx: target(s.pick),
    outputObjIdx: target(s.drop),
    // -1 = a belt end (any position on the belt); a building end names its sorter slot.
    inputFromSlot: s.pick.kind === 'building' ? s.pick.slot : -1,
    outputToSlot: s.drop.kind === 'building' ? s.drop.slot : -1,
    outputFromSlot: 0,
    inputToSlot: 1,
    filterId: s.filterItemId,
    parameters: Int32Array.of(s.span),
  });
}

// ---------------------------------------------------------------------------------------------
// Blueprint

export interface BuildOptions {
  shortDesc: string;
  desc: string;
  /** Header timestamp; defaults to the current time. */
  now?: Date;
}

const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000n;

/** .NET `DateTime.Now.Ticks`: 100 ns units since 0001-01-01, local wall-clock time (BF §1.1, §1.5). */
function localTicks(now: Date): bigint {
  const localMs = now.getTime() - now.getTimezoneOffset() * 60000;
  return BigInt(Math.round(localMs)) * 10000n + DOTNET_UNIX_EPOCH_TICKS;
}

const EPS = 1e-6;

/**
 * Build the blueprint for `layout`. Records are ordered buildings, then belt records (belt by belt: source
 * stubs, nodes, sink stubs), then sorters, so `index == position` as the game requires. Every position is
 * shifted by the integer `(-floor(minX), -floor(minY))` so buildings keep their grid parity.
 */
export function layoutToBlueprint(layout: Layout, data: GameDataIndex, opts: BuildOptions): Blueprint {
  const ctx = makeContext(layout, data);
  const buildingIndex = new Map(layout.buildings.map((b, i) => [b.id, i]));
  const layouts = beltLayouts(layout.belts, layout.buildings.length);

  const records: BlueprintBuilding[] = [
    ...layout.buildings.map((b) => buildingRecord(b, ctx)),
    ...layout.belts.flatMap((belt) => beltRecords(belt, ctx, layouts, buildingIndex)),
    ...layout.sorters.map((s) => sorterRecord(s, ctx, layouts, buildingIndex)),
  ];
  records.forEach((r, i) => {
    r.index = i;
  });

  // Translate onto the area's origin; sorter ends and port stubs are fractional and count too.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of records) {
    for (const p of [r.localOffset, r.localOffset2]) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const empty = records.length === 0;
  const dx = empty ? 0 : -Math.floor(minX);
  const dy = empty ? 0 : -Math.floor(minY);
  for (const r of records) {
    for (const p of [r.localOffset, r.localOffset2]) {
      p[0] += dx;
      p[1] += dy;
    }
  }
  // Cells 0..w-1 hold every position (a position belongs to the cell it rounds to).
  const cellCount = (min: number, max: number, shift: number) =>
    empty ? 1 : Math.max(Math.ceil(max - min - EPS), Math.round(max + shift)) + 1;
  const w = cellCount(minX, maxX, dx);
  const h = cellCount(minY, maxY, dy);

  const approximate = layout.meta.geometrySource === 'approximate';
  const desc = approximate ? (opts.desc ? `${opts.desc}\n${APPROXIMATE_FLAG}` : APPROXIMATE_FLAG) : opts.desc;
  const header: BlueprintHeader = {
    rawCells: [],
    headerVersion: 0,
    layout: 10,
    icons: [layout.meta.planTargetItemId, 0, 0, 0, 0],
    ticks: localTicks(opts.now ?? new Date()),
    gameVersion: layout.meta.gameVersion,
    shortDesc: opts.shortDesc,
    desc,
  };
  return {
    header,
    body: {
      version: 2,
      cursorOffsetX: Math.floor(w / 2),
      cursorOffsetY: Math.floor(h / 2),
      cursorTargetArea: 0,
      dragBoxSizeX: w,
      dragBoxSizeY: h,
      primaryAreaIdx: 0,
      areas: [
        {
          index: 0,
          parentIndex: -1,
          tropicAnchor: 0,
          areaSegments: 200,
          anchorLocalOffsetX: 0,
          anchorLocalOffsetY: 0,
          width: w,
          height: h,
        },
      ],
      buildings: records,
      patch2: 1,
      reformRaw: Uint8Array.of(0),
    },
    gzipOs: 0x0a,
  };
}

/** `BLUEPRINT:` string for `layout`: `encodeBlueprint(layoutToBlueprint(...))`. */
export function layoutToBlueprintString(layout: Layout, data: GameDataIndex, opts: BuildOptions): string {
  return encodeBlueprint(layoutToBlueprint(layout, data, opts));
}
