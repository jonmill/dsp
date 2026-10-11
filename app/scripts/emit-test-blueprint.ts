// Writes the M0 hand-made test blueprint to local/test-blueprints/m0-smelter-row.txt (gitignored).
// Run with `npm run emit:test-bp`. The user pastes it in-game to check the geometry assumptions
// (task 30 checklist): an ILS feeds Iron Ore along a belt past three Arc Smelters, each with a Mk.I
// input sorter and a Mk.I output sorter, and the ingots return on a second belt to the ILS.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { layoutToBlueprintString } from '../src/lib/blueprint/build';
import { GameDataIndex, parseGameData } from '../src/lib/data';
import type { Building, Pose } from '../src/lib/data';
import { prefabToGrid, TILE } from '../src/lib/geometry';
import type { BeltPath, Layout, PlacedBuilding, Sorter, StationPortConfig } from '../src/lib/geometry';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = resolve(repoRoot, 'data/fixture/dsp-fixture.json');
export const defaultOutPath = resolve(repoRoot, 'local/test-blueprints/m0-smelter-row.txt');

// ---------------------------------------------------------------------------------------------
// Slot cells. `slotInfos` / `portInfos` (src/lib/geometry/endpoints.ts) compute the same thing for the solver;
// this is the small independent version the hand-placed coordinates below are checked against, and
// endpoints.test.ts checks the two agree.

export interface SlotCell {
  /** The slot or port position in grid space. */
  pos: { x: number; y: number };
  /** Unit grid vector the slot faces (east, north). */
  dir: [number, number];
  /** First lattice point beyond the slot along its facing, not inside the footprint. */
  firstOutside: { x: number; y: number };
}

