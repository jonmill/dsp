import type { ZodIssue } from 'zod';
import { GameDataSchema } from './schema';
import type { Building, GameData, Item, Recipe, RecipeType } from './schema';

/** The only GameData schemaVersion this build of the app understands. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Thrown when a GameData file is rejected; the message always names the file. */
export class GameDataError extends Error {
  readonly fileName: string;
  /** One `path: message` line per zod issue (all of them, untruncated). */
  readonly issues: string[];

  constructor(message: string, fileName: string, issues: string[] = []) {
    super(message);
    this.name = 'GameDataError';
    this.fileName = fileName;
    this.issues = issues;
  }
}

const MAX_REPORTED_ISSUES = 10;

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/** `meta.schemaVersion` if the input has one, without trusting the rest of the shape. */
function declaredSchemaVersion(json: unknown): unknown {
  if (typeof json !== 'object' || json === null) return undefined;
  const meta = (json as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  return (meta as { schemaVersion?: unknown }).schemaVersion;
}

/** Validate untrusted JSON as GameData. `fileName` is only used to name the file in errors. */
export function parseGameData(json: unknown, fileName: string): GameData {
  const version = declaredSchemaVersion(json);
  if (version !== undefined && version !== SUPPORTED_SCHEMA_VERSION) {
    throw new GameDataError(
      `${fileName}: unsupported GameData schemaVersion ${JSON.stringify(version)} ` +
        `(this app reads schemaVersion ${SUPPORTED_SCHEMA_VERSION}). ` +
        `Re-run dsp-extract with a matching version or update the app.`,
      fileName,
    );
  }

  const result = GameDataSchema.safeParse(json);
  if (result.success) return result.data;

  const issues = result.error.issues.map(formatIssue);
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((line) => `  ${line}`);
  if (issues.length > shown.length) shown.push(`  ... and ${issues.length - shown.length} more`);
  throw new GameDataError(
    `${fileName}: invalid GameData (${issues.length} issue${issues.length === 1 ? '' : 's'})\n${shown.join('\n')}`,
    fileName,
    issues,
  );
}

/**
 * Compare two game versions numerically by their digit runs, so `0.10.35.1` > `0.9.27.0` and the
 * extractor's `0.0.0+build<steam buildid>` fallback orders by build id. Missing parts count as 0.
 */
export function compareGameVersions(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Lookup tables over a GameData. Lookups by id throw (naming the id) when it is unknown. */
export class GameDataIndex {
  readonly data: GameData;
  private readonly itemsById = new Map<number, Item>();
  private readonly recipesById = new Map<number, Recipe>();
  private readonly buildingsByItemId = new Map<number, Building>();
  private readonly recipesByOutput = new Map<number, Recipe[]>();
  private readonly buildingsByRecipeType = new Map<RecipeType, Building[]>();

  constructor(d: GameData) {
    this.data = d;
    for (const item of d.items) this.itemsById.set(item.id, item);
    for (const recipe of d.recipes) {
      this.recipesById.set(recipe.id, recipe);
      for (const itemId of new Set(recipe.outputs.map((o) => o.itemId))) {
        const list = this.recipesByOutput.get(itemId);
        if (list) list.push(recipe);
        else this.recipesByOutput.set(itemId, [recipe]);
      }
    }
    for (const building of d.buildings) {
      this.buildingsByItemId.set(building.itemId, building);
      const type = building.production?.recipeType;
      if (type !== undefined) {
        const list = this.buildingsByRecipeType.get(type);
        if (list) list.push(building);
        else this.buildingsByRecipeType.set(type, [building]);
      }
    }
  }

  item(id: number): Item {
    const item = this.itemsById.get(id);
    if (!item) throw new Error(`GameData has no item ${id}`);
    return item;
  }

  recipe(id: number): Recipe {
    const recipe = this.recipesById.get(id);
    if (!recipe) throw new Error(`GameData has no recipe ${id}`);
    return recipe;
  }

  /** The building whose item id is `itemId`, or undefined if that item is not a building. */
  building(itemId: number): Building | undefined {
    return this.buildingsByItemId.get(itemId);
  }

  /** Recipes with `itemId` among their outputs, in GameData order. */
  recipesProducing(itemId: number): Recipe[] {
    return [...(this.recipesByOutput.get(itemId) ?? [])];
  }

  /** Buildings with a `production` block for this recipe type (labs are not included). */
  buildingsForRecipeType(t: RecipeType): Building[] {
    return [...(this.buildingsByRecipeType.get(t) ?? [])];
  }
}

async function parseAll(files: Record<string, () => Promise<unknown>>): Promise<GameData[]> {
  const parsed: GameData[] = [];
  // Sorted so ties on gameVersion resolve the same way on every machine.
  for (const path of Object.keys(files).sort()) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    parsed.push(parseGameData(await files[path](), fileName));
  }
  return parsed;
}

function newest(all: GameData[]): GameData {
  return all.reduce((best, d) =>
    compareGameVersions(d.meta.gameVersion, best.meta.gameVersion) > 0 ? d : best,
  );
}

/**
 * Load the GameData the app runs on: the extraction with the highest `meta.gameVersion` among
 * `data/dsp-*.json`, else the committed `data/fixture/dsp-fixture.json`. A file that fails
 * validation throws rather than being skipped, so a stale extraction is never silently ignored.
 */
export async function loadDefaultGameData(): Promise<GameData> {
  // Vite expands `import.meta.glob` where it is written. It sits inside the function, not at module
  // scope, so scripts run by tsx (no Vite) can still import GameDataIndex and parseGameData from here.
  // Eager: false keeps the data out of the main bundle until requested, and an empty match (no
  // extraction output / fixture committed yet) is just an empty record rather than a build error.
  // Paths are relative to this file: app/src/lib/data/ -> repo-root data/.
  const extractedFiles = import.meta.glob<unknown>('../../../../data/dsp-*.json', {
    eager: false,
    import: 'default',
  });
  const fixtureFiles = import.meta.glob<unknown>('../../../../data/fixture/*.json', {
    eager: false,
    import: 'default',
  });

  const extracted = await parseAll(extractedFiles);
  if (extracted.length > 0) return newest(extracted);

  const fixtures = await parseAll(fixtureFiles);
  if (fixtures.length > 0) return newest(fixtures);

  throw new GameDataError(
    'no GameData found: expected data/dsp-<gameVersion>.json (run dsp-extract) ' +
      'or data/fixture/dsp-fixture.json',
    'data/',
  );
}
