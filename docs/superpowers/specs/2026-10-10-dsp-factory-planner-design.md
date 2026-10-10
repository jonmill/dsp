# DSP Factory Planner — Design

Date: 2026-10-10
Status: Draft, pending review

## 1. Purpose

A personal tool for Dyson Sphere Program (DSP). The user picks a target product, the technologies
they have unlocked, which items are supplied from outside, and either a target rate or a number of
final-stage buildings. The tool produces:

1. a production plan (recipes, facilities, building counts, flows),
2. a **working**, densely packed factory layout as a DSP blueprint string, and
3. the power the factory needs.

Priorities, in order:

1. **The factory works.** A pasted blueprint builds without placement errors and sustains the
   target output rate with no stalls or deadlocks.
2. **Efficiency.** Small footprint/volume. A mostly optimal layout is good enough; a provably
   optimal one is not required.

## 2. Decisions and constraints

| Topic | Decision |
|---|---|
| Platform | Local web app: TypeScript, Vite, **Svelte 5** (runes). No backend. |
| Factory I/O | Every blueprint is a self-contained block fed and drained by a **logistics station** (planetary or interstellar, per unlocked tech). |
| Intermediates | **One combined block** contains the whole chain from supplied inputs to target. |
| Proliferator | Supported per build: none / Mk I / Mk II / Mk III, extra-products or production-speedup. Spray coaters are placed in the layout; proliferator is a station import. |
| Layout | **General 3D grid solver** (placement + routing), uses vertical space and dense-packing tricks. |
| Validation | **Reimplemented in TypeScript.** No game mods, no runtime use of game binaries. |
| Game data | **Static extraction** from the installed game files by a Python tool. |
| Run environment | Extraction and app run on the user's gaming machine (Nobara Linux, DSP under Proton). Development also happens on macOS. |
| Repo | Private git repo. Extracted JSON data **is committed**. Game binaries, decompiled source, and extracted image assets **are not**. |

Out of scope for v1: game mods, hosted deployment, reading save files, multiple-target blocks,
non-station I/O (edge belts, logistics distributors).

## 3. Architecture

```
DSP install (Steam/Proton) ─▶ tools/extract (Python, UnityPy, ilspycmd)
                                   │
                                   ├─▶ data/dsp-<version>.json   (committed)
                                   ├─▶ data/fingerprints.json    (committed)
                                   ├─▶ app/public/icons/*.png    (gitignored)
                                   └─▶ local/decompiled/*.cs     (gitignored)

app/ (Vite + Svelte 5 + TypeScript)
  src/lib/data        typed loader + zod schema for the extracted JSON
  src/lib/calc        production planner (LP)               → ProductionPlan
  src/lib/layout      netlist, placement, routing (Worker)  → Layout
  src/lib/validate    geometry, rate-capacity, tick sim     → ValidationReport
  src/lib/blueprint   decode / encode / hash                → "BLUEPRINT:..."
  src/ui              Svelte components
```

Units and their interfaces:

| Unit | Input | Output | Depends on |
|---|---|---|---|
| `data` | JSON file | `GameData` (typed, validated) | zod |
| `calc` | `GameData`, `PlanRequest` | `ProductionPlan` | `data`, LP solver |
| `layout` | `GameData`, `ProductionPlan`, `TechState`, budget | stream of `Layout` candidates + progress | `data`, `validate` (fast checks) |
| `validate` | `GameData`, `Layout`, `ProductionPlan` | `ValidationReport` | `data` only (no solver code) |
| `blueprint` | `Layout` / blueprint string | blueprint string / `Layout` | `data` |

The validator never imports solver code. The solver may call the validator's fast checks.

## 4. Extraction tool (`tools/extract`)

Python 3.11+, run with `uv` or a venv. CLI: `dsp-extract [--game-dir PATH] [--out DIR] [--copy-blueprints]`.

### 4.1 Locating the game

First match wins:

