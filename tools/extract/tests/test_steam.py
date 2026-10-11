from pathlib import Path

import pytest

from dsp_extract import steam
from dsp_extract.steam import DSP_APP_ID, GameInstall, GameNotFoundError

INSTALLDIR = "Dyson Sphere Program"
BUILD_ID = "20345678"
BLUEPRINT_SUBPATH = (
    "compatdata/1366540/pfx/drive_c/users/steamuser/Documents/Dyson Sphere Program/Blueprint"
)


def write_libraryfolders(steamapps: Path, library_paths: list[Path]) -> None:
    """Write a real-format libraryfolders.vdf listing `library_paths`."""
    entries = []
    for i, path in enumerate(library_paths):
        entries.append(
            f'\t"{i}"\n\t{{\n\t\t"path"\t\t"{path}"\n\t\t"label"\t\t""\n'
            f'\t\t"apps"\n\t\t{{\n\t\t\t"228980"\t\t"412345678"\n\t\t}}\n\t}}\n'
        )
    steamapps.mkdir(parents=True, exist_ok=True)
    (steamapps / "libraryfolders.vdf").write_text(
        '"libraryfolders"\n{\n' + "".join(entries) + "}\n", encoding="utf-8"
    )


def write_manifest(library: Path, installdir: str = INSTALLDIR, build_id: str = BUILD_ID) -> None:
    steamapps = library / "steamapps"
    steamapps.mkdir(parents=True, exist_ok=True)
    (steamapps / f"appmanifest_{DSP_APP_ID}.acf").write_text(
        '"AppState"\n{\n'
        f'\t"appid"\t\t"{DSP_APP_ID}"\n'
        '\t"name"\t\t"Dyson Sphere Program"\n'
        f'\t"installdir"\t\t"{installdir}"\n'
        f'\t"buildid"\t\t"{build_id}"\n'
        "}\n",
        encoding="utf-8",
    )


def make_game(library: Path, installdir: str = INSTALLDIR) -> Path:
    """Create `<library>/steamapps/common/<installdir>/DSPGAME_Data/Managed` and return the root."""
    root = library / "steamapps" / "common" / installdir
    (root / "DSPGAME_Data" / "Managed").mkdir(parents=True)
    return root


def install_dsp(library: Path, build_id: str = BUILD_ID) -> Path:
    write_manifest(library, build_id=build_id)
    return make_game(library)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    path = tmp_path / "home"
    path.mkdir()
    return path


# --- candidate_steamapps_dirs -------------------------------------------------------------


def test_candidate_dirs_linux_order(home):
    assert steam.candidate_steamapps_dirs(home, "linux") == [
        home / ".local/share/Steam/steamapps",
        home / ".steam/steam/steamapps",
        home / ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps",
    ]


def test_candidate_dirs_windows_and_macos(home):
    assert steam.candidate_steamapps_dirs(home, "win32") == [
        Path("C:/Program Files (x86)/Steam/steamapps")
    ]
    assert steam.candidate_steamapps_dirs(home, "darwin") == [
        home / "Library/Application Support/Steam/steamapps"
    ]


def test_candidate_dirs_unknown_platform_is_empty(home):
    assert steam.candidate_steamapps_dirs(home, "plan9") == []


# --- locate_game: discovery ---------------------------------------------------------------


def test_native_linux(home):
    library = home / ".local/share/Steam"
    root = install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])

    install = steam.locate_game(None, home, "linux")

    assert install.root == root
    assert install.data_dir == root / "DSPGAME_Data"
    assert install.managed_dir == root / "DSPGAME_Data" / "Managed"
    assert install.data_dir.is_dir()
    assert install.build_id == BUILD_ID
    assert install.library == library


def test_game_in_second_library(home, tmp_path):
    steam_root = home / ".local/share/Steam"
    second = tmp_path / "mnt/games/SteamLibrary"
    root = install_dsp(second, build_id="999")
    write_libraryfolders(steam_root / "steamapps", [steam_root, second])

    install = steam.locate_game(None, home, "linux")

    assert install.root == root
    assert install.library == second
    assert install.build_id == "999"


