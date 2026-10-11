"""Locate the Dyson Sphere Program install through Steam's library metadata.

Order (design spec 4.1): an explicit `--game-dir` wins; otherwise every existing Steam
`steamapps` directory for the platform is read for `libraryfolders.vdf`, and each library it
names is checked for `appmanifest_1366540.acf`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import vdf

DSP_APP_ID = "1366540"
DATA_DIR_NAME = "DSPGAME_Data"

_BLUEPRINT_SUBPATH = (
    "compatdata",
    DSP_APP_ID,
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "Documents",
    "Dyson Sphere Program",
    "Blueprint",
)


class GameNotFoundError(Exception):
    """The DSP install could not be located (or looks unusable)."""


@dataclass(frozen=True)
class GameInstall:
    root: Path
    data_dir: Path
    managed_dir: Path
    build_id: str | None
    library: Path | None

    def compatdata_blueprint_dir(self) -> Path | None:
        """The Proton-prefix blueprint folder, if this install has a Steam library and it exists."""
        if self.library is None:
            return None
        path = self.library.joinpath("steamapps", *_BLUEPRINT_SUBPATH)
        return path if path.is_dir() else None


def candidate_steamapps_dirs(home: Path, platform: str) -> list[Path]:
    """Steam `steamapps` directories to read for `platform` (a `sys.platform` value), in order."""
    if platform.startswith("linux"):
        return [
            home / ".local/share/Steam/steamapps",
            home / ".steam/steam/steamapps",
            home / ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps",
        ]
    if platform == "win32":
        return [Path("C:/Program Files (x86)/Steam/steamapps")]
    if platform == "darwin":
        return [home / "Library/Application Support/Steam/steamapps"]
    return []


def locate_game(game_dir: Path | None, home: Path, platform: str) -> GameInstall:
    """Find the DSP install; raise `GameNotFoundError` naming what was searched."""
    if game_dir is not None:
        return _from_game_dir(game_dir)

    searched: list[str] = []
    incomplete: list[Path] = []
    seen: set[Path] = set()
    for steamapps in candidate_steamapps_dirs(home, platform):
        if not steamapps.is_dir():
            searched.append(f"{steamapps} (not found)")
            continue
        searched.append(f"{steamapps}")
        for library in _libraries(steamapps, searched):
            key = _resolved(library)
            if key in seen:
                continue
            seen.add(key)
            manifest = library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf"
            if not manifest.is_file():
                searched.append(f"{manifest} (not found)")
                continue
            installdir, build_id = _read_manifest(manifest)
            root = library / "steamapps" / "common" / installdir
            if not (root / DATA_DIR_NAME).is_dir():
                incomplete.append(root / DATA_DIR_NAME)
                continue
            return _install(root, build_id, library)

    if incomplete:
        missing = "\n".join(f"  - {path}" for path in incomplete)
        raise GameNotFoundError(
            "Steam has Dyson Sphere Program installed but the install looks incomplete; "
            f"the game data folder is missing:\n{missing}\n"
            "Verify the game files in Steam, or pass --game-dir PATH."
        )
    listing = "\n".join(f"  - {line}" for line in searched) or "  (no Steam locations for this platform)"
    raise GameNotFoundError(
        f"Dyson Sphere Program (Steam app {DSP_APP_ID}) not found. Searched:\n{listing}\n"
        f"Pass --game-dir PATH (the game folder, or its {DATA_DIR_NAME} folder) to point at the install."
    )


def _install(root: Path, build_id: str | None, library: Path | None) -> GameInstall:
    data_dir = root / DATA_DIR_NAME
    return GameInstall(
        root=root,
        data_dir=data_dir,
        managed_dir=data_dir / "Managed",
        build_id=build_id,
        library=library,
    )


def _from_game_dir(game_dir: Path) -> GameInstall:
    path = game_dir.expanduser()
    if not path.is_dir():
        raise GameNotFoundError(f"--game-dir {path} does not exist or is not a directory.")
    if path.name == DATA_DIR_NAME:
        return _install(path.parent, None, None)
    if (path / DATA_DIR_NAME).is_dir():
        return _install(path, None, None)
    raise GameNotFoundError(
        f"--game-dir {path} has no {DATA_DIR_NAME} folder; the install looks incomplete or the path "
        f"is wrong. Pass the Dyson Sphere Program folder (or its {DATA_DIR_NAME} folder)."
    )


def _libraries(steamapps: Path, searched: list[str]) -> list[Path]:
    """The library holding `steamapps` itself, then every `path` in its `libraryfolders.vdf`."""
    libraries = [steamapps.parent]
    listing = steamapps / "libraryfolders.vdf"
    if not listing.is_file():
        return libraries
    try:
        data = vdf.parse(listing.read_text(encoding="utf-8", errors="replace"))
    except (OSError, vdf.VdfError) as exc:
        searched.append(f"{listing} (unreadable: {exc})")
        return libraries
    folders = _get(data, "libraryfolders")
    if isinstance(folders, dict):
        for entry in folders.values():
            path = _get(entry, "path")
            if isinstance(path, str) and path:
                libraries.append(Path(path))
    return libraries


def _read_manifest(manifest: Path) -> tuple[str, str | None]:
    try:
        data = vdf.parse(manifest.read_text(encoding="utf-8", errors="replace"))
    except (OSError, vdf.VdfError) as exc:
        raise GameNotFoundError(f"Cannot read {manifest}: {exc}. Pass --game-dir PATH instead.") from exc
    state = _get(data, "AppState")
    installdir = _get(state, "installdir")
    if not isinstance(installdir, str) or not installdir:
        raise GameNotFoundError(
            f"{manifest} has no AppState/installdir entry. Pass --game-dir PATH instead."
        )
    build_id = _get(state, "buildid")
    return installdir, build_id if isinstance(build_id, str) and build_id else None


def _get(node: object, key: str) -> object | None:
    """Case-insensitive dict lookup; `None` if `node` is not a dict or has no such key."""
    if not isinstance(node, dict):
        return None
    wanted = key.lower()
    for name, value in node.items():
        if name.lower() == wanted:
            return value
    return None


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path
