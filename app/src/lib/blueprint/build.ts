/**
 * Layout to blueprint: turns a solved `Layout` into the record list the game pastes.
 * Format reference: docs/research/blueprint-format.md ("BF"), §3.3 records, §4.1 station parameters,
 * §5 coordinates. Output profile: header v0, body version 2, marker -101, patch2 1, no reform (BF §3.4).
 */
import type { Building, GameDataIndex } from '../data';
import {
  beltNodeAt,
  beltNodeYaws,
  buildingDef,
  headingDeg,
  LayoutIndex,
  portPosition,
  sorterEnds,
  sprayCoaterDef,
} from '../geometry';
import type { BeltPath, Endpoint, GridPoint, Layout, PlacedBuilding, Sorter, SprayCoater, StationConfig } from '../geometry';
import { encodeBlueprint } from './codec';
import type { Blueprint, BlueprintBuilding, BlueprintHeader } from './model';

/** Appended to `desc` while the geometry the layout was built on is approximate (Review Focus #5). */
const APPROXIMATE_FLAG = '[geometry: approximate - unverified in game]';

/**
 * Whether the yaw and axis conventions of the blueprint (`prefabToGrid`, BF §5; docs/TESTING-ON-NOBARA.md, item 1) have been checked in
 * game. Extracting the building geometry does not check them: a blueprint is only known to paste right once it has been pasted, so every
 * blueprint and the UI say so until this is flipped, after the first in-game paste of the runbook has come out right (final review, M5).
 */
export const CONVENTIONS_VERIFIED = false;
/** Appended to `desc` (after the geometry flag) while `CONVENTIONS_VERIFIED` is false, whatever the geometry source. */
export const CONVENTIONS_FLAG = '[conventions: yaw and axes not yet verified in game]';

/** What the builder needs to resolve ids: the game data, and the layout by id. */
interface Context {
  data: GameDataIndex;
  index: LayoutIndex;
}

function makeContext(layout: Layout, data: GameDataIndex): Context {
  return { data, index: new LayoutIndex(layout) };
}

function portPoint(ctx: Context, buildingId: number, port: number, what: string): GridPoint {
  const b = ctx.index.building(buildingId, what);
  return portPosition(b, buildingDef(ctx.data, b.itemId), port, what);
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

const mid = (a: GridPoint, b: GridPoint): GridPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

// Station parameters, BF §4.1.
const STATION_PARAMS = 2048;
const STATION_PORTS = 12;
const STATION_MAX_STORAGES = 5;
const DRONE_RANGE_50_DEG = 64278761; // round(cos(50°) · 1e8)

/** Lab parameter 0 (BF §4): 0 none, 1 matrix synthesis, 2 research. The planner's labs make matrices from a recipe. */
const LAB_MODE_MATRIX_SYNTHESIS = 1;

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
  // BF §4: a lab carries [research mode, proliferator mode]. Mode 0 is "none": a lab without it makes nothing in game.
  else if (def.kind === 'lab') parameters = Int32Array.of(LAB_MODE_MATRIX_SYNTHESIS, b.prolifMode ?? 0);
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

  const yaws = beltNodeYaws(pts);
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
    const target = ctx.index.belt(sink.beltId, `${what} sink`);
    beltNodeAt(target, sink.node, `${what} sink`);
    const t = layouts.get(target.id)!;
    last.outputObjIdx = t.base + t.pre + sink.node;
    // A belt that joins another belt's middle node is a side merge, which the game writes as input slot 2 of the target;
    // slot 1 is the straight run (the 0.10.34 sample: record 23 joins record 16 with 2, record 15 continues it with 1).
    last.outputToSlot = 2;
  }
  return recs;
}

function sorterRecord(
  s: Sorter,
  ctx: Context,
  layouts: Map<number, BeltLayout>,
  buildingIndex: Map<number, number>,
): BlueprintBuilding {
  const { pick, drop } = sorterEnds(s, ctx.index.layout, ctx.data, ctx.index);
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

/**
 * The record of a spray coater, written the way the game wrote the 8 of the capsule sample (BF §3.3): at the node of its
 * belt (both ends of the record), turned `yaw`, item 2313 and the model of GameData, linked to nothing (outputObjIdx and
 * inputObjIdx -1, the belts do not point at it either) and with the slot fields `14,15,15,14,0,0` that splitters and
 * depots carry, no parameters.
 */
function coaterRecord(c: SprayCoater, ctx: Context): BlueprintBuilding {
  const what = `coater ${c.id}`;
  const def = sprayCoaterDef(ctx.data);
  if (!def) throw new Error(`${what}: GameData has no spray coater building`);
  const p = beltNodeAt(ctx.index.belt(c.beltId, `${what} belt`), c.node, what);
  return record(def.itemId, def.modelIndex, {
    localOffset: [p.x, p.y, p.z],
    localOffset2: [p.x, p.y, p.z],
    yaw: c.yaw,
    yaw2: c.yaw,
    outputToSlot: 14,
    inputFromSlot: 15,
    outputFromSlot: 15,
    inputToSlot: 14,
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
 * stubs, nodes, sink stubs), then sorters, then spray coaters (which nothing links to, so they can come last without
 * moving any other index), so `index == position` as the game requires. Every position is
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
    ...(layout.coaters ?? []).map((c) => coaterRecord(c, ctx)),
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
  const desc = [opts.desc, ...(approximate ? [APPROXIMATE_FLAG] : []), ...(CONVENTIONS_VERIFIED ? [] : [CONVENTIONS_FLAG])]
    .filter((part) => part !== '')
    .join('\n');
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
