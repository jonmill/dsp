# DSP public datasets: survey and fixture recommendation

Researched 2026-10-10. Downloaded copies live in `docs/research/datasets/<source>/`.
They are data only. Nothing in them has been executed, and the generator scripts were not kept.

## TL;DR

- **Use `dsp-parser/` as the fixture basis.** It is a raw dump of the game's `ItemProtoSet`, `RecipeProtoSet` and `TechProtoSet`. It keeps the original IDs, `GridIndex`, `TimeSpend` in ticks, `Items/ItemCounts/Results/ResultCounts`, `Type`, `Handcraft`, `PreTechs` and `UnlockRecipes`, plus the building sub-descriptors (`_AssemblerDesc`, `_PowerDesc`, `_LabDesc`, ...). It has the same shape our own game-file extractor will produce, so fixture tests also exercise the real import path.
- It was dumped from game version **0.10.29.22015** (March 2024). The live game is **0.10.35.29104**. All 160 recipes have identical times, inputs and outputs across `dsp-parser` (Mar 2024), `dsp-calc` (data updated Dec 2024) and FactorioLab (updated Sep 2026). The only difference is that the Deuterium Fractionation recipe is modelled differently in each. Production recipes have not changed since 0.10.29. The fixture misses only the content added later (see Gaps).
- **Use FactorioLab (MIT) as the cross-check and fallback.** It is the only source maintained into 2026, and it already includes the Holo Beacon. Its `map.json` maps game IDs to its slugs.
- **Licensing caveat:** `dsp-parser` has **no license file**. All of this is derived from Youthcat's game data either way. For a committed fixture, prefer a small derived subset in our own schema, generated from these files and attributed. Do not vendor the raw files wholesale into shipped code.

## Sources

| Folder | Upstream | License | Game version | Last data update | Commit fetched |
|---|---|---|---|---|---|
| `dsp-parser/` | https://github.com/Martin-Pitt/dsp-parser (`dist/data/`) | none (no LICENSE) | 0.10.29.22015 (`meta.json`) | 2024-03-23 | `138b5d645a` |
| `factoriolab/` | https://github.com/factoriolab/factoriolab (`public/data/dsp/`) | MIT | `version.DSP` says 0.10.29.21950 (not bumped); contains 0.10.34 Holo Beacon | 2026-09-27 (`data.json`) | `08ff58b11d` |
| `dsp-calc/` | https://github.com/DSPCalculator/dsp-calc (`data/Vanilla.json`) | MulanPSL-2.0 | approx. 0.10.31 (no version field) | 2024-12-23 | `d53123399a` |
| `huww98-blueprint-editor/` | https://github.com/huww98/dsp_blueprint_editor (`src/data/*.ts`) | none | 0.10.29.21869 | 2024-05-26 | `5b1a258824` |
| `kirkmcdonald/` | https://github.com/KirkMcDonald/dsp-calculator (`data/data.json`) | Apache-2.0 | ~0.6.x (pre-Dark-Fog) | 2021-02-07 | `cc08d454b7` |

Not downloaded, but relevant:
- `Martin-Pitt/dsp-prod-ratios` (`src/data/`) is an older copy (0.10.29.21904) of the same `dsp-parser` output. It powers https://dsp-ratios.com. It was superseded by `dsp-parser` and deleted after diffing.
- **`dsp-parser` itself is a Node tool** (`src/assets-parser.mjs`, `src/lib/protoset.mjs`). It reads `resources.assets` from a DSP install and emits these JSONs. It is the most direct prior art for our "extract from the user's game files" step, so review it before writing our extractor.
- Thunderstore mod **DSP_Planner_Export** (Suite) serves `/protos` (items only: id, name, grid, building footprint `w`/`h`, slots), `/state` (tech levels) and `/rates` over HTTP from a running game. It has no recipe or tech-graph dump.
- Game patch notes are on dsp-wiki (`https://dsp-wiki.com/Patch_Notes:<version>`, readable via the MediaWiki API).

## Schemas

### dsp-parser (recommended basis)

Files: `items.json` (172), `recipes.json` (160), `tech.json` (306), `locale.json` (zh-CN / en-US / ja-JP), `meta.json`.

