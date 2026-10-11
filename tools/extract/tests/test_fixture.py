"""Tests for the dsp-parser fixture builder and the `dsp-extract fixture` command."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dsp_extract import cli
from dsp_extract.fixture import FixtureError, build_fixture, load_dump, run
from dsp_extract.schema_check import SchemaError, validate_against_schema

REPO_ROOT = Path(__file__).resolve().parents[3]
DUMP_DIR = REPO_ROOT / "docs" / "research" / "datasets" / "dsp-parser"
SCHEMA_PATH = REPO_ROOT / "data" / "schema" / "gamedata.schema.json"

needs_dump = pytest.mark.skipif(not DUMP_DIR.is_dir(), reason=f"dsp-parser dump not present at {DUMP_DIR}")


@pytest.fixture(scope="module")
def fixture_path(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("fixture") / "dsp-fixture.json"
    assert cli.main(["fixture", "--from", str(DUMP_DIR), "--out", str(out)]) == 0
    return out


@pytest.fixture(scope="module")
def data(fixture_path) -> dict:
    return json.loads(fixture_path.read_text(encoding="utf-8"))


def by_id(rows: list[dict], key: str, value: int) -> dict:
    return next(r for r in rows if r[key] == value)


@needs_dump
def test_fixture_validates_against_the_schema(data):
    validate_against_schema(data, SCHEMA_PATH)


@needs_dump
def test_fixture_meta(data):
    meta = data["meta"]
    assert meta["source"] == "fixture"
    assert meta["schemaVersion"] == 1
    assert meta["gameVersion"] == json.loads((DUMP_DIR / "meta.json").read_text())["version"]
    assert "steamBuildId" not in meta


@needs_dump
def test_fixture_has_at_least_160_recipes(data):
    assert len(data["recipes"]) >= 160


@needs_dump
def test_processor_recipe(data):
    recipe = by_id(data["recipes"], "id", 51)
    assert recipe["timeTicks"] == 180
    assert recipe["inputs"] == [{"itemId": 1301, "count": 2}, {"itemId": 1302, "count": 2}]
    assert recipe["outputs"] == [{"itemId": 1303, "count": 1}]
    assert recipe["name"] == "Processor"
    assert recipe["type"] == "ASSEMBLE"


@needs_dump
def test_proliferator_items_take_sprays_from_hpmax(data):
    assert by_id(data["items"], "id", 1141)["proliferator"] == {"ability": 1, "sprays": 12}
    assert by_id(data["items"], "id", 1142)["proliferator"] == {"ability": 2, "sprays": 24}
    assert by_id(data["items"], "id", 1143)["proliferator"] == {"ability": 4, "sprays": 60}
    assert [i["id"] for i in data["items"] if "proliferator" in i] == [1141, 1142, 1143]


@needs_dump
def test_assembler_mk1(data):
    b = by_id(data["buildings"], "itemId", 2303)
    assert b["kind"] == "production"
    assert b["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}
    assert b["power"]["workPerTick"] == 4500
    assert b["power"]["idlePerTick"] == 200
    assert b["name"] == "Assembling Machine Mk.I"


@needs_dump
def test_interstellar_station(data):
    b = by_id(data["buildings"], "itemId", 2104)
    assert b["kind"] == "station"
    assert b["station"]["maxItemKinds"] == 5
    assert b["station"]["isStellar"] is True
    assert len(b["geometry"]["ports"]) == 12
    assert len(b["geometry"]["colliders"]) == 2


@needs_dump
def test_planetary_station_has_four_item_kinds(data):
    assert by_id(data["buildings"], "itemId", 2103)["station"]["maxItemKinds"] == 4


@needs_dump
def test_every_building_has_approximate_geometry(data):
    assert data["buildings"]
    assert {b["geometry"]["source"] for b in data["buildings"]} == {"approximate"}


@needs_dump
def test_building_kinds(data):
    kinds = {b["itemId"]: b["kind"] for b in data["buildings"]}
    assert kinds[2001] == kinds[2002] == kinds[2003] == "belt"
    assert [kinds[i] for i in (2011, 2012, 2013, 2014)] == ["sorter"] * 4
    assert kinds[2020] == "splitter"
    assert kinds[2040] == "piler"
    assert kinds[2101] == kinds[2102] == "storage"
    assert kinds[2201] == kinds[2202] == kinds[2212] == "powerNode"
    # generators, accumulators and the exchanger are grid nodes too, but not poles
    assert {kinds[i] for i in (2203, 2204, 2205, 2206, 2207, 2208, 2209, 2210, 2211, 2213)} == {"other"}
    assert kinds[2313] == "sprayCoater"
    assert kinds[2314] == "fractionator"
    assert kinds[2316] == "other"  # Advanced Mining Machine is a vein collector, not a station
    assert kinds[2105] == "other"  # orbital collector
    assert kinds[2901] == kinds[2902] == "lab"
    assert {b["production"]["recipeType"] for b in data["buildings"] if b["kind"] == "production"} == {
        "ASSEMBLE",
        "SMELT",
        "CHEMICAL",
        "REFINE",
        "PARTICLE",
    }


@needs_dump
def test_sorters_and_belts(data):
    sorters = {b["itemId"]: b["sorter"] for b in data["buildings"] if b["kind"] == "sorter"}
    assert [sorters[i]["grade"] for i in (2011, 2012, 2013, 2014)] == [1, 2, 3, 4]
    assert sorters[2011]["stt"] == 200000
    assert sorted(b["belt"]["speed"] for b in data["buildings"] if b["kind"] == "belt") == [1, 2, 5]


@needs_dump
def test_labs_and_spray_coater(data):
    assert by_id(data["buildings"], "itemId", 2901)["lab"]["assembleSpeed"] == 10000
    assert by_id(data["buildings"], "itemId", 2902)["lab"]["assembleSpeed"] == 30000
    assert by_id(data["buildings"], "itemId", 2313)["sprayCoater"] == {"incCapacity": 600, "incItemIds": [1141, 1142, 1143]}


@needs_dump
def test_techs_carry_prerequisites_and_unlocks(data):
    tech = by_id(data["techs"], "id", 1302)
    assert tech["preTechs"] == [1311]
    assert tech["unlockRecipes"] == [51]
    assert tech["name"] == "Processor"


@needs_dump
def test_constants_come_from_the_research_defaults(data):
    assert data["constants"]["incTableMilli"][1] == 125
    assert all(s.startswith("research:") for s in data["constantSources"].values())


@needs_dump
def test_building_is_a_buildable_item_with_a_model(data):
    ids = {b["itemId"] for b in data["buildings"]}
    items = {i["id"]: i for i in data["items"]}
    assert ids <= {i for i, item in items.items() if item["canBuild"]}
    assert all(items[i]["modelIndex"] > 0 for i in ids)
    assert 1131 not in ids  # Foundation: buildable, but has no prefab model


@needs_dump
def test_output_is_reproducible(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    assert cli.main(["fixture", "--from", str(DUMP_DIR), "--out", str(a)]) == 0
    assert cli.main(["fixture", "--from", str(DUMP_DIR), "--out", str(b)]) == 0
    assert a.read_bytes() == b.read_bytes()


@needs_dump
def test_load_dump_buildings_have_descriptors_without_underscores():
    bundle, generated_at = load_dump(DUMP_DIR)
    raw = next(b for b in bundle.buildings if b.item_id == 2303)
    assert {"AssemblerDesc", "PowerDesc", "SlotConfig", "BuildConditionConfig"} <= set(raw.descs)
    assert raw.colliders is None and raw.slot_poses is None and raw.port_poses is None
    assert generated_at.startswith("2024-03-23")


@needs_dump
def test_build_fixture_validates_when_given_a_schema():
    assert build_fixture(DUMP_DIR, SCHEMA_PATH)["meta"]["source"] == "fixture"


# ---- failure modes, independent of the dump --------------------------------------------------


def test_missing_dump_directory_is_a_clear_error(tmp_path, capsys):
    assert cli.main(["fixture", "--from", str(tmp_path / "nope"), "--out", str(tmp_path / "out.json")]) == 1
    assert "missing" in capsys.readouterr().err
    assert not (tmp_path / "out.json").exists()


def test_load_dump_requires_english_locale(tmp_path):
    for name, content in (("items.json", []), ("recipes.json", []), ("tech.json", []), ("meta.json", {"version": "1.0"})):
        (tmp_path / name).write_text(json.dumps(content))
    (tmp_path / "locale.json").write_text(json.dumps([{"lcid": 2052, "strings": {}}]))
    with pytest.raises(FixtureError, match="en-US"):
        load_dump(tmp_path)


def test_fixture_command_surfaces_a_missing_field(tmp_path, capsys):
    broken = {"id": 51, "name": "处理器", "type": "ASSEMBLE", "items": [1], "itemCounts": [1], "results": [2], "resultCounts": [1]}
    for name, content in (("items.json", []), ("recipes.json", [broken]), ("tech.json", []), ("meta.json", {"version": "1.0"})):
        (tmp_path / name).write_text(json.dumps(content))
    (tmp_path / "locale.json").write_text(json.dumps([{"lcid": 1033, "strings": {}}]))
    assert cli.main(["fixture", "--from", str(tmp_path), "--out", str(tmp_path / "out.json")]) == 1
    assert "recipe 51 (处理器): missing field timeSpend" in capsys.readouterr().err


def test_fixture_command_reports_a_missing_schema_file(tmp_path, capsys):
    for name, content in (("items.json", []), ("recipes.json", []), ("tech.json", []), ("meta.json", {"version": "1.0"})):
        (tmp_path / name).write_text(json.dumps(content))
    (tmp_path / "locale.json").write_text(json.dumps([{"lcid": 1033, "strings": {}}]))
    out = tmp_path / "out.json"
    assert run(tmp_path, out, tmp_path / "no-schema.json") == 1
    assert "no-schema.json" in capsys.readouterr().err
    assert not out.exists()


# ---- schema_check ---------------------------------------------------------------------------


def test_schema_check_lists_json_paths_and_caps_at_ten(tmp_path):
    schema = tmp_path / "s.json"
    schema.write_text(
        json.dumps(
            {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {"rows": {"type": "array", "items": {"type": "object", "required": ["id"]}}},
            }
        )
    )
    with pytest.raises(SchemaError) as err:
        validate_against_schema({"rows": [{} for _ in range(12)]}, schema)
    text = str(err.value)
    assert "$.rows[0]" in text and "$.rows[9]" in text
    assert "$.rows[10]" not in text
    assert "and 2 more" in text
    validate_against_schema({"rows": [{"id": 1}]}, schema)


def test_schema_check_accepts_the_real_schema_for_an_empty_shell():
    with pytest.raises(SchemaError, match=r"\$"):
        validate_against_schema({}, SCHEMA_PATH)