def test_flatpak_only(home):
    library = home / ".var/app/com.valvesoftware.Steam/.local/share/Steam"
    root = install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])

    install = steam.locate_game(None, home, "linux")

    assert install.root == root
    assert install.library == library


def test_macos_library(home):
    library = home / "Library/Application Support/Steam"
    root = install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])

    assert steam.locate_game(None, home, "darwin").root == root


def test_missing_libraryfolders_falls_back_to_candidate_parent(home):
    library = home / ".local/share/Steam"
    root = install_dsp(library)  # no libraryfolders.vdf written

    assert steam.locate_game(None, home, "linux").root == root


def test_dot_steam_symlink_to_same_library(home):
    library = home / ".local/share/Steam"
    root = install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])
    (home / ".steam").mkdir()
    (home / ".steam/steam").symlink_to(library, target_is_directory=True)

    assert steam.locate_game(None, home, "linux").root == root


def test_dot_steam_only(home):
    library = home / ".steam/steam"
    root = install_dsp(library)

    assert steam.locate_game(None, home, "linux").root == root


def test_vdf_keys_are_case_insensitive(home):
    library = home / ".local/share/Steam"
    (library / "steamapps").mkdir(parents=True)
    (library / "steamapps/libraryfolders.vdf").write_text(
        f'"LibraryFolders" {{ "0" {{ "PATH" "{library}" }} }}', encoding="utf-8"
    )
    (library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf").write_text(
        f'"appstate" {{ "InstallDir" "{INSTALLDIR}" "BuildID" "77" }}', encoding="utf-8"
    )
    root = make_game(library)

    install = steam.locate_game(None, home, "linux")

    assert install.root == root
    assert install.build_id == "77"


def test_stale_manifest_in_first_library_does_not_hide_good_install(home, tmp_path):
    steam_root = home / ".local/share/Steam"
    second = tmp_path / "games"
    write_manifest(steam_root)  # manifest but game folder gone
    root = install_dsp(second)
    write_libraryfolders(steam_root / "steamapps", [steam_root, second])

    assert steam.locate_game(None, home, "linux").root == root


# --- locate_game: --game-dir --------------------------------------------------------------


def test_game_dir_wins_over_steam_discovery(home, tmp_path):
    library = home / ".local/share/Steam"
    install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])
    custom = make_game(tmp_path / "custom", installdir="DSP")

    install = steam.locate_game(custom, home, "linux")

    assert install.root == custom
    assert install.data_dir == custom / "DSPGAME_Data"
    assert install.managed_dir == custom / "DSPGAME_Data" / "Managed"
    assert install.build_id is None
    assert install.library is None


def test_game_dir_pointing_at_data_dir(tmp_path, home):
    custom = make_game(tmp_path / "custom", installdir="DSP")

    install = steam.locate_game(custom / "DSPGAME_Data", home, "linux")

    assert install.root == custom
    assert install.data_dir == custom / "DSPGAME_Data"
    assert install.managed_dir == custom / "DSPGAME_Data" / "Managed"


def test_game_dir_does_not_require_steam_dirs(tmp_path, home):
    custom = make_game(tmp_path / "custom", installdir="DSP")

    assert steam.locate_game(custom, home, "win32").root == custom


def test_game_dir_without_data_dir_is_an_error(tmp_path, home):
    empty = tmp_path / "empty"
    empty.mkdir()

    with pytest.raises(GameNotFoundError) as excinfo:
        steam.locate_game(empty, home, "linux")

    assert str(empty) in str(excinfo.value)
    assert "DSPGAME_Data" in str(excinfo.value)


def test_game_dir_that_does_not_exist_is_an_error(tmp_path, home):
    missing = tmp_path / "nope"

    with pytest.raises(GameNotFoundError, match="does not exist"):
        steam.locate_game(missing, home, "linux")


def test_bad_game_dir_never_falls_back_to_steam(home, tmp_path):
    library = home / ".local/share/Steam"
    install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])
    empty = tmp_path / "empty"
    empty.mkdir()

    with pytest.raises(GameNotFoundError):
        steam.locate_game(empty, home, "linux")


