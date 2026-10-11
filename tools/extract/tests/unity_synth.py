"""Write a small but real Unity (format 22, no embedded type trees) DSP-shaped game with UnityPy.

Used by test_unity_real.py to run the whole reader against UnityPy's actual parser: three
SerializedFiles (`globalgamemanagers`, `globalgamemanagers.assets`, `resources.assets`) with
cross-file PPtrs, a ResourceManager container, a TagManager and one building prefab. MonoBehaviour
type trees come from `SynthGenerator`, standing in for TypeTreeGeneratorAPI (which needs the real
game DLLs): UnityPy asks it for `get_nodes_up(assembly, class)` exactly as it would the real one.

This relies on UnityPy 1.25's SerializedFile internals to *write* files, so it is test-only.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

from UnityPy.enums import ClassIDType
from UnityPy.files import SerializedFile
from UnityPy.files.ObjectReader import ObjectReader
from UnityPy.files.SerializedFile import FileIdentifier, SerializedType
from UnityPy.helpers import TypeTreeHelper
from UnityPy.helpers.Tpk import get_typetree_node
from UnityPy.helpers.TypeTreeNode import TypeTreeNode
from UnityPy.helpers.UnityVersion import UnityVersion
from UnityPy.streams import EndianBinaryReader, EndianBinaryWriter

UNITY_VERSION = "2022.3.62f3c1"
FORMAT = 22
GAME_OBJECT, TRANSFORM, BOX_COLLIDER, MONO_BEHAVIOUR, MONO_SCRIPT, TAG_MANAGER, RESOURCE_MANAGER = 1, 4, 65, 114, 115, 78, 147
H = math.sqrt(0.5)


def null_ptr() -> dict:
    return {"m_FileID": 0, "m_PathID": 0}


def ptr(path_id: int, file_id: int = 0) -> dict:
    return {"m_FileID": file_id, "m_PathID": path_id}


def vec(x: float, y: float, z: float) -> dict:
    return {"x": x, "y": y, "z": z}


def quat(x: float, y: float, z: float, w: float) -> dict:
    return {"x": x, "y": y, "z": z, "w": w}


def _minimal_file() -> bytes:
    meta = (
        UNITY_VERSION.encode() + b"\0"
        + struct.pack("<i", 19)  # target platform: StandaloneWindows64
        + b"\0"  # enable_type_tree = False, like the release DSP build
        + struct.pack("<iiiii", 0, 0, 0, 0, 0)  # types, objects, script types, externals, ref types
        + b"\0"  # user information
    )
    header = struct.pack(">IIII", 0, 0, FORMAT, 0) + b"\0\0\0\0" + struct.pack(">I", len(meta)) + struct.pack(">qqq", 0, 0, 0)
    return header + meta


def builtin_nodes(class_id: int) -> TypeTreeNode:
    return get_typetree_node(class_id, UnityVersion.from_str(UNITY_VERSION))


# ---- MonoBehaviour trees (what TypeTreeGeneratorAPI would emit) --------------------------------

# Field specs: "int" | "bool" | "float" | "string" | "UInt8" | "SInt64" | "vec3" | "pptr"
#   ("array", spec)  a vector of spec        [(name, spec), ...]  a nested class
Spec = object


def _rows(level: int, name: str, spec: Spec) -> list[dict]:
    def row(lvl: int, typ: str, nm: str) -> dict:
        return {"m_Level": lvl, "m_Type": typ, "m_Name": nm, "m_MetaFlag": 0}

    if isinstance(spec, tuple) and spec[0] == "array":
        return [row(level, "vector", name), row(level + 1, "Array", "Array"), row(level + 2, "int", "size"), *_rows(level + 2, "data", spec[1])]
    if isinstance(spec, list):
        out = [row(level, name + "_t", name)]
        for sub_name, sub_spec in spec:
            out += _rows(level + 1, sub_name, sub_spec)
        return out
    if spec == "string":
        return [row(level, "string", name), row(level + 1, "Array", "Array"), row(level + 2, "int", "size"), row(level + 2, "char", "data")]
    if spec == "vec3":
        return [row(level, "Vector3f", name), *(row(level + 1, "float", axis) for axis in "xyz")]
    if spec == "pptr":
        return [row(level, "PPtr<Transform>", name), row(level + 1, "int", "m_FileID"), row(level + 1, "SInt64", "m_PathID")]
    return [row(level, str(spec), name)]


def mono_nodes(fields: list[tuple[str, Spec]]) -> TypeTreeNode:
    """The MonoBehaviour head from UnityPy's own tree plus the class's serialized `fields`."""
    rows = [{"m_Level": 0, "m_Type": "MonoBehaviour", "m_Name": "Base", "m_MetaFlag": 0}]
    for node in list(builtin_nodes(MONO_BEHAVIOUR).traverse())[1:]:
        rows.append({"m_Level": node.m_Level, "m_Type": node.m_Type, "m_Name": node.m_Name, "m_MetaFlag": node.m_MetaFlag})
    for name, spec in fields:
        rows += _rows(1, name, spec)
    return TypeTreeNode.from_list(rows)


ITEM_FIELDS = [("ID", "int"), ("Name", "string"), ("Type", "int"), ("StackSize", "int"), ("GridIndex", "int"), ("CanBuild", "bool"), ("ModelIndex", "int")]
RECIPE_FIELDS = [
    ("ID", "int"), ("Name", "string"), ("Type", "UInt8"), ("TimeSpend", "int"),
    ("Items", ("array", "int")), ("ItemCounts", ("array", "int")), ("Results", ("array", "int")), ("ResultCounts", ("array", "int")),
]
TECH_FIELDS = [("ID", "int"), ("Name", "string"), ("Position", [("x", "float"), ("y", "float")])]
MODEL_FIELDS = [("ID", "int"), ("Name", "string"), ("PrefabPath", "string")]


def protoset_fields(entry_fields) -> list[tuple[str, Spec]]:
    return [("TableName", "string"), ("Signature", "string"), ("dataArray", ("array", entry_fields))]


class SynthGenerator:
    """Stands in for `TypeTreeGenerator`: `get_nodes_up(assembly, class)` returns the class's tree."""

    trees = {
        "ItemProtoSet": mono_nodes(protoset_fields(ITEM_FIELDS)),
        "RecipeProtoSet": mono_nodes(protoset_fields(RECIPE_FIELDS)),
        "TechProtoSet": mono_nodes(protoset_fields(TECH_FIELDS)),
        "ModelProtoSet": mono_nodes(protoset_fields(MODEL_FIELDS)),
        "AssemblerDesc": mono_nodes([("recipeType", "UInt8"), ("speedf", "float")]),
        "PowerDesc": mono_nodes([("consumer", "bool"), ("workEnergyPerTick", "SInt64"), ("idleEnergyPerTick", "SInt64")]),
        "BuildConditionConfig": mono_nodes([("landPoints", ("array", "vec3")), ("multiLevel", "bool")]),
        "SlotConfig": mono_nodes(
            [("slotPoses", ("array", "pptr")), ("insertPoses", ("array", "pptr")), ("selectCenter", "vec3"), ("selectSize", "vec3")]
        ),
        "SomeAnimator": mono_nodes([("speed", "float")]),
    }

    def __init__(self, unity_version: str) -> None:
        self.unity_version = unity_version
        self.root: str | None = None

    def load_local_game(self, root: str) -> None:
        self.root = root

    def get_loaded_dll_names(self) -> list[str]:
        return ["Assembly-CSharp.dll", "UnityEngine.CoreModule.dll"]

    def get_nodes_up(self, assembly: str, fullname: str) -> TypeTreeNode:
        assert assembly == "Assembly-CSharp.dll", assembly
        if fullname not in self.trees:
            raise AssertionError("failed to dump nodes raw")  # what TypeTreeGeneratorAPI raises
        return self.trees[fullname]


