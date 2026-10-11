import math

import pytest
from fake_unity import H, IDENTITY, NULL, YAW_90, YAW_180, FakeEnv, PrefabBuilder, ptr, v3

from dsp_extract import prefab
from dsp_extract.prefab import (
    Pose,
    PrefabError,
    classify_collider,
    compose,
    describe_prefab,
    find_collider_prefab,
    quat_mul,
    quat_rotate,
    read_building,
    walk_hierarchy,
    world_pose,
)
from dsp_extract.report import Report

ITEM = {"ID": 2303, "Name": "组装机", "ModelIndex": 65, "CanBuild": True}
MODEL = {"ID": 65, "Name": "组装机", "PrefabPath": "Entities/Prefabs/Assembler-MK-1"}


def approx(values):
    return pytest.approx(values, abs=1e-5)


# ---- quaternion maths -------------------------------------------------------------------------


def test_quat_rotate_matches_unity_yaw_convention():
    # Quaternion.Euler(0, 90, 0) * Vector3.right == (0, 0, -1); Vector3.forward -> (1, 0, 0)
    assert quat_rotate(YAW_90, (1, 0, 0)) == approx((0, 0, -1))
    assert quat_rotate(YAW_90, (0, 0, 1)) == approx((1, 0, 0))
    assert quat_rotate(YAW_90, (0, 5, 0)) == approx((0, 5, 0))
    assert quat_rotate(IDENTITY, (1, 2, 3)) == approx((1, 2, 3))


def test_quat_mul_composes_rotations_right_to_left():
    assert quat_mul(YAW_90, YAW_90) == approx(YAW_180)
    pitch_90 = (H, 0.0, 0.0, H)  # +90 degrees about +x: forward (0,0,1) -> (0,-1,0) in Unity
    assert quat_rotate(pitch_90, (0, 0, 1)) == approx((0, -1, 0))
    # apply the pitch first, then the yaw
    both = quat_mul(YAW_90, pitch_90)
    assert quat_rotate(both, (0, 0, 1)) == approx(quat_rotate(YAW_90, (0, -1, 0)))


def test_compose_applies_parent_scale_rotation_and_translation():
    parent = Pose(position=(10, 0, 0), rotation=YAW_90, scale=(2, 2, 2))
    child = Pose(position=(1, 0, 0), rotation=YAW_90, scale=(1, 3, 1))
    world = compose(parent, child)
    assert world.position == approx((10, 0, -2))
    assert world.rotation == approx(YAW_180)
    assert world.scale == approx((2, 6, 2))


# ---- the reference building -------------------------------------------------------------------


def build_assembler(env: FakeEnv | None = None):
    """root (yaw 90) -> slots (yaw 90) -> c0, c1, c2; root -> body (scale 2) with a BoxCollider."""
    env = env or FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("assembler-mk-1", rot=YAW_90)
    slots = b.game_object("slots", root, pos=(0, 0, 1), rot=YAW_90)
    c0 = b.game_object("c0", slots, pos=(2, 0, 0))
    c1 = b.game_object("c1", slots, pos=(0, 3, 1), rot=YAW_90)
    c2 = b.game_object("c2", slots, pos=(1, 0, -1))
    body = b.game_object("body", root, pos=(0, 1, 0), scale=(2, 2, 2))
    b.box(body, center=(0, 0.5, 0), size=(1, 2, 3))
    extra = b.game_object("extra", root)
    b.mono(root, "AssemblerDesc", recipeType=4, speedf=0.75)
    b.mono(extra, "AssemblerDesc", recipeType=4, speedf=9.0)  # later in hierarchy order: ignored
    b.mono(root, "BuildConditionConfig", multiLevel=True)
    b.mono(
        root,
        "SlotConfig",
        slotPoses=[c0.transform, c1.transform, c2.transform],  # belt ports
        insertPoses=[c1.transform, c2.transform],  # sorter slots
        selectSize=v3(4.2, 4.6, 4.2),
    )
    b.mono(root, "AnimDesc", speed=1.0)  # rendering-only: not kept
    b.mono(root, "SomeUiBehaviour", x=1)  # not a descriptor class: not kept
    b.publish(root, "Entities/Prefabs/assembler-mk-1")
    return env, b, root


