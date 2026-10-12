# DSP Factory Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the whole DSP factory planner described in the spec: a game-data extractor, a production calculator, a 3D layout solver, an independent validator with a tick simulator, a blueprint codec and a Svelte UI. It runs end to end on a fixture dataset, and the extractor is ready for the user to run against their real install.

**Architecture:** A Python extractor (`tools/extract`) writes a versioned `GameData` JSON whose schema is owned by zod in the app. The TypeScript app (`app/`) has these pure-logic modules, all tested with Vitest:
- `data`
- `geometry` (shared math and the layout model)
- `calc`
- `layout` (runs in a Web Worker)
- `validate` (independent of `layout`)
- `blueprint`

A Svelte 5 UI sits on top. Until the user runs the extractor, everything runs against `data/fixture/dsp-fixture.json`, which is derived from a public proto dump and uses **approximate** building geometry.

**Tech Stack:**
- App: TypeScript 5, Vite 8, Svelte 5 (runes), Vitest 5, zod 4 (`z.toJSONSchema`), pako 2.1, glpk.js 5.
- Extractor: Python ≥ 3.11, UnityPy ≥ 1.20 + TypeTreeGeneratorAPI ≥ 0.0.10 (optional `game` extra), jsonschema, pytest. `ilspycmd` (needs .NET 10) is only used at extraction time.

**Spec:** `docs/superpowers/specs/2026-10-10-dsp-factory-planner-design.md`

**Normative research references** (implementers MUST read the sections a task cites; they hold the exact formats and constants):
- `docs/research/blueprint-format.md` (BF)
- `docs/research/game-data-extraction.md` (GX)
- `docs/research/mechanics.md` (MX)
- `docs/research/datasets.md` (DS)

Raw public datasets are in `docs/research/datasets/` (gitignored, local only).

## Global Constraints

