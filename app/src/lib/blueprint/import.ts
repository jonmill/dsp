/**
 * Blueprint to layout: the inverse of `layoutToBlueprint` (build.ts), so a blueprint the game exported (or one this
 * planner made) can be simulated and compared with what the player measured in game. Format reference:
 * docs/research/blueprint-format.md ("BF"), §3.3 records and links, §4.1 station parameters.
 *
 * What comes back. Positions are the blueprint's own (area-local) coordinates; the builder's integer shift is not undone,
 * nothing downstream depends on where the block sits. Ids are record indexes (a building and a sorter take the index of
 * their record, a belt the index of its first record), so a message that names "building 12" or "belt 3" can be looked up
 * in the blueprint. Belt and sorter planned rates are unknown and read 0. A belt's carried item is not stored in a
 * blueprint; it is inferred from the station port it leaves, else from a sorter filter on it, else 0.
 *
 * Belts. Belt records are chained through `outputObjIdx` into `BeltPath`s. Where several records feed one (a merge), the
 * one that continues the belt is chosen by, in order: the target slot of the link (`outputToSlot`: 1 is the straight run,
 * 2 a side merge; the game and `layoutToBlueprint` write them so), the direction (the feeder that arrives straight in the
 * direction the belt leaves), and the record just before the target in the file. The first signal that singles one out
 * wins; a warning says when the slot and the direction disagree. The others end in a `sink: belt`. A belt chain is one
 * `BeltPath` with one tier: when its records mix tiers the slowest is kept, with a warning. A chain that leaves a station
 * (`inputObjIdx` names a station) starts with the two port-stub records `layoutToBlueprint` writes (the game does the
 * same, BF §3.3); they fold back into `source`, and a chain that enters a station folds its last two records into `sink`.
 *
 * Sorters. A sorter end on a building is that building and the slot field of the record (`inputFromSlot` on the pick
 * side, `outputToSlot` on the drop side); an end on a belt is the node of the folded path that the record it links to
 * became.
 *
 * Stacks. A blueprint stores no link between stacked buildings, only their heights. A multiLevel building (a lab) standing
 * on another of the same kind, on the same x, y and yaw and one lapJoint higher, gets that building as its `stackParentId`.
 *
 * What is not imported. Only the kinds the planner models: production buildings, labs, stations, power nodes, belts and
 * sorters. Every other record (splitters, depots, spray coaters, unknown item ids...) is skipped and named in one
 * warning per item id; a belt or sorter end that linked to one is left open (belt) or the sorter is dropped. Throws only for
 * links that cannot be followed: a record index that is not in the blueprint, or a belt that outputs to itself.
 */
import { estimatePower } from '../calc/power';
import type { ItemRate, ProductionPlan, Stage, StationSlotDemand } from '../calc/types';
import type { Building, GameDataIndex, Recipe, TechEffects } from '../data';
import { headingDeg, LEVEL } from '../geometry';
import type {
  BeltPath,
  Endpoint,
  GridPoint,
  Layout,
  PlacedBuilding,
  Sorter,
  StationConfig,
  StationPortConfig,
  StationSlotConfig,
  Yaw,
} from '../geometry';
import type { Blueprint, BlueprintBuilding } from './model';

// Station parameters, BF §4.1 (the same constants as build.ts).
const STATION_PORTS = 12;
const STATION_MAX_STORAGES = 5;
/** Records a belt end spends on the stubs between a station port and the lattice. */
const PORT_STUB_RECORDS = 2;

/** A building yaw this many degrees from a quarter turn gets a warning when it snaps. */
const YAW_SNAP_WARN_DEG = 1;
/** Segments shorter than this (in tiles) have no heading. */
const MIN_SEGMENT = 1e-9;
/** `outputToSlot` of a belt record that feeds a belt record from behind; a side merge writes 2 (BF §3.3). */
const STRAIGHT_SLOT = 1;
/** Two feeders whose headings into a merge differ by less than this many degrees arrive alike. */
const SAME_TURN_DEG = 0.5;
/** At most this many record numbers are listed in a warning. */
const LISTED_RECORDS = 6;