- **Field names** are the game's proto fields in camelCase (`timeSpend`, `itemCounts`, `preTechs`, ...).
- **Enums** are strings (`"type": "ASSEMBLE"`, `"type": "PRODUCTION"`).
- **`name`** is the game's string *key*, which is Chinese (e.g. `"处理器"`). Translate it via `locale.json[1].strings[name]`, which gives "Processor". Tech names are prefixed with `T` (e.g. `"T处理器"`).
- **BigInt encoding:** `int64` values are encoded as `{":type":"BigInt","value":"144000"}`. This applies to `hashNeeded`, `heatValue` and `workEnergyPerTick`.
- **Recipes:** `id`, `sid` (= GridIndex string), `type` (SMELT/ASSEMBLE/CHEMICAL/REFINE/PARTICLE/RESEARCH/FRACTIONATE), `handcraft`, `explicit` (true on alternate recipes), `nonProductive`, `timeSpend` (**ticks, 60/s**), `items`, `itemCounts`, `results`, `resultCounts`, `gridIndex`, `iconPath`.
- **Items:** `id`, `type` (RESOURCE/MATERIAL/COMPONENT/PRODUCTION/MATRIX/...), `stackSize`, `gridIndex`, `productive`, `heatValue` (J), `fuelType`, `ability`, `buildIndex`, `upgrades`, `miningFrom`, `produceFrom`, `isFluid`, `canBuild`, `modelIndex`, `preTechOverride`, `unlockKey`, `descFields`.
  - Buildings also carry the decoded prefab descriptors:
    - `_AssemblerDesc {speed (×10000, e.g. 7500 = 0.75), recipeType}`
    - `_LabDesc {assembleSpeed, researchSpeed}`
    - `_PowerDesc {workEnergyPerTick, idleEnergyPerTick, consumer, generator, genEnergyPerTick, useFuelPerTick, fuelMask, ...}` (J/tick; ×60 = W)
    - `_MinerDesc`, `_BeltDesc`, `_InserterDesc`, `_StationDesc`, `_FractionatorDesc`, `_SpraycoaterDesc {incCapacity, incItemId}`, `_EjectorDesc`, `_SiloDesc`, `_TurretDesc`, `_BeaconDesc`, ...
    - `_BuildConditionConfig {landPoints, ...}` and `_SlotConfig {selectSize, selectCenter, insertPoses...}` (geometry)
    - `_descFields` (the tooltip rows as display strings)
- **Techs:** `id`, `preTechs`, `preTechsImplicit`, `preTechsMax`, `items` + `itemPoints` (matrix types and points), `hashNeeded`, `unlockRecipes`, `unlockFunctions`/`unlockValues` (upgrade effects), `addItems`/`addItemCounts` (rewards), `level`/`maxLevel`/`levelCoef1`/`levelCoef2` (repeatable upgrades), `isLabTech`, `isHiddenTech`, `isObsolete`, `position` (tree layout), `preItem`, `propertyOverrideItems`.
  - Matrix cost per item = `hashNeeded × itemPoints / 3600`. For example, Electromagnetism: 1200 × 30 / 3600 = 10 Magnetic Coil. Processor tech 1302: 144000 × 20 / 3600 = 800 Electromagnetic Matrix.
