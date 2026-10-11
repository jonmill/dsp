import copy
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest
from fake_unity import YAW_90, FakeEnv, PrefabBuilder, v3

from dsp_extract.errors import ExtractError
from dsp_extract.normalize import normalize
from dsp_extract.raw import RawBundle
from dsp_extract.report import Report
from dsp_extract.steam import GameInstall
from dsp_extract.unity_reader import UnityEnvAdapter, read_bundle, read_game_version

BUILD_ID = "20345678"

GAME_CONFIG = """\
public static class GameConfig
{
    public static readonly Version minimumVersion = new Version(0, 1, 0, 0);

    public static readonly Version gameVersion = new Version(0, 10, 35, 29104);

    public const int kMaxPlayers = 8;
}
"""


def make_install(tmp_path: Path, build_id: str | None = BUILD_ID, locale: bool = True) -> GameInstall:
    root = tmp_path / "Dyson Sphere Program"
    data = root / "DSPGAME_Data"
    (data / "Managed").mkdir(parents=True)
    if locale:
        page = root / "Locale" / "1033" / "Item.txt"
        page.parent.mkdir(parents=True)
        text = "组装机\t0\t0\tAssembler\r\n铁块\t0\t0\tIron Ingot\r\nT电磁学\t0\t0\tElectromagnetism\r\n"
        page.write_bytes(b"\xff\xfe" + text.encode("utf-16-le"))
    return GameInstall(root=root, data_dir=data, managed_dir=data / "Managed", build_id=build_id, library=None)


# ---- read_game_version ------------------------------------------------------------------------


def test_game_version_from_decompiled_game_config(tmp_path):
    install = make_install(tmp_path)
    assert read_game_version(install, {"GameConfig": GAME_CONFIG}) == "0.10.35.29104"


def test_game_version_accepts_property_and_string_forms(tmp_path):
    install = make_install(tmp_path)
    prop = "public static Version gameVersion { get { return new Version(0, 10, 28, 20594); } }"
    assert read_game_version(install, {"GameConfig": prop}) == "0.10.28.20594"
    text = 'public static readonly Version gameVersion = new Version("0.10.31.23287");'
    assert read_game_version(install, {"GameConfig": text}) == "0.10.31.23287"
    spaced = "public static Version gameVersion =\n    new System.Version( 0 , 10 , 33 , 1 );"
    assert read_game_version(install, {"GameConfig": spaced}) == "0.10.33.1"


def test_game_version_searches_other_decompiled_types(tmp_path):
    install = make_install(tmp_path)
    assert read_game_version(install, {"Other": "class X {}", "Misc": GAME_CONFIG}) == "0.10.35.29104"


def test_game_version_falls_back_to_the_steam_build_id(tmp_path):
    install = make_install(tmp_path)
    assert read_game_version(install, None) == f"0.0.0+build{BUILD_ID}"
    assert read_game_version(install, {}) == f"0.0.0+build{BUILD_ID}"
    # a GameConfig whose version cannot be parsed also falls back
    assert read_game_version(install, {"GameConfig": "class GameConfig { }"}) == f"0.0.0+build{BUILD_ID}"


def test_game_version_unknown_raises(tmp_path):
    install = make_install(tmp_path, build_id=None)
    with pytest.raises(ExtractError, match="cannot determine game version"):
        read_game_version(install, None)
    with pytest.raises(ExtractError, match="cannot determine game version"):
        read_game_version(install, {"GameConfig": "class GameConfig { }"})
    assert read_game_version(install, {"GameConfig": GAME_CONFIG}) == "0.10.35.29104"


# ---- read_bundle over a fake adapter ----------------------------------------------------------

ITEMS = [
    {"ID": 1101, "Name": "铁块", "Type": 2, "StackSize": 100, "GridIndex": 1101, "CanBuild": False, "ModelIndex": 0},
    {"ID": 2303, "Name": "组装机", "Type": 6, "StackSize": 50, "GridIndex": 2203, "CanBuild": True, "ModelIndex": 65},
]
RECIPES = [
    {
        "ID": 1,
        "Name": "铁块",
        "Type": 1,
        "TimeSpend": 60,
        "Items": [1001],
        "ItemCounts": [1],
        "Results": [1101],
        "ResultCounts": [1],
    }
]
TECHS = [{"ID": 1, "Name": "T电磁学"}]
MODELS = [{"ID": 65, "Name": "组装机", "PrefabPath": "Entities/Prefabs/assembler-mk-1"}]


