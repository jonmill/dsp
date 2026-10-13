"""End-to-end tests of the `dsp-extract` command with the game faked out.

`locate_game` and `read_bundle` are monkeypatched (or fed a FakeEnv), `ilspycmd` is never run, and every test
works in a throwaway repository (a copy of the real JSON Schema under `data/schema`) that is also the cwd.
"""

from __future__ import annotations

import copy
import functools
import io
import json
import shutil
import stat
import sys
import tomllib
from pathlib import Path

import pytest
from test_unity_reader import build_game_env, make_install

from dsp_extract import cli, unity_reader
from dsp_extract.decompile import TYPES_TO_DECOMPILE, build_fingerprints, find_ilspycmd
from dsp_extract.errors import ExtractError
from dsp_extract.raw import RawBuilding, RawBundle
from dsp_extract.schema_check import validate_against_schema
from dsp_extract.steam import GameInstall, GameNotFoundError

REAL_REPO = Path(__file__).resolve().parents[3]
VERSION = "0.10.35.29104"
BUILD_ID = "20345678"

GAME_CONFIG = f"""\
public static class GameConfig
{{
    public static readonly Version gameVersion = new Version({VERSION.replace(".", ", ")});
}}
"""
CARGO = """
public struct Cargo
{
	public static readonly int[] incTableMilli = new int[11] { 0, 130, 260, 300, 350, 400, 450, 500, 550, 600, 650 };
}
"""
CARGO_PATH_V1 = "public class CargoPath\n{\n\tpublic void Update(long time)\n\t{\n\t\tspeed = 1;\n\t}\n}\n"
CARGO_PATH_V2 = "public class CargoPath\n{\n\tpublic void Update(long time)\n\t{\n\t\tspeed = 2;\n\t}\n}\n"
STATION = "public class StationComponent\n{\n\tpublic void UpdateInputSlots(long time)\n\t{\n\t\tslots = 1;\n\t}\n}\n"
TEST_MIRRORED = {
    "CargoPath.Update": "app/src/lib/validate/sim/belt.ts",
    "StationComponent.UpdateInputSlots": "app/src/lib/validate/sim/station.ts",
}


# ---- fixtures and fakes -----------------------------------------------------------------------


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Path:
    """A minimal repository: the real schema, the committed empty fingerprints file; also the cwd."""
    root = tmp_path / "repo"
    (root / "data" / "schema").mkdir(parents=True)
    shutil.copy(REAL_REPO / "data" / "schema" / "gamedata.schema.json", root / "data" / "schema" / "gamedata.schema.json")
    (root / "data" / "fingerprints.json").write_text("{}\n", encoding="utf-8")
    monkeypatch.chdir(root)
    return root


@pytest.fixture
def install(tmp_path) -> GameInstall:
    root = tmp_path / "steam" / "steamapps" / "common" / "Dyson Sphere Program"
    data = root / "DSPGAME_Data"
    (data / "Managed").mkdir(parents=True)
    return GameInstall(root=root, data_dir=data, managed_dir=data / "Managed", build_id=BUILD_ID, library=None)


@pytest.fixture(autouse=True)
def no_real_tools(monkeypatch, install):
    """By default: the game is `install`, ilspycmd is not installed, and the mirrored set is the small test one."""
    monkeypatch.setattr(cli, "locate_game", lambda game_dir, home, platform: install)
    monkeypatch.setattr(cli, "find_ilspycmd", lambda: None)
    monkeypatch.setattr(cli, "check_game_dependencies", lambda: None)  # UnityPy is not needed: read_bundle is faked
    monkeypatch.setattr(cli, "MIRRORED", dict(TEST_MIRRORED))


SLOT_CONFIG = {"selectCenter": [0, 2.3, 0], "selectSize": [4.2, 4.6, 4.2], "slotPoses": [], "insertPoses": [None] * 12}
BUILD_CONDITION = {
    "landPoints": [[-2, 0.3, 2], [2, 0.3, 2], [2, 0.3, -2], [-2, 0.3, -2]],
    "multiLevel": False,
    "multiLevelAllowInserter": False,
    "lapJoint": [0, 0, 0],
}


def assembler(item_id: int, extracted: bool) -> RawBuilding:
    descs = {
        "AssemblerDesc": {"recipeType": 4, "speedf": 0.75},
        "SlotConfig": copy.deepcopy(SLOT_CONFIG),
        "BuildConditionConfig": copy.deepcopy(BUILD_CONDITION),
    }
    if not extracted:
        return RawBuilding(item_id=item_id, model_index=5, descs=descs)
    collider = {"center": [0, 1, 0], "halfExtents": [1.5, 1, 1.5], "rotation": [0, 0, 0, 1], "usage": "build"}
    return RawBuilding(item_id=item_id, model_index=5, descs=descs, colliders=[collider], slot_poses=[], port_poses=[])


def make_bundle(version: str = VERSION, **overrides) -> RawBundle:
    """Two buildings: item 2303 with extracted geometry, 2304 falling back to approximate geometry."""
    bundle = RawBundle(
        game_version=version,
        steam_build_id=BUILD_ID,
        source="game",
        items=[
            {"id": 1101, "name": "铁块", "type": "MATERIAL", "stackSize": 100, "gridIndex": 1101, "iconPath": "Icons/ItemRecipe/iron-ingot"},
            {"id": 2303, "name": "组装机", "type": "PRODUCTION", "stackSize": 50, "gridIndex": 2203, "canBuild": True, "modelIndex": 5},
            {"id": 2304, "name": "组装机2", "type": "PRODUCTION", "stackSize": 50, "gridIndex": 2204, "canBuild": True, "modelIndex": 6},
        ],
        recipes=[
            {"id": 1, "name": "铁块", "type": "SMELT", "timeSpend": 60, "items": [1001], "itemCounts": [1], "results": [1101], "resultCounts": [1]}
        ],
        techs=[{"id": 1, "name": "T电磁学"}],
        buildings=[assembler(2303, extracted=True), assembler(2304, extracted=False)],
        locale={"铁块": "Iron Ingot", "组装机": "Assembler", "组装机2": "Assembler 2"},
        proto_signatures={"ItemProtoSet": "Item ABC"},
    )
    for key, value in overrides.items():
        setattr(bundle, key, value)
    return bundle


def patch_read_bundle(monkeypatch, bundle: RawBundle | None = None) -> list[dict]:
    """`read_bundle` returns (a copy of) `bundle`; the returned list records each call's `decompiled`."""
    calls: list[dict] = []
    template = bundle if bundle is not None else make_bundle()

    def fake(install, report, *, decompiled=None, **kwargs):
        calls.append({"install": install, "decompiled": decompiled})
        report.set("unity_version", "2022.3.62f3c1")
        return copy.deepcopy(template)

    monkeypatch.setattr(cli, "read_bundle", fake)
    return calls


