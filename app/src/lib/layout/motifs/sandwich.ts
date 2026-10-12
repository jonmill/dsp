// Shared-belt sandwich (MX §9 M1): two mirrored rows of machines of one stage with a single belt between them. Each
// machine reaches that belt with a span-1 sorter on its slots facing it, and the two rows' tap points land on the
// same lattice row, so the router can run one straight belt along the middle instead of one per row.
//
// Only offsets are proposed; no net or sorter changes. For a building type:
//  - the row pitch is the smallest whole `dx > 0` at which two machines of a row do not overlap (3 tiles for a smelter,
//    4 for an assembler);
//  - the row gap is the smallest whole `dy > 0` at which a machine turned half a turn (the second row mirrors the
//    first) at `dy` north of another does not overlap it and has a slot facing it whose first lattice point outside is
//    the very point a slot of the other machine faces: the belt row, which must clear both footprints (4 tiles when
//    the belt is 2 tiles from each row's centres).
// A module is two rows of `m` machines, `m` up to `MAX_ROW`, of one stage and one building, in machine id order: the
// first `m` ids are the south row (the anchor first), the next `m` the north row.
import type { Building, GameDataIndex, TechEffects } from '../../data';
import { BELT_HALF_WIDTH_TILES, buildingDef, buildingOBBs, obbOverlap, pointInOBBs, slotInfos } from '../../geometry';
import type { PlacedBuilding } from '../../geometry';
import { checkGeometry } from '../../validate';
import type { Netlist } from '../netlist';
import type { Motif, MotifInstance } from './types';

/** Machines in a row of a module. */
const MAX_ROW = 3;
/** Pitches and gaps tried, in tiles. */
const MAX_OFFSET = 16;

export interface SandwichSpacing {
  /** Distance between neighbours in a row. */
  pitch: number;
  /** Distance between the rows, the shared belt in the middle. */
  gap: number;
}

const spacingCache = new WeakMap<GameDataIndex, Map<number, SandwichSpacing | null>>();

/** The row pitch and row gap of `itemId` (see the file comment), or undefined if its slots cannot share a belt row. */
export function sandwichSpacing(itemId: number, data: GameDataIndex, effects: TechEffects): SandwichSpacing | undefined {
  let byItem = spacingCache.get(data);
  if (!byItem) spacingCache.set(data, (byItem = new Map()));
  const known = byItem.get(itemId);
  if (known !== undefined) return known ?? undefined;
  const found = findSpacing(itemId, data, effects);
  byItem.set(itemId, found ?? null);
  return found;
}

function findSpacing(itemId: number, data: GameDataIndex, effects: TechEffects): SandwichSpacing | undefined {
  const def = buildingDef(data, itemId);
  const at = (x: number, y: number, yaw: PlacedBuilding['yaw'], id: number): PlacedBuilding => ({ id, itemId, x, y, z: 0, yaw });
  const lower = at(0, 0, 0, 1);
  const lowerObbs = buildingOBBs(lower, def);
  let lowerSlots;
  try {
    lowerSlots = slotInfos(lower, def);
  } catch {
    return undefined;
  }

  let pitch: number | undefined;
  for (let dx = 1; dx <= MAX_OFFSET && pitch === undefined; dx++) {
    const next = buildingOBBs(at(dx, 0, 0, 2), def);
    if (!lowerObbs.some((a) => next.some((b) => obbOverlap(a, b)))) pitch = dx;
  }
  if (pitch === undefined) return undefined;

  for (let gap = 1; gap <= MAX_OFFSET; gap++) {
    const upper = at(0, gap, 180, 2);
    const upperObbs = buildingOBBs(upper, def);
    if (lowerObbs.some((a) => upperObbs.some((b) => obbOverlap(a, b)))) continue;
    let upperSlots;
    try {
      upperSlots = slotInfos(upper, def);
    } catch {
      continue;
    }
    // a slot of each, facing the other, that taps the belt row at one and the same lattice point
    const shared = lowerSlots.some(
      (a) =>
        a.dir[0] === 0 &&
        a.dir[1] === 1 &&
        upperSlots.some((b) => b.dir[0] === 0 && b.dir[1] === -1 && a.firstOutside.x === b.firstOutside.x && a.firstOutside.y === b.firstOutside.y) &&
        !pointInOBBs(a.firstOutside.x, a.firstOutside.y, null, [...lowerObbs, ...upperObbs], BELT_HALF_WIDTH_TILES),
    );
    if (!shared) continue;
    const layout = {
      buildings: [lower, upper],
      belts: [],
      sorters: [],
      meta: { geometrySource: 'approximate' as const, gameVersion: 'motif', planTargetItemId: 0, planTargetRate: 0 },
    };
    if (checkGeometry(layout, data, effects).some((v) => v.code === 'BUILDING_OVERLAP')) continue;
    return { pitch, gap };
  }
  return undefined;
}

/** Can the machine be in a module: a production building. */
function capable(def: Building | undefined): boolean {
  return !!def && def.kind === 'production' && def.geometry.slots.length > 0;
}

export const sandwichMotif: Motif = {
  kind: 'sandwich',
  propose(net: Netlist, data: GameDataIndex, effects: TechEffects, taken: ReadonlySet<number> = new Set()): MotifInstance[] {
    // the free machines of each stage, in id order (a stage has one building and one recipe)
    const stages = new Map<number, number[]>();
    for (const m of net.machines) {
      if (taken.has(m.id) || !capable(data.building(m.buildingItemId))) continue;
      const list = stages.get(m.stageIndex);
      if (list) list.push(m.id);
      else stages.set(m.stageIndex, [m.id]);
    }

    const itemOf = new Map(net.machines.map((m) => [m.id, m.buildingItemId] as const));
    const found: MotifInstance[] = [];
    for (const [, unsorted] of [...stages].sort((a, b) => a[0] - b[0])) {
      const ids = unsorted.slice().sort((a, b) => a - b);
      const itemId = itemOf.get(ids[0]) as number;
      const spacing = sandwichSpacing(itemId, data, effects);
      if (!spacing) continue;
      for (let at = 0; ids.length - at >= 2; ) {
        const m = Math.min(MAX_ROW, Math.floor((ids.length - at) / 2));
        const chunk = ids.slice(at, at + 2 * m);
        at += 2 * m;
        found.push({
          kind: 'sandwich',
          machineIds: chunk,
          anchor: { x: 0, y: 0, yaw: 0 },
          relative: chunk.map((machineId, i) => ({
            machineId,
            dx: (i % m) * spacing.pitch,
            dy: i < m ? 0 : spacing.gap,
            dz: 0,
            yaw: i < m ? 0 : 180,
          })),
          internalSorters: [],
          satisfiesNets: [],
        });
      }
    }
    return found;
  },
};