- The app is a local web app only: no backend server, no network calls at runtime.
- **No game mods** and no runtime use of game binaries. Game logic is re-implemented in TypeScript.
- **Game binaries, decompiled source (`local/`) and icons (`app/public/icons/`) are never committed.** Extracted JSON in `data/` is committed.
- The validator (`app/src/lib/validate/**`) must not import anything from `app/src/lib/layout/**`. An ESLint `no-restricted-imports` rule enforces this.
- Default solver time budget is **10 minutes** (overridable). Early stop: no footprint improvement in the most recent 20 % of elapsed time, after at least 30 s.
- Tick simulator gate defaults: 2 game-minutes warm-up, 5 game-minutes measurement, pass if target output ≥ 99 % of the plan rate, with no deadlocked entity.
- Simulator accuracy target: within 2 % of in-game measured rates (checked later against the user's regression set).
- Blueprint output profile: header v0, body version 2, building marker -101, `patch2 = 1`, `hasReform = 0` (BF §3.4).
- Everything game-derived carries provenance. Each `GameData.constants` key records its source in `constantSources`, and building geometry records `source: "extracted" | "approximate"`.
- Every ported game-logic function has a doc comment naming the game method it mirrors, written as `// mirrors: CargoPath.Update`. That name must be listed in `tools/extract/src/dsp_extract/mirrored_methods.py`.
- Python CLI name: `dsp-extract`. DSP Steam app id: `1366540`.
- Units: game ticks are 60/s. Power is held internally as J/tick (W = ×60) and shown to users in kW/MW. Grid tile = `2π·200/1000` m = 1.2566 m at the equator. Height level = 4/3 m.

## Review Focus

These five inputs or failure modes are implied by the spec but are easy to miss. Each line names its owning task; that task carries a test for it.

1. **The user's game is a newer or older version than the fixture**, so fields are added or missing. The extractor must fail loudly, naming the missing field, and must never silently write partial data (Task 7: missing-key test). The app must reject a data file whose `schemaVersion` it doesn't know, with a message naming the file (Task 2).
2. **A target that can't be built with the selected techs or inputs** (a locked recipe, or an item neither supplied nor craftable). The calculator returns a typed infeasibility naming the item or tech, never NaN or an empty plan (Task 11).
3. **Station slot overflow**: more distinct imports, exports and proliferator than one station's `maxItemKinds`. The plan must request more stations, and the layout must place them (Task 11 test; Task 29 test).
4. **Byproducts that nothing consumes** (e.g. hydrogen from Plasma Refining). They must get an export path; otherwise the simulator must flag the refinery as stalled. The validator must fail that layout, not pass it (Task 11 export test; Task 19 stall test).
5. **The blueprint is pasted where geometry assumptions are wrong**: approximate geometry, or yaw/axis conventions not yet verified in-game. Every generated blueprint and the UI must carry a visible "geometry: approximate / unverified" flag while `GameData` geometry is approximate (Task 9 builder test; Task 25 UI test).

---

## Shared conventions (all tasks)

### Coordinates

- **Grid space** (layout, validator, blueprint): `x` = east (longitude columns), `y` = north (latitude rows), both in **tiles**. `z` = height in **levels** (1 level = 4/3 m). Grid points are integer coordinates. A building whose footprint is an even number of tiles wide sits on `.5` coordinates (BF §5).
- **Prefab space** (GameData geometry, metres, Unity axes): `px` = right, `py` = up, `pz` = forward.
- **Prefab to grid for a building at grid `(bx, by, bz)` with yaw `θ` degrees (clockwise from north, viewed from above):**
  `east_m = px·cosθ + pz·sinθ`, `north_m = −px·sinθ + pz·cosθ`, `up_m = py`.
  Then `x = bx + east_m / TILE`, `y = by + north_m / TILE`, `z = bz + up_m / LEVEL`, with `TILE = 1.2566370614359172` and `LEVEL = 4/3`.
  This convention is an **assumption** until checked in-game. Keep it in one function (`prefabToGrid`, Task 14) so a fix is one edit.
- Yaw values used by the solver: `0 | 90 | 180 | 270`.

### File layout

```
app/                         Vite + Svelte 5 app
  src/lib/data/              GameData schema, loader, tech effects
  src/lib/geometry/          Layout model types, transforms, OBB math, footprints (shared by layout & validate)
  src/lib/calc/              Production planner
  src/lib/blueprint/         Codec + Layout→blueprint builder
  src/lib/validate/          Geometry checks, rate check, tick simulator
  src/lib/layout/            Netlist, placement, routing, power poles, solver orchestrator, worker
  src/ui/                    Svelte components
  test/fixtures/blueprints/  Blueprint string fixtures
data/
  fixture/dsp-fixture.json   Committed fixture GameData (approximate geometry)
  schema/gamedata.schema.json  Generated from zod (committed)
  dsp-<gameVersion>.json     Real extraction output (committed by the user later)
tools/extract/               Python package dsp_extract
local/                       gitignored: decompiled sources, extract reports
```

---

## Milestone M0: Foundations

### Task 1: Repository scaffolding

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/tsconfig.json`, `app/svelte.config.js`, `app/index.html`, `app/src/main.ts`, `app/src/App.svelte`, `app/eslint.config.js`, `app/test/smoke.test.ts`
- Create: `tools/extract/pyproject.toml`, `tools/extract/src/dsp_extract/__init__.py`, `tools/extract/tests/test_smoke.py`
- Create: `README.md` (root), `.nvmrc` (`22`)
- Modify: `.gitignore` (add `app/node_modules/`, `app/dist/`, `tools/extract/.venv/`, `.pytest_cache/`)

**Interfaces:**
- Produces:
  - npm scripts in `app/`: `dev`, `build`, `test` (`vitest run`), `lint` (`eslint .`), `check` (`svelte-check`).
  - Python package `dsp_extract` installable with `pip install -e 'tools/extract[dev]'`. The `game` extra holds `UnityPy>=1.20` and `TypeTreeGeneratorAPI>=0.0.10`. The `dev` extra holds `pytest` and `jsonschema`.

- [ ] **Step 1:** Scaffold `app/` by hand (not `npm create`, to avoid interactive prompts).
  - Dependencies: `svelte@^5`, `vite@^8`, `@sveltejs/vite-plugin-svelte`, `typescript`, `vitest`, `svelte-check`, `zod@^4`, `pako@^2.1` (byte-exact gzip verified only with 2.x, BF §1.2), `@types/pako`, `glpk.js@^5`, `eslint`, `typescript-eslint`, `eslint-plugin-svelte`.
  - `vite.config.ts`: Svelte plugin; `test: { environment: 'node', include: ['src/**/*.test.ts','test/**/*.test.ts'] }`; `server.fs.allow: ['..']` so the app can import `../data/*.json`.
- [ ] **Step 2:** In `eslint.config.js`, add a `no-restricted-imports` rule for files matching `src/lib/validate/**` that forbids patterns `**/lib/layout/**`, `../layout/*`, `../../layout/*` and `$lib/layout/*`, with the message "validator must stay independent of the solver". (`geometry/model.ts` is shared and allowed.) Verify the rule both ways: a temporary file under `src/lib/validate/` importing `../layout/x` fails lint, and one importing `../geometry/model` passes; delete both temporary files afterwards.
- [ ] **Step 3:** Write the smoke tests:
  - `app/test/smoke.test.ts`: `expect(1+1).toBe(2)`.
  - `tools/extract/tests/test_smoke.py`: imports `dsp_extract` and asserts `dsp_extract.__version__ == "0.1.0"`.
- [ ] **Step 4:** Run `cd app && npm install && npm test && npm run lint && npm run build`, then `python3 -m venv tools/extract/.venv && tools/extract/.venv/bin/pip install -e 'tools/extract[dev]' && tools/extract/.venv/bin/pytest tools/extract`. Expected: everything passes.
- [ ] **Step 5:** Root `README.md`: a project overview of 5 lines and a "Dev commands" section with the exact commands above.
- [ ] **Step 6:** Commit `chore: scaffold app and extractor packages`.

### Task 2: GameData schema, JSON Schema export and loader

**Files:**
- Create: `app/src/lib/data/schema.ts`, `app/src/lib/data/load.ts`, `app/src/lib/data/index.ts`, `app/scripts/export-schema.ts`
- Create: `data/schema/gamedata.schema.json` (generated)
- Test: `app/src/lib/data/schema.test.ts`, `app/src/lib/data/load.test.ts`

**Interfaces:**
- Produces (exact TypeScript, inferred from zod schemas named `GameDataSchema` etc.):

```ts
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x,y,z,w (Unity order)
export type RecipeType = 'NONE'|'SMELT'|'CHEMICAL'|'REFINE'|'ASSEMBLE'|'PARTICLE'|'EXCHANGE'|'PHOTON_STORE'|'FRACTIONATE'|'RESEARCH';
export interface ItemCount { itemId: number; count: number }
export interface Item {
  id: number; name: string; nameKey: string; type: string; stackSize: number;
  isFluid: boolean; canBuild: boolean; productive: boolean; gridIndex: number; iconPath: string;
  heatValue: number; modelIndex: number;
  proliferator?: { ability: number; sprays: number };      // only items 1141-1143 (ability 1/2/4, sprays 12/24/60)
}
export interface Recipe {
  id: number; name: string; type: RecipeType; timeTicks: number;
  inputs: ItemCount[]; outputs: ItemCount[];
  explicit: boolean; nonProductive: boolean; handcraft: boolean; gridIndex: number;
}
export interface Tech {
  id: number; name: string; preTechs: number[]; preTechsImplicit: number[];
  unlockRecipes: number[]; unlockFunctions: { func: number; value: number }[];
  level: number; maxLevel: number; isObsolete: boolean; isHidden: boolean; published: boolean;
  position: [number, number];
}
export interface Pose { position: Vec3; rotation: Quat }
export interface Collider { center: Vec3; halfExtents: Vec3; rotation: Quat; usage: 'build'|'physics'|'other' }
export type BuildingKind = 'production'|'lab'|'belt'|'sorter'|'splitter'|'station'|'powerNode'|'sprayCoater'|'piler'|'storage'|'fractionator'|'other';
export interface Building {
  itemId: number; modelIndex: number; name: string; kind: BuildingKind;
  production?: { recipeType: RecipeType; speed: number };        // 10000 = 1x
  lab?: { assembleSpeed: number; researchSpeed: number };
  belt?: { speed: number };                                       // cells per tick (1/2/5)
  sorter?: { grade: number; stt: number; delay: number; canStack: boolean; stackSize: number };
  station?: { isStellar: boolean; maxItemKinds: number; maxItemCount: number; maxEnergyAcc: number; maxDroneCount: number; maxShipCount: number };
  sprayCoater?: { incCapacity: number; incItemIds: number[] };
  power: { consumer: boolean; workPerTick: number; idlePerTick: number;
           node?: { connectDistance: number; coverRadius: number; powerPoint: Vec3 } };
  geometry: {
    source: 'extracted'|'approximate';
    colliders: Collider[];          // prefab space, metres
    slots: Pose[];                  // sorter attachment slots (PrefabDesc.slotPoses)
    ports: Pose[];                  // belt ports (PrefabDesc.portPoses)
    selectCenter: Vec3; selectSize: Vec3; landPoints: Vec3[];
    multiLevel: boolean; multiLevelAllowInserter: boolean; lapJoint: Vec3;
    blueprintBoxSize: [number, number];
  };
}
export interface Constants {
  ticksPerSecond: number;            // 60
  cargoLength: number;               // 10 (CargoPath.kCargoLength)
  beltCellsPerTile: number;          // 20 (MX §2.2, approximate)
  tileMeters: number;                // 1.2566370614359172
  levelMeters: number;               // 4/3
  sorterMaxReachMeters: number;      // 5.5
  sorterMaxGridSpan: number;         // 3.499
  beltMaxLevelBase: number;          // 12
  beltMaxLevelPerVerticalTech: number; // 6
  incTableMilli: number[];           // 11 entries, MX §5
  accTableMilli: number[];
  powerTableRatio: number[];
  assemblerOutputCrafts: { SMELT_items: number; ASSEMBLE_crafts: number; OTHER_crafts: number }; // 100 / 10 / 20 (MX §4.3)
  stationDefaultChargePerTick: { planetary: number; interstellar: number }; // 200000 / 1000000
}
export interface GameData {
  meta: { schemaVersion: 1; gameVersion: string; steamBuildId?: string; extractedAt: string;
          extractorVersion: string; source: 'game'|'fixture'; protoSignatures?: Record<string,string> };
  items: Item[]; recipes: Recipe[]; techs: Tech[]; buildings: Building[];
  constants: Constants; constantSources: Record<keyof Constants, string>;
}
```

- Also produces:
  - `load.ts`: `parseGameData(json: unknown, fileName: string): GameData`. It throws `GameDataError` whose message contains `fileName` and the zod issue path.
  - `class GameDataIndex { constructor(d: GameData); item(id): Item; recipe(id): Recipe; building(itemId): Building | undefined; recipesProducing(itemId): Recipe[]; buildingsForRecipeType(t: RecipeType): Building[] }`. Lookups throw on unknown ids, with the id in the message.
  - `loadDefaultGameData(): Promise<GameData>`. It imports every `../../../../data/dsp-*.json` via `import.meta.glob`, picks the highest semver `gameVersion`, and falls back to `data/fixture/dsp-fixture.json`.

- [ ] **Step 1:** Write failing tests in `schema.test.ts`:
  - A minimal valid GameData literal (one item, one recipe, one tech, one building, full constants) parses.
  - `schemaVersion: 2` is rejected.
  - A recipe missing `timeTicks` is rejected, and the error path includes `recipes.0.timeTicks`.
- [ ] **Step 2:** Run `npm test -- schema` and confirm the tests fail (module not found).
- [ ] **Step 3:** Implement the zod schemas: `.strict()` on every object, integers via `z.number().int()`, and `schemaVersion: z.literal(1)`. Export the inferred types.
- [ ] **Step 4:** Write `load.test.ts`:
  - `parseGameData({...bad}, 'dsp-0.10.35.json')` throws, with a message containing `dsp-0.10.35.json`.
  - `GameDataIndex.recipesProducing` returns both graphene recipes when given a two-recipe literal.
  - An unknown item id throws `/item 999/`.
- [ ] **Step 5:** Implement `load.ts` and `index.ts`. `loadDefaultGameData` is exercised later in the UI task; unit tests cover only `parseGameData` and the index.
- [ ] **Step 6:** Implement `scripts/export-schema.ts`, which calls `z.toJSONSchema(GameDataSchema)` and writes `data/schema/gamedata.schema.json` (2-space JSON). Add an npm script `schema` (`vite-node scripts/export-schema.ts`, or `tsx`; add whichever is used as a devDependency). Run it.
- [ ] **Step 7:** Run the tests; they must pass. Commit `feat(data): GameData zod schema, loader and JSON Schema export`.

### Task 3: Steam install discovery (Python)

**Files:**
- Create: `tools/extract/src/dsp_extract/vdf.py`, `tools/extract/src/dsp_extract/steam.py`
- Test: `tools/extract/tests/test_vdf.py`, `tools/extract/tests/test_steam.py`

**Interfaces:**
- Produces:
  - `vdf.parse(text: str) -> dict`: Valve KeyValues text with nested braces, quoted keys and values, `//` comments and escaped quotes.
  - `steam.DSP_APP_ID = "1366540"`.
  - `@dataclass(frozen=True) class GameInstall: root: Path; data_dir: Path; managed_dir: Path; build_id: str | None; library: Path | None`.
  - `steam.candidate_steamapps_dirs(home: Path, platform: str) -> list[Path]`, in the spec §4.1 order (Linux native, `~/.steam/steam`, Flatpak, Windows `C:/Program Files (x86)/Steam/steamapps`, macOS).
  - `steam.locate_game(game_dir: Path | None, home: Path, platform: str) -> GameInstall`. It raises `GameNotFoundError` with a message listing every path searched and suggesting `--game-dir`.
  - `GameInstall.compatdata_blueprint_dir() -> Path | None`. It returns `<library>/steamapps/compatdata/1366540/pfx/drive_c/users/steamuser/Documents/Dyson Sphere Program/Blueprint` if that directory exists.

- [ ] **Step 1:** Write failing `test_vdf.py`:
  - Parse a real-format `libraryfolders.vdf` (two libraries; the second with `"apps" { "1366540" "123" }`).
  - Parse an `appmanifest_1366540.acf` with `"installdir" "Dyson Sphere Program"` and `"buildid" "20345678"`.
  - Handle an escaped quote inside a value.
- [ ] **Step 2:** Implement `vdf.py` (a small hand-written tokenizer, no dependency). Run the tests until they pass.
- [ ] **Step 3:** Write failing `test_steam.py` using `tmp_path` to build fake trees:
  - (a) Native Linux: `home/.local/share/Steam/steamapps/libraryfolders.vdf` lists the library itself, plus the appmanifest, plus `common/Dyson Sphere Program/DSPGAME_Data/Managed/`. Expect `data_dir` to resolve and `build_id == "20345678"`.
  - (b) The game is in a **second** library listed in `libraryfolders.vdf` (e.g. `/mnt/games/SteamLibrary`).
  - (c) Flatpak path only.
  - (d) `--game-dir` given and pointing at the game root, which wins over (a).
  - (e) `--game-dir` pointing directly at `DSPGAME_Data` is also accepted.
  - (f) Nothing is found: `GameNotFoundError`, whose message contains each searched path string and `--game-dir`.
  - (g) An appmanifest exists but `DSPGAME_Data` is missing: an error that says the install looks incomplete.
- [ ] **Step 4:** Implement `steam.py`. Library resolution: for each candidate `steamapps` dir that exists, parse `libraryfolders.vdf` and collect `path` values plus the dir's own parent. For each library, check `steamapps/appmanifest_1366540.acf`, read `installdir`, then build `library/steamapps/common/<installdir>`. Run the tests until they pass.
- [ ] **Step 5:** Commit `feat(extract): locate DSP install via Steam libraries`.

### Task 4: Proto normalizer and fixture builder (Python)

The extractor and the fixture share one normalizer. It takes a **raw bundle** and produces GameData JSON. The raw bundle is the in-memory shape that both the game reader (Task 5) and the dsp-parser dump can produce.

**Files:**
- Create: `tools/extract/src/dsp_extract/raw.py` (RawBundle dataclasses)
- Create: `tools/extract/src/dsp_extract/normalize.py`
- Create: `tools/extract/src/dsp_extract/approx_geometry.py`
- Create: `tools/extract/src/dsp_extract/constants.py`
- Create: `tools/extract/src/dsp_extract/schema_check.py`
- Create: `tools/extract/src/dsp_extract/fixture.py` (CLI subcommand `dsp-extract fixture --from <dsp-parser dir> --out data/fixture/dsp-fixture.json`)
- Create: `data/fixture/dsp-fixture.json` (generated, committed)
- Test: `tools/extract/tests/test_normalize.py`, `tools/extract/tests/test_approx_geometry.py`, `tools/extract/tests/test_fixture.py`

**Interfaces:**
- Produces:

```python
@dataclass
class RawBuilding:
    item_id: int; model_index: int
    descs: dict[str, dict]           # component class name -> fields, e.g. "AssemblerDesc", "PowerDesc", "SlotConfig",
                                      # "BuildConditionConfig", "InserterDesc", "BeltDesc", "StationDesc", "SpraycoaterDesc", "LabDesc", ...
    colliders: list[dict] | None      # [{"center":[...],"halfExtents":[...],"rotation":[x,y,z,w],"usage":"build"|...}] or None if unknown
    slot_poses: list[dict] | None     # [{"position":[...],"rotation":[...]}] (sorter slots) or None if unknown
    port_poses: list[dict] | None     # belt ports, or None if unknown
@dataclass
class RawBundle:
    game_version: str; steam_build_id: str | None; source: str      # "game" | "fixture"
    items: list[dict]; recipes: list[dict]; techs: list[dict]       # proto dicts; keys in PascalCase (game) or camelCase (dump)
    buildings: list[RawBuilding]
    locale: dict[str, str]                                          # key -> English
    constants: dict[str, object]; constant_sources: dict[str, str]
    proto_signatures: dict[str, str]
def normalize(bundle: RawBundle, extractor_version: str, now_iso: str) -> dict   # GameData JSON (plain dicts)
def approx_geometry(descs: dict[str, dict], slot_count: int, port_count: int) -> dict  # GameData geometry with source "approximate"
DEFAULT_CONSTANTS: dict[str, object]; DEFAULT_CONSTANT_SOURCES: dict[str, str]
def validate_against_schema(gamedata: dict, schema_path: Path) -> None   # raises SchemaError listing the first 10 errors with JSON paths
```

- **Key normalization:** accept both `TimeSpend`/`timeSpend`, `ItemCounts`/`itemCounts`, etc. Normalize keys by lowercasing the first letter.
  - Enum values may arrive as strings (`"ASSEMBLE"`) or ints (4). Map ints using GX §2.2.
  - BigInt values `{":type":"BigInt","value":"…"}` become numbers.
- **Required vs defaulted fields** (Review Focus #1). The dump omits default-valued fields, so a missing field is an error **only** if it is REQUIRED:

  | Proto | REQUIRED (missing → `NormalizeError("<proto> <id> (<nameKey>): missing field <f>")`) | DEFAULTED (missing → default) |
  |---|---|---|
  | item | `id`, `name`, `type`, `stackSize`, `gridIndex` | `isFluid` false, `canBuild` false, `productive` false, `heatValue` 0, `modelIndex` 0, `iconPath` "", `ability` 0, `hpMax` 0 |
  | recipe | `id`, `name`, `type`, `timeSpend`, `items`, `itemCounts`, `results`, `resultCounts` | `handcraft` false, `explicit` false, `nonProductive` false, `gridIndex` 0 |
  | tech | `id`, `name` | `preTechs` [], `preTechsImplicit` [], `unlockRecipes` [], `unlockFunctions` [], `unlockValues` [], `level` 0, `maxLevel` 0, `isObsolete` false, `isHiddenTech` false, `published` false, `position` [0,0] |
  | descriptors | `AssemblerDesc.speed` (or `speedf`), `InserterDesc.stt` (or `sttf`), `BeltDesc.speed`, `StationDesc.maxItemKinds` | `PowerDesc` absent → `{consumer:false, workPerTick:0, idlePerTick:0}`; `PowerDesc.consumer`/`workEnergyPerTick`/`idleEnergyPerTick` absent → false/0/0; `InserterDesc.delay` 0, `canStack` false, `stackSize` 1 |

- **Raw game descriptor field mapping with unit conversion** (the game's MonoBehaviours differ from the dump; GX §2.6 table). Normalize accepts BOTH shapes:
  - `AssemblerDesc`: `speed` (int, 10000 = 1×) **or** `speedf` (float) → `speed = round(speedf*10000)`.
  - `InserterDesc`: `stt` **or** `sttf` → `round(sttf*600000)`; `delay` **or** `delayf` → `round(delayf*600000)`; `grade` taken from the descriptor if present, else from the upgrade chain (2011→1 … 2014→4).
  - `LabDesc.assembleSpeed`/`researchSpeed`: an int ≥ 100 is used as-is; a float < 100 → `round(v*10000)`.
  - Plausibility guards (raise `NormalizeError`): production `speed < 100`, sorter `stt < 1000`, belt `speed` not in 1..20.
  - Test with a game-shaped `RawBuilding` (`AssemblerDesc {recipeType: 4, speedf: 0.75}` → `production.speed == 7500`; `InserterDesc {sttf: 0.33333334}` → `stt == 200000`).
- **Game version** (`RawBundle.game_version`): the fixture uses `meta.json`. The game reader (Task 5/7) uses the decompiled `GameConfig` version (major.minor.release.build) when ilspycmd is available, else `"0.0.0+build<steam buildid>"`. If neither exists, raise `ExtractError("cannot determine game version")`.
- **Names:** `name = locale.get(nameKey, nameKey)`.
- **Building kind:** derived from the descriptors present.
  - `AssemblerDesc` → production.
  - `LabDesc` → lab.
  - `BeltDesc.speed > 0` → belt.
  - `InserterDesc` → sorter; `grade` comes from the item's position in the sorter upgrade chain (2011→1, 2012→2, 2013→3, 2014→4).
  - `StationDesc` with `isCollector == false` **and** `isVeinCollector == false` → station (the Advanced Mining Machine 2316 is a vein collector → other).
  - `PowerDesc.node` → powerNode.
  - `SpraycoaterDesc` → sprayCoater.
  - `SplitterDesc` or item 2020 → splitter.
  - `FractionatorDesc` → fractionator.
  - `PilerDesc` → piler.
  - `StorageDesc` → storage.
  - Anything else → other.
- **Geometry:** when `colliders`, `slot_poses` or `port_poses` is `None`, call `approx_geometry` and set `source: "approximate"`. When all three are present, set `"extracted"`.

**Approximate geometry rules** (deterministic, documented in a module docstring):
- Footprint half-extents `hx, hz`: the max |x| and |z| over `BuildConditionConfig.landPoints` when there are at least 2 points. Otherwise `SlotConfig.selectSize/2 − 0.1`. Height `hy = selectSize.y/2`, center `(selectCenter.x, hy, selectCenter.z)` and identity rotation. Produce one `build` collider.
  - **Cross-shaped land points** (both `(±a, ±b)` and `(±b, ±a)` present with a ≠ b, e.g. PLS/ILS `(±4,±2)` and `(±2,±4)`): produce **two** build boxes, half-extents `(a, hy, b)` and `(b, hy, a)`.
- Sorter slots: `n = len(SlotConfig.insertPoses)`. Slot `y = 0` (real sorters sit at z ≈ 0).
  - n = 12 (assemblers, smelters, labs; **values derived from real blueprint samples by the plan review**): 3 per side. Slot centre at normal offset **1.11 m** from the building centre, lateral offsets **−1.0, 0, +1.0 m**. **Index order clockwise starting at the north side's west slot**: north (+z) 0 (W), 1, 2 (E); east (+x) 3 (N), 4, 5 (S); south (−z) 6 (E), 7, 8 (W); west (−x) 9 (S), 10, 11 (N). Rotation faces outward: yaw 0 = +z, 90 = +x, 180 = −z, 270 = −x, as a quaternion about +y.
  - n = 8: 4 on each long side at lateral offsets `−1.5, −0.5, 0.5, 1.5` tiles, normal offset = half-extent − 0.9 m, indexed clockwise as above.
  - n = 9: 3 per side on +z, −z and +x, normal offset = half-extent − 0.9 m.
  - Other n: spread round-robin over the sides at offsets centred on 0, spaced 1 tile apart, normal offset = half-extent − 0.9 m.
- Belt ports: `m = len(SlotConfig.slotPoses)`.
  - m = 12 (stations; **derived from the ILS sample**): 3 per side at normal offset **2.70 m** (≈2.15 tiles), lateral offsets **−TILE, 0, +TILE**, facing outward. **Index order counter-clockwise starting at the north side's east port**: north 0 (E), 1, 2 (W); west 3 (N), 4, 5 (S); south 6 (W), 7, 8 (E); east 9 (S), 10, 11 (N). Use the same numbers for the PLS.
  - m = 4 (splitter): one per side, at 0 offset.
  - Otherwise round-robin as for slots.
- **Calibration test (assembler):** decode the capsule sample's 8 Assembler Mk.II and their attached Mk.III sorters (pure Python decode of the -101 records: re-use a minimal reader written in the test, following BF §3.3). For each sorter end connected to an assembler (via `inputObjIdx`/`outputObjIdx` and the slot fields `inputFromSlot`/`outputToSlot`), convert the end to the assembler's local frame (BF yaw) and assert that it lies within **0.35 m** of the approximate slot **with that slot index**.
- **Calibration test (station):** decode `ils-configured-0.9.24.txt`. For each belt whose `inputObjIdx` is the ILS, assert that the first belt node (local frame) lies within **0.35 m** of the approximate port with index `inputFromSlot`.
- If a calibration test fails, fix the approximation (not the tolerance) and record the derived numbers in the module docstring.

**Constants:**
- `DEFAULT_CONSTANTS` holds the Constants values from Task 2 (incTable `0,125,200,225,250,275,300,325,350,375,400`, accTable `0,250,…,2500`, powerTable `0,300,700,1100,1500,1900,2300,2700,3100,3500,3900`, MX §5).
- Each has its source in `DEFAULT_CONSTANT_SOURCES`, e.g. `"research:mechanics.md§5 (unverified)"`. Real extraction overrides sources whose values it reads from code (Task 6).

**Fixture source mapping (dsp-parser):**
- `items.json` entries with `_XxxDesc` keys become `RawBuilding.descs["XxxDesc"]` (underscore stripped).
- `locale.json` holds a list of languages; pick the entry with `lcid == 1033` (`locale: "en-US"`) and use its `strings` map.
- Proliferator items 1141–1143: `proliferator = {ability: item.ability, sprays: item.hpMax}`.
- `meta.json` gives `game_version`.

**Tests:**
- [ ] **Step 1:** `test_normalize.py` (failing first):
  - camelCase and PascalCase recipe dicts normalize identically.
  - Enum int 4 → `"ASSEMBLE"`.
  - BigInt decoding.
  - An unknown building with no descriptors → kind `"other"`.
  - Locale fallback to the key.
  - A recipe missing `timeSpend` raises `NormalizeError("recipe 51 (处理器): missing field timeSpend")`. This is the missing-key test from Review Focus #1.
  - A recipe missing `explicit`/`handcraft`/`nonProductive` normalizes with `false` defaults (DEFAULTED fields never raise).
  - A tech missing `preTechs` normalizes to `[]`.
  - Game-shaped descriptors: `AssemblerDesc {recipeType: 4, speedf: 0.75}` → `production.speed == 7500`; `InserterDesc {sttf: 0.33333334, delayf: 0}` → `sorter.stt == 200000`; `AssemblerDesc {speedf: 0.0001}` raises (plausibility guard).
  - The Advanced Mining Machine (StationDesc with `isVeinCollector: true`) → kind `"other"`.
- [ ] **Step 2:** Implement `raw.py`, `normalize.py` and `constants.py`. Run the tests until they pass.
- [ ] **Step 3:** `test_approx_geometry.py`:
  - The assembler (landPoints ±2) gives half-extents `(2, 2.3, 2)` and 12 slots.
  - The station gives 12 ports, 3 per face, in the counter-clockwise order above (port 0 is on the north face, east end), and two cross-shaped build boxes.
  - Slot index 3 on the assembler is on the east face, north end (`position ≈ (1.11, 0, 1.0)`).
  - Both calibration tests above, which read `docs/research/blueprint-samples/capsule-production-v2-reform-0.10.33.txt` and `ils-configured-0.9.24.txt`. Skip with a clear reason if a file is missing.
- [ ] **Step 4:** Implement `approx_geometry.py`. Run the tests until they pass.
- [ ] **Step 5:** Implement `schema_check.py` using `jsonschema` (Draft 2020-12) against `data/schema/gamedata.schema.json`. Implement `fixture.py`.
- [ ] **Step 6:** `test_fixture.py`, which skips if `docs/research/datasets/dsp-parser` is absent:
  - Building the fixture to a tmp path validates against the schema.
  - It has ≥ 160 recipes.
  - Recipe 51 has `timeTicks` 180, inputs `[{1301,2},{1302,2}]` and outputs `[{1303,1}]`.
  - Item 1141 has `proliferator == {ability:1, sprays:12}` (sprays come from `hpMax` in the dump).
  - Building 2303 has `production.speed == 7500` and `power.workPerTick == 4500`.
  - Building 2104 has `station.maxItemKinds == 5`.
  - Every building has `geometry.source == "approximate"`.
- [ ] **Step 7:** Generate the committed fixture: `tools/extract/.venv/bin/dsp-extract fixture --from docs/research/datasets/dsp-parser --out data/fixture/dsp-fixture.json`. Then check from the app: add `app/src/lib/data/fixture.test.ts`, which reads the file and calls `parseGameData`, and assert that it passes.
- [ ] **Step 8:** Commit `feat(extract): proto normalizer, approximate geometry, fixture dataset`.

### Task 5: Unity asset reader (Python, game files)

This can't be tested against a real install in CI. Tests use **fakes** that imitate UnityPy's object API. The code must produce a detailed diagnostic report so the first real run on the user's machine tells us exactly what to fix.

**Files:**
- Create: `tools/extract/src/dsp_extract/unity_reader.py`
- Create: `tools/extract/src/dsp_extract/prefab.py`
- Create: `tools/extract/src/dsp_extract/locale_files.py`
- Create: `tools/extract/src/dsp_extract/report.py`
- Test: `tools/extract/tests/test_locale_files.py`, `tools/extract/tests/test_prefab.py`, `tools/extract/tests/test_unity_reader.py`

**Interfaces:**
- Consumes: `GameInstall` (Task 3), `RawBundle`/`RawBuilding` (Task 4).
- Produces:
  - `unity_reader.read_game_version(install, decompiled: dict[str,str] | None) -> str`: parses `GameConfig` from decompiled source (the `gameVersion` / `Version(major, minor, release, build)` construction; record the regex in a docstring) when available, else `"0.0.0+build<buildid>"`; raises `ExtractError("cannot determine game version")` if neither exists. Test both paths with inline C# and a fake install.
  - `locale_files.load_english(game_root: Path) -> dict[str,str]`. Reads `Locale/Header.txt` and `Locale/1033/*.txt` (UTF-16 LE with BOM, falling back to UTF-8; lines are `key\t?\t?\ttext`; unescape `\n \t \r \\`). GX §2.5.
  - `unity_reader.read_bundle(install: GameInstall, report: Report) -> RawBundle`. Uses UnityPy with `TypeTreeGenerator.load_local_game` (GX §5) and the GX §1 locations. Collects ProtoSets by MonoScript class name; asserts the expected keys (`dataArray`, and for ItemProto `ID`, `ModelIndex`, `CanBuild`) and raises `ExtractError` naming the class and the missing key.
  - `prefab.read_building(env_adapter, model_proto: dict, item: dict, report) -> RawBuilding`. Implements the GX §2.6 static-extraction plan:
    - Resolve `ModelProto.PrefabPath.lower()` through the `ResourceManager` container.
    - Walk the hierarchy in `GetComponentsInChildren` order.
    - Collect the first instance of each descriptor MonoBehaviour by class name.
    - Compose world poses for the `SlotConfig.slotPoses`/`insertPoses` Transform PPtrs. Ports = `slotPoses`, slots = `insertPoses`; mind the naming trap.
    - Read Box/Sphere/Capsule colliders as `{center (composed world), halfExtents = size*lossyScale/2, rotation, usage}`, where usage is `"build"` when the GameObject layer or name indicates build colliders. That rule is **unknown** (GX gap 1), so implement it as a pluggable function `classify_collider(go_name, layer, is_trigger) -> usage`. The default heuristic: layer name/number matching the build layer (record every distinct `(layer, is_trigger, name)` in the report), else `"build"` if it is a BoxCollider and not a trigger. Record the decision in the report.
    - Any failure sets that geometry part to `None` (so normalize falls back to approximate geometry for that building) and adds a warning to the report. It must never crash the whole extraction.
  - `report.Report`: collects `info/warn/error` entries plus structured sections (`unity_version`, `files_loaded`, `protosets_found`, `per_building_geometry`, `collider_layers_seen`). It writes `local/extract-report.json` and a human summary to stdout.
  - An `EnvAdapter` protocol wrapping UnityPy (`objects_of_type(name)`, `script_class(obj)`, `read_typetree(obj)`, `deref(pptr)`, `container() -> dict[str, pptr]`), so tests can inject fakes.

- [ ] **Step 1:** `test_locale_files.py`: write a UTF-16-LE-with-BOM `Locale/1033/Item.txt` and a `Header.txt` into tmp. `load_english` maps `处理器 → Processor`. Escaped `\n` unescapes. A UTF-8 file without a BOM also works. Implement, then make the test pass.
- [ ] **Step 2:** `test_prefab.py`: build a fake hierarchy using small dataclasses that imitate UnityPy readers:
  - root GameObject → child "slots" with three Transform children with local positions and rotations; a SlotConfig MonoBehaviour whose `slotPoses`/`insertPoses` reference them; an AssemblerDesc; a BoxCollider on a child with scale 2.
  - Assert the composed world positions (root rotated 90° about y), the port/slot name swap, collider half-extents with scale applied, and the first-match-wins rule for descriptors.
  - A missing SlotConfig yields `slot_poses=None` plus a report warning.
- [ ] **Step 3:** Implement `prefab.py` (pure functions over `EnvAdapter`; quaternion math by hand: compose, rotate vector). Run the tests until they pass.
- [ ] **Step 4:** `test_unity_reader.py`: a fake `EnvAdapter` returning ProtoSet MonoBehaviours for Item, Recipe, Tech and Model with minimal dataArrays. `read_bundle` returns a RawBundle with the protos, the locale map from tmp files and `proto_signatures` from each set's `Signature`. A ProtoSet missing `dataArray` raises `ExtractError` mentioning the class name.
- [ ] **Step 5:** Implement `unity_reader.py`. Import UnityPy **lazily** inside a `UnityEnvAdapter` class, so the module imports without the `game` extra. If the import fails, raise `ExtractError("UnityPy not installed: pip install 'dsp-extract[game]'")`. Run the tests until they pass.
- [ ] **Step 6:** Commit `feat(extract): Unity asset reader with prefab geometry and diagnostics`.

### Task 6: Decompilation, fingerprints and code constants (Python)

**Files:**
- Create: `tools/extract/src/dsp_extract/decompile.py`
- Create: `tools/extract/src/dsp_extract/mirrored_methods.py`
- Create: `tools/extract/src/dsp_extract/code_constants.py`
- Create: `data/fingerprints.json` (empty `{}` initially; written by real runs)
- Test: `tools/extract/tests/test_decompile.py`, `tools/extract/tests/test_code_constants.py`

**Interfaces:**
- Produces:
  - `mirrored_methods.MIRRORED: dict[str, str]`, mapping game method (`"CargoPath.Update"`) to the TS module that mirrors it (`"app/src/lib/validate/sim/belt.ts"`). The initial list covers every method named in Tasks 8, 15, 17, 18 and 19: `BlueprintData.Export`, `BlueprintData.Import`, `MD5F.Compute`, `CargoPath.Update`, `CargoPath.TryInsertItem`, `CargoPath.TryPickItem`, `CargoPath.TryInsertItemAtHeadAndFillBlank`, `InserterComponent.InternalUpdate`, `AssemblerComponent.InternalUpdate`, `AssemblerComponent.UpdateNeeds`, `SpraycoaterComponent.InternalUpdate`, `StationComponent.UpdateOutputSlots`, `StationComponent.UpdateInputSlots`, `PowerSystem.GameTick`, `LabComponent.InternalUpdateAssemble`, `BuildTool_Click.CheckBuildConditions`, `BuildTool_Path.CheckBuildConditions`, `BuildTool_Inserter.CheckBuildConditions`. Each later task that adds a `// mirrors: X` comment must add `X` here (Task 30 adds a consistency test).
  - `decompile.find_ilspycmd() -> str | None`.
  - `decompile.decompile_types(ilspy: str, managed_dir: Path, types: list[str], out_dir: Path) -> dict[str, Path]` runs `ilspycmd --disable-updatecheck -r <managed> -t <Type> <managed>/Assembly-CSharp.dll`.
  - `decompile.extract_method(source: str, method: str) -> str | None`: brace-matching extraction of every overload whose name matches. Overloads are joined in source order.
  - `decompile.normalize_body(src: str) -> str`: strip comments and blank lines, collapse whitespace.
  - `decompile.fingerprint(body: str) -> str` (sha256 hex of the normalized body).
  - `decompile.drift_report(old: dict, new: dict, mirrored: dict) -> list[DriftEntry]`, where `DriftEntry(method, ts_module, status: "changed"|"missing"|"new", diff: str | None)`. `diff` is a unified diff (difflib) of the old vs new normalized method body when the previous decompiled source is present in `local/decompiled/` (spec §4.4); the previous decompile is kept by renaming the directory to `local/decompiled.prev/` before a new run.
  - `code_constants.parse_constants(sources: dict[str,str]) -> tuple[dict, dict]` parses `Cargo.incTableMilli`, `accTableMilli` and `powerTableRatio` from the decompiled `Cargo` source, plus `CargoPath.kCargoLength`. It returns `(values, sources)`; missing values are simply absent, so defaults remain.

- [ ] **Step 1:** `test_decompile.py` with an inline C# sample class containing two overloads of `InternalUpdate`, a nested brace inside a string literal and a `//` comment:
  - `extract_method` returns both overloads.
  - Braces inside strings and chars don't break matching.
  - `normalize_body` ignores comment and whitespace changes (equal fingerprints).
  - A real body change gives a different fingerprint.
  - `drift_report` flags changed/missing/new.
  - `find_ilspycmd` returns None when PATH is empty (monkeypatch).
- [ ] **Step 2:** Implement `decompile.py` and `mirrored_methods.py`. Run the tests until they pass.
- [ ] **Step 3:** `test_code_constants.py` on an inline sample, `public static readonly int[] incTableMilli = new int[11] { 0, 125, 200, ... };`: values and sources (`"decompiled:Cargo.incTableMilli"`) are parsed. Implement, then make the test pass.
- [ ] **Step 4:** Commit `feat(extract): decompile, fingerprint drift detection, code constants`.

### Task 7: Extractor CLI end-to-end (Python)

**Files:**
- Create: `tools/extract/src/dsp_extract/cli.py` (console script `dsp-extract`)
- Create: `tools/extract/src/dsp_extract/writer.py`
- Create: `tools/extract/src/dsp_extract/icons.py`
- Create: `tools/extract/README.md`
- Test: `tools/extract/tests/test_cli.py`, `tools/extract/tests/test_writer.py`

**Interfaces:**
- CLI:
  - `dsp-extract [--game-dir PATH] [--out DIR (default: <repo>/data)] [--copy-blueprints] [--icons] [--no-decompile] [--check] [--report PATH]`
  - `dsp-extract fixture --from DIR --out FILE`
  - `dsp-extract inspect [--game-dir PATH]`: lists the files, Unity version, ProtoSet classes found and the first 3 entries of each, plus a prefab walk of 5 sample models (assembler-mk-1, logistic-station, inserter-1, belt-1, tesla tower) into the report. No GameData is written.
- Default flow:
  1. `locate_game`
  2. `read_bundle`
  3. decompile (unless `--no-decompile`, or ilspycmd is missing, which is a warning) and parse code constants
  4. write fingerprints, plus drift vs the existing `data/fingerprints.json`
  5. `normalize`
  6. `validate_against_schema`
  7. atomic write of `data/dsp-<gameVersion>.json` (tmp file + `os.replace`)
  8. optional icon export to `app/public/icons/<iconName>.png`
  9. optional blueprint copy to `app/test/fixtures/blueprints/game/`
  10. print the summary
  - Exit codes: 0 ok; 2 game not found; 3 extraction error; 4 schema validation failure; 5 drift found with `--check`.
- `writer.write_atomic(path: Path, data: dict) -> None` never leaves a partial file. On an exception the target is untouched.
- The repo root is located by walking up from cwd to find `data/schema/gamedata.schema.json`; error if not found.

- [ ] **Step 1:** `test_writer.py`:
  - `write_atomic` writes the file.
  - When serialization raises (an unserializable object is injected), the existing target file is unchanged and no tmp file remains.
- [ ] **Step 2:** Implement `writer.py`. Run the tests until they pass.
- [ ] **Step 3:** `test_cli.py` (monkeypatch `read_bundle` to return a small valid RawBundle and `locate_game` to return a fake install):
  - The exit code is 0 and `data/dsp-0.10.35.29104.json` exists and validates (the fake bundle's `game_version` is `0.10.35.29104`).
  - A schema failure (the bundle produces an invalid recipe) gives exit 4, and no output file is created.
  - Game not found gives exit 2, with the message on stderr.
  - `--check` with a fingerprint drift gives exit 5.
  - The `fixture` subcommand works on a minimal fake dsp-parser dir.
- [ ] **Step 4:** Implement `cli.py` and `icons.py`. Icons: Texture2D export via UnityPy with names from `IconPath` (GX §5 pitfalls); failures warn only. Register `[project.scripts] dsp-extract = "dsp_extract.cli:main"`. Run the tests until they pass.
- [ ] **Step 5:** `tools/extract/README.md`:
  - Nobara setup: `sudo dnf install python3 python3-pip dotnet-sdk-10.0` (or `dotnet-install.sh --channel 10.0`); `dotnet tool install -g ilspycmd`; venv plus `pip install -e 'tools/extract[game,dev]'`.
  - The run commands, the exit codes, and what to send back when something fails (`local/extract-report.json`).
- [ ] **Step 6:** Commit `feat(extract): dsp-extract CLI with atomic output and diagnostics`.

### Task 8: Blueprint codec (TypeScript)

**Files:**
- Create: `app/src/lib/blueprint/md5f.ts`, `app/src/lib/blueprint/escape.ts`, `app/src/lib/blueprint/binary.ts` (ByteReader/ByteWriter), `app/src/lib/blueprint/model.ts`, `app/src/lib/blueprint/codec.ts`, `app/src/lib/blueprint/index.ts`
- Create: `app/test/fixtures/blueprints/*.txt` (copied from `docs/research/blueprint-samples/`)
- Test: `app/src/lib/blueprint/md5f.test.ts`, `escape.test.ts`, `codec.test.ts`

**Interfaces:**
- Produces (from `model.ts`):

```ts
export type BuildingMarker = -1 | -100 | -101 | -102;   // -1 = legacy (no marker)
export interface BlueprintArea { index: number; parentIndex: number; tropicAnchor: number; areaSegments: number;
  anchorLocalOffsetX: number; anchorLocalOffsetY: number; width: number; height: number }
export interface BlueprintBuilding {
  marker: BuildingMarker; index: number; areaIndex: number;
  localOffset: [number, number, number]; localOffset2: [number, number, number];
  yaw: number; yaw2: number; tilt: number; pitch: number; tilt2: number; pitch2: number;
  itemId: number; modelIndex: number;
  outputObjIdx: number; inputObjIdx: number;
  outputToSlot: number; inputFromSlot: number; outputFromSlot: number; inputToSlot: number;
  outputOffset: number; inputOffset: number;
  recipeId: number; filterId: number; parameters: Int32Array;
  contentFlag?: number; content?: string;           // -102 only
}
export interface BlueprintHeader { rawCells: string[]; headerVersion: number; layout: number; icons: [number,number,number,number,number];
  ticks: bigint; gameVersion: string; shortDesc: string; desc: string;
  author?: string; customVersion?: string; attributes?: string }   // v1 cells
export interface BlueprintBody { version: number; cursorOffsetX: number; cursorOffsetY: number; cursorTargetArea: number;
  dragBoxSizeX: number; dragBoxSizeY: number; primaryAreaIdx: number; areas: BlueprintArea[]; buildings: BlueprintBuilding[];
  patch2?: number; reformRaw?: Uint8Array }   // trailer (version >= 2): hasReform byte + reform block preserved raw
export interface Blueprint { header: BlueprintHeader; body: BlueprintBody; gzipOs: number }
```

- Also produces:
  - `md5f(bytes: Uint8Array): string` (uppercase hex; BF §2.2, verbatim algorithm).
  - `escapeDataString(s)` and `unescapeDataString(s)` (BF §1.3; the unescape is tolerant of malformed `%`).
  - `decodeBlueprint(str: string): Blueprint`. Throws `BlueprintError` with a `code`: `'NOT_BLUEPRINT'|'HEADER'|'BASE64'|'GZIP'|'BODY'|'HASH'`. The hash check runs first, unless `{ verifyHash: false }`.
  - `encodeBlueprint(bp: Blueprint): string`. Re-emits `header.rawCells` for any field not changed. Compression is `pako.gzip(raw, {level: 6, header: {os: bp.gzipOs}})` (BF §1.2).
  - `encodeBody(body)` and `decodeBody(bytes)` (exported for tests).

- [ ] **Step 1:** `md5f.test.ts`: every vector in BF §2.3, including the two sample strings (hash of `str.slice(0, lastIndexOf('"'))`). Run it and see it fail. Implement `md5f.ts`. Run it and see it pass.
- [ ] **Step 2:** `escape.test.ts`:
  - `escapeDataString("a b!()*'") === "a%20b%21%28%29%2A%27"`.
  - Non-ASCII `"处理器"` becomes uppercase-hex UTF-8.
  - `unescapeDataString("100%")` returns `"100%"` and doesn't throw.
  - Implement, then make the tests pass.
- [ ] **Step 3:** `codec.test.ts`, for each of the 4 hash-valid samples:
  - `encodeBlueprint(decodeBlueprint(s)) === s` (byte-exact).
  - For the 0.10.34 sample: decode with `{verifyHash:false}`, then re-encode and compare everything except the 32-char hash.
  - Structural assertions: the capsule sample has 331 buildings with marker -101 and body version 2. The ILS sample's station params `[0..5]` = `[6001,1,1,10000,...]` per the BF sample README, and `params[320] = 1000000`. The mixed sample has `areas[0].areaSegments == 160`.
  - A tampered string (one base64 char changed) throws `code 'HASH'`.
  - A truncated body throws `code 'BODY'`.
- [ ] **Step 4:** Implement `binary.ts`, `codec.ts` and `index.ts`, following BF §3 exactly: all four building formats, the version-2 trailer and the -102 content (7-bit length-prefixed UTF-8). Ticks are a bigint parsed from the raw header cell. Run the tests until they all pass.
- [ ] **Step 5:** Commit `feat(blueprint): byte-exact DSP blueprint codec with MD5F`.

### Task 9: Layout model and Layout→Blueprint builder

**Files:**
- Create: `app/src/lib/geometry/model.ts` (Layout model types; shared contract)
- Create: `app/src/lib/blueprint/build.ts`
- Create: `app/scripts/emit-test-blueprint.ts`
- Test: `app/src/lib/blueprint/build.test.ts`

**Interfaces:**
- Produces (`geometry/model.ts`; used by every later task):

```ts
export type Yaw = 0 | 90 | 180 | 270;
export interface GridPoint { x: number; y: number; z: number }           // tiles, tiles, levels
export interface StationSlotConfig { itemId: number; localLogic: 0|1|2; remoteLogic: 0|1|2; max: number }
export interface StationPortConfig { dir: 0|1|2; storageIdx: number }   // dir: 0 none, 1 output, 2 input; storageIdx 1-based
export interface StationConfig { slots: StationSlotConfig[]; ports: StationPortConfig[] /* length 12 */;
  chargePerTick: number; pilerCount: 0|1|2|3|4 }
