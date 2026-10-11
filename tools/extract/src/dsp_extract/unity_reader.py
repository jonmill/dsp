"""Read the proto tables, locale and building prefabs from a Dyson Sphere Program install.

UnityPy is imported lazily (inside `UnityEnvAdapter.open`), so this module imports without the
`game` extra. Everything else talks to the `EnvAdapter` protocol, which tests replace with fakes.

Verified against UnityPy 1.25.4 and TypeTreeGeneratorAPI 0.0.10 (source read, not run against DSP):
  * `Environment(path=...)`, `Environment.load_file(path)` -> `SerializedFile` (`.objects`
    path_id -> `ObjectReader`, `.unity_version`, `.name`); `Environment.files` is keyed by the FULL
    path string given to `load_file`, so this module keeps its own basename index.
  * `ObjectReader`: `.type.name` (ClassIDType name such as "MonoBehaviour"), `.path_id`,
    `.assets_file`, `.read_typetree()` -> dict (PPtr -> `{m_FileID, m_PathID}`, vector -> `{x, y, z}`),
    `.parse_monobehaviour_head()` -> object with `.m_Script` (PPtr bound to the file).
  * `PPtr(m_FileID=, m_PathID=, assetsfile=)` (keyword-only), `.deref()` -> `ObjectReader`,
    `.deref_parse_as_object()`; external files are resolved through `Environment.find_file`.
  * `env.typetree_generator = TypeTreeGenerator(unity_version)`; `ObjectReader.read_typetree()` then
    builds MonoBehaviour trees from the loaded DLLs. A class the generator cannot build raises
    AssertionError (TypeTreeGeneratorAPI) or silently yields the bare MonoBehaviour tree
    (`except ValueError: pass` in UnityPy), which shows up here as a missing `dataArray`.
"""

from __future__ import annotations

import importlib
import re
from collections.abc import Iterable, Mapping
from typing import Any, Protocol

from .errors import ExtractError
from .locale_files import load_english
from .prefab import ColliderClassifier, classify_collider, read_building
from .raw import RawBuilding, RawBundle
from .report import Report
from .steam import GameInstall

__all__ = [
    "EnvAdapter",
    "ExtractError",
    "UnityEnvAdapter",
    "check_game_dependencies",
    "collect_protosets",
    "find_protosets",
    "read_bundle",
    "read_game_version",
]

INSTALL_HINT = "pip install 'dsp-extract[game]'"
MIN_UNITYPY = (1, 25)

# GX section 5: MonoScripts and the ResourceManager live in the two globalgamemanagers files, the
# ProtoSets in resources.assets; sharedassets*.assets are loaded too in case a prefab depends on them.
REQUIRED_FILES = ("globalgamemanagers", "globalgamemanagers.assets", "resources.assets")

# ProtoSet class -> keys every entry of its dataArray must have (ExtractError naming class and key).
WANTED_PROTOSETS: dict[str, tuple[str, ...]] = {
    "ItemProtoSet": ("ID", "ModelIndex", "CanBuild"),
    "RecipeProtoSet": ("ID",),
    "TechProtoSet": ("ID",),
    "ModelProtoSet": ("ID", "PrefabPath"),
}

_LAYER_KEY = re.compile(r"(?:Builtin|User)_Layer_(\d+)")


class EnvAdapter(Protocol):
    """What the readers need from the Unity asset library. Objects and PPtrs are opaque handles.

    A PPtr is the plain dict `{"m_FileID": int, "m_PathID": int}` as found in `read_typetree`
    results (`m_PathID == 0` is null); `deref` resolves it to an object, or None when null.
    """

    def objects_of_type(self, type_name: str) -> Iterable[Any]: ...

    def type_name(self, obj: Any) -> str: ...

    def script_class(self, obj: Any) -> str | None: ...

    def read_typetree(self, obj: Any) -> dict: ...

    def deref(self, pptr: Any) -> Any | None: ...

    def container(self) -> dict[str, Any]: ...

    def layer_names(self) -> dict[int, str]: ...


# ---- game version -----------------------------------------------------------------------------

