"""Tests for the proto normalizer (RawBundle -> GameData JSON)."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from dsp_extract.constants import DEFAULT_CONSTANT_SOURCES, DEFAULT_CONSTANTS
from dsp_extract.normalize import NormalizeError, normalize
from dsp_extract.raw import RawBuilding, RawBundle
from dsp_extract.schema_check import validate_against_schema

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO_ROOT / "data" / "schema" / "gamedata.schema.json"

NOW = "2026-10-10T00:00:00Z"


def item_proto(item_id: int, name: str = "铁块", **extra) -> dict:
    proto = {"id": item_id, "name": name, "type": "MATERIAL", "stackSize": 100, "gridIndex": 1101}
    proto.update(extra)
    return proto


def recipe_proto(**extra) -> dict:
    proto = {
        "id": 51,
        "name": "处理器",
        "type": "ASSEMBLE",
        "timeSpend": 180,
        "items": [1301, 1302],
        "itemCounts": [2, 2],
        "results": [1303],
        "resultCounts": [1],
    }
    proto.update(extra)
    return proto


SLOT_CONFIG = {
    "selectCenter": [0, 2.3, 0],
    "selectSize": [4.2, 4.6, 4.2],
    "slotPoses": [],
    "insertPoses": [None] * 12,
}
BUILD_CONDITION = {
    "landPoints": [[-2, 0.3, 2], [2, 0.3, 2], [2, 0.3, -2], [-2, 0.3, -2]],
    "multiLevel": False,
    "multiLevelAllowInserter": False,
    "lapJoint": [0, 0, 0],
}


def building(item_id: int, **descs) -> RawBuilding:
    descs.setdefault("SlotConfig", copy.deepcopy(SLOT_CONFIG))
    descs.setdefault("BuildConditionConfig", copy.deepcopy(BUILD_CONDITION))
    return RawBuilding(item_id=item_id, model_index=5, descs=descs, colliders=None, slot_poses=None, port_poses=None)


def make_bundle(
    *,
    items=None,
    recipes=None,
    techs=None,
    buildings=None,
    locale=None,
    constants=None,
    constant_sources=None,
) -> RawBundle:
    return RawBundle(
        game_version="0.10.29.22015",
        steam_build_id=None,
        source="fixture",
        items=[item_proto(1101)] if items is None else items,
        recipes=[recipe_proto()] if recipes is None else recipes,
        techs=[{"id": 1, "name": "T戴森球计划"}] if techs is None else techs,
        buildings=[] if buildings is None else buildings,
        locale={} if locale is None else locale,
        constants={} if constants is None else constants,
        constant_sources={} if constant_sources is None else constant_sources,
        proto_signatures={},
    )


def run(bundle: RawBundle) -> dict:
    return normalize(bundle, "0.1.0", NOW)


def building_of(bundle: RawBundle, item_id: int) -> dict:
    return next(b for b in run(bundle)["buildings"] if b["itemId"] == item_id)


def building_bundle(item_id: int, name: str = "测试建筑", **descs) -> RawBundle:
    return make_bundle(items=[item_proto(item_id, name, canBuild=True)], buildings=[building(item_id, **descs)])


# ---- shape-agnostic keys, enums, BigInt, defaults ---------------------------------------------


def test_camel_and_pascal_recipes_normalize_identically():
    camel = recipe_proto(explicit=True)
    pascal = {
        "ID": 51,
        "Name": "处理器",
        "Type": 4,
        "TimeSpend": 180,
        "Items": [1301, 1302],
        "ItemCounts": [2, 2],
        "Results": [1303],
        "ResultCounts": [1],
        "Explicit": True,
    }
    a = run(make_bundle(recipes=[camel]))["recipes"]
    b = run(make_bundle(recipes=[pascal]))["recipes"]
    assert a == b
    assert a[0]["inputs"] == [{"itemId": 1301, "count": 2}, {"itemId": 1302, "count": 2}]
    assert a[0]["outputs"] == [{"itemId": 1303, "count": 1}]
    assert a[0]["timeTicks"] == 180


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(4, "ASSEMBLE"), ("ASSEMBLE", "ASSEMBLE"), (1, "SMELT"), (7, "PHOTON_STORE"), (15, "RESEARCH"), (0, "NONE")],
)
def test_recipe_type_enum_accepts_int_and_string(raw, expected):
    assert run(make_bundle(recipes=[recipe_proto(type=raw)]))["recipes"][0]["type"] == expected


def test_unknown_recipe_type_int_raises():
    with pytest.raises(NormalizeError, match=r"recipe 51 \(处理器\): .*type"):
        run(make_bundle(recipes=[recipe_proto(type=99)]))


def test_item_type_int_maps_to_the_dump_spelling():
    out = run(make_bundle(items=[item_proto(1101, type=2), item_proto(6001, "电磁矩阵", type=11)]))
    assert [i["type"] for i in out["items"]] == ["MATERIAL", "MATRIX"]


def test_bigint_values_become_numbers():
    big = {":type": "BigInt", "value": "3240000"}
    out = run(make_bundle(items=[item_proto(1141, "增产剂 Mk.I", heatValue=big, ability=1, hpMax=12)]))
    assert out["items"][0]["heatValue"] == 3240000
    assert isinstance(out["items"][0]["heatValue"], int)


def test_power_bigint_workenergy():
    big = lambda v: {":type": "BigInt", "value": str(v)}  # noqa: E731
    b = building_bundle(
        2303,
        AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"},
        PowerDesc={"consumer": True, "workEnergyPerTick": big(4500), "idleEnergyPerTick": big(200)},
    )
    assert building_of(b, 2303)["power"] == {"consumer": True, "workPerTick": 4500, "idlePerTick": 200}


def test_locale_fallback_to_key():
    bundle = make_bundle(items=[item_proto(1101, "铁块"), item_proto(1102, "钢材")], locale={"铁块": "Iron Ingot"})
    items = run(bundle)["items"]
    assert [(i["name"], i["nameKey"]) for i in items] == [("Iron Ingot", "铁块"), ("钢材", "钢材")]


def test_item_defaults_for_missing_optional_fields():
    item = run(make_bundle(items=[item_proto(1101)]))["items"][0]
    assert item == {
        "id": 1101,
        "name": "铁块",
        "nameKey": "铁块",
        "type": "MATERIAL",
        "stackSize": 100,
        "isFluid": False,
        "canBuild": False,
        "productive": False,
        "gridIndex": 1101,
        "iconPath": "",
        "heatValue": 0,
        "modelIndex": 0,
    }


def test_proliferator_items_get_ability_and_sprays_from_hpmax():
    items = [item_proto(1141, "增产剂 Mk.I", ability=1, hpMax=12), item_proto(1143, "增产剂 Mk.III", ability=4, hpMax=60)]
    out = run(make_bundle(items=items))["items"]
    assert out[0]["proliferator"] == {"ability": 1, "sprays": 12}
    assert out[1]["proliferator"] == {"ability": 4, "sprays": 60}
    assert "proliferator" not in run(make_bundle(items=[item_proto(1101, ability=1, hpMax=12)]))["items"][0]


@pytest.mark.parametrize(
    ("missing", "label"),
    [
        ("id", r"item \? \(铁块\)"),
        ("name", r"item 1101 \(\?\)"),
        ("type", r"item 1101 \(铁块\)"),
        ("stackSize", r"item 1101 \(铁块\)"),
        ("gridIndex", r"item 1101 \(铁块\)"),
    ],
)
def test_item_required_fields(missing, label):
    proto = item_proto(1101)
    del proto[missing]
    with pytest.raises(NormalizeError, match=rf"^{label}: missing field {missing}$"):
        run(make_bundle(items=[proto]))


# ---- recipes ----------------------------------------------------------------------------------


def test_recipe_missing_timespend_raises_naming_recipe_and_field():
    proto = recipe_proto()
    del proto["timeSpend"]
    with pytest.raises(NormalizeError) as err:
        run(make_bundle(recipes=[proto]))
    assert str(err.value) == "recipe 51 (处理器): missing field timeSpend"


@pytest.mark.parametrize("missing", ["id", "name", "type", "timeSpend", "items", "itemCounts", "results", "resultCounts"])
def test_recipe_required_fields(missing):
    proto = recipe_proto()
    del proto[missing]
    with pytest.raises(NormalizeError, match=f"missing field {missing}"):
        run(make_bundle(recipes=[proto]))


def test_recipe_defaulted_flags_never_raise():
    recipe = run(make_bundle(recipes=[recipe_proto()]))["recipes"][0]
    assert recipe["explicit"] is False
    assert recipe["handcraft"] is False
    assert recipe["nonProductive"] is False
    assert recipe["gridIndex"] == 0


def test_recipe_mismatched_count_lists_raise():
    with pytest.raises(NormalizeError, match=r"recipe 51 \(处理器\): .*itemCounts"):
        run(make_bundle(recipes=[recipe_proto(itemCounts=[2])]))


def test_recipe_name_uses_locale():
    out = run(make_bundle(recipes=[recipe_proto()], locale={"处理器": "Processor"}))
    assert out["recipes"][0]["name"] == "Processor"


# ---- techs ------------------------------------------------------------------------------------


def test_tech_missing_prerequisites_defaults_to_empty():
    tech = run(make_bundle(techs=[{"id": 1302, "name": "T处理器"}]))["techs"][0]
    assert tech == {
        "id": 1302,
        "name": "T处理器",
        "preTechs": [],
        "preTechsImplicit": [],
        "unlockRecipes": [],
        "unlockFunctions": [],
        "level": 0,
        "maxLevel": 0,
        "isObsolete": False,
        "isHidden": False,
        "published": False,
        "position": [0, 0],
    }


def test_tech_unlock_functions_zip_with_values_and_hidden_flag_renamed():
    proto = {
        "id": 2201,
        "name": "T能量回路",
        "preTechs": [1001],
        "unlockRecipes": [5, 6],
        "unlockFunctions": [3, 7],
        "unlockValues": [0.5, {":type": "BigInt", "value": "2"}],
        "isHiddenTech": True,
        "published": True,
        "position": [5, 1],
        "level": 1,
        "maxLevel": 10000,
    }
    tech = run(make_bundle(techs=[proto]))["techs"][0]
    assert tech["unlockFunctions"] == [{"func": 3, "value": 0.5}, {"func": 7, "value": 2}]
    assert tech["isHidden"] is True
    assert tech["position"] == [5, 1]
    assert tech["maxLevel"] == 10000


def test_tech_unlock_values_length_mismatch_raises():
    with pytest.raises(NormalizeError, match=r"tech 3 \(T.*\): .*unlockValues"):
        run(make_bundle(techs=[{"id": 3, "name": "T测试", "unlockFunctions": [1, 2], "unlockValues": [1.0]}]))


@pytest.mark.parametrize("missing", ["id", "name"])
def test_tech_required_fields(missing):
    proto = {"id": 1, "name": "T戴森球计划"}
    del proto[missing]
    with pytest.raises(NormalizeError, match=f"missing field {missing}"):
        run(make_bundle(techs=[proto]))


def test_duplicate_ids_raise():
    with pytest.raises(NormalizeError, match="duplicate"):
        run(make_bundle(items=[item_proto(1101), item_proto(1101)]))


# ---- building kinds and descriptor fields -----------------------------------------------------


def test_unknown_building_without_descriptors_is_other():
    bundle = make_bundle(
        items=[item_proto(9999, "神秘建筑", canBuild=True)],
        buildings=[RawBuilding(item_id=9999, model_index=7, descs={}, colliders=None, slot_poses=None, port_poses=None)],
    )
    b = building_of(bundle, 9999)
    assert b["kind"] == "other"
    assert b["power"] == {"consumer": False, "workPerTick": 0, "idlePerTick": 0}
    assert b["modelIndex"] == 7
    assert b["name"] == "神秘建筑"
    for block in ("production", "lab", "belt", "sorter", "station", "sprayCoater"):
        assert block not in b


def test_building_without_an_item_proto_raises():
    bundle = make_bundle(buildings=[building(2303, AssemblerDesc={"speed": 7500, "recipeType": 4})])
    with pytest.raises(NormalizeError, match="building 2303"):
        run(bundle)


def test_building_name_uses_locale_of_item_name_key():
    bundle = building_bundle(2303, "制造台 Mk.I", AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"})
    bundle.locale = {"制造台 Mk.I": "Assembling Machine Mk.I"}
    assert building_of(bundle, 2303)["name"] == "Assembling Machine Mk.I"


def test_assembler_dump_shape():
    b = building_of(building_bundle(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"}), 2303)
    assert b["kind"] == "production"
    assert b["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}


def test_assembler_game_shape_converts_speedf():
    b = building_of(building_bundle(2303, AssemblerDesc={"recipeType": 4, "speedf": 0.75}), 2303)
    assert b["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}


def test_assembler_pascal_case_descriptor_fields():
    b = building_of(building_bundle(2303, AssemblerDesc={"RecipeType": 4, "Speedf": 1.5}), 2303)
    assert b["production"] == {"recipeType": "ASSEMBLE", "speed": 15000}


def test_assembler_missing_speed_raises():
    with pytest.raises(NormalizeError, match=r"building 2303 \(测试建筑\): missing field AssemblerDesc.speed"):
        run(building_bundle(2303, AssemblerDesc={"recipeType": "ASSEMBLE"}))


def test_assembler_implausible_speed_raises():
    with pytest.raises(NormalizeError, match=r"AssemblerDesc.speed"):
        run(building_bundle(2303, AssemblerDesc={"recipeType": 4, "speedf": 0.0001}))


def test_sorter_game_shape_converts_sttf_and_takes_grade_from_chain():
    b = building_of(building_bundle(2012, InserterDesc={"sttf": 0.33333334, "delayf": 0}), 2012)
    assert b["kind"] == "sorter"
    assert b["sorter"] == {"grade": 2, "stt": 200000, "delay": 0, "canStack": False, "stackSize": 1}


def test_sorter_dump_shape_and_descriptor_grade_wins():
    b = building_of(
        building_bundle(2011, InserterDesc={"stt": 200000, "delay": 30, "canStack": True, "stackSize": 4, "grade": 3}), 2011
    )
    assert b["sorter"] == {"grade": 3, "stt": 200000, "delay": 30, "canStack": True, "stackSize": 4}


def test_sorter_delayf_converts():
    b = building_of(building_bundle(2014, InserterDesc={"sttf": 0.25, "delayf": 0.1}), 2014)
    assert b["sorter"]["delay"] == 60000
    assert b["sorter"]["grade"] == 4


def test_sorter_outside_chain_without_grade_raises():
    with pytest.raises(NormalizeError, match="InserterDesc.grade"):
        run(building_bundle(2999, InserterDesc={"stt": 200000}))


def test_sorter_missing_stt_raises_and_implausible_stt_raises():
    with pytest.raises(NormalizeError, match="missing field InserterDesc.stt"):
        run(building_bundle(2011, InserterDesc={"delay": 0}))
    with pytest.raises(NormalizeError, match="InserterDesc.stt"):
        run(building_bundle(2011, InserterDesc={"stt": 999}))


def test_belt_speed_required_and_guarded():
    b = building_of(building_bundle(2003, BeltDesc={"beltPrototype": 2003, "speed": 5}), 2003)
    assert b["kind"] == "belt"
    assert b["belt"] == {"speed": 5}
    with pytest.raises(NormalizeError, match="missing field BeltDesc.speed"):
        run(building_bundle(2003, BeltDesc={"beltPrototype": 2003}))
    for bad in (0.0, 21, 600000):
        with pytest.raises(NormalizeError, match="BeltDesc.speed"):
            run(building_bundle(2003, BeltDesc={"speed": bad}))


def test_belt_with_zero_speed_is_not_a_belt_kind_but_still_fails_guard():
    # BeltDesc.speed > 0 makes a belt; a descriptor with no usable speed is a data error, not "other".
    with pytest.raises(NormalizeError, match="BeltDesc.speed"):
        run(building_bundle(2003, BeltDesc={"speed": 0}))


def test_lab_speed_conversion_accepts_both_shapes():
    dump = building_of(building_bundle(2901, LabDesc={"assembleSpeed": 10000, "researchSpeed": 1}), 2901)
    game = building_of(building_bundle(2902, LabDesc={"assembleSpeed": 3.0, "researchSpeed": 3.0}), 2902)
    assert dump["kind"] == "lab"
    assert dump["lab"] == {"assembleSpeed": 10000, "researchSpeed": 10000}
    assert game["lab"] == {"assembleSpeed": 30000, "researchSpeed": 30000}


def test_lab_int_at_least_100_is_used_as_is():
    b = building_of(building_bundle(2902, LabDesc={"assembleSpeed": 30000, "researchSpeed": 30000}), 2902)
    assert b["lab"] == {"assembleSpeed": 30000, "researchSpeed": 30000}


def test_station_kind_and_block():
    desc = {
        "isStellar": True,
        "maxItemCount": 10000,
        "maxItemKinds": 5,
        "maxDroneCount": 100,
        "maxShipCount": 10,
        "maxEnergyAcc": {":type": "BigInt", "value": "12000000000"},
        "isCollector": False,
        "isVeinCollector": False,
    }
    b = building_of(building_bundle(2104, StationDesc=desc), 2104)
    assert b["kind"] == "station"
    assert b["station"] == {
        "isStellar": True,
        "maxItemKinds": 5,
        "maxItemCount": 10000,
        "maxEnergyAcc": 12000000000,
        "maxDroneCount": 100,
        "maxShipCount": 10,
    }


def test_station_max_item_kinds_required():
    with pytest.raises(NormalizeError, match="missing field StationDesc.maxItemKinds"):
        run(building_bundle(2104, StationDesc={"isStellar": True}))


def test_advanced_mining_machine_vein_collector_is_other():
    b = building_of(
        building_bundle(2316, "大型采矿机", StationDesc={"maxItemKinds": 1, "maxItemCount": 5000, "isVeinCollector": True}),
        2316,
    )
    assert b["kind"] == "other"
    assert "station" not in b


def test_orbital_collector_is_other():
    b = building_of(building_bundle(2105, StationDesc={"maxItemKinds": 6, "isCollector": True, "isStellar": True}), 2105)
    assert b["kind"] == "other"


def test_power_node_kind_and_block():
    desc = {"node": True, "connectDistance": 22.5, "coverRadius": 10.5, "powerPoint": [0, 4, 0]}
    b = building_of(building_bundle(2201, PowerDesc=desc), 2201)
    assert b["kind"] == "powerNode"
    assert b["power"] == {
        "consumer": False,
        "workPerTick": 0,
        "idlePerTick": 0,
        "node": {"connectDistance": 22.5, "coverRadius": 10.5, "powerPoint": [0, 4, 0]},
    }


@pytest.mark.parametrize("flag", ["generator", "accumulator", "exchanger"])
def test_grid_members_that_generate_or_store_power_are_not_poles(flag):
    desc = {"node": True, "connectDistance": 16.5, "coverRadius": 7.7, "powerPoint": [0, 0.4, 0], flag: True}
    b = building_of(building_bundle(2203, PowerDesc=desc), 2203)
    assert b["kind"] == "other"
    assert b["power"]["node"]["connectDistance"] == 16.5  # the node block is still reported


def test_power_node_missing_fields_raise():
    with pytest.raises(NormalizeError, match="PowerDesc.coverRadius"):
        run(building_bundle(2201, PowerDesc={"node": True, "connectDistance": 22.5, "powerPoint": [0, 4, 0]}))


def test_spray_coater_kind_and_block():
    b = building_of(
        building_bundle(2313, SpraycoaterDesc={"incCapacity": 600, "incItemId": [1141, 1142, 1143]}), 2313
    )
    assert b["kind"] == "sprayCoater"
    assert b["sprayCoater"] == {"incCapacity": 600, "incItemIds": [1141, 1142, 1143]}


@pytest.mark.parametrize(
    ("item_id", "descs", "kind"),
    [
        (2999, {"SplitterDesc": {}}, "splitter"),
        (2020, {}, "splitter"),
        (2314, {"FractionatorDesc": {"recipeType": "FRACTIONATE"}}, "fractionator"),
        (2998, {"PilerDesc": {}}, "piler"),
        (2040, {}, "piler"),
        (2101, {"StorageDesc": {"colCount": 10, "rowCount": 3}}, "storage"),
        (2204, {"PowerDesc": {"consumer": True}}, "other"),
        (3001, {"TurretDesc": {}}, "other"),
    ],
)
def test_kind_from_remaining_descriptors(item_id, descs, kind):
    assert building_of(building_bundle(item_id, **descs), item_id)["kind"] == kind


def test_kind_precedence_production_over_power_consumer():
    b = building_of(
        building_bundle(
            2303,
            AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"},
            PowerDesc={"consumer": True, "workEnergyPerTick": 4500, "idleEnergyPerTick": 200},
        ),
        2303,
    )
    assert b["kind"] == "production"
    assert b["power"]["consumer"] is True


# ---- geometry source --------------------------------------------------------------------------


def test_missing_collider_data_gives_approximate_geometry():
    bundle = building_bundle(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"})
    geometry = building_of(bundle, 2303)["geometry"]
    assert geometry["source"] == "approximate"
    assert len(geometry["slots"]) == 12
    assert geometry["colliders"][0]["usage"] == "build"
    assert geometry["selectSize"] == [4.2, 4.6, 4.2]
    assert geometry["landPoints"] == BUILD_CONDITION["landPoints"]


def test_partial_extraction_still_counts_as_approximate():
    bundle = building_bundle(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"})
    bundle.buildings[0].colliders = [
        {"center": [0, 1, 0], "halfExtents": [1, 1, 1], "rotation": [0, 0, 0, 1], "usage": "build"}
    ]
    assert building_of(bundle, 2303)["geometry"]["source"] == "approximate"


def test_all_three_extracted_gives_extracted_geometry():
    bundle = building_bundle(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"})
    raw = bundle.buildings[0]
    raw.colliders = [
        {"center": [0, 2.3, 0], "halfExtents": [1.9, 2.3, 1.9], "rotation": [0, 0, 0, 1], "usage": "build"},
        {"center": [0, 1, 0], "halfExtents": [1, 1, 1], "rotation": [0, 0, 0, 1], "usage": 0},
        {"center": [0, 1, 0], "halfExtents": [1, 1, 1], "rotation": [0, 0, 0, 1], "usage": "belt"},
    ]
    raw.slot_poses = [{"position": [1.1, 0, 1.0], "rotation": [0, 0, 0, 1]}]
    raw.port_poses = []
    geometry = building_of(bundle, 2303)["geometry"]
    assert geometry["source"] == "extracted"
    assert [c["usage"] for c in geometry["colliders"]] == ["build", "physics", "other"]
    assert geometry["slots"] == [{"position": [1.1, 0, 1.0], "rotation": [0, 0, 0, 1]}]
    assert geometry["ports"] == []
    assert geometry["blueprintBoxSize"] == [3.8, 3.8]
    assert geometry["selectCenter"] == [0, 2.3, 0]


def test_blueprint_box_size_override_wins_when_large_enough():
    cfg = copy.deepcopy(BUILD_CONDITION)
    cfg["blueprintBoxSizeOverride"] = [3.0, 2.0]
    bundle = building_bundle(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"}, BuildConditionConfig=cfg)
    assert building_of(bundle, 2303)["geometry"]["blueprintBoxSize"] == [3.0, 2.0]


# ---- constants, meta, schema ------------------------------------------------------------------


def test_default_constants_cover_every_schema_constant():
    schema = __import__("json").loads(SCHEMA_PATH.read_text())
    keys = set(schema["properties"]["constants"]["properties"])
    assert set(DEFAULT_CONSTANTS) == keys
    assert set(DEFAULT_CONSTANT_SOURCES) == keys
    assert DEFAULT_CONSTANTS["incTableMilli"] == [0, 125, 200, 225, 250, 275, 300, 325, 350, 375, 400]
    assert DEFAULT_CONSTANTS["accTableMilli"] == [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500]
    assert DEFAULT_CONSTANTS["powerTableRatio"] == [0, 300, 700, 1100, 1500, 1900, 2300, 2700, 3100, 3500, 3900]
    assert all("unverified" in s for s in DEFAULT_CONSTANT_SOURCES.values() if s.startswith("research:"))


def test_constants_default_and_overrides_carry_their_source():
    out = run(make_bundle())
    assert out["constants"] == DEFAULT_CONSTANTS
    assert out["constantSources"] == DEFAULT_CONSTANT_SOURCES

    out = run(make_bundle(constants={"cargoLength": 10}, constant_sources={"cargoLength": "code:CargoPath.kCargoLength"}))
    assert out["constantSources"]["cargoLength"] == "code:CargoPath.kCargoLength"
    assert out["constantSources"]["ticksPerSecond"] == DEFAULT_CONSTANT_SOURCES["ticksPerSecond"]


def test_constant_override_without_source_raises():
    with pytest.raises(NormalizeError, match="cargoLength"):
        run(make_bundle(constants={"cargoLength": 12}))


def test_unknown_constant_raises():
    with pytest.raises(NormalizeError, match="bogus"):
        run(make_bundle(constants={"bogus": 1}, constant_sources={"bogus": "x"}))


def test_default_constants_are_not_shared_with_the_output():
    out = run(make_bundle())
    out["constants"]["incTableMilli"].append(1)
    assert len(DEFAULT_CONSTANTS["incTableMilli"]) == 11


def test_meta_block():
    bundle = make_bundle()
    bundle.steam_build_id = "12345"
    bundle.proto_signatures = {"ItemProto": "abc"}
    meta = run(bundle)["meta"]
    assert meta == {
        "schemaVersion": 1,
        "gameVersion": "0.10.29.22015",
        "steamBuildId": "12345",
        "extractedAt": NOW,
        "extractorVersion": "0.1.0",
        "source": "fixture",
        "protoSignatures": {"ItemProto": "abc"},
    }
    meta = run(make_bundle())["meta"]
    assert "steamBuildId" not in meta
    assert "protoSignatures" not in meta


def test_output_is_sorted_by_id_and_validates_against_the_schema():
    bundle = make_bundle(
        items=[item_proto(2303, "制造台 Mk.I", canBuild=True), item_proto(1101)],
        buildings=[building(2303, AssemblerDesc={"speed": 7500, "recipeType": "ASSEMBLE"})],
    )
    out = run(bundle)
    assert [i["id"] for i in out["items"]] == [1101, 2303]
    validate_against_schema(out, SCHEMA_PATH)