export interface PlacedBuilding {
  id: number; itemId: number; x: number; y: number; z: number; yaw: Yaw;
  recipeId?: number; prolifMode?: 0 | 1;               // 0 extra products, 1 speedup
  station?: StationConfig; role?: string;               // free-form tag e.g. "stage:51"
}
export type Endpoint =
  | { kind: 'building'; buildingId: number; slot: number }            // sorter slot index on the building
  | { kind: 'belt'; beltId: number; node: number };                   // node index on the belt path
export interface BeltPath {
  id: number; tierItemId: 2001 | 2002 | 2003; itemId: number;          // carried item (0 = proliferator/mixed not used in v1)
  nodes: GridPoint[];                                                  // in flow order, consecutive nodes adjacent
  source?: { buildingId: number; port: number };                       // belt starts at a building belt port (station output)
  sink?: { kind: 'port'; buildingId: number; port: number } | { kind: 'belt'; beltId: number; node: number };
  plannedRate: number;                                                 // items/s the solver intends to carry
}
export interface Sorter { id: number; tierItemId: 2011 | 2012 | 2013 | 2014; filterItemId: number; span: 1 | 2 | 3;
  pick: Endpoint; drop: Endpoint; plannedRate: number }
export interface Layout {
  buildings: PlacedBuilding[]; belts: BeltPath[]; sorters: Sorter[];
  meta: { geometrySource: 'extracted' | 'approximate'; gameVersion: string; planTargetItemId: number; planTargetRate: number };
}
```

- Also produces:
  - `build.ts`: `layoutToBlueprint(layout: Layout, data: GameDataIndex, opts: { shortDesc: string; desc: string; now?: Date }): Blueprint`, plus `layoutToBlueprintString(...) = encodeBlueprint(layoutToBlueprint(...))`.
  - Building records use marker -101. Indexes: buildings first (in `layout.buildings` order), then belt nodes (belt by belt, node by node), then sorters. `index == position`.
  - Positions: translate by the **integer** offset `(−floor(minX), −floor(minY))` over all emitted positions (including fractional sorter ends and port stubs), applied identically to everything, so buildings stay on their grid parity. Single area `{0,-1,0,200,0,0,w,h}`, where `w/h` = ceil(extent)+1. `cursorOffset` = centre, `dragBox = (w,h)`.
  - Belt node record: `itemId = tierItemId`, `modelIndex` from `GameDataIndex.building(tier).modelIndex`.
    - `yaw` = direction to the next node (last node: same as the previous). `tilt = 0`.
    - Each node's `outputObjIdx` = the next node's index. The last node's `outputObjIdx` = the sink building index with `outputToSlot = sink.port`, or the merge belt node index for a belt sink, else -1.
    - The first node with a `source` has `inputObjIdx = station index` and `inputFromSlot = port`.
    - **Port stubs** (derived from the ILS sample by the plan review: belts leaving a port have nodes at ≈2.15 and ≈3.02 tiles from the station centre before reaching the lattice at 4.0): for a belt with a `source` port, the builder emits two extra belt records **before** `nodes[0]`: the port position itself (`prefabToGrid(port.position)`), then the midpoint between it and `nodes[0]`. For a belt with a `sink` port, it emits the mirror image after the last node (midpoint, then the port position). Stub records carry the station link (the first stub has `inputObjIdx = station`, `inputFromSlot = port`; the last sink stub has `outputObjIdx = station`, `outputToSlot = port`). Stubs exist only in the blueprint, not in `Layout` (the validator and solver reason about `nodes`, whose first/last node is the port's `firstOutside` lattice point).
    - Belts change level only by **vertical lifts** (consecutive nodes with equal x/y and `|dz| = 1`), as seen in the capsule sample; `tilt` is always 0.
    - Slot fields per BF §3.3: belt chain `outputToSlot=1, inputFromSlot=0, outputFromSlot=0, inputToSlot=1, offsets 0`, except the overrides above.
  - Sorter record:
    - `localOffset` = pick world position and `localOffset2` = drop world position, from `sorterEnds(sorter, layout, data)` (Task 14 owns it; until Task 14 exists, implement it locally in `build.ts` and move it later). Building end: `prefabToGrid(slot.position)`. Belt end (**derived from the capsule sample**): the projection of the building slot's position onto the belt's axis line through the tap node, i.e. the point on the belt at the slot's lateral coordinate (e.g. a side slot at lateral +0.795 tiles gives a belt end at lateral +0.795, not at the node). Building↔building: both slot positions.
    - `yaw`/`yaw2` = direction from pick to drop. `parameters = [span]`. `filterId = filterItemId`.
    - `inputObjIdx` = pick target index and `outputObjIdx` = drop target index.
    - `inputFromSlot` = pick slot (building) or -1 (belt). `outputToSlot` = drop slot or -1. `outputFromSlot=0`, `inputToSlot=1`.
  - Production building: `recipeId` and `parameters = [prolifMode ?? 0]`. Station: 2048 params per BF §4.1, from `StationConfig` (slot `itemId`, `localLogic`, `remoteLogic`, `max`; port `dir`, `storageIdx`; `params[320] = chargePerTick`; `params[328] = pilerCount`; drone/ship defaults: `321 = 64278761` (50°), `326 = 1`, `327 = 1`, `330 = 1`). Power node: 0 params.
  - Header: layout 10, `icons[0]` = target item id, `gameVersion = layout.meta.gameVersion`. `desc` gets the line `"[geometry: approximate - unverified in game]"` appended when `meta.geometrySource === 'approximate'` (Review Focus #5).
  - Body version 2, patch2 = 1, no reform, gzipOs 0x0A.

- [ ] **Step 1:** `build.test.ts` (failing):
  - (a) A layout with 1 ILS and 1 Mk.III belt of 5 nodes leaving station port 3: `decodeBlueprint(layoutToBlueprintString(...))` round-trips. The belt chain links are correct (`outputObjIdx` chain, first node `inputObjIdx` = station index, `inputFromSlot == 3`). Station `params[192+4*3] == 1` when port 3 is configured as an output.
  - (b) A smelter + Mk.I sorter + belt: the sorter's `inputObjIdx`/`outputObjIdx` point at the smelter/belt records, and `parameters[0] == span`.
  - (c) `desc` contains "approximate" when the geometry is approximate, and does not otherwise.
  - (d) Every record has `index == position` and all link indexes are in range.
  - (e) Station slot params: a StationConfig with slot 0 `{itemId 1001, localLogic 2, remoteLogic 2, max 10000}` and slot 1 `{1101, 1, 1, 10000}` emits `params[0..3] == [1001,2,2,10000]` and `params[6..9] == [1101,1,1,10000]`.
  - (f) Port stubs: a belt sourced at ILS port 0 emits 2 stub records before its first node, the first stub's position is within 0.01 of `prefabToGrid(port0.position)`, and the chain links stub→stub→node 0.
  - (g) Translation is an integer: a layout whose minimum x is −3.6 shifts every record by exactly +4.
  - (h) A sorter from a belt to an assembler side slot has its belt end at the slot's lateral coordinate (not the node's).
- [ ] **Step 2:** Implement `geometry/model.ts` and `blueprint/build.ts`. Run the tests until they pass.
- [ ] **Step 3:** `scripts/emit-test-blueprint.ts` (npm script `emit:test-bp`) builds the M0 hand-made layout from the fixture data and writes `local/test-blueprints/m0-smelter-row.txt`:
  - ILS at the origin.
  - ILS slot 0 = Iron Ore (local demand, remote demand, max 10000); slot 1 = Iron Ingot (local supply, remote supply, max 10000).
  - Port 3 outputs Iron Ore into a Mk.I belt running 10 tiles past 3 Arc Smelters (iron ingot recipe 1). Each smelter has a Mk.I input sorter span 1 from the belt and an output sorter span 1 (filter Iron Ingot) onto a second belt that returns to ILS port 4 (input).
  - Tesla towers covering everything.
  - Hand-place the coordinates using the approximate geometry rule "slot cell = first lattice point outside the footprint along the slot facing".
  - It is used in the final user test checklist (Task 30). The test for this script only checks that it runs and the output decodes.
- [ ] **Step 4:** Commit `feat(blueprint): layout model and layout-to-blueprint builder`.

---

## Milestone M1: Calculator and UI shell

### Task 10: Tech state and effects

**Files:**
- Create: `app/src/lib/data/tech.ts`
- Test: `app/src/lib/data/tech.test.ts`

**Interfaces:**
- Consumes: `GameData`, `GameDataIndex`.
- Produces:

```ts
export interface TechEffects {
  unlockedRecipes: Set<number>; availableBuildings: Set<number>;   // building item ids
  stationPilerLevel: number;      // base 1, func 29 additive (MX §2.1, GX §3)
  inserterStackInput: number;     // base 2, func 41 assign-max
  inserterStackOutput: number;    // base 1, func 39 assign-max
  labLevel: number;               // base 3, func 25 additive
  storageLevel: number;           // base 2, func 24 additive
  beltVerticalConstruction: boolean; // func 42
  beltMaxLevel: number;           // 12 + 6 * verticalConstructionLevels (count of techs 3701-3706 unlocked)
}
export function techClosure(data: GameData, techIds: Iterable<number>): Set<number>;   // adds all preTechs (not implicit) transitively
export function computeTechEffects(data: GameData, unlocked: Set<number>): TechEffects;
export function allTechs(data: GameData): Set<number>;   // every published, non-obsolete tech
```

- Rules:
  - A recipe is unlocked if some unlocked tech lists it, or **no** tech lists it (an initial recipe).
  - A building is available if some unlocked recipe outputs its item id.
  - Obsolete techs are ignored.
  - Leveled techs (`maxLevel > level`) count only as their base level.

- [ ] **Step 1:** Tests on the fixture:
  - `techClosure({1302})` contains 1311 and 1001.
  - With `techClosure({1302})`, recipe 51 is unlocked and recipe 52 (Quantum Chip) is not.
  - Recipe 1 (iron ingot) is unlocked with the empty set.
  - `computeTechEffects(allTechs)` has `stationPilerLevel == 4`, `inserterStackOutput == 4` and `beltMaxLevel == 48`. `beltVerticalConstruction` is `true` iff some unlocked tech has unlock function 42 (the 0.10.29 fixture has none, so assert `false` on the fixture and `true` on a synthetic tech list containing func 42).
  - With the empty set, the base values hold (1, 2, 1, 3, 2, false, 12).
  - Building 2305 (Mk.III assembler) is unavailable at the empty set and available with all techs.
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(data): tech closure and effects`.