def test_reference_building_world_poses_and_port_slot_swap():
    env, _, _ = build_assembler()
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)

    assert raw.item_id == 2303 and raw.model_index == 65
    assert report.warnings == [] and report.errors == []

    # World = root yaw 90 * slots (pos (0,0,1), yaw 90) -> yaw 180 below "slots", slots at (1, 0, 0).
    assert [p["position"] for p in raw.port_poses] == [approx([-1, 0, 0]), approx([1, 3, -1]), approx([0, 0, 1])]
    assert raw.port_poses[0]["rotation"] == approx([0, 1, 0, 0])
    assert raw.port_poses[1]["rotation"] == approx([0, H, 0, -H])  # yaw 270
    # insertPoses -> slot_poses: the NAMING TRAP (ports come from slotPoses, slots from insertPoses)
    assert len(raw.port_poses) == 3 and len(raw.slot_poses) == 2
    assert [p["position"] for p in raw.slot_poses] == [approx([1, 3, -1]), approx([0, 0, 1])]

    # The descriptor keeps the entry counts the normalizer reads, now as plain pose data.
    slot_config = raw.descs["SlotConfig"]
    assert len(slot_config["slotPoses"]) == 3 and len(slot_config["insertPoses"]) == 2
    assert slot_config["slotPoses"][0]["position"] == approx([-1, 0, 0])
    assert slot_config["selectSize"] == {"x": 4.2, "y": 4.6, "z": 4.2}


def test_collider_half_extents_apply_scale_and_center_is_composed():
    env, _, _ = build_assembler()
    raw = read_building(env, MODEL, ITEM, Report())
    assert len(raw.colliders) == 1
    box = raw.colliders[0]
    # size (1, 2, 3) * lossy scale 2 / 2
    assert box["halfExtents"] == approx([1, 2, 3])
    # body at (0,1,0) under the yawed root; center (0, .5, 0) * 2 = (0, 1, 0) -> world (0, 2, 0)
    assert box["center"] == approx([0, 2, 0])
    assert box["rotation"] == approx([0, H, 0, H])
    assert box["usage"] == "build" and box["shape"] == "box"


def test_first_instance_of_each_descriptor_wins_and_non_descriptors_are_dropped():
    env, _, _ = build_assembler()
    raw = read_building(env, MODEL, ITEM, Report())
    assert set(raw.descs) == {"AssemblerDesc", "BuildConditionConfig", "SlotConfig"}
    assert raw.descs["AssemblerDesc"] == {"recipeType": 4, "speedf": 0.75}  # not 9.0; head keys stripped
    assert raw.descs["BuildConditionConfig"] == {"multiLevel": True}


def test_prefab_path_lookup_is_case_insensitive():
    env, _, _ = build_assembler()
    raw = read_building(env, {"PrefabPath": "ENTITIES/prefabs/ASSEMBLER-mk-1"}, ITEM, Report())
    assert raw.colliders is not None


def test_pair_style_component_entries_work():
    env, _, _ = build_assembler(FakeEnv(component_style="pair"))
    raw = read_building(env, MODEL, ITEM, Report())
    assert raw.colliders is not None and len(raw.port_poses) == 3


def test_report_records_the_building():
    env, _, _ = build_assembler()
    report = Report()
    read_building(env, MODEL, ITEM, report)
    record = report.sections["per_building_geometry"]["2303"]
    assert record["status"] == "extracted"
    assert record["prefab_path"] == "Entities/Prefabs/Assembler-MK-1"
    assert record["container_key"] == "entities/prefabs/assembler-mk-1"
    assert record["port_count"] == 3 and record["slot_count"] == 2
    assert record["descriptors"] == ["AssemblerDesc", "BuildConditionConfig", "SlotConfig"]
    assert record["components"]["MonoBehaviour"] == 6
    assert record["colliders"] == {"total": 1, "build": 1, "ignored_types": {}}
    assert record["collider_source"] == "prefab"


