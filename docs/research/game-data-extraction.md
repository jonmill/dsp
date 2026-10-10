# DSP game-data extraction: research notes

Goal: statically extract items, recipes, techs and buildings (including geometry) from an installed
Dyson Sphere Program, using Python (UnityPy) and `ilspycmd` for targeted decompilation.

Research date: 2026-10-10. Reference game build: **0.10.35.29088** (latest
`DysonSphereProgram.GameLibs` package on the BepInEx NuGet feed). Prototype dumps cited below come
from 0.10.34.28529.

**Legend.**
- **[V]**: verified. I saw it in decompiled game code, a reference assembly, a real data dump, or I ran it.
- **[V-ref]**: verified against the BepInEx *reference* assembly. Signatures and fields are real,
  but method bodies are stripped (`throw null`).
- **[I]**: inferred. Plausible, but not seen in code. Confirm it with `ilspycmd` on the real DLL.

---

## 0. TL;DR for the implementer

1. **Unity version.** Current DSP is **Unity 2022.3.62f3c1, Mono backend** [V]. Older builds
   (2021 to 2023) were Unity 2018.4.12f1. Don't hardcode the version. Read it from the file header
   (`SerializedFile.unity_version`).
2. **Where protos live.** Every `XxxProtoSet` is a `ScriptableObject`, stored as a MonoBehaviour
   object in `DSPGAME_Data/resources.assets` [V]. Its script is resolved through
   `MonoScript.m_ClassName`, and the MonoScripts live in `globalgamemanagers.assets` [V].
   Type trees are **not embedded**. Generate them from `DSPGAME_Data/Managed/*.dll` with
   `TypeTreeGeneratorAPI` [V].
3. **Localization.** It is **not** in the assets any more (`StringProtoSet` no longer exists in
   0.10.35 [V-ref]). It lives in plain text files under `<game root>/Locale/` [V]. Proto `Name`
   fields are Chinese keys, for example `铁块` or `T通讯控制`. Look them up in `Locale/1033/*.txt`
   (English) [V].
4. **Building geometry.** `PrefabDesc` is built at runtime by `PrefabDesc.ReadPrefab(prefab, colliderPrefab)`
   [V]. The constructor reads Unity components on the prefab GameObject: `SlotConfig`,
   `BuildConditionConfig`, `BeltDesc`, `InserterDesc`, `AssemblerDesc`, `PowerDesc`, `StationDesc`
   and so on, plus all `Collider` components on the collider prefab. A static extractor must:
   - load each `ModelProto.PrefabPath` GameObject through the `ResourceManager` container,
   - walk the hierarchy,
   - read these MonoBehaviours with generated type trees,
   - compose Transform poses,
   - re-implement the `ReadPrefab` logic in section 2.6.

   **Naming trap [V]:** `SlotConfig.slotPoses` becomes `PrefabDesc.portPoses` (belt ports), and
   `SlotConfig.insertPoses` becomes `PrefabDesc.slotPoses` (sorter slots).
5. **Don't** generate type trees from the publicized BepInEx `GameLibs` DLL. Its private fields
   were made public, so the generator emits extra fields (`_colliderPath`, `prewarmed`,
   `_iconSprite`, ...) that are not in the serialized data [V, tested]. Use the game's own
   `Managed/Assembly-CSharp.dll`.

---

## 1. Where the proto data lives

### 1.1 Classes [V-ref]

```text
abstract class Proto                      { string Name; int ID; string SID; }
abstract class ProtoTable : ScriptableObject { string TableName; string Signature; }
class ProtoSet<T> : ProtoTable, ISerializationCallbackReceiver where T : Proto
                                          { T[] dataArray; /* private Dictionary<int,int> dataIndices (not serialized) */ }
class ItemProtoSet : ProtoSet<ItemProto> {}   // likewise RecipeProtoSet, TechProtoSet, ModelProtoSet, ...
```

`LDB` (static class) holds lazily loaded tables: `players`, `themes`, `veges`, `veins`, `items`,
`enemies`, `fleets`, `vehicleParts`, `models`, `recipes`, `techs`, `signals`, `audios`, `MIDIs`,
`effectEmitters`, `prompts`, `advisorTips`, `tutorial`, `achievements`, `milestones`,
`journalPatterns`, `goals`, `cosmicMessages`, `doodads` and `abnormalities`, plus the private
static `protoResDir` [V-ref].

There is **no `strings` table and no `StringProto`/`StringProtoSet` type** in 0.10.35. Older
builds had them [V-ref].

The loading path is `Resources.Load(protoResDir + typeof(T).Name)`, where `protoResDir = "Prototypes/"`.
That gives Resources paths like `Prototypes/ItemProtoSet` [I, but strongly supported].
LokiSharp/DspLib re-implements `LDB.LoadTable` with exactly that `"Prototypes/" + typeof(T).Name`
pattern, and the dumps are named `ItemProtoSet` and so on.
Sources: https://github.com/LokiSharp/DspLib/blob/master/DspLib/LDB.cs.
You can read the asset directly without knowing the path (section 5).

### 1.2 Files [V]

- The ProtoSets are MonoBehaviour objects in `DSPGAME_Data/resources.assets`.
- Their `m_Script` PPtrs point to MonoScripts in `DSPGAME_Data/globalgamemanagers.assets`.

Source: soarqin's `generate_text.py`, which runs against a real install with UnityPy.
It reads MonoScripts from `globalgamemanagers.assets`, then reads MonoBehaviours from
`resources.assets` and keeps those whose script class name ends in `ProtoSet`:
https://github.com/soarqin/DSP_Mods/blob/master/LiveStreamAssist/js/scripts/generate_text.py

Known ProtoSet class names (from the same script): `ItemProtoSet`, `TechProtoSet`,
`RecipeProtoSet`, `SignalProtoSet`, `VeinProtoSet`, `EnemyProtoSet`, `ModelProtoSet`,
`ThemeProtoSet`, `AchievementProtoSet`, `TutorialProtoSet`, `MilestoneProtoSet`, `GoalProtoSet`,
`AudioProtoSet`, `PromptProtoSet`, `AdvisorTipProtoSet`, `JournalPatternProtoSet`,
`CosmicMessageProtoSet`, `DoodadProtoSet`, `AbnormalityProtoSet`, `FleetProtoSet`,
`CreationPartProtoSet`, `EffectEmitterProtoSet`, `MIDIProtoSet`, `PlayerProtoSet`, `VegeProtoSet`.

The serialized layout of a ProtoSet object [V] is:

```text
m_GameObject, m_Enabled, m_Script, m_Name, TableName, Signature, dataArray[]
```

