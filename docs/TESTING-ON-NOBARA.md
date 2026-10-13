# Testing the planner on Nobara (Dyson Sphere Program under Proton)

This is the runbook for the one thing the developer machine cannot do: run the extractor against your real game files,
generate blueprints from the app, paste them into the game and check that they work. You need the game installed
through Steam, a Linux shell, and no knowledge of the code.

What you do, in order:

1. [Set up](#1-set-up-once): Node, Python, the .NET SDK and the decompiler, about 20 minutes.
2. [Run the extractor](#2-extract-the-game-data): it reads the installed game and writes `data/dsp-<gameVersion>.json`.
3. [Run the app](#3-run-the-app) and generate blueprints from your own data.
4. [Paste the blueprints in the game](#4-try-it-in-the-game) and check them with the numbered list in
   [section 5](#5-unverified-conventions--please-check-in-game).
5. [Send back](#6-what-to-send-back) what is needed when something is off.

## 0. What is approximate until you have done this

- Until the extractor has run, the app uses a committed **fixture** (`data/fixture/dsp-fixture.json`, game version 0.10.29)
  whose building footprints and sorter slot positions are **estimates**. The app says so ("Geometry: approximate (fixture
  data)" in the header, a warning above the blueprint, and `[geometry: approximate - unverified in game]` in the
  blueprint's own description). Blueprints made from it may overlap or leave belts unconnected in the game.
- After the extraction the footprints and slot positions come from the game's prefabs, and the flag goes away once every
  building could be read (any building that could not be read keeps the flag). **No flag does not mean verified.** The yaw and axis convention, the belt and sorter
  record details and the station port details have never been checked in the game; that is what section 5 is for.
- The simulator that validates every layout re-implements the game's logic from decompiled code. It is meant to match
  measured rates within 2 %; that has not been measured yet. Your measurements (section 7) are the first real data.

## 1. Set up (once)

Everything runs from a checkout of this repository, on the branch `feat/planner`. The repository has no remote
configured, so copy it over the way you prefer (for example `git clone ssh://<your-mac>/<path>/dsp`, or `git bundle`) and
then:

```bash
cd dsp
git checkout feat/planner
```

**Node 22** (`.nvmrc` pins it; 22.13 or newer is needed):

```bash
sudo dnf install nodejs npm
node --version        # must print v22.13 or newer in the v22 series
```

If it prints another major version, use [nvm](https://github.com/nvm-sh/nvm) instead: after installing it, `nvm install` in
the repository root reads `.nvmrc`.

**Python 3.11 or newer** (`python3 --version`; Nobara ships a recent one).

**.NET 10 SDK and `ilspycmd`**, the decompiler the extractor uses (it reads the game's code for a few constants and for
the drift check). `ilspycmd` 10.x and 11.x target .NET 10:

```bash
sudo dnf install python3 python3-pip dotnet-sdk-10.0
#   If dnf has no dotnet-sdk-10.0, use Microsoft's installer (it installs into ~/.dotnet):
#     curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
#     bash dotnet-install.sh --channel 10.0

# Only after a script install (the dnf package needs neither line; leave DOTNET_ROOT unset then):
[ -x "$HOME/.dotnet/dotnet" ] && export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$PATH:$HOME/.dotnet:$HOME/.dotnet/tools"

dotnet tool install -g ilspycmd
```

`DOTNET_ROOT` matters only when `dotnet` is the one in `~/.dotnet`. `dsp-extract` also looks in `~/.dotnet/tools` for
`ilspycmd` by itself, so the `PATH` line is only for running `ilspycmd` by hand. Without `ilspycmd` the extraction still
runs, but the game version then comes from the Steam build id, the code constants keep their defaults and the fingerprints
are not updated (details: `tools/extract/README.md`).

**The extractor**, in a virtual environment (from the repository root):

```bash
python3 -m venv tools/extract/.venv
source tools/extract/.venv/bin/activate
pip install -e 'tools/extract[game,dev]'
```

Run `source tools/extract/.venv/bin/activate` again in every new shell before `dsp-extract`. The `game` extra (UnityPy and
TypeTreeGeneratorAPI) is what reads the game; without it the command stops at once (exit 3) and prints
`pip install 'dsp-extract[game]'`. That hint does not work from a checkout: run `pip install -e 'tools/extract[game,dev]'`
in the activated environment, as above.

**The app's packages**:

```bash
cd app && npm install && cd ..
```

**A quick self-check** (optional, none of it needs the game):

```bash
cd app && npm test && cd ..                  # about 20 s; a timing test can fail on a busy machine, run it again
tools/extract/.venv/bin/pytest tools/extract
```

Both should end green. If not, send back the first failing test's output.

## 2. Extract the game data

Run these from the repository root with the virtual environment active.

```bash
dsp-extract inspect                        # first: a quick look, writes only local/extract-report.json
dsp-extract --copy-blueprints --icons      # then the real extraction
```

The extractor finds Dyson Sphere Program through Steam's library files (`~/.local/share/Steam`, `~/.steam/steam` and the
Flatpak Steam), so a game on a second drive is found too. If it does not find it (exit 2), point it at the game folder, or
its `DSPGAME_Data` folder, yourself:

```bash
dsp-extract inspect --game-dir "/path/to/steamapps/common/Dyson Sphere Program"
dsp-extract --game-dir "/path/to/steamapps/common/Dyson Sphere Program" --copy-blueprints --icons
```

`inspect` takes about a minute and writes no game data. It prints the Unity version, how many entries each ProtoSet class has
(items, recipes, techs, buildings ...) and a walk through five sample building prefabs. If it fails, the full run will too:
send the report (section 6) before going on. The full run decompiles a handful of game classes (`ilspycmd`, the slow
step, several minutes), reads the assets, checks the result against `data/schema/gamedata.schema.json` and only then writes.

What the options do (from `dsp-extract --help`):

| Option | What it does |
|---|---|
| `--copy-blueprints` | Copies your own `.txt` blueprints out of the game's Proton prefix (see below). |
| `--icons` | Exports the item icons to `app/public/icons/` for the app. A failure here only warns. |
| `--game-dir PATH` | Where the game is, if Steam discovery does not find it. |
| `--strict` | Exit 3 after writing if the report has any errors (without it, errors in the report do not change the exit code; the summary still lists them). Use it when you want a failing building read to be impossible to miss. |
| `--allow-partial` | Write the data even if more than 25 % of the buildings could not be read from their prefab. Without it that case exits 3 and writes nothing. Only for a look at the damage; never trust the geometry of such a file. |
| `--no-decompile` | Skip `ilspycmd`. |
| `--check` | After a game patch, see section 8. |
| `--out DIR`, `--report PATH` | Where the data and the report go (defaults `data/` and `local/extract-report.json`). |

(`dsp-extract fixture --from DIR --out FILE` also exists; it rebuilds the committed fixture from a third-party dump and is
for the developer only.)

**What a good run ends with** (the "dsp-extract result" block):

```
Game version: 0.10.xx.xxxxx, Steam build NNNNNNN
Wrote .../data/dsp-<gameVersion>.json (N items, N recipes, N techs, N buildings)
Building geometry: N extracted, M approximate
Code constants read from the game: ...
Fingerprints (.../data/fingerprints.json): written (19 methods)
Drift: 0 changed, 0 missing, 19 new (mirrored game methods)
  new     AssemblerComponent.InternalUpdate -> app/src/lib/validate/sim/machine.ts
  new     AssemblerComponent.UpdateNeeds -> app/src/lib/validate/sim/machine.ts
  new     BlueprintData.Export -> app/src/lib/blueprint/codec.ts
  new     BlueprintData.Import -> app/src/lib/blueprint/codec.ts
  new     BuildTool_Click.CheckBuildConditions -> app/src/lib/validate/geometry-checks.ts
  new     BuildTool_Inserter.CheckBuildConditions -> app/src/lib/geometry/sorter-rules.ts
  new     BuildTool_Path.CheckBuildConditions -> app/src/lib/validate/geometry-checks.ts
  new     CargoPath.TryInsertItem -> app/src/lib/validate/sim/belt.ts
  new     CargoPath.TryInsertItemAtHeadAndFillBlank -> app/src/lib/validate/sim/belt.ts
  new     CargoPath.TryPickItem -> app/src/lib/validate/sim/belt.ts
  new     CargoPath.TryPickItemAtRear -> app/src/lib/validate/sim/belt.ts
  new     CargoPath.Update -> app/src/lib/validate/sim/belt.ts
  new     InserterComponent.InternalUpdate -> app/src/lib/validate/sim/sorter.ts
  new     LabComponent.InternalUpdateAssemble -> app/src/lib/validate/sim/machine.ts
  new     MD5F.Compute -> app/src/lib/blueprint/md5f.ts
  new     PowerSystem.GameTick -> app/src/lib/validate/sim/world.ts
  new     SpraycoaterComponent.InternalUpdate -> app/src/lib/validate/sim/coater.ts
  new     StationComponent.UpdateInputSlots -> app/src/lib/validate/sim/station.ts
  new     StationComponent.UpdateOutputSlots -> app/src/lib/validate/sim/station.ts
Icons: N exported to .../app/public/icons
Blueprints: N copied to .../app/test/fixtures/blueprints/game
Report: 0 errors, K warnings -> .../local/extract-report.json
```

The `, Steam build NNNNNNN` is there when the Steam manifest was found. If the version line instead ends with "(no GameConfig
version: this is the Steam build id ...)", `ilspycmd` did not run: install it and run again. The **Drift block** is what the
first run looks like: `data/fingerprints.json` is committed empty (`{}`), so every game method the app re-implements is
reported as `new` and recorded. That is not drift. The count is the number of those methods the decompile found (19 when
every game class decompiled; fewer, with a warning in the report, otherwise). From the second run on the line reads
`Drift: 0 changed, 0 missing, 0 new` unless the game changed. Commit `data/fingerprints.json` after the first run.

"approximate" geometry means a building whose collider or slot positions the extractor could not read; the summary lists the
first ten. A few are expected; most of them are not. A line "WARNING: N buildings could not be read from the game prefab" is
the one to report.

**Exit codes**

| Code | Meaning | What to do |
|---|---|---|
| 0 | GameData written. | Go on. |
| 2 | Dyson Sphere Program not found (the message lists everything it searched), or a command line mistake. | Use `--game-dir`. If that fails too, send back what section 6 lists for exit 2. |
| 3 | Extraction failed and nothing was written: a missing class, key or field (the game version differs from the one the reader was written against), the missing `game` extra (fix: `pip install -e 'tools/extract[game,dev]'`), or too many unreadable buildings. Also `--strict` with errors in the report. | Send the report and the terminal output. |
| 4 | The extracted data failed schema validation; nothing was written. | Send the report and the terminal output. |
| 5 | `--check` found a mirrored game method that changed. | Only after a patch, section 8. |

**Where things go.** The data file is `data/dsp-<gameVersion>.json` and `data/fingerprints.json` is updated next to it:
both are meant to be committed (they are the extraction of your game). The report in `local/`, the decompiled sources in
`local/decompiled/` and the icons in `app/public/icons/` are never committed (gitignored).

**`--copy-blueprints`.** On Linux the game keeps your saved blueprints as `.txt` files in its Proton prefix:

```
<Steam library>/steamapps/compatdata/1366540/pfx/drive_c/users/steamuser/Documents/Dyson Sphere Program/Blueprint/
```

for example `~/.local/share/Steam/steamapps/compatdata/1366540/pfx/drive_c/users/steamuser/Documents/Dyson Sphere Program/Blueprint/`.
The extractor takes the Steam library the game is installed in and copies every `.txt` below that folder, keeping the
sub-folder layout, to `app/test/fixtures/blueprints/game/`. It prints how many it copied; if the folder does not exist
(game never run, or another prefix) it only warns and you copy the files by hand. These are your own blueprints, handy as
regression material (section 7); that folder is not gitignored, so do not commit it if they are private.

## 3. Run the app

```bash
cd app
npm run dev
```

Open <http://localhost:5173/> (Vite prints the address). The app is a local page: it makes no network requests and needs no
backend. After a new extraction, stop the server (Ctrl+C) and start it again so it picks the new file up.

**Which data it loads.** The app looks in the repository's `data/` folder (not in `app/`) for `data/dsp-*.json`, and uses
the one with the highest game version. Only when there is none does it fall back to `data/fixture/dsp-fixture.json`. The
top right of the page says which one is in use: "Game 0.10.xx.xxxxx, extracted data" or "..., fixture data". If a data file
is damaged, or has a `schemaVersion` the app does not know, the page shows "Cannot use game data file <name>" with the
reason. **It does not fall back to the fixture in that case** (a broken extraction must not be ignored silently), so the page
stays stuck on that message until the file is fixed or moved. To carry on with the fixture meanwhile, move the extracted
files out of `data/` from the repository root and restart `npm run dev`:

```bash
mkdir -p local/aside && mv data/dsp-*.json local/aside/      # data/fingerprints.json stays where it is
```

(`local/` is gitignored.) Send back the full text of the message, `head -c 600 local/aside/dsp-*.json`, the output of the
extraction run that wrote the file, and `local/extract-report.json`.

**Using it**

1. **Target**: search the item, choose Rate (per second or per minute) or a number of final buildings.
2. **Technology**: "Unlock all" (default) or the techs you have; this decides which recipes, buildings and belt and sorter
   tiers the plan may use. For the in-game tests, match it to the save you paste into.
3. **Inputs**: for every intermediate item choose Supply (the station gets it from outside) or Make (the block builds it).
   The raw resources (ores, water, oil ...) are supplied by default.
4. **Options** (below), then press **Solve**. The plan table updates at once; the layout solver then works until its time
   budget runs out, or earlier (see below). "Stop & use best" ends it whenever you like and keeps the best layout so far.
5. The **Validation** panel shows PASS or FAIL for the layout: geometry rules, belt and sorter capacity, and a tick
   simulation of the block (target rate, power). Only a layout that passes is offered as a blueprint.
6. The **Blueprint** panel has the string, **Copy** and **Download .txt**. It reminds you to paste within the equatorial band
   (about 28 degrees of latitude either side of the equator).

**The options worth knowing**

- **Time budget** (default 10 minutes). How long the solver looks for a layout and keeps shrinking it. A solve that has no
  valid layout by then stops and says so (see [Known limitations](#known-limitations-of-the-layout-solver): very large plans
  can take the router longer than any budget). Once there is a layout it keeps shrinking it until the budget runs out, or
  earlier when the footprint has not improved in the last 20 % of the elapsed time (after at least 30 s). It never changes
  the plan, only how compact the layout is. For these tests 1 to 2 minutes is enough for a compact layout of the small blocks, and a larger footprint matters less than a block that works.
- **Proliferator** (None, Mk.I, Mk.II, Mk.III; Extra products or Speed-up). Chosen for each build, before you press Solve.
  It changes the plan (machine counts, power) and the block: spray coaters on the belts of proliferated stages, one raised
  feed belt that reaches all coaters, and a station slot for the proliferator. **You must put that proliferator into the
  station by hand** (the plan table lists the rate it needs), like every other supplied item. Leave it at None for the first
  tests.
- **Machine headroom** (default 1 %). A stage that would keep less than this share of its machines spare gets at least one
  more machine (`ceil(exact need x (1 + headroom))`), so at 1 % any stage that would run above 99 % busy gets another. That
  keeps the output from dipping below the plan rate; it is why a block has slightly more machines than you may expect.
  0 sizes every stage to its exact need. A request by building count keeps the final stage at the count you gave.
- **Use dense motifs not yet verified in-game** (off by default). Direct insertion between machines, belts shared by two
  rows of machines and stacked labs make the layout much smaller, but they rely on game rules nobody has confirmed. Leave it
  off until the plain blocks work; section 5 item 12 is what to check when you turn it on.
- **Logistics stations**: Planetary (default) or Interstellar, and the charging power. **Alternate recipes** and
  **Facilities** let you pick another recipe or machine for a stage.

## 4. Try it in the game

**Prepare a save.** Start a new game in **Sandbox mode** (so buildings cost nothing and you can put items into stations),
on a planet, and stay within the equatorial band, about 28 degrees of latitude either side of the equator and preferably as
close to the equator as you can: the planner assumes a grid tile of 1.2566 m, which is exact only at the equator, and the
game can refuse a blueprint pasted in the wrong band. Find flat, open ground (the larger blocks need hundreds of
tiles; the Quantum Chip block would need far more than that, so start small). Make sure the buildings the plan uses are
unlocked in that save, and that the app's technology selection matches it. The block carries Tesla towers; connect one to
a power source sized by the power figures in the app's Validation panel (steady and peak; the plan table shows an estimate
before you solve). The peak includes the stations charging: 12 MW for each Planetary Logistics Station and 60 MW for each
Interstellar one.

**Getting a blueprint into the game.** Either:

- press **Copy** in the app's Blueprint panel, open the game's blueprint browser and import from the clipboard (the
  game has a paste-from-clipboard function there); or
- press **Download .txt**, and put the file into the game's Blueprint folder (the path in section 2) so that the blueprint
  browser lists it.

The names of the buttons and hotkeys above are not checked against a running game and may differ a little in your version.
Under Proton the clipboard usually works between a native browser and the game; if the game says the clipboard holds no
blueprint, use the file route (that the browser lists a file dropped in by hand is itself unverified). Report which route
worked in the result sheet (section 6).

**Before measuring.** The block takes its raw materials from its station and delivers its product to it. Open the station:
the product has a supply slot, every supplied item a demand slot. In sandbox mode put enough of each supplied item into its
slot, and do not let anything else take the product out (no drones or vessels that demand it). A slot holds at most its
`max`, which the planner writes from the station data: 5000 items for a Planetary Logistics Station and 10000 for an
Interstellar one. So a supplied item that the block uses at 6 per second empties a 5000-item slot in about 14 minutes (5000 /
6 = 833 s): top it up during the test, or connect the station to your network so that something keeps it stocked.

**The product slot fills up too.** Nothing takes the product out of its supply slot, so the slot rises to its `max`, the
station then refuses more and the block stalls. A block that delivers 1 item per second fills a 5000-item slot in about 83
minutes (3 per second: 28 minutes). Either read the rate early, within the first minutes after the block has filled, or keep
the product slot below its `max` by taking items out by hand in sandbox mode (or by connecting the station to the network, so
that another station demands the product). If you take items out between two readings, add them: rate = (second reading -
first reading + items taken out) / seconds.

**Measuring the output rate.** Let the block run until it is full: all machines busy, belts full. Then read the station's
stock of the product, wait at least 60 seconds of game time (several minutes is better, and use the game clock, not wall
time; do not change the game speed), read it again. Rate = difference / seconds. A small block fills in minutes. A large
one can take hours of game time before its output settles, and its product slot would reach its `max` long before that if
left alone (3 per second: 28 minutes), so keep emptying it while the block fills, as above. For the measured number that you
send back, wait at least ten game minutes after the block is full.

### The three tests, in this order

**A. The hand-made M0 smelter row.** From `app/`:

```bash
npm run emit:test-bp
```

writes `local/test-blueprints/m0-smelter-row.txt` (the file you paste, one `BLUEPRINT:...` line). It is built by hand, not
by the solver, and always from the fixture geometry, also after the extraction (so it does not change when you extract). The
app therefore has no preview of it, and the preview of the other blocks does not show which way a belt flows (it shows
buildings, belts by item, and sorters as arrows from pick to drop). This plan view is the reference. North is up, east is
right, one cell is one tile; the x numbers are tiles east of the station's centre, the y numbers tiles north of it:

```
      -15 -14 -13 -12 -11 -10  -9  -8  -7  -6  -5  -4  -3  -2  -1   0
y=2        T                   T                   T
y=1        <   <   <   <   <   <   <   <   <   <  <P3 ILS ILS ILS ILS
               v           v           v
y=0    #   #   #   #   #   #   #   #   #       >  >P4 ILS ILS ILS ILS
y=-1   #   3   #   #   2   #   #   1   #       ^      ILS ILS ILS ILS
y=-2   #   #   #   #   #   #   #   #   #       ^
               v           v           v
y=-3       >   >   >   >   >   >   >   >   >   ^
```

- `ILS`: the Interstellar Logistics Station, centre (0, 0), continuing east. Its first slot ("slot 0" in the in-game blueprint description) is Iron Ore (demand) and its second ("slot 1") Iron
  Ingot (supply). Two of its three west-face ports are used: **P3**, the north one, is an output port for the ore slot
  (the ore leaves here), **P4**, the middle one (y = 0), an input port (the ingots arrive here; the hand-made blueprint writes
  storage index 0 on it, see item 5).
- `<` `>` `^`: belt nodes, pointing the way items flow. The **ore belt** (Mk.I) runs along y = 1 from P3 at (-4, 1) west to
  (-14, 1) and ends there. The **ingot belt** starts at (-14, -3), flows east along y = -3 to (-5, -3), turns north there
  (corner 1), runs north to (-5, 0), turns east there (corner 2) and ends in P4 through (-4, 0).
- `#` and the digits: the three Arc Smelters (3 x 3 tiles, recipe Iron Ingot), `1` at (-8, -1) nearest the station, `2` at
  (-11, -1), `3` at (-14, -1).
- `v` between the ore belt and a smelter: an **input sorter** (Mk.I) taking from the ore belt into the smelter's north face.
  `v` between a smelter and the ingot belt: an **output sorter** (Mk.I, filter Iron Ingot) taking from the smelter's south
  face onto the ingot belt. Each sorter stands at the east (station-side) end of its smelter's face, 0.8 tile east of the
  smelter's centre, at x = -7.2, -10.2 and -13.2.
- `T`: Tesla towers at (-4, 2), (-9, 2) and (-14, 2).

Paste it on flat ground; **you choose the paste orientation** in the game, so turn the ghost until the station is on the
east side as drawn (or compare after turning your screenshot; see item 1). Connect a tower to power. Put Iron Ore into the
station's ore slot. Check that the buildings and belts are positioned and connected as the figure shows (ore flows west out
of P3, each input sorter feeds its smelter, the output sorters put the ingots on the south belt, the ingots flow east round
both corners into P4, and the station's Iron Ingot count rises) and measure the ingot rate. Expected: about 3 ingots per
second (three smelters at one ingot per second each). This test mostly exercises checklist items 1, 2, 4 and 5.

**B. One Circuit Board per second.** In the app: target Circuit Board, Rate 1 /s, proliferator None, everything else at the
defaults; Solve; copy the blueprint; paste. Put Iron Ore and Copper Ore into the station. Expected output: 1 Circuit Board
per second at least (the Validation panel's "Capacity (simulated)" is what the layout should deliver).

**C. The Processor block.** Target Processor, Rate 1 /s (or whatever you like to measure), proliferator None. Supplied: Iron
Ore, Copper Ore and Silicon Ore (the defaults). Same procedure. It is bigger, has more belts and nets and more machine
types, and is the first block where belts really have to cross and merge.

**For each test, write down**: did the paste succeed (any error message, exactly)? Did everything connect (what did not)?
What was the measured output rate and how did you measure it? Compare it with the plan table's rate and with the
Validation panel's "Capacity (simulated)". Section 6 says what to send.

### Optional follow-up blocks

These cover the checklist items that the three tests cannot (build them after A to C work):

- **Labs** (item 9): target Electromagnetic Matrix, 1 to 2 /s.
- **Spray coaters and the proliferator feed** (items 10 and 11): the Processor with the proliferator set to Mk.III, Extra
  products. It needs two stations and puts the proliferator into its own slot; stock that slot.
- **By-product export** (item 7): target Refined Oil, give it the alternate recipe Plasma Refining (Alternate recipes
  fieldset, appears once the item is the target), Crude Oil supplied. The by-product Hydrogen goes back into the station.
- **More than one station** (item 8): any plan that says "2 stations" in the plan table, for example the Processor with
  Mk.III above.
- **Dense motifs** (item 12): any of the above again with the motif box ticked.
- **Interstellar station** (item 6): Test B again with the station kind set to Interstellar, and the two-station Processor with
  Mk.III (above) once more with it, to see an Interstellar station as the second one.

## 5. Unverified conventions — please check in game

Everything here is an assumption the planner makes that has not been tested in the game. For each item: what to look at,
how to tell right from wrong, and what to send back. If you cannot check an item with the blocks you have built, skip it;
say so rather than guessing. In "send back", "the blueprint" always means the `.txt` or the string, and a screenshot is
best taken from above with the app's layout preview next to it.

**1. Yaw and axis convention** (every block; test A shows it best).
- Look at: the **relative arrangement**, not the absolute orientation. You choose how the blueprint is turned when you place
  it, so a block that is turned as a whole (by 90, 180 or 270 degrees) is **not** a fault: turn the ghost, or your screenshot,
  until it reads like the reference, then compare. For test A the reference is the plan view above: with the station on the
  east, the ore belt is the north row and flows west, the ingot belt the south row and flows east and then north, the input
  sorters are on the smelters' north faces and the output sorters on their south faces, all at the end nearest the station,
  and P3 (ore, output) is the northernmost of the station's three west-face ports and P4 (ingots, input) the middle one. For the generated blocks the reference is
  the app's layout preview (north up; boxes are buildings, arrows are sorters, belts are lines, belt flow is not shown): which
  side of each machine its sorters are on, which side of the station the ports are, which way the machines are turned
  relative to one another. The planner measures yaw clockwise from north, with x east and y north.
- Right: after turning the block as a whole, it is the reference. Wrong: a mirror image (with the station on the east, the ore
  belt on the south row, or the sorters on the far end of the smelters), a belt flowing the wrong way, or one kind of piece
  turned differently from the rest (for example the belts and sorters as in the reference but the station or the machines
  quarter-turned relative to them).
- Send back: the blueprint, a screenshot of the game and (for B and C) of the preview, and which relative difference you see.
  The fix is one function (`prefabToGrid`), so an exact description (for example "mirrored: the ore belt is south of the
  smelters when the station is east" or "the station is rotated 90 degrees clockwise relative to the smelters") is what makes
  it a one-line change.

**2. Corner belts** (test A has two corners on the ingot belt; every block has more).
- Look at: each place a belt turns. The planner turns a corner belt to the bisector of the incoming and outgoing headings.
- Right: the belt is continuous around the corner and items go round without stopping. Wrong: a gap, a corner piece
  facing the wrong way, or items that stop at the corner.
- Send back: a screenshot of one corner and its position in the block.

**3. Belt merges** (only blocks where one belt ends against the side of another; test A has none, larger blocks may).
- Look at: such a junction. A side join is written as input slot 2 of the target belt, the straight continuation as slot 1.
  Left-side and right-side joins are separate cases: check each one you find.
- Right: items from the joining belt enter the main belt, and the main belt keeps flowing past the junction. Wrong: the
  joining belt's items stop, or the main belt is blocked or cut after the junction.
- Send back: which side, a screenshot, the blueprint.

**4. Sorters** (every block).
- Look at: that each sorter is attached to the intended slot of its machine or station and to the intended belt cell. The
  planner writes the sorters' pick and drop offsets as 0 (real samples show 0, 4 and -1). Also look at the sorters that
  reach 2 or 3 cells over another net's belt.
- Right: items move machine to belt and belt to machine, no sorter shows as disconnected, and the long sorters that pass
  over another belt are built and work. Wrong: a sorter that hangs in the air or attaches to a different slot than in the
  preview, one that will not paste, or a long sorter that moves nothing.
- Send back: a screenshot of the sorter, the machine type and slot, the blueprint.

**5. Station slots and ports** (every block; the Planetary Logistics Station, the default).
- Look at: open the station. In the planner's stations the first slot is the product, then the supplied items by rate, then
  the proliferator, then by-products. Each port is wired to one slot (the planner writes the slot's 1-based number as the
  port's storage index, also on input ports) and has a direction (into or out of the station). The hand-made test A writes 0
  as the storage index on its ingot input port instead.
- Right: every input port delivers into a slot of its item and the count rises; every output port takes from its slot. Wrong:
  the product count stays at 0 while its input belt fills up and backs up (the port is not counted for the slot), or a port
  has the wrong direction or points at another slot.
- Send back: a screenshot of the station's slot list and port settings, and the blueprint. Also say whether test A (storage
  index 0) and a generated block (slot number) behave differently, because the game may need one or the other.

**6. Interstellar Logistics Station** (Test B with the Interstellar station kind).
- Look at: the same things as item 5, plus that every slot's local and remote logic are equal, and that the belt stubs at the
  station's ports (two extra belt records between the station and the first node) connect, as they do at a Planetary
  station.
- Also, with the same Interstellar setting, a plan that needs two stations (the Processor with Mk.III proliferator): the
  second station is an Interstellar one as well. In the data an Interstellar station has 5 item slots and 12 ports; open
  it and check that its slots (remote logic equal to local logic on each) and its ports are what the blueprint should have
  given it, not only the first station's.
- Right: it behaves like the Planetary one. Wrong: ports that do not connect at the Interstellar station only, a second
  station that lacks slots or ports, or with a slot count or port count other than the layout configured for that station (later stations legitimately
  differ from the first).
- Send back: as item 5, for each station.

**7. By-products and pooled slots** (the Plasma Refining block; the Quantum Chip block made from raw materials).
- Look at: the Hydrogen from the Plasma Refining refineries arrives at an input port of the station, into a slot that is a
  supply slot (the block exports it). In a block that both imports and makes the same item (only the larger plans, for
  example a Quantum Chip block from raw materials; skip this part if you have no room for one), the made item goes through
  an input port into a slot that has demand logic, and the same station's output port supplies the consumers.
- Right: the slot fills and the input port only blocks when the slot is full; the refineries keep their rate over ten or
  more minutes, with and without drones or vessels delivering that item; vessels or drones of a station that demands the
  by-product can take it from the slot. Wrong: the by-product belt backs up and a refinery
  stalls with a slot that is not full; or a demand slot that sits at its maximum (kept full by vessels) stops accepting what
  the block makes locally.
- Send back: the station's slot screenshot, whether the refinery shows "output blocked", the blueprint.

**8. More than one station in one blueprint** (plans that need 2 or more stations).
- Look at: the stations are placed in a column at the west edge of the block, each about 16 to 18 tiles north of the one
  before. Check: it pastes without overlaps; each station is connected to its own belts; each station's own configuration
  (slots, port directions, storage indices) after paste, the second and later ones as well as the first; power reaches all
  of them. The app's power figures count the stations of the layout.
- Right: all stations work like a single one would. Wrong: a station without belts or power, a station whose slots or ports
  are not what the preview shows, or stations that overlap.
- Send back: a screenshot of each station's configuration, the blueprint.

**9. Labs** (Electromagnetic Matrix block).
- Look at: that the Matrix Labs arrive in matrix-synthesis mode (the blueprint writes the parameters `[1, proliferator
  mode]`) with the recipe set, and produce.
- Right: each lab shows the matrix recipe and works. Wrong: a lab in research mode (asking for a tech), or idle with
  everything delivered.
- Send back: a screenshot of a lab's panel, the blueprint.

**10. Spray coaters** (proliferator set to Mk.I, Mk.II or Mk.III).
- Look at: the coaters on the item belts. The planner assumes:
  - **(a) The top passage.** The proliferator belt passes through the top of each coater, at a point 1.25 m behind it and one
    level (1.33 m) above the item belt. That proliferator belt runs at that raised level and crosses the item belts at a
    right angle. This is what the one real sample shows; whether the game reads the belt at exactly that point is not known.
  - **(b) Either way round.** A coater may face either way on belts flowing in either direction.
  - **(c) Facings other than yaw 180.** All eight coaters of the one real sample are turned the same way (yaw 180) on
    north-south belts. Coaters at the other three facings (yaw 0, and 90 and 270 on east-west belts) exist only through the
    planner's yaw convention (item 1), so look at one coater of each facing in the block and check that each takes
    proliferator from the belt behind it.
  - **(d) Room beside a coater.** In the sample no sorter stands closer than 3.2 tiles to a coater, but the planner lets
    another net's sorter stand 1 to 2 tiles beside a coater's body, which may be too close for the game.
  - **(e) A coater near a station.** The planner may put a coater as close as 2 belt nodes from a station's port; nothing in
    the sample shows a coater near a station.
- Right: every coater draws proliferator from the belt above it and its output items are sprayed; the raised belt pastes and
  connects at every crossing; coaters work whichever way they face; a coater beside a sorter, or close to a station port,
  is built and works. Wrong: a coater that shows no proliferator although a belt runs above it (name its facing); a raised
  belt that will not connect to a coater; a coater beside another net's sorter, or next to a port, that cannot be placed
  or blocks it.
- Open question (an experiment, only if you like; it does not check the planner's output): the planner never runs a
  proliferator belt **along** a coater's axis over it, because its next node would be inside the coater's body. Whether the
  game would accept that arrangement is unknown. If you try one by hand, say whether the game lets you build it and
  whether the coater then takes proliferator from it.
- Send back: a screenshot of one working and one failing coater from the side and from above (with its facing), the blueprint.

**11. The proliferator feed belt** (same blocks as item 10).
- Look at: the belt leaves the station's output port flat for two cells, then lifts one level, runs over the item belts
  (sometimes above a sorter cell) and ends as a dead end at the last coater's top passage.
- Right: the proliferator reaches all coaters, the lift connects, the belt over a sorter pastes. Wrong: the lift is
  disconnected, the belt stops before the last coater, or it cannot be placed above a sorter.
- Send back: a screenshot of the lift and of the dead end, the blueprint. Also whether the station's proliferator slot (an
  output port from a demand slot) feeds the belt at all.

**12. Dense motifs** (only with "Use dense motifs not yet verified in-game" ticked).
- Look at: direct insertion (a sorter straight from one machine to the next, no belt); the shared-belt sandwich (two rows of
  machines taking from the same belt); stacked labs fed at the bottom; stacks that mix Matrix Labs and Self-evolution Labs;
  and power for tall stacks (does a Tesla tower that covers the bottom lab also power the top lab when the lab level is 6 or
  more?).
- Right: the sorters between buildings are built and move items; every lab in a stack works; the top labs of a tall stack
  are powered. Wrong: a sorter that will not place or does not connect, upper labs idle, upper labs without power.
- Send back: which motif, a screenshot, the blueprint. If a motif fails, the answer for you is to untick the option.

**13. Power.**
- Look at: the block's power use in the game's power panel with the block running at full output (and the peak while the
  stations charge) against the app's Validation panel ("Measured" steady and peak, "Plan estimate"). Real spray coater power
  rises with the stack size on its belt; the simulation does not model that.
- Right: close. Wrong: a large gap, or machines or towers reported as unpowered.
- Send back: both numbers and the block.

**14. Approximate geometry.**
- Look at: building footprints and slot positions come from estimates until the extractor has run. After the extraction
  regenerate and paste B and C again (and any optional block) and compare with the earlier result. Test A is the exception:
  `npm run emit:test-bp` always builds from the fixture, so A is the same blueprint before and after the extraction. The
  coater rules in particular were tuned on the estimated coater body; redo item 10 on extracted data.
- Right: no overlaps, no gaps in belts. Wrong: buildings overlapping or standing too far apart.
- Send back: the "Building geometry: N extracted, M approximate" line of the extractor and the buildings it lists, plus a
  screenshot of the error.

**15. Measured output.**
- Look at: the station's stock of the product, measured as in section 4 (with the product slot kept below its `max`, which
  is 5000 for a Planetary station), for at least ten game minutes after the block is full (large blocks can take hours of game
  time to fill, and need the product slot emptied from time to time while they do). Compare with the plan table's rate ("planned") and with the Validation
  panel's "Capacity (simulated)", which is what the layout should deliver; the layout is built with spare machines, so it
  normally delivers a little more than planned.
- Right: within 2 % of the simulated capacity (that is the simulator's accuracy target) and never below the planned rate.
  Wrong: lower than planned, or more than 2 % away from the simulated capacity.
- Send back: the measured number, how you measured it (readings and the time between them), the planned and simulated
  numbers, and a regression entry (section 7).

## 6. What to send back

| Situation | Send |
|---|---|
| Setup failed (`pip`, `dotnet`, `npm`) | The error output; the output of `python3 --version`, `dotnet --version`, `ilspycmd --version`, `node --version`. |
| Extractor exit 2 (game not found) | The terminal output, `ls ~/.local/share/Steam/steamapps` and `cat ~/.local/share/Steam/steamapps/libraryfolders.vdf`. |
| Extractor exit 3, 4 or a crash | **`local/extract-report.json`** (written on every run, crash tracebacks included; it has paths from your machine and the game's proto names, no game assets), the **terminal output** (the last screen), and any stack traces. |
| `dsp-extract inspect` looks wrong | `local/extract-report.json` and the output. |
| The app shows "Cannot use game data file ..." or cannot be solved | The full text of the message; the first lines of the data file (`head -c 600 data/dsp-*.json`). |
| A solve fails, or the Validation panel says FAIL | A screenshot or the text of the Validation panel, the plan table's summary and the options you set (target, rate, techs, proliferator, station kind, headroom, motifs). |
| An in-game problem | The result sheet below, the blueprint, screenshots. |

A result sheet for each block you try (copy into a message):

```
Game version (bottom of the main menu):
Data in use (header of the app: extracted or fixture; geometry flag shown?):
Block: (target, rate, options)
Paste worked? (exact message if not):
Everything connected? (what is not, where):
Planned rate / simulated capacity (app) / measured rate and how measured:
Checklist items checked: (number: ok / wrong - what)
Attached: blueprint .txt, screenshots
```

## 7. Recording a regression entry

A block that you have built and measured in the game is the most useful thing you can give the project: the tick simulator
is checked against it. Make a file `app/test/fixtures/regression/<name>.json`:

```json
{
  "blueprint": "BLUEPRINT:0,10,...",
  "gameVersion": "0.10.xx.xxxxx",
  "targetItemId": 1303,
  "measuredRates": { "1303": 0.99 },
  "notes": "what the block is, the save, how it was measured"
}
```

`measuredRates` maps item ids to items per second (include the target). `app/test/regression.test.ts` imports every such file,
imports the blueprint, simulates it for 20 game minutes of warm-up plus 5 game minutes, and requires each rate to match
within 2 %. Run it with `cd app && npx vitest run test/regression.test.ts` (it is also part of `npm test`). Item ids are
in the data file: `node -e "const d=require('./data/dsp-<gameVersion>.json'); for (const i of d.items) console.log(i.id, i.name)"`
from the repository root. The full format, how to measure and what a failure means are in
`app/test/fixtures/regression/README.md`. A block that delivers at least 1 item per second matches best.

## 8. After a game patch

```bash
source tools/extract/.venv/bin/activate
dsp-extract --check
```

This is the whole extraction again (it writes the new `data/dsp-<gameVersion>.json` too; the app uses the highest version,
so delete the old file if you do not want it around) plus a comparison of the game methods the app re-implements (belts,
sorters, stations, machines, labs, spray coaters, power, the blueprint codec ...) with `data/fingerprints.json`. Exit 5
lists the methods that changed or went missing, with a diff, and the TypeScript module to re-check for each. **Exit 0 only
means "nothing changed" if the summary says `Drift: 0 changed, 0 missing, 0 new`.** Two other exit-0 outcomes compared
nothing:
- Without `ilspycmd` (or if it cannot decompile), or if `data/fingerprints.json` cannot be read, there is no Drift line, and
  the run prints `dsp-extract: --check could not compare the mirrored game methods: fingerprints ...` on stderr and exits 0.
- With `data/fingerprints.json` still `{}` (no plain extraction has recorded the fingerprints yet; commit the file after the
  first run, section 2) every method is reported as `new`, which is not drift: `Drift: 0 changed, 0 missing, 19 new`, exit 0.

`--check` never rewrites the fingerprints, so you can run it again and see the same drift. Send back the output of an exit 5
and `local/extract-report.json`. When the drift is understood, run `dsp-extract` without `--check`: it accepts the new
fingerprints. Redo sections 3 to 5 on the new data if the patch touched anything you rely on.

## 9. Known approximations

The two research documents list the gaps in full: `docs/research/blueprint-format.md` section 10 and
`docs/research/mechanics.md` section 10. The ones that matter in your tests:

- Building colliders and sorter slot positions are unknown until the extraction (section 0); coaters, labs and stations
  inherit that.
- The meaning of the sorters' slot/offset fields and the z values of raised belt layers were inferred from sample
  blueprints and are checked by items 4, 10 and 11.
- Not fully known in the blueprint parameters: the splitter's, some power and mining buildings' parameter layouts (the
  planner does not use them), and how a header version 1 hash is computed (a game 0.10.34 export has a hash the codec
  cannot verify; the planner writes header version 0, so this affects only reading your own exports).
- The game's tick order, pile sorter behaviour, the power coverage formulas, the exact latitude limit for pasting, and the
  vertical reach of sorters are modelled from public sources and are the likely source of any simulator mismatch.

### Known limitations of the layout solver

These are known to fail or to be slow; none is a bug in the plan. The numbers come from the ladder sweeps (every producible
item planned at 1 per second, the fallback ladder alone; `app/test/ladder-sweep*.e2e.test.ts`, and the deep ones with
`npm run test:sweep-deep`).

- **Large plans often cannot be laid out.** The router cannot always lay out a plan of roughly **400 machines or more** (about
  **200 or more** with a proliferator, whose feed belt must reach every spray coater); some plans of that size do route (Small
  Carrier Rocket, 472 machines). The solver then tries the six rungs of its ladder, which can take longer than the time budget;
  at the budget it stops with **no layout** and a message that names the size of the plan ("No valid layout found within the
  time budget, with some layout attempts left. This plan has N machines; plans over ~400 machines (or ~200 with proliferator)
  often can't be laid out yet. A longer time budget (in Options) may help. Try a lower rate, or split the build."). When every
  rung was tried and failed first, the message says so and does not suggest a longer budget. Lower the rate, or plan the build in
  parts. There is no router rewrite planned.
- **The items this hits** at 1 per second (machines in brackets). Plain: Mini Fusion Power Plant (391), Interstellar Logistics
  Vessel (400), Advanced Mining Machine (834; its one routable rung reads 0.95 per second, the others leave 1 to 7 routing
  conflicts), Energy Exchanger (856), Interstellar Logistics Station (975), Miniature Particle Collider (1162), Artificial Star
  (1334). With Mk.III: Destroyer (343), Advanced Mining Machine (365), Artificial Star (590) and Vertical Launching Silo
  (1205), which fail at the proliferator feed belt or at routing. The plain Vertical Launching Silo (2749) did not finish: the
  sweep gave up on it after 6 hours. These are the items of the last full deep sweep that failed for their size; the rest of the
  sweep's items were not all re-run since, so treat the list as what is known, not as a guarantee for any other plan of that size.
- **Quantum Chemical Plant with Mk.III proliferator (208 machines) gives no layout.** Some rungs route, but the simulated
  block reaches 0.96 to 0.99 per second instead of 1. Cause: Graphene (advanced) makes Hydrogen as a by-product for Deuterium
  and Casimir Crystal, on six dead-end belts that are each planned exactly balanced, with 69 machines for 67.9 needed. A
  Deuterium machine whose product is not drawn idles, the Hydrogen belt that feeds it backs up, and the Graphene machines on
  that belt block for 37 % of the time: about 5 % of all Graphene machine time, three times the spare, so the other belts are
  short of Hydrogen and the Deuterium and Casimir Crystal stages run 4 % short. Neither the calculator's rates nor the
  simulator's machine speed are wrong (a machine that is 100 % busy makes exactly its theoretical maximum). Raising the
  **machine headroom** (Options) to 2 % (210 machines instead of 208: one more Graphene machine) gives a block that passes at
  1.04 per second.

**In game: a surplus export slot, only when the layout needed it.** Some plans have an item that two or more stages make and the
stages use (in practice Hydrogen, made by Graphene (advanced) and Plasma Refining). The solver first builds the layout with that
belt a dead end, as for any plan. Only if the simulation of a layout then deadlocks (Deuteron Fuel Rod with Mk.III does: the
second producer fills the Hydrogen belt and Plasma Refining, which also makes the oil the chain needs, blocks) does it build that
layout and the rest of its attempts with the belt ending at a station, in an export slot, so that the producers never block. The
progress line says "surplus export" when it did, the Solve panel and the blueprint description name the item, and the plan
table counts the slot ("N item slots, 1 of them for a surplus"). The plan view shows no such slot until a layout needs it.
The simulator's station takes whatever arrives without limit; the real slot stops at its `max` (5000 for a Planetary Logistics
Station), and once it is full the belt backs up as it would without the sink. Take the item out of that slot by hand (sandbox
mode) or let another station demand it, as for the product slot (section 4, "The product slot fills up too").

## 10. Command reference

From `app/` (`cd app`):

| Command | What it does |
|---|---|
| `npm run dev` | The app on <http://localhost:5173/>. |
| `npm run build` | A production build into `app/dist/`. |
| `npm test` | The unit tests (about 20 s), including `test/regression.test.ts` and `test/mirrors.test.ts`. |
| `npm run test:e2e` | The slow end-to-end tests (`test/*.e2e.test.ts`: the solver on real plans, both 102-item ladder sweeps, multi-station and proliferator plans), several minutes. |
| `npm run test:all` | Both of the above. |
| `npm run test:sweep-deep` | The deep ladder sweeps (the 37 items of more than 12 stages, plain and with Mk.III; hours). Failures are the known limitations in section 9. |
| `npm run lint`, `npm run check` | ESLint, and `svelte-check` (types). |
| `npm run emit:test-bp` | Writes `local/test-blueprints/m0-smelter-row.txt`. |
| `npm run bench -- --budget 30 --plans processor` | The solver benchmark; it appends a row to `docs/benchmarks.md` (add `--no-write` to only print it). |

From the repository root, with the environment active: `dsp-extract inspect`, `dsp-extract [--copy-blueprints] [--icons]
[--game-dir PATH] [--strict] [--allow-partial] [--check]`, and `tools/extract/.venv/bin/pytest tools/extract`.