# ---- failures degrade to None, never raise ----------------------------------------------------


def test_missing_slot_config_gives_none_poses_and_a_warning():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("belt-1")
    b.box(root, size=(1, 1, 1))
    b.mono(root, "BeltDesc", speed=1)
    b.publish(root, "Entities/Prefabs/belt-1")
    report = Report()
    raw = read_building(env, {"PrefabPath": "Entities/Prefabs/belt-1"}, ITEM, report)
    assert raw.slot_poses is None and raw.port_poses is None
    assert raw.colliders is not None  # the other parts survive
    assert raw.descs == {"BeltDesc": {"speed": 1}}
    assert any("SlotConfig" in w for w in report.warnings)
    assert report.sections["per_building_geometry"]["2303"]["status"] == "partial"


def test_null_slot_reference_drops_only_that_list():
    env, b, root = build_assembler()
    cfg = next(o for o in env.objects.values() if o.script == "SlotConfig")
    cfg.tree["insertPoses"] = [cfg.tree["insertPoses"][0], NULL]
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.slot_poses is None
    assert len(raw.port_poses) == 3
    assert raw.descs["SlotConfig"]["insertPoses"] == [None, None]  # count kept for the normalizer
    assert any("insertPoses" in w and "null" in w for w in report.warnings)


def test_slot_config_pose_field_that_is_not_a_list_is_reported_not_raised():
    env, b, root = build_assembler()
    cfg = next(o for o in env.objects.values() if o.script == "SlotConfig")
    cfg.tree["slotPoses"] = 7
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.port_poses is None and raw.slot_poses is not None
    assert raw.descs["SlotConfig"]["slotPoses"] == []
    assert any("slotPoses" in w and "not a list" in w for w in report.warnings)


def test_slot_reference_to_a_non_transform_is_reported():
    env, b, root = build_assembler()
    cfg = next(o for o in env.objects.values() if o.script == "SlotConfig")
    box_ptr = next(ptr(o.path_id) for o in env.objects.values() if o.kind == "BoxCollider")
    cfg.tree["slotPoses"][1] = box_ptr
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.port_poses is None and raw.slot_poses is not None
    assert any("slotPoses" in w and "BoxCollider" in w for w in report.warnings)


def test_slot_config_without_the_pose_fields_is_reported():
    env, b, root = build_assembler()
    cfg = next(o for o in env.objects.values() if o.script == "SlotConfig")
    del cfg.tree["insertPoses"]
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.slot_poses is None and raw.port_poses is not None
    assert any("insertPoses" in w for w in report.warnings)


def test_unresolvable_prefab_returns_empty_building_and_an_error():
    env = FakeEnv()
    env.container_map["entities/prefabs/assembler-mk-2"] = ptr(1)
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.descs == {} and raw.colliders is None and raw.slot_poses is None and raw.port_poses is None
    assert report.has_errors
    assert "Assembler-MK-1" in report.errors[0]
    assert "assembler-mk-2" not in report.errors[0]  # unrelated key is not suggested
    assert report.sections["per_building_geometry"]["2303"]["status"] == "failed"


def test_missing_prefab_error_suggests_keys_with_the_same_name():
    env = FakeEnv()
    env.container_map["other/dir/assembler-mk-1"] = ptr(1)
    env.container_map["entities/prefabs/inserter-1"] = ptr(2)
    report = Report()
    read_building(env, MODEL, ITEM, report)
    assert "other/dir/assembler-mk-1" in report.errors[0]


def test_unique_suffix_match_resolves_a_prefixed_container_key():
    env, b, root = build_assembler()
    env.container_map = {"assets/resources/entities/prefabs/assembler-mk-1": root.go}
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders is not None and not report.errors