def patch_decompile(monkeypatch, sources: dict[str, str] | None, *, error: Exception | None = None) -> list[dict]:
    """ilspycmd 'exists'; `decompile_types` writes `sources` (or raises `error`). Returns the recorded calls."""
    calls: list[dict] = []
    monkeypatch.setattr(cli, "find_ilspycmd", lambda: "/fake/dotnet/tools/ilspycmd")

    def fake(ilspy, managed_dir, types, out_dir, report=None, **kwargs):
        calls.append({"ilspy": ilspy, "managed_dir": managed_dir, "types": list(types), "out_dir": Path(out_dir)})
        if error is not None:
            Path(out_dir).mkdir(parents=True, exist_ok=True)
            raise error
        written = {}
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        for name, text in (sources or {}).items():
            path = Path(out_dir) / f"{name}.cs"
            path.write_text(text, encoding="utf-8")
            written[name] = path
        if report is not None:
            report.set("decompile", {"ilspycmd": ilspy, "decompiled": list(written), "failed": {}})
        return written

    monkeypatch.setattr(cli, "decompile_types", fake)
    return calls


def run(*args: str) -> int:
    return cli.main(list(args))


def output_file(repo: Path, version: str = VERSION) -> Path:
    return repo / "data" / f"dsp-{version}.json"


def load_report(repo: Path) -> dict:
    return json.loads((repo / "local" / "extract-report.json").read_text(encoding="utf-8"))


def fingerprints(repo: Path) -> dict:
    return json.loads((repo / "data" / "fingerprints.json").read_text(encoding="utf-8"))


def committed_fingerprints(repo: Path, sources: dict[str, str], version: str = "0.10.1.1") -> dict:
    doc = build_fingerprints(version, sources, TEST_MIRRORED)
    (repo / "data" / "fingerprints.json").write_text(json.dumps(doc), encoding="utf-8")
    return doc


# ---- the brief's cases ------------------------------------------------------------------------


def test_success_writes_a_valid_game_data_file_and_exits_0(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch)
    assert run() == 0
    target = output_file(repo)
    assert target.is_file()
    data = json.loads(target.read_text(encoding="utf-8"))
    validate_against_schema(data, repo / "data" / "schema" / "gamedata.schema.json")
    assert data["meta"]["gameVersion"] == VERSION
    assert data["meta"]["source"] == "game"
    assert data["meta"]["extractorVersion"] == "0.1.0"
    assert {b["itemId"] for b in data["buildings"]} == {2303, 2304}
    assert not [p for p in (repo / "data").iterdir() if p.name.endswith(".tmp")]
    out = capsys.readouterr().out
    assert str(target) in out and VERSION in out


def test_schema_failure_exits_4_and_creates_no_output_file(repo, monkeypatch, capsys):
    bad = make_bundle()
    bad.recipes = [{**bad.recipes[0], "id": 10**20}]  # normalizes, but is outside the schema's integer range
    patch_read_bundle(monkeypatch, bad)
    assert run() == 4
    assert not output_file(repo).exists()
    assert [p.name for p in (repo / "data").iterdir() if p.name.startswith("dsp-")] == []
    err = capsys.readouterr().err
    assert "schema" in err.lower() and "recipes" in err
    assert "no gamedata was written" in err.lower()


def test_schema_failure_leaves_an_existing_output_file_untouched(repo, monkeypatch):
    output_file(repo).write_text('{"old": true}', encoding="utf-8")
    bad = make_bundle()
    bad.recipes = [{**bad.recipes[0], "id": 10**20}]
    patch_read_bundle(monkeypatch, bad)
    assert run() == 4
    assert output_file(repo).read_text(encoding="utf-8") == '{"old": true}'


def test_game_not_found_exits_2_with_the_message_on_stderr(repo, monkeypatch, capsys):
    def missing(game_dir, home, platform):
        raise GameNotFoundError("Dyson Sphere Program (Steam app 1366540) not found. Searched:\n  - /x/steamapps (not found)")

    monkeypatch.setattr(cli, "locate_game", missing)
    patch_read_bundle(monkeypatch)
    assert run() == 2
    captured = capsys.readouterr()
    assert "not found" in captured.err and "/x/steamapps" in captured.err
    assert not output_file(repo).exists()


def test_a_bad_game_dir_exits_2_through_the_real_locator(repo, monkeypatch, capsys, tmp_path):
    monkeypatch.undo()  # use the real locate_game
    monkeypatch.chdir(repo)
    assert run("--game-dir", str(tmp_path / "does-not-exist")) == 2
    assert "does not exist" in capsys.readouterr().err


def test_check_with_a_changed_mirrored_method_exits_5(repo, monkeypatch, capsys):
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION, "GameConfig": GAME_CONFIG})
    assert run("--check") == 5
    out = capsys.readouterr().out
    assert "CargoPath.Update" in out and "changed" in out and "app/src/lib/validate/sim/belt.ts" in out
    assert [d["method"] for d in load_report(repo)["drift"]] == ["CargoPath.Update"]  # the unchanged one is not listed
    assert fingerprints(repo) == committed  # --check never accepts the new hashes
    assert output_file(repo).is_file()  # the extraction itself still happened
    assert load_report(repo)["drift"][0]["status"] == "changed"


def test_fixture_subcommand_works_on_a_minimal_dsp_parser_dump(tmp_path, repo, capsys):
    dump = tmp_path / "dump"
    dump.mkdir()
    (dump / "meta.json").write_text(json.dumps({"version": "0.10.29.22015", "generatedAt": "2026-01-01T00:00:00Z"}), encoding="utf-8")
    (dump / "items.json").write_text(
        json.dumps([{"id": 1101, "name": "铁块", "type": "MATERIAL", "stackSize": 100, "gridIndex": 1101}]), encoding="utf-8"
    )
    (dump / "recipes.json").write_text(
        json.dumps(
            [{"id": 1, "name": "铁块", "type": "SMELT", "timeSpend": 60, "items": [1001], "itemCounts": [1], "results": [1101], "resultCounts": [1]}]
        ),
        encoding="utf-8",
    )
    (dump / "tech.json").write_text(json.dumps([{"id": 1, "name": "T电磁学"}]), encoding="utf-8")
    (dump / "locale.json").write_text(json.dumps([{"lcid": 1033, "strings": {"铁块": "Iron Ingot"}}]), encoding="utf-8")
    out_file = tmp_path / "out" / "dsp-fixture.json"

    assert run("fixture", "--from", str(dump), "--out", str(out_file)) == 0

    data = json.loads(out_file.read_text(encoding="utf-8"))
    assert data["meta"]["source"] == "fixture" and data["meta"]["gameVersion"] == "0.10.29.22015"
    assert data["items"][0]["name"] == "Iron Ingot"
    assert "wrote" in capsys.readouterr().out


# ---- Review Focus 1: a game with missing fields fails loudly ----------------------------------


def test_a_missing_required_field_exits_3_naming_the_field_and_writes_nothing(repo, monkeypatch, capsys):
    broken = make_bundle()
    del broken.recipes[0]["timeSpend"]
    patch_read_bundle(monkeypatch, broken)
    assert run() == 3
    err = capsys.readouterr().err
    assert "timeSpend" in err and "recipe 1" in err
    assert not output_file(repo).exists()
    report = load_report(repo)
    assert any("timeSpend" in e["message"] for e in report["entries"] if e["level"] == "error")