- A 28-byte MonoBehaviour header comes first, then the strings. In the raw `.dat` reader, strings
  are int32 length + UTF-8 + 4-byte alignment, and bools are 1 byte + 3 padding bytes.
  Source: https://github.com/LokiSharp/DspLib/blob/master/DspLib/LDBFileReader.cs
- `TableName` is `"Item"`, `"Tech"`, `"Recipe"`, and so on.
- `Signature` is a 32-hex-character hash, for example
  `Item 9B99CF5F04803D5A61177FEC266D9790` and `Tech 2452C409B78808D067E12A59B5FF0906`.
  It is a good version fingerprint for caching.

### 1.3 Type trees

Release builds ship without MonoBehaviour type trees. Both community extractors therefore need the
Managed DLLs:
- soarqin uses `TypeTreeGenerator(...).load_local_game(root)` [V].
- huww98 and DSPSeedCalc use AssetStudio exports, and AssetStudio needs the `Managed` folder [V].

So: **generate type trees** with
`UnityPy.helpers.TypeTreeGenerator` (needs `TypeTreeGeneratorAPI`; manylinux x86_64 wheels exist).
Pin `UnityPy>=1.20` and `TypeTreeGeneratorAPI>=0.0.10`, as soarqin's `requirements.txt` does
[V]. I tested with UnityPy 1.25.4 and TypeTreeGeneratorAPI 0.0.10.

### 1.4 Unity version [V]

- DSPSeedCalc `CLAUDE.md`: "Game: Dyson Sphere Program `0.10.34.28529`; Unity: `2022.3.62f3c1`;
  Script backend: Mono". https://github.com/soarqin/DSPSeedCalc/blob/HEAD/CLAUDE.md
- DSP mods compile against `UnityEngine.Modules` 2022.3.53 or 2022.3.62:
  https://github.com/NebulaModTeam/nebula/blob/master/Directory.Build.props and
  https://github.com/soarqin/DSP_Mods/blob/master/Directory.Build.props
- Historical builds used 2018.4.12f1 (Steam forum and mod docs; seen in search results).
- UnityPy parses `"2022.3.62f3c1"` correctly to (2022, 3, 62, f, 3) [V, ran it]. TypeTreeGeneratorAPI
  accepts the string too [V].

---

## 2. Field lists

All serialized fields are listed in serialization order, which is also the order of the generated
type tree.