export function insideFootprint(b: PlacedBuilding, def: Building, x: number, y: number): boolean {
  const rad = (b.yaw * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const east = (x - b.x) * TILE;
  const north = (y - b.y) * TILE;
  // Back into prefab space (the inverse of prefabToGrid's rotation).
  const px = east * cos - north * sin;
  const pz = east * sin + north * cos;
  const boxes = def.geometry.colliders.filter((c) => c.usage === 'build');
  // Fixture colliders are axis-aligned boxes; a rotated collider would need the full OBB test (Task 14).
  return (boxes.length > 0 ? boxes : def.geometry.colliders).some(
    (c) => Math.abs(px - c.center[0]) < c.halfExtents[0] && Math.abs(pz - c.center[2]) < c.halfExtents[2],
  );
}

/**
 * The approximate-geometry rule for where a belt meets a slot or port: on the line through the pose along
 * its facing, at lateral = round(pose lateral), the first lattice point beyond the pose that is outside
 * the building's footprint.
 */
export function slotCell(b: PlacedBuilding, def: Building, pose: Pose): SlotCell {
  const pos = prefabToGrid(b, pose.position);
  // Prefab forward (+pz) rotated by the pose quaternion about y, then by the building yaw.
  const [qx, qy, qz, qw] = pose.rotation;
  const fwd = prefabToGrid({ x: 0, y: 0, z: 0, yaw: b.yaw }, [2 * (qx * qz + qw * qy), 0, 1 - 2 * (qx * qx + qy * qy)]);
  const len = Math.hypot(fwd.x, fwd.y);
  // `+ 0` turns -0 into 0.
  const dir: [number, number] = [Math.round(fwd.x / len) + 0, Math.round(fwd.y / len) + 0];
  if (Math.abs(dir[0]) + Math.abs(dir[1]) !== 1) throw new Error(`pose faces ${dir.join(',')}, not along an axis`);

  const alongX = dir[0] !== 0;
  const lateral = Math.round(alongX ? pos.y : pos.x);
  const normal = alongX ? pos.x : pos.y;
  const step = alongX ? dir[0] : dir[1];
  let n = step > 0 ? Math.floor(normal) + 1 : Math.ceil(normal) - 1;
  const at = (v: number) => (alongX ? { x: v, y: lateral } : { x: lateral, y: v });
  while (insideFootprint(b, def, at(n).x, at(n).y)) n += step;
  return { pos: { x: pos.x, y: pos.y }, dir, firstOutside: at(n) };
}

// ---------------------------------------------------------------------------------------------
// The layout

const ILS_ID = 1;
const IRON_ORE = 1001;
const IRON_INGOT = 1101;
const IRON_INGOT_RECIPE = 1;
const ARC_SMELTER = 2302;
const ILS = 2104;
const TESLA_TOWER = 2201;
const MK1_BELT = 2001;
const MK1_SORTER = 2011;

/** ILS ports (counter-clockwise from the north side's east port): 3 and 4 are the west side's north and middle. */
const ORE_PORT = 3;
const INGOT_PORT = 4;

/**
 * Hand-placed coordinates (the test re-derives each from the fixture with the slot-cell rule). Plan view,
 * x grows east and y north, one character per tile:
 *
 *     y= 2    T            T            T         Tesla towers at x = -4, -9, -14
 *     y= 1   P3 o  o  o  o  o  o  o  o  o  o  o   ore belt, flows west; node 0 = port 3's cell (-4, 1)
 *                      |in          |in          |in
 *     y=-1  ILS     [smelter 1]  [smelter 2]  [smelter 3]    centres x = -8, -11, -14
 *                      |out         |out         |out
 *     y=-3          o  o  o  o  o  o  o  o  o  o   ingot belt, flows east to (-5, -3), north to (-5, 0)
 *     y= 0   P4 o                                  then east: the last node is port 4's cell (-4, 0)
 *
 * Input sorters sit on each smelter's north slot 2, output sorters on its south slot 6.
 */
const SMELTER_X = [-8, -11, -14];
const SMELTER_Y = -1;
const ORE_ROW_Y = 1;
const INGOT_ROW_Y = -3;
const BELT_WEST_X = -14;
const TOWERS: [number, number][] = [
  [-4, 2],
  [-9, 2],
  [-14, 2],
];
/** North face, east-most slot of an Arc Smelter (slots run clockwise from the north face's west slot). */
const INPUT_SLOT = 2;
/** South face, east-most slot (south slots are 6..8, east to west). */
const OUTPUT_SLOT = 6;

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + Math.sign(to - from) * i);