def test_failing_descriptor_read_is_an_error_but_other_parts_survive():
    env, b, root = build_assembler()
    assembler = next(o for o in env.objects.values() if o.script == "AssemblerDesc")
    env.tree_errors[assembler.path_id] = AssertionError("failed to dump nodes raw")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert "AssemblerDesc" not in raw.descs  # the other instance is not silently used either
    assert raw.colliders is not None and raw.port_poses is not None
    assert any("AssemblerDesc" in e and "failed to dump nodes raw" in e for e in report.errors)


def test_failing_non_core_descriptor_is_only_a_warning():
    env, b, root = build_assembler()
    b.mono(root, "OddballConfig", x=1)
    oddball = next(o for o in env.objects.values() if o.script == "OddballConfig")
    env.tree_errors[oddball.path_id] = AssertionError("failed to dump nodes raw")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert "OddballConfig" not in raw.descs and "AssemblerDesc" in raw.descs
    assert not report.errors and any("OddballConfig" in w for w in report.warnings)


def test_unresolvable_script_is_a_single_warning():
    env, b, root = build_assembler()
    for o in list(env.objects.values()):
        if o.kind == "MonoBehaviour":
            env.script_errors.add(o.path_id)
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.descs == {}
    assert len([w for w in report.warnings if "script" in w]) == 1


def test_collider_missing_a_field_gives_none_colliders_and_a_warning():
    env, b, root = build_assembler()
    box = next(o for o in env.objects.values() if o.kind == "BoxCollider")
    del box.tree["m_Size"]
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders is None and raw.port_poses is not None and raw.slot_poses is not None
    assert any("m_Size" in w for w in report.warnings)


def test_no_colliders_gives_none_with_a_warning():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("thing")
    b.mono(root, "SlotConfig", slotPoses=[], insertPoses=[])
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders is None
    assert raw.port_poses == [] and raw.slot_poses == []
    assert any("no Box/Sphere/Capsule" in w for w in report.warnings)


def test_mesh_colliders_are_ignored_and_counted():
    env, b, root = build_assembler()
    b.component(root, "MeshCollider", {"m_IsTrigger": False})
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert len(raw.colliders) == 1
    assert report.sections["per_building_geometry"]["2303"]["colliders"]["ignored_types"] == {"MeshCollider": 1}


def test_deref_failure_anywhere_never_raises():
    env, b, root = build_assembler()
    del env.objects[next(o.path_id for o in env.objects.values() if o.kind == "Transform" and o.tree["m_Children"] == [])]
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)  # a dangling reference somewhere in the tree
    assert raw.item_id == 2303
    assert report.has_errors or report.warnings


def test_child_cycle_is_cut_off_with_an_error():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("loop")
    env.objects[root.transform["m_PathID"]].tree["m_Children"].append(root.transform)
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.descs == {} and report.has_errors
    assert "deeper" in report.errors[0]


# ---- collider usage ---------------------------------------------------------------------------


def test_default_classifier_rules():
    assert classify_collider("body", 0, False) == "build"  # non-trigger box
    assert classify_collider("body", 0, True) == "other"  # trigger box
    assert classify_collider("body", 5, True, layer_name="BuildCollider") == "build"  # layer name hint
    assert classify_collider("build-area", 0, True) == "build"  # GameObject name hint
    assert classify_collider("body", 0, False, shape="sphere") == "physics"
    assert classify_collider("body", 0, True, shape="capsule") == "other"
    assert classify_collider("body", 0, False, shape="sphere", layer_name="Build") == "physics"  # boxes only


def test_build_layer_numbers_are_pluggable(monkeypatch):
    monkeypatch.setattr(prefab, "BUILD_LAYER_NUMBERS", frozenset({22}))
    assert classify_collider("x", 22, True) == "build"
    assert classify_collider("x", 21, True) == "other"


def test_custom_classifier_decides_usage_and_receives_layer_info():
    env, b, root = build_assembler()
    b.box(root, trigger=True)  # the default rule calls a trigger box "other"
    env.layers = {0: "Default"}
    calls = []

    def classify(go_name, layer, is_trigger, shape, layer_name):
        calls.append((go_name, layer, is_trigger, shape, layer_name))
        return "build"

    raw = read_building(env, MODEL, ITEM, Report(), classify=classify)
    assert calls == [
        ("assembler-mk-1", 0, True, "box", "Default"),
        ("body", 0, False, "box", "Default"),
    ]
    assert [c["usage"] for c in raw.colliders] == ["build", "build"]