def test_a_proto_missing_a_key_in_the_real_reader_exits_3_naming_class_and_key(repo, monkeypatch, capsys):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ItemProtoSet":
            del obj.tree["dataArray"][1]["ModelIndex"]
    game = make_install(repo.parent)
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    monkeypatch.setattr(cli, "read_bundle", lambda inst, report, **kw: unity_reader.read_bundle(inst, report, adapter=env, **kw))
    assert run() == 3
    err = capsys.readouterr().err
    assert "ItemProtoSet" in err and "ModelIndex" in err
    assert not any(p.name.startswith("dsp-") for p in (repo / "data").iterdir())


# ---- decompile flow ---------------------------------------------------------------------------


def test_decompiled_sources_give_the_game_version_and_the_code_constants(repo, monkeypatch):
    env = build_game_env()
    game = make_install(repo.parent)
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    monkeypatch.setattr(cli, "read_bundle", lambda inst, report, **kw: unity_reader.read_bundle(inst, report, adapter=env, **kw))
    calls = patch_decompile(monkeypatch, {"GameConfig": GAME_CONFIG, "Cargo": CARGO, "CargoPath": CARGO_PATH_V1, "StationComponent": STATION})

    assert run() == 0

    assert [c["ilspy"] for c in calls] == ["/fake/dotnet/tools/ilspycmd"]
    assert calls[0]["managed_dir"] == game.managed_dir
    assert calls[0]["out_dir"] == repo / "local" / "decompiled"
    assert calls[0]["types"] == TYPES_TO_DECOMPILE
    data = json.loads(output_file(repo).read_text(encoding="utf-8"))
    assert data["meta"]["gameVersion"] == VERSION  # from GameConfig, not "0.0.0+build..."
    assert data["constants"]["incTableMilli"] == [0, 130, 260, 300, 350, 400, 450, 500, 550, 600, 650]
    assert data["constantSources"]["incTableMilli"] == "decompiled:Cargo.incTableMilli"
    assert data["constantSources"]["accTableMilli"].endswith("(unverified)")  # not in the source: default kept


def test_read_bundle_receives_the_decompiled_sources(repo, monkeypatch):
    calls = patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"GameConfig": GAME_CONFIG, "Cargo": CARGO})
    assert run() == 0
    assert set(calls[0]["decompiled"]) == {"GameConfig", "Cargo"}
    assert "gameVersion" in calls[0]["decompiled"]["GameConfig"]


def test_decompile_rotates_the_previous_accepted_run_first_and_drift_shows_the_diff(repo, monkeypatch, capsys):
    (repo / "local" / "decompiled").mkdir(parents=True)
    (repo / "local" / "decompiled" / "CargoPath.cs").write_text(CARGO_PATH_V1, encoding="utf-8")
    (repo / "local" / "decompiled" / ".accepted").write_text("0.10.1.1\n", encoding="utf-8")
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})

    assert run() == 0  # drift without --check is reported, not fatal

    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V1
    assert (repo / "local" / "decompiled" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V2
    out = capsys.readouterr().out
    assert "CargoPath.Update" in out and "changed" in out
    assert "speed = 1;" in out and "speed = 2;" in out  # the diff body is shown
    drift = load_report(repo)["drift"]
    assert drift[0]["method"] == "CargoPath.Update" and "speed = 2;" in drift[0]["diff"]


def test_an_empty_previous_decompile_folder_does_not_replace_the_good_prev_folder(repo, monkeypatch):
    (repo / "local" / "decompiled").mkdir(parents=True)  # a failed earlier run left this empty
    (repo / "local" / "decompiled.prev").mkdir()
    (repo / "local" / "decompiled.prev" / "CargoPath.cs").write_text(CARGO_PATH_V1, encoding="utf-8")
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2})
    assert run() == 0
    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V1


def test_missing_ilspycmd_is_a_warning_and_the_defaults_are_used(repo, monkeypatch, capsys):
    calls = patch_read_bundle(monkeypatch)
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1})
    assert run() == 0  # find_ilspycmd is None (autouse fixture)
    assert calls[0]["decompiled"] is None
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("ilspycmd" in w for w in warnings)
    assert fingerprints(repo) == committed  # never overwritten with nothing
    data = json.loads(output_file(repo).read_text(encoding="utf-8"))
    assert data["constantSources"]["incTableMilli"].endswith("(unverified)")


def test_a_failing_decompile_continues_with_defaults(repo, monkeypatch, capsys):
    calls = patch_read_bundle(monkeypatch)
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1})
    patch_decompile(monkeypatch, None, error=ExtractError("ilspycmd produced no output for any type: PrefabDesc: exit code 1"))
    assert run() == 0
    assert calls[0]["decompiled"] is None
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("decompil" in w and "ilspycmd produced no output" in w for w in warnings)
    assert fingerprints(repo) == committed


def test_no_decompile_never_runs_ilspycmd(repo, monkeypatch):
    calls = patch_read_bundle(monkeypatch)
    decompile_calls = patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1})
    assert run("--no-decompile") == 0
    assert decompile_calls == []
    assert calls[0]["decompiled"] is None


FAKE_ILSPY = """#!{python}
import sys
type_name = sys.argv[sys.argv.index("-t") + 1]
if type_name == "GameConfig":
    sys.stdout.write("public static class GameConfig\\n{{\\n\\tpublic static readonly Version gameVersion = new Version(0, 10, 35, 29104);\\n}}\\n")
else:
    sys.stdout.write("public class " + type_name + "\\n{{\\n}}\\n")
"""


@pytest.mark.skipif(sys.platform == "win32", reason="shebang script")
def test_a_real_ilspycmd_on_path_is_run_for_every_type_and_gives_the_game_version(repo, monkeypatch, tmp_path):
    exe = tmp_path / "tools" / "ilspycmd"
    exe.parent.mkdir()
    exe.write_text(FAKE_ILSPY.format(python=sys.executable))
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(exe.parent))
    monkeypatch.setattr(cli, "find_ilspycmd", functools.partial(find_ilspycmd, home=tmp_path / "nohome"))
    game = make_install(repo.parent)
    (game.managed_dir / "Assembly-CSharp.dll").write_bytes(b"")
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    monkeypatch.setattr(cli, "read_bundle", lambda inst, report, **kw: unity_reader.read_bundle(inst, report, adapter=build_game_env(), **kw))
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1})

    assert run() == 0

    decompiled = sorted(p.stem for p in (repo / "local" / "decompiled").glob("*.cs"))
    assert decompiled == sorted(TYPES_TO_DECOMPILE)
    assert output_file(repo).is_file()  # the version came from the fake GameConfig
    assert fingerprints(repo) == committed  # the real mirrored methods were not in the stubs: nothing to write
    report = load_report(repo)
    assert report["decompile"]["ilspycmd"] == str(exe)
    assert report["code_constants"]["read_from_game_code"] == {}


# ---- fingerprints and drift -------------------------------------------------------------------