# ---- file writer -------------------------------------------------------------------------------


class FileBuilder:
    """One SerializedFile under construction; `add` returns the new object's path id."""

    def __init__(self, externals: list[str]) -> None:
        self.sf = SerializedFile(EndianBinaryReader(_minimal_file()), None, "scratch")
        self.sf.externals = []
        for path in externals:
            external = FileIdentifier.__new__(FileIdentifier)
            external.temp_empty, external.guid, external.type, external.path = "", bytes(16), 0, path
            self.sf.externals.append(external)
        self.sf.types = []
        self._type_index: dict[int, int] = {}
        self._next_id = 1

    def add(self, class_id: int, value: dict, nodes: TypeTreeNode | None = None) -> int:
        writer = EndianBinaryWriter(endian="<")
        TypeTreeHelper.write_typetree(value, nodes or builtin_nodes(class_id), writer, self.sf)
        data = writer.bytes
        if class_id not in self._type_index:
            serialized = SerializedType.__new__(SerializedType)
            serialized.__attrs_init__(class_id)
            serialized.is_stripped_type = False
            serialized.script_type_index = -1
            serialized.script_id = bytes(16) if class_id == MONO_BEHAVIOUR else None
            serialized.old_type_hash = bytes([class_id % 256]) * 16
            serialized.node = None
            serialized.type_dependencies = ()
            self.sf.types.append(serialized)
            self._type_index[class_id] = len(self.sf.types) - 1
        type_id = self._type_index[class_id]
        path_id, self._next_id = self._next_id, self._next_id + 1
        self.sf.objects[path_id] = ObjectReader(
            self.sf, None, path_id, type_id, self.sf.types[type_id], class_id, ClassIDType(class_id), 0, len(data), None, None, data=data
        )
        return path_id

    def write(self, path: Path) -> None:
        self.sf.userInformation = ""
        path.write_bytes(self.sf.save())