def add_protoset(env: FakeEnv, class_name: str, entries, signature: str | None = "auto", **extra) -> None:
    table = class_name.removesuffix("ProtoSet")
    tree = {"m_Name": class_name, "TableName": table, "Signature": f"{table} ABC123", **extra}
    if signature != "auto":
        tree.pop("Signature")
    if entries is not None:
        tree["dataArray"] = copy.deepcopy(entries)
    env.add("MonoBehaviour", tree, script=class_name)


def build_game_env() -> FakeEnv:
    env = FakeEnv()
    b = PrefabBuilder(env)
    root = b.game_object("assembler-mk-1", rot=YAW_90)
    ports = [b.game_object(f"port{i}", root, pos=(i, 0, 1)) for i in range(3)]
    slots = [b.game_object(f"slot{i}", root, pos=(0, i, 2)) for i in range(2)]
    b.box(b.game_object("body", root), center=(0, 1, 0), size=(3, 2, 3))
    b.mono(root, "AssemblerDesc", recipeType=4, speedf=0.75)
    b.mono(root, "PowerDesc", consumer=True, workEnergyPerTick=1000, idleEnergyPerTick=100)
    b.mono(root, "BuildConditionConfig", landPoints=[v3(-1.5, 0, -1.5), v3(1.5, 0, 1.5)])
    b.mono(
        root,
        "SlotConfig",
        slotPoses=[p.transform for p in ports],
        insertPoses=[s.transform for s in slots],
        selectCenter=v3(0, 1, 0),
        selectSize=v3(3, 2, 3),
    )
    b.publish(root, "Entities/Prefabs/assembler-mk-1")
    add_protoset(env, "ItemProtoSet", ITEMS)
    add_protoset(env, "RecipeProtoSet", RECIPES)
    add_protoset(env, "TechProtoSet", TECHS)
    add_protoset(env, "ModelProtoSet", MODELS)
    add_protoset(env, "SignalProtoSet", [{"ID": 1, "Name": "x"}])  # found and counted, never read
    env.add("MonoBehaviour", {"m_Name": "decoy"}, script=None)
    env.add("MonoBehaviour", {"m_Name": "decoy"}, script="SomeOtherBehaviour")
    return env


def test_read_bundle_collects_protos_locale_signatures_and_buildings(tmp_path):
    install = make_install(tmp_path)
    report = Report()
    bundle = read_bundle(install, report, adapter=build_game_env())

    assert isinstance(bundle, RawBundle)
    assert bundle.source == "game"
    assert bundle.steam_build_id == BUILD_ID
    assert bundle.game_version == f"0.0.0+build{BUILD_ID}"
    assert bundle.items == ITEMS and bundle.recipes == RECIPES and bundle.techs == TECHS
    assert bundle.locale["组装机"] == "Assembler"
    assert bundle.proto_signatures == {
        "ItemProtoSet": "Item ABC123",
        "RecipeProtoSet": "Recipe ABC123",
        "TechProtoSet": "Tech ABC123",
        "ModelProtoSet": "Model ABC123",
    }

    assert [b.item_id for b in bundle.buildings] == [2303]  # only CanBuild items with a ModelIndex
    building = bundle.buildings[0]
    assert building.model_index == 65
    assert set(building.descs) == {"AssemblerDesc", "PowerDesc", "BuildConditionConfig", "SlotConfig"}
    assert len(building.port_poses) == 3 and len(building.slot_poses) == 2
    assert building.colliders[0]["usage"] == "build"

    found = report.sections["protosets_found"]
    assert found["ItemProtoSet"] == {
        "count": 1,
        "table_name": "Item",
        "signature": "Item ABC123",
        "entries": 2,
        "read": True,
    }
    assert found["SignalProtoSet"]["read"] is False and found["SignalProtoSet"]["count"] == 1
    assert report.sections["per_building_geometry"]["2303"]["status"] == "extracted"
    assert not report.has_errors