def test_fingerprints_are_written_after_a_decompile(repo, monkeypatch):
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    assert run() == 0
    doc = fingerprints(repo)
    assert doc["gameVersion"] == VERSION
    assert set(doc["methods"]) == set(TEST_MIRRORED)
    assert doc["methods"]["CargoPath.Update"]["tsModule"] == "app/src/lib/validate/sim/belt.ts"
    assert doc == build_fingerprints(VERSION, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION}, TEST_MIRRORED)


def test_new_methods_against_the_empty_committed_file_are_not_drift_even_with_check(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    assert run("--check") == 0
    assert fingerprints(repo) == {}  # --check does not write the baseline either
    assert "new" in capsys.readouterr().out


def test_check_exits_5_for_a_missing_method_too(repo, monkeypatch):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    gone = "public class CargoPath\n{\n\tpublic void Other() { }\n}\n"
    patch_decompile(monkeypatch, {"CargoPath": gone, "StationComponent": STATION})
    assert run("--check") == 5
    assert [d["status"] for d in load_report(repo)["drift"]] == ["missing"]


def test_check_with_unchanged_fingerprints_exits_0(repo, monkeypatch):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    assert run("--check") == 0


def test_drift_without_check_updates_the_fingerprints_and_exits_0(repo, monkeypatch):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run() == 0
    assert fingerprints(repo) == build_fingerprints(VERSION, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION}, TEST_MIRRORED)


def test_a_type_that_failed_to_decompile_is_neither_drift_nor_lost_from_the_fingerprints(repo, monkeypatch):
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1})  # StationComponent did not decompile
    assert run("--check") == 0  # not "missing"
    assert run() == 0
    doc = fingerprints(repo)
    assert doc["methods"]["StationComponent.UpdateInputSlots"] == committed["methods"]["StationComponent.UpdateInputSlots"]
    assert doc["methods"]["CargoPath.Update"] == committed["methods"]["CargoPath.Update"]


def test_a_corrupt_committed_fingerprints_file_is_left_alone_with_a_warning(repo, monkeypatch):
    (repo / "data" / "fingerprints.json").write_text("{not json", encoding="utf-8")
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1})
    assert run() == 0
    assert (repo / "data" / "fingerprints.json").read_text(encoding="utf-8") == "{not json"
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("fingerprints.json" in w for w in warnings)


def test_fingerprints_stay_in_the_repo_data_folder_whatever_out_is(repo, monkeypatch, tmp_path):
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2})
    other = tmp_path / "elsewhere"
    assert run("--out", str(other)) == 0
    assert (other / f"dsp-{VERSION}.json").is_file()
    assert not (other / "fingerprints.json").exists()
    assert not output_file(repo).exists()
    # the baseline was the committed repo file (so the drift was seen) and it is the file that was updated
    assert load_report(repo)["drift"][0]["status"] == "changed"
    expected = build_fingerprints(VERSION, {"CargoPath": CARGO_PATH_V2}, TEST_MIRRORED)["methods"]["CargoPath.Update"]
    assert fingerprints(repo)["methods"]["CargoPath.Update"] == expected != committed["methods"]["CargoPath.Update"]


def test_check_with_out_still_compares_against_the_repo_fingerprints(repo, monkeypatch, tmp_path):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run("--check", "--out", str(tmp_path / "elsewhere")) == 5


# ---- the diff baseline survives a failed run ----------------------------------------------------


def fail_after_decompile(monkeypatch, message="RecipeProtoSet not found among 3 ProtoSet objects"):
    def fails(install, report, *, decompiled=None, **kwargs):
        raise ExtractError(message)

    monkeypatch.setattr(cli, "read_bundle", fails)


def test_a_failed_run_after_a_patch_does_not_lose_the_diff_baseline(repo, monkeypatch, capsys):
    # run 1: the accepted baseline (V1 sources, fingerprints written)
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    assert run() == 0
    accepted = fingerprints(repo)
    assert (repo / "local" / "decompiled" / ".accepted").is_file()

    # run 2: the game was patched (V2), decompiled fine, but the run fails before anything is accepted
    fail_after_decompile(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run() == 3
    assert fingerprints(repo) == accepted
    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V1

    # run 3: fixed; the diff must still be V1 against V2, not V2 against V2
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    capsys.readouterr()
    assert run() == 0
    out = capsys.readouterr().out
    assert "speed = 1;" in out and "speed = 2;" in out
    (entry,) = load_report(repo)["drift"]
    assert entry["status"] == "changed" and "speed = 1;" in entry["diff"] and "speed = 2;" in entry["diff"]
    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V1

    # run 4: V2 is accepted now, so it becomes the previous one
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run() == 0
    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V2
    assert load_report(repo)["drift"] == []


def test_a_failed_first_run_leaves_no_baseline_to_lose(repo, monkeypatch):
    fail_after_decompile(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1})
    assert run() == 3
    assert not (repo / "local" / "decompiled" / ".accepted").exists()
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2})
    assert run() == 0  # no .prev, no baseline: nothing to diff, nothing to fail on
    assert not (repo / "local" / "decompiled.prev").exists()


def test_a_check_run_that_finds_drift_does_not_accept_it(repo, monkeypatch, capsys):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})
    (repo / "local" / "decompiled").mkdir(parents=True)
    (repo / "local" / "decompiled" / "CargoPath.cs").write_text(CARGO_PATH_V1, encoding="utf-8")
    (repo / "local" / "decompiled" / ".accepted").write_text("0.10.1.1\n", encoding="utf-8")
    patch_read_bundle(monkeypatch)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run("--check") == 5
    assert not (repo / "local" / "decompiled" / ".accepted").exists()
    capsys.readouterr()
    assert run("--check") == 5  # the second look still has the V1 baseline
    out = capsys.readouterr().out
    assert "speed = 1;" in out and "speed = 2;" in out
    assert run() == 0  # accepted now
    assert (repo / "local" / "decompiled" / ".accepted").is_file()
    assert (repo / "local" / "decompiled.prev" / "CargoPath.cs").read_text(encoding="utf-8") == CARGO_PATH_V1


# ---- exit codes, strict, report in every outcome ----------------------------------------------


def test_report_errors_do_not_fail_the_run_by_default_but_strict_exits_3_after_writing(repo, monkeypatch, capsys):
    def with_errors(install, report, *, decompiled=None, **kwargs):
        report.error("building 2303 (Assembler): prefab unreadable, descriptors and geometry lost: boom")
        return make_bundle()

    monkeypatch.setattr(cli, "read_bundle", with_errors)
    assert run() == 0
    assert "1 error" in capsys.readouterr().out
    output_file(repo).unlink()

    assert run("--strict") == 3
    assert output_file(repo).is_file()  # still written
    assert "--strict" in capsys.readouterr().err


def test_summary_counts_extracted_and_approximate_geometry_and_report_entries(repo, monkeypatch, capsys):
    def noisy(install, report, *, decompiled=None, **kwargs):
        report.warn("w1")
        report.warn("w2")
        report.error("e1")
        return make_bundle()

    monkeypatch.setattr(cli, "read_bundle", noisy)
    assert run() == 0
    out = capsys.readouterr().out
    assert "1 extracted" in out and "1 approximate" in out
    assert "1 error" in out and "3 warnings" in out  # w1, w2 and the ilspycmd-missing warning
    assert "local/extract-report.json" in out.replace("\\", "/")
    assert "Assembler 2" in out  # the approximate building is named