export interface ImportResult {
  layout: Layout;
  warnings: string[];
}

type Role = 'building' | 'belt' | 'sorter' | 'skipped';

/** What `blueprintToLayout` models, by GameData building kind. */
const PLACED_KINDS: ReadonlySet<string> = new Set(['production', 'lab', 'station', 'powerNode']);

interface Skipped {
  label: string;
  reason: string;
  positions: number[];
}

/** A chain of belt records in flow order, before and after the port stubs are folded away. */
interface Chain {
  /** Record positions, in flow order. */
  recs: number[];
  /** Stub records at the start and at the end. */
  head: number;
  tail: number;
}

const listRecords = (positions: number[]): string =>
  positions.length <= LISTED_RECORDS
    ? positions.join(', ')
    : `${positions.slice(0, LISTED_RECORDS).join(', ')}, ... (${positions.length} in all)`;

/** The nearest quarter turn of `deg` (degrees clockwise from north), and how far `deg` was from it. */
function snapYaw(deg: number): { yaw: Yaw; off: number } {
  const quarter = Math.round(deg / 90);
  return { yaw: ((((quarter % 4) + 4) % 4) * 90) as Yaw, off: Math.abs(deg - quarter * 90) };
}

/** Smallest angle between two headings in degrees, in [0, 180]. */
const headingGap = (a: number, b: number): number => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Stacked buildings stand on the same x, y (tiles) and one lapJoint apart in z (metres), to within these. */
const STACK_XY_TOL = 0.05;
const STACK_Z_TOL_M = 0.05;

/**
 * Sets `stackParentId` on every multiLevel building that stands directly on another of the same kind: the same x, y
 * and yaw, and its z one `lapJoint` of the lower building above the lower one's (a blueprint stores no link, the
 * stack is only a matter of position). The first such building in record order is the parent.
 */
function linkStacks(buildings: PlacedBuilding[], defOf: (b: PlacedBuilding) => Building | undefined): void {
  for (const b of buildings) {
    const def = defOf(b);
    if (!def?.geometry.multiLevel) continue;
    const parent = buildings.find((q) => {
      if (q === b || q.yaw !== b.yaw || Math.abs(q.x - b.x) > STACK_XY_TOL || Math.abs(q.y - b.y) > STACK_XY_TOL) return false;
      const lower = defOf(q);
      if (!lower?.geometry.multiLevel || lower.kind !== def.kind || !(lower.geometry.lapJoint[1] > 0)) return false;
      return Math.abs((b.z - q.z) * LEVEL - lower.geometry.lapJoint[1]) <= STACK_Z_TOL_M;
    });
    if (parent) b.stackParentId = parent.id;
  }
}

const point = (r: BlueprintBuilding): GridPoint => ({ x: r.localOffset[0], y: r.localOffset[1], z: r.localOffset[2] });

/**
 * The inverse of `layoutToBlueprint` for the entity kinds the planner uses: see the file comment. Skipped records and
 * links that had to be dropped are reported in `warnings`.
 */