### Task 11: Production calculator (LP)

**Files:**
- Create: `app/src/lib/calc/types.ts`, `app/src/lib/calc/proliferator.ts`, `app/src/lib/calc/lp.ts`, `app/src/lib/calc/plan.ts`, `app/src/lib/calc/power.ts`, `app/src/lib/calc/index.ts`
- Test: `app/src/lib/calc/plan.test.ts`, `app/src/lib/calc/proliferator.test.ts`, `app/src/lib/calc/power.test.ts`

**Interfaces:**
- Consumes: `GameDataIndex`, `TechEffects` (Task 10).
- Produces (`types.ts`):

```ts
export interface ItemRate { itemId: number; perSecond: number }
export interface ProliferatorSetting { tier: 0 | 1 | 2 | 3; mode: 'extra' | 'speed' }   // tier n -> item 1140+n
export interface PlanRequest {
  targetItemId: number;
  quantity: { kind: 'rate'; perSecond: number } | { kind: 'buildings'; count: number };
  finalFacilityItemId: number;
  unlockedTechs: Set<number>;
  suppliedItemIds: Set<number>;
  facilityOverrides: Record<number, number>;     // recipeId -> building itemId
  recipeOverrides: Record<number, number>;       // itemId -> recipeId (forces the recipe for that item)
  proliferator: ProliferatorSetting;
  stationKind: 'planetary' | 'interstellar';
  stationChargePerTick?: number;                  // default from constants
}
export interface Stage {
  recipeId: number; buildingItemId: number; machines: number; exactMachines: number;
  craftsPerSecond: number; utilization: number;   // exactMachines / machines
  inputs: ItemRate[]; outputs: ItemRate[];        // totals for the stage at the planned (exact) crafts/s
  perMachineCraftsPerSecond: number;              // at 100% utilization
  proliferated: boolean; effectiveSpeed: number;  // multiplier incl. speedup (1.0 = 10000)
  workPowerW: number; idlePowerW: number;         // per machine, incl. proliferator power multiplier
}
export interface Flow { itemId: number; from: number | 'import'; to: number | 'export'; perSecond: number } // stage indexes
export interface StationSlotDemand { itemId: number; role: 'import' | 'export' | 'proliferator' }
export interface PowerEstimate { productionWorkW: number; productionIdleW: number; sortersW: number; coatersW: number;
  stationChargeW: number; steadyW: number; peakW: number }
export interface ProductionPlan {
  request: PlanRequest; stages: Stage[]; flows: Flow[];
  imports: ItemRate[]; exports: ItemRate[];        // exports include the target first
  actualTargetRate: number; stationSlots: StationSlotDemand[]; stationsNeeded: number;
  proliferatorPerSecond: number; power: PowerEstimate; warnings: string[];
}
export type PlanResult = { ok: true; plan: ProductionPlan } | { ok: false; error: PlanError };
export type PlanError =
  | { kind: 'target-locked'; itemId: number; message: string }
  | { kind: 'no-recipe'; itemId: number; message: string }            // not supplied and no unlocked recipe
  | { kind: 'facility-unavailable'; recipeId: number; buildingItemId: number; message: string }
  | { kind: 'infeasible'; message: string };
export function planProduction(req: PlanRequest, data: GameDataIndex, effects: TechEffects): Promise<PlanResult>;
```

**Algorithm:**
1. **Candidate recipes.** Walk back from the target over unlocked recipes (honouring `recipeOverrides`). Stop at supplied items. Exclude types FRACTIONATE, EXCHANGE, PHOTON_STORE and NONE; exclude RESEARCH **except** recipes whose results are matrices (items 6001–6006), which are admitted and run in labs (in the dump, matrix recipes such as recipe 9 have `type: RESEARCH`).
   - **Prune infeasible alternates** to a fixed point: a recipe is dropped if any input is neither supplied nor producible by a remaining candidate (e.g. Graphene recipe 32 when Fire Ice is unsupplied; Hydrogen via recipe 74 when Critical Photon has no recipe).
   - Return `no-recipe` only when a required item (one the target cannot be made without, i.e. pruning removed every producer of an item on all paths to the target) is neither supplied nor producible; name the first such item found walking from the target (English name).
   - If the target itself has no unlocked recipe and isn't supplied, return `target-locked`.
2. **Facility per recipe.** Use the override, else `finalFacilityItemId` for the target's recipe, else the fastest available building with `production.recipeType == recipe.type`.
   - Labs: if a recipe's results are matrices (items 6001–6006), its facility candidates are buildings with `kind == 'lab'` (speed = `lab.assembleSpeed`), regardless of the recipe's `type`. `GameDataIndex.buildingsForRecipeType` doesn't return labs, so handle this case explicitly.
   - An overridden facility that is unavailable or wrong-typed gives `facility-unavailable`.