def test_buildings_whose_prefab_could_not_be_read_are_called_out(repo, monkeypatch, capsys):
    def lossy(install, report, *, decompiled=None, **kwargs):
        # two buildings the planner can do without: 2501 failed, 2500 only partial
        report.set_building(PLAIN_BASE + 1, {"name_key": "组装机1", "status": "failed"})
        report.set_building(PLAIN_BASE, {"name_key": "组装机0", "status": "partial"})
        report.error(f"building {PLAIN_BASE + 1} (组装机1): prefab 'x' unreadable, descriptors and geometry lost: boom")
        return bundle_with_buildings(2)

    monkeypatch.setattr(cli, "read_bundle", lossy)
    assert run("--allow-partial") == 0  # 1 of 2 buildings is over the partial-data limit
    out = capsys.readouterr().out
    result = out.split("== dsp-extract result ==")[1]
    assert "1 building" in result and "could not be read" in result and str(PLAIN_BASE + 1) in result
    assert str(PLAIN_BASE) not in result.split("could not be read")[1].splitlines()[0]  # partial ones are only approximate geometry


def test_check_that_could_not_compare_anything_says_so(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch)
    assert run("--check") == 0  # nothing decompiled: no drift can be detected
    captured = capsys.readouterr()
    assert "--check" in captured.err and "could not" in captured.err
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("--check" in w for w in warnings)


def test_strict_errors_take_precedence_over_check_drift(repo, monkeypatch):
    committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1, "StationComponent": STATION})

    def with_errors(install, report, *, decompiled=None, **kwargs):
        report.error("something broke")
        return make_bundle()

    monkeypatch.setattr(cli, "read_bundle", with_errors)
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2, "StationComponent": STATION})
    assert run("--check", "--strict") == 3
    assert run("--check") == 5


def test_streams_that_cannot_encode_chinese_names_do_not_break_the_summary(monkeypatch):
    ascii_out = io.TextIOWrapper(io.BytesIO(), encoding="ascii", errors="strict")
    monkeypatch.setattr(sys, "stdout", ascii_out)
    cli._make_streams_safe()
    print("组装机")  # would raise UnicodeEncodeError before
    ascii_out.flush()


def test_a_version_taken_from_the_steam_build_id_is_labelled_as_such(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch, make_bundle(version=f"0.0.0+build{BUILD_ID}"))
    assert run() == 0
    out = capsys.readouterr().out
    assert f"Game version: 0.0.0+build{BUILD_ID}" in out and "Steam build id" in out.split("== dsp-extract result ==")[1]
    assert (repo / "data" / f"dsp-0.0.0+build{BUILD_ID}.json").is_file()


def test_the_report_is_written_on_success(repo, monkeypatch):
    patch_read_bundle(monkeypatch)
    assert run() == 0
    report = load_report(repo)
    assert report["unity_version"] == "2022.3.62f3c1"
    assert report["counts"]["error"] == 0
    assert report["output"]["path"].endswith(f"dsp-{VERSION}.json")
    assert report["environment"]["dsp_extract"] == "0.1.0"


def test_the_report_is_written_when_the_game_is_not_found(repo, monkeypatch):
    def missing(game_dir, home, platform):
        raise GameNotFoundError("not found")

    monkeypatch.setattr(cli, "locate_game", missing)
    assert run() == 2
    report = load_report(repo)
    assert any("not found" in e["message"] for e in report["entries"] if e["level"] == "error")


def test_the_report_is_written_on_a_fatal_extract_error_with_the_partial_findings(repo, monkeypatch, capsys):
    def fails(install, report, *, decompiled=None, **kwargs):
        report.set("protosets_found", {"ItemProtoSet": {"count": 1, "read": False}})
        raise ExtractError("RecipeProtoSet not found among 3 ProtoSet objects")

    monkeypatch.setattr(cli, "read_bundle", fails)
    assert run() == 3
    err = capsys.readouterr().err
    assert "RecipeProtoSet not found" in err
    assert str(repo / "local" / "extract-report.json") in err or "local/extract-report.json" in err.replace("\\", "/")
    report = load_report(repo)
    assert report["protosets_found"]["ItemProtoSet"]["count"] == 1
    assert any("RecipeProtoSet not found" in e["message"] for e in report["entries"] if e["level"] == "error")
    assert not output_file(repo).exists()


def test_the_report_is_written_on_a_schema_failure(repo, monkeypatch):
    bad = make_bundle()
    bad.recipes = [{**bad.recipes[0], "id": 10**20}]
    patch_read_bundle(monkeypatch, bad)
    assert run() == 4
    assert any("schema" in e["message"].lower() for e in load_report(repo)["entries"] if e["level"] == "error")


def test_an_unexpected_exception_is_caught_recorded_with_its_traceback_and_exits_3(repo, monkeypatch, capsys):
    def explodes(install, report, *, decompiled=None, **kwargs):
        return {}["no such key"]

    monkeypatch.setattr(cli, "read_bundle", explodes)
    assert run() == 3
    err = capsys.readouterr().err
    assert "unexpected" in err.lower() and "KeyError" in err
    assert "send" in err.lower() and "extract-report.json" in err.replace("\\", "/")
    assert "Traceback" not in err  # short message only; the traceback is in the report
    report = load_report(repo)
    assert "Traceback (most recent call last)" in report["traceback"]
    assert "explodes" in report["traceback"] and "KeyError" in report["traceback"]
    error = next(e for e in report["entries"] if e["level"] == "error")
    assert "KeyError" in error["message"]


def test_when_the_report_cannot_be_written_the_traceback_goes_to_stderr(repo, monkeypatch, capsys):
    def explodes(install, report, *, decompiled=None, **kwargs):
        return {}["no such key"]

    monkeypatch.setattr(cli, "read_bundle", explodes)
    blocker = repo / "blocker"
    blocker.write_text("a file, not a folder", encoding="utf-8")
    assert run("--report", str(blocker / "report.json")) == 3
    err = capsys.readouterr().err
    assert "could not write the report" in err.lower()
    assert "Traceback (most recent call last)" in err and "explodes" in err and "KeyError" in err


def test_a_custom_report_path_is_used(repo, monkeypatch, tmp_path):
    patch_read_bundle(monkeypatch)
    target = tmp_path / "reports" / "mine.json"
    assert run("--report", str(target)) == 0
    assert json.loads(target.read_text(encoding="utf-8"))["counts"]["error"] == 0
    assert not (repo / "local" / "extract-report.json").exists()


def test_a_report_that_cannot_be_written_does_not_change_the_exit_code(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch)
    blocker = repo / "blocker"
    blocker.write_text("a file, not a folder", encoding="utf-8")
    assert run("--report", str(blocker / "report.json")) == 0
    assert "could not write the report" in capsys.readouterr().err.lower()