export function blueprintToLayout(bp: Blueprint, data: GameDataIndex): ImportResult {
  const recs = bp.body.buildings;
  const warnings: string[] = [];

  // -------------------------------------------------------------------------------------------
  // Classify the records

  const roles: Role[] = [];
  const defs: (Building | undefined)[] = [];
  const skipped = new Map<string, Skipped>();
  const skip = (pos: number, key: string, label: string, reason: string): void => {
    const entry = skipped.get(key);
    if (entry) entry.positions.push(pos);
    else skipped.set(key, { label, reason, positions: [pos] });
  };
  recs.forEach((r, pos) => {
    const def = data.building(r.itemId);
    defs.push(def);
    if (!def) {
      roles.push('skipped');
      skip(pos, `item ${r.itemId}`, `item ${r.itemId}`, 'GameData has no building with this item id');
    } else if (def.kind === 'belt') {
      roles.push('belt');
    } else if (def.kind === 'sorter') {
      roles.push('sorter');
    } else if (PLACED_KINDS.has(def.kind)) {
      roles.push('building');
    } else {
      roles.push('skipped');
      const reason =
        def.kind === 'sprayCoater'
          ? 'the Layout model has no spray coaters yet, so a proliferator network is not simulated'
          : `the planner does not model this building (kind ${def.kind})`;
      skip(pos, `item ${r.itemId}`, `${def.name} (item ${r.itemId})`, reason);
    }
  });
  for (const s of skipped.values()) {
    warnings.push(`${s.positions.length} x ${s.label} skipped: ${s.reason} (records ${listRecords(s.positions)})`);
  }

  // Links that the importer follows must name a record. A skipped record's links do not matter.
  recs.forEach((r, pos) => {
    if (roles[pos] !== 'belt' && roles[pos] !== 'sorter') return;
    for (const field of ['outputObjIdx', 'inputObjIdx'] as const) {
      const v = r[field];
      if (!Number.isInteger(v) || v < -1 || v >= recs.length) {
        throw new Error(
          `record ${pos} (${defs[pos]?.name ?? `item ${r.itemId}`}): ${field} ${v} does not name a record of the blueprint (${recs.length} records)`,
        );
      }
    }
    if (roles[pos] === 'belt' && r.outputObjIdx === pos) {
      throw new Error(`record ${pos} (${defs[pos]?.name}): a belt that outputs to itself`);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Buildings

  const buildings: PlacedBuilding[] = [];
  const buildingAt = new Map<number, PlacedBuilding>();
  recs.forEach((r, pos) => {
    if (roles[pos] !== 'building') return;
    const def = defs[pos] as Building;
    const { yaw, off } = snapYaw(r.yaw);
    if (off > YAW_SNAP_WARN_DEG) {
      warnings.push(`building ${pos} (${def.name}): yaw ${r.yaw.toFixed(1)} is not a quarter turn and was snapped to ${yaw}`);
    }
    const b: PlacedBuilding = { id: pos, itemId: r.itemId, x: r.localOffset[0], y: r.localOffset[1], z: r.localOffset[2], yaw };
    if ((def.kind === 'production' || def.kind === 'lab') && r.recipeId > 0) b.recipeId = r.recipeId;
    if (def.kind === 'production' && r.parameters.length >= 1) b.prolifMode = r.parameters[0] === 1 ? 1 : 0;
    // A lab's parameters are [research mode, proliferator mode].
    if (def.kind === 'lab' && r.parameters.length >= 2) b.prolifMode = r.parameters[1] === 1 ? 1 : 0;
    if (def.kind === 'station') b.station = stationConfig(r, def, pos, warnings);
    buildings.push(b);
    buildingAt.set(pos, b);
  });

  linkStacks(buildings, (b) => data.building(b.itemId));

  // -------------------------------------------------------------------------------------------
  // Belts: chains of records, then the folded paths

  const beltPositions = recs.flatMap((_, pos) => (roles[pos] === 'belt' ? [pos] : []));
  const feeders = new Map<number, number[]>();
  for (const pos of beltPositions) {
    const to = recs[pos].outputObjIdx;
    if (to >= 0 && roles[to] === 'belt') {
      const list = feeders.get(to);
      if (list) list.push(pos);
      else feeders.set(to, [pos]);
    }
  }
  const nextInChain = new Map<number, number>();
  for (const [to, from] of feeders) nextInChain.set(continuationOf(to, from, recs, (m) => warnings.push(m)), to);

  const visited = new Set<number>();
  const walk = (start: number): number[] => {
    const chain: number[] = [];
    for (let at: number | undefined = start; at !== undefined && !visited.has(at); at = nextInChain.get(at)) {
      visited.add(at);
      chain.push(at);
    }
    return chain;
  };
  const chainRecs: number[][] = [];
  // Heads first (nothing feeds them), in record order; what is left is a ring.
  for (const pos of beltPositions) if (!feeders.has(pos)) chainRecs.push(walk(pos));
  for (const pos of beltPositions) if (!visited.has(pos)) chainRecs.push(walk(pos));
  chainRecs.sort((a, b) => a[0] - b[0]);

  const isStation = (pos: number): boolean => roles[pos] === 'building' && buildingAt.get(pos)?.station !== undefined;
  const validPort = (port: number): boolean => Number.isInteger(port) && port >= 0 && port < STATION_PORTS;
  /** Belt ends whose neighbour was skipped. One warning for all of them. */
  const openEnds: string[] = [];

  interface Folded {
    chain: Chain;
    source?: BeltPath['source'];
    sinkPort?: { buildingId: number; port: number };
  }
  const folded: Folded[] = chainRecs.map((list) => {
    const first = recs[list[0]];
    const last = recs[list[list.length - 1]];
    const out: Folded = { chain: { recs: list, head: 0, tail: 0 } };
    const id = list[0];

    if (first.inputObjIdx >= 0) {
      const from = first.inputObjIdx;
      if (isStation(from) && validPort(first.inputFromSlot)) {
        out.source = { buildingId: from, port: first.inputFromSlot };
      } else if (isStation(from)) {
        warnings.push(`belt ${id}: leaves station ${from} by port ${first.inputFromSlot}, which is not one of its ${STATION_PORTS}; the belt starts open`);
      } else if (roles[from] === 'skipped') {
        openEnds.push(`belt ${id} start (record ${from})`);
      }
    }
    const to = last.outputObjIdx;
    if (to >= 0 && roles[to] !== 'belt') {
      if (isStation(to) && validPort(last.outputToSlot)) {
        out.sinkPort = { buildingId: to, port: last.outputToSlot };
      } else if (isStation(to)) {
        warnings.push(`belt ${id}: enters station ${to} by port ${last.outputToSlot}, which is not one of its ${STATION_PORTS}; the belt ends open`);
      } else if (roles[to] === 'skipped') {
        openEnds.push(`belt ${id} end (record ${to})`);
      }
    }

    // Keep at least one node whatever the stubs claim.
    const wantHead = out.source ? PORT_STUB_RECORDS : 0;
    const wantTail = out.sinkPort ? PORT_STUB_RECORDS : 0;
    out.chain.head = Math.min(wantHead, list.length - 1);
    out.chain.tail = Math.min(wantTail, list.length - 1 - out.chain.head);
    if (out.chain.head < wantHead || out.chain.tail < wantTail) {
      warnings.push(`belt ${id}: only ${list.length} records, too few to fold both port stubs away; some stay as nodes`);
    }
    return out;
  });
  if (openEnds.length > 0) {
    warnings.push(`${openEnds.length} belt ends link to skipped buildings and were left open (${openEnds.slice(0, LISTED_RECORDS).join('; ')}${openEnds.length > LISTED_RECORDS ? '; ...' : ''})`);
  }

  // Where each belt record went: its chain, and the node it became (a stub maps to the nearest node).
  const nodeOf = new Map<number, { belt: number; node: number }>();
  folded.forEach(({ chain }, index) => {
    const nodeCount = chain.recs.length - chain.head - chain.tail;
    chain.recs.forEach((pos, i) => nodeOf.set(pos, { belt: index, node: Math.min(Math.max(i - chain.head, 0), nodeCount - 1) }));
  });

  /** The tier of a chain: the slowest of its records' (conservative), with a warning when they differ. */
  const tierOf = (list: number[]): BeltPath['tierItemId'] => {
    const tiers = [...new Set(list.map((pos) => recs[pos].itemId))];
    if (tiers.length === 1) return tiers[0] as BeltPath['tierItemId'];
    const speed = (itemId: number): number => data.building(itemId)?.belt?.speed ?? Infinity;
    const slowest = tiers.reduce((best, t) => (speed(t) < speed(best) ? t : best));
    const name = (itemId: number): string => data.building(itemId)?.name ?? `item ${itemId}`;
    warnings.push(`belt ${list[0]} mixes belt tiers (${tiers.map(name).join(', ')}); kept the slowest, ${name(slowest)}`);
    return slowest as BeltPath['tierItemId'];
  };

  const belts: BeltPath[] = folded.map(({ chain, source, sinkPort }) => {
    const list = chain.recs;
    const path: BeltPath = {
      id: list[0],
      tierItemId: tierOf(list),
      itemId: 0,
      nodes: list.slice(chain.head, list.length - chain.tail).map((pos) => point(recs[pos])),
      plannedRate: 0,
    };
    if (source) path.source = source;
    if (sinkPort) {
      path.sink = { kind: 'port', ...sinkPort };
    } else {
      const to = recs[list[list.length - 1]].outputObjIdx;
      const target = to >= 0 ? nodeOf.get(to) : undefined;
      if (target) path.sink = { kind: 'belt', beltId: folded[target.belt].chain.recs[0], node: target.node };
    }
    return path;
  });

  // -------------------------------------------------------------------------------------------
  // Sorters

  const sorters: Sorter[] = [];
  recs.forEach((r, pos) => {
    if (roles[pos] !== 'sorter') return;
    const def = defs[pos] as Building;
    const end = (which: 'pick' | 'drop'): Endpoint | null => {
      const link = which === 'pick' ? r.inputObjIdx : r.outputObjIdx;
      const slot = which === 'pick' ? r.inputFromSlot : r.outputToSlot;
      const lost = (why: string): null => {
        warnings.push(`sorter ${pos} (${def.name}) ${which}: ${why}; the sorter is skipped`);
        return null;
      };
      if (link < 0) return lost('it links no record');
      if (roles[link] === 'belt') {
        const at = nodeOf.get(link) as { belt: number; node: number };
        return { kind: 'belt', beltId: folded[at.belt].chain.recs[0], node: at.node };
      }
      if (roles[link] === 'building') {
        if (!Number.isInteger(slot) || slot < 0) return lost(`record ${link} is a building but the slot field is ${slot}`);
        return { kind: 'building', buildingId: link, slot };
      }
      const what = roles[link] === 'sorter' ? 'a sorter' : `${defs[link]?.name ?? `item ${recs[link].itemId}`}, which was skipped`;
      return lost(`record ${link} is ${what}`);
    };
    const pick = end('pick');
    const drop = end('drop');
    if (!pick || !drop) return;
    const rawSpan = r.parameters[0];
    if (rawSpan !== 1 && rawSpan !== 2 && rawSpan !== 3) {
      warnings.push(`sorter ${pos} (${def.name}): length parameter ${rawSpan ?? 'missing'} is not 1..3; read as 1`);
    }
    sorters.push({
      id: pos,
      tierItemId: r.itemId as Sorter['tierItemId'],
      filterItemId: r.filterId,
      span: rawSpan === 2 || rawSpan === 3 ? rawSpan : 1,
      pick,
      drop,
      plannedRate: 0,
    });
  });

  // -------------------------------------------------------------------------------------------
  // The item each belt carries, as far as the blueprint says

  const beltById = new Map(belts.map((b) => [b.id, b]));
  for (const belt of belts) {
    const source = belt.source;
    const cfg = source ? buildingAt.get(source.buildingId)?.station : undefined;
    const port = cfg?.ports[source?.port ?? -1];
    const fromStation = port && port.dir === 1 && port.storageIdx >= 1 ? cfg?.slots[port.storageIdx - 1]?.itemId : undefined;
    if (fromStation) belt.itemId = fromStation;
  }
  for (const s of sorters) {
    if (s.filterItemId === 0) continue;
    for (const e of [s.pick, s.drop]) {
      if (e.kind !== 'belt') continue;
      const belt = beltById.get(e.beltId);
      if (belt && belt.itemId === 0) belt.itemId = s.filterItemId;
    }
  }

  // -------------------------------------------------------------------------------------------

  const used = [...new Set(recs.flatMap((r, pos) => (roles[pos] === 'skipped' ? [] : [defs[pos] as Building])))];
  const approximate = used.length === 0 || used.some((d) => d.geometry.source !== 'extracted');
  return {
    layout: {
      buildings,
      belts,
      sorters,
      meta: {
        geometrySource: approximate ? 'approximate' : 'extracted',
        gameVersion: bp.header.gameVersion,
        planTargetItemId: bp.header.icons[0],
        planTargetRate: 0,
      },
    },
    warnings,
  };
}

/**
 * Of the belt records `from` that feed record `to`, the one the chain continues from; the others merge into it. The
 * first signal that settles it wins:
 *
 * 1. The slot: a feeder with `outputToSlot` 1 (the straight run) when it is the only one. A game export writes a side
 *    merge with 2 (the 0.10.34 sample: record 15 continues record 16 with 1, record 23 joins it with 2).
 * 2. The direction: the feeder that arrives in the direction the belt leaves `to` (the turn from the heading into `to` to
 *    the heading out of it is smallest), among the ones the slot left. A feeder on top of `to` arrives from nowhere.
 * 3. The record just before `to` in the file, among the ones left. A game export is not ordered like that (1 of 237 links
 *    in the capsule sample), so this only breaks a tie.
 * 4. The lowest record index.
 *
 * `warn` hears when the slot and the direction both settle it and disagree; the slot wins.
 */
function continuationOf(to: number, from: number[], recs: BlueprintBuilding[], warn: (message: string) => void): number {
  if (from.length === 1) return from[0];
  const straight = from.filter((pos) => recs[pos].outputToSlot === STRAIGHT_SLOT);
  const bySlot = straight.length === 1 ? straight[0] : undefined;

  const at = recs[to];
  const next = at.outputObjIdx >= 0 ? recs[at.outputObjIdx] : undefined;
  const leaving =
    next && Math.hypot(next.localOffset[0] - at.localOffset[0], next.localOffset[1] - at.localOffset[1]) > MIN_SEGMENT
      ? headingDeg(next.localOffset[0] - at.localOffset[0], next.localOffset[1] - at.localOffset[1])
      : at.yaw;
  const turnOf = (pos: number): number => {
    const dx = at.localOffset[0] - recs[pos].localOffset[0];
    const dy = at.localOffset[1] - recs[pos].localOffset[1];
    return Math.hypot(dx, dy) > MIN_SEGMENT ? headingGap(headingDeg(dx, dy), leaving) : 180;
  };
  const straightest = (candidates: number[]): number[] => {
    const best = Math.min(...candidates.map(turnOf));
    return candidates.filter((pos) => turnOf(pos) - best < SAME_TURN_DEG);
  };
  const byDirection = straightest(from);
  if (bySlot !== undefined) {
    if (byDirection.length === 1 && byDirection[0] !== bySlot) {
      warn(
        `belts merging at record ${to}: the slot fields make record ${bySlot} the straight run, but record ${byDirection[0]} ` +
          `arrives in the direction the belt leaves; went by the slot fields`,
      );
    }
    return bySlot;
  }

  // The slot did not single one out: narrow to the ones it left (all of them, if none reads 1), then by direction.
  const left = straightest(straight.length > 1 ? straight : from);
  if (left.length === 1) return left[0];
  return left.includes(to - 1) ? to - 1 : Math.min(...left);
}

/** The station parameters of `r` (BF §4.1) as a `StationConfig`. A missing parameter reads 0. */
function stationConfig(r: BlueprintBuilding, def: Building, pos: number, warnings: string[]): StationConfig {
  const at = (i: number): number => r.parameters[i] ?? 0;
  const what = `station ${pos} (${def.name})`;
  const logic = (v: number, label: string): 0 | 1 | 2 => {
    if (v === 0 || v === 1 || v === 2) return v;
    warnings.push(`${what}: ${label} ${v} is not 0, 1 or 2; read as 0`);
    return 0;
  };

  const storages = Math.min(STATION_MAX_STORAGES, def.station?.maxItemKinds ?? STATION_MAX_STORAGES);
  const slots: StationSlotConfig[] = [];
  for (let i = 0; i < storages; i++) {
    slots.push({
      itemId: at(6 * i),
      localLogic: logic(at(6 * i + 1), `storage ${i} localLogic`),
      remoteLogic: logic(at(6 * i + 2), `storage ${i} remoteLogic`),
      max: at(6 * i + 3),
    });
  }
  // Empty storages after the last used one carry nothing; one before it keeps its place (ports index storages from 1).
  while (slots.length > 0 && slots[slots.length - 1].itemId === 0) slots.pop();

  const ports: StationPortConfig[] = [];
  for (let s = 0; s < STATION_PORTS; s++) {
    const dir = at(192 + 4 * s);
    if (dir !== 0 && dir !== 1 && dir !== 2) warnings.push(`${what}: port ${s} dir ${dir} is not 0, 1 or 2; read as none`);
    ports.push({ dir: dir === 1 || dir === 2 ? dir : 0, storageIdx: Math.max(0, at(192 + 4 * s + 1)) });
  }

  const piler = at(328);
  if (!Number.isInteger(piler) || piler < 0 || piler > 4) warnings.push(`${what}: pilerCount ${piler} is not 0..4; clamped`);
  return { slots, ports, chargePerTick: at(320), pilerCount: Math.min(4, Math.max(0, Math.round(piler))) as StationConfig['pilerCount'] };
}

// ---------------------------------------------------------------------------------------------
// The plan an imported blueprint is simulated with

export interface RegressionPlanOptions {
  /** The item whose arrival at station input ports is the target rate. Default: the first supply slot's item. */
  targetItemId?: number;
  /** More items whose arrival `runSimulation` reports in `measuredExports` (the target and supply slots always are). */
  alsoReport?: readonly number[];
}

const recipeOrNull = (data: GameDataIndex, id: number): Recipe | null => {
  try {
    return data.recipe(id);
  } catch {
    return null;
  }
};

/**
 * A minimal `ProductionPlan` for an imported layout, so `runSimulation` can run on it.
 *
 * Stages: one per recipe id among the production buildings and labs, in layout order. `machines` is the count,
 * `craftsPerSecond` the full-speed capacity of those machines (each building's own speed, no proliferator, since a
 * layout without coaters sprays nothing), `buildingItemId` the most common building of the recipe. The simulator
 * matches a machine to its stage by recipe id.
 *
 * Target: the item of the first station slot configured as supply (`localLogic` 1), or `opts.targetItemId`. The other
 * supply slots' items are exports too, and `opts.alsoReport` adds more, so `SimResult.measuredExports` holds the arrival
 * rate of everything a regression fixture may have measured. Items in demand slots (`localLogic` 2) count as supplied.
 *
 * Provisioned rate: 0. An imported layout has no planned rate to hold it to, so nothing is judged against the plan (the
 * adaptive warm-up never sees the plan's rate reached and runs to its cap, and `deadlocked` stays false); a regression
 * compares `SimResult` with the rates measured in game instead. Throws if the layout has no supply slot and no target
 * is given.
 */
export function regressionPlanFor(
  layout: Layout,
  data: GameDataIndex,
  effects: TechEffects,
  opts: RegressionPlanOptions = {},
): ProductionPlan {
  const tps = data.data.constants.ticksPerSecond;

  // Stages
  interface Member {
    def: Building;
    speed: number;
  }
  const byRecipe = new Map<number, { recipe: Recipe; members: Member[] }>();
  for (const b of layout.buildings) {
    if (b.recipeId === undefined) continue;
    const def = data.building(b.itemId);
    const raw = def?.production?.speed ?? def?.lab?.assembleSpeed;
    const recipe = recipeOrNull(data, b.recipeId);
    if (!def || raw === undefined || !recipe) continue;
    const entry = byRecipe.get(b.recipeId) ?? { recipe, members: [] };
    entry.members.push({ def, speed: raw / 10000 });
    byRecipe.set(b.recipeId, entry);
  }
  const stages: Stage[] = [...byRecipe.values()].map(({ recipe, members }) => {
    const crafts = members.reduce((sum, m) => sum + (tps * m.speed) / recipe.timeTicks, 0);
    const counts = new Map<number, number>();
    for (const m of members) counts.set(m.def.itemId, (counts.get(m.def.itemId) ?? 0) + 1);
    // The most common building; the first listed wins a tie (Map keeps insertion order).
    const [dominantId] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    const dominant = members.find((m) => m.def.itemId === dominantId) as Member;
    const rates = (list: { itemId: number; count: number }[]): ItemRate[] => {
      const merged = new Map<number, number>();
      for (const { itemId, count } of list) merged.set(itemId, (merged.get(itemId) ?? 0) + count * crafts);
      return [...merged].map(([itemId, perSecond]) => ({ itemId, perSecond }));
    };
    return {
      recipeId: recipe.id,
      buildingItemId: dominantId,
      machines: members.length,
      exactMachines: members.length,
      craftsPerSecond: crafts,
      utilization: 1,
      inputs: rates(recipe.inputs),
      outputs: rates(recipe.outputs),
      perMachineCraftsPerSecond: crafts / members.length,
      proliferated: false,
      effectiveSpeed: members.reduce((sum, m) => sum + m.speed, 0) / members.length,
      workPowerW: dominant.def.power.workPerTick * tps,
      idlePowerW: dominant.def.power.idlePerTick * tps,
    };
  });

  // Stations: supply slots are what the block delivers, demand slots what it is fed
  const supply: number[] = [];
  const demand = new Set<number>();
  const stationSlots: StationSlotDemand[] = [];
  let stations = 0;
  let interstellar = false;
  for (const b of layout.buildings) {
    if (!b.station) continue;
    stations++;
    if (data.building(b.itemId)?.station?.isStellar) interstellar = true;
    for (const slot of b.station.slots) {
      if (slot.itemId === 0) continue;
      if (slot.localLogic === 1 && !supply.includes(slot.itemId)) supply.push(slot.itemId);
      if (slot.localLogic === 2) demand.add(slot.itemId);
      const role = slot.localLogic === 1 ? 'export' : 'import';
      const known = stationSlots.find((s) => s.itemId === slot.itemId);
      if (!known) stationSlots.push({ itemId: slot.itemId, role });
      else if (role === 'export') known.role = 'export';
    }
  }
  const target = opts.targetItemId ?? supply[0];
  if (target === undefined) {
    throw new Error(
      'regressionPlanFor: no station slot is configured as supply (local logic 1), so the layout names no target item; pass targetItemId',
    );
  }
  const exportItems = [...new Set([target, ...supply, ...(opts.alsoReport ?? [])])];

  const finalStage = stages.find((s) => s.outputs.some((o) => o.itemId === target)) ?? stages[stages.length - 1];
  const withoutPower: Omit<ProductionPlan, 'power'> = {
    request: {
      targetItemId: target,
      quantity: { kind: 'rate', perSecond: 0 },
      finalFacilityItemId: finalStage?.buildingItemId ?? 0,
      unlockedTechs: new Set(),
      suppliedItemIds: demand,
      facilityOverrides: {},
      recipeOverrides: {},
      proliferator: { tier: 0, mode: 'extra' },
      stationKind: interstellar ? 'interstellar' : 'planetary',
    },
    stages,
    flows: [],
    imports: [],
    exports: exportItems.map((itemId) => ({ itemId, perSecond: 0 })),
    actualTargetRate: 0,
    stationSlots,
    stationsNeeded: stations,
    proliferatorPerSecond: 0,
    warnings: ['regression plan: built from an imported layout; stage rates are machine capacities and no rate is provisioned'],
  };
  return { ...withoutPower, power: estimatePower(withoutPower, data, effects) };
}