def test_game_dir_dot_from_inside_the_data_folder_is_resolved(tmp_path, home, monkeypatch):
    custom = make_game(tmp_path / "custom", installdir="DSP")
    monkeypatch.chdir(custom / "DSPGAME_Data")

    install = steam.locate_game(Path("."), home, "linux")

    assert install.root == custom
    assert install.data_dir == custom / "DSPGAME_Data"
    assert install.root.is_absolute()


def test_relative_game_dir_is_resolved_against_the_cwd(tmp_path, home, monkeypatch):
    custom = make_game(tmp_path / "custom", installdir="DSP")
    monkeypatch.chdir(custom.parent)

    assert steam.locate_game(Path("DSP"), home, "linux").root == custom
    assert steam.locate_game(Path("../common/DSP/../DSP"), home, "linux").root == custom


def test_game_dir_expands_the_user_home(tmp_path, home, monkeypatch):
    games = home / "games"
    custom = make_game(games, installdir="DSP")
    monkeypatch.setenv("HOME", str(home))

    assert steam.locate_game(Path("~/games/steamapps/common/DSP"), home, "linux").root == custom


def test_game_dir_through_a_symlink_is_resolved(tmp_path, home):
    real = make_game(tmp_path / "real", installdir="DSP")
    link = tmp_path / "link"
    link.symlink_to(real)

    assert steam.locate_game(link, home, "linux").root == real


def test_game_dir_inside_a_steam_library_reads_the_build_id_and_library(tmp_path, home):
    library = tmp_path / "SteamLibrary"
    root = install_dsp(library, build_id="99887766")
    blueprints = library / "steamapps" / BLUEPRINT_SUBPATH
    blueprints.mkdir(parents=True)

    install = steam.locate_game(root, home, "linux")

    assert install.root == root
    assert install.build_id == "99887766"
    assert install.library == library
    assert install.compatdata_blueprint_dir() == blueprints


def test_game_dir_pointing_at_the_data_folder_inside_a_library_also_finds_the_library(tmp_path, home):
    library = tmp_path / "SteamLibrary"
    root = install_dsp(library)

    install = steam.locate_game(root / "DSPGAME_Data", home, "linux")

    assert install.root == root
    assert install.build_id == BUILD_ID
    assert install.library == library


def test_game_dir_dot_inside_a_library_finds_the_library_too(tmp_path, home, monkeypatch):
    library = tmp_path / "SteamLibrary"
    root = install_dsp(library)
    monkeypatch.chdir(root / "DSPGAME_Data")

    install = steam.locate_game(Path("."), home, "linux")

    assert install.library == library and install.build_id == BUILD_ID


