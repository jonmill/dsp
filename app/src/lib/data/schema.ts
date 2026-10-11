// GameData is the contract between the Python extractor and every TS module. This zod schema
// is the single owner: `scripts/export-schema.ts` derives data/schema/gamedata.schema.json from
// it, and the extractor validates its output against that file. Keep it to constructs that
// survive z.toJSONSchema (no refine/transform/preprocess), or the two sides drift apart.
import { z } from 'zod';

const int = z.number().int();

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
/** x, y, z, w (Unity order). */
export const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const RecipeTypeSchema = z.enum([
  'NONE',
  'SMELT',
  'CHEMICAL',
  'REFINE',
  'ASSEMBLE',
  'PARTICLE',
  'EXCHANGE',
  'PHOTON_STORE',
  'FRACTIONATE',
  'RESEARCH',
]);

export const ItemCountSchema = z.strictObject({ itemId: int, count: int });

export const ItemSchema = z.strictObject({
  id: int,
  name: z.string(),
  nameKey: z.string(),
  type: z.string(),
  stackSize: int,
  isFluid: z.boolean(),
  canBuild: z.boolean(),
  productive: z.boolean(),
  gridIndex: int,
  iconPath: z.string(),
  heatValue: int,
  modelIndex: int,
  /** Only items 1141-1143 (ability 1/2/4, sprays 12/24/60). */
  proliferator: z.strictObject({ ability: int, sprays: int }).optional(),
});

export const RecipeSchema = z.strictObject({
  id: int,
  name: z.string(),
  type: RecipeTypeSchema,
  timeTicks: int,
  inputs: z.array(ItemCountSchema),
  outputs: z.array(ItemCountSchema),
  explicit: z.boolean(),
  nonProductive: z.boolean(),
  handcraft: z.boolean(),
  gridIndex: int,
});

export const TechSchema = z.strictObject({
  id: int,
  name: z.string(),
  preTechs: z.array(int),
  preTechsImplicit: z.array(int),
  unlockRecipes: z.array(int),
  unlockFunctions: z.array(z.strictObject({ func: int, value: z.number() })),
  level: int,
  maxLevel: int,
  isObsolete: z.boolean(),
  isHidden: z.boolean(),
  published: z.boolean(),
  position: z.tuple([z.number(), z.number()]),
});

export const PoseSchema = z.strictObject({ position: Vec3Schema, rotation: QuatSchema });

export const ColliderSchema = z.strictObject({
  center: Vec3Schema,
  halfExtents: Vec3Schema,
  rotation: QuatSchema,
  usage: z.enum(['build', 'physics', 'other']),
});

export const BuildingKindSchema = z.enum([
  'production',
  'lab',
  'belt',
  'sorter',
  'splitter',
  'station',
  'powerNode',
  'sprayCoater',
  'piler',
  'storage',
  'fractionator',
  'other',
]);

export const BuildingSchema = z.strictObject({
  itemId: int,
  modelIndex: int,
  name: z.string(),
  kind: BuildingKindSchema,
  /** speed: 10000 = 1x. */
  production: z.strictObject({ recipeType: RecipeTypeSchema, speed: int }).optional(),
  lab: z.strictObject({ assembleSpeed: int, researchSpeed: int }).optional(),
  /** speed: cells per tick (1/2/5). */
  belt: z.strictObject({ speed: int }).optional(),
  sorter: z
    .strictObject({
      grade: int,
      stt: int,
      delay: int,
      canStack: z.boolean(),
      stackSize: int,
    })
    .optional(),
  station: z
    .strictObject({
      isStellar: z.boolean(),
      maxItemKinds: int,
      maxItemCount: int,
      maxEnergyAcc: int,
      maxDroneCount: int,
      maxShipCount: int,
    })
    .optional(),
  sprayCoater: z.strictObject({ incCapacity: int, incItemIds: z.array(int) }).optional(),
  power: z.strictObject({
    consumer: z.boolean(),
    workPerTick: int,
    idlePerTick: int,
    node: z
      .strictObject({
        connectDistance: z.number(),
        coverRadius: z.number(),
        powerPoint: Vec3Schema,
      })
      .optional(),
  }),
  geometry: z.strictObject({
    source: z.enum(['extracted', 'approximate']),
    /** Prefab space, metres. */
    colliders: z.array(ColliderSchema),
    /** Sorter attachment slots (PrefabDesc.slotPoses). */
    slots: z.array(PoseSchema),
    /** Belt ports (PrefabDesc.portPoses). */
    ports: z.array(PoseSchema),
    selectCenter: Vec3Schema,
    selectSize: Vec3Schema,
    landPoints: z.array(Vec3Schema),
    multiLevel: z.boolean(),
    multiLevelAllowInserter: z.boolean(),
    lapJoint: Vec3Schema,
    blueprintBoxSize: z.tuple([z.number(), z.number()]),
  }),
});

