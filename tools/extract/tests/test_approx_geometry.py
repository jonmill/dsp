"""Tests for approximate building geometry, including calibration against real blueprints."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from blueprint_decode import Blueprint, BpBuilding, load_blueprint
from dsp_extract.approx_geometry import TILE, approx_geometry

REPO_ROOT = Path(__file__).resolve().parents[3]
SAMPLES = REPO_ROOT / "docs" / "research" / "blueprint-samples"
CAPSULE_SAMPLE = SAMPLES / "capsule-production-v2-reform-0.10.33.txt"
ILS_SAMPLE = SAMPLES / "ils-configured-0.9.24.txt"

TOLERANCE_M = 0.35
SQRT_HALF = math.sqrt(0.5)

ASSEMBLER_DESCS = {
    "SlotConfig": {
        "selectCenter": [0, 2.299999952316284, 0],
        "selectSize": [4.199999809265137, 4.599999904632568, 4.199999809265137],
        "slotPoses": [],
        "insertPoses": [None] * 12,
    },
    "BuildConditionConfig": {
        "landPoints": [[-2, 0.3, 2], [2, 0.3, 2], [2, 0.3, -2], [-2, 0.3, -2]],
        "multiLevel": False,
    },
}

_STATION_LAND = [[4, 0.3, -2], [-4, 0.3, -2], [-4, 0.3, 2], [4, 0.3, 2], [2, 0.3, -4], [-2, 0.3, -4], [-2, 0.3, 4], [2, 0.3, 4]]
STATION_DESCS = {
    "SlotConfig": {
        "selectCenter": [0, 17, 0],
        "selectSize": [8, 34, 8],
        "slotPoses": [None] * 12,
        "insertPoses": [],
    },
    "BuildConditionConfig": {"landPoints": _STATION_LAND, "multiLevel": False},
}


def assembler_geometry() -> dict:
    return approx_geometry(ASSEMBLER_DESCS, 12, 0)


def station_geometry() -> dict:
    return approx_geometry(STATION_DESCS, 0, 12)


def xz(pose: dict) -> tuple[float, float]:
    return pose["position"][0], pose["position"][2]


def yaw_of(rotation: list[float]) -> int:
    """Yaw in degrees (0/90/180/270) of a quaternion about +y."""
    return round(math.degrees(2 * math.atan2(rotation[1], rotation[3]))) % 360


# ---- assembler --------------------------------------------------------------------------------


def test_assembler_footprint_and_collider():
    geometry = assembler_geometry()
    assert geometry["source"] == "approximate"
    assert len(geometry["colliders"]) == 1
    collider = geometry["colliders"][0]
    assert collider["usage"] == "build"
    assert collider["halfExtents"] == pytest.approx([2, 2.3, 2])
    assert collider["center"] == pytest.approx([0, 2.3, 0])
    assert collider["rotation"] == [0, 0, 0, 1]
    assert geometry["blueprintBoxSize"] == pytest.approx([4, 4])
    assert geometry["selectSize"] == ASSEMBLER_DESCS["SlotConfig"]["selectSize"]
    assert geometry["landPoints"] == ASSEMBLER_DESCS["BuildConditionConfig"]["landPoints"]
    assert geometry["ports"] == []


def test_assembler_has_twelve_slots_three_per_side_facing_outward():
    slots = assembler_geometry()["slots"]
    assert len(slots) == 12
    # sides in index order: north, east, south, west; outward yaw 0/90/180/270
    for side, yaw in enumerate((0, 90, 180, 270)):
        for slot in slots[3 * side : 3 * side + 3]:
            assert yaw_of(slot["rotation"]) == yaw
    assert all(slot["position"][1] == 0 for slot in slots)


def test_assembler_slot_three_is_east_face_north_end():
    slot = assembler_geometry()["slots"][3]
    assert slot["position"] == pytest.approx([1.11, 0, 1.0])
    assert slot["rotation"] == pytest.approx([0, SQRT_HALF, 0, SQRT_HALF])


def test_assembler_slots_run_clockwise_from_north_west():
    slots = assembler_geometry()["slots"]
    expected = {
        0: (-1.0, 1.11), 1: (0.0, 1.11), 2: (1.0, 1.11),
        3: (1.11, 1.0), 4: (1.11, 0.0), 5: (1.11, -1.0),
        6: (1.0, -1.11), 7: (0.0, -1.11), 8: (-1.0, -1.11),
        9: (-1.11, -1.0), 10: (-1.11, 0.0), 11: (-1.11, 1.0),
    }  # fmt: skip
    for index, (x, z) in expected.items():
        assert xz(slots[index]) == pytest.approx((x, z)), index


def test_geometry_is_deterministic_and_has_no_negative_zero():
    assert assembler_geometry() == assembler_geometry()
    for pose in assembler_geometry()["slots"] + station_geometry()["ports"]:
        for value in pose["position"] + pose["rotation"]:
            assert math.copysign(1.0, value) > 0 or value != 0


# ---- station ----------------------------------------------------------------------------------


def test_station_has_two_cross_shaped_build_boxes():
    colliders = station_geometry()["colliders"]
    assert [c["usage"] for c in colliders] == ["build", "build"]
    assert colliders[0]["halfExtents"] == pytest.approx([4, 17, 2])
    assert colliders[1]["halfExtents"] == pytest.approx([2, 17, 4])
    assert station_geometry()["blueprintBoxSize"] == pytest.approx([8, 8])


def test_station_ports_counter_clockwise_from_north_east():
    geometry = station_geometry()
    ports = geometry["ports"]
    assert geometry["slots"] == []
    assert len(ports) == 12
    n = 2.70
    expected = {
        0: (TILE, n), 1: (0, n), 2: (-TILE, n),
        3: (-n, TILE), 4: (-n, 0), 5: (-n, -TILE),
        6: (-TILE, -n), 7: (0, -n), 8: (TILE, -n),
        9: (n, -TILE), 10: (n, 0), 11: (n, TILE),
    }  # fmt: skip
    for index, (x, z) in expected.items():
        assert xz(ports[index]) == pytest.approx((x, z)), index
    # port 0 is on the north face, east end
    assert ports[0]["position"][0] > 0 and ports[0]["position"][2] > 0
    assert [yaw_of(p["rotation"]) for p in ports] == [0] * 3 + [270] * 3 + [180] * 3 + [90] * 3


def test_three_ports_per_face():
    ports = station_geometry()["ports"]
    for side in range(4):
        face = ports[3 * side : 3 * side + 3]
        assert len({yaw_of(p["rotation"]) for p in face}) == 1


# ---- footprint rules --------------------------------------------------------------------------


def test_footprint_from_select_size_when_fewer_than_two_land_points():
    descs = {
        "SlotConfig": {"selectCenter": [0, 1, 0], "selectSize": [2.2, 2, 3], "slotPoses": [], "insertPoses": []},
        "BuildConditionConfig": {"landPoints": [[0, 0.2, 0]]},
    }
    collider = approx_geometry(descs, 0, 0)["colliders"][0]
    assert collider["halfExtents"] == pytest.approx([1.0, 1.0, 1.4])
    assert collider["center"] == pytest.approx([0, 1, 0])


def test_diamond_land_points_stay_a_single_box():
    descs = {
        "SlotConfig": {"selectCenter": [0, 1.2, 0], "selectSize": [2.7, 2.4, 2.7], "slotPoses": [None] * 4},
        "BuildConditionConfig": {"landPoints": [[0, 0.09, 1.28], [1.28, 0.09, 0], [0, 0.09, -1.28], [-1.28, 0.09, 0]]},
    }
    geometry = approx_geometry(descs, 0, 4)
    assert len(geometry["colliders"]) == 1
    assert geometry["colliders"][0]["halfExtents"] == pytest.approx([1.28, 1.2, 1.28])
    # splitter: one port per side at lateral 0, in round-robin (clockwise from north) order
    ports = geometry["ports"]
    assert [yaw_of(p["rotation"]) for p in ports] == [0, 90, 180, 270]
    assert all(min(abs(c) for c in xz(p)) == 0 for p in ports)


def test_irregular_land_points_use_max_extents():
    descs = {
        "SlotConfig": {"selectCenter": [0, 5.3, -0.32], "selectSize": [4.2, 10.6, 7.4], "insertPoses": [None] * 9},
        "BuildConditionConfig": {
            "landPoints": [[0, 0.3, 3.3], [1.98, 0.3, 2], [-1.98, 0.3, 2], [-2.05, 0.3, -1], [2.05, 0.3, -1], [1.2, 0.3, -3.95], [-1.2, 0.3, -3.95]]
        },
    }
    geometry = approx_geometry(descs, 9, 0)
    assert geometry["colliders"][0]["halfExtents"] == pytest.approx([2.05, 5.3, 3.95])
    assert geometry["colliders"][0]["center"] == pytest.approx([0, 5.3, -0.32])
    slots = geometry["slots"]
    # three per side on north, east, south
    assert [yaw_of(s["rotation"]) for s in slots] == [0] * 3 + [90] * 3 + [180] * 3
    assert slots[1]["position"] == pytest.approx([0, 0, 3.95 - 0.9])
    assert slots[4]["position"] == pytest.approx([2.05 - 0.9, 0, 0])


def test_eight_slots_sit_on_the_long_sides():
    descs = {
        "SlotConfig": {"selectCenter": [0.48, 3.15, 0.78], "selectSize": [9.2, 6.3, 5.3], "insertPoses": [None] * 8},
        "BuildConditionConfig": {
            "landPoints": [[-4.2, 0.3, 0], [-2, 0.3, 3.38], [2.8, 0.3, 2.8], [4.8, 0.3, 0.5], [2.82, 0.3, -1.55], [-2.2, 0.3, -1.8]]
        },
    }
    slots = approx_geometry(descs, 8, 0)["slots"]
    assert [yaw_of(s["rotation"]) for s in slots] == [0] * 4 + [180] * 4
    assert [s["position"][0] for s in slots[:4]] == pytest.approx([-1.5 * TILE, -0.5 * TILE, 0.5 * TILE, 1.5 * TILE])
    assert [s["position"][0] for s in slots[4:]] == pytest.approx([1.5 * TILE, 0.5 * TILE, -0.5 * TILE, -1.5 * TILE])
    assert slots[0]["position"][2] == pytest.approx(3.38 - 0.9)
    assert slots[4]["position"][2] == pytest.approx(-(3.38 - 0.9))


def test_other_slot_counts_round_robin_across_sides():
    descs = {
        "SlotConfig": {"selectCenter": [0, 1, 0], "selectSize": [5, 2, 5], "insertPoses": [None] * 5},
        "BuildConditionConfig": {"landPoints": [[-2.4, 0, 2.4], [2.4, 0, 2.4], [2.4, 0, -2.4], [-2.4, 0, -2.4]]},
    }
    slots = approx_geometry(descs, 5, 0)["slots"]
    assert [yaw_of(s["rotation"]) for s in slots] == [0, 90, 180, 270, 0]
    # two slots on the north side are centred on 0 and one tile apart
    assert slots[0]["position"][0] == pytest.approx(-TILE / 2)
    assert slots[4]["position"][0] == pytest.approx(TILE / 2)
    assert slots[0]["position"][2] == pytest.approx(2.4 - 0.9)


def test_no_slots_or_ports_for_zero_counts():
    geometry = approx_geometry({"SlotConfig": {"selectCenter": [0, 0.5, 0], "selectSize": [1, 1, 1]}}, 0, 0)
    assert geometry["slots"] == [] and geometry["ports"] == []
    assert geometry["colliders"][0]["halfExtents"] == pytest.approx([0.4, 0.5, 0.4])


def test_empty_descs_fall_back_to_a_unit_cube():
    geometry = approx_geometry({}, 0, 0)
    assert geometry["colliders"][0]["halfExtents"] == pytest.approx([0.4, 0.5, 0.4])
    assert geometry["selectSize"] == [1, 1, 1]
    assert geometry["landPoints"] == []


def test_pascal_case_config_fields_are_accepted():
    descs = {
        "SlotConfig": {"SelectCenter": [0, 1, 0], "SelectSize": [2, 2, 2]},
        "BuildConditionConfig": {"LandPoints": [[-1, 0, 1], [1, 0, 1], [1, 0, -1], [-1, 0, -1]], "MultiLevel": True},
    }
    geometry = approx_geometry(descs, 0, 0)
    assert geometry["colliders"][0]["halfExtents"] == pytest.approx([1, 1, 1])
    assert geometry["multiLevel"] is True


# ---- calibration against real blueprints -----------------------------------------------------


def to_local(building: BpBuilding, point: tuple[float, float, float]) -> tuple[float, float, float]:
    """Metres in the building's prefab frame (px right, py up, pz forward) for a grid-space point.

    Inverts the plan's shared convention `east = px*cos(t) + pz*sin(t)`, `north = -px*sin(t) + pz*cos(t)`
    (yaw t clockwise from north) after scaling grid units to metres.
    """
    theta = math.radians(building.yaw)
    east = (point[0] - building.pos[0]) * TILE
    north = (point[1] - building.pos[1]) * TILE
    px = east * math.cos(theta) - north * math.sin(theta)
    pz = east * math.sin(theta) + north * math.cos(theta)
    return px, (point[2] - building.pos[2]) * (4 / 3), pz


def test_to_local_inverts_the_plan_convention():
    base = BpBuilding(
        index=0, item_id=2304, model_index=66, area_index=0, pos=(10.0, 10.0, 0.0), yaw=90.0,
        pos2=(10.0, 10.0, 0.0), yaw2=90.0, output_obj_idx=-1, input_obj_idx=-1, output_to_slot=-1,
        input_from_slot=-1, output_from_slot=-1, input_to_slot=-1, output_offset=0, input_offset=0,
        recipe_id=0, filter_id=0,
    )  # fmt: skip
    # yaw 90 turns the prefab's +z (forward) to the east: a point one tile east is straight ahead
    px, py, pz = to_local(base, (11.0, 10.0, 1.0))
    assert (px, pz) == pytest.approx((0.0, TILE), abs=1e-9)
    assert py == pytest.approx(4 / 3)


def require(path: Path) -> Blueprint:
    if not path.is_file():
        pytest.skip(f"blueprint sample missing: {path}")
    return load_blueprint(path)


def test_calibration_assembler_slots_match_capsule_sample():
    blueprint = require(CAPSULE_SAMPLE)
    buildings = blueprint.buildings
    slots = assembler_geometry()["slots"]
    checked = 0
    seen = set()
    for sorter in (b for b in buildings if b.item_id == 2013):
        ends = (
            (sorter.input_obj_idx, sorter.input_from_slot, sorter.pos),  # pick end
            (sorter.output_obj_idx, sorter.output_to_slot, sorter.pos2),  # drop end
        )
        for obj_idx, slot_index, end in ends:
            if obj_idx < 0 or buildings[obj_idx].item_id != 2304:
                continue
            px, py, pz = to_local(buildings[obj_idx], end)
            slot = slots[slot_index]["position"]
            distance = math.hypot(px - slot[0], pz - slot[2])
            assert distance < TOLERANCE_M, (obj_idx, slot_index, (px, pz), slot)
            assert abs(py - slot[1]) < TOLERANCE_M
            seen.add(slot_index)
            checked += 1
    assert checked == 36
    assert seen == {3, 4, 5, 9, 10, 11}


def test_calibration_station_ports_match_ils_sample():
    blueprint = require(ILS_SAMPLE)
    buildings = blueprint.buildings
    ils = next(b for b in buildings if b.item_id == 2104)
    ports = station_geometry()["ports"]
    checked = set()
    for belt in buildings:
        if belt.input_obj_idx != ils.index:
            continue
        px, py, pz = to_local(ils, belt.pos)  # first belt node
        port = ports[belt.input_from_slot]["position"]
        distance = math.hypot(px - port[0], pz - port[2])
        assert distance < TOLERANCE_M, (belt.input_from_slot, (px, pz), port)
        checked.add(belt.input_from_slot)
    assert checked == set(range(12))