def test_game_dir_in_a_library_with_an_unreadable_manifest_still_works_without_a_build_id(tmp_path, home):
    library = tmp_path / "SteamLibrary"
    root = make_game(library)
    (library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf").write_text('"AppState" {', encoding="utf-8")

    install = steam.locate_game(root, home, "linux")

    assert install.root == root
    assert install.build_id is None
    assert install.library == library


def test_game_dir_in_a_library_whose_manifest_has_no_buildid(tmp_path, home):
    library = tmp_path / "SteamLibrary"
    root = make_game(library)
    (library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf").write_text(
        '"AppState"\n{\n\t"installdir"\t\t"Dyson Sphere Program"\n}\n', encoding="utf-8"
    )

    install = steam.locate_game(root, home, "linux")

    assert install.build_id is None and install.library == library


def test_game_dir_outside_a_library_has_no_library_or_build_id(tmp_path, home):
    root = tmp_path / "somewhere" / "DSP"
    (root / "DSPGAME_Data" / "Managed").mkdir(parents=True)

    install = steam.locate_game(root, home, "linux")

    assert install.library is None and install.build_id is None


# --- locate_game: failures ----------------------------------------------------------------


def test_nothing_found_lists_searched_paths_and_suggests_game_dir(home, tmp_path):
    second = tmp_path / "mnt/games/SteamLibrary"
    steam_root = home / ".local/share/Steam"
    write_libraryfolders(steam_root / "steamapps", [steam_root, second])

    with pytest.raises(GameNotFoundError) as excinfo:
        steam.locate_game(None, home, "linux")

    message = str(excinfo.value)
    for candidate in steam.candidate_steamapps_dirs(home, "linux"):
        assert str(candidate) in message
    assert str(second / "steamapps") in message
    assert "--game-dir" in message
    assert DSP_APP_ID in message


def test_nothing_found_with_no_steam_at_all(home):
    with pytest.raises(GameNotFoundError) as excinfo:
        steam.locate_game(None, home, "linux")

    assert "--game-dir" in str(excinfo.value)
    assert str(home / ".local/share/Steam/steamapps") in str(excinfo.value)


def test_manifest_without_data_dir_reports_incomplete_install(home):
    library = home / ".local/share/Steam"
    write_manifest(library)
    (library / "steamapps/common" / INSTALLDIR).mkdir(parents=True)  # no DSPGAME_Data
    write_libraryfolders(library / "steamapps", [library])

    with pytest.raises(GameNotFoundError) as excinfo:
        steam.locate_game(None, home, "linux")

    message = str(excinfo.value)
    assert "incomplete" in message
    assert str(library / "steamapps/common" / INSTALLDIR / "DSPGAME_Data") in message
    assert "--game-dir" in message


def test_manifest_without_installdir_is_an_error(home):
    library = home / ".local/share/Steam"
    (library / "steamapps").mkdir(parents=True)
    (library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf").write_text(
        '"AppState" { "appid" "1366540" }', encoding="utf-8"
    )

    with pytest.raises(GameNotFoundError, match="installdir"):
        steam.locate_game(None, home, "linux")


def test_unparseable_manifest_is_an_error(home):
    library = home / ".local/share/Steam"
    (library / "steamapps").mkdir(parents=True)
    manifest = library / "steamapps" / f"appmanifest_{DSP_APP_ID}.acf"
    manifest.write_text('"AppState" { "installdir" ', encoding="utf-8")

    with pytest.raises(GameNotFoundError) as excinfo:
        steam.locate_game(None, home, "linux")

    assert str(manifest) in str(excinfo.value)


# --- GameInstall.compatdata_blueprint_dir -------------------------------------------------


def test_compatdata_blueprint_dir_exists(home, tmp_path):
    library = tmp_path / "lib"
    install = GameInstall(
        root=make_game(library),
        data_dir=library / "steamapps/common" / INSTALLDIR / "DSPGAME_Data",
        managed_dir=library / "steamapps/common" / INSTALLDIR / "DSPGAME_Data/Managed",
        build_id=BUILD_ID,
        library=library,
    )
    blueprints = library / "steamapps" / BLUEPRINT_SUBPATH
    blueprints.mkdir(parents=True)

    assert install.compatdata_blueprint_dir() == blueprints


def test_compatdata_blueprint_dir_missing_is_none(tmp_path):
    library = tmp_path / "lib"
    root = make_game(library)
    install = GameInstall(root, root / "DSPGAME_Data", root / "DSPGAME_Data/Managed", None, library)

    assert install.compatdata_blueprint_dir() is None


def test_compatdata_blueprint_dir_without_library_is_none(tmp_path):
    root = make_game(tmp_path / "custom")
    install = GameInstall(root, root / "DSPGAME_Data", root / "DSPGAME_Data/Managed", None, None)

    assert install.compatdata_blueprint_dir() is None


def test_game_install_is_frozen(tmp_path):
    root = tmp_path
    install = GameInstall(root, root, root, None, None)

    with pytest.raises(AttributeError):
        install.build_id = "1"  # type: ignore[misc]


def test_located_install_exposes_blueprint_dir(home):
    library = home / ".local/share/Steam"
    install_dsp(library)
    write_libraryfolders(library / "steamapps", [library])
    blueprints = library / "steamapps" / BLUEPRINT_SUBPATH
    blueprints.mkdir(parents=True)

    assert steam.locate_game(None, home, "linux").compatdata_blueprint_dir() == blueprints
