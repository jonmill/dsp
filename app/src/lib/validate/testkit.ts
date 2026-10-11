// Layout builders for validator tests. Loads the committed fixture GameData (approximate geometry) and offers
// small helpers to put buildings, belts and sorters into a Layout. Kept free of `lib/layout/` imports, like the
// rest of the validator.
import { computeTechEffects, GameDataIndex } from '../data';
import type { Building, TechEffects } from '../data';
import type { ProductionPlan, Stage } from '../calc';
import { loadFixtureGameData } from '../../../test/fixtures/fixtureGameData';
import { slotInfos, sorterTapPoint } from '../geometry';
import type {
  BeltPath,
  Endpoint,
  GridPoint,
  Layout,
  PlacedBuilding,
  Sorter,
  StationConfig,
  Yaw,
} from '../geometry';
import type { Violation, ViolationCode } from './types';

/** The fixture GameData, indexed. Shared and never mutated; use `patchBuilding` to get a changed copy. */
export const fixtureData = new GameDataIndex(loadFixtureGameData());

/** Tech effects with nothing researched (belt height limit 12). */
export const fixtureEffects: TechEffects = computeTechEffects(fixtureData.data, new Set());

/** Item ids of the fixture buildings the kit places. */
export const ITEM = {
  belt: { 1: 2001, 2: 2002, 3: 2003 },
  sorter: { mk1: 2011, mk2: 2012, mk3: 2013, pile: 2014 },
  pls: 2103,
  ils: 2104,
  tesla: 2201,
  wirelessTower: 2202,
  smelter: 2302,
  assembler: 2303,
  matrixLab: 2901,
} as const;

/** A point as `[x, y]` or `[x, y, z]`; z defaults to 0. */
export type P = readonly [x: number, y: number, z?: number];

const toPoint = (p: P | GridPoint): GridPoint =>
  Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] ?? 0 } : { ...(p as GridPoint) };

/** Lattice points from `from` to `to` inclusive, one step at a time, along one axis, at height `z`. */
export function line(from: readonly [number, number], to: readonly [number, number], z = 0): GridPoint[] {
  const [x0, y0] = from;
  const [x1, y1] = to;
  if (x0 !== x1 && y0 !== y1) throw new Error(`line (${x0},${y0}) to (${x1},${y1}) is not axis-aligned`);
  const n = Math.abs(x1 - x0) + Math.abs(y1 - y0);
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + i * sx, y: y0 + i * sy, z }));
}

/** An endpoint on sorter slot `slot` of `building`. */
export const onSlot = (building: PlacedBuilding, slot: number): Endpoint => ({
  kind: 'building',
  buildingId: building.id,
  slot,
});

/** An endpoint on node `node` of `belt`. */
export const onNode = (belt: BeltPath, node: number): Endpoint => ({ kind: 'belt', beltId: belt.id, node });

/** The codes of `violations`, in order. */
export const codesOf = (violations: Violation[]): ViolationCode[] => violations.map((v) => v.code);

/** Only the violations with this code. */
export const only = (violations: Violation[], code: ViolationCode): Violation[] =>
  violations.filter((v) => v.code === code);

/** A copy of `data` in which the building with `itemId` is replaced by `patch(building)`. */
export function patchBuilding(data: GameDataIndex, itemId: number, patch: (b: Building) => Building): GameDataIndex {
  const copy = structuredClone(data.data);
  const at = copy.buildings.findIndex((b) => b.itemId === itemId);
  if (at < 0) throw new Error(`no building ${itemId} to patch`);
  copy.buildings[at] = patch(copy.buildings[at]);
  return new GameDataIndex(copy);
}

/** A station config with `slots` storage slots; port 0 outputs slot 1. */
export function stationConfig(slots = 1): StationConfig {
  return {
    slots: Array.from({ length: slots }, (_, i) => ({ itemId: 1001 + i, localLogic: 2, remoteLogic: 0, max: 1000 })),
    ports: Array.from({ length: 12 }, (_, i) => ({ dir: i === 0 && slots > 0 ? 1 : 0, storageIdx: i === 0 && slots > 0 ? 1 : 0 })),
    chargePerTick: 0,
    pilerCount: 1,
  };
}

/** A plan stage for `recipeId` with one machine at full utilization; `over` sets the rest (inputs, machines, ...). */
export function planStage(recipeId: number, over: Partial<Stage> = {}): Stage {
  return {
    recipeId,
    buildingItemId: ITEM.assembler,
    machines: 1,
    exactMachines: 1,
    craftsPerSecond: 1,
    utilization: 1,
    inputs: [],
    outputs: [],
    perMachineCraftsPerSecond: 1,
    proliferated: false,
    effectiveSpeed: 1,
    workPowerW: 0,
    idlePowerW: 0,
    ...over,
  };
}

/** A minimal plan around `stages`: only the stages are meaningful, the rest is empty. */
export function planOf(stages: Stage[]): ProductionPlan {
  return {
    request: {
      targetItemId: 1101,
      quantity: { kind: 'rate', perSecond: 1 },
      finalFacilityItemId: ITEM.assembler,
      unlockedTechs: new Set(),
      suppliedItemIds: new Set(),
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier: 0, mode: 'extra' },
      stationKind: 'interstellar',
    },
    stages,
    flows: [],
    imports: [],
    exports: [],
    actualTargetRate: 1,
    stationSlots: [],
    stationsNeeded: 1,
    proliferatorPerSecond: 0,
    power: { productionWorkW: 0, productionIdleW: 0, sortersW: 0, coatersW: 0, stationChargeW: 0, steadyW: 0, peakW: 0 },
    warnings: [],
  };
}