3. **Proliferator** (`proliferator.ts`):
   - `effectFor(tier, mode, recipe, data)` returns `{ outputMultiplier, speedMultiplier, powerMultiplier, proliferated }`.
   - Ability per tier: 1→1, 2→2, 3→4.
   - Extra mode applies only if `!recipe.nonProductive` and every input item is `productive`; otherwise it falls back to speed mode (a warning is added).
   - outputMultiplier = `1 + incTableMilli[ability]/1000`; speedMultiplier = `1 + accTableMilli[ability]/1000`; powerMultiplier = `1 + powerTableRatio[ability]/1000`.
   - Sprays per proliferator item = `sprays` (the item's `hpMax`: 12/24/60). The station imports unsprayed proliferator; self-spray loops (75 for Mk.III) are out of scope for v1.
   - Proliferator consumption = (Σ input items/s across all proliferated stages) / spraysPerItem. It is added as an import with a `'proliferator'` station slot.
4. **LP** (`lp.ts`, glpk.js; initialise once and cache). Variables: `x_r ≥ 0` crafts/s per candidate recipe; `imp_k ≥ 0` for supplied items; `exp_k ≥ 0` for every item.
   - Constraints per item k: `Σ_r out·mult·x_r − Σ_r in·x_r + imp_k − exp_k = (k == target ? R : 0)`.
   - Objective (lexicographic via weights): minimize `1e6 · Σ_r x_r · machineSecondsPerCraft_r + 1e3 · Σ_k imp_k + Σ_k exp_k`, where `machineSecondsPerCraft = timeTicks/60 / (speed/10000 · speedMultiplier)`.
   - With `quantity.kind == 'buildings'`: `R = count · perMachineCraftsPerSecond(final recipe) · outputCountOfTarget · outputMultiplier`.
   - Non-optimal or infeasible status gives `infeasible`.
5. **Stages:** one per recipe with `x_r > 1e-9`. `exactMachines = x_r · machineSecondsPerCraft`; `machines = ceil(exactMachines − 1e-9)`.
6. **Flows:** decompose by proportional allocation. For each item, distribute producers' output (stages, then import) to consumers (stages, then export) in stage order. Precision is 1e-9.
7. **Exports:** the target first, then by-products with positive `exp_k`. `actualTargetRate` = `machines`-limited capacity of the target's producing stage(s) (ceil effect), never below R.
8. **Station slots:** imports + exports + proliferator. `maxKinds` = station `maxItemKinds` for the chosen station kind's building (fixture: PLS 4, ILS 5); `stationsNeeded = ceil(slots / maxKinds)`. This is a **lower bound**: the netlist (Task 20) may raise the station count further when belt-port demand exceeds 12 per station; it reports its own count.
9. **Power** (`power.ts`):
   - `estimatePower(plan, data, effects)`: production work W = Σ machines·work·powerMult·utilization; idle W = Σ machines·idle·(1−utilization).
   - Sorters: estimate `2 × machines` Mk.III sorters at 50 % duty.
   - Coaters: one per import/intermediate belt when proliferated, at work power.
   - stationChargeW = `chargePerTick·60·stationsNeeded`. `steadyW` = production + sorters + coaters + 10 % of stationCharge; `peakW` = all work + full station charge.
   - Units: J/tick·60 = W.

**Tests** (`plan.test.ts`, fixture data, all techs unless noted; numbers from DS "Test targets"):
- [ ] **Step 1:** Write failing tests:
  - All tests that name a facility pass `facilityOverrides` for **every** recipe in the chain (otherwise "all techs" picks the fastest building). E.g. Processor: `{51: 2303, 50: 2303, 53: 2303, 1: 2302, 3: 2302, 59: 2302}`.
  - 1 Processor/s, Mk.I assemblers everywhere, Arc Smelters, supplied ores {1001,1002,1003}:
    - stages for recipes 51, 50, 53, 1, 3, 59;
    - Processor exactMachines = 4, Circuit Board 4/3 → machines 2, Microcrystalline 16/3 → 6, High-purity Si 8, Iron Ingot 2, Copper 3;
    - imports 2/3/8;
    - exports `[{1303,1}]`.
  - Facility override to Mk.III on recipe 51: 2 machines.
  - Buildings mode: `{kind:'buildings', count:4}` with Mk.I gives `actualTargetRate` 1.
  - Graphene with `recipeOverrides {1123: 32}`, `facilityOverrides {32: 2309}` and Fire Ice supplied: one stage (recipe 32), 1 chemical plant at 1/s, and exports include hydrogen 0.5/s (Review Focus #4).
  - Graphene with no override and fire ice **not** supplied picks recipe 31 (recipe 32 pruned, not an error) and imports crude oil, coal, stone and water when those are supplied.
  - Electromagnetic Matrix (6001) at 1/s with Magnetic Coil and Circuit Board supplied: one stage on a lab building (`kind == 'lab'`), 3 Matrix Labs (2901) with `facilityOverrides {9: 2901}`.
  - Locked: `unlockedTechs = techClosure({})` with target Processor gives `{ok:false, kind:'target-locked'}` (Review Focus #2).
  - Missing input: target Processor, supplied only {1001}: `no-recipe` for an ore whose name appears in the message.
  - Station overflow: Quantum Chip from raw ores with PLS (4 kinds) gives `stationsNeeded ≥ 3` (Review Focus #3).
  - Proliferator Mk.III extra on Processor (as in DS): 3.2 Mk.I assemblers exact, input rates 1.6/1.6, power 675 kW/machine; `proliferatorPerSecond > 0` and a slot with role `'proliferator'`. Proliferator consumption uses 60 sprays per Mk.III item.
- [ ] **Step 2:** Implement `proliferator.ts` with its unit tests (`proliferator.test.ts`: Mk.III sprays 60; Mk.I extra multiplier 1.125; nonProductive falls back to speed).
- [ ] **Step 3:** Implement `lp.ts` (a thin wrapper `solveLP(model): Promise<{status, values}>` over glpk.js). Implement `plan.ts`. Run the tests until they pass.
- [ ] **Step 4:** `power.test.ts`: for a plan with a single stage of 4 Mk.I assemblers at utilization 1 and no proliferator, productionWorkW = 4·270000 W and productionIdleW = 0; with utilization 0.5 (exactMachines 2 of 4), productionWorkW = 540000 and productionIdleW = 2·12000; ILS stationChargeW = 60e6 per station. Implement `power.ts`.
- [ ] **Step 5:** Commit `feat(calc): LP production planner with proliferator and power estimate`.

### Task 12: UI shell, configuration and plan view

**Files:**
- Create: `app/src/ui/state.svelte.ts` (runes store)
- Create: `app/src/ui/TargetPicker.svelte`, `app/src/ui/TechPicker.svelte`, `app/src/ui/InputsTree.svelte`, `app/src/ui/OptionsPanel.svelte`, `app/src/ui/PlanTable.svelte`, `app/src/ui/ItemIcon.svelte`, `app/src/ui/format.ts`
- Modify: `app/src/App.svelte`
- Test: `app/src/ui/format.test.ts`, `app/src/ui/state.test.ts`

**Interfaces:**
- Consumes: `loadDefaultGameData`, `GameDataIndex`, `techClosure`, `computeTechEffects`, `planProduction`.
- Produces:
  - `state.svelte.ts` exports `createAppState(data: GameData)`, returning a runes object: `{ request: PlanRequest (reactive), techProfileName, plan: PlanResult | null, setTarget(id), toggleSupplied(id), ... }`.
  - Tech profiles persist in `localStorage` under key `dsp-planner.techProfiles.v1` (`Record<name, number[]>`); every access is wrapped in try/catch.
  - Plan recompute: **no `$effect` in the `.svelte.ts` module** (it would throw `effect_orphan` outside a component). Every mutator (`setTarget`, `toggleSupplied`, `setQuantity`, …) calls a debounced (150 ms) `scheduleRecompute()`. The state also exposes `recompute(): Promise<PlanResult>` (immediate, used by tests) and `whenSettled(): Promise<void>` (resolves after any pending debounced recompute).
  - `format.ts`: `formatPower(w: number): string` ("675 kW", "60.0 MW", "1.20 GW"), `formatRate(perSecond, unit: 's'|'min')`, `itemName(index, id)`.

**UI layout:** two columns (left config 380px, right results); a single column below 900px.
1. **TargetPicker:** a search input filtering items that have a producing recipe; selecting one sets the target and the default final facility. A rate input with a `/s` or `/min` toggle, or a building-count input. The final-facility select lists available buildings for the target's recipe type.
2. **TechPicker:**
   - a search list of techs with checkboxes;
   - an "Unlock all" button;
   - "Unlock up to…" (a select of a tech, which applies `techClosure`);
   - profile select, save and delete.
3. **InputsTree:** the recipe tree from the target downwards, using the current plan's stages. Each item row has a supply/make toggle; leaves default to supplied.
4. **OptionsPanel:**
   - proliferator tier/mode;
   - station kind and charge (MW, slider within `[work/2, work·5]` per MX §6.3);
   - per-recipe facility overrides and alternate-recipe choice;
   - solver time budget in minutes (default 10; stored only for later tasks).
5. **PlanTable:**
   - stages with icon, name, facility, machines (exact), utilization;
   - imports and exports;
   - power estimate;
   - warnings;
   - PlanError rendered as an error panel naming the item or tech.

- Every displayed string about geometry shows a badge "Geometry: approximate (fixture data)" when `meta.source === 'fixture'`, or when any building's geometry is approximate.

- [ ] **Step 1:** Write `format.test.ts` (power formatting edge cases: 0 W, 999 kW → "999 kW", 1.5e6 → "1.50 MW") and `state.test.ts` (create state on the fixture; set target 1303 with rate 1; `await state.whenSettled()` then the plan is ok; toggling supplied 1101 then `await state.recompute()` removes the Iron Ingot stage; use `vi.useFakeTimers()` where the debounce matters). Run them and see them fail.
- [ ] **Step 2:** Implement `format.ts` and `state.svelte.ts` (tests run under Vitest with the Svelte compiler; name the file `*.svelte.ts` so runes compile). Run the tests until they pass.
- [ ] **Step 3:** Implement the components and the `App.svelte` layout. Use CSS variables for colours with light/dark via `prefers-color-scheme`. `ItemIcon` shows `/icons/<name>.png` if it loads, else a coloured monogram.
- [ ] **Step 4:** `npm run check && npm run build` must pass. Browser check: the **controller** runs it after the task (Playwright MCP: select Processor at 1/s and confirm the plan table shows the Processor stage; screenshot to `local/screenshots/m1-plan.png`). The implementer may skip it if no browser tool is available, and says so in the report.
- [ ] **Step 5:** Commit `feat(ui): configuration panels and production plan view`.

---

## Milestone M2: Geometry kernel and validator

### Task 14: Geometry kernel

**Files:**
- Create: `app/src/lib/geometry/transform.ts`, `app/src/lib/geometry/obb.ts`, `app/src/lib/geometry/footprint.ts`, `app/src/lib/geometry/endpoints.ts`, `app/src/lib/geometry/index.ts`
- Modify: `app/src/lib/blueprint/build.ts` (use `sorterEnds` from here; delete the local helper)
- Test: `transform.test.ts`, `obb.test.ts`, `footprint.test.ts`, `endpoints.test.ts`

**Interfaces:**
- Produces:

```ts
export const TILE: number; export const LEVEL: number;
export function rotateYaw(east: number, north: number, yaw: Yaw): [number, number]; // applies convention in "Shared conventions"
export function prefabToGrid(b: { x: number; y: number; z: number; yaw: Yaw }, p: Vec3): GridPoint;
export function prefabDirToGrid(yaw: Yaw, q: Quat): [number, number];   // unit facing (forward = +pz rotated) in grid x/y
export interface OBB2 { cx: number; cy: number; hx: number; hy: number; angle: number; zMin: number; zMax: number } // grid units
export function buildingOBBs(b: PlacedBuilding, bd: Building): OBB2[];   // from colliders with usage 'build' (fallback all)
export function obbOverlap(a: OBB2, b: OBB2, eps?: number): boolean;     // SAT in 2D + z interval overlap; eps shrink (default 0.02 tiles)
export function pointInOBBs(x: number, y: number, z: number, obbs: OBB2[], inflate: number): boolean;
export interface SlotInfo { index: number; pos: GridPoint; dir: [number, number]; firstOutside: { x: number; y: number } }
export function slotInfos(b: PlacedBuilding, bd: Building): SlotInfo[];  // firstOutside: on the line through the slot along dir, at lateral = round(slot lateral), the first lattice point beyond the slot (normal coordinate > slot's) that is not inside the building's footprint (inflate 0)
export function portInfos(b: PlacedBuilding, bd: Building): SlotInfo[];  // same for belt ports
export function sorterTapPoint(slot: SlotInfo, span: 1|2|3): { x: number; y: number }; // firstOutside + (span-1)*dir, rounded to lattice
export function endpointWorld(e: Endpoint, layout: Layout, data: GameDataIndex): GridPoint; // building: slot position; belt: the node point
export function sorterEnds(s: Sorter, layout: Layout, data: GameDataIndex): { pick: GridPoint; drop: GridPoint };
// building end = slot position; belt end = projection of the opposite building slot's position onto the belt's axis line through the
// tap node (axis = direction between the tap node's neighbours), i.e. the belt point at the slot's lateral coordinate, z = node z.
// building↔building: both slot positions. belt↔belt (not used in v1): both node points.
export const BELT_HALF_WIDTH_TILES: number; // 0.32 m / TILE
```

- [ ] **Step 1:** Tests:
  - `rotateYaw(0,1,90)` equals `[1,0]` (north rotates to east, clockwise).
  - `prefabToGrid` for a building at (10,20,0) yaw 90 maps p = (0,0,TILE) to (11,20,0).
  - SAT: two 1×1 squares 1.5 apart don't overlap; 0.9 apart overlap; 45° rotated squares touching at corners behave correctly; disjoint z intervals never overlap.
  - Fixture assemblers: centres 4 tiles apart (same yaw) do **not** overlap; 3 tiles apart **do** overlap (half-extent 2 m: 3 tiles = 3.77 m < 4 m).
  - `slotInfos` on a fixture assembler at (0,0) yaw 0 gives 12 slots; slot 3 (east face, north end) has `pos ≈ (0.883, 0.796, 0)` and `firstOutside = (2, 1)`. Span-2 tap at (3, 1).
  - The same at yaw 90: slot 3 is rotated onto the south face (`pos ≈ (0.796, −0.883, 0)` per the convention), `firstOutside = (1, −2)`.
  - `endpointWorld` for a belt endpoint returns the node.
  - `sorterEnds` for a sorter from a N–S belt through (2,0),(2,1),(2,2) (tap node index 1) to assembler slot 3: belt end `(2, 0.796, 0)`, building end `(0.883, 0.796, 0)`.
- [ ] **Step 2:** Implement. Run the tests until they pass. Update `build.ts` to use `sorterEnds`. Re-run the blueprint tests.
- [ ] **Step 3:** Commit `feat(geometry): transforms, OBB collision, slot and port geometry`.

### Task 15: Geometry and connection checks (validator part 1)

**Files:**
- Create: `app/src/lib/validate/types.ts`, `app/src/lib/validate/geometry-checks.ts`
- Test: `app/src/lib/validate/geometry-checks.test.ts`, `app/src/lib/validate/testkit.ts` (layout builders for tests)

**Interfaces:**
- Consumes: geometry kernel (Task 14), `Layout`, `GameDataIndex`, `TechEffects`.
- Produces:

```ts
export type ViolationCode =
  | 'BUILDING_OVERLAP' | 'BELT_IN_BUILDING' | 'BELT_OVERLAP' | 'BELT_DISCONNECTED' | 'BELT_BAD_RAMP' | 'BELT_TOO_HIGH'
  | 'BELT_PORT_MISMATCH' | 'SORTER_SPAN' | 'SORTER_SLOT_INVALID' | 'SORTER_SLOT_REUSED' | 'SORTER_SKEW' | 'SORTER_IN_BUILDING'
  | 'SORTER_ENDPOINT_BELT_RAMP' | 'SORTER_BELT_TANGENT' | 'SORTER_TO_STATION' | 'POWER_UNCOVERED' | 'POWER_DISCONNECTED' | 'STATION_SLOTS'
  | 'COATER_PLACEMENT' | 'COATER_UNFED'
  | 'RATE_BELT' | 'RATE_SORTER' | 'RATE_MACHINE_INPUT' | 'SIM_OUTPUT_LOW' | 'SIM_DEADLOCK' | 'SIM_STALLED';
export interface Violation { code: ViolationCode; entities: { kind: 'building'|'belt'|'sorter'; id: number; node?: number }[];
  message: string; mirrors?: string }          // game method the rule mirrors, e.g. "BuildTool_Path.CheckBuildConditions"
export function checkGeometry(layout: Layout, data: GameDataIndex, effects: TechEffects): Violation[];
```

**Rules** (each gets its own pass and fail test in `geometry-checks.test.ts`, built with `testkit.ts` helpers such as `kit.station(x,y)`, `kit.assembler(x,y,yaw,recipe)`, `kit.belt(tier, item, points)`, `kit.sorter(...)`, `kit.tesla(x,y)`):
1. `BUILDING_OVERLAP`: pairwise `obbOverlap` of building OBBs. Buildings stacked via `multiLevel` with z offset = `lapJoint` are exempt.
2. `BELT_IN_BUILDING`: a belt node point inside any building OBB, inflated by `BELT_HALF_WIDTH_TILES`, with node z within the building's z range.
3. `BELT_OVERLAP`: two belt nodes (any belts, or non-consecutive in the same belt) at the same (x,y,z). A `sink: belt` merge target node is exempt for the merging belt's last node.
4. `BELT_DISCONNECTED`: consecutive nodes must be either a **flat step** (4-adjacent in x/y, dz = 0) or a **vertical lift** (same x/y, |dz| = 1). Anything else (diagonal, a horizontal step combined with a z change, a jump) is disconnected. Diagonal "1 tile + 1 level" ramps are **unverified in-game** and not generated in v1.
5. `BELT_BAD_RAMP`: a lift run (one or more consecutive vertical lifts in the same z direction at one x/y) must be preceded by ≥ 2 flat steps and followed by ≥ 2 flat steps, all in the same horizontal direction (no turn within 2 steps either side of the lift; capsule-sample pattern, MX §2.4).
6. `BELT_TOO_HIGH`: z > `effects.beltMaxLevel`.
7. `BELT_PORT_MISMATCH`: `source`/`sink` ports must exist, and the first/last node must equal the port's `firstOutside` lattice point at z 0.
8. `SORTER_SPAN`: building↔belt: the belt tap node must equal `sorterTapPoint(slot, span)` (x/y) for the building slot. Building↔building: the two slots face each other (opposite facings) and the distance between their `firstOutside` points along the facing is `span − 1` (span 1 = adjacent lattice). In all cases the 3D distance between `sorterEnds` pick and drop must be ≤ `sorterMaxReachMeters` and ≥ 1 m.
9. `SORTER_SLOT_INVALID` (slot index out of range) and `SORTER_SLOT_REUSED` (two sorters on the same building slot).
10. `SORTER_SKEW`: the sorter direction computed from `sorterEnds` (pick→drop) must align with the building slot facing (or its reverse) within 14° (building↔building) or 11° (belt involved).
11. `SORTER_IN_BUILDING`: lattice points strictly between the endpoints that lie inside a building OBB that isn't one of the endpoints' own buildings.
12. `SORTER_ENDPOINT_BELT_RAMP`: a sorter's belt endpoint node must have z = 0 and no z change on adjacent nodes.
12a. `SORTER_BELT_TANGENT`: a sorter's belt tap node must be mid-straight: it has a previous and a next node, all three collinear, and the belt axis is perpendicular to the sorter's slot facing (within 11°). Belt corners are diagonal in-game and break the facing rule (plan review, capsule sample).
13. `SORTER_TO_STATION`: a sorter endpoint on a station building (MX §3.3).
14. `POWER_UNCOVERED`: every power consumer must be within `coverRadius` m (2D, metres) of some node's `powerPoint`: consumer **buildings** (power.consumer and not a node) measured at their centre, and every **sorter** measured at the midpoint of its `sorterEnds` (sorters are consumers). Coaters (Task 28) are added here too.
15. `POWER_DISCONNECTED`: nodes form one connected graph, with an edge when the distance is ≤ `min(connectDistance_a, connectDistance_b)` (MX §6.1, C3; noted in the rule's message).
16. `STATION_SLOTS`: slot configs exceed `maxItemKinds`, or a port references a storageIdx > slots.length.

- [ ] **Step 1:** Write `testkit.ts`. Write the failing tests: one valid composite layout (station + belt + 2 assemblers + sorters + tesla) gives `[]`; plus a pass and a fail case per rule.
- [ ] **Step 2:** Implement `geometry-checks.ts` with a spatial hash for the pairwise checks. Run the tests until they pass.
- [ ] **Step 3:** Commit `feat(validate): geometry and connection rules`.

### Task 16: Rate-capacity check (validator part 2)

**Files:**
- Create: `app/src/lib/validate/capacity.ts`
- Test: `app/src/lib/validate/capacity.test.ts`

**Interfaces:**
- Produces:
  - `beltCapacity(tierItemId, stack, data): number`. Items/s = `belt.speed·60/cargoLength·stack` (MX §2.1).
  - `sorterRate(tierItemId, span, stackFromBelt, effects, data): number`. Items/s = `ticksPerSecond / (2·max(10000, stt·span)/10000) · itemsPerTrip`. For a non-pile sorter `itemsPerTrip = stackFromBelt` when picking from a belt, and 1 when picking from a building. Pile sorter: `itemsPerTrip = min(effects.inserterStackInput, 4)` when picking from a belt, and `stt` is **not** multiplied by span (BF/CYING; flagged C3).
  - `checkCapacity(layout, plan: ProductionPlan, data, effects): Violation[]` emits RATE_BELT, RATE_SORTER and RATE_MACHINE_INPUT:
    - **belt:** `plannedRate > capacity` (stack = `effects.stationPilerLevel` for belts sourced at a station port, else 1).
    - **sorter:** `plannedRate > sorterRate`.
    - **machine input:** for each production building and each recipe input, Σ plannedRate of sorters dropping into it with that filter (or unfiltered sorters fed from a belt carrying that item) < required per-machine input rate × 0.999, where the required rate is the **planned** rate (stage input totals ÷ machines, i.e. utilization-weighted), not full speed.
- Fast: precomputed indexes; O(entities).

- [ ] **Step 1:** Failing tests:
  - Mk.I belt stack 1 gives 6/s; Mk.III with pilerLevel 4 gives 120/s.
  - Mk.I sorter span 1 gives 1.5/s, span 3 gives 0.5/s.
  - A Mk.III sorter on a 4-stack belt gives 24/s.
  - A layout with an assembler fed by one Mk.I sorter for a 2/s ingredient gives RATE_MACHINE_INPUT.
  - The same with two Mk.III sorters gives `[]`.
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(validate): rate-capacity check`.

### Task 17: Tick simulator: world, belts and station ports

**Files:**
- Create: `app/src/lib/validate/sim/world.ts`, `app/src/lib/validate/sim/belt.ts`, `app/src/lib/validate/sim/station.ts`, `app/src/lib/validate/sim/cargo.ts`
- Test: `app/src/lib/validate/sim/belt.test.ts`, `app/src/lib/validate/sim/station.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Cargo { item: number; stack: number; inc: number }
export class BeltSim {            // mirrors: CargoPath.Update (MX §2.2)
  constructor(lengthCells: number, speedCellsPerTick: number);
  readonly length: number;
  tryInsertAtHead(c: Cargo): boolean;                         // mirrors: CargoPath.TryInsertItemAtHeadAndFillBlank
  tryInsert(cellIndex: number, c: Cargo): boolean;            // mirrors: CargoPath.TryInsertItem (±5 window, squeeze limited)
  tryPick(cellIndex: number, filter: number, accept?: (item: number) => boolean): Cargo | null; // mirrors: CargoPath.TryPickItem (5-cell window)
  tryPickRear(filter: number, accept?: (item:number)=>boolean): Cargo | null;  // rear = end of path
  setOutput(target: BeltSim, cellIndex: number): void;        // merge into another path at an index
  update(): void;                                             // one tick
  cargoCount(): number;
}
export class StationSim {           // mirrors: StationComponent.UpdateOutputSlots / UpdateInputSlots (MX §7)
  constructor(cfg: StationConfig, pilerLevel: number);
  attachOutput(port: number, belt: BeltSim): void;   // unlimited source of the port's storage item
  attachInput(port: number, belt: BeltSim): void;    // unlimited sink; counts received items per item id
  tick(tickIndex: number): void;                      // each port acts at most every 2 ticks
  received(itemId: number): number;
}
export class World {
  constructor(layout: Layout, plan: ProductionPlan, data: GameDataIndex, effects: TechEffects, opts?: { powerSupplyW?: number });
  readonly powerRatio: number;                        // 1 unless powerSupplyW caps it
  tick(): void;                                       // fixed order per MX §10.7
  readonly ticks: number;
}
```

- Belt cell mapping: `lengthCells = nodes.length · constants.beltCellsPerTile` (+ `2·cellsPerTile/2` extra cells for each port stub end, approximating the blueprint's stub records). Node `i` maps to cell `stubCells + i·cellsPerTile + cellsPerTile/2`. Speed = `belt.speed` of the tier. **Cell index 0 is the head (where items enter); the rear is the last cell.**
- **Power supply:** the block's network is assumed to be externally supplied. The `World` power ratio is `1` by default; an optional `opts.powerSupplyW` cap sets `ratio = min(1, supply / lastTickDemand)` (mirrors: PowerSystem.GameTick consumer ratio, MX §6.2).
- `World` builds BeltSims for all belts, wires `sink: belt` merges via `setOutput`, and builds StationSims. Later tasks register sorters and machines. Expose a registration API: `world.addEntity({ tick(): void })` with an explicit phase (`'power'|'machines'|'stationIn'|'sorters'|'belts'|'stationOut'`).

- [ ] **Step 1:** `belt.test.ts`:
  - A cargo inserted at the head of a Mk.I belt of 100 cells reaches the rear after ceil(90/1) ticks and stops; it never moves past the end.
  - A full-density belt holds `length/10` cargo.
  - Throughput: inserting at the head every tick when possible and picking at the rear every tick gives 6 cargo/s on Mk.I (±2 %) and 30/s on Mk.III.
  - A merge: belt A ends into belt B mid-path; items transfer only when a 10-cell gap is free.
  - `tryPick` with a filter only takes matching items.
- [ ] **Step 2:** Implement `cargo.ts` and `belt.ts`. Run the tests until they pass.
- [ ] **Step 3:** `station.test.ts`:
  - The output port on a Mk.III belt with pilerLevel 4, run for 600 ticks, delivers 4-stacks at ≤ 30 cargo/s (120 items/s).
  - The input port consumes the rear cargo and counts it.
  - A port with dir 0 does nothing.
- [ ] **Step 4:** Implement `station.ts` and `world.ts`. Run the tests until they pass. Commit `feat(validate): tick simulator belts and station ports`.

### Task 18: Tick simulator: sorters

**Files:**
- Create: `app/src/lib/validate/sim/sorter.ts`
- Test: `app/src/lib/validate/sim/sorter.test.ts`

**Interfaces:**
- Consumes: BeltSim and World (Task 17), plus a machine interface consumed abstractly:

```ts
export interface InsertTarget { needs(item: number): boolean; careNeeds: boolean; insert(item: number, count: number, inc: number): boolean }
export interface PickSource { pickProduct(filter: number, accept: (item: number) => boolean): { item: number; count: number; inc: number } | null }
```

- Produces:
  - `class SorterSim` (mirrors `InserterComponent.InternalUpdate`; MX §3.2 state machine: Picking/Sending/Inserting/Returning; `stt = max(10000, prefab.stt·span)`, except the pile sorter, whose stt is not multiplied by span; idleTick back-off 9/10).
  - Constructed with `{ pick: BeltRef | PickSource, drop: BeltRef | InsertTarget, filter, grade, stt, delay, stackInput, stackOutput }`, where `BeltRef = { belt: BeltSim; cell: number }`.
  - `tick(power: number)` and `workingThisTick(): boolean` (for power accounting).

- [ ] **Step 1:** Failing tests, using a fake InsertTarget that always needs and a belt full of cargo:
  - A Mk.I span 1 moves 1.5 items/s over 600 ticks (±3 %).
  - Mk.II 3/s; Mk.III 6/s; Mk.I span 3 0.5/s.
  - From a 4-stack belt, a Mk.III moves 24 items/s.
  - A target whose `needs()` is false makes the sorter wait and moves nothing.
  - A pile sorter with stackInput 4 picking from 1-stack cargo accumulates up to 4 before leaving, or leaves after the delay.
  - A sorter from a PickSource onto a belt inserts one cargo per trip and waits when the belt has no gap.
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(validate): sorter simulation`.

### Task 19: Tick simulator: machines, coaters, power and the validation report

**Files:**
- Create: `app/src/lib/validate/sim/machine.ts`, `app/src/lib/validate/sim/coater.ts`, `app/src/lib/validate/sim/run.ts`, `app/src/lib/validate/report.ts`, `app/src/lib/validate/index.ts`
- Test: `app/src/lib/validate/sim/machine.test.ts`, `coater.test.ts`, `run.test.ts`, `app/src/lib/validate/report.test.ts`

**Interfaces:**
- Produces:
  - `class MachineSim implements InsertTarget, PickSource` (mirrors `AssemblerComponent.InternalUpdate` / `UpdateNeeds`; labs in production mode mirror `LabComponent.InternalUpdateAssemble`). Behaviour per MX §4.3:
    - needs threshold `N = max(2, floor(speed·180/timeSpend)+1)` (labs use the MX §4.4 thresholds);
    - output caps (SMELT 100 items, ASSEMBLE 10 crafts, others 20 crafts);
    - proliferator extra/speed via `inc` levels and `split_inc_level` (minimum level across consumed ingredients);
    - deterministic extra products through `extraTime`;
    - `powerDemand()` = work·(1000+powerTable[L])/1000 while replicating, else idle;
    - counters `crafts`, `stalledTicks`, `starvedTicks`.
  - `class CoaterSim` (mirrors `SpraycoaterComponent.InternalUpdate`, MX §4.6): attached to an item belt cell and a proliferator belt.
  - `runSimulation(layout, plan, data, effects, opts?: { warmupTicks?: number; measureTicks?: number; powerSupplyW?: number }): SimResult`. Defaults: 7200 and 18000 ticks; power externally supplied (ratio 1) unless `powerSupplyW` is given.

```ts
export interface SimResult {
  measuredTargetRate: number; measuredExports: ItemRate[];
  machineStats: { buildingId: number; crafts: number; busyFraction: number; outputBlockedFraction: number; starvedFraction: number }[];
  stageStats: { stageIndex: number; crafts: number; plannedCrafts: number }[];   // over the measurement window
  deadlocked: boolean;          // no belt movement, no sorter state change and no machine progress for 600 consecutive ticks during measurement while plan expects output
  power: { steadyW: number; peakW: number; idleW: number };   // measured average; peak = max tick demand + station charge
}
```

  - `validateLayout(layout, plan, data, effects, opts?: { simulate?: boolean; warmupTicks?: number; measureTicks?: number }): ValidationReport`:

```ts
export interface ValidationReport { pass: boolean; violations: Violation[]; sim?: SimResult; checkedAt: string;
  stage: 'geometry' | 'capacity' | 'simulation' }   // stage reached; stops at first failing stage
```

  - Rules:
    - Run checkGeometry, then (if clean) checkCapacity, then (if `simulate`, default true) runSimulation.
    - SIM_OUTPUT_LOW if measured target < 0.99·plan rate.
    - SIM_DEADLOCK if deadlocked.
    - SIM_STALLED for any **stage** whose measured crafts < 0.9 × planned crafts (`stage.craftsPerSecond × measureSeconds`); the violation lists that stage's machines with their `busyFraction`/`outputBlockedFraction`. This catches undrained byproducts (Review Focus #4) without flagging machines that are legitimately idle part of the time because they were rounded up (a dead-end net keeps a low-utilization machine blocked most of the time, which is correct).
  - Power accounting: sorters work while Sending/Returning; machines per demand; coaters work while spraying; station charge = `chargePerTick` constant at peak (blocks start with empty stations), and `steadyW` excludes station charge (reported separately).

- [ ] **Step 1:** `machine.test.ts`:
  - An iron ingot smelter (60 ticks, 1×) with an unlimited ore feeder makes 1 ingot/s.
  - An assembler with `N`: 1 s recipe at 1× gives `needs` false after 4 crafts' worth is served.
  - Output blocking at 10 crafts for ASSEMBLE.
  - Mk.III proliferator extra (+25 %) over 400 crafts yields 500 products ±1.
  - Speed mode at Mk.III doubles the rate.
  - Power demand while blocked equals idle.
- [ ] **Step 2:** Implement `machine.ts`. Run the tests until they pass.
- [ ] **Step 3:** `coater.test.ts`: the coater sprays every passing cargo (inc set to stack·ability), consumes sprays per stack, and passes items unsprayed when out of proliferator. Implement, then make it pass.
- [ ] **Step 4:** `run.test.ts`, built with `testkit.ts`:
  - (a) A hand-built valid smelter-row layout (ILS → ore belt → 3 smelters → ingot belt → ILS) with plan 3 ingots/s: `measuredTargetRate ≥ 2.97`, not deadlocked.
  - (b) The same layout with the output belt's sink removed (dead end): SIM_STALLED or SIM_OUTPUT_LOW.
  - (c) A refinery layout whose hydrogen has no output belt: SIM_STALLED on the refinery (Review Focus #4).
  - (d) Determinism: two runs give identical results.
- [ ] **Step 5:** Implement `run.ts`, `report.ts` and `index.ts` (export `validateLayout`, `checkGeometry`, `checkCapacity`, `runSimulation`). Run the tests until they pass. Measure the runtime of (a); log it in the test output and keep it < 3 s.
- [ ] **Step 6:** Commit `feat(validate): machine and coater simulation, validation report`.

---

## Milestone M3: Solver v1 (valid, loose layouts end to end)

### Task 20: Netlist

**Files:**
- Create: `app/src/lib/layout/netlist.ts`
- Test: `app/src/lib/layout/netlist.test.ts`

**Interfaces:**
- Consumes: `ProductionPlan`, `GameDataIndex`, `TechEffects`, capacity helpers (`beltCapacity`, `sorterRate` from Task 16). **Import them from `app/src/lib/validate/capacity.ts`.** The solver may depend on the validator; the reverse is forbidden.
- Produces:

```ts
export interface MachineInst { id: number; stageIndex: number; recipeId: number; buildingItemId: number }
export interface MachineInstIO { inputs: ItemRate[]; outputs: ItemRate[] }  // per machine, at plan utilization (stage totals / machines)
export interface NetTap { machineId: number; itemId: number; dir: 'in' | 'out'; rate: number; sorters: number } // sorters needed at span 1 (recomputed by assignTaps once spans are chosen)
export interface BeltNet {
  id: number; itemId: number; tierItemId: 2001|2002|2003; rate: number;
  source: { kind: 'station'; stationIdx: number } | { kind: 'taps' };      // import belts start at a station port; intermediate belts start at first producer tap
  sink: { kind: 'station'; stationIdx: number } | { kind: 'deadEnd' };      // exports/byproducts end at a station port; feed belts dead-end
  taps: NetTap[];
}
export interface Netlist {
  machines: (MachineInst & MachineInstIO)[]; nets: BeltNet[];
  stations: { kind: 'planetary' | 'interstellar'; buildingItemId: number; slots: StationSlotConfig[]; portsNeeded: number }[];
  sorterTierItemId: 2011|2012|2013|2014; beltTierItemId: 2001|2002|2003;
  warnings: string[];
}
export function buildNetlist(plan: ProductionPlan, data: GameDataIndex, effects: TechEffects, opts?: { maxMachinesPerNet?: number }): Netlist;
```

**Rules:**
- Use the best available belt and sorter tiers.
- One `MachineInst` per machine; each carries rates = stage totals / machines.
- For each item flow:
  - imports → nets with a station source;
  - the target and exports → nets with a station sink;
  - intermediates → nets with source `taps` and sink `deadEnd`, **unless** the item is also exported, in which case the sink is the station.
- Net capacity = `0.95 · beltCapacity(tier, stack)`, with `stack = effects.stationPilerLevel` for station-sourced nets and 1 otherwise.
- Split a net into several when its rate > capacity, or when its tap count > `maxMachinesPerNet` (default 12). **Split by rate, not by id**: partition the consumers (id order) into groups whose demand ≤ capacity and tap count ≤ the max; then allocate producer capacity to the groups greedily (id order) so that each group's supply ≥ its demand. A producer whose output is split between two groups gets one tap in each group, with the rate divided. Every sub-net must satisfy Σ producer tap rates ≥ Σ consumer tap rates (assert it).
- Sorters per tap = `ceil(rate / sorterRate(tier, span=1, stack, …))`. If that is > 3, raise the belt tier or add a netlist warning.
- Stations:
  - Assign item slots in order (target first, then imports by rate, then proliferator, then byproducts).
  - Start a new station when `maxItemKinds` is exceeded.
  - Each net with a station source/sink uses one port. Also start a new station when the current one's port demand would exceed 12. So `stations.length = max(plan.stationsNeeded, slot- and port-driven count)`; record a warning when the netlist needs more stations than the plan predicted.
  - Slot logic: imports and proliferator → `localLogic 2` (demand), `remoteLogic 2` on an ILS (0 on a PLS); exports (target and byproducts) → `localLogic 1` (supply), `remoteLogic 1` on an ILS (0 on a PLS); `max = station.maxItemCount`.

- [ ] **Step 1:** Failing tests:
  - The Processor plan (Mk.I) has 4+2+6 assemblers and 2+3+8 smelters = 25 machines.
  - Import nets for ores have a station source.
  - The circuit-board net has producer taps from 2 machines and consumer taps on 4 Processor machines, sink deadEnd.
  - The Processor export net has a station sink.
  - An iron ore net with 2/s on Mk.I (6/s) is one net.
  - An **intermediate** (taps-sourced, stack 1) 20/s net on Mk.I splits into 4, and each sub-net's producer supply ≥ its consumer demand.
  - A **station-sourced** 20/s import on Mk.I with `stationPilerLevel 4` (capacity 0.95·24) is one net.
  - Quantum Chip with PLS: `stations.length ≥ plan.stationsNeeded`, every station has ≤ 4 slots and ≤ 12 ports.
  - Slot logic: on an ILS, import slots are `{localLogic 2, remoteLogic 2}` and the export slot is `{1, 1}`; `max == 10000`.
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(layout): netlist from production plan`.

### Task 21: Occupancy grid and placement (simulated annealing)

**Files:**
- Create: `app/src/lib/layout/occupancy.ts`, `app/src/lib/layout/placement.ts`, `app/src/lib/layout/rng.ts`
- Test: `occupancy.test.ts`, `placement.test.ts`

**Interfaces:**
- Consumes: geometry kernel, Netlist.
- Produces:
  - `rng.ts`: `class Rng { constructor(seed: number); next(): number /*[0,1)*/; int(n): number }` (mulberry32).
  - `occupancy.ts`:

```ts
export class Occupancy {                     // lattice-point occupancy for belts/sorters vs buildings, plus building OBB index
  constructor(data: GameDataIndex);
  addBuilding(b: PlacedBuilding): void; removeBuilding(id: number): void;
  buildingCollides(b: PlacedBuilding): boolean;              // exact OBB vs indexed buildings (spatial hash)
  blockedForBelt(x: number, y: number, z: number): boolean;  // pointInOBBs with BELT_HALF_WIDTH inflate
  bounds(): { minX: number; minY: number; maxX: number; maxY: number };
}
```

  - `placement.ts`:

```ts
export interface PlacementParams { margin: number; seed: number; iterations: number; startTemp: number; weights: { area: number; wire: number } }
export interface Placement { buildings: PlacedBuilding[]; cost: number }   // stations + machines (no belts/sorters/poles yet)
export function constructivePlacement(net: Netlist, data: GameDataIndex, margin: number): Placement;   // deterministic rows: station(s) at origin, machines grouped by stage in rows along +x, rows separated by (2*margin + 3) tiles of channel
export function annealPlacement(net: Netlist, data: GameDataIndex, init: Placement, p: PlacementParams, shouldStop: () => boolean): Placement;
```

- Margin semantics: every machine's OBB is inflated by `margin` tiles for building-building collision during placement (`margin ≥ 1` keeps lattice channels free for sorters and belts).
- Annealing:
  - Moves: translate one machine by ±1..4 tiles; swap two machines of different stages; rotate by 90°; translate a whole stage group.
  - Reject on collision.
  - Cost = `weights.area · bboxArea + weights.wire · Σ_nets HPWL(tap machine centres + station port points)`.
  - Geometric cooling; deterministic for a given seed.

- [ ] **Step 1:** `occupancy.test.ts`:
  - An assembler blocks belts at its centre and at ±1, but not at ±2.
  - A station (approximate ±4 m) blocks ±3 and not ±4.
  - Two assemblers 4 apart do not collide; 3 apart do.
- [ ] **Step 2:** `placement.test.ts`:
  - `constructivePlacement` for the Processor netlist has no collisions with margin 2.
  - `annealPlacement` (seed 1, 20k iterations) never increases the cost above the initial, has no collisions, and is deterministic for a seed.
  - `shouldStop` returning true stops immediately with the current best.
- [ ] **Step 3:** Implement. Run the tests until they pass. Commit `feat(layout): occupancy index and annealing placement`.

### Task 22: Tap assignment and 3D belt routing

**Files:**
- Create: `app/src/lib/layout/taps.ts`, `app/src/lib/layout/router.ts`, `app/src/lib/layout/heap.ts`
- Test: `taps.test.ts`, `router.test.ts`

**Interfaces:**
- Produces:
  - `taps.ts`: `assignTaps(net: Netlist, placement: Placement, occ: Occupancy, data): TapAssignment | { failed: string }`.

```ts
export interface AssignedTap { netId: number; machineId: number; slot: number; span: 1|2|3; point: { x: number; y: number }; axis: 'x' | 'y'; dir: 'in'|'out'; sorterIndex: number; rate: number }
// ONE AssignedTap per sorter: a NetTap needing k sorters yields k AssignedTaps on k distinct slots, each with its own belt point;
// `axis` = the belt direction required through `point` (perpendicular to the slot facing); `rate` = this sorter's share.
export interface TapAssignment { taps: AssignedTap[]; stationPorts: { netId: number; stationBuildingId: number; port: number; point: { x: number; y: number } }[] }
```

  - Tap rules:
    - Each machine slot is used at most once.
    - The tap point (`sorterTapPoint`) must not be blocked for belts, and must not equal another net's tap point.
    - Prefer span 1, then 2, then 3. Prefer slots facing the centroid of the net's other taps.
    - After a span is chosen, recompute that NetTap's sorter count with `sorterRate(tier, span, …)` (span 2/3 sorters are slower) and allocate more slots if needed; fail if the machine runs out of slots.
    - Station ports are assigned to nets by nearest facing toward the net's tap centroid; the port's lattice point is its `portInfos(...).firstOutside`.
  - `router.ts`:

```ts
export interface RouteParams { maxIterations: number; presentFactorStart: number; presentFactorGrowth: number; historyFactor: number;
  allowElevation: boolean; maxLevel: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } } // search window = placement bounds + 6
export interface RoutedNet { netId: number; nodes: GridPoint[] }
export function routeNets(net: Netlist, taps: TapAssignment, occ: Occupancy, p: RouteParams, shouldStop: () => boolean): { ok: true; routes: RoutedNet[] } | { ok: false; conflicts: number; routes: RoutedNet[] };
```

  - Waypoints per net: [station port point, if source] → producer tap points (nearest-neighbour order) → consumer tap points (nearest-neighbour) → [station port point, if sink]. Each leg is routed with A*, and the **A* direction state is carried from one leg to the next** (no U-turns at a waypoint).
  - **Taps are mid-straight:** the path must pass through each tap point at z = 0 moving along the tap's `axis`, with the previous and next nodes collinear (so a tap is never a belt corner and never the first or last node). A taps-sourced belt therefore starts one node *before* its first tap along the axis, and a dead-end belt ends one node *after* its last tap. Port points are visited at z = 0, and the port's first/last node must step straight out from/into the port along the port's facing.
  - A* state = `(x, y, z, dir, straight)`, with `straight ∈ {0,1,2}` = flat same-direction steps taken since the last turn or lift (capped at 2).
  - Moves (the only level change is the in-game-verified **vertical lift**, capsule sample):
    - forward flat (`straight = min(2, straight+1)`);
    - turn left/right at z = 0 always; at z > 0 only if `straight == 2`;
    - lift: same x/y, z ± 1 (only if `allowElevation`, `straight == 2`, and resulting z ∈ [0, maxLevel]); after a lift `straight = 0`, the next two moves must be forward flat in the same direction, and consecutive lifts in the same z direction are allowed (multi-level lift).
  - A z = 1 belt may pass over a z = 0 belt at the same x/y (capsule sample); occupancy is per (x, y, z).
  - Cell cost = 1 + elevation penalty 0.5·z + present-congestion·presentFactor + history.
  - Blocked: `occ.blockedForBelt`, and cells that are another net's tap points.
  - Negotiated congestion: iterate rip-up/reroute of all nets; overused (x,y,z) cells raise history; stop at zero overuse or `maxIterations`.
  - A net never reuses its own cell (no self-crossing).

- [ ] **Step 1:** `router.test.ts`:
  - Route one net in an empty 20×20 area between two points: a shortest-length path with 4-adjacent nodes.
  - Two nets that must cross on the ground: with `allowElevation` they succeed with one net lifted to z = 1 by vertical lifts (assert by running `checkGeometry` BELT_* rules on a synthetic layout: no BELT_DISCONNECTED/BELT_BAD_RAMP); without elevation they fail (`ok: false`).
  - A tap waypoint with axis `y` is passed straight along y (previous and next node share its x), and the following leg never reverses direction.
  - An obstacle building is avoided.
  - Waypoints are visited in order at z = 0.
- [ ] **Step 2:** `taps.test.ts`:
  - On the constructive Processor placement (margin 2), every netlist tap gets its sorters' slots, no slot is reused, and Σ AssignedTap rates per NetTap ≥ the NetTap rate.
  - Tap points are not inside buildings.
  - A span-2 choice increases the sorter count when one span-2 sorter can't carry the rate.
- [ ] **Step 3:** Implement `heap.ts` (binary heap), `taps.ts` and `router.ts`. Run the tests until they pass. Commit `feat(layout): tap assignment and negotiated 3D belt routing`.

### Task 23: Power poles and layout assembly

**Files:**
- Create: `app/src/lib/layout/power.ts`, `app/src/lib/layout/assemble.ts`
- Test: `power.test.ts`, `assemble.test.ts`

**Interfaces:**
- Produces:
  - `placePowerNodes(buildings: PlacedBuilding[], consumerPoints: { x: number; y: number }[] /* sorter midpoints (and later coaters) */, blockedPoints: Set<string> /* "x,y" belts+taps+sorter cells */, occ: Occupancy, data, effects): PlacedBuilding[] | null`. Coverage targets = consumer building centres **plus** `consumerPoints`.
    - Node type: the available node with the best `coverRadius² / footprint` (Tesla Tower in the fixture). Wireless Power Tower and Satellite Substation are only used if Tesla is unavailable.
    - Greedy set cover over candidate lattice points (not blocked; the node OBB collides with nothing).
    - Then connect components by adding relay nodes along straight lines (steps of 0.9·connectDistance).
    - Return null if coverage fails.
  - `assembleLayout(netlist, placement, taps, routes, powerNodes, plan, data): Layout`.
    - Creates the `BeltPath`s: the route nodes, `source`/`sink` set from station ports, `plannedRate` = net rate.
    - Creates one `Sorter` per AssignedTap: pick/drop endpoints between the machine slot and the belt node index of the tap point. Direction: 'in' taps pick from the belt and drop into the machine; 'out' taps the reverse. `filterItemId` = the net's item for **both** directions (an unfiltered output sorter on a multi-output machine, e.g. Plasma Refining, would put the wrong product on the belt and jam the station input). `plannedRate` = the tap's rate.
    - Creates station `StationConfig`: slots from the netlist (logic and max as set there); ports dir 1 for source nets, 2 for sink nets, 0 otherwise; `storageIdx` 1-based of the item slot; `chargePerTick` from the plan request; `pilerCount 0`.
    - Fills meta.

- [ ] **Step 1:** Tests:
  - On a synthetic set of 6 assemblers in a row, `placePowerNodes` yields nodes such that `checkGeometry` reports no POWER_* violations.
  - `placePowerNodes` covers sorter midpoints: a layout whose only uncovered consumer is a sorter gets an extra node.
  - `assembleLayout` from a tiny hand netlist (1 station, 1 smelter, import and export nets, hand routes) produces a layout that passes `validateLayout` with simulation (3000/6000 ticks).
  - For a Plasma Refining stage, the hydrogen output sorter has `filterItemId == 1120` and the refined-oil one `1114`.
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(layout): power node placement and layout assembly`.

### Task 24: Solver orchestrator, Web Worker and anytime loop

**Files:**
- Create: `app/src/lib/layout/solver.ts`, `app/src/lib/layout/worker.ts`, `app/src/lib/layout/client.ts`, `app/src/lib/layout/index.ts`
- Test: `solver.test.ts`, `app/test/solver.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SolveOptions { timeBudgetMs: number /* default 600000 */; seed: number; minRunMs: number /* 30000 */;
  earlyStopFraction: number /* 0.2 */; simulate: boolean; simWarmupTicks?: number; simMeasureTicks?: number;
  now?: () => number }   // injectable clock for tests
export interface SolveProgress { elapsedMs: number; attempts: number; validated: number; bestFootprint: number | null; phase: string; lastFailure?: string }
export interface SolveResult { layout: Layout | null; report: ValidationReport | null; footprint: number | null; attempts: number; validated: number; stoppedBy: 'budget' | 'early' | 'user' | 'exhausted'; failures: string[] }
export function solve(plan: ProductionPlan, data: GameDataIndex, effects: TechEffects, opts: SolveOptions,
  onProgress: (p: SolveProgress) => void, onImproved: (l: Layout, r: ValidationReport, footprint: number) => void, shouldStop: () => boolean): SolveResult;
export function footprintOf(layout: Layout, data: GameDataIndex): number;   // bbox area in tiles of all entities
```

**Algorithm (anytime):**
1. Build the netlist.
2. **Fallback ladder first:** margins `[3, 4, 6]`, then **constructivePlacement** → assignTaps → routeNets (elevation on) → power → assemble → `validateLayout` (fast checks; then simulation only if this would be the new best).
   - The first valid result is emitted immediately; this is the guarantee. **The fallback ladder runs to completion regardless of the time budget** (the budget and early-stop only apply to the improvement loop); only a user stop interrupts it.
   - If every margin fails, report `failures` (all violation messages) with `stoppedBy: 'exhausted'`.
3. **Improvement loop until the stop condition:**
   - pick a margin from `[1, 2]`;
   - anneal from the current best placement with a new seed, the iteration count scaled to the remaining time;
   - route, assemble and run the fast checks;
   - on success with a smaller footprint, run the simulation; if it passes, emit it as the new best.
4. **Stop conditions:**
   - `shouldStop()` ('user');
   - elapsed ≥ budget ('budget');
   - elapsed ≥ minRunMs and no improvement within the last `earlyStopFraction·elapsed` ('early').
5. `worker.ts` wraps `solve` with a message protocol:
   - `{type:'start', plan, data, effectsSerialized, opts}` and `{type:'stop'}`;
   - posts `{type:'progress'}`, `{type:'improved', layout, report, footprint}` and `{type:'done', result}`.
   - `client.ts` exposes `startSolve(...)` returning `{ stop(), done: Promise<SolveResult> }` with callbacks. Serialize Sets as arrays.

- [ ] **Step 1:** `solver.test.ts` (fake clock via `now`):
  - The early-stop rule triggers when there's no improvement in the last 20 % after 30 s.
  - The budget stop triggers.
  - The user stop returns the best found.
  - Determinism for a fixed seed.
- [ ] **Step 2:** `test/solver.e2e.test.ts`, marked with a 180 s timeout, using `simWarmupTicks: 1800, simMeasureTicks: 3600` to keep it fast. For fixture plans (a) 3 iron ingots/s, (b) 1 Circuit Board/s from iron and copper ore, (c) 1 Processor/s from ores (Mk.III assemblers, Mk.II belts), with a 20 s budget:
  - `layout != null`;
  - `report.pass`;
  - `report.sim.measuredTargetRate ≥ 0.99·plan rate`;
  - the blueprint string decodes;
  - the footprint is logged.
  - **This is the M3 acceptance test.** If (c) can't be made to pass, step back and fix the earlier components; don't weaken the assertion.
  - Performance: log the simulator's ticks/second for (c) and assert ≥ 2000 ticks/s.
  - **Property test** (spec §11): for 5 seeded random feasible plans (random target among items with ≤ 3 recipe stages from raw ores, random rate 0.5–3/s, all techs), every layout emitted through `onImproved` passes `validateLayout` with simulation. Use a 10 s budget each.
- [ ] **Step 3:** Implement. Run the tests until they pass. Commit `feat(layout): anytime solver with fallback ladder and web worker`.

### Task 25: UI: solve, preview, validation report and blueprint export

**Files:**
- Create: `app/src/ui/SolvePanel.svelte`, `app/src/ui/LayoutPreview.svelte`, `app/src/ui/ValidationPanel.svelte`, `app/src/ui/BlueprintPanel.svelte`, `app/src/ui/preview.ts`
- Modify: `app/src/App.svelte`, `app/src/ui/state.svelte.ts`
- Test: `app/src/ui/preview.test.ts`

**Interfaces:**
- Produces:
  - `preview.ts`: `renderLayout(ctx: CanvasRenderingContext2D, layout: Layout, data, opts: { level: number | 'all'; scale: number; highlight?: Violation[] })`. Buildings are drawn as OBB outlines filled by kind, belts as lines coloured by item (hash colour), sorters as short arrows, power nodes as circles with the cover radius at low alpha; violations are drawn in red.
  - `hitTest(layout, data, x, y)` returns the entity under the cursor, for a tooltip.
- **SolvePanel:** a Solve button (disabled without an ok plan); the time budget from the options; live progress (elapsed, attempts, validated, best footprint); "Stop & use best".
- **LayoutPreview:** a canvas with pan/zoom (wheel, drag), a height-level slider (`all`, 0..max z) and an entity tooltip.
- **ValidationPanel:** pass/fail; the violation list (clicking one highlights it); simulated vs planned target rate; measured power (steady/peak) next to the estimate.
- **BlueprintPanel:** a read-only textarea with the blueprint string, Copy (clipboard API with a fallback), Download `.txt` (`<target-name>-<rate>.txt`), an "approximate geometry" warning banner when applicable (Review Focus #5), and a permanent note: "Paste within the equatorial band (±28° latitude); pasting near the poles may fail" (spec §6.1).

- [ ] **Step 1:** `preview.test.ts` with a fake 2D context recording calls: renderLayout draws one path per belt and one rect per building; `hitTest` returns the assembler at its centre.
- [ ] **Step 2:** Implement. `npm run check && npm run build` must pass.
- [ ] **Step 3:** Browser check (the **controller** runs this after the task with the Playwright MCP; the implementer may skip it and say so) on `npm run dev`:
  - choose 1 Circuit Board/s with ores supplied;
  - set the budget to 0.5 min;
  - Solve, and wait for done;
  - the validation panel shows PASS, the blueprint textarea starts with `BLUEPRINT:`, and the approximate banner is visible.
  - Screenshot to `local/screenshots/m3-solve.png`.
- [ ] **Step 4:** Commit `feat(ui): solve panel, layout preview, validation and blueprint export`.

---

## Milestone M4: Density

### Task 26: Motif library (direct insertion, shared-belt sandwich, lab stacking)

**Files:**
- Create: `app/src/lib/layout/motifs/types.ts`, `app/src/lib/layout/motifs/direct-insertion.ts`, `app/src/lib/layout/motifs/sandwich.ts`, `app/src/lib/layout/motifs/lab-stack.ts`, `app/src/lib/layout/motifs/index.ts`
- Modify: `placement.ts`, `taps.ts`, `assemble.ts`, `netlist.ts` (motif-aware), `solver.ts` (enable motifs in the improvement loop)
- Test: one test file per motif, plus `motifs/index.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MotifInstance { kind: 'direct' | 'sandwich' | 'labStack'; machineIds: number[]; anchor: { x: number; y: number; yaw: Yaw };
  relative: { machineId: number; dx: number; dy: number; dz: number; yaw: Yaw }[];
  internalSorters: { fromMachine: number; fromSlot: number; toMachine: number; toSlot: number; itemId: number; span: 1|2|3 }[];
  satisfiesNets: { netId: number; machineIds: number[] }[] }   // nets (or parts) satisfied internally (no belt)
export interface Motif { kind: MotifInstance['kind']; propose(net: Netlist, data: GameDataIndex, effects: TechEffects): MotifInstance[] }
export const MOTIFS: Motif[];
export const VERIFIED_MOTIFS: Set<MotifInstance['kind']>;   // spec §6.4: enabled only when in-game verified; ships EMPTY, plus a UI/dev toggle "use unverified motifs"
```

- **direct-insertion (MX §9 M3):** when an intermediate net has exactly one producer machine and one consumer machine (after the netlist splits nets per consumer group, a 1:k ratio becomes k pairs only when rates allow), place producer and consumer facing each other. Use slot pairs whose `firstOutside` points lie on a line ≤ 3 tiles apart, found by searching relative offsets (dx, dy ∈ [−8, 8], 4 yaws) with the geometry kernel and checking the SORTER_* rules via `checkGeometry` on a 2-building mini layout. Rate check via `sorterRate` (building pick = 1 item/trip). The internal sorter replaces the belt for that pair.
- **sandwich (MX §9 M1):** two mirrored rows of same-stage machines around a shared belt line at `firstOutside` distance. It proposes only relative offsets (row pitch from a non-collision search: the smallest dx > 0 with no OBB overlap). Taps for both rows land on the same lattice line, so the router can use one straight belt.
- **lab-stack (MX §4.4, §8):** matrix stages using labs stack up to `effects.labLevel` high (`dz = lapJoint.y / LEVEL` levels). Only the bottom lab gets sorters. Machines in a stack count as one footprint. Requires sim support: extend `MachineSim` for stacked labs (pass ingredients up, products down, per MX §4.4) and add `PlacedBuilding.z > 0` with `stackParentId?: number` to the Layout model (update `geometry/model.ts`, `build.ts`: stacked building records set z and link nothing; and the validator's BUILDING_OVERLAP multiLevel exemption).
- [ ] **Step 1:** Per motif:
  - write a test that the proposals for a fixture plan are geometrically valid (`checkGeometry` clean on a mini layout) and that a layout using them passes `validateLayout`;
  - implement it.
  - Lab stack test: 6 Matrix Labs at labLevel 3 make 2 stacks; simulated output equals 6 labs' worth ±2 %.
- [ ] **Step 2:** Integrate:
  - in the improvement loop, with probability 0.5, apply motif instances to the netlist (remove the satisfied belt taps and add the internal sorters);
  - placement moves treat a motif as a rigid group;
  - motifs are only applied if `VERIFIED_MOTIFS` has the kind, or `opts.useUnverifiedMotifs` is true;
  - add `useUnverifiedMotifs: boolean` to SolveOptions and an OptionsPanel toggle, labelled "Use dense motifs not yet verified in-game".
- [ ] **Step 3:** The e2e test: Processor with `useUnverifiedMotifs: true` passes validation, and its footprint is ≤ the footprint without motifs (same seed, same budget). Commit `feat(layout): dense motifs (direct insertion, sandwich, lab stacks)`.

### Task 27: Multi-lane taps, elevation tuning and benchmarks

**Files:**
- Modify: `taps.ts` (span 2–3 multi-lane choice when span-1 points conflict), `router.ts` (bias toward reusing parallel lanes; elevation cost tuning), `solver.ts` (adaptive margin/iterations)
- Create: `app/scripts/bench.ts` (npm script `bench`), `docs/benchmarks.md`
- Test: `taps.test.ts` (new cases), `app/test/bench-smoke.test.ts`

**Interfaces:**
- Produces: `npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row`. For each plan it records time to first valid layout, best footprint and validated count, and appends a dated table row to `docs/benchmarks.md`.
- [ ] **Step 1:** Taps tests:
  - When two nets' span-1 tap points coincide, one takes span 2 on the same slot direction (a multi-lane bus, MX §9 M2) and the sorter rate still covers the tap rate (else more sorters).
  - Validate with `checkCapacity`.
- [ ] **Step 2:** Implement the tuning. Run `bench` with budget 60 on all four plans; record the results. Quantum Chip from raw ores must produce a valid layout within the budget (the fallback guarantees one), and its time to first valid layout must be recorded.
- [ ] **Step 3:** Commit `perf(layout): multi-lane taps, routing tuning, benchmark harness`.

---

## Milestone M5: Extras

### Task 28: Spray coaters and the proliferator network

**Files:**
**Pattern (from the capsule sample, plan review):** the proliferator line is a single elevated (z = 1) dead-end belt whose path passes through each coater's **top-passage point** (prefab addon centre `[0, 1.333, −1.25]` m, i.e. one level up, offset along the coater's axis). Nothing links to the coater: coater records have `outputObjIdx = inputObjIdx = -1` and slot fields `14,15,15,14,0,0`, and no belt has `outputObjIdx` pointing at a coater.

- Modify: `netlist.ts` (a proliferator net: source station port, sink deadEnd, waypoints = coater top-passage points at z = 1), `router.ts` (route the proliferator net to pass through each coater top point at z = 1 along the coater's axis, using vertical lifts from the station port), `assemble.ts` (place coaters on item belts: on each input net's belt, a straight run of ≥ 3 ground nodes before the first consumer tap; coater yaw along the belt; do this before routing the proliferator net), `geometry-checks.ts` (coater must sit on a straight ground belt run; some proliferator belt node must be at its top point), `validate/sim/run.ts` (wire CoaterSim: the coater draws proliferator from the cargo passing its top point)
- Modify: `geometry/model.ts` (add optional `coaters?: { id: number; beltId: number; node: number; yaw: Yaw }[]` to `Layout`), `build.ts` (coater records: itemId 2313, model from data, at the belt node position, yaw along the belt, links -1, slots `14,15,15,14,0,0`)
- Test: `app/test/proliferator-e2e.test.ts`, plus new geometry-check cases

**Interfaces:** as described in the Modify bullets. `Layout.coaters` is optional so earlier layouts stay valid. The power-coverage rule (Task 15 rule 14) and `placePowerNodes` must include coaters as consumers.
- [ ] **Step 1:** Geometry tests: a coater on a straight belt passes; a coater on a corner fails (new code `COATER_PLACEMENT`); a coater without a proliferator feed fails (`COATER_UNFED`). Add both codes to `ViolationCode`.
- [ ] **Step 2:** E2E: Processor with Mk.III proliferator extra mode, budget 60 s:
  - the layout passes;
  - the simulated target rate ≥ 0.99·plan (the plan already accounts for +25 %);
  - proliferator consumption > 0 in the sim.
- [ ] **Step 3:** Implement. Run the tests until they pass. Commit `feat(layout): spray coaters and proliferator distribution`.

### Task 29: Multiple stations and by-product exports

**Files:**
- Modify: `placement.ts` (several stations: placed in a row at the origin with spacing from a non-collision search), `taps.ts` (port assignment across stations), `assemble.ts` (one StationConfig per station)
- Test: `app/test/multistation-e2e.test.ts`

- [ ] **Step 1:** E2E tests:
  - Quantum Chip from processors, plane filters and the like with PLS, forcing `stationsNeeded == 2`: the layout has 2 station buildings, each with ≤ 4 item slots, and passes validation with simulation.
  - Plasma Refining for refined oil with hydrogen as a by-product: hydrogen is exported to a station input port, and there are no SIM_STALLED violations (Review Focus #3 and #4).
- [ ] **Step 2:** Implement. Run the tests until they pass. Commit `feat(layout): multi-station blocks and by-product export`.

### Task 31: Blueprint importer and in-game regression runner

(Execute **before** Task 30; numbered 31 only to keep earlier numbering stable.)

**Files:**
- Create: `app/src/lib/blueprint/import.ts`, `app/test/regression.test.ts`, `app/test/fixtures/regression/README.md`
- Test: `app/src/lib/blueprint/import.test.ts`

**Interfaces:**
- Produces:
  - `blueprintToLayout(bp: Blueprint, data: GameDataIndex): { layout: Layout; warnings: string[] }`: the inverse of `layoutToBlueprint` for the entity kinds the planner uses (stations, production buildings, labs, belts, sorters, power nodes, coaters). Belt records are chained via `outputObjIdx` into `BeltPath`s (port-stub records are folded back into `source`/`sink`); sorter endpoints come from `inputObjIdx`/`outputObjIdx` and slot fields; fractional positions are kept. Unknown building kinds are skipped with a warning.
  - `regressionPlanFor(layout, data, effects)`: builds a minimal `ProductionPlan` from the layout (stages from recipe ids and machine counts; target = the station's supply slot item) so `runSimulation` can run on an imported blueprint.
  - `app/test/regression.test.ts`: for each `app/test/fixtures/regression/*.json` (`{ blueprint, gameVersion, targetItemId, measuredRates: Record<itemId, perSecond>, notes }`), decode, import, simulate (default ticks) and assert every measured rate is matched within **2 %** (spec §11). With no fixtures the test passes with a logged "no regression fixtures yet".
- [ ] **Step 1:** `import.test.ts`: `blueprintToLayout(decodeBlueprint(layoutToBlueprintString(L)))` reproduces `L` (buildings, belt node lists, sorter endpoints) for the Task 9 test layouts and for one solver output (Task 24 plan (a)).
- [ ] **Step 2:** Implement `import.ts` and `regression.test.ts`; README documents how to add a fixture from an in-game measurement.
- [ ] **Step 3:** Commit `feat(blueprint): blueprint importer and regression runner`.

### Task 30: User test runbook and final integration check

**Files:**
- Create: `docs/TESTING-ON-NOBARA.md`
- Modify: `README.md`

- [ ] **Step 1:** Write `docs/TESTING-ON-NOBARA.md`:
  1. Clone the repo; install Node 22 and Python ≥ 3.11; install the .NET 10 SDK and `ilspycmd`.
  2. `dsp-extract inspect`, then `dsp-extract --copy-blueprints --icons`.
  3. What to send back on failure: `local/extract-report.json`, the stdout, and any stack traces.
  4. Run the app with `npm run dev` and pick the extracted data (it is used automatically).
  5. **In-game checks** (start a sandbox-mode save on a planet's equator band):
     - (a) paste `local/test-blueprints/m0-smelter-row.txt` (regenerate with `npm run emit:test-bp`) and check that buildings and belts are positioned and connected as intended;
     - (b) generate and paste a 1 Circuit Board/s block;
     - (c) generate and paste the Processor block;
     - (d) for each, note whether paste succeeds, whether everything connects, and the measured output (the station's input count over 60 s).
  6. How to record a regression entry: `app/test/fixtures/regression/<name>.json`, holding `{ blueprint, gameVersion, targetItemId, measuredRates: {itemId: perSecond}, notes }` (consumed by `app/test/regression.test.ts`, Task 31).
  7. Known approximations to watch for, per BF §10 and MX §10, especially the yaw/axis convention and sorter slot positions.
  - Re-run `dsp-extract --check` after game patches.
- [ ] **Step 1b:** Add `app/test/mirrors.test.ts`: grep every `// mirrors: X` (and `mirrors: 'X'` violation fields) under `app/src`, and assert each `X` is a key in `tools/extract/src/dsp_extract/mirrored_methods.py` (parse the Python dict keys with a regex). Fix any omissions in `mirrored_methods.py`.
- [ ] **Step 2:** Final verification:
  - `cd app && npm run lint && npm run check && npm test && npm run build`;
  - `tools/extract/.venv/bin/pytest tools/extract`;
  - `npm run bench -- --budget 30 --plans processor`;
  - all must pass.
  - Attach the outputs to the final report.
- [ ] **Step 3:** Commit `docs: user testing runbook`.
