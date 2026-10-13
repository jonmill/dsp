# dsp-extract

Reads your installed Dyson Sphere Program and writes the planner's game data:

- `data/dsp-<gameVersion>.json`: items, recipes, techs and buildings (with geometry), validated against
  `data/schema/gamedata.schema.json` before anything is written. Commit this file.
- `data/fingerprints.json`: a hash of each game method the TypeScript code re-implements, so a game patch that
  changes one is noticed (`--check`). Commit this too.
- `local/extract-report.json`: what was found, every warning and error, and the traceback of a crash. Written on
  every run, whether it works or not. Never committed.

Game files, the decompiled source (`local/decompiled/`) and icons (`app/public/icons/`) are never committed.

## Setup on Nobara Linux

Everything below runs from the repository root. Python 3.11 or newer is needed (Nobara ships it).

```bash
# 1. Python and the .NET SDK that ilspycmd needs (ilspycmd 10.x and 11.x target .NET 10)
sudo dnf install python3 python3-pip dotnet-sdk-10.0
#    If dnf has no dotnet-sdk-10.0, use Microsoft's installer instead (it installs into ~/.dotnet):
#      curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
#      bash dotnet-install.sh --channel 10.0

# 2. Make this shell find dotnet and the dotnet tools. Needed BEFORE step 3 when you used dotnet-install.sh
#    (the script does not touch your environment). With the dnf package DOTNET_ROOT must stay unset, so
#    it is only exported when ~/.dotnet/dotnet exists, i.e. after a script install. To keep this for new
#    shells, also add the two lines to ~/.bashrc or ~/.zshrc.
[ -x "$HOME/.dotnet/dotnet" ] && export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$PATH:$HOME/.dotnet:$HOME/.dotnet/tools"

# 3. ilspycmd, the decompiler
dotnet tool install -g ilspycmd

# 4. The extractor, in a virtual environment
python3 -m venv tools/extract/.venv
source tools/extract/.venv/bin/activate
pip install -e 'tools/extract[game,dev]'
```

`dotnet tool install -g` puts `ilspycmd` in `~/.dotnet/tools`, which is usually not on `PATH` in a new shell.
`dsp-extract` also looks there itself, so it finds `ilspycmd` even without step 2, but `dotnet tool install`
itself needs `dotnet` on `PATH` (and `DOTNET_ROOT`, only for a script install), and you need the `PATH` line to run
`ilspycmd` by hand. If `ilspycmd` cannot be found at all the extraction still runs: the game version then comes
from the Steam build id, the code constants keep their (unverified) defaults, and the fingerprints are not
updated. Without the `game` extra (UnityPy and TypeTreeGeneratorAPI) nothing can be read from the game; the
command checks for them before any slow step and stops at once with the install command if they are missing.

Activate the environment (`source tools/extract/.venv/bin/activate`) in every new shell before running
`dsp-extract`.

## Running

```bash
dsp-extract inspect                      # first: quick look, writes the report only, no GameData
dsp-extract                              # the full extraction
dsp-extract --icons --copy-blueprints    # also export item icons and copy your blueprints
dsp-extract --check                      # after a game patch: exit 5 if a mirrored game method changed
dsp-extract --game-dir "/path/to/Dyson Sphere Program"   # when Steam discovery does not find the game
```

The game is found through Steam's library files (`~/.local/share/Steam`, `~/.steam/steam`, Flatpak Steam), so a
game on a second drive works. `--game-dir` takes the game folder or its `DSPGAME_Data` folder, and `.` is fine
from inside either. Run it from anywhere inside the repository checkout.

| Flag | Meaning |
|---|---|
| `--game-dir PATH` | The Dyson Sphere Program folder (or its `DSPGAME_Data`). |
| `--out DIR` | Output folder for `dsp-<gameVersion>.json` (default `data/`). `data/fingerprints.json` always stays in the repository's `data/` folder. |
| `--icons` | Export item icons to `app/public/icons/<iconName>.png` (80x80 where the game has it). A failure only warns. |
| `--copy-blueprints` | Copy your `.txt` blueprints from the Proton prefix to `app/test/fixtures/blueprints/game/`. |
| `--no-decompile` | Do not run ilspycmd (see above for what that costs). |
| `--check` | Compare the mirrored game methods with `data/fingerprints.json` and exit 5 if one `changed` or went `missing`. Does not rewrite the fingerprints, so the drift stays visible until you run without `--check`. |
| `--strict` | Exit 3 after writing if the report has errors (for example a building prefab that could not be read). |
| `--allow-partial` | Write the GameData even when more than 25% of the buildings could not be read from their prefab. Without it that case exits 3 and writes nothing. It does not allow an unreadable belt, sorter, logistics station, spray coater, production building or lab (`CORE_BUILDING_ITEMS` in `cli.py`): any one of those exits 3 and writes nothing, whatever the share. |
| `--report PATH` | Where to write the report (default `local/extract-report.json`). |

