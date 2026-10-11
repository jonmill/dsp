// Tech state: which recipes and buildings a set of researched techs unlocks, and the logistics
// upgrade levels they grant. Unlock function ids, additive vs assign semantics and base values are
// from docs/research/game-data-extraction.md §3 (GameHistoryData.UnlockTechFunction, whose body is
// stripped in the reference DLL, and SetForNewGame).
import type { GameData, Tech } from './schema';

export interface TechEffects {
  /** Recipe ids the user can use: listed by an unlocked tech, or listed by no tech (initial recipes). */
  unlockedRecipes: Set<number>;
  /** Building item ids that some unlocked recipe outputs. */
  availableBuildings: Set<number>;
  /** Base 1, func 29 additive: station output stacking. */
  stationPilerLevel: number;
  /** Base 2, func 41 assign-max. */
  inserterStackInput: number;
  /** Base 1, func 39 assign-max. */
  inserterStackOutput: number;
  /** Base 3, func 25 additive: max vertical stack height of labs. */
  labLevel: number;
  /** Base 2, func 24 additive: max vertical stack height of storage. */
  storageLevel: number;
  /** Func 42 flag. */
  beltVerticalConstruction: boolean;
  /** `beltMaxLevelBase + beltMaxLevelPerVerticalTech * (unlocked techs 3701-3706)`. */
  beltMaxLevel: number;
}

const FUNC_STORAGE_LEVEL = 24;
const FUNC_LAB_LEVEL = 25;
const FUNC_STATION_PILER_LEVEL = 29;
const FUNC_INSERTER_STACK_OUTPUT = 39;
const FUNC_INSERTER_STACK_INPUT = 41;
const FUNC_BELT_VERTICAL_CONSTRUCTION = 42;

// Values before any tech, from GameHistoryData.SetForNewGame.
const BASE_STATION_PILER_LEVEL = 1;
const BASE_INSERTER_STACK_INPUT = 2;
const BASE_INSERTER_STACK_OUTPUT = 1;
const BASE_LAB_LEVEL = 3;
const BASE_STORAGE_LEVEL = 2;

// "Vertical Construction" levels 1-6: each raises the belt height limit, besides funcs 24 and 25.
const VERTICAL_CONSTRUCTION_FIRST_TECH = 3701;
const VERTICAL_CONSTRUCTION_LAST_TECH = 3706;

/** The game converts function values with `(int)(v + 0.5)`. */
function toInt(value: number): number {
  return Math.trunc(value + 0.5);
}

function techsById(data: GameData): Map<number, Tech> {
  return new Map(data.techs.map((t) => [t.id, t]));
}

function requireTech(byId: Map<number, Tech>, id: number): Tech {
  const tech = byId.get(id);
  if (!tech) throw new Error(`GameData has no tech ${id}`);
  return tech;
}

/**
 * `techIds` plus every tech they need, following `preTechs` transitively. `preTechsImplicit` is not
 * followed. Throws, naming the id, if a tech id is not in `data`.
 */
export function techClosure(data: GameData, techIds: Iterable<number>): Set<number> {
  const byId = techsById(data);
  const closure = new Set<number>();
  const pending = [...techIds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (closure.has(id)) continue;
    const tech = requireTech(byId, id);
    closure.add(id);
    pending.push(...tech.preTechs);
  }
  return closure;
}

/** Every published, non-obsolete tech (hidden ones included). */
export function allTechs(data: GameData): Set<number> {
  return new Set(data.techs.filter((t) => t.published && !t.isObsolete).map((t) => t.id));
}

/**
 * What the `unlocked` techs grant. Obsolete techs are ignored: they unlock nothing and apply no
 * function. A recipe that only an obsolete tech lists therefore stays locked (it is not an initial
 * recipe). `unlocked` is a set of tech protos, so a leveled tech (one proto per level band) counts
 * once, and additive functions sum over the protos in the set. Throws, naming the id, if `unlocked`
 * has an id that is not in `data`.
 */
export function computeTechEffects(data: GameData, unlocked: Set<number>): TechEffects {
  const byId = techsById(data);

  // Initial recipes are the ones no tech lists, obsolete techs included.
  const listed = new Set<number>();
  for (const tech of data.techs) for (const recipeId of tech.unlockRecipes) listed.add(recipeId);
  const unlockedRecipes = new Set<number>();
  for (const recipe of data.recipes) if (!listed.has(recipe.id)) unlockedRecipes.add(recipe.id);

  let stationPilerLevel = BASE_STATION_PILER_LEVEL;
  let inserterStackInput = BASE_INSERTER_STACK_INPUT;
  let inserterStackOutput = BASE_INSERTER_STACK_OUTPUT;
  let labLevel = BASE_LAB_LEVEL;
  let storageLevel = BASE_STORAGE_LEVEL;
  let beltVerticalConstruction = false;
  let verticalConstructionTechs = 0;

  for (const id of unlocked) {
    const tech = requireTech(byId, id);
    if (tech.isObsolete) continue;
    for (const recipeId of tech.unlockRecipes) unlockedRecipes.add(recipeId);
    if (id >= VERTICAL_CONSTRUCTION_FIRST_TECH && id <= VERTICAL_CONSTRUCTION_LAST_TECH) {
      verticalConstructionTechs++;
    }
    for (const { func, value } of tech.unlockFunctions) {
      switch (func) {
        case FUNC_STORAGE_LEVEL:
          storageLevel += toInt(value);
          break;
        case FUNC_LAB_LEVEL:
          labLevel += toInt(value);
          break;
        case FUNC_STATION_PILER_LEVEL:
          stationPilerLevel += toInt(value);
          break;
        case FUNC_INSERTER_STACK_OUTPUT:
          inserterStackOutput = Math.max(inserterStackOutput, toInt(value));
          break;
        case FUNC_INSERTER_STACK_INPUT:
          inserterStackInput = Math.max(inserterStackInput, toInt(value));
          break;
        case FUNC_BELT_VERTICAL_CONSTRUCTION:
          beltVerticalConstruction = true;
          break;
      }
    }
  }

  const buildingItemIds = new Set(data.buildings.map((b) => b.itemId));
  const availableBuildings = new Set<number>();
  for (const recipe of data.recipes) {
    if (!unlockedRecipes.has(recipe.id)) continue;
    for (const { itemId } of recipe.outputs) {
      if (buildingItemIds.has(itemId)) availableBuildings.add(itemId);
    }
  }

  return {
    unlockedRecipes,
    availableBuildings,
    stationPilerLevel,
    inserterStackInput,
    inserterStackOutput,
    labLevel,
    storageLevel,
    beltVerticalConstruction,
    beltMaxLevel:
      data.constants.beltMaxLevelBase +
      data.constants.beltMaxLevelPerVerticalTech * verticalConstructionTechs,
  };
}