# ---- repo root --------------------------------------------------------------------------------


def test_the_repo_root_is_found_by_walking_up_from_a_subfolder(repo, monkeypatch):
    sub = repo / "app" / "src" / "deep"
    sub.mkdir(parents=True)
    monkeypatch.chdir(sub)
    patch_read_bundle(monkeypatch)
    assert run() == 0
    assert output_file(repo).is_file()
    assert (repo / "local" / "extract-report.json").is_file()  # the report goes to the repo's local/, not the cwd's


def test_the_repo_root_falls_back_to_the_package_location(tmp_path):
    elsewhere = tmp_path / "nowhere"
    elsewhere.mkdir()
    assert cli.find_repo_root(elsewhere) == REAL_REPO  # this package lives inside the real repository


def test_the_repo_root_is_an_error_when_neither_cwd_nor_package_is_inside_one(tmp_path):
    lonely = tmp_path / "lonely"
    lonely.mkdir()
    with pytest.raises(cli.RepoNotFoundError, match="gamedata.schema.json"):
        cli.find_repo_root(lonely, package_file=lonely / "cli.py")


def test_a_missing_repo_root_exits_3_with_a_message_and_still_writes_a_report(tmp_path, monkeypatch, capsys):
    lonely = tmp_path / "lonely"
    lonely.mkdir()
    monkeypatch.chdir(lonely)

    def nope(start=None, package_file=None):
        raise cli.RepoNotFoundError("cannot find data/schema/gamedata.schema.json above the current folder")

    monkeypatch.setattr(cli, "find_repo_root", nope)
    assert run() == 3
    assert "gamedata.schema.json" in capsys.readouterr().err
    assert (lonely / "local" / "extract-report.json").is_file()


# ---- --game-dir, --out, icons, blueprints -----------------------------------------------------


def test_game_dir_is_passed_to_the_locator(repo, monkeypatch, install):
    seen = []

    def spy(game_dir, home, platform):
        seen.append(game_dir)
        return install

    monkeypatch.setattr(cli, "locate_game", spy)
    patch_read_bundle(monkeypatch)
    assert run("--game-dir", "/some/where") == 0
    assert seen == [Path("/some/where")]
    assert run() == 0 and seen[-1] is None


def test_out_chooses_the_output_folder(repo, monkeypatch, tmp_path):
    patch_read_bundle(monkeypatch)
    other = tmp_path / "elsewhere"
    assert run("--out", str(other)) == 0
    assert (other / f"dsp-{VERSION}.json").is_file()
    assert not output_file(repo).exists()


def test_icons_are_exported_to_app_public_icons_and_failures_only_warn(repo, monkeypatch, capsys):
    patch_read_bundle(monkeypatch)
    calls = []

    def fake_export(inst, items, out_dir, report):
        calls.append((inst, [i["id"] for i in items], Path(out_dir)))
        return 7

    monkeypatch.setattr(cli, "export_icons", fake_export)
    assert run("--icons") == 0
    assert calls[0][1] == [1101, 2303, 2304] and calls[0][2] == repo / "app" / "public" / "icons"
    assert "7" in capsys.readouterr().out

    def boom(*a, **k):
        raise RuntimeError("PIL exploded")

    monkeypatch.setattr(cli, "export_icons", boom)
    assert run("--icons") == 0
    assert any("PIL exploded" in e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn")


def test_icons_are_not_exported_without_the_flag(repo, monkeypatch):
    patch_read_bundle(monkeypatch)
    monkeypatch.setattr(cli, "export_icons", lambda *a, **k: pytest.fail("icons exported without --icons"))
    assert run() == 0


def test_copy_blueprints_copies_txt_files_from_the_proton_prefix(repo, monkeypatch, tmp_path, capsys):
    library = tmp_path / "lib"
    source = library / "steamapps" / "compatdata" / "1366540" / "pfx" / "drive_c" / "users" / "steamuser" / "Documents" / "Dyson Sphere Program" / "Blueprint"
    (source / "folder").mkdir(parents=True)
    (source / "one.txt").write_text("BLUEPRINT:0,1", encoding="utf-8")
    (source / "folder" / "two.txt").write_text("BLUEPRINT:0,2", encoding="utf-8")
    (source / "ignored.bin").write_bytes(b"x")
    game = GameInstall(
        root=library / "steamapps" / "common" / "Dyson Sphere Program",
        data_dir=library / "steamapps" / "common" / "Dyson Sphere Program" / "DSPGAME_Data",
        managed_dir=library / "steamapps" / "common" / "Dyson Sphere Program" / "DSPGAME_Data" / "Managed",
        build_id=BUILD_ID,
        library=library,
    )
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    patch_read_bundle(monkeypatch)
    assert run("--copy-blueprints") == 0
    dest = repo / "app" / "test" / "fixtures" / "blueprints" / "game"
    assert (dest / "one.txt").read_text(encoding="utf-8") == "BLUEPRINT:0,1"
    assert (dest / "folder" / "two.txt").read_text(encoding="utf-8") == "BLUEPRINT:0,2"
    assert not (dest / "ignored.bin").exists()
    assert "2" in capsys.readouterr().out


def test_copy_blueprints_without_a_proton_folder_is_a_warning(repo, monkeypatch):
    patch_read_bundle(monkeypatch)  # the fake install has no library
    assert run("--copy-blueprints") == 0
    assert not (repo / "app").exists()
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("blueprint" in w.lower() for w in warnings)


# ---- inspect ----------------------------------------------------------------------------------


def test_inspect_lists_protosets_and_walks_sample_prefabs_without_writing_game_data(repo, monkeypatch, capsys):
    env = build_game_env()
    game = make_install(repo.parent)
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    monkeypatch.setattr(cli, "open_adapter", lambda inst, report: env)

    assert run("inspect") == 0

    out = capsys.readouterr().out
    assert "ItemProtoSet" in out and "SignalProtoSet" in out
    assert not any(p.name.startswith("dsp-") for p in (repo / "data").iterdir())
    report = load_report(repo)
    assert set(report["protoset_samples"]) >= {"ItemProtoSet", "RecipeProtoSet", "SignalProtoSet"}
    assert len(report["protoset_samples"]["ItemProtoSet"]["first_entries"]) == 2  # the fake has only 2 items
    walks = report["prefab_walks"]
    assert set(walks) == {"assembler-mk-1", "logistic-station", "inserter-1", "belt-1", "tesla tower"}
    assembler = walks["assembler-mk-1"]
    assert assembler["prefab_path"] == "Entities/Prefabs/assembler-mk-1"
    assert [g["path"] for g in assembler["game_objects"]][0] == "assembler-mk-1"
    assert "error" in walks["logistic-station"]  # the fake game has no such building; recorded, not fatal


def test_inspect_accepts_game_dir_and_report_after_the_subcommand(repo, monkeypatch, tmp_path):
    seen = []
    game = make_install(repo.parent)

    def spy(game_dir, home, platform):
        seen.append(game_dir)
        return game

    monkeypatch.setattr(cli, "locate_game", spy)
    monkeypatch.setattr(cli, "open_adapter", lambda inst, report: build_game_env())
    target = tmp_path / "inspect.json"
    assert run("inspect", "--game-dir", "/g", "--report", str(target)) == 0
    assert seen == [Path("/g")] and target.is_file()
    assert run("--game-dir", "/h", "inspect") == 0
    assert seen[-1] == Path("/h")


def test_inspect_reports_a_game_that_is_not_found(repo, monkeypatch, capsys):
    def missing(game_dir, home, platform):
        raise GameNotFoundError("not found")

    monkeypatch.setattr(cli, "locate_game", missing)
    assert run("inspect") == 2
    assert "not found" in capsys.readouterr().err


def test_inspect_with_an_unreadable_asset_set_exits_3_and_keeps_what_it_saw(repo, monkeypatch, capsys):
    def broken(inst, report):
        report.set("files_loaded", [{"name": "resources.assets", "size": 1, "error": "bad header"}])
        raise ExtractError("cannot parse resources.assets: bad header")

    monkeypatch.setattr(cli, "open_adapter", broken)
    assert run("inspect") == 3
    assert load_report(repo)["files_loaded"][0]["error"] == "bad header"


# ---- the game extra is checked before the slow work ------------------------------------------------


def test_a_missing_game_extra_fails_fast_before_decompiling(repo, monkeypatch, capsys):
    def missing():
        raise ExtractError("UnityPy not installed: pip install 'dsp-extract[game]'")

    monkeypatch.setattr(cli, "check_game_dependencies", missing)
    decompile_calls = patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V1})
    monkeypatch.setattr(cli, "read_bundle", lambda *a, **k: pytest.fail("read_bundle ran without UnityPy"))
    assert run() == 3
    assert decompile_calls == []  # nothing slow ran
    err = capsys.readouterr().err
    assert "UnityPy not installed" in err and "pip install" in err
    assert any("UnityPy not installed" in e["message"] for e in load_report(repo)["entries"] if e["level"] == "error")
    assert not output_file(repo).exists()