# `gameVersion` followed (before the next `;`) by `new Version(a, b, c, d)` or `new Version("a.b.c.d")`,
# as ilspycmd prints GameConfig: `public static readonly Version gameVersion = new Version(0, 10, 35, 29104);`
# The property form `gameVersion { get { return new Version(...); } }` matches too.
_VERSION_INTS = re.compile(
    r"\bgameVersion\b[^;]*?\bnew\s+(?:System\.)?Version\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)"
)
_VERSION_TEXT = re.compile(
    r"\bgameVersion\b[^;]*?\bnew\s+(?:System\.)?Version\s*\(\s*\"(\d+)\.(\d+)\.(\d+)\.(\d+)\"\s*\)"
)


def read_game_version(install: GameInstall, decompiled: Mapping[str, str] | None) -> str:
    """The game version as `major.minor.release.build`.

    From the decompiled `GameConfig` source when available, matching (see `_VERSION_INTS`):
        gameVersion ... new Version(<major>, <minor>, <release>, <build>)   (or a "a.b.c.d" string)
    Otherwise `"0.0.0+build<steam build id>"`; with neither, `ExtractError("cannot determine game version")`.
    `decompiled` maps C# type name -> source; `GameConfig` is tried first, then every other type.
    """
    if decompiled:
        ordered = sorted(decompiled.items(), key=lambda kv: kv[0] != "GameConfig")
        for _, source in ordered:
            for pattern in (_VERSION_INTS, _VERSION_TEXT):
                match = pattern.search(source)
                if match:
                    return ".".join(str(int(part)) for part in match.groups())
    if install.build_id:
        return f"0.0.0+build{install.build_id}"
    raise ExtractError("cannot determine game version")


# ---- UnityPy adapter --------------------------------------------------------------------------


class BoundPPtr(dict):
    """A `{m_FileID, m_PathID}` dict that remembers the asset file it was read from.

    It stays an ordinary dict for JSON and equality; `UnityEnvAdapter.deref` needs the file because
    a PPtr's `m_FileID` is relative to the file that contains it.
    """

    __slots__ = ("assets_file",)

    def __init__(self, value: Mapping, assets_file: Any) -> None:
        super().__init__(value)
        self.assets_file = assets_file


def _is_pptr(value: Mapping) -> bool:
    return len(value) == 2 and "m_FileID" in value and "m_PathID" in value