1. `--game-dir`.
2. Steam library discovery: read `libraryfolders.vdf` from each existing candidate:
   - `~/.local/share/Steam/steamapps/`
   - `~/.steam/steam/steamapps/`
   - `~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/` (Flatpak)
   - `C:\Program Files (x86)\Steam\steamapps\` (Windows)
   - `~/Library/Application Support/Steam/steamapps/` (macOS)

   For each library, look for `appmanifest_1366540.acf` (DSP app id). Read `installdir` and
   `buildid`. Game data dir: `<library>/steamapps/common/<installdir>/DSPGAME_Data/`.
3. Otherwise exit with a clear error listing the paths searched and suggesting `--game-dir`.

### 4.2 What it extracts

From `DSPGAME_Data/resources.assets` (and related asset files) via UnityPy, using type trees
generated from `Managed/Assembly-CSharp.dll`:

- **Items**: id, name, stack size, fuel/heat values, proliferator properties, icon reference.
- **Recipes**: id, type (smelt/assemble/chemical/refine/particle/…), inputs, outputs, time,
  handcraft-only flag, prerequisite tech.
- **Technologies**: id, name, prerequisites, unlocked recipes/buildings, and upgrade effects
  relevant to logistics (belt stacking level, sorter stacking, vertical construction, station
  capacity, drone/vessel capacity).
- **Buildings / models**: footprint and colliders (3D), slot/port positions and directions,
  sorter attach points, work/idle power, speed multiplier, station slot count, belt speed per tier,
  sorter reach/speed per tier, power-pole range and connection range, stacking rules.

From the decompiled code (`ilspycmd` on `Assembly-CSharp.dll`): constants not stored in asset data
(proliferator multiplier tables, power formulas, game version constant). Each extracted code
constant records the method it came from.

Optional: item/building icons exported as PNG to `app/public/icons/` (gitignored).

`--copy-blueprints` copies `.txt` blueprints from the Proton prefix
(`<library>/steamapps/compatdata/1366540/pfx/drive_c/users/steamuser/Documents/Dyson Sphere Program/Blueprint/`)
into `app/test/fixtures/blueprints/` for encoder round-trip tests.

### 4.3 Output

`data/dsp-<gameVersion>.json`, with a header: game version, Steam build id, extraction timestamp,
extractor version. Its schema is defined once in zod and exported as JSON Schema. The Python side
validates against that JSON Schema before writing.

### 4.4 Patch drift detection

`data/fingerprints.json` maps each **mirrored game method** (the methods ported by hand in §7.3)
to a hash of its normalized decompiled body, plus the TypeScript module that mirrors it. On
re-extraction the tool reports every mirrored method whose hash changed. It shows the diff
against the previous decompiled source if that source is still in `local/decompiled/`. The tool
exits non-zero in `--check` mode so drift is hard to miss.

## 5. Calculator (`calc`)

### 5.1 `PlanRequest`

- `target`: item id.
- `quantity`: `{ kind: "rate", perSecond }` or `{ kind: "buildings", count }`. Either way, the
  final stage's facility is chosen explicitly.
- `tech`: set of unlocked technology ids. Derives available recipes, facilities, belt/sorter
  tiers, stacking levels, station type.
- `supplied`: set of item ids imported by the station. Default: raw resources only.
- `facilityOverrides`: optional per-recipe facility choice. Default is the best unlocked facility
  for that recipe type.
- `proliferator`: `{ tier: 0|1|2|3, mode: "extra" | "speed" }`.

### 5.2 Solving

- A linear program over recipe run rates (`glpk.js` or equivalent, in-browser). It handles
  alternate recipes and by-products.
- Objective: lexicographic. Minimize building count, then imported raw material.
- Constraints: target produced at ≥ requested rate. Every non-supplied item is net ≥ 0. Surplus
  by-products become exports.
- Building counts are `ceil` of the fractional counts (DSP buildings cannot be throttled). The plan
  reports actual output (≥ target) and per-stage utilization.
- Buildings mode: rate = count × per-building rate of the final stage, then solve as rate mode.
- Proliferator changes the effective recipe outputs or speed and the power, using the extracted
  multiplier tables.

### 5.3 `ProductionPlan`

Stages (recipe, facility, count, utilization), item flows between stages (item, rate), imports
per second, exports per second (target and by-products), station slot demand, and an estimated
power draw (working, idle, station charging).

If station slot demand exceeds the slots of one station, the plan requires additional stations.
The layout must include them.

## 6. Layout solver (`layout`)

Runs in a Web Worker. It is an anytime algorithm: it emits progress and every improved
**validated** layout, and never presents an invalid one. "Validated" means the layout passed all
of §7: geometry checks, the rate-capacity check, and the tick simulator. Inside the search loop
only the fast checks (§7.1–7.2) run. The tick simulator runs on each candidate that would become
the new best.

### 6.1 Model

- A local integer 3D grid: x/y tiles, discrete z height levels for raised belts and stacked
  entities. The blueprint is intended for a latitude band where the planet grid is regular. The UI
  warns that pasting near the poles may fail.
- Entities: stations, production buildings, sorters, belts, spray coaters, power poles. Shapes,
  ports, reach, and stacking rules come from `GameData`.
- **Power coverage is a hard constraint.** Every powered entity must be within range of a pole,
  and the poles must form one connected network.

### 6.2 Pipeline

1. **Netlist.** Expand `ProductionPlan` into entity instances and flow edges
   `(item, rate, source, sink)`. Each edge chooses a connection style: direct sorter between
   adjacent buildings, a belt shared by several sinks, or a stacked belt. Each style is limited by
   the belt and sorter capacity of the user's tech.
2. **Placement.** Simulated annealing over positions and orientations of buildings and **motifs**.
   Motifs are pre-verified multi-entity dense patterns, placed as one unit. Collisions are hard
   constraints. Cost = footprint area and volume + estimated routing length + congestion.
3. **Routing.** 3D A* belt routing with negotiated congestion (PathFinder-style): routes
   rip up and re-route contested cells with rising penalties until no cells are shared. Belts may
   feed several sorters along their length and change height to cross other belts.
4. **Validate and repair.** Run `validate`. On failure, rip up the failing routes or perturb
   placement and retry. After repeated failure, relax density (more spacing) and retry. The
   relaxed fallback must always produce a valid layout for any plan the calculator emits.
   Failing to do so is a bug.

### 6.3 Time budget

- Default **10 minutes**, overridable in the UI.
- Early stop: stop when there has been no footprint improvement in the most recent 20% of elapsed
  time, after a minimum of 30 seconds.
- The UI can stop the solver at any time and keep the best validated layout found so far.

### 6.4 Motif library

Each motif is a parameterized pattern (e.g. a sorter chain directly between buildings, a stacked
input belt pair, coater placement on a shared input belt). A motif is enabled for the solver only
after it passes the validator **and** has been confirmed in-game (§9).

## 7. Validator (`validate`)

Independent of the solver. Output: `ValidationReport`, containing pass/fail, a list of
violations (each with entity ids and the game method the rule mirrors), simulated output rate,
stalled entities, and measured power.

### 7.1 Geometry checks

3D collisions using extracted colliders. Sorter endpoints must attach to valid ports or belt
cells, within the tier's reach and height rules. Belt slope and elevation limits. Belts must have
no unintended dangling ends. Power coverage and connectivity. Each rule cites the decompiled game
method it mirrors.

### 7.2 Rate-capacity check (fast)

Treat belts, sorters, and buildings as a network with capacities. Check that every flow edge can
carry its assigned rate. The solver calls this check in its inner loop. It must run in
milliseconds for layouts of a few hundred entities.

### 7.3 Tick simulator (final gate)

Hand-ported simulation of the game's update logic at 60 ticks per second:

- belt cargo movement and stacking,
- sorter pickup and dropoff timing (including stacking),
- facility craft cycles, input buffering, and output blocking,
- spray coaters and proliferator consumption,
- power network satisfaction (an under-powered network slows entities),
- the station as an unlimited source for imports and an unlimited sink for exports.

Run for a warm-up period followed by a measurement window (defaults: 2 and 5 game-minutes). Pass
requires measured target output ≥ 99% of the plan's rate, no deadlocked entity, and no permanently
starved entity that the plan says should be busy.

Every ported TypeScript function names the game method it mirrors. These method names are the
entries in `data/fingerprints.json` (§4.4).

### 7.4 Power report

Steady-state draw (measured), idle draw, and peak draw including station charging at the
blueprint's configured charging power. The plan's estimate is shown next to the measured figure.

## 8. Blueprint codec (`blueprint`)

- Format: `BLUEPRINT:0,<layout>,<icon0..4>,<timestamp>,<gameVersion>,<shortDesc>,<desc>"<base64(gzip(binary))>"<hash>`.
- The binary layout mirrors the game's `BlueprintData` import/export code: header, areas,
  buildings (index, area, local offsets, yaw, item/model ids, input/output links and slots,
  recipe, sorter filter, parameters such as station slot config, storage limits, charging power,
  and drone/vessel counts).
- The hash is the game's modified-MD5 variant, ported from decompiled code.
- Both decode and encode are implemented. Decode exists for tests and for importing motifs from
  in-game designs.

## 9. UI (Svelte 5)

One page, with configuration on the left and results on the right.

Configuration:
1. Target item search. Rate or building count. Final-stage facility.
2. Technology picker: searchable list, "unlock everything up to X" (includes prerequisites),
   saved as a named profile in `localStorage`.
3. Inputs: recipe tree for the target. Toggle each item between **supply** and **make**. The plan
   updates live.
4. Options: proliferator tier and mode, per-recipe facility overrides, solver time budget.

Results:
- Plan table: stages, counts, utilization, imports/exports, estimated power.
- Solve: progress (elapsed, best footprint, validated count) and **Stop & use best**.
- Layout preview: top-down 2D canvas with a height-layer slider and item color coding.
- Validation report.
- Blueprint: copy to clipboard and download `.txt`.

Without icons the UI falls back to item names.

## 10. Error handling

- Extraction: missing install, unreadable assets, or schema validation failure exits non-zero
  with an actionable message. Partial output is never written.
- App load: schema mismatch on the data file shows a blocking error naming the file and the
  failing field.
- Calculator infeasible (e.g. the target needs a recipe whose tech is locked, or a needed item is
  neither supplied nor craftable): the UI names the missing item or tech.
- Solver: if the time budget expires before any validated layout exists, report failure with the
  blocking violations. Per §6.2 this is treated as a bug to fix, not a normal outcome.
- Blueprint decode: malformed string or bad hash produces a specific error.

## 11. Testing

- **Extractor (pytest):** Steam discovery against fixture directory trees (Linux, Flatpak,
  Windows, macOS layouts). The schema is validated on output. Golden-file test on a small synthetic
  asset bundle where possible.
- **Data schema:** a single zod schema, exported as JSON Schema for Python.
- **Blueprint codec (Vitest):** byte-identical round-trip of real blueprints exported from the
  game. Hash matches for each.
- **Calculator:** known ratios (e.g. per-second requirements for standard chains), alternate
  recipe selection, by-product export, ceiling and utilization.
- **Validator:** one pass case and one fail case per geometry rule. Rate-capacity cases.
- **Simulator accuracy:** regression set of blueprints confirmed in-game, each recorded with the
  output rate observed in-game. Simulated rate must match within 2%.
- **Solver:** property test: for random feasible plans, every emitted layout passes the validator.
  Benchmarks record time to first valid layout and best footprint per reference plan.

## 12. Milestones

Each milestone gets its own implementation plan.

- **M0 — Foundations and format risk.** Repo scaffolding (Python tool, Vite+Svelte app). Extractor
  with Steam discovery, data JSON, version, fingerprints. Blueprint decode/encode with round-trip
  tests. One hand-built blueprint generated by code that pastes successfully in-game.
- **M1 — Calculator and UI shell.** Configuration UI and plan table with a power estimate. No
  layout yet.
- **M2 — Validator.** Geometry, rate-capacity, tick simulator, power report. Validated against the
  regression set from the game.
- **M3 — Solver v1.** Valid layouts with loose packing for short chains, end to end to a blueprint
  string.
- **M4 — Density.** 3D routing improvements, motif library, annealing tuning, benchmarks.
- **M5 — Extras.** Spray-coater layouts, multi-station blocks, by-product export slots.

## 13. Open risks

- **Simulator accuracy** depends on how faithfully the game logic is ported. Mitigated by the
  regression set from the game and by drift detection.
- **Planet-grid geometry**: blueprint coordinates vs. grid distortion away from the equator.
  M0 confirms the model with a hand-built blueprint.
- **Solver time on large chains** (hundreds of entities) may exceed the budget before density
  converges. The fallback guarantees validity. Benchmarks in M4 quantify the gap.
- **UnityPy compatibility** with the game's Unity version. Verified in M0, the first step of
  extraction.
