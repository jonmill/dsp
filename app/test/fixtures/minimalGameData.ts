import type { GameData } from '../../src/lib/data/schema';

/**
 * A small, fully valid GameData literal for unit tests: one of each record type plus the
 * full Constants block. Returns a fresh object each call so tests may mutate it freely.
 */
export function minimalGameData(): GameData {
  return {
    meta: {
      schemaVersion: 1,
      gameVersion: '0.10.35.0',
      extractedAt: '2026-10-10T00:00:00Z',
      extractorVersion: 'test',
      source: 'fixture',
    },
    items: [
      {
        id: 1101,
        name: 'Iron Ingot',
        nameKey: '铁块',
        type: 'Material',
        stackSize: 100,
        isFluid: false,
        canBuild: false,
        productive: true,
        gridIndex: 1101,
        iconPath: 'Icons/ItemRecipe/iron-ingot',
        heatValue: 0,
        modelIndex: 0,
      },
    ],
    recipes: [
      {
        id: 1,
        name: 'Iron Ingot',
        type: 'SMELT',
        timeTicks: 60,
        inputs: [{ itemId: 1001, count: 1 }],
        outputs: [{ itemId: 1101, count: 1 }],
        explicit: false,
        nonProductive: false,
        handcraft: true,
        gridIndex: 1101,
      },
    ],
    techs: [
      {
        id: 1,
        name: 'Electromagnetism',
        preTechs: [],
        preTechsImplicit: [],
        unlockRecipes: [1],
        unlockFunctions: [{ func: 1, value: 1 }],
        level: 0,
        maxLevel: 0,
        isObsolete: false,
        isHidden: false,
        published: true,
        position: [0, 0],
      },
    ],
    buildings: [
      {
        itemId: 2302,
        modelIndex: 2,
        name: 'Arc Smelter',
        kind: 'production',
        production: { recipeType: 'SMELT', speed: 10000 },
        power: { consumer: true, workPerTick: 12000, idlePerTick: 400 },
        geometry: {
          source: 'approximate',
          colliders: [
            {
              center: [0, 1.5, 0],
              halfExtents: [1.4, 1.5, 1.4],
              rotation: [0, 0, 0, 1],
              usage: 'build',
            },
          ],
          slots: [{ position: [0, 0, 1.11], rotation: [0, 0, 0, 1] }],
          ports: [],
          selectCenter: [0, 1.5, 0],
          selectSize: [3, 3, 3],
          landPoints: [
            [-1.25, 0, -1.25],
            [1.25, 0, 1.25],
          ],
          multiLevel: false,
          multiLevelAllowInserter: false,
          lapJoint: [0, 0, 0],
          blueprintBoxSize: [3, 3],
        },
      },
    ],
    constants: {
      ticksPerSecond: 60,
      cargoLength: 10,
      beltCellsPerTile: 20,
      tileMeters: 1.2566370614359172,
      levelMeters: 4 / 3,
      sorterMaxReachMeters: 5.5,
      sorterMaxGridSpan: 3.499,
      beltMaxLevelBase: 12,
      beltMaxLevelPerVerticalTech: 6,
      incTableMilli: [0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400],
      accTableMilli: [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500],
      powerTableRatio: [0, 300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500, 3900],
      assemblerOutputCrafts: { SMELT_items: 100, ASSEMBLE_crafts: 10, OTHER_crafts: 20 },
      stationDefaultChargePerTick: { planetary: 200000, interstellar: 1000000 },
    },
    constantSources: {
      ticksPerSecond: 'test',
      cargoLength: 'test',
      beltCellsPerTile: 'test',
      tileMeters: 'test',
      levelMeters: 'test',
      sorterMaxReachMeters: 'test',
      sorterMaxGridSpan: 'test',
      beltMaxLevelBase: 'test',
      beltMaxLevelPerVerticalTech: 'test',
      incTableMilli: 'test',
      accTableMilli: 'test',
      powerTableRatio: 'test',
      assemblerOutputCrafts: 'test',
      stationDefaultChargePerTick: 'test',
    },
  };
}