/** Collects the pieces of a layout with ids assigned in order. Build with the helpers, then call `layout()`. */
export class LayoutKit {
  readonly buildings: PlacedBuilding[] = [];
  readonly belts: BeltPath[] = [];
  readonly sorters: Sorter[] = [];
  private nextBuilding = 1;
  private nextBelt = 1;
  private nextSorter = 1;

  constructor(
    readonly data: GameDataIndex = fixtureData,
    readonly effects: TechEffects = fixtureEffects,
  ) {}

  /** Any building at `(x, y)`, ground level unless `over.z` says otherwise. */
  building(itemId: number, x: number, y: number, yaw: Yaw = 0, over: Partial<PlacedBuilding> = {}): PlacedBuilding {
    const b: PlacedBuilding = { id: this.nextBuilding++, itemId, x, y, z: 0, yaw, ...over };
    this.buildings.push(b);
    return b;
  }

  /** An interstellar station (or a planetary one with `item = ITEM.pls`) with a one-slot config. */
  station(x: number, y: number, yaw: Yaw = 0, item: number = ITEM.ils, over: Partial<PlacedBuilding> = {}): PlacedBuilding {
    return this.building(item, x, y, yaw, { station: stationConfig(), ...over });
  }

  assembler(x: number, y: number, yaw: Yaw = 0, recipeId = 1, item: number = ITEM.assembler): PlacedBuilding {
    return this.building(item, x, y, yaw, { recipeId });
  }

  smelter(x: number, y: number, yaw: Yaw = 0, recipeId = 1): PlacedBuilding {
    return this.building(ITEM.smelter, x, y, yaw, { recipeId });
  }

  tesla(x: number, y: number): PlacedBuilding {
    return this.building(ITEM.tesla, x, y);
  }

  /** A belt through `points` (in flow order) of belt tier `tier` (1, 2 or 3) carrying `itemId`. */
  belt(tier: 1 | 2 | 3, itemId: number, points: readonly (P | GridPoint)[], over: Partial<BeltPath> = {}): BeltPath {
    const belt: BeltPath = {
      id: this.nextBelt++,
      tierItemId: ITEM.belt[tier],
      itemId,
      nodes: points.map(toPoint),
      plannedRate: 1,
      ...over,
    };
    this.belts.push(belt);
    return belt;
  }

  /** A sorter from `pick` to `drop`; Mk.I unless `over.tierItemId` says otherwise. */
  sorter(pick: Endpoint, drop: Endpoint, span: 1 | 2 | 3 = 1, over: Partial<Sorter> = {}): Sorter {
    const s: Sorter = {
      id: this.nextSorter++,
      tierItemId: ITEM.sorter.mk1,
      filterItemId: 0,
      span,
      pick,
      drop,
      plannedRate: 1,
      ...over,
    };
    this.sorters.push(s);
    return s;
  }

  /** The lattice point a span-`span` sorter on `slot` of `building` taps on a belt (from the geometry kernel). */
  tapPoint(building: PlacedBuilding, slot: number, span: 1 | 2 | 3 = 1): { x: number; y: number } {
    const def = this.data.building(building.itemId);
    if (!def) throw new Error(`no building ${building.itemId}`);
    return sorterTapPoint(slotInfos(building, def)[slot], span);
  }

  /** The layout as collected so far. The arrays are copies, so a test can edit the result freely. */
  layout(): Layout {
    return {
      buildings: [...this.buildings],
      belts: [...this.belts],
      sorters: [...this.sorters],
      meta: { geometrySource: 'approximate', gameVersion: '0.10.29.22015', planTargetItemId: 1101, planTargetRate: 1 },
    };
  }
}

/** The pieces of `compositeLayout`, for tests that want to change one of them. */
export interface Composite {
  kit: LayoutKit;
  station: PlacedBuilding;
  asmA: PlacedBuilding;
  asmB: PlacedBuilding;
  tesla: PlacedBuilding;
  /** Leaves the station's port 0 and runs east along y = 6. */
  belt: BeltPath;
  /** Belt to assembler A (slot 7) at belt node 7, the lattice point (6, 6). */
  feedA: Sorter;
  /** Belt to assembler B (slot 7) at belt node 11, the lattice point (10, 6). */
  feedB: Sorter;
  /** Assembler B (slot 6) to the belt at node 12, the lattice point (11, 6). */
  outB: Sorter;
  /** Assembler A (slot 4) to assembler B (slot 10), directly. */
  link: Sorter;
}

/**
 * One layout that passes every geometry rule: a station whose port 0 feeds a belt running east along y = 6,
 * assemblers at (6, 8) and (10, 8) above it with sorters onto the belt, one sorter between the two assemblers,
 * and a Tesla tower covering all of it.
 */
export function compositeLayout(kit: LayoutKit = new LayoutKit()): Composite {
  const station = kit.station(0, 0);
  const asmA = kit.assembler(6, 8);
  const asmB = kit.assembler(10, 8);
  const tesla = kit.tesla(5, 3);
  const belt = kit.belt(
    1,
    1001,
    [...line([1, 4], [1, 6]), ...line([2, 6], [12, 6])],
    { source: { buildingId: station.id, port: 0 } },
  );
  // Node 0..2 are (1,4)..(1,6); node k >= 3 is (k - 1, 6).
  const nodeAtX = (x: number) => x + 1;
  const feedA = kit.sorter(onNode(belt, nodeAtX(6)), onSlot(asmA, 7));
  const feedB = kit.sorter(onNode(belt, nodeAtX(10)), onSlot(asmB, 7));
  const outB = kit.sorter(onSlot(asmB, 6), onNode(belt, nodeAtX(11)));
  const link = kit.sorter(onSlot(asmA, 4), onSlot(asmB, 10));
  return { kit, station, asmA, asmB, tesla, belt, feedA, feedB, outB, link };
}