Without `--check`, new fingerprints are written after a successful run and any drift is printed with a diff
against the previous decompile (`local/decompiled.prev/`). A decompile only becomes that baseline once a run has
written its GameData and fingerprints (it is marked with `local/decompiled/.accepted`), so a run that fails, or a
`--check` run that only reports drift, does not lose the diff: run it again and the same diff is shown.

`dsp-extract fixture --from DIR --out FILE` rebuilds the committed fixture dataset from a dsp-parser dump
(developer use; needs no game).

### What the end of a run tells you

The summary prints the game version, the file written, how many buildings have **extracted** geometry and how
many fell back to **approximate** geometry (the app marks those blueprints "geometry: approximate / unverified"),
which code constants were read from the game, the fingerprint and drift status, and the number of report errors
and warnings. A building whose prefab could not be read at all is called out separately; if more than a quarter
of the buildings are in that state the run stops with exit 3 and writes no GameData (`--allow-partial` overrides
this), listing the first ten with the reason. A belt, sorter, logistics station, spray coater, production building or lab that could
not be read stops the run whatever the share, and `--allow-partial` does not override that: the planner cannot use a
layout of buildings it knows nothing about.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | GameData written. Some buildings may still use approximate geometry; the summary counts them. |
| 2 | Dyson Sphere Program not found (the message lists what was searched), or a command line usage error. |
| 3 | Extraction failed and no GameData was written: the message names the missing class, key or field, the missing `game` extra, or the buildings that could not be read (more than 25%, see `--allow-partial`; any one belt, sorter, station, spray coater, production building or lab, always). Also `--strict` with errors in the report, and a crash late in the run; in those two cases GameData may already have been written, and the report says so (`output`). |
| 4 | The extracted data failed schema validation (the first violations are listed); nothing was written. |
| 5 | `--check` found a mirrored game method that changed or went missing. |

## When something fails: what to send back

1. **`local/extract-report.json`**. It exists after every run, including crashes (it then holds the traceback),
   and says which files loaded, which ProtoSets were found, what each building's prefab walk produced, the
   collider layers seen and every warning. It contains file paths from your machine and the game's proto names,
   no game assets.
2. The terminal output of the run (copy the last screen).
3. If the game was not found (exit 2): the output of `ls ~/.local/share/Steam/steamapps` and
   `cat ~/.local/share/Steam/steamapps/libraryfolders.vdf`.
4. If setup failed: the output of `python3 --version`, `dotnet --version`, `ilspycmd --version` and the
   `pip install` error.

For a first look at a game version the reader has never seen, run `dsp-extract inspect` and send that report
as well: it lists the Unity version, every ProtoSet class with its first 3 entries, and a prefab walk of five
sample buildings.

Common messages:

- `UnityPy not installed` / `TypeTreeGeneratorAPI not installed`: `pip install -e 'tools/extract[game,dev]'` in the activated environment.
- `cannot determine game version`: ilspycmd did not run and no Steam manifest was found (an explicit `--game-dir` outside a Steam library). Install ilspycmd or point `--game-dir` into the library.
- `N of M buildings ... could not be read from their game prefab`: the reader no longer understands this game version's building prefabs. Nothing was written; send the report (its `per_building_geometry` has the reason for each building).
- `... is missing key 'X'` or `missing field X`: the game version differs from the one the reader was written against. Send the report.

## Tests

```bash
tools/extract/.venv/bin/python -m pytest tools/extract
```

The suite never needs the game: it uses fakes and a small synthetic Unity data set. `test_unity_real.py` (the
reader against UnityPy's real parser) runs only when UnityPy is installed, and `test_decompile_real.py` (the real
ilspycmd) only when ilspycmd and a .NET runtime are present; otherwise they skip themselves.