# ---- the game ----------------------------------------------------------------------------------

ITEMS = [
    {"ID": 1101, "Name": "铁块", "Type": 2, "StackSize": 100, "GridIndex": 1101, "CanBuild": False, "ModelIndex": 0},
    {"ID": 2303, "Name": "组装机", "Type": 6, "StackSize": 50, "GridIndex": 2203, "CanBuild": True, "ModelIndex": 65},
]
RECIPES = [
    {"ID": 1, "Name": "铁块", "Type": 1, "TimeSpend": 60, "Items": [1001], "ItemCounts": [1], "Results": [1101], "ResultCounts": [1]}
]
TECHS = [{"ID": 1, "Name": "T电磁学", "Position": {"x": 1.0, "y": 2.0}}]
MODELS = [{"ID": 65, "Name": "组装机", "PrefabPath": "Entities/Prefabs/assembler-mk-1"}]
SIGNATURES = {"Item": "Item 9B99CF5F04803D5A61177FEC266D9790", "Recipe": "Recipe AAAA", "Tech": "Tech BBBB", "Model": "Model CCCC"}
BUILD_LAYER = 12


def write_game(data_dir: Path) -> None:
    """`globalgamemanagers`, `globalgamemanagers.assets` and `resources.assets` in `data_dir`."""
    data_dir.mkdir(parents=True, exist_ok=True)

    scripts = FileBuilder([])
    script_ids = {}
    for class_name in (*SynthGenerator.trees, "BrokenDesc"):
        script_ids[class_name] = scripts.add(
            MONO_SCRIPT,
            {
                "m_Name": class_name,
                "m_ExecutionOrder": 0,
                "m_PropertiesHash": {f"bytes[{i}]": 0 for i in range(16)},
                "m_ClassName": class_name,
                "m_Namespace": "",
                "m_AssemblyName": "Assembly-CSharp.dll",
            },
        )
    scripts.write(data_dir / "globalgamemanagers.assets")

    resources = FileBuilder(["globalgamemanagers.assets"])  # PPtr file id 1 -> the scripts file

    def mono(class_name: str, go_ptr: dict, **fields) -> int:
        head = {"m_GameObject": go_ptr, "m_Enabled": 1, "m_Script": ptr(script_ids[class_name], 1), "m_Name": ""}
        return resources.add(MONO_BEHAVIOUR, {**head, **fields}, SynthGenerator.trees[class_name])

    for class_name, table, entries in (
        ("ItemProtoSet", "Item", ITEMS),
        ("RecipeProtoSet", "Recipe", RECIPES),
        ("TechProtoSet", "Tech", TECHS),
        ("ModelProtoSet", "Model", MODELS),
    ):
        mono(class_name, null_ptr(), m_Name=class_name, TableName=table, Signature=SIGNATURES[table], dataArray=entries)

    # name, parent, local position, local rotation (x, y, z, w), layer
    plan = [
        ("assembler-mk-1", None, (0.0, 0.0, 0.0), (0.0, H, 0.0, H), 0),
        ("port0", "assembler-mk-1", (0.0, 0.0, 1.0), (0.0, 0.0, 0.0, 1.0), 0),
        ("port1", "assembler-mk-1", (1.0, 0.0, 1.0), (0.0, 0.0, 0.0, 1.0), 0),
        ("slot0", "assembler-mk-1", (0.0, 0.0, 2.0), (0.0, 0.0, 0.0, 1.0), 0),
        ("body", "assembler-mk-1", (0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0), BUILD_LAYER),
    ]
    # Pass 1: placeholder GameObjects and Transforms, so every path id is known.
    game_objects: dict[str, int] = {}
    transforms: dict[str, int] = {}
    for name, *_ in plan:
        game_objects[name] = resources.add(GAME_OBJECT, {"m_Component": [], "m_Layer": 0, "m_Name": name, "m_Tag": 0, "m_IsActive": True})
        transforms[name] = resources.add(TRANSFORM, builtin_placeholder(game_objects[name]))

    box = resources.add(
        BOX_COLLIDER,
        {
            "m_GameObject": ptr(game_objects["body"]),
            "m_Material": null_ptr(),
            "m_IncludeLayers": {"m_Bits": 0},
            "m_ExcludeLayers": {"m_Bits": 0},
            "m_LayerOverridePriority": 0,
            "m_IsTrigger": False,
            "m_ProvidesContacts": False,
            "m_Enabled": True,
            "m_Size": vec(3.0, 2.0, 3.0),
            "m_Center": vec(0.0, 0.0, 0.0),
        },
    )
    root_go = ptr(game_objects["assembler-mk-1"])
    root_components = [
        mono("AssemblerDesc", root_go, recipeType=4, speedf=0.75),
        mono("PowerDesc", root_go, consumer=True, workEnergyPerTick=1000, idleEnergyPerTick=100),
        mono("BuildConditionConfig", root_go, landPoints=[vec(-1.5, 0, -1.5), vec(1.5, 0, 1.5)], multiLevel=False),
        mono(
            "SlotConfig",
            root_go,
            slotPoses=[ptr(transforms["port0"]), ptr(transforms["port1"])],
            insertPoses=[ptr(transforms["slot0"])],
            selectCenter=vec(0.0, 1.0, 0.0),
            selectSize=vec(3.0, 2.0, 3.0),
        ),
        # A descriptor the type tree generator cannot build: must cost one error, nothing else.
        resources.add(
            MONO_BEHAVIOUR,
            {"m_GameObject": root_go, "m_Enabled": 1, "m_Script": ptr(script_ids["BrokenDesc"], 1), "m_Name": "", "speed": 1.0},
            SynthGenerator.trees["SomeAnimator"],
        ),
    ]
    extra = {"assembler-mk-1": root_components, "body": [box]}

    # Pass 2: the real GameObject and Transform data.
    for name, parent, position, rotation, layer in plan:
        component_ids = [transforms[name], *extra.get(name, [])]
        rewrite(
            resources,
            game_objects[name],
            GAME_OBJECT,
            {"m_Component": [{"component": ptr(c)} for c in component_ids], "m_Layer": layer, "m_Name": name, "m_Tag": 0, "m_IsActive": True},
        )
        children = [ptr(transforms[child]) for child, child_parent, *_ in plan if child_parent == name]
        rewrite(
            resources,
            transforms[name],
            TRANSFORM,
            {
                "m_GameObject": ptr(game_objects[name]),
                "m_LocalRotation": quat(*rotation),
                "m_LocalPosition": vec(*position),
                "m_LocalScale": vec(1.0, 1.0, 1.0),
                "m_Children": children,
                "m_Father": ptr(transforms[parent]) if parent else null_ptr(),
            },
        )
    resources.write(data_dir / "resources.assets")

    manager = FileBuilder(["resources.assets"])  # PPtr file id 1 -> resources.assets
    layers = [""] * 32
    layers[0], layers[1], layers[BUILD_LAYER] = "Default", "TransparentFX", "Build"
    manager.add(TAG_MANAGER, {"tags": ["Untagged"], "layers": layers, "m_SortingLayers": []})
    manager.add(
        RESOURCE_MANAGER,
        {
            "m_Container": [
                ("entities/prefabs/assembler-mk-1", ptr(game_objects["assembler-mk-1"], 1)),
                ("entities/prefabs/assembler-mk-1", ptr(1, 1)),  # duplicate key: the first entry wins
            ],
            "m_DependentAssets": [],
        },
    )
    manager.write(data_dir / "globalgamemanagers")


def builtin_placeholder(go_id: int) -> dict:
    return {
        "m_GameObject": ptr(go_id),
        "m_LocalRotation": quat(0.0, 0.0, 0.0, 1.0),
        "m_LocalPosition": vec(0.0, 0.0, 0.0),
        "m_LocalScale": vec(1.0, 1.0, 1.0),
        "m_Children": [],
        "m_Father": null_ptr(),
    }


def rewrite(builder: FileBuilder, path_id: int, class_id: int, value: dict) -> None:
    """Replace an object's data in place (same type), once the ids it refers to are known."""
    writer = EndianBinaryWriter(endian="<")
    TypeTreeHelper.write_typetree(value, builtin_nodes(class_id), writer, builder.sf)
    obj = builder.sf.objects[path_id]
    obj.data = writer.bytes
    obj.byte_size = len(obj.data)
