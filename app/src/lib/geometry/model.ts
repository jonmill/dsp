// The Layout model: the contract between the solver, the validator and the blueprint builder.
// Coordinates are grid space (docs: "Shared conventions"): x east and y north in tiles, z in levels.

export type Yaw = 0 | 90 | 180 | 270;

export interface GridPoint {
  x: number;
  y: number;
  z: number;
}

export interface StationSlotConfig {
  itemId: number;
  localLogic: 0 | 1 | 2;
  remoteLogic: 0 | 1 | 2;
  max: number;
}

export interface StationPortConfig {
  /** 0 none, 1 output, 2 input. */
  dir: 0 | 1 | 2;
  /** 1-based index into `StationConfig.slots` of the storage a port outputs; 0 = none. */
  storageIdx: number;
}

export interface StationConfig {
  slots: StationSlotConfig[];
  /** Length 12, in the building's port order. */
  ports: StationPortConfig[];
  chargePerTick: number;
  pilerCount: 0 | 1 | 2 | 3 | 4;
}

export interface PlacedBuilding {
  id: number;
  itemId: number;
  x: number;
  y: number;
  z: number;
  yaw: Yaw;
  recipeId?: number;
  /** 0 extra products, 1 speedup. */
  prolifMode?: 0 | 1;
  station?: StationConfig;
  /** Free-form tag, e.g. "stage:51". */
  role?: string;
}

export type Endpoint =
  /** `slot` is the sorter slot index on the building. */
  | { kind: 'building'; buildingId: number; slot: number }
  /** `node` is the node index on the belt path. */
  | { kind: 'belt'; beltId: number; node: number };

export interface BeltPath {
  id: number;
  tierItemId: 2001 | 2002 | 2003;
  /** The carried item (0 = proliferator/mixed, not used in v1). */
  itemId: number;
  /** In flow order; consecutive nodes are adjacent. */
  nodes: GridPoint[];
  /** The belt starts at a building belt port (station output). */
  source?: { buildingId: number; port: number };
  sink?: { kind: 'port'; buildingId: number; port: number } | { kind: 'belt'; beltId: number; node: number };
  /** Items/s the solver intends to carry. */
  plannedRate: number;
}

export interface Sorter {
  id: number;
  tierItemId: 2011 | 2012 | 2013 | 2014;
  filterItemId: number;
  span: 1 | 2 | 3;
  pick: Endpoint;
  drop: Endpoint;
  plannedRate: number;
}

export interface Layout {
  buildings: PlacedBuilding[];
  belts: BeltPath[];
  sorters: Sorter[];
  meta: {
    geometrySource: 'extracted' | 'approximate';
    gameVersion: string;
    planTargetItemId: number;
    planTargetRate: number;
  };
}