- **Original IDs:** yes, for items, recipes, techs and buildings. A building is an item, and the item `id` is the building ID used by recipes and blueprints.
- **Tech prerequisites and unlocks:** yes. For example, 1302 Processor: `preTechs [1311]`, `unlockRecipes [51]`.
- **Buildings:** speed, work/idle power, recipe type, and geometry (land points and select box). The blueprint grid footprint is not given as a simple W×H; derive it from `landPoints` or `_SlotConfig.selectSize`. `blueprintBoxSizeOverride` is never set in this dump.
- **Proliferator:**
  - Items 1141/1142/1143 have `ability` 1/2/4 (index into the game's inc/acc tables) and `heatValue`.
  - The effect percentages appear only as tooltip strings in `_descFields`: extra products +12.5/+20/+25 %, speedup +25/+50/+100 %, power +30/+70/+150 %, sprays 12/24/60.
  - The numeric tables (`Cargo.incTableMilli`, `accTableMilli`, `powerTableRatio`) are code constants, not protos, so no source has them as protos.
  - Recipe eligibility for extra products: `!nonProductive && every input item.productive`.

### FactorioLab (`factoriolab/`)

- **`data.json`:** `{version, categories, icons, items[486], recipes[493], limitations, defaults, flags}`. It uses FactorioLab's generic multi-game schema with slug IDs (`"processor"`).
- **Items:**
  - `machine` `{speed, usage (kW), drain (kW), type electric|burner, modules, fuelTypes}`
  - `belt.speed` (items/s: 6/12/30)
  - `fuel.value` (MJ)
  - `module` (proliferator)
  - `technology {prerequisites, recipeUnlock}`
- **Recipes:** `time` (**seconds**), `in`/`out` maps, `producers` (machine slugs), `flags` (`locked`, `mining`, `technology`), `cost`.
  - Tech research is modelled as recipes in category `technologies`: `in` = `itemPoints` (matrices consumed per 3600 hash) and `out` = 3600. **The total `hashNeeded` is not present**, so total tech cost cannot be derived. Repeatable upgrades are one item per level.
  - Mining and pump recipes exist (`iron-vein`, ...).
- **`map.json`:** game ID → slug for `recipes` (160), `items` (172), `techs` (305) and `veins` (14). This is how you get original IDs. The 0.10.34 Holo Beacon and its tech have **no** game ID in `map.json` yet.
- **Proliferator:** most complete as numbers. The modules `proliferator-{1,2,3}-products` / `-speed` are `{productivity 0.125/0.2/0.25, speed 0.25/0.5/1.0, consumption 0.3/0.7/1.5, sprays 12/24/60}`, and `limitations.productivity` is the list of recipes eligible for extra products.
- **Buildings:** speed and power. No size/footprint.
- **Other:** `defaults.json` holds the default excluded alternate recipes and machine ranks. `hash.json` is URL-hash ordering (ignore). `zh.json` holds Chinese names.

### dsp-calc (`dsp-calc/Vanilla.json`; note: UTF-8 **BOM**, read with `utf-8-sig`)

- **Fields:** `{items[174], recipes[238]}` in PascalCase proto fields.
  - Recipe fields: `ID, Type (int enum), Factories [building item IDs], Name (zh), Items, ItemCounts, Results, ResultCounts, TimeSpend (ticks), Proliferator (bitmask: 1 = speedup only, 3 = speedup + extra products), IconName`.
  - Item fields: `ID, Type, Name, GridIndex, IconName`; buildings add `WorkEnergyPerTick` (J/tick), `Speed`, `Space` (footprint area; unit unconfirmed, e.g. Assembler 10.24 = 3.2²).
- **Original IDs:** yes, for items, recipes and buildings.
- **Techs:** **none**.
- **Pseudo-recipes:** 78 recipes with `Type -1` and `ID ≥ 10000` (`[无中生有]…`, "from nothing") are calculator pseudo-recipes. Filter them out.
- **Value:** independent confirmation of recipe numbers and a ready-made recipe→factory list.

### huww98 blueprint editor (`huww98-blueprint-editor/`)

- **Format:** TypeScript literals generated from proto dumps. Items have `{id, grid:[page,row,col], productive}`; recipes have `{id, time (ticks), from, to, grid, nonProductive}`.
- **`building.ts`:** per-model `selectSize` boxes, which are useful for blueprint rendering.
- **Missing:** no techs and no power data. Names are in Chinese.

### Kirk McDonald (`kirkmcdonald/`)

- 2021, pre-Dark-Fog (112 recipes, short keys, seconds). It has no game IDs or techs. **Obsolete**; kept only for completeness.

## Comparison

| | dsp-parser | FactorioLab | dsp-calc | huww98 | Kirk |
|---|---|---|---|---|---|
| Game IDs (items/recipes) | yes | via `map.json` | yes | yes | no |
| Tech IDs, prerequisites, unlocks | yes (raw) | yes (slugs; IDs via map) | no | no | no |
| Tech cost (hash, matrices) | yes | per-hash rate only, no total | no | no | no |
| Time unit | ticks | seconds | ticks | ticks | seconds |
| Building speed / power | yes (raw) | yes (kW) | yes (J/tick) | no | speed only |
| Building size | geometry (raw) | no | area scalar | select boxes | no |
| Proliferator effects | tooltip strings + item ability | numeric modules + eligibility list | eligibility bitmask | productive flags | no |
| English names | via `locale.json` | yes | no (zh) | no (zh) | yes |
| Dark Fog content | yes | yes | yes | yes | no |
| Post-0.10.29 content | no | Holo Beacon only | no | no | no |

## Gaps and gotchas for the fixture

1. **Content added after 0.10.29 is missing from the raw dump:**
   - 0.10.31: "Solar Sail Attaching Speed" upgrade techs.
   - 0.10.33: "Blueprint Foundation Limit" upgrade under Mass Construction.
   - 0.10.34: **Holo Beacon** building, recipe and tech. FactorioLab has it: 3 Iron Ingot + 4 Prism + 2 Plasma Exciter + 2 Circuit Board → 1, 4 s, assembler; tech prerequisite Basic Assembling Processes, `in` 180 EM matrix per 3600 hash (total hash unknown). Its game IDs are unknown.
   - 0.10.35: **Dark Fog Lens** item, recipe and tech (a Ray Receiver lens). No public source has it yet.

   None of these touch the production chains below. Real extraction will close this gap.
2. **Deuterium Fractionation (recipe 115)** is a 1 %-per-pass building mechanic, so each source encodes it differently:
   - dsp-parser: 100 H → 1 D at time 1.
   - dsp-calc: 1 → 1 at time 6000.
   - FactorioLab: 0.01 → 0.01.

   Model fractionators specially.
3. **Not recipes, but needed by a planner:** mining rates (veins, `_MinerDesc`, Vein Utilization research), orbital collectors, water pumps, oil extractors, Ray Receiver photon output, and Dyson energy. FactorioLab models some of these as `mining` recipes.
4. Proliferator numeric tables are not in any proto dump. Hard-code them from FactorioLab's module values, which match the in-game tooltips.
5. Alternate recipes are flagged `explicit: true` in dsp-parser: X-ray Cracking, Diamond/Crystal Silicon/Casimir/Carbon Nanotube/Particle Container/Space Warper/Photon Combiner "(advanced)", Graphene (advanced), and Organic Crystal (original).
   - Refined oil has two producers, Plasma Refining (16) and Reformed Refinement (121), and **both** are flagged explicit. Use 16 as the default.
   - Hydrogen has no "home" recipe; it is a byproduct of 16, 32, 58 and 74, or comes from gas giants.

## Test targets: canonical chains with rates

Data: `dsp-parser` 0.10.29.22015. All recipe numbers were cross-checked against FactorioLab and dsp-calc, and every source agrees.

**Conventions:**
- `crafts/s = demand / output count`, and `machines = crafts/s × (timeSpend / 60) / speed`.
- No proliferator.
- Byproducts are **not** credited back. This is tree expansion, not LP; a net line is given where it matters.
- Base-tier machines:
  - Assembling Machine Mk.I 0.75× (Mk.II 1.0×, Mk.III 1.5×, Recomposing Assembler 3.0×)
  - Arc Smelter 1.0× (Plane 2.0×, Negentropy 3.0×)
  - Chemical Plant 1.0× (Quantum 2.0×)
  - Oil Refinery 1.0×
  - Miniature Particle Collider 1.0×
  - Matrix Lab 1.0× (Self-evolution Lab 3.0×)
- Default recipe per item = the non-`explicit` recipe, with Refined Oil = Plasma Refining (16).
- **Boundary items** (treated as raw inputs): Water 1000, ores 1001–1006, Crude Oil 1007, Fire Ice 1011, Hydrogen 1120, Deuterium 1121, Critical Photon 1208.

Ready-made assertions:
- 1 Processor/s with Assembler Mk.I = **4 assemblers** (3 s ÷ 0.75 = 4 s per craft), consuming 2 Circuit Board/s + 2 Microcrystalline Component/s. The full chain needs 2 Iron Ore + 3 Copper Ore + 8 Silicon Ore per second, 10⅔ assemblers and 13 arc smelters.
- 1 Processor/s at Assembler Mk.III (1.5×) = 2 assemblers. At the Recomposing Assembler (3×) = 1.
- With Proliferator Mk.III extra products (+25 %) on the Processor step: 0.8 crafts/s → 3.2 Mk.I assemblers, consuming 1.6 Circuit Board/s + 1.6 Microcrystalline/s. Power is 270 kW × 2.5 = 675 kW each.
- With Proliferator Mk.III speedup (+100 %): Mk.I effective 1.5× → 2 assemblers, unchanged inputs, 675 kW each.
- Assembler Mk.I power: `workEnergyPerTick 4500` × 60 = 270 kW work and `idle 200` × 60 = 12 kW idle (FactorioLab `usage 270`, `drain 12`).
- 1 Graphene/s via recipe 31 = 1.5 Chemical Plants. Via recipe 32 = 1 Chemical Plant, + 1 Fire Ice/s in, + 0.5 Hydrogen/s byproduct.
- Tech: Processor (1302) requires Semiconductor Material (1311) and unlocks recipe 51. 1311 unlocks recipe 53 (Microcrystalline Component).

Chains below are generated by tree expansion over `dsp-parser/recipes.json`. Fractions are exact. Rows are ordered from the target down. Item and recipe IDs are the game IDs.

#### Processor: 1 Processor/s

| Recipe (game ID) | Inputs -> Outputs per craft | Time (ticks / s) | Machine (speed) | Crafts/s | Machines |
|---|---|---|---|---|---|
| Processor (51) | 2 Circuit Board + 2 Microcrystalline Component -> 1 Processor | 180 / 3 | Assembling Machine Mk.I (0.75x) | 1 | 4 |
| Circuit Board (50) | 2 Iron Ingot + 1 Copper Ingot -> 2 Circuit Board | 60 / 1 | Assembling Machine Mk.I (0.75x) | 1 | 1.333 (4/3) |
| Microcrystalline Component (53) | 2 High-purity Silicon + 1 Copper Ingot -> 1 Microcrystalline Component | 120 / 2 | Assembling Machine Mk.I (0.75x) | 2 | 5.333 (16/3) |
| Iron Ingot (1) | 1 Iron Ore -> 1 Iron Ingot | 60 / 1 | Arc Smelter (1x) | 2 | 2 |
| Copper Ingot (3) | 1 Copper Ore -> 1 Copper Ingot | 60 / 1 | Arc Smelter (1x) | 3 | 3 |
| High-purity Silicon (59) | 2 Silicon Ore -> 1 High-purity Silicon | 120 / 2 | Arc Smelter (1x) | 4 | 8 |

Boundary inputs/s: Iron Ore (1001) 2; Copper Ore (1002) 3; Silicon Ore (1003) 8

Machine totals (fractional, unrounded): Arc Smelter 13; Assembling Machine Mk.I 10.67 (32/3)

#### Quantum Chip: 1 Quantum Chip/s

| Recipe (game ID) | Inputs -> Outputs per craft | Time (ticks / s) | Machine (speed) | Crafts/s | Machines |
|---|---|---|---|---|---|
| Quantum Chip (52) | 2 Processor + 2 Plane Filter -> 1 Quantum Chip | 360 / 6 | Assembling Machine Mk.I (0.75x) | 1 | 8 |
| Plane Filter (38) | 1 Casimir Crystal + 2 Titanium Glass -> 1 Plane Filter | 720 / 12 | Assembling Machine Mk.I (0.75x) | 2 | 32 |
| Processor (51) | 2 Circuit Board + 2 Microcrystalline Component -> 1 Processor | 180 / 3 | Assembling Machine Mk.I (0.75x) | 2 | 8 |
| Casimir Crystal (28) | 1 Titanium Crystal + 2 Graphene + 12 Hydrogen -> 1 Casimir Crystal | 240 / 4 | Assembling Machine Mk.I (0.75x) | 2 | 10.67 (32/3) |
| Titanium Glass (30) | 2 Glass + 2 Titanium Ingot + 2 Water -> 2 Titanium Glass | 300 / 5 | Assembling Machine Mk.I (0.75x) | 2 | 13.33 (40/3) |
| Circuit Board (50) | 2 Iron Ingot + 1 Copper Ingot -> 2 Circuit Board | 60 / 1 | Assembling Machine Mk.I (0.75x) | 2 | 2.667 (8/3) |
| Microcrystalline Component (53) | 2 High-purity Silicon + 1 Copper Ingot -> 1 Microcrystalline Component | 120 / 2 | Assembling Machine Mk.I (0.75x) | 4 | 10.67 (32/3) |
| Iron Ingot (1) | 1 Iron Ore -> 1 Iron Ingot | 60 / 1 | Arc Smelter (1x) | 4 | 4 |
| Copper Ingot (3) | 1 Copper Ore -> 1 Copper Ingot | 60 / 1 | Arc Smelter (1x) | 6 | 6 |
| Titanium Crystal (26) | 1 Organic Crystal + 3 Titanium Ingot -> 1 Titanium Crystal | 240 / 4 | Assembling Machine Mk.I (0.75x) | 2 | 10.67 (32/3) |
| Graphene (31) | 3 Energetic Graphite + 1 Sulfuric Acid -> 2 Graphene | 180 / 3 | Chemical Plant (1x) | 2 | 6 |
| Glass (57) | 2 Stone -> 1 Glass | 120 / 2 | Arc Smelter (1x) | 4 | 8 |
| High-purity Silicon (59) | 2 Silicon Ore -> 1 High-purity Silicon | 120 / 2 | Arc Smelter (1x) | 8 | 16 |
| Sulfuric Acid (24) | 6 Refined Oil + 8 Stone + 4 Water -> 4 Sulfuric Acid | 360 / 6 | Chemical Plant (1x) | 0.5 (1/2) | 3 |
| Organic Crystal (25) | 2 Plastic + 1 Refined Oil + 1 Water -> 1 Organic Crystal | 360 / 6 | Chemical Plant (1x) | 2 | 12 |
| Titanium Ingot (65) | 2 Titanium Ore -> 1 Titanium Ingot | 120 / 2 | Arc Smelter (1x) | 10 | 20 |
| Plastic (23) | 2 Refined Oil + 1 Energetic Graphite -> 1 Plastic | 180 / 3 | Chemical Plant (1x) | 4 | 12 |
| Plasma Refining (16) | 2 Crude Oil -> 1 Hydrogen + 2 Refined Oil | 240 / 4 | Oil Refinery (1x) | 6.5 (13/2) | 26 |
| Energetic Graphite (17) | 2 Coal -> 1 Energetic Graphite | 120 / 2 | Arc Smelter (1x) | 10 | 20 |

Boundary inputs/s: Water (1000) 8; Iron Ore (1001) 4; Copper Ore (1002) 6; Silicon Ore (1003) 16; Titanium Ore (1004) 20; Stone (1005) 12; Coal (1006) 20; Crude Oil (1007) 13; Hydrogen (1120) 24

Byproducts/s (not credited back): Hydrogen (1120) 6.5 (13/2)

Net Hydrogen if byproduct is recycled: 17.5 (35/2)/s import

Machine totals (fractional, unrounded): Arc Smelter 74; Assembling Machine Mk.I 96; Oil Refinery 26; Chemical Plant 33

#### Universe Matrix: 1 Universe Matrix/s

| Recipe (game ID) | Inputs -> Outputs per craft | Time (ticks / s) | Machine (speed) | Crafts/s | Machines |
|---|---|---|---|---|---|
| Universe Matrix (75) | 1 Electromagnetic Matrix + 1 Energy Matrix + 1 Structure Matrix + 1 Information Matrix + 1 Gravity Matrix + 1 Antimatter -> 1 Universe Matrix | 900 / 15 | Matrix Lab (1x) | 1 | 15 |
| Electromagnetic Matrix (9) | 1 Magnetic Coil + 1 Circuit Board -> 1 Electromagnetic Matrix | 180 / 3 | Matrix Lab (1x) | 1 | 3 |
| Energy Matrix (18) | 2 Energetic Graphite + 2 Hydrogen -> 1 Energy Matrix | 360 / 6 | Matrix Lab (1x) | 1 | 6 |
| Structure Matrix (27) | 1 Diamond + 1 Titanium Crystal -> 1 Structure Matrix | 480 / 8 | Matrix Lab (1x) | 1 | 8 |
| Information Matrix (55) | 2 Processor + 1 Particle Broadband -> 1 Information Matrix | 600 / 10 | Matrix Lab (1x) | 1 | 10 |
| Mass-energy Storage (74) | 2 Critical Photon -> 2 Antimatter + 2 Hydrogen | 120 / 2 | Miniature Particle Collider (1x) | 0.5 (1/2) | 1 |
| Gravity Matrix (102) | 1 Graviton Lens + 1 Quantum Chip -> 2 Gravity Matrix | 1440 / 24 | Matrix Lab (1x) | 0.5 (1/2) | 12 |
| Particle Broadband (36) | 2 Carbon Nanotube + 2 Crystal Silicon + 1 Plastic -> 1 Particle Broadband | 480 / 8 | Assembling Machine Mk.I (0.75x) | 1 | 10.67 (32/3) |
| Quantum Chip (52) | 2 Processor + 2 Plane Filter -> 1 Quantum Chip | 360 / 6 | Assembling Machine Mk.I (0.75x) | 0.5 (1/2) | 4 |
| Graviton Lens (101) | 4 Diamond + 1 Strange Matter -> 1 Graviton Lens | 360 / 6 | Assembling Machine Mk.I (0.75x) | 0.5 (1/2) | 4 |
| Carbon Nanotube (33) | 3 Graphene + 1 Titanium Ingot -> 2 Carbon Nanotube | 240 / 4 | Chemical Plant (1x) | 1 | 4 |
| Crystal Silicon (37) | 1 High-purity Silicon -> 1 Crystal Silicon | 120 / 2 | Arc Smelter (1x) | 2 | 4 |
| Plane Filter (38) | 1 Casimir Crystal + 2 Titanium Glass -> 1 Plane Filter | 720 / 12 | Assembling Machine Mk.I (0.75x) | 1 | 16 |
| Processor (51) | 2 Circuit Board + 2 Microcrystalline Component -> 1 Processor | 180 / 3 | Assembling Machine Mk.I (0.75x) | 3 | 12 |
| Diamond (60) | 1 Energetic Graphite -> 1 Diamond | 120 / 2 | Arc Smelter (1x) | 3 | 6 |
| Strange Matter (104) | 2 Particle Container + 2 Iron Ingot + 10 Deuterium -> 1 Strange Matter | 480 / 8 | Miniature Particle Collider (1x) | 0.5 (1/2) | 4 |
| Casimir Crystal (28) | 1 Titanium Crystal + 2 Graphene + 12 Hydrogen -> 1 Casimir Crystal | 240 / 4 | Assembling Machine Mk.I (0.75x) | 1 | 5.333 (16/3) |
| Titanium Glass (30) | 2 Glass + 2 Titanium Ingot + 2 Water -> 2 Titanium Glass | 300 / 5 | Assembling Machine Mk.I (0.75x) | 1 | 6.667 (20/3) |
| Circuit Board (50) | 2 Iron Ingot + 1 Copper Ingot -> 2 Circuit Board | 60 / 1 | Assembling Machine Mk.I (0.75x) | 3.5 (7/2) | 4.667 (14/3) |
| Microcrystalline Component (53) | 2 High-purity Silicon + 1 Copper Ingot -> 1 Microcrystalline Component | 120 / 2 | Assembling Machine Mk.I (0.75x) | 6 | 16 |
| Particle Container (99) | 2 Electromagnetic Turbine + 2 Copper Ingot + 2 Graphene -> 1 Particle Container | 240 / 4 | Assembling Machine Mk.I (0.75x) | 1 | 5.333 (16/3) |
| Titanium Crystal (26) | 1 Organic Crystal + 3 Titanium Ingot -> 1 Titanium Crystal | 240 / 4 | Assembling Machine Mk.I (0.75x) | 2 | 10.67 (32/3) |
| Graphene (31) | 3 Energetic Graphite + 1 Sulfuric Acid -> 2 Graphene | 180 / 3 | Chemical Plant (1x) | 3.5 (7/2) | 10.5 (21/2) |
| Glass (57) | 2 Stone -> 1 Glass | 120 / 2 | Arc Smelter (1x) | 2 | 4 |
| High-purity Silicon (59) | 2 Silicon Ore -> 1 High-purity Silicon | 120 / 2 | Arc Smelter (1x) | 14 | 28 |
| Electromagnetic Turbine (98) | 2 Electric Motor + 2 Magnetic Coil -> 1 Electromagnetic Turbine | 120 / 2 | Assembling Machine Mk.I (0.75x) | 2 | 5.333 (16/3) |
| Sulfuric Acid (24) | 6 Refined Oil + 8 Stone + 4 Water -> 4 Sulfuric Acid | 360 / 6 | Chemical Plant (1x) | 0.875 (7/8) | 5.25 (21/4) |
| Organic Crystal (25) | 2 Plastic + 1 Refined Oil + 1 Water -> 1 Organic Crystal | 360 / 6 | Chemical Plant (1x) | 2 | 12 |
| Titanium Ingot (65) | 2 Titanium Ore -> 1 Titanium Ingot | 120 / 2 | Arc Smelter (1x) | 9 | 18 |
| Electric Motor (97) | 2 Iron Ingot + 1 Gear + 1 Magnetic Coil -> 1 Electric Motor | 120 / 2 | Assembling Machine Mk.I (0.75x) | 4 | 10.67 (32/3) |
| Gear (5) | 1 Iron Ingot -> 1 Gear | 60 / 1 | Assembling Machine Mk.I (0.75x) | 4 | 5.333 (16/3) |
| Magnetic Coil (6) | 2 Magnet + 1 Copper Ingot -> 2 Magnetic Coil | 60 / 1 | Assembling Machine Mk.I (0.75x) | 4.5 (9/2) | 6 |
| Plastic (23) | 2 Refined Oil + 1 Energetic Graphite -> 1 Plastic | 180 / 3 | Chemical Plant (1x) | 5 | 15 |
| Iron Ingot (1) | 1 Iron Ore -> 1 Iron Ingot | 60 / 1 | Arc Smelter (1x) | 20 | 20 |
| Magnet (2) | 1 Iron Ore -> 1 Magnet | 90 / 1.5 (3/2) | Arc Smelter (1x) | 9 | 13.5 (27/2) |
| Copper Ingot (3) | 1 Copper Ore -> 1 Copper Ingot | 60 / 1 | Arc Smelter (1x) | 16 | 16 |
| Plasma Refining (16) | 2 Crude Oil -> 1 Hydrogen + 2 Refined Oil | 240 / 4 | Oil Refinery (1x) | 8.625 (69/8) | 34.5 (69/2) |
| Energetic Graphite (17) | 2 Coal -> 1 Energetic Graphite | 120 / 2 | Arc Smelter (1x) | 20.5 (41/2) | 41 |

Boundary inputs/s: Water (1000) 7.5 (15/2); Iron Ore (1001) 29; Copper Ore (1002) 16; Silicon Ore (1003) 28; Titanium Ore (1004) 18; Stone (1005) 11; Coal (1006) 41; Crude Oil (1007) 17.25 (69/4); Hydrogen (1120) 14; Deuterium (1121) 5; Critical Photon (1208) 1

Byproducts/s (not credited back): Hydrogen (1120) 9.625 (77/8)

Net Hydrogen if byproduct is recycled: 4.375 (35/8)/s import

Machine totals (fractional, unrounded): Arc Smelter 150.5 (301/2); Assembling Machine Mk.I 122.7 (368/3); Oil Refinery 34.5 (69/2); Chemical Plant 46.75 (187/4); Miniature Particle Collider 5; Matrix Lab 54

#### Graphene, standard recipe 31: 1 Graphene/s

| Recipe (game ID) | Inputs -> Outputs per craft | Time (ticks / s) | Machine (speed) | Crafts/s | Machines |
|---|---|---|---|---|---|
| Graphene (31) | 3 Energetic Graphite + 1 Sulfuric Acid -> 2 Graphene | 180 / 3 | Chemical Plant (1x) | 0.5 (1/2) | 1.5 (3/2) |
| Energetic Graphite (17) | 2 Coal -> 1 Energetic Graphite | 120 / 2 | Arc Smelter (1x) | 1.5 (3/2) | 3 |
| Sulfuric Acid (24) | 6 Refined Oil + 8 Stone + 4 Water -> 4 Sulfuric Acid | 360 / 6 | Chemical Plant (1x) | 0.125 (1/8) | 0.75 (3/4) |
| Plasma Refining (16) | 2 Crude Oil -> 1 Hydrogen + 2 Refined Oil | 240 / 4 | Oil Refinery (1x) | 0.375 (3/8) | 1.5 (3/2) |

Boundary inputs/s: Water (1000) 0.5 (1/2); Stone (1005) 1; Coal (1006) 3; Crude Oil (1007) 0.75 (3/4)

Byproducts/s (not credited back): Hydrogen (1120) 0.375 (3/8)

Machine totals (fractional, unrounded): Arc Smelter 3; Oil Refinery 1.5 (3/2); Chemical Plant 2.25 (9/4)

#### Graphene, advanced recipe 32 (Fire Ice): 1 Graphene/s

| Recipe (game ID) | Inputs -> Outputs per craft | Time (ticks / s) | Machine (speed) | Crafts/s | Machines |
|---|---|---|---|---|---|
| Graphene (advanced) (32) | 2 Fire Ice -> 2 Graphene + 1 Hydrogen | 120 / 2 | Chemical Plant (1x) | 0.5 (1/2) | 1 |

Boundary inputs/s: Fire Ice (1011) 1

Byproducts/s (not credited back): Hydrogen (1120) 0.5 (1/2)

Machine totals (fractional, unrounded): Chemical Plant 1