// The shape is kept separate so constantSources can be derived from the same key list.
const constantsShape = {
  ticksPerSecond: int, // 60
  cargoLength: int, // 10 (CargoPath.kCargoLength)
  beltCellsPerTile: z.number(), // 20 (MX §2.2, approximate)
  tileMeters: z.number(), // 1.2566370614359172
  levelMeters: z.number(), // 4/3
  sorterMaxReachMeters: z.number(), // 5.5
  sorterMaxGridSpan: z.number(), // 3.499
  beltMaxLevelBase: int, // 12
  beltMaxLevelPerVerticalTech: int, // 6
  incTableMilli: z.array(z.number()).length(11), // MX §5
  accTableMilli: z.array(z.number()),
  powerTableRatio: z.array(z.number()),
  // 100 / 10 / 20 (MX §4.3)
  assemblerOutputCrafts: z.strictObject({
    SMELT_items: int,
    ASSEMBLE_crafts: int,
    OTHER_crafts: int,
  }),
  // 200000 / 1000000
  stationDefaultChargePerTick: z.strictObject({ planetary: int, interstellar: int }),
};

export const ConstantsSchema = z.strictObject(constantsShape);

/** One provenance string per Constants key. */
export const ConstantSourcesSchema = z.strictObject(
  Object.fromEntries(Object.keys(constantsShape).map((k) => [k, z.string()])) as {
    [K in keyof typeof constantsShape]: z.ZodString;
  },
);

export const GameDataSchema = z.strictObject({
  meta: z.strictObject({
    schemaVersion: z.literal(1),
    gameVersion: z.string(),
    steamBuildId: z.string().optional(),
    extractedAt: z.string(),
    extractorVersion: z.string(),
    source: z.enum(['game', 'fixture']),
    protoSignatures: z.record(z.string(), z.string()).optional(),
  }),
  items: z.array(ItemSchema),
  recipes: z.array(RecipeSchema),
  techs: z.array(TechSchema),
  buildings: z.array(BuildingSchema),
  constants: ConstantsSchema,
  constantSources: ConstantSourcesSchema,
});

/**
 * The JSON Schema form of GameDataSchema, as committed to data/schema/gamedata.schema.json.
 * Draft 2020-12 is pinned because the extractor validates with jsonschema's Draft202012Validator;
 * io 'output' describes the parsed shape (optional keys stay optional).
 */
export function gameDataJsonSchema(): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(GameDataSchema, { target: 'draft-2020-12', io: 'output' });
}

export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quat = z.infer<typeof QuatSchema>;
export type RecipeType = z.infer<typeof RecipeTypeSchema>;
export type ItemCount = z.infer<typeof ItemCountSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type Tech = z.infer<typeof TechSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type Collider = z.infer<typeof ColliderSchema>;
export type BuildingKind = z.infer<typeof BuildingKindSchema>;
export type Building = z.infer<typeof BuildingSchema>;
export type Constants = z.infer<typeof ConstantsSchema>;
export type GameData = z.infer<typeof GameDataSchema>;