def test_zero_build_colliders_falls_back_to_none_with_a_warning():
    env, b, root = build_assembler()
    report = Report()
    raw = read_building(env, MODEL, ITEM, report, classify=lambda *a, **k: "physics")
    assert raw.colliders is None
    assert any("build collider" in w for w in report.warnings)
    # the colliders that were seen are still recorded for the person tuning the rule
    assert report.sections["collider_layers_seen"][0]["usage"] == "physics"


def test_every_distinct_layer_trigger_name_is_recorded_with_the_decision():
    env = FakeEnv()
    env.layers = {13: "Trigger"}
    b = PrefabBuilder(env)
    root = b.game_object("assembler-mk-1")
    body = b.game_object("body", root, layer=0)
    zone = b.game_object("zone", root, layer=13)
    b.box(body)
    b.box(zone, trigger=True)
    b.sphere(zone, trigger=True)
    b.box(body)  # same key as the first box: counted, not duplicated
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    report = Report()
    read_building(env, MODEL, ITEM, report)
    rows = {(r["layer"], r["is_trigger"], r["name"], r["shape"]): r for r in report.sections["collider_layers_seen"]}
    assert set(rows) == {(0, False, "body", "box"), (13, True, "zone", "box"), (13, True, "zone", "sphere")}
    assert rows[(0, False, "body", "box")]["count"] == 2 and rows[(0, False, "body", "box")]["usage"] == "build"
    assert rows[(13, True, "zone", "box")]["usage"] == "other"
    assert rows[(13, True, "zone", "box")]["layer_name"] == "Trigger"
    assert rows[(13, True, "zone", "sphere")]["example_items"] == [2303]


def test_sphere_and_capsule_extents():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("thing", scale=(2, 1, 1))
    b.sphere(root, center=(1, 0, 0), radius=0.5)  # radius scales by the largest axis scale (2)
    b.capsule(root, radius=0.5, height=3.0, direction=1)  # y-axis capsule: cross axes (x=2, z=1)
    b.box(root, size=(1, 1, 1))
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    raw = read_building(env, MODEL, ITEM, Report())
    sphere, capsule, _ = raw.colliders
    assert sphere["halfExtents"] == approx([1, 1, 1]) and sphere["center"] == approx([2, 0, 0])
    assert sphere["usage"] == "physics" and sphere["shape"] == "sphere"
    assert capsule["halfExtents"] == approx([1, 1.5, 1])  # r = 0.5 * 2 = 1; height 3 * 1 / 2


# ---- separate collider prefab -----------------------------------------------------------------


def test_find_collider_prefab_matches_sibling_collider_prefabs_only_when_unambiguous():
    key = "entities/prefabs/assembler-mk-1"
    assert find_collider_prefab({key: 1, "entities/colliders/assembler-mk-1": 2}, key) == "entities/colliders/assembler-mk-1"
    assert find_collider_prefab({key: 1, "entities/prefabs/assembler-mk-1-collider": 2}, key) == (
        "entities/prefabs/assembler-mk-1-collider"
    )
    assert find_collider_prefab({key: 1, "entities/colliders/assembler-mk-2": 2}, key) is None
    assert find_collider_prefab({key: 1, "entities/prefabs/assembler-mk-1-collider": 2, "x/colliders/assembler-mk-1": 3}, key) is None
    assert find_collider_prefab({key: 1}, key) is None


