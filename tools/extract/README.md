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
#    If dnf has no dotnet-sdk-10.0, use Microsoft's installer instead:
#      curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
#      bash dotnet-install.sh --channel 10.0

# 2. ilspycmd, the decompiler
dotnet tool install -g ilspycmd

# 3. Put the dotnet tools on PATH (add this line to ~/.bashrc or ~/.zshrc, then open a new shell)
export PATH="$PATH:$HOME/.dotnet:$HOME/.dotnet/tools"

# 4. The extractor, in a virtual environment
python3 -m venv tools/extract/.venv
source tools/extract/.venv/bin/activate
pip install -e 'tools/extract[game,dev]'
```

`dotnet tool install -g` puts `ilspycmd` in `~/.dotnet/tools`, which is usually not on `PATH` in a new shell.
`dsp-extract` also looks there itself, so it works even before step 3, but add the line anyway if you want to
run `ilspycmd` by hand. If `ilspycmd` cannot be found at all the extraction still runs: the game version then
comes from the Steam build id, the code constants keep their (unverified) defaults, and the fingerprints are not
updated. Without the `game` extra (UnityPy) nothing can be read from the game.

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
| `--out DIR` | Output folder for `dsp-<gameVersion>.json` and `fingerprints.json` (default `data/`). |
| `--icons` | Export item icons to `app/public/icons/<iconName>.png` (80x80 where the game has it). A failure only warns. |
| `--copy-blueprints` | Copy your `.txt` blueprints from the Proton prefix to `app/test/fixtures/blueprints/game/`. |
| `--no-decompile` | Do not run ilspycmd (see above for what that costs). |
| `--check` | Compare the mirrored game methods with `data/fingerprints.json` and exit 5 if one `changed` or went `missing`. Does not rewrite the fingerprints, so the drift stays visible until you run without `--check`. |
| `--strict` | Exit 3 after writing if the report has errors (for example a building prefab that could not be read). |
| `--report PATH` | Where to write the report (default `local/extract-report.json`). |

Without `--check`, new fingerprints are written after a successful run and any drift is printed with a diff
against the previous decompile (`local/decompiled.prev/`).

`dsp-extract fixture --from DIR --out FILE` rebuilds the committed fixture dataset from a dsp-parser dump
(developer use; needs no game).

### What the end of a run tells you

The summary prints the game version, the file written, how many buildings have **extracted** geometry and how
many fell back to **approximate** geometry (the app marks those blueprints "geometry: approximate / unverified"),
which code constants were read from the game, the fingerprint and drift status, and the number of report errors
and warnings. A building whose prefab could not be read at all is called out separately.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | GameData written. Some buildings may still use approximate geometry; the summary counts them. |
| 2 | Dyson Sphere Program not found (the message lists what was searched), or a command line usage error. |
| 3 | Extraction failed and no GameData was written (the message names the missing class, key or field), an unexpected crash, or `--strict` with errors in the report. |
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
- `... is missing key 'X'` or `missing field X`: the game version differs from the one the reader was written against. Send the report.

## Tests

```bash
tools/extract/.venv/bin/python -m pytest tools/extract
```

The suite never needs the game: it uses fakes and a small synthetic Unity data set. `test_unity_real.py` (the
reader against UnityPy's real parser) runs only when UnityPy is installed, and `test_decompile_real.py` (the real
ilspycmd) only when ilspycmd and a .NET runtime are present; otherwise they skip themselves.