def _bind(value: Any, assets_file: Any) -> Any:
    """Copy a typetree result, binding PPtr dicts to `assets_file` and turning tuples into lists."""
    if isinstance(value, dict):
        if _is_pptr(value):
            return BoundPPtr(value, assets_file)
        return {k: _bind(v, assets_file) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        if all(not isinstance(v, (dict, list, tuple)) for v in value):
            return list(value)  # numbers or strings only; nothing to bind
        return [_bind(v, assets_file) for v in value]
    return value


class UnityEnvAdapter:
    """`EnvAdapter` over a UnityPy `Environment`. Build it with `UnityEnvAdapter.open`."""

    def __init__(self, env: Any, files: Mapping[str, Any], pptr_cls: Any, report: Report | None = None) -> None:
        self._env = env
        self._files = dict(files)  # file name -> SerializedFile
        self._pptr_cls = pptr_cls
        self._report = report
        self._trees: dict[tuple[int, int], dict] = {}
        self._scripts: dict[tuple[int, int, int], str | None] = {}
        self._container: dict[str, Any] | None = None
        self._layers: dict[int, str] | None = None
        primary = self._files.get("resources.assets") or next(iter(self._files.values()), None)
        self.unity_version: str | None = getattr(primary, "unity_version", None)

    @classmethod
    def open(cls, install: GameInstall, report: Report) -> UnityEnvAdapter:
        """Load the Unity data files of `install`, set up the type tree generator, record it all in `report`."""
        try:
            import UnityPy  # lazy on purpose: the `game` extra is optional
            from UnityPy.classes import PPtr
            from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
        except ImportError as exc:
            raise ExtractError(f"UnityPy not installed: {INSTALL_HINT}") from exc
        _check_unitypy_version(getattr(UnityPy, "__version__", ""), report)

        data_dir = install.data_dir
        missing = [name for name in REQUIRED_FILES if not (data_dir / name).is_file()]
        if missing:
            raise ExtractError(
                f"missing Unity data files in {data_dir}: {', '.join(missing)}. "
                "Verify the game files in Steam, or pass --game-dir PATH."
            )

        env = UnityPy.Environment(path=str(data_dir))
        names = [*REQUIRED_FILES, *sorted(p.name for p in data_dir.glob("sharedassets*.assets"))]
        files: dict[str, Any] = {}
        records: list[dict[str, Any]] = []
        report.set("files_loaded", records)
        for name in names:
            path = data_dir / name
            record: dict[str, Any] = {"name": name, "size": path.stat().st_size}
            records.append(record)
            try:
                loaded = env.load_file(str(path))
                if loaded is None:
                    raise ExtractError("UnityPy could not open the file")
                record["objects"] = len(loaded.objects)
                record["unity_version"] = getattr(loaded, "unity_version", None)
                files[name] = loaded
            except Exception as exc:  # UnityPy raises many types for bad files
                record["error"] = f"{type(exc).__name__}: {exc}"
                if name in REQUIRED_FILES:
                    raise ExtractError(f"cannot parse {name}: {exc}") from exc
                report.warn(f"{name} could not be parsed and is skipped: {exc}")

        unity_version = files["resources.assets"].unity_version
        report.set("unity_version", unity_version)
        env.typetree_generator = _create_generator(TypeTreeGenerator, unity_version, install, report)
        return cls(env, files, PPtr, report)

    # ---- EnvAdapter ---------------------------------------------------------------------------

    def objects_of_type(self, type_name: str) -> Iterable[Any]:
        for assets_file in self._files.values():
            for obj in assets_file.objects.values():
                if obj.type.name == type_name:
                    yield obj

    def type_name(self, obj: Any) -> str:
        return obj.type.name

    def script_class(self, obj: Any) -> str | None:
        """`MonoScript.m_ClassName` of a MonoBehaviour (None for a null script); cached per script PPtr."""
        script = obj.parse_monobehaviour_head().m_Script
        if not getattr(script, "m_PathID", 0):
            return None
        key = (id(obj.assets_file), script.m_FileID, script.m_PathID)
        if key not in self._scripts:
            self._scripts[key] = script.deref_parse_as_object().m_ClassName or None
        return self._scripts[key]

    def read_typetree(self, obj: Any) -> dict:
        """The object's fields as a dict with PPtrs bound to its file. Cached: callers must not mutate it."""
        key = (id(obj.assets_file), obj.path_id)
        tree = self._trees.get(key)
        if tree is None:
            tree = _bind(obj.read_typetree(), obj.assets_file)
            self._trees[key] = tree
        return tree

    def deref(self, pptr: Any) -> Any | None:
        if pptr["m_PathID"] == 0:
            return None
        assets_file = getattr(pptr, "assets_file", None)
        if assets_file is None:
            raise ValueError("PPtr was not read through this adapter, so its file is unknown")
        return self._pptr_cls(m_FileID=pptr["m_FileID"], m_PathID=pptr["m_PathID"], assetsfile=assets_file).deref()

    def container(self) -> dict[str, Any]:
        """`ResourceManager.m_Container` as lowercase Resources path -> PPtr (first entry wins)."""
        if self._container is not None:
            return self._container
        manager = self._first_object("globalgamemanagers", "ResourceManager")
        if manager is None:
            raise ExtractError("no ResourceManager object in globalgamemanagers (needed to find prefabs)")
        tree = self.read_typetree(manager)
        entries = tree.get("m_Container")
        if not isinstance(entries, list):
            raise ExtractError(f"ResourceManager has no m_Container list (keys: {sorted(tree)})")
        container: dict[str, Any] = {}
        duplicates = 0
        for entry in entries:
            path, pptr = (entry["first"], entry["second"]) if isinstance(entry, dict) else (entry[0], entry[1])
            key = str(path).lower()
            if key in container:
                duplicates += 1
            else:
                container[key] = pptr
        self._container = container
        if self._report is not None:
            self._report.set(
                "container",
                {
                    "entries": len(entries),
                    "unique_keys": len(container),
                    "duplicate_keys": duplicates,
                    # for research gap 2 (the derivation of ModelProto.ColliderPath)
                    "collider_keys": sorted(k for k in container if "collider" in k)[:60],
                },
            )
        return container

    def layer_names(self) -> dict[int, str]:
        """Unity layer number -> name from the TagManager (empty when unavailable)."""
        if self._layers is not None:
            return self._layers
        names: dict[int, str] = {}
        try:
            manager = self._first_object("globalgamemanagers", "TagManager")
            if manager is not None:
                tree = self.read_typetree(manager)
                for key, value in tree.items():
                    match = _LAYER_KEY.fullmatch(key)
                    if match and isinstance(value, str) and value:
                        names[int(match.group(1))] = value
                layers = tree.get("layers")
                if isinstance(layers, list):
                    for number, value in enumerate(layers):
                        if isinstance(value, str) and value:
                            names.setdefault(number, value)
        except Exception as exc:  # layer names are a diagnostic nicety
            if self._report is not None:
                self._report.warn(f"cannot read layer names from the TagManager: {exc}")
        self._layers = names
        if self._report is not None:
            self._report.set("layer_names", {str(k): v for k, v in sorted(names.items())})
        return names

    def _first_object(self, file_name: str, type_name: str) -> Any | None:
        assets_file = self._files.get(file_name)
        if assets_file is None:
            return None
        return next((o for o in assets_file.objects.values() if o.type.name == type_name), None)


def check_game_dependencies() -> None:
    """Fail fast, before any slow work, when the `game` extra is missing, too old or its native library will not load.

    Raises `ExtractError` carrying the install hint. UnityPy and TypeTreeGeneratorAPI are imported lazily everywhere
    else, so without this a missing extra would only show up after the decompile step (minutes into the run).
    """
    try:
        unitypy = importlib.import_module("UnityPy")
    except ImportError as exc:
        raise ExtractError(f"UnityPy not installed: {INSTALL_HINT}") from exc
    except Exception as exc:
        raise ExtractError(f"UnityPy is installed but cannot be imported ({type(exc).__name__}: {exc})") from exc
    _check_unitypy_version(getattr(unitypy, "__version__", ""), Report())  # raises when too old; warnings come later
    try:
        importlib.import_module("TypeTreeGeneratorAPI")
    except ImportError as exc:
        raise ExtractError(f"TypeTreeGeneratorAPI not installed: {INSTALL_HINT}") from exc
    except Exception as exc:  # the native library failing to load: OSError, RuntimeError, ...
        raise ExtractError(
            f"TypeTreeGeneratorAPI is installed but cannot be loaded ({type(exc).__name__}: {exc}); "
            f"reinstall it: {INSTALL_HINT}"
        ) from exc


def _check_unitypy_version(version: str, report: Report) -> None:
    match = re.match(r"(\d+)\.(\d+)", version or "")
    if not match:
        report.warn(f"cannot parse the UnityPy version {version!r}; this reader needs UnityPy >= 1.25")
        return
    found = (int(match.group(1)), int(match.group(2)))
    if found < MIN_UNITYPY:
        raise ExtractError(
            f"UnityPy {MIN_UNITYPY[0]}.{MIN_UNITYPY[1]} or newer is required (found {version}): "
            "pip install -U 'dsp-extract[game]'"
        )
    if found[0] >= 2:
        report.warn(f"UnityPy {version} is newer than the tested 1.25 series; its API may have changed")


def _create_generator(generator_cls: Any, unity_version: str, install: GameInstall, report: Report) -> Any:
    """A TypeTreeGenerator loaded with the game's own `Managed` DLLs (never the publicized GameLibs)."""
    try:
        generator = generator_cls(unity_version)
    except ImportError as exc:
        raise ExtractError(f"TypeTreeGeneratorAPI not installed: {INSTALL_HINT}") from exc
    except Exception as exc:  # ctypes load failures: OSError, RuntimeError, ...
        raise ExtractError(f"cannot start the type tree generator for Unity {unity_version}: {exc}") from exc

    method = "load_local_game"
    failed: list[str] = []
    try:
        generator.load_local_game(str(install.root))
    except Exception as exc:
        report.warn(
            f"TypeTreeGenerator.load_local_game({install.root}) failed ({type(exc).__name__}: {exc}); "
            f"loading {install.managed_dir}/*.dll one by one"
        )
        method = "per-dll"
        generator = generator_cls(unity_version)  # a failed bulk load may leave partial state
        for dll in sorted(install.managed_dir.glob("*.dll")):
            try:
                generator.load_dll(dll.read_bytes())
            except Exception as dll_exc:
                failed.append(dll.name)
                report.warn(f"cannot load {dll.name} into the type tree generator: {dll_exc}")

    loaded: list[str] | None
    try:
        loaded = list(generator.get_loaded_dll_names())
    except Exception:  # older TypeTreeGeneratorAPI builds lack this call
        loaded = None
    report.set("typetree_generator", {"method": method, "loaded_dlls": loaded, "failed_dlls": failed})
    if loaded is not None and not any("assembly-csharp" in name.lower() for name in loaded):
        raise ExtractError(
            f"Assembly-CSharp.dll was not loaded into the type tree generator (loaded: {loaded}); "
            f"check {install.managed_dir}"
        )
    return generator


# ---- ProtoSets and the bundle -----------------------------------------------------------------


def _check_protoset(class_name: str, tree: Mapping) -> list[dict]:
    required = WANTED_PROTOSETS[class_name]
    if "dataArray" not in tree:
        raise ExtractError(
            f"{class_name}: missing key 'dataArray' (keys read: {sorted(tree)}). The type tree for this class "
            "was probably not generated from Managed/Assembly-CSharp.dll; see typetree_generator in the report."
        )
    entries = tree["dataArray"]
    if not isinstance(entries, list):
        raise ExtractError(f"{class_name}.dataArray is not a list: {type(entries).__name__}")
    if not entries:
        raise ExtractError(f"{class_name}.dataArray is empty")
    for index, entry in enumerate(entries):
        if not isinstance(entry, Mapping):
            raise ExtractError(f"{class_name}.dataArray[{index}] is not an object: {entry!r}")
        for key in required:
            if key not in entry:
                raise ExtractError(
                    f"{class_name}.dataArray[{index}] (ID {entry.get('ID', '?')}) is missing key {key!r} "
                    f"(keys read: {sorted(entry)}). The game version may have changed this proto."
                )
    return entries


def _scan_protosets(adapter: EnvAdapter, report: Report) -> tuple[dict[str, list[Any]], int, int]:
    """`(found, scanned, unresolved)`: the `*ProtoSet` MonoBehaviours by script class, and how many scripts failed."""
    found: dict[str, list[Any]] = {}
    scanned = unresolved = 0
    first_error = ""
    for obj in adapter.objects_of_type("MonoBehaviour"):
        scanned += 1
        try:
            class_name = adapter.script_class(obj)
        except Exception as exc:
            unresolved += 1
            first_error = first_error or f"{type(exc).__name__}: {exc}"
            continue
        if class_name and class_name.endswith("ProtoSet"):
            found.setdefault(class_name, []).append(obj)
    if unresolved:
        report.warn(
            f"{unresolved} MonoBehaviour objects (of {scanned}) have a script that could not be resolved, "
            f"first: {first_error}"
        )
    return found, scanned, unresolved


def find_protosets(adapter: EnvAdapter, report: Report) -> dict[str, list[Any]]:
    """Every `*ProtoSet` MonoBehaviour by MonoScript class name (the `inspect` command lists them all)."""
    return _scan_protosets(adapter, report)[0]


def collect_protosets(adapter: EnvAdapter, report: Report) -> dict[str, dict]:
    """The Item/Recipe/Tech/Model ProtoSet trees by MonoScript class name, validated.

    Every `*ProtoSet` found is listed in the report's `protosets_found`; only the wanted four are read.
    """
    found, scanned, unresolved = _scan_protosets(adapter, report)

    listing = {name: {"count": len(objs), "read": False} for name, objs in sorted(found.items())}
    report.set("protosets_found", listing)

    trees: dict[str, dict] = {}
    for class_name in WANTED_PROTOSETS:
        objs = found.get(class_name)
        if not objs:
            raise ExtractError(
                f"{class_name} not found among {sum(map(len, found.values()))} ProtoSet objects "
                f"(found: {sorted(found)}); scanned {scanned} MonoBehaviour objects, "
                f"{unresolved} with unresolved scripts"
            )
        if len(objs) > 1:
            report.warn(f"{class_name}: {len(objs)} objects found; using the first")
        try:
            tree = adapter.read_typetree(objs[0])
        except Exception as exc:
            raise ExtractError(
                f"{class_name}: cannot read the ProtoSet ({type(exc).__name__}: {exc}); the type tree generated "
                "for it probably does not match the serialized data"
            ) from exc
        entries = _check_protoset(class_name, tree)
        signature = tree.get("Signature")
        if not isinstance(signature, str):
            report.warn(f"{class_name}: no Signature key; it will not be recorded as a version fingerprint")
            signature = None
        listing[class_name].update(
            {"table_name": tree.get("TableName"), "signature": signature, "entries": len(entries), "read": True}
        )
        trees[class_name] = tree
    return trees


def read_bundle(
    install: GameInstall,
    report: Report,
    *,
    adapter: EnvAdapter | None = None,
    decompiled: Mapping[str, str] | None = None,
    classify: ColliderClassifier = classify_collider,
) -> RawBundle:
    """Everything `normalize` needs from a real install; raises `ExtractError` for structural problems.

    `adapter` replaces the UnityPy adapter (tests); `decompiled` (type name -> C# source) supplies the
    game version, which otherwise falls back to the Steam build id; `classify` replaces the
    collider-usage rule. Per-building failures never raise: they become report entries and None
    geometry parts (see prefab.read_building).
    """
    game_version = read_game_version(install, decompiled)
    locale = load_english(install.root, report)
    adapter = adapter if adapter is not None else UnityEnvAdapter.open(install, report)

    trees = collect_protosets(adapter, report)
    items = trees["ItemProtoSet"]["dataArray"]
    models = {int(m["ID"]): m for m in trees["ModelProtoSet"]["dataArray"]}

    # Every building's prefab is found through the container; if it cannot be read, say so once instead of
    # reporting the same failure for each of the ~100 buildings.
    try:
        adapter.container()
    except Exception as exc:
        raise ExtractError(f"cannot read the ResourceManager container, so no building prefab can be found: {exc}") from exc

    buildings: list[RawBuilding] = []
    for item in sorted(items, key=lambda i: int(i["ID"])):
        if not item["CanBuild"] or not item["ModelIndex"]:
            continue
        model = models.get(int(item["ModelIndex"]))
        if model is None:
            item_id, model_index = int(item["ID"]), int(item["ModelIndex"])
            report.error(
                f"building {item_id} ({item.get('Name', '?')}): ModelIndex {model_index} has no ModelProto; "
                "no descriptors or geometry",
                item_id=item_id,
            )
            report.set_building(
                item_id,
                {"name_key": item.get("Name"), "model_index": model_index, "status": "failed", "unreadable": True},
            )
            buildings.append(RawBuilding(item_id=item_id, model_index=model_index, descs={}))
            continue
        buildings.append(read_building(adapter, model, item, report, classify=classify))

    report.info(
        f"Read {len(items)} items, {len(trees['RecipeProtoSet']['dataArray'])} recipes, "
        f"{len(trees['TechProtoSet']['dataArray'])} techs, {len(models)} models; {len(buildings)} buildings"
    )
    return RawBundle(
        game_version=game_version,
        steam_build_id=install.build_id,
        source="game",
        items=items,
        recipes=trees["RecipeProtoSet"]["dataArray"],
        techs=trees["TechProtoSet"]["dataArray"],
        buildings=buildings,
        locale=locale,
        proto_signatures={
            name: tree["Signature"] for name, tree in trees.items() if isinstance(tree.get("Signature"), str)
        },
    )