export function buildM0Layout(data: GameDataIndex): Layout {
  const ports: StationPortConfig[] = Array.from({ length: 12 }, () => ({ dir: 0, storageIdx: 0 }));
  ports[ORE_PORT] = { dir: 1, storageIdx: 1 }; // outputs storage 1 (Iron Ore)
  ports[INGOT_PORT] = { dir: 2, storageIdx: 0 }; // takes Iron Ingot in

  const buildings: PlacedBuilding[] = [
    {
      id: ILS_ID,
      itemId: ILS,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      role: 'logistics',
      station: {
        slots: [
          { itemId: IRON_ORE, localLogic: 2, remoteLogic: 2, max: 10000 },
          { itemId: IRON_INGOT, localLogic: 1, remoteLogic: 1, max: 10000 },
        ],
        ports,
        chargePerTick: data.data.constants.stationDefaultChargePerTick.interstellar,
        pilerCount: 1,
      },
    },
    ...SMELTER_X.map(
      (x, i): PlacedBuilding => ({
        id: 2 + i,
        itemId: ARC_SMELTER,
        x,
        y: SMELTER_Y,
        z: 0,
        yaw: 0,
        recipeId: IRON_INGOT_RECIPE,
        prolifMode: 0,
        role: 'smelter',
      }),
    ),
    ...TOWERS.map(([x, y], i): PlacedBuilding => ({ id: 20 + i, itemId: TESLA_TOWER, x, y, z: 0, yaw: 0, role: 'power' })),
  ];

  const oreNodes = range(-4, BELT_WEST_X).map((x) => ({ x, y: ORE_ROW_Y, z: 0 }));
  const ingotNodes = [
    ...range(BELT_WEST_X, -5).map((x) => ({ x, y: INGOT_ROW_Y, z: 0 })),
    ...range(INGOT_ROW_Y + 1, 0).map((y) => ({ x: -5, y, z: 0 })),
    { x: -4, y: 0, z: 0 },
  ];
  const belts: BeltPath[] = [
    {
      id: 1,
      tierItemId: MK1_BELT,
      itemId: IRON_ORE,
      nodes: oreNodes,
      source: { buildingId: ILS_ID, port: ORE_PORT },
      plannedRate: SMELTER_X.length,
    },
    {
      id: 2,
      tierItemId: MK1_BELT,
      itemId: IRON_INGOT,
      nodes: ingotNodes,
      sink: { kind: 'port', buildingId: ILS_ID, port: INGOT_PORT },
      plannedRate: SMELTER_X.length,
    },
  ];

  // A smelter's slot 2 / slot 6 lateral is x + 0.796, so the sorter taps the belt node at x + 1.
  const sorters: Sorter[] = SMELTER_X.flatMap((x, i): Sorter[] => {
    const smelterId = 2 + i;
    return [
      {
        id: 1 + 2 * i,
        tierItemId: MK1_SORTER,
        filterItemId: 0,
        span: 1,
        pick: { kind: 'belt', beltId: 1, node: oreNodes.findIndex((n) => n.x === x + 1) },
        drop: { kind: 'building', buildingId: smelterId, slot: INPUT_SLOT },
        plannedRate: 1,
      },
      {
        id: 2 + 2 * i,
        tierItemId: MK1_SORTER,
        filterItemId: IRON_INGOT,
        span: 1,
        pick: { kind: 'building', buildingId: smelterId, slot: OUTPUT_SLOT },
        drop: { kind: 'belt', beltId: 2, node: ingotNodes.findIndex((n) => n.x === x + 1 && n.y === INGOT_ROW_Y) },
        plannedRate: 1,
      },
    ];
  });

  const used = [ILS, ARC_SMELTER, TESLA_TOWER, MK1_BELT, MK1_SORTER];
  const approximate = used.some((id) => data.building(id)?.geometry.source !== 'extracted');
  return {
    buildings,
    belts,
    sorters,
    meta: {
      geometrySource: approximate ? 'approximate' : 'extracted',
      gameVersion: data.data.meta.gameVersion,
      planTargetItemId: IRON_INGOT,
      planTargetRate: SMELTER_X.length,
    },
  };
}

export function buildM0Blueprint(data: GameDataIndex, now?: Date): string {
  return layoutToBlueprintString(buildM0Layout(data), data, {
    shortDesc: 'M0 smelter row',
    desc:
      'M0 hand-made test: an ILS feeds Iron Ore along a Mk.I belt past 3 Arc Smelters (recipe Iron Ingot). ' +
      'Each smelter has a Mk.I input sorter and a Mk.I output sorter onto a return belt to the ILS. ' +
      'ILS slot 0 Iron Ore (demand), slot 1 Iron Ingot (supply); port 3 outputs ore, port 4 takes ingots. ' +
      'Paste on flat ground with a Tesla tower connected to power.',
    now,
  });
}

export function loadFixture(): GameDataIndex {
  return new GameDataIndex(parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')), 'dsp-fixture.json'));
}

/** Build the M0 blueprint from the fixture data and write it to `outFile` (parent directories are created). */
export function writeM0Blueprint(outFile = defaultOutPath, now?: Date): string {
  const str = buildM0Blueprint(loadFixture(), now);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${str}\n`);
  return str;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const str = writeM0Blueprint();
  console.log(`wrote ${defaultOutPath} (${str.length} characters)`);
}