def test_the_game_extra_is_checked_for_no_decompile_and_inspect_too(repo, monkeypatch):
    calls = []

    def missing():
        calls.append(1)
        raise ExtractError("TypeTreeGeneratorAPI not installed: pip install 'dsp-extract[game]'")

    monkeypatch.setattr(cli, "check_game_dependencies", missing)
    assert run("--no-decompile") == 3
    assert run("inspect") == 3
    assert len(calls) == 2


# ---- the partial-data guard (Review Focus 1) --------------------------------------------------------


# The ids of the buildings of the share tests: none of them is one the planner cannot do without (`cli.CORE_BUILDING_ITEMS`), so
# the share of unreadable ones is what decides.
PLAIN_BASE = 2500


def bundle_with_buildings(count: int) -> RawBundle:
    bundle = make_bundle()
    bundle.items = [bundle.items[0]] + [
        {"id": PLAIN_BASE + i, "name": f"组装机{i}", "type": "PRODUCTION", "stackSize": 50, "gridIndex": 2200 + i, "canBuild": True, "modelIndex": 5}
        for i in range(count)
    ]
    bundle.locale = {"铁块": "Iron Ingot", **{f"组装机{i}": f"Assembler {i}" for i in range(count)}}
    bundle.buildings = [assembler(PLAIN_BASE + i, extracted=True) for i in range(count)]
    return bundle


def patch_unreadable(monkeypatch, count: int, bad: set[int], *, flag: str = "status") -> None:
    """`count` buildings; those whose index is in `bad` were recorded as unreadable (status 'failed' or the flag)."""
    template = bundle_with_buildings(count)

    def fake(install, report, *, decompiled=None, **kwargs):
        for i in range(count):
            record = {"name_key": f"组装机{i}", "model_index": 5, "status": "extracted", "problems": []}
            if i in bad:
                record["problems"] = [f"prefab 'Entities/Prefabs/b{i}' unreadable, descriptors and geometry lost: boom {i}"]
                if flag == "status":
                    record["status"] = "failed"
                else:
                    record["status"] = "partial"
                    record["unreadable"] = True
                report.error(f"building {PLAIN_BASE + i}: " + record["problems"][0], item_id=PLAIN_BASE + i)
            report.set_building(PLAIN_BASE + i, record)
        return copy.deepcopy(template)

    monkeypatch.setattr(cli, "read_bundle", fake)


def test_exactly_a_quarter_unreadable_is_still_written(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 8, {0, 1})
    assert run() == 0
    assert output_file(repo).is_file()
    assert "2 buildings could not be read" in capsys.readouterr().out


def test_more_than_a_quarter_unreadable_exits_3_and_writes_no_game_data(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 8, {0, 1, 2})
    committed = committed_fingerprints(repo, {"CargoPath": CARGO_PATH_V1})
    patch_decompile(monkeypatch, {"CargoPath": CARGO_PATH_V2})
    assert run() == 3
    assert not output_file(repo).exists()
    assert fingerprints(repo) == committed  # nothing in the repo was touched
    err = capsys.readouterr().err
    assert "3 of 8 buildings" in err and "--allow-partial" in err
    assert "Assembler 0" in err and "boom 0" in err  # which ones, and why
    assert "No GameData was written" in err
    assert str(repo / "local" / "extract-report.json") in err
    report = load_report(repo)  # the report is written, with the per-building records
    assert report["per_building_geometry"][str(PLAIN_BASE)]["status"] == "failed"
    assert any("3 of 8 buildings" in e["message"] for e in report["entries"] if e["level"] == "error")
    assert "output" not in report


def test_the_failed_buildings_listing_stops_at_ten(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 20, set(range(14)))
    assert run() == 3
    err = capsys.readouterr().err
    assert "14 of 20 buildings" in err
    assert "Assembler 9" in err and "Assembler 10" not in err
    assert "4 more" in err


def test_allow_partial_writes_the_game_data_anyway_and_says_so(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 8, {0, 1, 2})
    assert run("--allow-partial") == 0
    assert output_file(repo).is_file()
    out = capsys.readouterr().out
    assert "3 buildings could not be read" in out
    warnings = [e["message"] for e in load_report(repo)["entries"] if e["level"] == "warn"]
    assert any("--allow-partial" in w and "3 of 8" in w for w in warnings)


def test_buildings_that_lost_a_core_descriptor_count_even_though_the_prefab_was_found(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 4, {0, 1}, flag="unreadable")
    assert run() == 3
    assert "2 of 4 buildings" in capsys.readouterr().err
    assert not output_file(repo).exists()


def test_the_guard_applies_before_a_schema_or_normalize_failure_can_hide_it(repo, monkeypatch, capsys):
    patch_unreadable(monkeypatch, 4, {0, 1, 2})
    assert run() == 3  # and not 4/3 for some later reason
    assert "--allow-partial" in capsys.readouterr().err