def test_read_bundle_output_normalizes_with_extracted_geometry(tmp_path):
    bundle = read_bundle(make_install(tmp_path), Report(), adapter=build_game_env())
    data = normalize(bundle, "0.1.0", "2026-10-10T00:00:00Z")
    assert data["meta"]["gameVersion"] == f"0.0.0+build{BUILD_ID}"
    assert data["meta"]["source"] == "game"
    assert data["meta"]["protoSignatures"]["ItemProtoSet"] == "Item ABC123"
    assembler = next(b for b in data["buildings"] if b["itemId"] == 2303)
    assert assembler["name"] == "Assembler"
    assert assembler["kind"] == "production"
    assert assembler["production"] == {"recipeType": "ASSEMBLE", "speed": 7500}
    geometry = assembler["geometry"]
    assert geometry["source"] == "extracted"
    assert len(geometry["ports"]) == 3 and len(geometry["slots"]) == 2
    assert geometry["colliders"][0]["usage"] == "build"
    assert geometry["blueprintBoxSize"] == [3.0, 3.0]


def test_read_bundle_uses_decompiled_version_when_given(tmp_path):
    bundle = read_bundle(make_install(tmp_path), Report(), adapter=build_game_env(), decompiled={"GameConfig": GAME_CONFIG})
    assert bundle.game_version == "0.10.35.29104"


def test_read_bundle_without_any_version_source_raises(tmp_path):
    with pytest.raises(ExtractError, match="cannot determine game version"):
        read_bundle(make_install(tmp_path, build_id=None), Report(), adapter=build_game_env())


