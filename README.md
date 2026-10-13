# DSP Factory Planner

A personal, local-only web app for Dyson Sphere Program: no backend and no network calls at runtime.
Pick a target product, your unlocked techs, the items supplied from outside and a rate or building count.
It produces a production plan, a validated densely packed factory layout as a blueprint string, and the power it needs.
Game data is extracted statically from the installed game by a Python tool (`tools/extract/`) and committed as JSON in `data/`; there are no game mods.
The app lives in `app/` (Vite + Svelte 5 + TypeScript); game binaries, decompiled source and icons are never committed.

## Dev commands

Node 22 (see `.nvmrc`) and Python 3.11+. Run from the repository root.

App (`app/`):

```sh
cd app && npm install && npm test && npm run lint && npm run build
npm run dev     # dev server
npm run check   # svelte-check
npm run test:e2e   # slow end-to-end tests (the solver on real plans, two 102-item ladder sweeps; 3 to 7 minutes); `npm test` leaves them out
npm run test:all   # both
npm run test:sweep-deep   # the deep ladder sweeps (the 37 items of more than 12 stages, plain and with Mk.III); hours, not part of `test:e2e`
npm run emit:test-bp   # hand-made in-game test blueprint -> local/test-blueprints/m0-smelter-row.txt
npm run bench -- --budget 60 --plans processor,quantum-chip,circuit-board,smelter-row   # solver benchmark; appends rows to docs/benchmarks.md
```

Extractor (`tools/extract/`, package `dsp_extract`):

```sh
python3 -m venv tools/extract/.venv && tools/extract/.venv/bin/pip install -e 'tools/extract[dev]' && tools/extract/.venv/bin/pytest tools/extract
```

The `game` extra (`pip install -e 'tools/extract[game]'`) adds UnityPy and TypeTreeGeneratorAPI, which are only needed to run the extraction against a real game install.

## Known limitations

- **Large plans may get no layout.** The router cannot lay out every plan of roughly **400 machines or more** (about **200 or
  more** with a proliferator). The solver stops at its time budget (Options, default 10 minutes), shows no layout and says how
  big the plan is; lower the rate or split the build. Mini Fusion Power Plant, Interstellar Logistics Vessel and Station,
  Advanced Mining Machine, Energy Exchanger, Miniature Particle Collider, Artificial Star and Vertical Launching Silo are such
  plans at 1 per second.
- **Quantum Chemical Plant with Mk.III proliferator** has a valid plan (208 machines) but no layout that holds 1 per second:
  by-product Hydrogen is stranded on dead-end belts. Raising the machine headroom (Options) to 2 % works around it.
- A layout that was found stuck without it (Hydrogen, in Deuteron Fuel Rod and Crystal Explosive Unit with Mk.III) ends the belt of a shared by-product at a station: that export slot appears only then, and you must drain it in game.
- The list, the causes and the numbers are in [docs/TESTING-ON-NOBARA.md](docs/TESTING-ON-NOBARA.md) (section 9, Known limitations).

## Quick start on Nobara (Dyson Sphere Program under Proton)

The whole procedure, with the in-game checklist and what to send back when something is off, is in
[docs/TESTING-ON-NOBARA.md](docs/TESTING-ON-NOBARA.md). In short, from the repository root:

```sh
# once: Node 22, Python 3.11+, the .NET 10 SDK and `dotnet tool install -g ilspycmd` (the runbook has the commands), then
python3 -m venv tools/extract/.venv && source tools/extract/.venv/bin/activate
pip install -e 'tools/extract[game,dev]' && (cd app && npm install)

dsp-extract inspect                        # a first look at your game files; writes local/extract-report.json only
dsp-extract --copy-blueprints --icons      # the extraction: writes data/dsp-<gameVersion>.json
(cd app && npm run emit:test-bp)           # local/test-blueprints/m0-smelter-row.txt: the first blueprint to paste in game
(cd app && npm run dev)                    # http://localhost:5173/; uses the extracted data automatically (Ctrl+C to stop)
```

The app reads `data/dsp-<gameVersion>.json` (the highest game version) and falls back to the committed fixture
`data/fixture/dsp-fixture.json` when there is none; the page header says which one is in use.

What is approximate until the extractor has run on your game: building footprints and sorter slot positions come from
the fixture, which only estimates them, so every blueprint made from it is flagged "geometry: approximate - unverified in
game" and may overlap or leave belts unconnected. Even with extracted geometry the yaw and axis convention and several belt,
sorter, station and spray coater details have not been tried in the game; the runbook lists each one to check, and the app
and every blueprint description keep a "conventions not yet verified in game" note until the first paste has come out right.