def _real_reader_with_a_missing_prefab(repo, monkeypatch, item_id: int) -> None:
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ItemProtoSet":
            obj.tree["dataArray"].append(
                {"ID": item_id, "Name": "分拣器", "Type": 5, "StackSize": 50, "GridIndex": 1, "CanBuild": True, "ModelIndex": 41}
            )
        if obj.script == "ModelProtoSet":
            obj.tree["dataArray"].append({"ID": 41, "Name": "分拣器", "PrefabPath": "Entities/Prefabs/missing"})
    game = make_install(repo.parent)
    monkeypatch.setattr(cli, "locate_game", lambda *a: game)
    monkeypatch.setattr(cli, "read_bundle", lambda inst, report, **kw: unity_reader.read_bundle(inst, report, adapter=env, **kw))


def test_the_guard_works_through_the_real_reader_when_a_prefab_is_missing(repo, monkeypatch, capsys):
    _real_reader_with_a_missing_prefab(repo, monkeypatch, 2201)  # a Tesla Tower: one of the two buildings is 50 %
    assert run() == 3  # one of the two buildings has no prefab
    err = capsys.readouterr().err
    assert "1 of 2 buildings" in err and "2201" in err and "missing" in err
    assert not any(p.name.startswith("dsp-") for p in (repo / "data").iterdir())
    assert load_report(repo)["per_building_geometry"]["2201"]["unreadable"] is True


def test_a_missing_prefab_of_a_sorter_is_fatal_through_the_real_reader_too(repo, monkeypatch, capsys):
    _real_reader_with_a_missing_prefab(repo, monkeypatch, 2011)
    assert run() == 3
    err = capsys.readouterr().err
    assert "cannot do without" in err and "2011" in err and "sorter" in err and "missing" in err
    assert not any(p.name.startswith("dsp-") for p in (repo / "data").iterdir())


# ---- an unreadable core building is fatal whatever the share (final review, M7) -----------------------------


CORE_BUILDINGS = [
    (2001, "belt"),
    (2003, "belt"),
    (2011, "sorter"),
    (2014, "sorter"),
    (2103, "station"),
    (2104, "station"),
    (2302, "production building"),
    (2303, "production building"),
    (2309, "production building"),
    (2318, "production building"),
    (2901, "lab"),
    (2902, "lab"),
]


def patch_unreadable_ids(monkeypatch, bad: set[int], *, plain: int = 39) -> None:
    """`plain` ordinary buildings, all readable, and the buildings with the ids in `bad`, recorded as unreadable."""
    template = bundle_with_buildings(plain)
    ids = [PLAIN_BASE + i for i in range(plain)] + sorted(bad)
    template.items += [
        {"id": i, "name": f"核心{i}", "type": "PRODUCTION", "stackSize": 50, "gridIndex": 2200 + i % 100, "canBuild": True, "modelIndex": 5}
        for i in sorted(bad)
    ]
    template.locale.update({f"核心{i}": f"Core {i}" for i in bad})
    template.buildings += [assembler(i, extracted=True) for i in sorted(bad)]

    def fake(install, report, *, decompiled=None, **kwargs):
        for i in ids:
            record = {"name_key": f"核心{i}" if i in bad else f"组装机{i - PLAIN_BASE}", "model_index": 5, "status": "extracted", "problems": []}
            if i in bad:
                record["status"] = "failed"
                record["problems"] = [f"prefab 'Entities/Prefabs/core{i}' unreadable, descriptors and geometry lost: boom {i}"]
                report.error(f"building {i}: " + record["problems"][0], item_id=i)
            report.set_building(i, record)
        return copy.deepcopy(template)

    monkeypatch.setattr(cli, "read_bundle", fake)


@pytest.mark.parametrize(("item_id", "what"), CORE_BUILDINGS)
def test_one_unreadable_core_building_is_fatal_though_it_is_a_tiny_share(repo, monkeypatch, capsys, item_id, what):
    patch_unreadable_ids(monkeypatch, {item_id})  # 1 of 40: 2.5 %, far under the 25 % limit
    assert run() == 3
    assert not output_file(repo).exists()
    err = capsys.readouterr().err
    assert f"Core {item_id} ({item_id})" in err and f"boom {item_id}" in err  # which one, and why
    assert what in err and "planner cannot" in err  # and why it matters
    assert "No GameData was written" in err
    assert str(repo / "local" / "extract-report.json") in err
    report = load_report(repo)
    assert report["per_building_geometry"][str(item_id)]["status"] == "failed"
    assert any(str(item_id) in e["message"] for e in report["entries"] if e["level"] == "error")


def test_allow_partial_does_not_let_an_unreadable_core_building_through(repo, monkeypatch, capsys):
    patch_unreadable_ids(monkeypatch, {2303})
    assert run("--allow-partial") == 3
    assert not output_file(repo).exists()
    assert "Core 2303" in capsys.readouterr().err


def test_all_the_unreadable_core_buildings_are_listed_with_the_others_after_them(repo, monkeypatch, capsys):
    patch_unreadable_ids(monkeypatch, {2011, 2103, 2303})
    assert run() == 3
    err = capsys.readouterr().err
    assert "3 buildings" in err
    assert err.index("Core 2011") < err.index("Core 2103") < err.index("Core 2303")


def test_an_unreadable_building_that_is_not_core_is_still_only_a_share_matter(repo, monkeypatch, capsys):
    patch_unreadable_ids(monkeypatch, {2201})  # a Tesla Tower: 1 of 40
    assert run() == 0
    assert output_file(repo).is_file()
    assert "1 building could not be read" in capsys.readouterr().out


def test_a_readable_core_building_is_no_problem(repo, monkeypatch):
    patch_unreadable_ids(monkeypatch, set())
    template = bundle_with_buildings(3)
    template.items += [{"id": 2303, "name": "组装机", "type": "PRODUCTION", "stackSize": 50, "gridIndex": 2203, "canBuild": True, "modelIndex": 5}]
    assert run() == 0


def test_strict_still_fails_after_writing_when_partial_data_was_allowed(repo, monkeypatch):
    patch_unreadable(monkeypatch, 8, {0})
    assert run("--strict") == 3
    assert output_file(repo).is_file()


# ---- packaging --------------------------------------------------------------------------------


def test_pyproject_registers_the_console_script_and_makes_jsonschema_a_runtime_dependency():
    pyproject = tomllib.loads((REAL_REPO / "tools" / "extract" / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["scripts"]["dsp-extract"] == "dsp_extract.cli:main"
    assert any(dep.lower().startswith("jsonschema") for dep in pyproject["project"]["dependencies"])
    game = " ".join(pyproject["project"]["optional-dependencies"]["game"]).lower()
    assert "unitypy" in game and "typetreegeneratorapi" in game
    assert not any("jsonschema" in dep.lower() for dep in pyproject["project"]["optional-dependencies"]["dev"])


def test_help_lists_the_flags_and_exit_codes(capsys):
    with pytest.raises(SystemExit) as excinfo:
        cli.main(["--help"])
    assert excinfo.value.code == 0
    out = capsys.readouterr().out
    for flag in ("--game-dir", "--out", "--copy-blueprints", "--icons", "--no-decompile", "--check", "--strict", "--allow-partial", "--report"):
        assert flag in out
    for word in ("inspect", "fixture", "exit"):
        assert word in out