- Items, recipes and techs: verified 3 ways. The reference DLL, a TypeTreeGenerator run (UnityPy +
  TypeTreeGeneratorAPI against the 0.10.35 reference DLL plus UnityEngine 2022.3.62 reference modules),
  and an AssetStudio JSON dump from 0.10.34
  (https://github.com/soarqin/DSPSeedCalc/tree/HEAD/Prototypes) [V].
- Enum-typed fields (`ERecipeType`, `EAmmoType`) are **byte-sized** (`UInt8` in the type tree) [V].

### 2.1 ItemProto (`Proto` base: `Name`, `ID`, `SID`) [V]

| Field | Type | Notes |
|---|---|---|
| Type | EItemType (int) | 0 Unknown, 1 Resource, 2 Material, 3 Component, 4 Product, 5 Logistics, 6 Production, 7 Decoration, 8 Turret, 9 Defense, 10 DarkFog, 11 Matrix [V] |
| SubID | int | |
| MiningFrom, ProduceFrom | string | locale keys |
| StackSize | int | |
| Grade | int | position in the upgrade chain |
| Upgrades | int[] | item IDs of the upgrade chain (for example Assembler MK.I/II/III) |
| IsFluid, IsEntity, CanBuild, BuildInGas | bool | `CanBuild` = is a building |
| IconPath, IconTag | string | `IconPath` is like `Icons/ItemRecipe/anti-matter` (Texture2D name = last segment) |
| ModelIndex, ModelCount | int | `ModelProto.ID` of the building model (range `[ModelIndex, ModelIndex+ModelCount)`) |
| HpMax, Ability | int | |
| HeatValue, Potential | long | fuel energy (J) |
| ReactorInc | float | |
| FuelType, CatalystType | int | |
| AmmoType | EAmmoType (byte) | |
| BombType, CraftType, BuildIndex, BuildMode, GridIndex, UnlockKey, PreTechOverride | int | `GridIndex` is XYZZ (page, row, col); `BuildIndex` is XYY |
| Productive | bool | can be proliferated |
| MechaMaterialID | int | |
| DropRate | float | |
| EnemyDropLevel | int | |
| EnemyDropRange | Vector2 | |
| EnemyDropCount | float | |
| EnemyDropMask | int | |
| EnemyDropMaskRatio | float | |
| DescFields | int[] | |
| Description | string | locale key, for example `I反物质` |
| iconTagString, iconNameTagString | string | |

Non-serialized fields computed at runtime [V-ref]: `prefabDesc` (from `LDB.models.Select(ModelIndex)`
[I]), `recipes`, `makes`, `handcraft`, `maincraft`, `rawMats`, `preTech`, `isRaw`, and others.

Useful constants on `ItemProto` [V-ref]:
- water 1000, drone 5001, ship 5002, courier 5003, warper 1210
- vein miner 2301, oil miner 2307, advanced miner 2316
- spraycoater 2313, accumulator 2206 (full 2207), soil pile 1099
- `kMaxProtoId` 12000

### 2.2 RecipeProto [V]

| Field | Type |
|---|---|
| Name, ID, SID | string, int, string (SID is like `"1101"`) |
| Type | ERecipeType (byte): 0 None, 1 Smelt, 2 Chemical, 3 Refine, 4 Assemble, 5 Particle, 6 Exchange, 7 PhotonStore, 8 Fractionate, 15 Research |
| Handcraft, Explicit | bool |
| TimeSpend | int (**ticks**, 60/s; iron ingot = 60) |
| Items, ItemCounts, Results, ResultCounts | int[] |
| GridIndex | int |
| IconPath, IconTag, Description | string |
| NonProductive | bool (true = no proliferator "extra products" mode) |
| iconTagString, iconNameTagString | string |

`AssemblerDesc.recipeType` uses the same `ERecipeType` to pick which recipes a building can run.

### 2.3 TechProto [V]

| Field | Type | Notes |
|---|---|---|
| Name, ID, SID | | `Name` is like `T通讯控制` (locale key) |
| Desc, Conclusion | string | |
| Published, IsHiddenTech, IsObsolete | bool | skip `IsObsolete` (for example the old sorter-stacking techs 3301 to 3306) |
| PreItem | int[] | |
| Level, MaxLevel | int | leveled or infinite techs: one proto per level band; MaxLevel 10000 means infinite |
| LevelCoef1, LevelCoef2 | int | hash scaling for leveled techs (`GetHashNeeded(level)`, body to decompile) |
| IconPath, IconTag | string | |
| IsLabTech | bool | |
| PreTechs, PreTechsImplicit | int[] | |
| PreTechsMax | bool | |
| Items, ItemPoints | int[] | matrix IDs (6001 to 6006) and points per hash |
| PropertyOverrideItems, PropertyItemCounts | int[] | |
| HashNeeded | long | |
| UnlockRecipes | int[] | recipe IDs |
| UnlockFunctions | int[] | see section 3 |
| UnlockValues | double[] | parallel to `UnlockFunctions` |
| AddItems, AddItemCounts | int[] | items granted on unlock |
| Position | Vector2 | tech-tree position |
| iconTagString, iconNameTagString | string | |

### 2.4 ModelProto [V]

Serialized fields: `Name`, `ID`, `SID`, `OverrideName`, `Order`, `ObjectType` (EObjectType),
`RuinType`, `RendererType`, `RotSymmetry`, `HpMax`, `HpUpgrade`, `HpRecover`, `RuinId`,
`RuinCount`, `RuinLifeTime`, and `PrefabPath`.

- The AssetStudio dump ends at `PrefabPath`.
- `_colliderPath`, `_ruinPath`, `_wreckagePath`, `prewarmed` and `_iconSprite` are private, so they
  are **not serialized**.

Example `PrefabPath` values [V]:

| ID | PrefabPath |
|---|---|
| 35 / 36 / 37 | `Entities/Prefabs/belt-1/2/3` |
| 38 / 39 / 40 | `Entities/Prefabs/splitter-a/b/c` |
| 41 / 42 / 43 / 483 | `Entities/Prefabs/inserter-1/2/3/4` |
| 49 | `Entities/Prefabs/logistic-station` |
| 50 | `Entities/Prefabs/interstellar-logistic-station` |
| 65 / 66 / 67 / 456 | `Entities/Prefabs/assembler-mk-1/2/3/4` |
| 1 | `Ore/Prefabs/metal-ore-1` |

The dump has 664 models (https://github.com/soarqin/DSPSeedCalc/blob/HEAD/Prototypes/ModelProtoSet.json).

How the runtime loads a model [I, mirrored by mods]:
- Mods recreate `ModelProto.Preload` as
  `prefab = Resources.Load<GameObject>(PrefabPath); colliderPrefab = Resources.Load<GameObject>(ColliderPath);`
  `prefabDesc = colliderPrefab == null ? new PrefabDesc(id, prefab) : new PrefabDesc(id, prefab, colliderPrefab)`.
  Sources: https://github.com/Awbugl/ProjectGenesis/blob/HEAD/src/Utils/CopyModelUtils.cs and
  https://github.com/komonad/ProliferatorMk4/blob/HEAD/src/Plugin.cs
- **Open item:** `ColliderPath` is a computed getter of `PrefabPath` (body stripped). Run
  `ilspycmd -t ModelProto` on the real DLL to get the derivation. Expect something like a sibling
  "-collider" prefab. Separate collider prefabs probably exist only for some models; otherwise the
  prefab is its own collider prefab.

### 2.5 Localization (replaces StringProto) [V]

- `Localization` is a static class [V-ref]:
  - constants `LCID_ENUS = 1033` and `LCID_ZHCN = 2052`
  - `Dictionary<string,int> namesIndexer`, `string[][] strings`, `string[] resourcePages`
  - methods `Translate(this string)`, `Load(string path)`, `LoadLanguage(int)`
- Files live under `<game root>/Locale/` [V]:
  - `Locale/Header.txt` holds the language list (`lcid,name,abbr,abbr2,fallback` lines after
    `Version=`) and the page order (`PageName=N`).
  - `Locale/Names/<page>.txt` holds the key lists.
  - `Locale/<LCID>/<page>.txt` holds the translations. Each line is `key\t?\t?\ttranslation`
    (4 tab-separated cells; cell 0 = key, cell 3 = text). Escapes are `\n \t \r \\`.
  - Encoding is **UTF-16 LE** with BOM in practice. Detect the BOM and fall back to UTF-8.

  Sources: soarqin `generate_text.py` (`parse_header`, `load_language_strings`) and
  https://github.com/huww98/dsp_blueprint_editor/blob/HEAD/src/data/i18n.py
- Key conventions [V from dumps]:
  - item name = `ItemProto.Name` (`铁块`)
  - item description = `I<name>`
  - tech name = `TechProto.Name`, which already starts with `T`
  - recipe name = `RecipeProto.Name`

  A missing key translates to itself.
- `LDB.ItemName(int)` and `LDB.RecipeName(int)` exist [V-ref].

### 2.6 PrefabDesc and how it is built (geometry)

Source: full decompiled `PrefabDesc.cs` from a very recent build (it already has the vehicle `VD*`
parts):
https://github.com/unieagle/dsp-mod-BattlefieldAnalysisBaseDeliver/blob/HEAD/GameCodeReference/PrefabDesc.cs
[V]

#### Constructors [V]

- `PrefabDesc(int modelIndex, GameObject prefab)` calls `ReadPrefab(prefab, prefab)`.
- `PrefabDesc(int modelIndex, GameObject prefab, GameObject colliderPrefab)` sets
  `independentCollider = true` and calls `ReadPrefab(prefab, colliderPrefab)`.

#### `ReadPrefab` algorithm [V]

Every `GetComponentInChildren<T>(true)` call includes inactive objects and searches the root first,
then the children depth-first. The first match wins.

1. **subId.** Taken from the `ItemProto` whose `[ModelIndex, ModelIndex+max(1,ModelCount))` range
   contains `modelIndex`.
2. **Colliders.**
   - `colliders = colliderPrefab.GetComponentsInChildren<Collider>(true)`, each converted with
     `ColliderData.InitFromCollider(collider, independentCollider)`.
   - `ColliderData` is `{int idType; Vector3 pos; Vector3 ext; float radius; Quaternion q; int link}`.
     `idType` packs `objId`, `shape` (EColliderShape: Sphere 1, Capsule 2, Box 3) and `usage`
     (EColliderUsage: Physics 0, Build 1, Through 2, Belt 3) [V-ref].
   - **Open item:** the `InitFromCollider` body was not found publicly. Decompile
     `ColliderData` to learn how `usage` is decided (GameObject layer vs `isTrigger` vs name) and
     whether `pos` and `ext` are in prefab-root space (expected: world-space center and half-extents
     relative to the prefab root, with `q` the world rotation) [I].
   - `buildCollider` is the **last** collider with `usage==Build && shape==Box`. `hasBuildCollider`
     is set if any exist.
   - Let `n` be the number of Build+Box colliders. `buildColliders` takes the first `n` of them
     when `n <= 2`. When `n > 2`, it takes the first `n-1`, and the code also shrinks the *last*
     one's `ext` to (0.1, 0.1, 0.1).
   - `roughRadius`, `roughHeight` and `roughWidth` start at 0.7 / 0.7 / 1.4. They grow over the
     non-Build colliders and over the `buildCollider` extents, then each is multiplied by 1.03 and
     0.2 is added. `colliderComplexity` is 0, 1 (a single sphere), or max(2, n).
3. **LOD meshes.** From `LODModelDesc` (`lodMeshDatas`, `lodDistances`, `lodVertaPaths`, plus
   `Verta/*.verta` files). These are rendering-only and can be ignored.
4. **`BuildConditionConfig`** on the prefab:
   - copied directly: `landPoints`, `landOffset`, `allowBuildInWater`, `needBuildInWaterTech`,
     `waterPoints`, `waterTypes`, `multiLevel`, `lapJoint` (vertical stacking offset),
     `multiLevelAlternativeIds` and `multiLevelAlternativeYawTransposes`, `addonType`,
     `veinMiner`, `oilMiner`, `dragBuild`, `dragBuildByGrid`, `dragBuildByRect`,
     `shiftSnapGridInterval`
   - renamed: `multiLevelAllowPortsOrSlots` comes from `multiLevelAllowInserter`
   - **`blueprintBoxSize = (buildCollider.ext.x*2, buildCollider.ext.z*2)`**, unless
     `blueprintBoxSizeOverride.x` or `.y` is at least 0.25
   - `dragBuildDist` defaults the same way, with `dragBuildDistOverride`
   - `dragBuild` is forced false for belts and inserters
   - if the component is absent, `landPoints`, `waterPoints` and `waterTypes` are empty
5. **`SlotConfig`** on the prefab. **Name swap:**
   - `portPoses[i] = Pose(SlotConfig.slotPoses[i].position, .rotation)`. These are the belt
     connection ports.
   - `slotPoses[i] = Pose(SlotConfig.insertPoses[i].position, .rotation)`. These are the sorter
     attachment slots.
   - `addonAreaPoses`, `addonAreaColPoses` and `addonAreaSize` come from `addonAreaCol`
     (Transforms) and `addonAreaCenter`. Size = `localScale * 0.5`.
   - Also copied: `selectCenter`, `selectSize`, `selectAlpha`, `selectDistance`, `signHeight`,
     `signSize`, `overrideBarWidth` and `overrideBarHeight`.
   - `SlotConfig.slotPoses` and `insertPoses` are `Transform[]` (PPtrs into the prefab hierarchy).
     `.position` and `.rotation` are **world** values of the uninstantiated prefab. Compose
     `localPosition`, `localRotation` and `localScale` up the parent chain, including the root
     Transform (normally identity).
   - Consumer example [V]: `BuildTool_Click` places a sorter end at
     `objPose.position + objPose.rotation * slotPoses[i].position`, facing
     `objPose.rotation * slotPoses[i].rotation * (0,0,-1)`. Source:
     https://github.com/GoToNightmare/DSP-PlanetwideMining/blob/HEAD/PlanetwideMining/PlanetwideMining/DecompiledData.txt
6. **Functional descriptors.** Each is a MonoBehaviour on the prefab. Fields are [V-ref] and the
   mapping is [V]:

| Component (fields) | PrefabDesc fields set |
|---|---|
| `BeltDesc {int beltPrototype; int speed}` | `beltPrototype`, `beltSpeed = speed`, `isBelt = speed>0` |
| `SplitterDesc {}` | `isSplitter` (only if no BeltDesc) |
| `MonitorDesc {...}` | `isMonitor`, `monitor*` |
| `SpeakerDesc` | `isSpeaker`, `speaker*` |
| `SpraycoaterDesc {int incCapacity; int[] incItemId}` | `incCapacity`, `incItemId`, `isSpraycoster` (sic) |
| `PilerDesc {}` | `isPiler` |
| `StorageDesc {int colCount; int rowCount}` | `storageCol`, `storageRow`, `isStorage = col*row>0` |
| `TankDesc {int fluidStorageCount}` | `isTank`, `fluidStorageCount` |
| `MinerDesc {EMinerType minerType; float periodf}` | `minerType`, `minerPeriod = round(periodf*600000)` |
| `InserterDesc {int grade; float sttf; float delayf; bool canStack; int stackSize}` | `inserterGrade`, **`inserterSTT = round(sttf*600000)`**, `inserterDelay = round(delayf*600000)`, `inserterCanStack`, `inserterStackSize`, `isInserter = STT>0` |
| `AssemblerDesc {ERecipeType recipeType; float speedf}` | **`assemblerSpeed = round(speedf*10000)`** (10000 = 1.0x), `assemblerRecipeType`, `isAssembler = recipeType>None` |
| `FractionatorDesc {recipeType, fluidInputMax, productOutputMax, fluidOutputMax}` | `isFractionator`, `frac*`, `assemblerRecipeType` |
| `LabDesc {float assembleSpeed; float researchSpeed}` | `isLab`, `labAssembleSpeed = round(assembleSpeed*10000)`, `labResearchSpeed` |
| `StationDesc {bool isStellar; int maxItemCount; int maxItemKinds; int maxDroneCount; int maxShipCount; long maxEnergyAcc; Vector3 dronePoint; Vector3 shipPoint; bool isCollector; int collectSpeed; bool isVeinCollector}` | `isStation`, `isStellarStation`, `stationMaxItemCount`, **`stationMaxItemKinds`**, `stationMaxDroneCount`, `stationMaxShipCount`, `stationMaxEnergyAcc`, `stationDronePos`, `stationShipPos`, `isCollectStation`, `stationCollectSpeed`, `isVeinCollector` |
| `DispenserDesc` | `isDispenser`, `dispenserMaxCourierCount`, `dispenserMaxEnergyAcc` |
| `EjectorDesc`, `SiloDesc` | `isEjector`, `ejector*`, `isSilo`, `silo*` |
| `PowerDesc` (see below) | `isPowerNode = node`, **`powerConnectDistance`**, **`powerCoverRadius`**, `powerPoint`, `isPowerGen = generator`, `photovoltaic`, `windForcedPower = wind`, `gammaRayReceiver = gamma`, `geothermal`, `genEnergyPerTick`, `useFuelPerTick`, `fuelMask`, `powerCatalystId`, `powerProductId`, `powerProductHeat`, `isAccumulator`, `inputEnergyPerTick`, `outputEnergyPerTick`, `maxAcuEnergy`, `isPowerConsumer = consumer`, `isPowerCharger = charger`, **`workEnergyPerTick`**, **`idleEnergyPerTick`**, `isPowerExchanger`, `exchangeEnergyPerTick`, `emptyId`, `fullId`, `maxExcEnergy` (= `HeatValue` of the `fullId` item) |
| `MinimapConfig`, `AudioDesc`, `AnimDesc` | minimap, audio, animation (ignore) |
| `TurretDesc`, `BeaconDesc`, `FieldGeneratorDesc`, `BattleBaseDesc`, `ConstructionModuleDesc`, `CombatModuleDesc`, `EnemyDesc`/`DF*Desc`, `UnitDesc`, `FleetDesc`, `CreationPartDesc`/`VD*`/`VW*` | combat, Dark Fog, vehicles (probably out of scope) |

`PowerDesc` fields [V-ref], in order:

```text
node, connectDistance, coverRadius, powerPoint,
generator, photovoltaic, wind, gamma, geothermal,
genEnergyPerTick, useFuelPerTick, fuelMask, catalystId, catalystMask, productId, productHeat,
accumulator, inputEnergyPerTick, outputEnergyPerTick, maxAcuEnergy,
exchanger, exchangeEnergyPerTick, emptyId, fullId,
consumer, charger, workEnergyPerTick, idleEnergyPerTick
```

The full list of the roughly 300 PrefabDesc fields is in the cited `PrefabDesc.cs`. Fields not set in
`ReadPrefab` (for example `stationCollectIds`, `isRuin` and `wreckage*`) are filled elsewhere [I]:
check `ModelProto.Preload` and `ItemProto.Preload`.

#### Units [V for the scale factors in code; I for the physical interpretation]

- Game logic runs at 60 ticks per second.
- `*EnergyPerTick` values are in J per tick, so watts = value × 60.
- `TimeSpend` is in ticks.
- `assemblerSpeed`: 10000 = 1×.
- `inserterSTT`: sttf × 600000. This is a fixed-point time per round trip. The meaning of the
  constant is to be confirmed in `InserterComponent`.
- `beltSpeed` is the integer from `BeltDesc.speed`. Items per second is believed to be
  `speed × 6` for vanilla (1, 2, 5 gives 6, 12, 30/s) [I]. Confirm in `CargoPath`
  (`kMaxCargoFlowSpeedPerSecond = 120`, `kCargoLength = 10`) [V-ref].

#### Static-extraction plan for geometry

1. Read `globalgamemanagers` → `ResourceManager` (class 147).
   `m_Container: List[(path, PPtr<Object>)]` maps Resources paths, which Unity stores lowercased
   [I], to objects.
2. For each `ModelProto`, look up `PrefabPath.lower()` to get the root `GameObject`, then do the
   same for the collider prefab path once the derivation is known.
3. Walk the hierarchy: `GameObject.m_Component[*].component` and `Transform.m_Children` /
   `m_Father`. Gather components in Unity's `GetComponentsInChildren` order (pre-order depth-first,
   each GameObject's components in `m_Component` order).
4. For `MonoBehaviour` components, resolve `m_Script` to `MonoScript.m_ClassName`, then read the
   type tree with the generator. Resolve the Transform PPtrs in `SlotConfig`.
5. For Collider components (`BoxCollider` / `SphereCollider` / `CapsuleCollider`):
   - `m_Center` and `m_Size`, or `m_Radius`, `m_Height` and `m_Direction`
   - `m_IsTrigger`
   - the owning GameObject's `m_Layer`, `m_Name` and `m_IsActive`

   Then reproduce `InitFromCollider` (after decompiling it).
6. Re-implement steps 2 to 6 of `ReadPrefab` above.
7. Validate against known values, for example huww98's `SlotConfig.selectSize` table: assembler
   `box [4.2, 4.6, 4.2]`, ILS `[8.0, 34.0, 8.0]`, belt `[0.64, 0.12, 0.64]`.
   https://github.com/huww98/dsp_blueprint_editor/blob/HEAD/src/data/building.ts

**Fallback** if prefab parsing turns out painful: a tiny BepInEx dumper that serializes
`LDB.models.dataArray[i].prefabDesc` at runtime. DSP Planner Export already exports
`blueprintBoxSize`, `lapJoint.y` and the `slotPoses` count this way:
https://thunderstore.io/c/dyson-sphere-program/p/Suite/DSP_Planner_Export/

---

## 3. Tech unlock semantics

Applied by `GameHistoryData.UnlockTechFunction(int func, double value, int level)` [V-ref].

- Body stripped in the reference DLL. The mapping below comes from soarqin's inverse implementation,
  which mirrors the native switch:
  https://github.com/soarqin/DSP_Mods/blob/master/CheatEnabler/Patches/Tech/TechFuncRevert.cs [V]
- The "techs" column comes from the 0.10.34 `TechProtoSet` dump [V].
- Most functions are **additive per level**. Assignment-type functions are marked.
- Values convert to int as `(int)(v + 0.5)`.

| func | GameHistoryData / Mecha field | Kind | Vanilla techs (values) |
|---|---|---|---|
| 1 | mecha construction drone count | + | 2401 to 2407 |
| 2 | mecha.reactorPowerGen | + | 2501 to 2506 |
| 3 | mecha.walkSpeed | + | 2201 and up |
| 4 | mecha.thrusterLevel | assign | 2901, 2902, 2904 |
| 5 | player inventory rows | + | 2301 to 2306 |
| 6 | mecha.coreEnergyCap (+), coreLevel = tech level | + / assign | 2101 to 2106 |
| 7 | mecha.replicateSpeed | + | 1202, 1203 (0.5) |
| 8 | useIonLayer | flag | 1505 |
| 9 | constructionDroneMovement | + | 2403, 2406 |
| 10 | constructionDroneSpeed | + | 2601 to 2606 |
| 11 | mecha.maxSailSpeed | + | 2903 |
| 12 | solarSailLife | + | 3101 and up |
| 13 | solarEnergyLossRate | × | 3201 and up (0.9) |
| 14 | inserterStackCountObsolete | assign | 3301 to 3305 (**IsObsolete**) |
| 15 / 16 | logisticDroneSpeedScale / logisticShipSpeedScale | + | 3401 and up |
| 17 | logisticShipWarpDrive | flag | 3404 |
| **18 / 19** | **logisticDroneCarries / logisticShipCarries** | + | 3501 to 3508 |
| 20 | miningCostRate | × (clamped to 0 below `TechProto.MINING_COST_CRITICAL_POINT`) | 3601 and up (0.94) |
| 21 | miningSpeedScale | + | 3601 and up (0.1) |
| 22 | techSpeed | + | 3901 and up |
| 23 | universeObserveLevel | assign | 4101 to 4104 |
| **24 / 25** | **storageLevel (base 2) / labLevel (base 3)**: max vertical stack height of storage and labs ("Vertical Construction") | + | 3701 to 3706 (24: +1, 25: +2 per level) |
| 26 | dysonNodeLatitude | + | 1523 |
| 27 | mecha.maxWarpSpeed (value × 40000) | + | 2905, 2906 |
| 28 | blueprintLimit | assign | 2701 to 2705 |
| **29** | **stationPilerLevel** (base 1): station output stacking ("Logistics station integrated logistics") | + | 3801 to 3803 |
| **30 / 31** | **localStationExtraStorage / remoteStationExtraStorage** (station item capacity bonus) | + | 3509, 3510 (1000 / 2000) |
| 32 | deliveryPackage.colCount (logistics bot slots) | + | 1608, 2304, 2307 |
| 33 | deliveryPackage.stackSizeMultiplier | + | 2303 to 2306 |
| 34 / 35 | logisticCourierSpeedScale / logisticCourierCarries | + | 3401 and up / 3501 and up |
| 36 | dispenserDeliveryMaxAngle | + | 4001 to 4005 |
| 37 | feature key: registers `1600000 + value` (matches `ItemProto.UnlockKey`-style keys) | key | 1411 (2203, 2401) |
| 38 | player inventory columns (base 10) | + | 2307 |
| **39** | **inserterStackOutput** (base 1): pile-sorter output stack onto belt | assign (max) | 3306 (obsolete), 3311, 3313, 3315 (2, 3, 4) |
| **40** | **inserterBidirectional** | flag | 3306, 3316 |
| **41** | **inserterStackInput** (base 2) | assign (max) | 3312, 3314 (3, 4) |
| **42** | **beltVerticalConstruction** | flag | 1711 |
| 43 | dysonNodeAbsorbInterval (base 360; smaller is better) | assign (min) | 4201 to 4206 |
| 44 | bpReformLimit | assign | 2701 to 2706 |
| 45 | manualPlantVegetation | flag | (none in the dump) |
| 61 to 64 | kinetic / energy / blast / magnetic damage scale | + | 5001+, 5101+, 5201+, 6101+ |
| 65 / 66 | mecha energy shield radius / capacity | + | 2801 and up |
| 67 to 73 | combat drone / ship damage, ROF, durability, speed ratios | + | 5301+, 5401+, 5601+ |
| 74 | planetaryATFieldEnergyRate (base / (1 + Σ)) | ratio | 5701 to 5705 |
| 75 / 86 | energyShieldUnlocked / energyShieldBurstUnlocked | flag | 2801 / 2803 |
| 76 | autoReconstructSpeed | assign (max) | 2951 to 2956 |
| 77 to 80 | ground and space fleet counts / port counts | + | 1819, 1822, 5801+, 5901+ |
| 81 | mecha.hpMaxUpgrade | + | 2101 and up |
| 82 / 83 | mecha laser range / damage | (recomputed) | 2101 and up |
| 84 | globalHpEnhancement | + | 6001 and up |
| 85 | enemyDropScale | + | 3601 and up |
| 99 | missionAccomplished | flag | 1508 |

The [V-ref] base values in `GameHistoryData.SetForNewGame` are:
- `inserterStackInput` = 2
- `inserterStackOutput` = 1
- `storageLevel` = 2
- `labLevel` = 3
- `stationPilerLevel` = 1

For the exact runtime meaning of 39 to 42 (how sorters and pile sorters consume `inserterStackInput`
and `inserterStackOutput`), decompile `GameHistoryData` (`UnlockTechFunction`) and
`InserterComponent.InternalUpdate`.

---

## 4. Methods in Assembly-CSharp worth decompiling

All types are in the **global namespace** (no namespaces) [V-ref], so `ilspycmd -t TypeName` works
directly. Signatures are from the 0.10.35 reference DLL [V-ref].

### Prototypes and geometry

- `PrefabDesc`: `ReadPrefab(GameObject, GameObject)` (private)
- `ColliderData` (struct): `InitFromCollider(Collider collider, bool independent)`, plus the
  getters `shape`, `usage`, `objType`, `objId`, `isForBuild`
- `ModelProto`: `Preload()`, getters `ColliderPath`, `_ruinPath` and `_wreckagePath`,
  `InitModelIndices()`
- `ItemProto`: `Preload(int)`, `FindRecipes()`, `ComputeRawMats()`
- `RecipeProto`: `Preload(int)`
- `TechProto`: `Preload()`, `Preload2()`, `GetHashNeeded(int levelRequest)`, `UnlockFunctionText(StringBuilder)`
- `LDB` (static getters), `Localization`: `Load(string)`, `Translate`, `LoadLanguage`
- `GameHistoryData`: `UnlockTechFunction(int func, double value, int level)`, `SetForNewGame()`

### Blueprints

See also `docs/research/blueprint-format.md`.

- `BlueprintData`: `ToBase64String()`, `FromBase64String(string)`, `HeaderFromBase64String`,
  `ContentFromBase64String`, `CheckSignature`, `Export(BinaryWriter)`, `Import(BinaryReader)`,
  `CreateNew(string)`, plus the `headerStr` getter
- `BlueprintBuilding`: `Export` / `Import`
- `BlueprintArea`: `Export` / `Import`
- `MD5F`: `Compute(string)`, `Compute(byte[])`. This is a modified MD5 (changed init words B and D
  and a few K constants). There is a JS port at
  https://github.com/huww98/dsp_blueprint_editor/blob/HEAD/src/blueprint/md5.ts. Also note
  `MD5FC`.
- `BlueprintUtils`, `BuildingParameters` (`ApplyPrebuildParametersToEntity`, `SimpleParamFromParamsArray`)

### Build conditions

- `BuildTool_Click.CheckBuildConditions()`, `BuildTool_Path.CheckBuildConditions()`,
  `BuildTool_Inserter.CheckBuildConditions()`, `BuildTool_Addon.CheckBuildConditions()`
- `BuildTool_BlueprintPaste.CheckBuildConditions()` and `CheckBuildConditionsPrestage()`
- `BuildTool` (base): `GetBeltInputBeltPose`, `GetInserterT1T2`, ...
- `BuildTool_Path`: `CheckBeltAddonAreaCondition`
- `BuildPreview.GetConditionText(EBuildCondition)`

Known detail [V, older decompile]:
- The build-collider overlap test uses `Physics.OverlapBoxNonAlloc(pos, ext, ..., q, mask 428032, Collide)`.
  The mask is 425984 for vein and oil miners.
- Inserter colliders are stretched to the pick and insert distance (±0.35 when connected to belts).

### Belts

- `CargoPath`: `Update()`, `TryInsertItem`, `TryPickItem`, `TryInsertItemAtHead`,
  `TryInsertItemWithStackIncreasement`
- `CargoPath` constants: `kCargoLength = 10`, `kMaxCargoFlowSpeedPerSecond = 120`
- `CargoTraffic`: `CargoPathsGameTickSync()`, `SplitterGameTick(long)`, `UpdateSplitter(ref SplitterComponent)`,
  `MonitorGameTick()`, `SpraycoaterGameTick()`, `PilerGameTick()`, `AlterBeltConnections(...)`
- Component structs: `BeltComponent`, `SplitterComponent`, `PilerComponent.InternalUpdate(CargoTraffic, AnimData[])`

### Sorters

- `InserterComponent` (struct):
  - `InternalUpdate(PlanetFactory, int[][] needsPool, AnimData[], float power)`
  - `InternalUpdate_Bidirectional(PlanetFactory, int[][], AnimData[], float power, bool isActive)`
  - `InternalUpdateNoAnim(...)`
- `FactorySystem.GameTickInserters(long, bool)`

### Production

- `AssemblerComponent`: `uint InternalUpdate(float power, int[] productRegister, int[] consumeRegister)`
  and `UpdateNeeds()`
- `LabComponent`: `InternalUpdateAssemble(...)` and `InternalUpdateResearch(...)`
- `MinerComponent.InternalUpdate(...)`
- `FractionatorComponent.InternalUpdate(...)`
- `FactorySystem.GameTick(long, bool)`

### Spray coater

- `SpraycoaterComponent.InternalUpdate(CargoTraffic, AnimData[], int[] consumeRegister)`
- Driven by `CargoTraffic.SpraycoaterGameTick()`

### Power

- `PowerSystem.GameTick(long time, bool isActive, bool multithreaded, int threadOrdinal)`
- `PowerSystem`: `NewNodeComponent(int, float conn, float cover)`, `NewConsumerComponent(int, long work, long idle)`
- `PowerNetwork`, `PowerGeneratorComponent`, `PowerConsumerComponent`, `PowerNodeComponent`,
  `PowerAccumulatorComponent`, `PowerExchangerComponent`

### Stations

- `StationComponent`:
  - `InternalTickLocal(PlanetFactory, int timeGene, float power, float droneSpeed, int droneCarries, StationComponent[])`
  - `InternalTickRemote(...)`
  - `UpdateInputSlots(...)` and `UpdateOutputSlots(CargoTraffic, SignData[], int maxPilerCount, bool)`
  - `UpdateNeeds()`, `CalcTripEnergyCost`

### Frame order

`GameLogic` sets the per-frame order. Its methods include `FactoryPowerSystemGameTick`,
`FactorySystemFacilityGameTick`, `FactorySystemInserterGameTick`, `FactoryCargoPathGameTick`,
`FactorySplitterGameTick`, `FactoryCargoTrafficMiscGameTick`, `FactoryStationInput` and
`FactoryTransportOutput` [V-ref].

### Connections

`PlanetFactory`: `ApplyInsertTarget`, `ApplyPickTarget`, `ApplyEntityInput`, `ApplyEntityOutput`,
`ReadObjectConn`, `WriteObjectConn`, `CreateEntityLogicComponents(int, PrefabDesc, int)`.

---

## 5. UnityPy recipe (sketch, untested against a real install)

```python
# pip install "UnityPy>=1.20" "TypeTreeGeneratorAPI>=0.0.10"
from pathlib import Path
import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

GAME = Path.home() / ".local/share/Steam/steamapps/common/Dyson Sphere Program"
# Flatpak Steam: ~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/...
# Other libraries: parse steamapps/libraryfolders.vdf for app 1366540
DATA = GAME / "DSPGAME_Data"

files = ["globalgamemanagers", "globalgamemanagers.assets", "resources.assets",
         *sorted(p.name for p in DATA.glob("sharedassets*.assets"))]
# path= lets PPtr.deref lazily load externals via env.find_file
env = UnityPy.Environment(*[str(DATA / f) for f in files], path=str(DATA))

unity_version = env.files["resources.assets"].unity_version      # e.g. "2022.3.62f3c1"
gen = TypeTreeGenerator(unity_version)
gen.load_local_game(str(GAME))        # Mono: loads every DSPGAME_Data/Managed/*.dll
env.typetree_generator = gen          # obj.read_typetree() then auto-generates MonoBehaviour trees

# 1) script-class lookup: MonoScripts live in globalgamemanagers.assets
def script_class(mb_obj):
    head = mb_obj.parse_monobehaviour_head()          # reads only m_GameObject/m_Enabled/m_Script/m_Name
    return head.m_Script.deref_parse_as_object().m_ClassName

# 2) proto sets
protos = {}
for obj in env.files["resources.assets"].objects.values():
    if obj.type.name != "MonoBehaviour":
        continue
    try:
        cls = script_class(obj)
    except Exception:
        continue
    if cls.endswith("ProtoSet"):
        tree = obj.read_typetree()    # dict: m_Name, TableName, Signature, dataArray[...]
        protos[cls] = tree

items  = {p["ID"]: p for p in protos["ItemProtoSet"]["dataArray"]}
models = {p["ID"]: p for p in protos["ModelProtoSet"]["dataArray"]}

# 3) Resources path -> object  (ResourceManager, class id 147, in globalgamemanagers)
res = next(o for o in env.files["globalgamemanagers"].objects.values()
           if o.type.name == "ResourceManager").read()
container = {path: pptr for path, pptr in res.m_Container}      # paths are lowercase
prefab_go = container["entities/prefabs/assembler-mk-1"].deref_parse_as_object()   # GameObject

# 4) hierarchy walk in Unity GetComponentsInChildren order
def components(go):
    for pair in go.m_Component:
        pptr = pair.component if hasattr(pair, "component") else pair[1]
        yield pptr.deref()                                # ObjectReader
def transform_of(go):
    return next(c for c in components(go) if c.type.name == "Transform").read()
def walk(go):
    yield go
    for child_t in transform_of(go).m_Children:
        yield from walk(child_t.deref_parse_as_object().m_GameObject.deref_parse_as_object())

def find_desc(root, class_name):          # == GetComponentInChildren<T>(true)
    for go in walk(root):
        for c in components(go):
            if c.type.name == "MonoBehaviour" and script_class(c) == class_name:
                return c.read_typetree()
    return None

slot_cfg = find_desc(prefab_go, "SlotConfig")
# slot_cfg["slotPoses"] / ["insertPoses"] are PPtr dicts {m_FileID, m_PathID} -> resolve to Transform,
# then compose world pose by walking m_Father up to the root (TRS: p = parent.p + parent.q*(parent.s*local.p)).
```

### Pitfalls and notes

- **Generator source DLL** [V, tested]. Use the game's own `Managed` folder. The BepInEx
  `DysonSphereProgram.GameLibs` assemblies are publicized, which adds private fields
  (`ModelProto._colliderPath`, `prewarmed`, `_iconSprite`; `ItemProto._propertyIconSprite`, ...)
  to the generated tree. That misaligns the read. The generator also needs `netstandard.dll` and
  `mscorlib`, which the game's `Managed` folder already contains.
- **Silent fallback.** When generation fails, UnityPy's `_get_typetree_node` silently falls back
  to the bare MonoBehaviour node (`except ValueError: pass`). Assert that the expected keys exist,
  and use `check_read=True` (the default) so a short read raises.
- **Version-specific trees.** Type trees are version-specific. `ItemProto` gained `IconTag`,
  `CatalystType`, `BombType` and the `EnemyDrop*` fields across versions (compare the 2024
  LokiSharp reader). Don't hand-code layouts; always generate. Key caches on `ProtoSet.Signature`
  plus the `Assembly-CSharp.dll` hash.
- **No obfuscation.** Decompiled code in public repos has full original names. BepInEx mods patch
  by method name, and Harmony targets like `BuildTool_Click.CheckBuildConditions` resolve [V].
- **Locale encoding.** Locale files are UTF-16 (LE, BOM) [V]. Keys are Chinese, so build the
  `key → English` map once from `Locale/1033`.
- **Icons.** Item and tech icons are `Texture2D` objects in `resources.assets` or
  `sharedassets0.assets`, named by the last segment of `IconPath`. Prefer the 80×80 version [V]
  (soarqin `generate_icons.py`).
- **Proton.** The install is the Windows build: `DSPGAME.exe`, `DSPGAME_Data/`,
  `MonoBleedingEdge/`. That's fine for UnityPy. `load_local_game` takes the Mono path because
  there is no `GameAssembly.dll`.
- **Memory.** `resources.assets` is large. Read objects lazily (iterate `objects.values()` and
  check `obj.type` before `read`). Don't call `UnityPy.load(DATA)` on the whole folder unless
  needed.

### Prior art to crib from

- soarqin `generate_text.py` / `generate_icons.py`: working UnityPy + TypeTreeGenerator code
  against current DSP [V].
- DSPSeedCalc `Prototypes/*.json`: complete AssetStudio JSON of every ProtoSet at 0.10.34, useful
  as test fixtures and for diffing your output [V].
  https://github.com/soarqin/DSPSeedCalc/tree/HEAD/Prototypes
- huww98 `dsp_blueprint_editor` `src/data/gen_*.py`: AssetStudio JSON to TypeScript, `i18n.py`
  locale parsing, and hand-entered SlotConfig select boxes [V].
- `GameCodeReference/*.cs` in unieagle's repos: full dnSpy exports of `PrefabDesc`,
  `CargoTraffic`, `StationComponent`, `PlanetFactory`, ... (recent build) [V].

---

## 6. ilspycmd

- Install: `dotnet tool install -g ilspycmd`. The current 10.x and 11.x packages target
  **.NET 10** (`tools/net10.0` in the nupkg) [V], so a .NET 10 runtime or SDK is required.
  - On Nobara/Fedora: `sudo dnf install dotnet-sdk-10.0` if the package exists in the repos [I].
  - Otherwise use Microsoft's `dotnet-install.sh --channel 10.0`, then
    `export PATH="$PATH:$HOME/.dotnet:$HOME/.dotnet/tools"`.
  - Pinning an older tool (`--version 9.1.0.7988`, net8) is an option if only .NET 8 is
    available [I].
- Decompile one type to stdout or a file [V, ran it]:

  ```bash
  M="$GAME/DSPGAME_Data/Managed"
  ilspycmd -r "$M" -t PrefabDesc "$M/Assembly-CSharp.dll" > PrefabDesc.cs
  ilspycmd -r "$M" -t ColliderData "$M/Assembly-CSharp.dll" > ColliderData.cs
  ilspycmd -r "$M" -t 'ProtoSet`1' "$M/Assembly-CSharp.dll"   # generic: backtick arity
  ilspycmd -l c "$M/Assembly-CSharp.dll"                       # list classes (also s, e, i, d)
  ilspycmd -r "$M" -p -o out/ "$M/Assembly-CSharp.dll"         # whole project (slow, ~2300 classes)
  ```

  - `-t` takes the full type name. DSP types have no namespace, so you use the bare name. Nested
    types use `Outer+Inner` [I].
  - ilspycmd can't target a single method. Decompile the type, then cut out the method with a
    brace-matching script or `grep -n`.
  - Add `--disable-updatecheck` in scripts.
  - Files extracted from a nupkg may come out with mode `0000`. Run `chmod u+r` first
    (`UnauthorizedAccessException` otherwise) [V].
- Recommended first decompile batch:
  - `PrefabDesc`, `ColliderData`, `ModelProto`, `ItemProto`, `TechProto`, `GameHistoryData`
  - `InserterComponent`, `CargoPath`, `CargoTraffic`, `AssemblerComponent`, `SpraycoaterComponent`
  - `PowerSystem`, `StationComponent`, `BuildTool_Click`, `BuildTool_Path`, `BlueprintData`, `MD5F`

---

## 7. Open gaps (confirm on the real install)

1. The `ColliderData.InitFromCollider` body: how `usage` (Build/Physics/...) is chosen, and which
   space `pos`, `ext` and `q` use. This is the key to building footprints.
2. The derivation of `ModelProto.ColliderPath` (and ruin/wreckage paths), and which models have
   separate collider prefabs.
3. Whether `ModelProto.Preload` or `ItemProto.Preload` post-patch any PrefabDesc fields after
   `ReadPrefab` (for example `stationCollectIds`).
4. The exact belt items/s per `beltSpeed` unit and the sorter timing formula
   (`InserterComponent.InternalUpdate`).
5. The exact sorter-side meaning of `inserterStackInput` and `inserterStackOutput`.
6. Whether every Resources prefab lives in `resources.assets`, or whether some dependencies resolve
   into `sharedassets*.assets` (the sketch loads both to be safe).
