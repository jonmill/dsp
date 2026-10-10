# DSP game mechanics for the simulator and layout solver (0.10.x, Dark Fog era)

Researched 2026-10-10. This is a working reference, not ground truth. Correct it against decompiled
`Assembly-CSharp.dll` once we have game files (see §10 "Gaps").

## 0. How to read this

### Confidence tags

| Tag | Meaning |
|---|---|
| **[C1]** | Code-level. It comes from (a) a raw dump of the game's prototype tables, (b) a mod that re-implements the vanilla tick loop line for line and is kept current, or (c) another project's notes from reading the current DLL. Formulas and constants are near-certain. Small details such as update order and off-by-one behaviour still need a check. |
| **[C2]** | Wiki or other documentation, and consistent with C1 wherever both cover it. |
| **[C3]** | Folklore, a single community source, or my own inference. Treat it as a hypothesis. |

### Source keys

| Key | Source | What it gives |
|---|---|---|
| **PD** | `docs/research/datasets/dsp-parser/items.json`, `recipes.json`: a raw dump of `ItemProtoSet`/`RecipeProtoSet` from game **0.10.29.22015** | Prefab descriptors: `_AssemblerDesc.speed`, `_InserterDesc.stt`, `_BeltDesc.speed`, `_PowerDesc` (J/tick), `connectDistance`/`coverRadius`, `_SlotConfig` (slot counts, select boxes), `_BuildConditionConfig` (land points, multiLevel, lapJoint, dragBuildDistOverride), `_StationDesc`, `_FractionatorDesc`, `_SpraycoaterDesc`, item `ability`/`hpMax`, recipe `nonProductive` |
| **WV** | [TheAIBot/DSP_Weaver](https://github.com/TheAIBot/DSP_Weaver) (last commit 2026-10-10). A performance mod that replaces the vanilla planet tick with re-implementations of `AssemblerComponent`, `InserterComponent`, `CargoPath`, `SpraycoaterComponent`, `StationComponent` belt I/O, `FractionatorComponent`, `LabComponent` and `PowerSystem`. The code keeps the decompiled variable names (`num2`, `split_inc_level`, …) and must reproduce vanilla results. | Tick-level algorithms (the closest thing to decompiled source available) |
| **SW** | [AvaloNero/Spherewright](https://github.com/AvaloNero/Spherewright) `docs/research/game-api-foundry.md`, `game-api-m0.md`: notes from ILSpy reading of the 0.10.34.28529 DLL | Sorter placement checks, belt height snap, `stt` construction, station charge slider |
| **AD** | [yeliex/AutomaticDSP](https://github.com/yeliex/AutomaticDSP) `skills/automatic-dsp/references/**` (Chinese): an agent that plays the live game through a mod | Measured spacing (`dragBuildDist`), slot-angle limits, proliferator table |
| **HE** | [huww98/dsp_blueprint_editor](https://github.com/huww98/dsp_blueprint_editor) `src/blueprint/planet.ts`, `src/data/building.ts` | Planet latitude-band table, `HEIGHT_GRID_SIZE = 4/3`, select boxes, station port layout |
| **BF** | Sibling doc `docs/research/blueprint-format.md` | Blueprint coordinate conventions (tested against real strings) |
| **W** | dsp-wiki.com raw wikitext, fetched 2026-10-10: Sorters, Pile Sorter, Conveyor Belt Mk.I/III, Spray Coater, Proliferator*, Planetary/Interstellar Logistics Station, Logistics Stations, Automatic Piler, Splitter, Fractionator, Power Grid, Upgrades, Vertical Construction, Blueprint, `*/ItemInfo` subpages. dsp.wiki.gg returned HTTP 401/403 to automated fetches and could not be used. | Display values, tech progressions, player-facing rules |
| **GP** | [gamepretty: Production Chain Layouts](https://gamepretty.com/dyson-sphere-program-production-chain-layouts/) | Footprint and spacing folklore |
| **ST** | Steam threads [3195867416980642228](https://steamcommunity.com/app/1366540/discussions/0/3195867416980642228) and [3108016336236964508](https://steamcommunity.com/app/1366540/discussions/0/3108016336236964508) | Belt ramp lengths, sky-bus and ground-bus practice |

### Units and conventions

- **Tick.** The game runs at **60 ticks/s**. All production logic is integer fixed-point: `10000` means "one unit of progress at 1× speed per tick". **[C1 WV]**
- **Power** is stored as **J per tick**, so watts = J/tick × 60. For example, Sorter Mk.I `workEnergyPerTick = 300` gives 18 kW. **[C1 PD]**
- **Recipe time** `RecipeProto.TimeSpend` is in **ticks**. Iron ingot = 60 ticks = 1 s. **[C1 PD]** The assembler stores `timeSpend = TimeSpend × 10000` and `extraTimeSpend = TimeSpend × 100000`. **[C1 WV for usage; ×10000 and ×100000 are C3 recall, but they are the only values consistent with the WV formulas and with the +25 % extra-product rate.]**
- **Lengths** are in metres on a radius-200 planet unless a value is given in "tiles" (grid units).

---

## 1. Planet grid

### 1.1 Grid basics

| Fact | Value | Conf. | Source |
|---|---|---|---|
| Buildable (rocky) planet radius | 200 m (gas giants are 800 m and not buildable) | C2 | HE uses R = 200; SW observes a 200.2 m belt shell |
| Latitude "segments" from pole to pole | `segment = 200` per full circle, so 1 segment = 1.8°. Each segment has **5 grid rows** (`GRID_PER_SEGMENT = 5`). | C1 | HE `planet.ts` |
| Grid row height (N–S) | 2π/(200·5) rad = **0.36°** = **1.2566 m**. It is the same at every latitude, which is why the N–S axis has no "grid crush". | C1 | HE, GP |
| Rows from equator to pole | 250 | derived | |
| Longitude columns per ring | `longSegs × 5`. At the equator: 200 × 5 = **1000 columns** (0.36° each, 1.2566 m at the equator). | C1 | HE, BF |
| Height level | **4/3 m = 1.3333 m** per level (`PlanetAuxData.Snap` and blueprint `localOffset.z`). A ground-level belt sits at radius + 0.2 m. An elevated snap is `Max(R, floor((|p|−R)/1.3333)·1.3333 + R) + 0.2`. | C1 | SW (DLL), HE `HEIGHT_GRID_SIZE = 4/3` |

### 1.2 Latitude bands ("tropics")

Longitude columns are not continuous across the planet. The planet is split into bands, and each band has
its own column count. Inside a band the column width (E–W metres) shrinks with cos(latitude). It jumps
back up at each band boundary (a "tropic line"). Table computed from HE's `segmentArr` (columns: longitude
segment count; first latitude segment where it applies):

| Band (deg latitude, each hemisphere) | Longitude segments | Columns per ring | Rows in band | E–W tile width at low edge to high edge (m) |
|---|---|---|---|---|
| 0.0 – 28.8 | 200 | 1000 | 80 | 1.257 → 1.101 |
| 28.8 – 46.8 | 160 | 800 | 50 | 1.376 → 1.075 |
| 46.8 – 55.8 | 120 | 600 | 25 | 1.434 → 1.177 |
| 55.8 – 63.0 | 100 | 500 | 20 | 1.413 → 1.141 |
| 63.0 – 70.2 | 80 | 400 | 20 | 1.426 → 1.064 |
| 70.2 – 75.6 | 60 | 300 | 15 | 1.419 → 1.042 |
| 75.6 – 79.2 | 40 | 200 | 10 | 1.563 → 1.177 |
| 79.2 – 82.8 | 32 | 160 | 10 | 1.472 → 0.984 |
| 82.8 – 84.6 | 20 | 100 | 5 | 1.575 → 1.183 |
| 84.6 – 86.4 | 16 | 80 | 5 | 1.478 → 0.986 |
| 86.4 – 88.2 | 8 | 40 | 5 | 1.973 → 0.987 |
| 88.2 – 90.0 | 4 | 20 | 5 | 1.974 → 0 |

Rule: band *i* applies where `200·cos(lat) ≥ minSeg_i`, with `minSeg` = 177, 140, 114, 91, 73, 54, 40,
28, 20, 16, 8, 1. Latitude boundaries are rounded up to whole segments:
`ceil(acos(minSeg/200) / 1.8°)`. **[C1 HE]**

Solver implications:
- **Grid crush.** Two buildings 3 columns apart are 3.77 m apart at the equator but only 3.30 m apart at
  28°. Spacing and sorter-span checks run in **metres and local grid units**, so the solver must recompute
  them per latitude. **[C1 SW: `PlanetGrid.CalcSegmentsAcross` weights latitude and longitude spacing by the
  local grid; C2 GP]**
- Layouts should prefer the equatorial band. Its 1000-column ring and 160 rows give the most room before
  a tropic line. Do not let a module straddle a tropic line.

### 1.3 Building placement grid

| Fact | Conf. | Source |
|---|---|---|
| Buildings snap to grid points. In blueprints `localOffset.x/y` are integers, or **.5 for even-sized footprints**. Belts and sorters get fractional positions because they follow curves and slot poses. | C1/C2 (tested on real blueprint strings) | BF §"Grid" |
| There is no general half-tile placement mode. Shift disables snapping only for belt *routing* over other objects. | C3 | W (belt page) |
| Collision uses per-prefab `buildColliders` (oriented boxes, several per building), **not** a tile mask. The wiki's "GridSize" is an approximation. Two numbers matter for packing: `dragBuildDist` (default pitch when dragging a row), and actual collider overlap. | C1 | AD, PD (`dragBuildDistOverride`) |
| `landPoints` (PD) are ground-contact samples used for terrain and water checks. They give a good lower bound on the footprint (see §4). | C1 | PD, AD |

### 1.4 Blueprint latitude restrictions

- A blueprint stores one **area** per latitude band it covers. Each area records `areaSegments` (the band's
  longitude segment count), `parentIndex`, `tropicAnchor` and `anchorLocalOffset`. A blueprint inside one
  band has a single area. **[C1 BF, HE]**
- On paste, the game snaps the cursor and runs `BlueprintUtils.SnapTropic`. A multi-area blueprint must
  realign to the *same* tropic boundary (`BlueprintNotAlignTropicAnchor`). Pasting into a band whose grid
  proportion differs too much fails with `BlueprintWrongTropicRatio`. **[C1 SW]** The exact ratio threshold
  is unknown.
- Player rule of thumb: a blueprint made on a tropic line must be pasted on the same tropic line. A
  blueprint made off a tropic line cannot be pasted across one. Polar blueprints do not paste at the
  equator. **[C2 W Blueprint]**
- Solver motif rule: generate modules **per band** (column width = `2π·R·cos(lat)/(5·longSegs)`), and keep
  a module inside one band.

---

## 2. Conveyor belts (`CargoPath`)

### 2.1 Speeds and stacking

| Belt | `_BeltDesc.speed` (cells/tick) | Cargo per s (= speed·60/10) | Items per s at stack 1 / 2 / 3 / 4 | Conf. |
|---|---|---|---|---|
| Mk.I (2001) | 1 | 6 | 6 / 12 / 18 / 24 | C1 PD + WV |
| Mk.II (2002) | 2 | 12 | 12 / 24 / 36 / 48 | C1 |
| Mk.III (2003) | 5 | 30 | 30 / 60 / 90 / 120 | C1 |

- **Cargo** is one belt "packet": `{item, stack 1–4, inc}`, where `inc` is the total proliferator points.
  The maximum stack is **4**. **[C1 WV; C2 W Automatic Piler]**
- Ways to get stacks onto a belt: the Automatic Piler (§2.5); a station/AMM belt output using
  `stationPilerLevel` (§7); a Pile Sorter dropping onto a belt (§3); and any sorter that moves an
  already-stacked cargo belt-to-belt. A non-pile sorter keeps the stack because it re-inserts the whole
  cargo. **[C1 WV]**
- Techs:
  - "Logistics Station Integrated Logistics" adds +1 station/AMM output stack per level, up to 4.
  - "Pile Sorter Upgrade" 1–6 controls the pile sorter's feed-out and load counts (§3.4).
  - "Sorter Cargo Stacking" is **obsolete** and cannot be researched in new saves.
  **[C2 W Upgrades]**

### 2.2 Internal representation (for the tick simulator)

**[C1 WV `Belts/OptimizedCargoPath.cs`; SW]**

- A **CargoPath** is a run of connected belts with a `byte[] buffer`, `bufferLength` (= `pathLength`),
  `pointPos[]`/`pointRot[]` (one 3D pose per buffer cell), `closed` (loop), `outputPath` + `outputIndex`
  (where this path merges into another), and `chunks[]`. Chunks are triples `(start, length, speed)`, so one
  path can mix belt tiers.
- **One cargo takes 10 cells** (`CargoPath.kCargoLength = 10`). Cells `i..i+9` hold
  `246,247,248,249,250, <4 bytes item/stack/inc>, 255`. The byte `250` marks the cargo's "head" index.
  Empty cells are 0.
- **Cells per tile ≈ 20** (≈ 2 cargo per tile at full density). This is derived from the wiki: "a full belt
  holds one item per tile and one per connection between tiles; an item moves 3 tiles/s (Mk.I) / 15
  tiles/s (Mk.III)". 60 cells/s ÷ 3 tiles/s = 20. **[C2 W; exact cell spacing vs metres and its latitude
  dependence: C3, check `CargoTraffic` path generation]**
- **Update** (`CargoPath.Update`, every tick):
  1. If the path has an `outputPath` and a cargo head sits at `bufferLength−6`, try to insert it into the
     output path at `outputIndex`. Use `TryInsertCargo` (allows squeezing), or `TryInsertCargoNoSqueeze`
     for closed loops. The index is shifted by the target chunk's speed when the two paths' update parity
     differs. On success, clear the 10 cells. A path with no output and `bufferLength ≤ 10` does nothing.
  2. Walk the chunks from last to first. In each chunk, shift contiguous cargo forward by up to `speed`
     cells into empty space ahead. Cargo can only compress to 10-cell spacing. `updateLen` tracks the
     blocked tail so a backed-up belt is skipped quickly.
- **Belt ends:** sorters, stations and splitters read the **rear** (end) cargo with `TryPickItemAtRear`.
  Station, fractionator and piler outputs write at the **head** (start) only when `buffer[9] == 0`
  (`TryInsertItemAtHeadAndFillBlank`).

### 2.3 Merging, splitting, priority

- Belts may join **only in the merge direction**. A side-joining belt merges into the straight belt, and the
  **straight belt has priority**: the join only succeeds when a ≥10-cell gap passes the merge index.
  **[C2 W; C1 WV for the gap rule]**
- **Splitter (2020):** 4 belt ports, each usable as input or output, with 3 model variants (Tab). It has
  one optional **input priority** port, one **output priority** port and an **output filter**. Splitters
  stack vertically (`lapJoint` 2.667 m, i.e. 2 height levels). A stacked splitter uses its ports across all
  levels (`topId`). A Depot Mk.I can sit on top (`multiLevelAlternativeIds = [2020]`) and act as a buffer
  that both takes from inputs and feeds all outputs. That buffer cannot be filtered and does not stack its
  output. Splitters use no power. **[C1 PD/WV; C2 W]**
  Input/output selection (from WV `OptimizedSplitter`): each tick, gather the rear cargo of every input
  (priority first), then try outputs in order (priority first, filter respected). Exact rotation
  (round-robin) order: **C3**, read `CargoTraffic.UpdateSplitter`.

### 2.4 Elevation and slopes

| Fact | Value | Conf. | Source |
|---|---|---|---|
| Height step | 1.3333 m per level | C1 | SW, HE |
| Max belt altitude | **12 levels** base. +6 per Vertical Construction level, up to **48**. | C2 | W (belt pages, Vertical Construction) |
| Slope profiles | The path snapper (`PlanetAuxData.SnapLineNonAlloc`) picks among "0.5 / 1 / 2 levels-per-step and vertical" profiles. Players see a single ~45° slope that goes vertical when there isn't enough horizontal run. (1 level per tile ≈ 1.333 m / 1.257 m ≈ 46.7°.) | C1 (profiles exist) / C3 (exact selection) | SW, ST1 |
| Flat run at ramp ends | The editor needs **2 flat tiles at each end** of a slope before it can turn. Errors: `JointCannotLift` (lifting at a junction or end), `TooBendToLift` (turning while lifting). Keep ramps, turns and joints in separate straight segments. | C2/C1 | W, AD |
| Ramp length in practice | A level change drawn from scratch takes ~5 tiles. If both heights already exist, about 3 tiles. | C3 | ST1 |
| Crossings | Belts on different levels cross freely. Sky-bus and ground-bus patterns: sorters reach up or down to the bus. | C2 | ST2 |
| Belts on water | Allowed, no foundation needed | C2 | AD |

Simulator note: a ramp is simply more path cells (3D length). Height does not affect speed. **[C3]**

### 2.5 Automatic Piler (2040)

**[C2 W; C1 PD]**

- 2 belt ports, 144 kW work / 9 kW idle.
- Stacks when the belt enters from the **small side** and unstacks when it enters from the large side.
- It merges two **consecutive** same-item cargos: 1+1→2, 2+2→4, 2+1→3. Unstacking splits 4→2+2, 3→2+1,
  2→1+1. Max stack 4.
- Stackable: 7 base, +3 per Vertical Construction level, up to 25.
- Power: works while `timeSpend < 10000`.
- Trick: belt speed step-down (fast belt → piler → slow belt → piler) reaches 4-stacks with 2 pilers.

---

## 3. Sorters (`InserterComponent`)

### 3.1 Prototype data

| Sorter | ID | `_InserterDesc.stt` (per span) | delay | canStack | stackSize | Work / idle power | Conf. |
|---|---|---|---|---|---|---|---|
| Mk.I | 2011 | 200 000 | 0 | no | 1 | 18 kW / 9 kW | C1 PD |
| Mk.II | 2012 | 100 000 | 0 | no | 1 | 36 kW / 9 kW | C1 PD |
| Mk.III | 2013 | 50 000 | 0 | yes (legacy) | 1 | 72 kW / 9 kW | C1 PD |
| Pile | 2014 | 30 000 | 0 | yes | 2 | 144 kW / 9 kW | C1 PD |

- `stt` for a placed sorter = `max(10000, prefab.stt × span)`, with span ∈ {1,2,3} grid lengths. The span is
  stored as blueprint `param[0]`. **[C1 SW]** BF cites a source claiming pile-sorter speed does not depend
  on length. The wiki's measured pile table does show distance dependence (§3.4). **Unresolved: check
  `PlanetFactory` inserter construction for grade 4.**
- Power draw is **work while Sending/Returning**, idle otherwise. **[C1 WV `InserterExecutor`]**

### 3.2 State machine

**[C1 WV `OptimizedInserter.Update`]**

Speed constant `InserterComponent.speed = 10000`. Each tick, with `power` = network serve ratio (0..1):
`if power < 0.1: do nothing`.

```
Picking:
  if holding nothing:
     if careNeeds (target has a needs[] array: assembler, lab, ejector, silo, …):
        if idleTick-- > 0: skip
        if target.needs all zero: idleTick = 9; skip
     else if target is a fuel generator: special fuel pick (max 10 fuel buffered in generator)
     filter = sorter.filter
  else if stackCount < StackInput:          # only pile sorter (or legacy Mk.III) loops here
     (same careNeeds/idle check, idleTick = 10)
     filter = held itemId
  else skip
  try pick (see 3.3); on success: itemId=..., itemCount += stack, itemInc += inc, stackCount++, time = 0
  if holding:
     time += 10000
     if stackCount == StackInput or time >= Delay:  time = power*10000; stage = Sending
  else time = 0

Sending:   time += power*10000; if time >= stt: stage = Inserting; time -= stt
           (if item vanished: stage = Returning, time = stt - time)
Inserting: if careNeeds and target.needs all zero: idleTick = 10; wait
           belt target and StackOutput > 1 (pile sorter): TryInsertItemWithStackIncreasement(...)
           else insert itemCount/stackCount items as ONE insertion (one cargo when the target is a belt)
           when everything is delivered: stage = Returning; time += power*10000
Returning: time += power*10000; if time >= stt: stage = Picking; time = 0
```

Grade parameters, from `GameMain.history`:

| Grade | StackInput | StackOutput | Delay |
|---|---|---|---|
| 1, 2 (Mk.I/II) | 1 | 1 | 0 |
| 3 (Mk.III) | `inserterStackCountObsolete`, which is **1 in new saves** | 1 | 110000 if stacking > 1 |
| 4 (Pile) | `history.inserterStackInput` | `history.inserterStackOutput` | 40000 if StackInput > 1 |

`Delay` counts from the *last successful pick*. The pile sorter therefore leaves after 3 ticks without a new
pick even if it is not full.

**Cycle time at full power, item available, target accepting:** `cycle = 2·stt/10000` ticks. The pick tick
counts as the first Sending tick and the insert tick as the first Returning tick.
- Mk.I span 1: 40 ticks, 1.5 trips/s. Mk.II: 20 ticks, 3/s. Mk.III: 10 ticks, 6/s. Pile: 6 ticks plus pick
  and insert extras.
- Span 2 and 3 multiply `stt`, giving the wiki table **[C2 W]**:

| items/s (stack-1 cargo, 1 item per trip) | 1 grid | 2 grids | 3 grids |
|---|---|---|---|
| Mk.I | 1.5 | 0.75 | 0.5 |
| Mk.II | 3 | 1.5 | 1 |
| Mk.III | 6 | 3 | 2 |

A trip carries **one cargo**. From a stacked belt, a non-pile sorter therefore moves up to 4 items per trip
(Mk.III on a 4-stack belt: 24 items/s at span 1). From a building, a non-pile sorter takes **1 item per
pick**. **[C1 WV]** Low power stretches every stage linearly. Below 10 % power, sorters stop. **[C1]**

### 3.3 Pick and insert rules per target

**[C1 WV `InserterExecutor`]**

- **Belt pick:** `TryPickItem(offset−2, 5, filter[, needs])` takes the first cargo whose head lies in the
  5-cell window around the sorter's attachment index, matching the filter and, when `careNeeds`, an item
  the target needs. The attachment index (`segIndex + segPivotOffset + pickOffset`) is clamped to
  `[4, pathLength−6]`. Several sorters on one belt each have their own offset.
- **Belt insert:** `TryInsertItem(offset, item, stack, inc)` needs a free 10-cell gap near the offset. It
  searches ±5 cells and may "squeeze" cargo backwards (search up to 2880 cells). Otherwise the sorter waits
  in Inserting.
- **Pick from assembler or smelter:** only **products**, one item per pick. Only if `produced > 0` and, with
  `careNeeds`, the downstream target needs that item. Ingredients are never pulled out. This is what makes
  building-to-building chains safe.
- **Insert into assembler:** adds to `served[i]` of the matching ingredient. There is **no per-item cap at
  insert time**. Back-pressure comes only from the `needs` check at pick time (§4.3). The sorter waits
  while the target's needs are all zero.
- **Labs (producing):** like assemblers. **Labs (research):** matrix `served += 3600 × count`.
- **Storage:** inserts bottom-first, moving up the stack when a level is full (`nextStorage`). Picks from
  the top down (`topStorage` → `previousStorage`).
- **Fuel generator (thermal, fusion, artificial star):** at most 10 fuel items buffered. Sorters can relay
  fuel **out of** one generator into the next (`PickFuelForPowerGenFrom`).
- **Stations:** sorters **cannot** connect to PLS or ILS. Stations are belt-only. **[C1: WV throws
  "Assumption that sorters can not interact with stations is incorrect"]**
- **"Bidirectional" sorters** (`InserterComponent.bidirectional`) run a separate instant-transfer update
  with no travel time (WV `OptimizedBiInserter`). The trigger is unknown, possibly zero-length or
  battle-base links. **[C3]**

### 3.4 Pile sorter

- Unlocked with Integrated Logistics System. Base: load (StackInput) 2, feed-out (StackOutput) 1.
  **[C1 PD stackSize=2; C2 W]**
- Upgrade levels:

| Pile Sorter Upgrade level | Effect |
|---|---|
| 1 | feeds out 2 |
| 2 | loads 3 |
| 3 | feeds out 3 |
| 4 | loads 4 |
| 5 | feeds out 4 |
| 6 | "loads/unloads simultaneously" (semantics unknown, probably removes the pick wait) |

  **[C2 W Upgrades]**
- "Feeds out n" is the **maximum stack height it builds on a belt**. It tops up existing cargos near the
  drop point (`TryInsertItemWithStackIncreasement`). An un-upgraded pile sorter unstacks.
- The ItemInfo display gives a single-trip time of **0.05 s/grid** (= 3 ticks, matching stt 30000) and
  120 items/s as a nominal maximum.
- Measured belt-unload speeds (items/min) **[C2 W, player-measured]**:

| Upgrade level | Max stack | Dist 1 | Dist 2 | Dist 3 | 3 sorters at dist 1 |
|---|---|---|---|---|---|
| Lv0 | 1 | 800 | 480 | 343 | 1800 |
| Lv1 | 2 | 1029 | 554 | 379 | 3085 |
| Lv2 | 2 | 1080 | 675 | 490 | 3340 |
| Lv3 | 3 | 1350 | 770 | 540 | 4050 |
| Lv4 | 3 | 1309 | 545 | 624 | 3927 |
| Lv5 | 4 | 1600 | 960 | 686 | 4800 |

### 3.5 Placement geometry

| Rule | Value | Conf. | Source |
|---|---|---|---|
| Reach | 1–3 grid lengths. Length check: end-to-end distance **≤ 5.5 m** (3D) **and** latitude-aware grid span **≤ 3.499** (`PlanetGrid.CalcSegmentsAcross`, measured from the device centre for belt/device links). Either failure gives `TooFar`. | C1 | SW |
| Minimum | End points **< 1 m** apart give `Failure` | C1 | AD |
| Facing | Each end must face along a slot or belt direction. Belt ends choose among 4 quarter-turn orientations. Max angular error **< 11°** when a belt is involved, **< 14°** for building↔building (`TooSkew`). | C1 | SW, AD |
| Belt attach point | Projected onto the belt's `pointPos` samples in the chosen segment window, 0.15 m radially inward | C1 | SW |
| Height difference | Allowed within the 5.5 m 3D limit. A tilt-difference check exists so vertical sorters with enough length no longer report "too close". Whether vertical distance counts toward span (and so speed): **C3**. | C2/C3 | ST, SW |
| Slots | One sorter per building slot (§4.2). Belts have no slots; any number of sorters can attach along a belt. | C1 | PD, AD |
| Grid crush | E–W reach shrinks in metres at high latitude inside a band. N–S always reaches 3 tiles. | C2 | GP |
| Facility priority | Faster sorters win when several unload the same storage | C3 | W |

---

## 4. Production buildings

### 4.1 Stats

Speeds are `_AssemblerDesc.speed / 10000` (or `_LabDesc.assembleSpeed`). Power is `_PowerDesc × 60`. Slots
come from `_SlotConfig`. All from **PD [C1]** unless noted. In PD, `insertPoses` count is the **sorter
slots** and `slotPoses` count is the **belt ports**; this naming was checked against splitter, tank and
station. The select box is the hover box in metres (W × L × H), not the collider.

| ID | Building | Recipe type | Speed | Work / idle | Sorter slots | Belt ports | Select box W×L×H (m) | landPoints extent (m) | Est. footprint (tiles @equator) | Stackable |
|---|---|---|---|---|---|---|---|---|---|---|
| 2302 | Arc Smelter | SMELT | 1× | 360 / 12 kW | 12 | 0 | 3.2×3.2×3.8 | ±1.5 | **3×3** (W; dragBuildDist 2.9 m, so 3-tile pitch, AD) | no |
| 2315 | Plane Smelter | SMELT | 2× | 1440 / 48 kW | 12 | 0 | same | ±1.5 | 3×3 | no |
| 2319 | Negentropy Smelter | SMELT | 3× | 2880 / 96 kW | 12 | 0 | same | ±1.5 | 3×3 | no |
| 2303 | Assembler Mk.I | ASSEMBLE | 0.75× | 270 / 12 kW | 12 | 0 | 4.2×4.2×4.6 | ±2.0 | **4×4 pitch** (W "4x4"; GP: core 3×3, belts fit in the 5×5 ring, neighbours ≥4 tiles apart; AD dragBuildDist 3.82 m) | no |
| 2304 | Assembler Mk.II | ASSEMBLE | 1× | 540 / 18 kW (W shows 15 kW) | 12 | 0 | same | ±2.0 | 4×4 | no |
| 2305 | Assembler Mk.III | ASSEMBLE | 1.5× | 1080 / 24 kW (W: 18) | 12 | 0 | same | ±2.0 | 4×4 | no |
| 2318 | Re-composing Assembler | ASSEMBLE | 3× | 2700 / 54 kW | 12 | 0 | same | ±2.0 | 4×4 | no |
| 2309 | Chemical Plant | CHEMICAL | 1× | 720 / 24 kW | 8 (2 rows, front and back; AD) | 0 | 9.2×5.3×6.3 | −4.2…4.8 × 0…3.4 | dragBuildDist **8.4 × 4.5 m**, so ~7×4 | no |
| 2317 | Quantum Chemical Plant | CHEMICAL | 2× | 2160 / 36 kW | 8 | 0 | 9.7×5.3×6.3 | same | ~7×4 (8.4 × 4.5 m) | no |
| 2308 | Oil Refinery | REFINE | 1× | 960 / 24 kW | 9 | 0 | 4.2×7.4×10.6 | ±2 × −1…3.3 | ~4×6 (C3) | no |
| 2310 | Miniature Particle Collider | PARTICLE | 1× | 12 MW / 120 kW | 9 | 0 | 11.2×6.1×13 | | dragBuildDist **12 × 6 m**, so ~10×5 | no |
| 2901 | Matrix Lab | lab | 1× (60 H/s, W) | 480 / 12 kW | 12 | 0 | 6.1×6.1×3.1 | ±2.8 | ~5×5 (C3) | **yes** (lap 4.0 m; mixes with 2902) |
| 2902 | Self-evolution Lab | lab | 3× (480 H/s, W) | 1920 / 48 kW | 12 | 0 | same | ±2.8 | ~5×5 | **yes** |
| 2314 | Fractionator | FRACTIONATE | — | 720 / 18 kW (scales with throughput, §4.5) | 0 | 3 | 4.8×4.8×9.4 | ±2.33 | dragBuildDist 5.5 m, so ~5×5 | no |
| 2313 | Spray Coater | belt addon | — | 90 / 4.5 kW | 0 | rides belt | 1.3×4.8×2.5 | ±0.35 × ±2 | 1×4 on the belt | **yes** (7 base, +3/level, up to 25, W) |
| 2103 | Planetary Logistics Station | station | — | charge 12 MW default / 60 kW idle | 0 | **12** | 7.6×7.6×25 | ±4 × ±2 | ~7×7 (C3) | no |
| 2104 | Interstellar Logistics Station | station | — | charge 60 MW default / 60 kW idle | 0 | **12** | 8.0×8.0×34 | ±4 × ±2 | ~7×7 (C3) | no |
| 2201 | Tesla Tower | power node | — | 0 | 0 | 0 | 1.25×1.25×6 | point | 1×1 | no |
| 2202 | Wireless Power Tower | power node | — | 4.8 MW (mecha charging) / 90 kW (W; PD shows 0) | 0 | 0 | 2.3×2.3×9.2 | point | W says 3×3, select box ~2×2 | no |
| 2212 | Satellite Substation | power node | — | idle 360 kW (W; PD shows 0) | 0 | 0 | 3.5×3.5×7 | ±1.85 | 3×3 (W) | no |
| 2020 | Splitter | belt | — | 0 | 0 | 4 | 2.7×2.7×2.4 (variant b: 1.5×2.7) | ±1.28 | ~2×2 to 3×3 | **yes** (same layer count as storage) |
| 2107 | Logistics Distributor | addon on Depot | — | charge 1.8 MW default (max 9 MW, W) / 18 kW; 27 MJ | 0 | 0 | 3.0×3.2×1.9 | on storage | — | sits on storage |
| 2040 | Automatic Piler | belt | — | 144 / 9 kW | 0 | 2 | 2.2×3.0×2.0 | ±1.1 × ±1.5 | ~2×3 | **yes** (7 / +3 / 25) |
| 2030 | Traffic Monitor | belt addon | — | 36 / 9 kW | 0 | rides belt | 1.3×2.3×1.4 | | on the belt | no |
| 2101 | Depot Mk.I | storage | — | — | 12 | 0 | 3.2×3.2×2.67 | ±1.45 | 3×3 | **yes** (lap 2.667 m; may stack on a splitter) |
| 2106 | Storage Tank | fluid | — | — | 0 | 4 | 4.8×4.8×4 | ±2.33 | ~4×4 | **yes** (lap 4.0 m) |
| 2204 / 2211 | Thermal / Mini Fusion plant | generator | — | 2.16 / 15 MW out | 5 | 0 | 4.8×9.0×4.2 | | ~4×7 | no |

Other slot counts **[C1 PD]**: EM-Rail Ejector 4, Vertical Launching Silo 3, Artificial Star 4,
Battlefield Analysis Base 9, Mining Machine 1 belt port, Advanced Mining Machine 9 belt ports, Water Pump 1,
Oil Extractor 1, Ray Receiver 2, Energy Exchanger 4.

Sorter-slot positions:
- Assemblers, labs, depots and arc smelters have 12 slots, **3 per side** on all 4 sides. **[C2 for
  assemblers (Steam: "three sorter connectors on all four sides"); C3 for smelters and labs]**
- The chemical plant's 8 are on the two long sides. **[C2 AD]**
- Exact slot poses are in `prefabDesc.slotPoses` (game files) and cannot be reconstructed from public data.
  **This is the biggest geometry gap.**

### 4.2 Station belt ports

- PLS and ILS have 12 ports, **3 per side**. In HE's port transform the ports sit at lateral offsets −1.256,
  0, +1.256, which is 1 tile apart at the equator, on each of the 4 faces. **[C2 HE `stationSlotTrans`;
  exact model units C3]**
- Each port is configured as input, output (with an item filter) or none.

### 4.3 Assembler and smelter tick logic

**[C1 WV `OptimizedAssembler`]** Applies to smelters, assemblers, chemical plants, refineries and the
collider (all `AssemblerComponent`).

**Progress per tick:** `time += (int)(power × speedOverride)` and `extraTime += (int)(power × extraSpeed)`
while replicating and both counters are below their limits. When `time ≥ timeSpend`, one craft completes.
When `extraTime ≥ extraTimeSpend` (10 × timeSpend), one *bonus* batch of products is added.

**Crafting time** = `TimeSpend_ticks × 10000 / (speed × power)` ticks. Mk.II assembler (10000), 1 s
recipe: 60 ticks.

**Start of a craft** (when not replicating):
1. Every ingredient needs `served[i] ≥ requireCounts[i]`. Otherwise `time = 0` and the machine idles.
2. Consume the ingredients.
3. Compute the proliferation level `L = min over ingredients of the consumed average inc` (via
   `split_inc_level`, capped at 10).
4. Set the mode:
   - Productive recipe and extra-products mode: `extraSpeed = speed × incTable[L]/1000 × 10`,
     `speedOverride = speed`.
   - Otherwise (speed-up mode): `speedOverride = speed × (1 + accTable[L]/1000)`.
   - Both modes: `extraPowerRatio = powerTable[L]`.

**Input acceptance ("needs").** Ingredient *i* is requested while
`served[i] < requireCounts[i] × N`, with

```
N = max(2, speedOverride × 180 / timeSpend + 1)      (integer division)
  = max(2, floor(3 s × effective_speed / recipe_seconds) + 1)
```

Examples: 1 s recipe at 1× gives N = 4 crafts' worth. 2 s at 1× gives N = 2. 1 s on Mk.III (1.5×) gives
N = 5. 0.5 s at 1× gives N = 7.

A sorter already in flight still delivers. A stacked cargo can overshoot by up to 3 items, or more with
pile-sorter loads.

**Output blocking** (checked before adding a craft's products; per product *j*):

| Recipe type | Blocks when | Effective max output buffer |
|---|---|---|
| SMELT | `produced + count > 100` | 100 items |
| ASSEMBLE | `produced > 9 × count` | 10 crafts |
| CHEMICAL, REFINE, PARTICLE, other | `produced > 19 × count` | 20 crafts |

While blocked, `replicating = false`, so the machine draws idle power. Bonus (extra-time) products are added
**without** this check.

**Power:** `required = replicating ? work × (1000 + extraPowerRatio)/1000 : idle`.

**Multi-output recipes** (refinery, etc.) block when **any** product is over its cap, so an un-drained
byproduct stalls the machine. **[C1]**

### 4.4 Labs

**[C1 WV `OptimizedProducingLab` / `OptimizedResearchingLab`]**

**Matrix-producing mode:**
- Input threshold per ingredient: `served < 3·((speed+5001)/10000) + 3`. That is 6 items for the Matrix
  Lab and 12 for the Self-evolution Lab. It is 6 for recipes longer than 540 ticks.
- Output cap: `10 × ceil(speed/10000)` items.

**Stack behaviour** (stacking is the main reason to use labs):
- Each lab passes ingredients **up** to the lab above. It keeps `requireCount + 1 + speed/20000` and passes
  at most 5 per tick.
- Products flow **down**. The lower lab pulls from the upper one until it holds `10·ceil(speed) − 2`.
- So you feed and unload only the **bottom** lab. `multiLevelAllowInserter = false` for labs: no sorters on
  upper levels.

**Research mode:**
- Matrices are stored as `3600 × count`. A lab requests while `< 36000` (10 cubes).
- It passes surplus above 7200 (2 cubes) upward, up to 10 cubes per tick.
- Proliferated matrices give bonus hash via `incTable` (an extra-product style bonus).

### 4.5 Fractionator

**[C1 WV `OptimizedFractionator`; PD]**

- 3 belt ports: product (deuterium) out at the **centre** port. The two side ports are input and
  pass-through output, configured by belt direction.
- Buffers: `fluidInputMax = 40` cargos, `productOutputMax = 20`, `fluidOutputMax = 20`.
- Per tick: `progress += (int)(power × 166.667 × min(cargoBuffered, 30) × avgStack + 0.75)`. Every 10000
  progress processes 1 hydrogen.
  - Success probability: `produceProb (0.01) × (1 + accTable[inc]/1000)`. Proliferation speeds up
    fractionation; it has no extra-products mode.
  - On success: 1 deuterium. On failure: the hydrogen goes to the fluid output.
- With ≥30 cargos buffered: 30 × stack H/s, which equals a full Mk.III belt.
- Fluid output: up to 2 cargos per tick, re-stacked to `ceil(avgInputStack − 0.1)`, so stacks are preserved.
- Input is taken from the belt rear (`TryPickItemAtRear`).
- Power permillage: `(max(0, min(cargo,30) × stack − 30) × 50 + 1000) × powerTableRatio[inc]`. This is
  720 kW up to a stack-1 Mk.III belt and rises above that, matching the wiki's
  `0.06 × (D/min − 6)` MW.

### 4.6 Spray Coater

**[C1 WV `OptimizedSpraycoater`, PD]**

- Built **on** the item belt (bottom passage). The proliferator belt enters the top passage.
- Capacity: `incCapacity = 600` sprays. It accepts one proliferator type at a time. Proliferator passes
  through if the coater is full or the type differs.
- Each proliferator item adds `hpMax` sprays (12/24/60), plus a bonus if the proliferator was itself sprayed:
  `+ (int)(hpMax × incTable[incPerItem]/1000 + 0.1)`.
- Spray pacing: `sprayTime += outgoingBeltSpeed × 1000 × powerRatio` per tick. One cargo is sprayed per
  10000, so the coater keeps up with exactly one belt's cargo rate. It does not spray below 10 % power.
- Spraying sets `cargo.inc = stack × ability` and consumes `stack` sprays. It only sprays if this raises the
  cargo's inc.
- Work power while spraying. The wiki says power rises with stack size.

---

## 5. Proliferator

| | Mk.I (1141) | Mk.II (1142) | Mk.III (1143) | Conf. / source |
|---|---|---|---|---|
| `ability` (inc points per item) | 1 | 2 | 4 | C1 PD |
| Sprays per item (`hpMax`) | 12 | 24 | 60 | C1 PD, W |
| Sprays when the proliferator itself is sprayed with the same tier | 13 | 28 | **75** (W says 72; the code gives 60 + int(60×0.25+0.1) = 75; AD also says 75) | C1 formula / C2 |
| Extra products | +12.5 % | +20 % | +25 % | C2 W, AD |
| Speed-up | +25 % | +50 % | +100 % | C2 |
| Work-power multiplier | ×1.3 | ×1.7 | ×2.5 | C2 |

Cargo tables, indexed by average inc points per item (0..10). Levels 1, 2 and 4 are pinned by the table
above. The other entries are recalled from decompiled `Cargo` and should be verified:

```
incTable   (‰ extra product): 0,125,200,225,250,275,300,325,350,375,400
accTable   (‰ speed-up)     : 0,250,500,750,1000,1250,1500,1750,2000,2250,2500
powerTable (‰ extra power)  : 0,300,700,1100,1500,1900,2300,2700,3100,3500,3900
```

Mixing tiers averages inc points across a stack or buffer. A machine uses the **minimum** level across its
ingredients. If any ingredient is unsprayed, there is no bonus. **[C1 WV `split_inc_level`; C2 W]**

**Extra products are deterministic**, not random. The parallel `extraTime` accumulator emits a full product
batch every 1/bonus crafts. **[C1]**

**Recipes that cannot use extra products** (speed-up only):
- Recipes flagged `nonProductive` in PD: Deuterium (fractionation), Antimatter Fuel Rod, X-ray Cracking,
  Mass-energy Storage (antimatter), Reformed Refinement.
- Every recipe whose ingredients include a non-productive item. PD marks **all buildings**, logistics
  drones, bots and vessels, Small Carrier Rocket, Critical Photon and the fuel rods as `productive=false`.
  So belt Mk.II, sorter Mk.II, Assembler Mk.II etc. are speed-up only.

  **[C1 PD flags; the "any ingredient" combination rule is C2 (W: "recipes that use other buildings as
  material"), so verify in `RecipeProto.Preload`]**

The speed-up multiplies the building speed: Mk.III assembler 1.5 × 2 = 3×. **[C2 W]**

Spray coater operation: see §4.6. Self-spraying a loop consumes 1 of the 75 sprays, leaving 74 net
(`S/(K−1)` supply rule). **[C2 AD]**

---

## 6. Power

### 6.1 Nodes

**[C1 PD `_PowerDesc`; W display values]**

| Node | `connectDistance` (m) | `coverRadius` (m) | Wiki display | Own consumption |
|---|---|---|---|---|
| Tesla Tower 2201 | 22.5 | 10.5 | "22 m reach / 10 m supply" | 0 |
| Wireless Power Tower 2202 | 45.5 | 6.5 | "45 m / 6 m" | 90 kW idle, 4.8 MW while charging the mecha (W) |
| Satellite Substation 2212 | 53.5 | 26.5 | "53 m / 26 m" | 360 kW idle (W) |
| Signal Tower 3007 | 60.5 | 14.5 | — | — |
| Wind Turbine 2203 | 16.5 | 7.7 | — | generator 300 kW |
| Thermal / Fusion plant | 11.75 | 4.5 | — | generator |
| Ray Receiver 2208 | 22.5 | 10.5 | — | generator |
| Energy Exchanger 2209 | 15.5 | 7.0 | — | — |
| Solar Panel 2205 | 6.75 | (none) | — | generator |
| Accumulator 2206 | 4.2 | (none) | — | 540 MJ, in 1.5 MW / out 2.25 MW |

Points still to confirm in the DLL:
- Whether a link between two nodes requires distance ≤ min or ≤ max of their `connectDistance`. **[C3]**
- Whether a consumer is covered when its own power point lies within the node's `coverRadius`. Each prefab
  has a `powerPoint` offset. **[C3]**

The wiki's display values are the raw values rounded down by 0.5. **[C3]**

### 6.2 Network balance

**[C1 WV `OptimizedPowerNetwork`]**

Each tick, per network:
1. Demand = Σ consumer requests computed **last tick**. Supply = Σ generator capacity.
2. Accumulators charge from the surplus or discharge into the deficit. Exchangers do the same.
3. `consumerRatio = supply ≥ demand ? 1 : supply/demand` (supply includes accumulator discharge).
4. Every consumer on the network gets the same `power = consumerRatio`.

Effects on consumers:
- Assemblers, labs, sorters and fractionators advance by `power × speed`.
- At **power < 0.1** they freeze entirely.
- Spray coaters spray at the reduced rate. Miners scale their own way.

**Consumer request formulas:**
- Assembler: `working ? work × (1000+powerTable[L])/1000 : idle`.
- Sorter: work in Sending/Returning, idle otherwise.
- Miner: `(speedDamper × speed²)/1e8` interpolation.
- Station: see §6.3.

### 6.3 Station charging

| | PLS | ILS | Source |
|---|---|---|---|
| Default max charge | **12 MW** (`workEnergyPerTick` 200000) | **60 MW** (1000000) | C1 PD |
| Slider range | 6 – 60 MW | 30 – 300 MW | C1 SW: `[work/2, work×5]`, step 3 MW (50000 J/tick); C2 W ItemInfo shows the max |
| Energy capacity | 180 MJ | 12 GJ | C1 PD `maxEnergyAcc` |
| Idle | 60 kW | 60 kW | C1 PD |

Live demand ≈ `maxCharge × (1 − stored/capacity)`. Example: 12 MW × (180−18)/180 = 10.8 MW.
**[C2 W; C1 SW: `SetPCState` sets the requested energy from the fill ratio every tick]**

The Logistics Distributor uses the same mechanism: 1.8 MW default (max 9 MW), 27 MJ.

---

## 7. Logistics stations

| | PLS 2103 | ILS 2104 | AMM 2316 (vein collector) | Source |
|---|---|---|---|---|
| Item slots | **4** | **5** (+ a dedicated warper slot) | 1 | C1 PD `maxItemKinds`; C2 W |
| Max per slot | **5000** (W: upgradable to 10000) | **10000** (W: upgradable to 20000) | 5000 | C1 PD `maxItemCount`; C2 W |
| Drones / vessels | 50 / 0 | 100 / 10 | — | C1 PD |
| Belt ports | 12 (3 per side) | 12 | 9 | C1 PD; C2 HE |

### Belt I/O per port

**[C1 WV `OptimizedStation`]**

- **Output port:**
  - Acts at most **once every 2 ticks** (`counter = 1`), giving ≤ 30 cargo/s, a full Mk.III belt.
  - Only acts when the belt head cell is empty.
  - Emits one cargo of `min(count, pilerCount)` items. `pilerCount` is the per-station setting; 0 means
    "tech max" = `history.stationPilerLevel` (1 base, up to **4** with the Integrated Logistics upgrades).
  - The port's filter (`storageIdx`) selects the slot. An index past the storage slots means space
    warpers.
  - **Max output: 30 cargo/s × 4 = 120 items/s per port.**
- **Input port:**
  - Also at most once every 2 ticks.
  - Takes the cargo at the belt's **rear** if its item matches a slot that still "needs" items. A slot needs
    items when it is configured and `count < max`, regardless of supply/demand mode. **[C1 SW
    `StationComponent.UpdateNeeds`]**
  - Stacked cargo is accepted whole (+stack, +inc).
  - Space warpers (1210) go to the warper slot.
- Sorters cannot interact with stations (§3.3).
- The AMM is a station-like vein collector: 1 item kind, 9 belt ports, uses the station output logic, and
  its stack count also scales with Integrated Logistics. **[C1 PD; C2 W]**

---

## 8. Stacking and vertical construction

**[C1 PD `multiLevel`/`lapJoint`; C2 W for limits]**

| Building | Stackable | Height per level (`lapJoint`) | Layer limit | Sorters on upper levels? |
|---|---|---|---|---|
| Matrix Lab / Self-evolution Lab (mixable) | yes | 4.0 m (3 height levels) | **3 base, +2 per Vertical Construction level, up to 15** (6 levels) | no (`multiLevelAllowInserter = false`); feed the bottom |
| Depot Mk.I | yes | 2.667 m | storage layers: **2 base(?), +1 per level, up to 8** (W: Vertical Construction 1 gives 3) | yes |
| Depot Mk.II | yes (alt: Battlefield Analysis Base) | 4.0 m | same as storage | yes |
| Splitter | yes; Depot Mk.I can top it | 2.667 m | same as storage | yes |
| Storage Tank | yes | 4.0 m | not documented (C3: storage limit) | — (belt ports may be missing on upper tanks, AD) |
| Automatic Piler | yes | 2.666 m | 7 base, +3 per level, up to 25 | yes |
| Spray Coater | yes | — | 7 base, +3 per level, up to 25. Belts cannot reach level 25. Stacked coaters share power distribution (W). | no |
| Belts (altitude, not stacking) | — | 1.333 m | 12 base, +6 per level, up to 48 | — |
| Smelters, assemblers, chemical plants, refineries, colliders, fractionators, stations | **no** in vanilla (mods add assembler stacking) | — | — | — |

Vertical Construction is a 6-level upgrade (tech IDs 3701–3706), unlocked from Basic Logistics System.
**[C2 W]**

---

## 9. Dense-packing motifs for the solver

All of these are **[C3]** unless tagged. They are written as parametrised motifs. Every motif must be
re-checked against colliders and sorter rules (§3.5) at the target latitude.

### M1. Shared-belt sandwich (smelters or assemblers)

- One belt runs between two mirrored rows of machines.
- The belt centre line is 2 tiles from each row's centres. GP: "belts fit in the 5×5 ring around a 3×3
  smelter or assembler core".
- Each machine reaches the shared belt with a span-1 sorter.
- Row pitch: smelters 3 tiles (dragBuildDist 2.9 m < 3 × 1.2566; AD **[C1-measured]**), assemblers 4 tiles
  (3.82 m; GP, AD).
- Module width: `belt + 2 × (machine half-width + 2)` lanes. Example for smelters: centres at y = 0 and
  y = 4, belt at y = 2.

### M2. Multi-lane side bus

- 2–3 parallel belts run along one side of a row, at 2, 3 and 4 tiles from the machine centre.
- Sorters of span 1, 2 and 3 reach them, passing **over** the nearer belts. Sorters do not collide with
  belts they cross.
- With both sides used, a 12-slot machine can take ≤ 6 distinct belts.
- Throughput drops with span (§3.2), so put the highest-rate input on the nearest lane. Use stacked belts
  and pile sorters to recover throughput.
- Tesla towers fit in the 1-tile gap between 4-pitch assemblers (GP).

### M3. Direct insertion chain

- Sorter from building A (products only) to building B (careNeeds): A's output slot → B's input slot.
- Legal when the slot-to-slot distance is 1–5.5 m, the grid span is ≤ 3.499, and the facing error is
  < 14° **[C1 SW, AD]**.
- Safe against jams because sorters only pick products the target currently needs **[C1]**.
- Rate is limited by sorter speed and span. One Mk.III at span 1 moves 6 items/s.
- Used for gear→motor, the coil chain, and similar.
- Also **fuel relay** between thermal or fusion plants **[C1 `PickFuelForPowerGenFrom`]**.

### M4. Lab tower

- 15-high stack (fully researched) on a single footprint.
- Feed and unload only the bottom lab. Ingredients climb and products descend (§4.4) **[C1]**.
- Throughput into the tower is limited by the bottom lab's sorter rate. Use stacked belts and pile sorters.
- Research towers: 1 sorter per matrix type at the bottom.

### M5. Station "blackbox" cell

- A PLS or ILS has 12 ports; use 3 per side.
- Outputs at 4-stack (120 items/s per port) feed short lines.
- Pile sorters unload the stacked belts into machines. Loads and feed-out are up to 4 per upgrades.
- Spray coaters sit on the input lines between the station and the machines.
- Outputs return to station input ports.
- The station needs no sorters.
- Common practice: 4-high belts from the ILS/PLS and Mk.III proliferator throughout. ILS throughput per
  item ≈ ports × 120/s.
- Player reports: PLS can be packed tighter than ILS. Small storages with distributors on top make local
  hubs.

### M6. Splitter tower and depot hub

- Stacked splitters move items vertically between belt levels. "Stack splitters to max height" is a sky-bus
  tap.
- A splitter with a Depot Mk.I on top is an unpowered buffer or merge.
- Use priority ports to recycle byproducts before external supply (hydrogen loops, Casimir crystals) **[C2
  W]**.

### M7. Belt crossing and bridging

- Cross belts by raising one belt ≥ 1 level (1.333 m).
- Budget ramps: ~2 flat tiles at each end plus 1 tile per level at the ~45° profile, or vertical lifts
  when short. ST: 3–5 tiles total for one level change.
- No turns or junctions on a ramp **[C1 AD error codes]**.
- Sky-bus: a bus at altitude, with sorters reaching down, or stacked splitters as taps.

### M8. Over-building belts (unverified)

- An elevated belt can pass over a building only if it clears the building's colliders.
- Select-box heights suggest the minimum clearance levels:

| Building | Select-box height | Minimum belt level |
|---|---|---|
| Smelter | 3.8 m | 3 (4.0 m) |
| Assembler | 4.6 m | 4 |
| Lab | 3.1 m | 3 |

  These are **guesses**. Read `buildColliders` before using this motif.
- Belts can never pass **under** buildings.

### M9. Fractionator chain

- A line of fractionators on a 4-stacked, proliferated hydrogen belt.
- Pile sorters or pilers re-stack between units.
- Rate per unit ≈ 0.01 × (1 + acc) × belt items/s (§4.5).
- W formula for N units: `7200 × (1 − 0.98^N)` /min with Mk.III proliferation.

### M10. Spray-coater placement

- One coater per input belt, before the first consumer.
- It keeps up with that belt's full cargo rate (§4.6).
- Its proliferator belt enters from the top, so it can be fed from an elevated belt.
- Coaters stack, so several belts can share a column (W).

### Global packing rules

- 1 sorter per slot.
- Sorters may cross belts. Assume they may *not* overlap building colliders (C3).
- E–W spacing in metres shrinks with latitude, so recompute per band.
- N–S spacing is constant.

---

## 10. Gaps and what to verify first in decompiled code

1. **Building collider boxes** (`prefabDesc.buildColliders`) and **sorter slot poses**
   (`prefabDesc.slotPoses`/`portPoses`). Public data gives only slot *counts* and select boxes. This blocks
   exact footprints and sorter geometry.
2. **CargoPath geometry:** cells per metre or per tile, and how `pointPos` is generated (latitude
   dependence). Also splitter round-robin order and the exact squeeze rules in `TryInsertCargo`.
3. **Pile sorter:** whether `stt` scales with span for grade 4; the Lv6 "simultaneous" semantics; and how
   multi-item picks from buildings work.
4. **Power coverage and connection formulas** (min vs max `connectDistance`; plug-point coverage), and the
   idle draw of WPT and substation (PD shows 0, W shows 90/360 kW).
5. **`Cargo.incTable/accTable/powerTable`** entries for levels 3 and 5–10, and the `RecipeProto.productive`
   rule.
6. **Storage, splitter and tank layer base counts**, and the Vertical Construction mapping for tanks.
7. **Planet tick order.** WV order: miners → assemblers → fractionators → ejectors/silos → labs (produce,
   pass) → station tick → station belt input → sorters → tanks → belts → splitters → monitors → spray
   coaters → pilers → station belt output. Power is computed first from last tick's demand. Confirm against
   `PlanetFactory.GameTick` and `GameLogic`.
8. **Blueprint tropic-ratio threshold** (`BlueprintWrongTropicRatio`).
9. **Stack-overshoot behaviour** when a pile sorter inserts 4 items into an assembler near its `N`
   threshold, and output-stack picking by pile sorters.
10. Sorter **vertical reach:** whether height counts in the grid span, and the minimum height difference
    for vertical sorters.