def test_separate_collider_prefab_supplies_the_colliders():
    env, b, root = build_assembler()
    col_root = b.game_object("assembler-mk-1-collider")
    b.box(col_root, center=(0, 1, 0), size=(2, 2, 2))
    b.publish(col_root, "Entities/Colliders/assembler-mk-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert len(raw.colliders) == 1 and raw.colliders[0]["halfExtents"] == approx([1, 1, 1])
    assert report.sections["per_building_geometry"]["2303"]["collider_source"] == "entities/colliders/assembler-mk-1"
    assert raw.port_poses is not None  # descriptors and poses still come from the main prefab


# ---- walking and describing -------------------------------------------------------------------


def test_walk_order_is_preorder_with_components_in_m_component_order():
    env, b, root = build_assembler()
    nodes = walk_hierarchy(env, env.object(root.go))
    assert [n.path for n in nodes] == [
        "assembler-mk-1",
        "assembler-mk-1/slots",
        "assembler-mk-1/slots/c0",
        "assembler-mk-1/slots/c1",
        "assembler-mk-1/slots/c2",
        "assembler-mk-1/body",
        "assembler-mk-1/extra",
    ]
    assert [t for t, _ in nodes[0].components][:3] == ["Transform", "MonoBehaviour", "MonoBehaviour"]
    assert nodes[1].world.position == approx((1, 0, 0))


def test_world_pose_climbs_to_the_root_including_the_root_transform():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root", pos=(5, 0, 0), rot=YAW_90)
    child = b.game_object("child", root, pos=(0, 0, 1))
    pose = world_pose(env, env.object(child.transform))
    assert pose.position == approx((6, 0, 0))
    assert pose.rotation == approx(YAW_90)


def test_world_pose_rejects_a_parent_cycle():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root")
    env.objects[root.transform["m_PathID"]].tree["m_Father"] = root.transform
    with pytest.raises(PrefabError, match="cycle"):
        world_pose(env, env.object(root.transform))


def test_describe_prefab_lists_game_objects_and_script_classes():
    env, b, root = build_assembler()
    info = describe_prefab(env, "Entities/Prefabs/assembler-mk-1")
    assert info["container_key"] == "entities/prefabs/assembler-mk-1"
    first = info["game_objects"][0]
    assert first["path"] == "assembler-mk-1"
    assert "MonoBehaviour:SlotConfig" in first["components"]
    assert info["game_objects"][1]["world_position"] == approx([1, 0, 0])
    with pytest.raises(PrefabError, match="not in the ResourceManager container"):
        describe_prefab(env, "nope")


def test_rounding_hides_float_noise_and_negative_zero():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root", rot=YAW_90)
    child = b.game_object("child", root, pos=(1, 0, 0))
    b.mono(root, "SlotConfig", slotPoses=[child.transform], insertPoses=[])
    b.box(root)
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    raw = read_building(env, MODEL, ITEM, Report())
    assert raw.port_poses[0]["position"] == [0.0, 0.0, -1.0]
    assert math.copysign(1, raw.port_poses[0]["position"][0]) == 1  # no -0.0


def test_ambiguous_suffix_match_is_not_guessed():
    env, b, root = build_assembler()
    env.container_map = {"a/entities/prefabs/assembler-mk-1": root.go, "b/entities/prefabs/assembler-mk-1": root.go}
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.descs == {} and "2 suffix matches" in report.errors[0]


# ---- Task 5 follow-ups ------------------------------------------------------------------------

ROLL_90 = (0.0, 0.0, H, H)  # +90 degrees about +z: x -> y, y -> -x
ROLL_45 = (0.0, 0.0, math.sin(math.radians(22.5)), math.cos(math.radians(22.5)))


def test_compose_derives_lossy_scale_from_the_full_matrix_for_a_non_uniform_ancestor():
    # world matrix = diag(1, 2, 1) * Rz90, whose columns have lengths (2, 1, 1): the child's x axis is stretched
    parent = Pose(scale=(1, 2, 1))
    child = compose(parent, Pose(rotation=ROLL_90))
    assert child.scale == approx((2, 1, 1))
    assert child.rotation == approx(ROLL_90)
    assert not child.sheared
    # a grandchild one unit along the child's x axis sits two units up in the world
    grandchild = compose(child, Pose(position=(1, 0, 0)))
    assert grandchild.position == approx((0, 2, 0))


def test_compose_flags_a_sheared_transform():
    # a 45 degree child under a (1, 2, 1) ancestor is sheared: no rotation and scale reproduce its matrix
    child = compose(Pose(scale=(1, 2, 1)), Pose(rotation=ROLL_45))
    assert child.sheared
    assert not compose(Pose(scale=(2, 2, 2)), Pose(rotation=ROLL_45)).sheared  # uniform parent: still a similarity
    assert not compose(Pose(scale=(1, 2, 1)), Pose(rotation=YAW_90)).sheared  # axis-aligned turn about the stretched axis


def test_collider_extents_use_the_lossy_scale_of_a_rotated_child_under_a_non_uniform_ancestor():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root", scale=(1, 2, 1))
    child = b.game_object("body", root, rot=ROLL_90, pos=(0, 0, 0))
    b.box(child, size=(1, 1, 1))
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    box = raw.colliders[0]
    assert box["halfExtents"] == approx([1, 0.5, 0.5])  # local x is the stretched axis
    assert box["rotation"] == approx(ROLL_90)
    assert not any("shear" in w for w in report.warnings)


def test_slot_pose_position_under_a_non_uniform_rotated_ancestor_uses_the_full_matrix():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root", scale=(1, 2, 1))
    mid = b.game_object("mid", root, rot=ROLL_90)
    slot = b.game_object("slot", mid, pos=(1, 0, 0))
    b.box(mid, size=(1, 1, 1))
    b.mono(root, "SlotConfig", slotPoses=[slot.transform], insertPoses=[])
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    raw = read_building(env, MODEL, ITEM, Report())
    assert raw.port_poses[0]["position"] == approx([0, 2, 0])


def test_a_collider_under_a_sheared_transform_is_extracted_with_a_warning():
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("root", scale=(1, 2, 1))
    child = b.game_object("body", root, rot=ROLL_45)
    b.box(child, size=(1, 1, 1))
    b.publish(root, "Entities/Prefabs/Assembler-MK-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders is not None and len(raw.colliders) == 1
    (warning,) = [w for w in report.warnings if "shear" in w]
    assert "root/body" in warning
    assert report.sections["per_building_geometry"]["2303"]["sheared_colliders"] == ["root/body"]


def test_collider_details_carry_center_and_half_extents():
    env, _, _ = build_assembler()
    report = Report()
    read_building(env, MODEL, ITEM, report)
    (detail,) = report.sections["per_building_geometry"]["2303"]["collider_details"]
    assert detail["center"] == approx([0, 2, 0])
    assert detail["halfExtents"] == approx([1, 2, 3])
    assert detail["path"] == "assembler-mk-1/body" and detail["shape"] == "box"


# ---- the guessed separate collider prefab can be wrong ----------------------------------------


def _with_guessed_collider_prefab(entry):
    """The assembler plus a container key `find_collider_prefab` will guess; `entry(env)` makes its container value."""
    env, b, root = build_assembler()
    env.container_map["entities/colliders/assembler-mk-1"] = entry(env)
    return env


@pytest.mark.parametrize(
    "entry, reason",
    [
        (lambda env: NULL, "null reference"),
        (lambda env: env.add("Transform", {"m_Children": []}), "expected a GameObject"),
        (lambda env: env.add("GameObject", {"m_Name": "broken", "m_Layer": 0, "m_IsActive": True, "m_Component": []}), "no Transform"),
    ],
    ids=["null", "not-a-gameobject", "unwalkable"],
)
def test_unusable_guessed_collider_prefab_falls_back_to_the_main_prefab(entry, reason):
    env = _with_guessed_collider_prefab(entry)
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders is not None and len(raw.colliders) == 1
    assert raw.colliders[0]["halfExtents"] == approx([1, 2, 3])  # the main prefab's body collider
    record = report.sections["per_building_geometry"]["2303"]
    assert record["collider_source"] == "prefab"
    assert record["status"] == "extracted"
    (warning,) = [w for w in report.warnings if "entities/colliders/assembler-mk-1" in w]
    assert reason in warning and "main prefab" in warning
    assert not report.errors


def test_a_usable_guessed_collider_prefab_is_still_preferred():
    env, b, root = build_assembler()
    col_root = b.game_object("assembler-mk-1-collider")
    b.box(col_root, size=(2, 2, 2))
    b.publish(col_root, "Entities/Colliders/assembler-mk-1")
    report = Report()
    raw = read_building(env, MODEL, ITEM, report)
    assert raw.colliders[0]["halfExtents"] == approx([1, 1, 1])
    assert report.sections["per_building_geometry"]["2303"]["collider_source"] == "entities/colliders/assembler-mk-1"
    assert report.warnings == []


# ---- container misses -------------------------------------------------------------------------


def test_a_container_miss_without_similar_keys_puts_a_key_sample_in_the_report():
    env = FakeEnv()
    for i in range(100):
        env.container_map[f"misc/folder/thing-{i:03d}"] = ptr(1)
    report = Report()
    read_building(env, MODEL, ITEM, report)
    sample = report.sections["container_sample"]
    assert 15 <= len(sample) <= 20 and len(set(sample)) == len(sample)
    assert set(sample) <= set(env.container_map)
    assert "container_sample" in report.errors[0]


def test_a_container_miss_with_similar_keys_names_them_and_adds_no_sample():
    env = FakeEnv()
    env.container_map["other/dir/assembler-mk-1"] = ptr(1)
    report = Report()
    read_building(env, MODEL, ITEM, report)
    assert "other/dir/assembler-mk-1" in report.errors[0]
    assert "container_sample" not in report.sections


def test_the_container_sample_is_kept_from_the_first_miss_only():
    env = FakeEnv()
    env.container_map["a/b/c"] = ptr(1)
    report = Report()
    read_building(env, MODEL, ITEM, report)
    first = list(report.sections["container_sample"])
    env.container_map["z/y/x"] = ptr(2)
    read_building(env, MODEL, {**ITEM, "ID": 2304}, report)
    assert report.sections["container_sample"] == first


# ---- which buildings count as unreadable (the partial-data guard reads this) --------------------


def test_an_unreadable_prefab_is_flagged_unreadable():
    report = Report()
    read_building(FakeEnv(), MODEL, ITEM, report)
    record = report.sections["per_building_geometry"]["2303"]
    assert record["status"] == "failed" and record["unreadable"] is True


def test_a_building_that_lost_a_core_descriptor_is_flagged_unreadable():
    env, b, root = build_assembler()
    assembler = next(o for o in env.objects.values() if o.script == "AssemblerDesc")
    env.tree_errors[assembler.path_id] = AssertionError("failed to dump nodes raw")
    report = Report()
    read_building(env, MODEL, ITEM, report)
    record = report.sections["per_building_geometry"]["2303"]
    assert record["unreadable"] is True
    assert record["status"] == "extracted"  # the geometry itself was fine


def test_warnings_only_never_flag_a_building_unreadable():
    env, b, root = build_assembler()
    cfg = next(o for o in env.objects.values() if o.script == "SlotConfig")
    del cfg.tree["insertPoses"]  # warning: slots not extracted
    b.mono(root, "SomeDesc", x=1)
    env.tree_errors[max(env.objects)] = AssertionError("non-core descriptor cannot be built")  # warning only
    report = Report()
    read_building(env, MODEL, ITEM, report)
    assert report.warnings
    assert "unreadable" not in report.sections["per_building_geometry"]["2303"]

    env2 = FakeEnv()
    b2 = PrefabBuilder(env2)
    root2 = b2.game_object("thing")
    b2.mono(root2, "SlotConfig", slotPoses=[], insertPoses=[])
    b2.publish(root2, "Entities/Prefabs/Assembler-MK-1")  # no colliders: approximate geometry, not unreadable
    report2 = Report()
    read_building(env2, MODEL, ITEM, report2)
    assert "unreadable" not in report2.sections["per_building_geometry"]["2303"]