def test_protoset_missing_data_array_names_class_and_key(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "RecipeProtoSet":
            del obj.tree["dataArray"]
    with pytest.raises(ExtractError) as err:
        read_bundle(make_install(tmp_path), Report(), adapter=env)
    assert "RecipeProtoSet" in str(err.value) and "dataArray" in str(err.value)
    assert "type tree" in str(err.value)  # points at the usual cause


@pytest.mark.parametrize("missing", ["ID", "ModelIndex", "CanBuild"])
def test_item_proto_missing_key_names_class_and_key(tmp_path, missing):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ItemProtoSet":
            del obj.tree["dataArray"][1][missing]
    with pytest.raises(ExtractError) as err:
        read_bundle(make_install(tmp_path), Report(), adapter=env)
    assert "ItemProtoSet" in str(err.value) and f"'{missing}'" in str(err.value)


def test_model_proto_missing_prefab_path_is_a_structural_error(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ModelProtoSet":
            del obj.tree["dataArray"][0]["PrefabPath"]
    with pytest.raises(ExtractError, match="ModelProtoSet.*'PrefabPath'"):
        read_bundle(make_install(tmp_path), Report(), adapter=env)


def test_empty_data_array_is_an_error(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "TechProtoSet":
            obj.tree["dataArray"] = []
    with pytest.raises(ExtractError, match="TechProtoSet.*empty"):
        read_bundle(make_install(tmp_path), Report(), adapter=env)


def test_missing_protoset_class_lists_what_was_found(tmp_path):
    env = build_game_env()
    for pid, obj in list(env.objects.items()):
        if obj.script == "RecipeProtoSet":
            del env.objects[pid]
    with pytest.raises(ExtractError) as err:
        read_bundle(make_install(tmp_path), Report(), adapter=env)
    assert "RecipeProtoSet not found" in str(err.value) and "ItemProtoSet" in str(err.value)


def test_unreadable_protoset_raises_naming_the_class(tmp_path):
    env = build_game_env()
    victim = next(o for o in env.objects.values() if o.script == "ItemProtoSet")
    env.tree_errors[victim.path_id] = ValueError("Expected to read 100 bytes, but only read 40 bytes")
    with pytest.raises(ExtractError, match="ItemProtoSet.*only read 40 bytes"):
        read_bundle(make_install(tmp_path), Report(), adapter=env)


def test_scripts_that_fail_to_resolve_are_counted_not_fatal(tmp_path):
    env = build_game_env()
    for _ in range(3):
        pointer = env.add("MonoBehaviour", {"m_Name": "broken"}, script="X")
        env.script_errors.add(pointer["m_PathID"])
    report = Report()
    read_bundle(make_install(tmp_path), report, adapter=env)
    assert any("3 MonoBehaviour" in w and "script" in w for w in report.warnings)


def test_missing_signature_is_a_warning_not_an_error(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "TechProtoSet":
            del obj.tree["Signature"]
    report = Report()
    bundle = read_bundle(make_install(tmp_path), report, adapter=env)
    assert "TechProtoSet" not in bundle.proto_signatures
    assert any("TechProtoSet" in w and "Signature" in w for w in report.warnings)


def test_duplicate_protoset_objects_warn_and_keep_the_first(tmp_path):
    env = build_game_env()
    add_protoset(env, "TechProtoSet", [{"ID": 99, "Name": "T二"}])
    report = Report()
    bundle = read_bundle(make_install(tmp_path), report, adapter=env)
    assert bundle.techs == TECHS
    assert any("TechProtoSet" in w and "2 objects" in w for w in report.warnings)


def test_building_whose_model_proto_is_missing_is_still_produced_with_an_error(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ModelProtoSet":
            obj.tree["dataArray"][0]["ID"] = 66
    report = Report()
    bundle = read_bundle(make_install(tmp_path), report, adapter=env)
    assert [b.item_id for b in bundle.buildings] == [2303]
    assert bundle.buildings[0].descs == {} and bundle.buildings[0].colliders is None
    assert any("ModelIndex 65" in e for e in report.errors)
    assert report.sections["per_building_geometry"]["2303"]["status"] == "failed"


def test_one_bad_prefab_does_not_stop_the_other_buildings(tmp_path):
    env = build_game_env()
    for obj in env.objects.values():
        if obj.script == "ItemProtoSet":
            obj.tree["dataArray"].append(
                {"ID": 2011, "Name": "分拣器", "Type": 5, "StackSize": 50, "GridIndex": 1, "CanBuild": True, "ModelIndex": 41}
            )
        if obj.script == "ModelProtoSet":
            obj.tree["dataArray"].append({"ID": 41, "Name": "分拣器", "PrefabPath": "Entities/Prefabs/missing"})
    report = Report()
    bundle = read_bundle(make_install(tmp_path), report, adapter=env)
    by_id = {b.item_id: b for b in bundle.buildings}
    assert set(by_id) == {2011, 2303}
    assert by_id[2303].colliders is not None
    assert by_id[2011].descs == {}
    assert report.has_errors


def test_read_bundle_passes_the_collider_classifier_through(tmp_path):
    seen = []

    def classify(go_name, layer, is_trigger, shape, layer_name):
        seen.append(go_name)
        return "build"

    read_bundle(make_install(tmp_path), Report(), adapter=build_game_env(), classify=classify)
    assert seen == ["body"]


def test_read_bundle_requires_the_locale_folder(tmp_path):
    with pytest.raises(ExtractError, match="Locale"):
        read_bundle(make_install(tmp_path, locale=False), Report(), adapter=build_game_env())


# ---- lazy UnityPy import ----------------------------------------------------------------------


def test_module_imports_without_unitypy():
    code = (
        "import sys; sys.modules['UnityPy'] = None\n"
        "import dsp_extract.unity_reader, dsp_extract.prefab, dsp_extract.locale_files, dsp_extract.report\n"
        "print('ok')"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert out.stdout.strip() == "ok", out.stderr


def test_open_without_unitypy_raises_with_install_hint(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "UnityPy", None)  # makes `import UnityPy` raise ImportError
    with pytest.raises(ExtractError) as err:
        UnityEnvAdapter.open(make_install(tmp_path), Report())
    assert str(err.value) == "UnityPy not installed: pip install 'dsp-extract[game]'"


# ---- UnityEnvAdapter over objects imitating UnityPy's API -------------------------------------


class FakePPtr:
    """Imitates `UnityPy.classes.PPtr` (kw-only attrs class) for the calls the adapter makes."""

    def __init__(self, *, m_FileID, m_PathID, assetsfile=None):
        self.m_FileID, self.m_PathID, self.assetsfile = m_FileID, m_PathID, assetsfile

    def deref(self):
        if self.m_PathID == 0:
            raise ValueError("PPtr can't deref with m_PathID == 0!")
        target = self.assetsfile
        if self.m_FileID != 0:
            name = self.assetsfile.externals[self.m_FileID - 1]
            target = self.assetsfile.environment.cabs[name.lower()]
        return target.objects[self.m_PathID]

    def deref_parse_as_object(self):
        return self.deref().parse_as_object()


class FakeReader:
    """Imitates `ObjectReader`: `.type.name`, `.path_id`, `.assets_file`, `read_typetree`, MonoBehaviour head."""

    def __init__(self, assets_file, path_id, type_name, tree=None, script_ptr=None, class_name=None):
        self.assets_file, self.path_id = assets_file, path_id
        self.type = SimpleNamespace(name=type_name)
        self._tree, self._script_ptr, self._class_name = tree or {}, script_ptr, class_name
        self.reads = self.parses = 0
        assets_file.objects[path_id] = self

    def read_typetree(self, nodes=None, wrap=False, check_read=True):
        self.reads += 1
        return {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v) for k, v in self._tree.items()}

    def parse_monobehaviour_head(self):
        return SimpleNamespace(m_Script=self._script_ptr)

    def parse_as_object(self):
        self.parses += 1
        return SimpleNamespace(m_ClassName=self._class_name)


class FakeAssetsFile:
    def __init__(self, name, env, externals=(), unity_version="2022.3.62f3c1"):
        self.name, self.environment, self.externals = name, env, list(externals)
        self.unity_version, self.objects = unity_version, {}


def pp(file_id, path_id):
    return {"m_FileID": file_id, "m_PathID": path_id}


def make_unity_files():
    env = SimpleNamespace(cabs={}, typetree_generator=None)
    ggm = FakeAssetsFile("globalgamemanagers", env)
    scripts = FakeAssetsFile("globalgamemanagers.assets", env)
    resources = FakeAssetsFile("resources.assets", env, externals=["globalgamemanagers.assets"])
    env.cabs = {"globalgamemanagers.assets": scripts, "resources.assets": resources, "globalgamemanagers": ggm}
    FakeReader(scripts, 10, "MonoScript", class_name="ItemProtoSet")
    FakeReader(scripts, 11, "MonoScript", class_name="SlotConfig")
    FakeReader(resources, 1, "MonoBehaviour", {"dataArray": [{"ID": 1, "ref": pp(0, 2)}], "list": [pp(1, 10), pp(0, 0)]},
               script_ptr=FakePPtr(m_FileID=1, m_PathID=10, assetsfile=resources))
    FakeReader(resources, 2, "MonoBehaviour", script_ptr=FakePPtr(m_FileID=1, m_PathID=11, assetsfile=resources))
    FakeReader(resources, 3, "GameObject", {"m_Name": "assembler-mk-1"})
    FakeReader(resources, 4, "MonoBehaviour", script_ptr=FakePPtr(m_FileID=0, m_PathID=0, assetsfile=resources))
    FakeReader(
        ggm, 5, "ResourceManager",
        {"m_Container": [("Entities/Prefabs/Assembler-MK-1", pp(1, 3)), ("entities/prefabs/assembler-mk-1", pp(1, 99))]},
    )
    FakeReader(
        ggm, 6, "TagManager",
        {"tags": ["Untagged"], "Builtin_Layer_0": "Default", "Builtin_Layer_1": "TransparentFX", "User_Layer_8": "",
         "User_Layer_12": "Build", "layers_unrelated": 3},
    )
    ggm.externals = ["resources.assets"]  # PPtr file id 1 inside globalgamemanagers
    files = {"globalgamemanagers": ggm, "globalgamemanagers.assets": scripts, "resources.assets": resources}
    return env, files


def make_adapter():
    env, files = make_unity_files()
    return UnityEnvAdapter(env, files, FakePPtr), files


def test_adapter_lists_objects_by_type_name_across_files():
    adapter, files = make_adapter()
    ids = sorted(o.path_id for o in adapter.objects_of_type("MonoBehaviour"))
    assert ids == [1, 2, 4]
    assert [adapter.type_name(o) for o in adapter.objects_of_type("GameObject")] == ["GameObject"]


def test_adapter_script_class_resolves_through_external_file_and_caches():
    adapter, files = make_adapter()
    resources = files["resources.assets"]
    assert adapter.script_class(resources.objects[1]) == "ItemProtoSet"
    assert adapter.script_class(resources.objects[2]) == "SlotConfig"
    assert adapter.script_class(resources.objects[4]) is None  # null m_Script
    # asking again, or for another object with the same script PPtr, does not parse the MonoScript again
    assert adapter.script_class(resources.objects[1]) == "ItemProtoSet"
    assert files["globalgamemanagers.assets"].objects[10].parses == 1


def test_adapter_typetree_binds_pptrs_to_their_file_and_deref_follows_them():
    adapter, files = make_adapter()
    resources = files["resources.assets"]
    tree = adapter.read_typetree(resources.objects[1])
    assert tree["dataArray"][0]["ID"] == 1
    same_file, external, null = tree["dataArray"][0]["ref"], tree["list"][0], tree["list"][1]
    assert adapter.deref(same_file) is resources.objects[2]
    assert adapter.deref(external) is files["globalgamemanagers.assets"].objects[10]  # via externals
    assert adapter.deref(null) is None
    assert tree["list"][0] == {"m_FileID": 1, "m_PathID": 10}  # still plain, JSON-able data
    # cached: reading the same object again does not re-parse it
    adapter.read_typetree(resources.objects[1])
    assert resources.objects[1].reads == 1


def test_adapter_container_lowercases_keys_keeps_first_duplicate_and_resolves_to_the_prefab():
    adapter, files = make_adapter()
    container = adapter.container()
    assert list(container) == ["entities/prefabs/assembler-mk-1"]
    assert adapter.deref(container["entities/prefabs/assembler-mk-1"]) is files["resources.assets"].objects[3]
    assert adapter.container() is container  # built once


def test_adapter_container_without_resource_manager_raises():
    adapter, files = make_adapter()
    del files["globalgamemanagers"].objects[5]
    with pytest.raises(ExtractError, match="ResourceManager"):
        adapter.container()


def test_adapter_layer_names_come_from_the_tag_manager():
    adapter, _ = make_adapter()
    assert adapter.layer_names() == {0: "Default", 1: "TransparentFX", 12: "Build"}


def test_adapter_layer_names_default_to_empty_without_a_tag_manager():
    adapter, files = make_adapter()
    del files["globalgamemanagers"].objects[6]
    assert adapter.layer_names() == {}


# ---- UnityEnvAdapter.open over a fake UnityPy module ------------------------------------------


class FakeGenerator:
    instances: list = []
    fail_load_local_game = False
    bad_dlls: set = set()
    api_missing = False

    def __init__(self, unity_version):
        if FakeGenerator.api_missing:
            raise ImportError("TypeTreeGeneratorAPI isn't installed!")
        self.unity_version, self.dlls, self.local_game = unity_version, [], None
        FakeGenerator.instances.append(self)

    def load_local_game(self, root):
        self.local_game = root
        if FakeGenerator.fail_load_local_game:
            raise AssertionError("failed to load dll")
        for dll in sorted(Path(root, "DSPGAME_Data", "Managed").glob("*.dll")):
            self.dlls.append(dll.name)

    def load_dll(self, data):
        name = data.decode()
        if name in FakeGenerator.bad_dlls:
            raise AssertionError("failed to load dll")
        self.dlls.append(name)

    def get_loaded_dll_names(self):
        return list(self.dlls)


def install_fake_unitypy(monkeypatch, tmp_path, *, version="1.25.4", present=("globalgamemanagers", "globalgamemanagers.assets", "resources.assets"), broken=()):
    FakeGenerator.instances, FakeGenerator.fail_load_local_game = [], False
    FakeGenerator.bad_dlls, FakeGenerator.api_missing = set(), False
    unity_env, files = make_unity_files()

    class Environment:
        def __init__(self, *args, path=None):
            self.path, self.files, self.typetree_generator = path, {}, None
            self.loaded = []

        def load_file(self, file):
            name = Path(file).name
            self.loaded.append(name)
            if name in broken:
                raise ValueError("bad serialized file")
            parsed = files.get(name) or FakeAssetsFile(name, self)
            self.files[file] = parsed
            return parsed

    unitypy = types.ModuleType("UnityPy")
    unitypy.__version__ = version
    unitypy.Environment = Environment
    helpers = types.ModuleType("UnityPy.helpers")
    ttg = types.ModuleType("UnityPy.helpers.TypeTreeGenerator")
    ttg.TypeTreeGenerator = FakeGenerator
    classes = types.ModuleType("UnityPy.classes")
    classes.PPtr = FakePPtr
    for name, module in (
        ("UnityPy", unitypy),
        ("UnityPy.helpers", helpers),
        ("UnityPy.helpers.TypeTreeGenerator", ttg),
        ("UnityPy.classes", classes),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    install = make_install(tmp_path)
    for name in (*present, "sharedassets0.assets", "sharedassets1.assets", "sharedassets0.assets.resS"):
        (install.data_dir / name).write_bytes(b"x")  # the .resS companion must not be loaded as an asset file
    (install.managed_dir / "Assembly-CSharp.dll").write_bytes(b"Assembly-CSharp.dll")
    (install.managed_dir / "UnityEngine.CoreModule.dll").write_bytes(b"UnityEngine.CoreModule.dll")
    return install


def test_open_loads_files_installs_the_generator_and_records_everything(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path)
    report = Report()
    adapter = UnityEnvAdapter.open(install, report)

    assert report.sections["unity_version"] == "2022.3.62f3c1"
    names = [f["name"] for f in report.sections["files_loaded"]]
    assert names == ["globalgamemanagers", "globalgamemanagers.assets", "resources.assets", "sharedassets0.assets", "sharedassets1.assets"]
    assert all("error" not in f for f in report.sections["files_loaded"])
    assert report.sections["files_loaded"][2]["objects"] == 4
    generator = FakeGenerator.instances[0]
    assert generator.unity_version == "2022.3.62f3c1"
    assert generator.local_game == str(install.root)
    assert adapter._env.typetree_generator is generator
    assert report.sections["typetree_generator"]["loaded_dlls"] == ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"]
    assert not report.warnings
    assert adapter.unity_version == "2022.3.62f3c1"


def test_open_reports_files_that_fail_to_parse_and_carries_on(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path, broken=("sharedassets1.assets",))
    report = Report()
    UnityEnvAdapter.open(install, report)
    failed = [f for f in report.sections["files_loaded"] if f.get("error")]
    assert [f["name"] for f in failed] == ["sharedassets1.assets"]
    assert any("sharedassets1.assets" in w and "bad serialized file" in w for w in report.warnings)


def test_open_names_missing_required_files(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path, present=("resources.assets",))
    with pytest.raises(ExtractError) as err:
        UnityEnvAdapter.open(install, Report())
    assert "globalgamemanagers" in str(err.value) and "globalgamemanagers.assets" in str(err.value)
    assert "resources.assets" not in str(err.value).split("missing")[-1]


def test_open_required_file_that_fails_to_parse_is_fatal(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path, broken=("resources.assets",))
    with pytest.raises(ExtractError, match="resources.assets.*bad serialized file"):
        UnityEnvAdapter.open(install, Report())


def test_open_falls_back_to_loading_dlls_one_by_one(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path)
    (install.managed_dir / "Broken.dll").write_bytes(b"Broken.dll")
    FakeGenerator.fail_load_local_game = True
    FakeGenerator.bad_dlls = {"Broken.dll"}
    report = Report()
    adapter = UnityEnvAdapter.open(install, report)
    assert adapter._env.typetree_generator.dlls == ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"]
    assert any("load_local_game" in w for w in report.warnings)
    assert any("Broken.dll" in w for w in report.warnings)


def test_open_fails_when_assembly_csharp_cannot_be_loaded(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path)
    FakeGenerator.fail_load_local_game = True
    FakeGenerator.bad_dlls = {"Assembly-CSharp.dll"}
    with pytest.raises(ExtractError, match="Assembly-CSharp.dll"):
        UnityEnvAdapter.open(install, Report())


def test_open_without_typetreegeneratorapi_raises_with_install_hint(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path)
    FakeGenerator.api_missing = True
    with pytest.raises(ExtractError, match=r"TypeTreeGeneratorAPI.*pip install 'dsp-extract\[game\]'"):
        UnityEnvAdapter.open(install, Report())


def test_open_rejects_an_unitypy_that_is_too_old(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path, version="1.20.0")
    with pytest.raises(ExtractError, match=r"UnityPy 1\.25"):
        UnityEnvAdapter.open(install, Report())


def test_adapter_deref_rejects_a_pptr_it_did_not_produce():
    adapter, _ = make_adapter()
    with pytest.raises(ValueError, match="not read through this adapter"):
        adapter.deref({"m_FileID": 0, "m_PathID": 3})
    assert adapter.deref({"m_FileID": 0, "m_PathID": 0}) is None


def test_open_warns_about_an_unparseable_or_newer_unitypy_version(monkeypatch, tmp_path):
    install = install_fake_unitypy(monkeypatch, tmp_path, version="dev")
    report = Report()
    UnityEnvAdapter.open(install, report)
    assert any("cannot parse the UnityPy version" in w for w in report.warnings)

    install = install_fake_unitypy(monkeypatch, tmp_path / "again", version="2.0.1")
    report = Report()
    UnityEnvAdapter.open(install, report)
    assert any("newer than the tested" in w for w in report.warnings)
