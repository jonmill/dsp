"""The reader against UnityPy's real parser, over a small synthetic game (tests/unity_synth.py).

Skipped unless UnityPy is installed (`pip install -e 'tools/extract[game]'`). The type tree generator
is replaced by `SynthGenerator` (the real one needs the game's DLLs); everything else, including
file parsing, cross-file PPtr resolution, the ResourceManager container and MonoBehaviour head
parsing, is UnityPy itself.
"""

import pytest

pytest.importorskip("UnityPy")

import unity_synth
from fake_unity import approx_list

from dsp_extract.normalize import normalize
from dsp_extract.report import Report
from dsp_extract.steam import GameInstall
from dsp_extract.unity_reader import UnityEnvAdapter, read_bundle


@pytest.fixture
def install(tmp_path, monkeypatch):
    import UnityPy.helpers.TypeTreeGenerator as generator_module

    monkeypatch.setattr(generator_module, "TypeTreeGenerator", unity_synth.SynthGenerator)
    root = tmp_path / "Dyson Sphere Program"
    data = root / "DSPGAME_Data"
    (data / "Managed").mkdir(parents=True)
    (data / "Managed" / "Assembly-CSharp.dll").write_bytes(b"")
    unity_synth.write_game(data)
    page = root / "Locale" / "1033" / "Item.txt"
    page.parent.mkdir(parents=True)
    page.write_bytes(b"\xff\xfe" + "组装机\t0\t0\tAssembler\r\n铁块\t0\t0\tIron Ingot\r\n".encode("utf-16-le"))
    return GameInstall(root=root, data_dir=data, managed_dir=data / "Managed", build_id="20345678", library=None)


def test_open_loads_the_files_and_the_generator(install):
    report = Report()
    adapter = UnityEnvAdapter.open(install, report)
    assert adapter.unity_version == "2022.3.62f3c1"
    assert report.sections["unity_version"] == "2022.3.62f3c1"
    loaded = {f["name"]: f["objects"] for f in report.sections["files_loaded"]}
    assert set(loaded) == {"globalgamemanagers", "globalgamemanagers.assets", "resources.assets"}
    assert loaded["globalgamemanagers"] == 2
    assert report.sections["typetree_generator"]["loaded_dlls"] == ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"]
    assert not report.warnings


def test_adapter_against_real_unitypy_objects(install):
    adapter = UnityEnvAdapter.open(install, Report())
    behaviours = list(adapter.objects_of_type("MonoBehaviour"))
    classes = sorted(adapter.script_class(o) for o in behaviours)
    assert classes == sorted(
        ["ItemProtoSet", "RecipeProtoSet", "TechProtoSet", "ModelProtoSet", "AssemblerDesc", "PowerDesc",
         "BuildConditionConfig", "SlotConfig", "BrokenDesc"]
    )
    container = adapter.container()
    assert list(container) == ["entities/prefabs/assembler-mk-1"]
    root = adapter.deref(container["entities/prefabs/assembler-mk-1"])  # globalgamemanagers -> resources.assets
    assert adapter.type_name(root) == "GameObject"
    tree = adapter.read_typetree(root)
    assert tree["m_Name"] == "assembler-mk-1"
    assert adapter.layer_names() == {0: "Default", 1: "TransparentFX", unity_synth.BUILD_LAYER: "Build"}
    slot_config = next(o for o in behaviours if adapter.script_class(o) == "SlotConfig")
    ports = adapter.read_typetree(slot_config)["slotPoses"]
    assert adapter.type_name(adapter.deref(ports[0])) == "Transform"
    assert adapter.deref({"m_FileID": 0, "m_PathID": 0}) is None


def test_read_bundle_end_to_end_over_real_unitypy(install):
    report = Report()
    bundle = read_bundle(install, report)

    assert bundle.items == unity_synth.ITEMS
    assert bundle.recipes[0]["Results"] == [1101] and bundle.recipes[0]["Type"] == 1
    assert bundle.techs[0]["Position"] == {"x": 1.0, "y": 2.0}
    assert bundle.locale["组装机"] == "Assembler"
    assert bundle.proto_signatures == {
        "ItemProtoSet": unity_synth.SIGNATURES["Item"],
        "RecipeProtoSet": unity_synth.SIGNATURES["Recipe"],
        "TechProtoSet": unity_synth.SIGNATURES["Tech"],
        "ModelProtoSet": unity_synth.SIGNATURES["Model"],
    }
    found = report.sections["protosets_found"]
    assert found["ItemProtoSet"]["signature"] == unity_synth.SIGNATURES["Item"]
    assert found["ItemProtoSet"]["entries"] == 2

    (building,) = bundle.buildings
    assert building.item_id == 2303 and building.model_index == 65
    assert set(building.descs) == {"AssemblerDesc", "PowerDesc", "BuildConditionConfig", "SlotConfig"}
    assert building.descs["AssemblerDesc"] == {"recipeType": 4, "speedf": 0.75}
    assert building.descs["PowerDesc"] == {"consumer": True, "workEnergyPerTick": 1000, "idleEnergyPerTick": 100}

    # Root is yawed +90 degrees: local (x, y, z) -> world (z, y, -x).
    assert [p["position"] for p in building.port_poses] == approx_list([[1, 0, 0], [1, 0, -1]])
    assert [p["position"] for p in building.slot_poses] == approx_list([[2, 0, 0]])  # insertPoses -> slots
    assert building.port_poses[0]["rotation"] == approx_list([0, 0.70710678, 0, 0.70710678], tol=1e-5)
    (collider,) = building.colliders
    assert collider["center"] == approx_list([0, 1, 0]) and collider["halfExtents"] == approx_list([1.5, 1, 1.5])
    assert collider["usage"] == "build" and collider["shape"] == "box"

    # A (non-core) descriptor the generator cannot build costs exactly one warning and nothing else.
    assert not report.errors
    building_warnings = [w for w in report.warnings if w.startswith("building ")]
    assert len(building_warnings) == 1 and "BrokenDesc" in building_warnings[0]
    record = report.sections["per_building_geometry"]["2303"]
    assert record["status"] == "extracted" and record["collider_source"] == "prefab"
    layer = report.sections["collider_layers_seen"][0]
    assert (layer["layer"], layer["layer_name"], layer["name"], layer["usage"]) == (12, "Build", "body", "build")
    assert report.sections["container"]["duplicate_keys"] == 1


def test_real_bundle_normalizes_with_extracted_geometry(install):
    bundle = read_bundle(install, Report())
    data = normalize(bundle, "0.1.0", "2026-10-10T00:00:00Z")
    (assembler,) = [b for b in data["buildings"] if b["itemId"] == 2303]
    assert assembler["name"] == "Assembler"
    assert assembler["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}
    assert assembler["geometry"]["source"] == "extracted"
    assert assembler["geometry"]["blueprintBoxSize"] == [3.0, 3.0]
    assert data["meta"]["protoSignatures"]["ModelProtoSet"] == unity_synth.SIGNATURES["Model"]
